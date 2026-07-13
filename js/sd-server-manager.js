// ╔══════════════════════════════════════════════════════════════════╗
// ║  sd-server-manager.js                                            ║
// ║  Visual Projector — sd-server.exe lifecycle + HTTP client        ║
// ║  Targets: leejet/stable-diffusion.cpp examples/server            ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP) return;

    // ── Helpers ─────────────────────────────────────────────────────
    async function fileToBase64(path) {
        if (!window.Neutralino?.filesystem?.readBinaryFile) return null;
        try {
            const bin = await Neutralino.filesystem.readBinaryFile(path);
            const ext = String(path).split('.').pop().toLowerCase();
            const mime = ext === 'webp' ? 'image/webp' : ext === 'jpeg' || ext === 'jpg' ? 'image/jpeg' : 'image/png';
            const bytes = new Uint8Array(bin);
            let b64 = '';
            const chunk = 8192;
            for (let i = 0; i < bytes.length; i += chunk) {
                b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
            }
            return `data:${mime};base64,${btoa(b64)}`;
        } catch (e) {
            console.warn('[SDServer] fileToBase64 failed:', path, e);
            return null;
        }
    }

    function b64ToBlob(b64, format = 'png') {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
        return new Blob([bytes], { type: mime });
    }

    function normPath(p) {
        return String(p || '').replace(/\\/g, '/').replace(/"/g, '');
    }

    function toWinPath(p) {
        if (typeof p !== 'string') return p;
        // Preserve "file:weight" LoRA syntax
        const lastColon = p.lastIndexOf(':');
        if (lastColon > 1) {
            const file = p.slice(0, lastColon).replace(/\//g, '\\');
            const weight = p.slice(lastColon + 1);
            return `${file}:${weight}`;
        }
        return p.replace(/\//g, '\\');
    }

    function absolutePath(rel, cwd) {
        const c = String(cwd || window.NL_CWD || '.').replace(/\\/g, '/');
        const r = String(rel || '').replace(/\\/g, '/');
        if (/^[a-zA-Z]:/.test(r) || r.startsWith('//')) return r;
        return (c + '/' + r).replace(/\/+/g, '/');
    }

    // ── SDServerManager ─────────────────────────────────────────────
    class SDServerManager {
        constructor(config = {}) {
            this.config = {
                executablePath: './bin/sd.cpp/sd-server.exe',
                listenIp: '127.0.0.1',
                listenPort: 0, // 0 = auto
                verbose: false,
                ...config,
            };
            this.processId = null;
            this.baseUrl = null;
            this._spawnedProcessHandler = null;
            this._stdout = '';
            this._stderr = '';
            this._state = 'offline'; // offline | starting | ready | error
            this._currentModel = null;
            this._currentJobId = null;
        }

        get state() { return this._state; }
        get currentModel() { return this._currentModel; }
        get currentJobId() { return this._currentJobId; }

        _pickPort(min = 15000, max = 65000) {
            return Math.floor(Math.random() * (max - min) + min);
        }

        async _fetchJson(path, opts = {}) {
            const { method = 'GET', body = null, timeout = 8000 } = opts;
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeout);
            try {
                const res = await fetch(`${this.baseUrl}${path}`, {
                    method,
                    headers: body ? { 'Content-Type': 'application/json' } : undefined,
                    body: body ? JSON.stringify(body) : null,
                    signal: controller.signal,
                });
                clearTimeout(t);
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
                }
                return await res.json().catch(() => null);
            } catch (e) {
                clearTimeout(t);
                throw e;
            }
        }

        _buildArgs(modelPath, extra = {}, isWin = false) {
            const args = [];
            const addPath = (flag, val) => {
                if (val === null || val === undefined || val === '') return;
                let v = String(val);
                if (isWin) v = toWinPath(v);
                args.push(flag, v);
            };
            const add = (flag, val) => {
                if (val === null || val === undefined || val === '') return;
                args.push(flag, String(val));
            };
            addPath('-m', modelPath);
            add('--listen-ip', this.config.listenIp);
            add('--listen-port', this.config.listenPort);
            if (this.config.verbose) args.push('-v');

            addPath('--clip_l', extra.clipL);
            addPath('--clip_g', extra.clipG);
            addPath('--vae', extra.vae);
            addPath('--taesd', extra.taesd);
            addPath('--diffusion-model', extra.diffusionModel);
            add('--type', extra.type);
            add('--threads', extra.threads);
            addPath('--lora-model-dir', extra.loraModelDir);
            addPath('--embd-dir', extra.embdDir);
            add('--backend', extra.backend);
            add('--max-vram', extra.maxVram);
            if (extra.flashAttention) args.push('--fa');
            if (extra.offloadCpu) args.push('--offload-to-cpu');
            if (extra.mmap) args.push('--mmap');
            return args;
        }

        async start(modelPath, opts = {}) {
            if (this._state === 'starting' || this._state === 'ready') {
                if (this._currentModel === modelPath) return true;
                await this.stop();
            }
            if (!window.Neutralino?.os?.spawnProcess) {
                throw new Error('Neutralino spawnProcess not available');
            }

            this._state = 'starting';
            this._currentModel = modelPath;
            this.config.listenPort = this.config.listenPort || this._pickPort();
            this.baseUrl = `http://${this.config.listenIp}:${this.config.listenPort}`;

            const isWin = (window.NL_OS || '').toLowerCase().includes('windows');
            const args = this._buildArgs(modelPath, opts, isWin);

            let exe = absolutePath(this.config.executablePath, window.NL_CWD || '.');
            if (isWin) exe = toWinPath(exe);

            const cmd = [exe, ...args]
                .map(a => (a.includes(' ') ? `"${a}"` : a))
                .join(' ');

            console.log('[SDServer] Starting:', cmd);
            console.log('[SDServer] CWD:', window.NL_CWD || '.');

            const processInfo = await Neutralino.os.spawnProcess(cmd, { cwd: window.NL_CWD || '.' });
            this.processId = processInfo.id;

            this._spawnedProcessHandler = (e) => {
                if (e.detail.id != this.processId) return;
                if (e.detail.action === 'stdOut') this._stdout += e.detail.data;
                else if (e.detail.action === 'stdErr') this._stderr += e.detail.data;
                else if (e.detail.action === 'exit') {
                    const code = e.detail.data;
                    this._state = code === 0 ? 'offline' : 'error';
                    this.processId = null;
                    if (this._spawnedProcessHandler) {
                        Neutralino.events.off('spawnedProcess', this._spawnedProcessHandler);
                        this._spawnedProcessHandler = null;
                    }
                }
            };
            Neutralino.events.on('spawnedProcess', this._spawnedProcessHandler);

            // Wait for HTTP ready
            const t0 = Date.now();
            const maxWait = 90000; // model load can take a while
            while (Date.now() - t0 < maxWait) {
                await new Promise(r => setTimeout(r, 600));
                try {
                    const status = await this._fetchJson('/sdapi/v1/options', { timeout: 3000 });
                    if (status && status.sd_model_checkpoint !== undefined) {
                        this._state = 'ready';
                        console.log('[SDServer] Ready at', this.baseUrl, 'model:', status.sd_model_checkpoint);
                        return true;
                    }
                } catch {
                    // not ready yet
                }
                if (this._state === 'error' || this._state === 'offline') {
                    throw new Error('Server process exited unexpectedly. stderr: ' + this._stderr.slice(-400));
                }
            }
            await this.stop();
            throw new Error('Server failed to start within 90s');
        }

        async stop() {
            if (this._spawnedProcessHandler) {
                Neutralino.events.off('spawnedProcess', this._spawnedProcessHandler);
                this._spawnedProcessHandler = null;
            }
            if (this.processId && window.Neutralino?.os?.updateSpawnedProcess) {
                try {
                    await Neutralino.os.updateSpawnedProcess(this.processId, 'exit');
                } catch (e) {
                    console.warn('[SDServer] Failed to kill process:', e);
                }
            }
            this.processId = null;
            this._state = 'offline';
            this._currentModel = null;
            this.baseUrl = null;
            this._currentJobId = null;
        }

        async generate(params, onStatus = null) {
            if (this._state !== 'ready') throw new Error('Server not ready');

            // Submit async job
            const submit = await this._fetchJson('/sdcpp/v1/img_gen', {
                method: 'POST',
                body: params,
                timeout: 15000,
            });
            if (!submit?.id) throw new Error('Failed to submit job: ' + JSON.stringify(submit));

            this._currentJobId = submit.id;
            const pollUrl = `/sdcpp/v1/jobs/${submit.id}`;
            const t0 = Date.now();
            const maxWait = 15 * 60 * 1000; // 15 min

            while (Date.now() - t0 < maxWait) {
                await new Promise(r => setTimeout(r, 600));
                let job;
                try {
                    job = await this._fetchJson(pollUrl, { timeout: 8000 });
                } catch {
                    continue;
                }
                if (!job) continue;

                if (onStatus) onStatus(job.status, job);

                if (job.status === 'completed') {
                    this._currentJobId = null;
                    if (!job.result?.images?.length) {
                        throw new Error('Job completed but no images returned');
                    }
                    const fmt = job.result.output_format || 'png';
                    return job.result.images.map((img, idx) => ({
                        index: img.index ?? idx,
                        b64: img.b64_json,
                        blob: b64ToBlob(img.b64_json, fmt),
                        format: fmt,
                    }));
                }
                if (job.status === 'failed') {
                    this._currentJobId = null;
                    throw new Error(job.error?.message || 'Generation failed');
                }
                if (job.status === 'cancelled') {
                    this._currentJobId = null;
                    throw new Error('Generation cancelled');
                }
            }

            // Timeout — attempt cancel
            try { await this._fetchJson(`/sdcpp/v1/jobs/${submit.id}/cancel`, { method: 'POST', timeout: 5000 }); } catch {}
            this._currentJobId = null;
            throw new Error('Generation timed out after 15 minutes');
        }

        async cancelCurrent() {
            if (!this._currentJobId) return false;
            try {
                await this._fetchJson(`/sdcpp/v1/jobs/${this._currentJobId}/cancel`, { method: 'POST', timeout: 5000 });
                return true;
            } catch {
                return false;
            }
        }
    }

    // ── Bag → Server Params converter ───────────────────────────────
    async function bagToServerParams(bag, graph) {
        const p = {
            prompt: '',
            negative_prompt: '',
            clip_skip: -1,
            width: 512,
            height: 512,
            strength: 0.75,
            seed: -1,
            batch_count: 1,
            auto_resize_ref_image: true,
            increase_ref_index: false,
            control_strength: 0.9,
            embed_image_metadata: true,
            init_image: null,
            ref_images: [],
            mask_image: null,
            control_image: null,
            sample_params: {
                scheduler: 'discrete',
                sample_method: 'euler_a',
                sample_steps: 20,
                eta: null,
                shifted_timestep: 0,
                custom_sigmas: [],
                flow_shift: null,
                guidance: {
                    txt_cfg: 7.0,
                    img_cfg: null,
                    distilled_guidance: 3.5,
                    slg: { layers: [7, 8, 9], layer_start: 0.01, layer_end: 0.2, scale: 0 },
                },
            },
            lora: [],
            hires: { enabled: false, upscaler: 'Latent', scale: 2.0, target_width: 0, target_height: 0, steps: 0, denoising_strength: 0.7, custom_sigmas: [], upscale_tile_size: 128 },
            vae_tiling_params: { enabled: false, temporal_tiling: false, tile_size_x: 0, tile_size_y: 0, target_overlap: 0.5, rel_size_x: 0.0, rel_size_y: 0.0, extra_tiling_args: '' },
            cache_mode: 'disabled',
            cache_option: '',
            scm_mask: '',
            scm_policy_dynamic: true,
            output_format: 'png',
            output_compression: 100,
        };

        // Simple scalar mappings
        const get = (keys, fallback) => {
            for (const k of Array.isArray(keys) ? keys : [keys]) {
                if (bag.map.has(k)) return bag.map.get(k);
            }
            return fallback;
        };

        const prompt = get(['-p', '--prompt'], '');
        if (prompt) p.prompt = String(prompt);

        const neg = get(['--negative-prompt', '-n'], '');
        if (neg) p.negative_prompt = String(neg);

        const w = get(['-W', '--width']);
        if (w !== undefined) p.width = parseInt(w) || 512;
        const h = get(['-H', '--height']);
        if (h !== undefined) p.height = parseInt(h) || 512;

        const steps = get('--steps');
        if (steps !== undefined) p.sample_params.sample_steps = parseInt(steps) || 20;

        const seed = get(['-s', '--seed']);
        if (seed !== undefined) p.seed = parseInt(seed) ?? -1;

        const cfg = get('--cfg-scale');
        if (cfg !== undefined) p.sample_params.guidance.txt_cfg = parseFloat(cfg) ?? 7.0;

        const guidance = get('--guidance');
        if (guidance !== undefined) p.sample_params.guidance.distilled_guidance = parseFloat(guidance) ?? 3.5;

        const sampler = get('--sampling-method');
        if (sampler) p.sample_params.sample_method = String(sampler);

        const scheduler = get('--schedule');
        if (scheduler) p.sample_params.scheduler = String(scheduler);

        const clipSkip = get('--clip-skip');
        if (clipSkip !== undefined) p.clip_skip = parseInt(clipSkip) ?? -1;

        const strength = get('--strength');
        if (strength !== undefined) p.strength = parseFloat(strength) ?? 0.75;

        const batch = get(['-b', '--batch-count']);
        if (batch !== undefined) p.batch_count = parseInt(batch) || 1;

        const controlStrength = get('--control-strength');
        if (controlStrength !== undefined) p.control_strength = parseFloat(controlStrength) ?? 0.9;

        // Reference images (-r)
        const refs = bag.get('-r');
        if (Array.isArray(refs)) {
            for (const ref of refs) {
                if (typeof ref === 'string' && ref.startsWith('data:image/')) {
                    p.ref_images.push(ref);
                } else if (typeof ref === 'string') {
                    const b64 = await fileToBase64(ref);
                    if (b64) p.ref_images.push(b64);
                }
            }
        }

        // Init image (-i)
        const initImg = get(['-i', '--init-img']);
        if (initImg) {
            if (typeof initImg === 'string' && initImg.startsWith('data:image/')) {
                p.init_image = initImg;
            } else {
                const b64 = await fileToBase64(initImg);
                if (b64) p.init_image = b64;
            }
        }

        // Control image
        const ctrlImg = get('--control-image');
        if (ctrlImg) {
            if (typeof ctrlImg === 'string' && ctrlImg.startsWith('data:image/')) {
                p.control_image = ctrlImg;
            } else {
                const b64 = await fileToBase64(ctrlImg);
                if (b64) p.control_image = b64;
            }
        }

        // LoRA — extract from LoRA node directly (server API ignores <lora:> tags in prompt)
        if (graph?.nodes) {
            for (const node of graph.nodes.values()) {
                if (node.type !== 'lora') continue;
                for (const item of node.data?.items || []) {
                    if (!item.file) continue;
                    p.lora.push({
                        path: normPath(item.file),
                        multiplier: parseFloat(item.weight) || 1.0,
                        is_high_noise: false,
                    });
                }
            }
        }

        // VAE tiling
        if (bag.map.has('--vae-tiling')) {
            p.vae_tiling_params.enabled = true;
        }

        return p;
    }

    // ── Export ──────────────────────────────────────────────────────
    window.SDServerManager = SDServerManager;
    window.SDServerBagConverter = { toParams: bagToServerParams, fileToBase64 };
})();
