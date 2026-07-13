// ╔══════════════════════════════════════════════════════════════════╗
// ║  sd-server-manager.js — SD Server primary, ephemeral cache       ║
// ║  RAM-first: no temp _ref_*.png files, base64 → Blob → Keep/Discard  ║
// ║  Blender-like: generation lives in RAM till user confirms.       ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector || {};

    // ── helpers ──
    const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/"/g, '');
    const uid = (prefix = 'gen') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    function toWinPath(p) {
        if (typeof p !== 'string') return p;
        return p.replace(/\//g, '\\');
    }

    function isWindows() {
        try { return (window.NL_OS || '').toLowerCase().includes('windows'); } catch { return true; }
    }

    function b64FromBytes(bytes) {
        let arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = '';
        const chunk = 8192;
        for (let i = 0; i < arr.length; i += chunk) {
            binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    function blobToDataURL(blob) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve(fr.result);
            fr.onerror = () => reject(fr.error);
            fr.readAsDataURL(blob);
        });
    }

    function dataURLToBlob(dataURL) {
        const comma = dataURL.indexOf(',');
        const meta = dataURL.slice(5, comma);
        const b64 = dataURL.slice(comma + 1);
        const mime = meta.split(';')[0] || 'image/png';
        const binStr = atob(b64);
        const len = binStr.length;
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binStr.charCodeAt(i);
        return new Blob([bytes], { type: mime });
    }

    async function refToBase64(ref) {
        if (!ref) return null;
        if (typeof ref !== 'string') return null;
        const s = ref.trim();
        if (!s) return null;
        if (s.startsWith('data:image/')) return s;
        if (s.startsWith('blob:')) {
            try {
                const res = await fetch(s);
                const blob = await res.blob();
                return await blobToDataURL(blob);
            } catch (e) {
                console.warn('[SD Server] blob url to base64 failed', e);
                return null;
            }
        }
        if (/^https?:\/\//i.test(s)) {
            try {
                const res = await fetch(s);
                const blob = await res.blob();
                return await blobToDataURL(blob);
            } catch (e) {
                console.warn('[SD Server] http url to base64 failed', s, e);
                return null;
            }
        }
        if (window.Neutralino?.filesystem?.readBinaryFile) {
            try {
                const bin = await Neutralino.filesystem.readBinaryFile(s);
                const ext = s.split('.').pop().toLowerCase();
                const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
                const b64 = b64FromBytes(bin);
                return `data:${mime};base64,${b64}`;
            } catch (e) {
                const alt = normPath(s);
                if (alt !== s) {
                    try {
                        const bin2 = await Neutralino.filesystem.readBinaryFile(alt);
                        const ext = alt.split('.').pop().toLowerCase();
                        const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
                        const b64 = b64FromBytes(bin2);
                        return `data:${mime};base64,${b64}`;
                    } catch {}
                }
                return null;
            }
        }
        try {
            const S = window.VisualProjector?.state;
            if (S?.gallery?.get) {
                const asset = S.gallery.get(s);
                if (asset) {
                    if (asset.base64 && asset.base64.startsWith('data:image/')) return asset.base64;
                    if (asset.url && asset.url.startsWith('data:image/')) return asset.url;
                    if (asset.blob) return await blobToDataURL(asset.blob);
                    if (asset.url) return await refToBase64(asset.url);
                }
            }
        } catch {}
        return null;
    }

    // ── SD Server Manager ──
    class SDServerManager {
        constructor() {
            this.host = '127.0.0.1';
            this.port = 8085;
            this.executablePath = './bin/sd.cpp/sd-server.exe';
            this.processId = null;
            this.isRunning = false;
            this.isStarting = false;
            this.modelPath = null;
            this.lastLogs = [];
            this.status = 'stopped';
            this._logListeners = new Set();
            this._processHandler = null;
            this._capabilities = null;
            this._lastExitCode = null;
            this._useNewFlags = false; // false = --host/--port, true = --listen-ip/--listen-port
            this.ephemeral = new Map();
            SEnsureEphemeral();
            console.log('[SD Server] Manager created — ready for ephemeral gen');
        }

        get urlBase() {
            return `http://${this.host}:${this.port}`;
        }

        getConfig() {
            return {
                executablePath: this.executablePath,
                host: this.host,
                port: this.port,
                modelPath: this.modelPath,
                status: this.status,
                isRunning: this.isRunning,
                useNewFlags: this._useNewFlags,
            };
        }

        setConfig(cfg = {}) {
            if (cfg.executablePath) this.executablePath = normPath(cfg.executablePath);
            if (cfg.host) this.host = String(cfg.host).trim();
            if (cfg.port) this.port = Number(cfg.port) || this.port;
            if (typeof cfg.useNewFlags === 'boolean') this._useNewFlags = cfg.useNewFlags;
            try {
                const AS = window.VisualProjector?.assetStudio;
                if (AS?.config) {
                    AS.config.serverExecutablePath = this.executablePath;
                    AS.config.serverHost = this.host;
                    AS.config.serverPort = this.port;
                }
            } catch {}
        }

        onLog(cb) {
            if (typeof cb === 'function') this._logListeners.add(cb);
            return () => this._logListeners.delete(cb);
        }

        _emitLog(line, level = 'info') {
            this.lastLogs.push(`[${new Date().toLocaleTimeString()}] ${line}`);
            if (this.lastLogs.length > 600) this.lastLogs = this.lastLogs.slice(-450);
            for (const l of this._logListeners) {
                try { l(line, level); } catch {}
            }
            // Also mirror to console for F12
            if (level === 'error') console.error(`[SD Server] ${line}`);
            else if (level === 'warn') console.warn(`[SD Server] ${line}`);
            else console.log(`[SD Server] ${line}`);
        }

        async _waitForServerReady(timeoutMs = 35000) {
            const start = Date.now();
            let attempts = 0;
            while (Date.now() - start < timeoutMs) {
                attempts++;
                // Early exit if process died
                if (!this.isRunning && !this.isStarting) {
                    this._emitLog(`Process died during startup (exit ${this._lastExitCode}). Last logs:\n${this.lastLogs.slice(-12).join('\n')}`, 'error');
                    return false;
                }
                // Try both endpoints
                try {
                    const res = await fetch(`${this.urlBase}/v1/models`, { method: 'GET', cache: 'no-store' });
                    if (res.ok) {
                        this._emitLog(`Server ready at ${this.urlBase} (${Math.round((Date.now() - start)/1000)}s, ${attempts} checks)`, 'ok');
                        return true;
                    }
                } catch (e) {
                    if (attempts % 6 === 1) this._emitLog(`Waiting ${this.urlBase}/v1/models — ${e.message || 'refused'}`, 'info');
                }
                try {
                    const res2 = await fetch(`${this.urlBase}/sdcpp/v1/capabilities`, { method: 'GET', cache: 'no-store' });
                    if (res2.ok) {
                        const cap = await res2.json();
                        this._capabilities = cap;
                        this._emitLog(`Server capabilities loaded`, 'ok');
                        return true;
                    }
                } catch {}
                await new Promise(r => setTimeout(r, 700));
            }
            return false;
        }

        async healthCheck() {
            try {
                const res = await fetch(`${this.urlBase}/sdcpp/v1/capabilities`, { cache: 'no-store' });
                if (res.ok) {
                    this._capabilities = await res.json();
                    return { ok: true, capabilities: this._capabilities };
                }
                return { ok: false, status: res.status };
            } catch (e) {
                return { ok: false, error: e.message || e };
            }
        }

        _buildServerArgs({ modelPath, vaePath, clipLPath, clipGPath, t5xxlPath, llmVisionPath, extra = {} } = {}, useNewFlags = false) {
            const win = isWindows();
            const qp = (p) => {
                if (!p) return p;
                let pp = normPath(p);
                if (win) pp = toWinPath(pp);
                if (pp.includes(' ') && !pp.startsWith('"')) return `"${pp}"`;
                return pp;
            };
            const isLLMPath = (p) => {
                if (!p) return false;
                const l = p.toLowerCase();
                return l.includes('qwen') || l.includes('llm') || l.includes('instruct') || l.includes('/vl') || l.includes('-vl-') || l.includes('vision') && !l.includes('mmproj');
            };
            const isMMProj = (p) => {
                if (!p) return false;
                const l = p.toLowerCase();
                return l.includes('mmproj') || l.includes('proj') && (l.includes('vision') || l.includes('qwen'));
            };

            const args = [];
            // Model: for gguf diffusion models (flux, qwen, sd3) prefer --diffusion-model, else -m
            if (modelPath) {
                const lower = modelPath.toLowerCase();
                if (lower.endsWith('.gguf')) {
                    // Use diffusion-model for gguf (covers qwen, flux, sd3, etc). Also keep -m as fallback? Use diffusion-model primary
                    args.push('--diffusion-model', qp(modelPath));
                } else {
                    args.push('-m', qp(modelPath));
                }
            }
            if (vaePath) args.push('--vae', qp(vaePath));

            // clip_l / llm handling
            if (clipLPath) {
                const lower = clipLPath.toLowerCase();
                if (lower.includes('qwen') || isLLMPath(clipLPath) && !isMMProj(clipLPath)) {
                    // Qwen or generic LLM -> --llm
                    args.push('--llm', qp(clipLPath));
                    // Also push as clip_l for older builds that might expect it? No, would fail. So only llm.
                } else if (isMMProj(clipLPath)) {
                    args.push('--llm_vision', qp(clipLPath));
                } else {
                    args.push('--clip_l', qp(clipLPath));
                }
                // If path is clearly llm but also need clip_l? For SDXL, clip_l is different. For safety, if not qwen, also push as clip_l.
                // For qwen case, don't double-push
            }
            if (clipGPath) {
                // clip_g sometimes needed
                const lower = clipGPath.toLowerCase();
                if (isMMProj(clipGPath)) args.push('--llm_vision', qp(clipGPath));
                else args.push('--clip_g', qp(clipGPath));
            }
            if (t5xxlPath) {
                const lower = t5xxlPath.toLowerCase();
                if (isMMProj(t5xxlPath)) {
                    args.push('--llm_vision', qp(t5xxlPath));
                } else if (lower.includes('qwen') || isLLMPath(t5xxlPath)) {
                    // If user put LLM in t5xxl field
                    args.push('--llm', qp(t5xxlPath));
                } else {
                    args.push('--t5xxl', qp(t5xxlPath));
                }
            }
            if (llmVisionPath) {
                args.push('--llm_vision', qp(llmVisionPath));
            }

            if (extra.threads) args.push('-t', String(extra.threads));
            if (extra.clipOnCpu) args.push('--clip-on-cpu');
            if (extra.vaeOnCpu) args.push('--vae-on-cpu');
            if (extra.offloadToCpu) args.push('--offload-to-cpu');
            if (extra.diffusionFa) args.push('--diffusion-fa');
            if (extra.loraDir) args.push('--lora-model-dir', qp(extra.loraDir));
            // Qwen zero cond flag - pass through if present in extra
            if (extra.qwenZeroCond) args.push('--qwen-image-zero-cond-t');

            if (useNewFlags) {
                args.push('--listen-ip', this.host);
                args.push('--listen-port', String(this.port));
            } else {
                args.push('--host', this.host);
                args.push('--port', String(this.port));
            }
            args.push('-v');
            return args.join(' ');
        }

        _buildCommand(argsStr) {
            let exe = normPath(this.executablePath);
            if (isWindows()) exe = toWinPath(exe);
            // Quote exe if spaces and not already quoted
            if (exe.includes(' ') && !exe.startsWith('"')) exe = `"${exe}"`;
            return `${exe} ${argsStr}`;
        }

        async _spawnOnce(argsStr) {
            const cwd = window.NL_CWD || '.';
            const cmd = this._buildCommand(argsStr);
            this._lastCommand = cmd;
            this._emitLog(`Spawning: ${cmd} @ ${cwd}`, 'info');
            try {
                const proc = await Neutralino.os.spawnProcess(cmd, { cwd });
                this.processId = proc.id;
                this.isRunning = true;
                this._lastExitCode = null;
                this._bindProcessEvents();
                this._emitLog(`Spawned sd-server pid=${proc.id} at ${this.urlBase}`, 'ok');
                return proc;
            } catch (e) {
                this._emitLog(`spawnProcess failed: ${e.message || e}`, 'error');
                throw e;
            }
        }

        getLastCommand() {
            return this._lastCommand || '';
        }

        copyLastCommandToClipboard() {
            const cmd = this.getLastCommand();
            if (!cmd) return false;
            try {
                navigator.clipboard?.writeText(cmd);
                return true;
            } catch { return false; }
        }

        async start(opts = {}) {
            if (this.isRunning) {
                this._emitLog('Server already running', 'warn');
                return true;
            }
            if (this.isStarting) {
                this._emitLog('Server starting in progress', 'warn');
                return false;
            }
            if (!window.Neutralino?.os?.spawnProcess) {
                this._emitLog('Neutralino spawnProcess not available — browser fallback cannot start sd-server', 'error');
                VP.showToast?.('SD Server requires Neutralino desktop', 'error');
                return false;
            }

            const modelPath = normPath(opts.modelPath || this.modelPath || '');
            if (!modelPath) {
                this._emitLog('No model path for server start', 'error');
                VP.showToast?.('Set model path in Loader node first', 'warn');
                return false;
            }

            if (window.Neutralino?.filesystem?.getStats) {
                try {
                    await Neutralino.filesystem.getStats(this.executablePath);
                } catch {
                    const alt = this.executablePath.replace(/\\/g, '/');
                    try {
                        await Neutralino.filesystem.getStats(alt);
                    } catch {
                        this._emitLog(`Server executable not found: ${this.executablePath}`, 'error');
                        VP.showToast?.(`sd-server.exe not found: ${this.executablePath}`, 'error');
                        return false;
                    }
                }
            }

            const extra = opts.extra || {};
            const common = {
                modelPath,
                vaePath: opts.vaePath,
                clipLPath: opts.clipLPath,
                clipGPath: opts.clipGPath || null,
                t5xxlPath: opts.t5xxlPath,
                llmVisionPath: opts.llmVisionPath || null,
                extra,
            };

            this.isStarting = true;
            this.status = 'starting';
            this.modelPath = modelPath;
            this.lastLogs = [];
            this._lastExitCode = null;

            // Try old flags first unless we already know new flags needed
            const flagsToTry = this._useNewFlags ? [true, false] : [false, true];

            for (let attempt = 0; attempt < flagsToTry.length; attempt++) {
                const useNew = flagsToTry[attempt];
                const flagLabel = useNew ? '--listen-ip/--listen-port (new)' : '--host/--port (old)';
                this._emitLog(`Attempt ${attempt+1}/${flagsToTry.length}: ${flagLabel}`, 'info');
                const argStr = this._buildServerArgs(common, useNew);
                try {
                    await this._spawnOnce(argStr);
                } catch (e) {
                    this._emitLog(`Spawn attempt ${attempt+1} failed: ${e.message}`, 'error');
                    continue;
                }

                const ready = await this._waitForServerReady(20000);
                if (ready) {
                    this.status = 'running';
                    this.isStarting = false;
                    this._useNewFlags = useNew; // remember working style
                    VP.showToast?.(`🟢 SD Server running at ${this.urlBase} (${flagLabel})`, 'success');
                    return true;
                }

                // Not ready — check if process died quickly (wrong flags)
                if (!this.isRunning) {
                    const last = this.lastLogs.slice(-20).join('\n').toLowerCase();
                    const isFlagError = last.includes('unknown') || last.includes('unrecognized') || last.includes('host') || last.includes('listen') || last.includes('port');
                    this._emitLog(`Server died quickly (exit ${this._lastExitCode}). Flag error suspect: ${isFlagError}. Trying other flag style...`, isFlagError ? 'warn' : 'error');
                    // Small delay before retry
                    await new Promise(r => setTimeout(r, 800));
                    // Ensure stopped state
                    this.processId = null;
                    this.isRunning = false;
                    continue;
                } else {
                    // Still running but not responding — keep it? For now stop and retry other flags
                    this._emitLog('Server process still alive but not responding, stopping for retry...', 'warn');
                    await this.stop();
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
            }

            // All attempts failed
            this._emitLog(`All flag attempts failed. Last logs:\n${this.lastLogs.slice(-30).join('\n')}`, 'error');
            this.status = 'error';
            this.isStarting = false;
            VP.showToast?.(`SD Server start failed — check logs. Try running ${this.executablePath} --help in terminal`, 'error');
            return false;
        }

        _bindProcessEvents() {
            if (this._processHandler) {
                try { Neutralino.events.off('spawnedProcess', this._processHandler); } catch {}
            }
            const pid = this.processId;
            this._processHandler = (e) => {
                if (e.detail.id != pid) return;
                if (e.detail.action === 'stdOut' || e.detail.action === 'stdErr') {
                    const data = String(e.detail.data || '');
                    const clean = data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
                    const lines = clean.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
                    for (const l of lines) {
                        // Detect ready message
                        if (l.toLowerCase().includes('server listening') || l.toLowerCase().includes('listening on')) {
                            this._emitLog(l, 'ok');
                        } else {
                            this._emitLog(l, e.detail.action === 'stdErr' ? 'stderr' : 'stdout');
                        }
                    }
                } else if (e.detail.action === 'exit') {
                    const code = e.detail.data;
                    this._lastExitCode = code;
                    const joined = this.lastLogs.slice(-30).join('\n').toLowerCase();
                    if (joined.includes('new_sd_ctx') || joined.includes('failed to create') || joined.includes('clip')) {
                        this._emitLog(`❌ new_sd_ctx_t failed — model loading error. Check if diffusion model + VAE + LLM paths are compatible. Try with only diffusion model first.`, 'error');
                        this._emitLog(`💡 Manual test: open PowerShell in project folder and run:\n${this._lastCommand || '(no command yet)'}`, 'warn');
                    }
                    this._emitLog(`Server exited with code ${code}`, code === 0 ? 'ok' : 'error');
                    this.isRunning = false;
                    this.status = code === 0 ? 'stopped' : 'error';
                    this.processId = null;
                    try { Neutralino.events.off('spawnedProcess', this._processHandler); } catch {}
                    this._processHandler = null;
                }
            };
            Neutralino.events.on('spawnedProcess', this._processHandler);
        }

        async stop() {
            if (!this.processId) {
                this._emitLog('Server not running (no pid)', 'info');
                this.isRunning = false;
                this.status = 'stopped';
                return true;
            }
            try {
                this._emitLog('Stopping sd-server...', 'info');
                if (window.Neutralino?.os?.updateSpawnedProcess) {
                    await Neutralino.os.updateSpawnedProcess(this.processId, 'exit');
                }
                await new Promise(r => setTimeout(r, 900));
                this.isRunning = false;
                this.status = 'stopped';
                this.processId = null;
                if (this._processHandler) {
                    try { Neutralino.events.off('spawnedProcess', this._processHandler); } catch {}
                    this._processHandler = null;
                }
                this._emitLog('Server stopped', 'ok');
                VP.showToast?.('🔴 SD Server stopped', 'info');
                return true;
            } catch (e) {
                this._emitLog(`Stop failed: ${e.message || e}`, 'error');
                return false;
            }
        }

        async unload() {
            this._emitLog('Unload model — stopping server to free VRAM', 'info');
            await this.stop();
            try {
                await fetch(`${this.urlBase}/models/unload`, { method: 'POST' });
            } catch {}
            try {
                const S = window.VisualProjector?.state;
                if (S) S.sdServerUnloadedAt = Date.now();
            } catch {}
            VP.showToast?.('Model unloaded (server stopped, VRAM freed)', 'success');
        }

        addEphemeral({ blob, prompt, assetName, payload }) {
            const id = uid('ephem');
            const url = URL.createObjectURL(blob);
            const entry = { id, blob, url, prompt, assetName: assetName || null, payload: payload || null, ts: Date.now() };
            this.ephemeral.set(id, entry);
            SEnsureEphemeral();
            const S = window.VisualProjector?.state;
            if (S) {
                if (!S.ephemeral) S.ephemeral = {};
                if (!S.ephemeral.generated) S.ephemeral.generated = this.ephemeral;
            }
            return entry;
        }

        removeEphemeral(id) {
            const entry = this.ephemeral.get(id);
            if (entry) {
                try { URL.revokeObjectURL(entry.url); } catch {}
                this.ephemeral.delete(id);
                return true;
            }
            return false;
        }

        clearEphemeral() {
            for (const [id, e] of this.ephemeral) {
                try { URL.revokeObjectURL(e.url); } catch {}
            }
            this.ephemeral.clear();
        }

        async generateFromGraph({ logCallback, progressCallback } = {}) {
            const Graph = window.VP_AS?.Graph;
            if (!Graph) throw new Error('Graph not available');
            const nodes = Array.from(Graph.nodes.values());
            const loaderNode = nodes.find(n => n.type === 'loader');
            const promptNode = nodes.find(n => n.type === 'prompt');
            const samplerNode = nodes.find(n => n.type === 'sampler');
            const loraNode = nodes.find(n => n.type === 'lora');

            const modelPath = loaderNode?.data?.coreModel || loaderNode?.data?.diffusionModel || '';
            if (!modelPath) throw new Error('No model set in Loader node');

            // Extract possible llm vision from loader: clip2 may hold mmproj
            const getLoaderVal = (keys) => {
                for (const k of keys) {
                    if (loaderNode?.data?.[k]) return loaderNode.data[k];
                }
                return null;
            };
            const vaePath = getLoaderVal(['vae', 'vaePath']);
            const clipLPath = getLoaderVal(['clip1', 'clip_l', 'llm', 'coreModel']) && loaderNode?.data?.clip1 ? loaderNode.data.clip1 : getLoaderVal(['clip1', 'llm']);
            const clipGPath = getLoaderVal(['clip2', 'clip_g']);
            const t5xxlPath = getLoaderVal(['t5xxl', 't5']);
            const llmVisionPath = getLoaderVal(['llmVision', 'llm_vision', 'mmproj', 'clipVision']);

            if (!this.isRunning) {
                const extra = {
                    threads: loaderNode?.data?.threads,
                    clipOnCpu: loaderNode?.data?.clipOnCpu,
                    vaeOnCpu: loaderNode?.data?.vaeOnCpu,
                    offloadToCpu: loaderNode?.data?.offloadToCpu,
                    diffusionFa: loaderNode?.data?.diffusionFa,
                    loraDir: loraNode?.data?.loraDir || getLoaderVal(['loraDir', 'lora_model_dir']) || '',
                };
                await this.start({ modelPath, vaePath, clipLPath, clipGPath, t5xxlPath, llmVisionPath, extra });
                if (!this.isRunning) {
                    // Fallback: try with only diffusion model, no extra encoders (helps diagnose Qwen mismatch)
                    this._emitLog('First start failed, retrying with only diffusion model (no VAE/CLIP) as fallback...', 'warn');
                    if (logCallback) logCallback('First start failed, retrying with only diffusion model...', 'warn');
                    await this.start({ modelPath, extra: { threads: extra.threads } });
                    if (!this.isRunning) throw new Error(`Failed to start SD Server. Last logs:\n${this.lastLogs.slice(-40).join('\n')}`);
                }
            } else if (this.modelPath !== modelPath) {
                if (logCallback) logCallback(`Model changed from ${this.modelPath} to ${modelPath}, restarting server...`, 'warn');
                await this.stop();
                await new Promise(r => setTimeout(r, 500));
                const extra = {
                    threads: loaderNode?.data?.threads,
                    clipOnCpu: loaderNode?.data?.clipOnCpu,
                    vaeOnCpu: loaderNode?.data?.vaeOnCpu,
                    offloadToCpu: loaderNode?.data?.offloadToCpu,
                    diffusionFa: loaderNode?.data?.diffusionFa,
                    loraDir: loraNode?.data?.loraDir || '',
                };
                await this.start({ modelPath, vaePath, clipLPath, clipGPath, t5xxlPath, llmVisionPath, extra });
            }

            let promptText = '';
            let negativePrompt = '';
            let assetName = null;
            let referenceImages = [];

            if (promptNode) {
                const activeTab = promptNode.data.tabs?.find(t => t.id === promptNode.data.activeTabId) || promptNode.data.tabs?.[0];
                if (activeTab) {
                    const text = activeTab.text || '';
                    const nameMatch = text.match(/\{\s*name\s*:\s*(.+?)\s*\}/i);
                    if (nameMatch) assetName = nameMatch[1].trim();
                    promptText = text.replace(/\{[^}]+\}/g, '').trim();
                }
                negativePrompt = promptNode.data.negative || '';
                const refs = Array.isArray(promptNode.data.reference) ? promptNode.data.reference : [];
                if (refs.length) {
                    if (logCallback) logCallback(`Resolving ${refs.length} reference image(s) to base64...`, 'info');
                    for (const ref of refs) {
                        const b64 = await refToBase64(ref);
                        if (b64) referenceImages.push(b64);
                        else if (logCallback) logCallback(`Failed to resolve ref: ${String(ref).slice(0, 80)}`, 'warn');
                    }
                }
            }

            const width = Number(samplerNode?.data?.width || 512);
            const height = Number(samplerNode?.data?.height || 512);
            const steps = Number(samplerNode?.data?.steps || 20);
            const cfg = Number(samplerNode?.data?.cfg ?? samplerNode?.data?.cfgScale ?? 7.0);
            const seed = Number(samplerNode?.data?.seed ?? -1);
            const strength = samplerNode?.data?.strength != null ? Number(samplerNode.data.strength) : 0.75;
            const samplerMethod = samplerNode?.data?.sampler || 'euler_a';
            const scheduler = samplerNode?.data?.scheduler || 'discrete';
            const clipSkip = samplerNode?.data?.clipSkip != null ? Number(samplerNode.data.clipSkip) : -1;

            const loraList = [];
            if (loraNode?.data?.items) {
                for (const item of loraNode.data.items) {
                    if (!item.file) continue;
                    loraList.push({ path: item.file, multiplier: Number(item.weight) || 1.0 });
                }
            }

            let init_image = null;
            let ref_images = [];
            if (referenceImages.length) {
                if (strength < 1.0 && referenceImages.length > 0) {
                    init_image = referenceImages[0];
                    ref_images = referenceImages.slice(1);
                } else {
                    ref_images = referenceImages;
                }
            }

            const payload = {
                prompt: promptText || 'a photo',
                negative_prompt: negativePrompt || '',
                width,
                height,
                seed,
                strength,
                clip_skip: clipSkip,
                batch_count: 1,
                sample_params: {
                    sample_steps: steps,
                    sample_method: samplerMethod,
                    scheduler,
                    guidance: { txt_cfg: cfg }
                },
                lora: loraList,
                output_format: 'png',
                output_compression: 100,
            };
            if (init_image) payload.init_image = init_image;
            if (ref_images.length) payload.ref_images = ref_images;
            payload.width = Math.max(64, Math.min(2048, payload.width));
            payload.height = Math.max(64, Math.min(2048, payload.height));

            if (logCallback) logCallback(`Payload: ${promptText.slice(0, 80)}... ${width}x${height} steps=${steps} cfg=${cfg} seed=${seed} lora=${loraList.length} refs=${referenceImages.length}`, 'info');

            return await this.generate(payload, { logCallback, progressCallback, assetName, prompt: promptText });
        }

        async generate(payload, { logCallback, progressCallback, assetName, prompt } = {}) {
            const startTime = Date.now();
            if (!this.isRunning) throw new Error('SD Server not running');

            const submitUrl = `${this.urlBase}/sdcpp/v1/img_gen`;
            if (logCallback) logCallback(`POST ${submitUrl}`, 'info');

            let jobId = null;
            try {
                const res = await fetch(submitUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                if (!res.ok) {
                    const txt = await res.text().catch(() => '');
                    throw new Error(`Submit failed ${res.status}: ${txt.slice(0, 500)}`);
                }
                const data = await res.json();
                jobId = data.id;
                if (logCallback) logCallback(`Job queued: ${jobId}`, 'ok');
            } catch (e) {
                if (logCallback) logCallback(`Submit error: ${e.message}`, 'error');
                throw e;
            }

            const pollUrl = `${this.urlBase}/sdcpp/v1/jobs/${jobId}`;
            let lastStatus = '';
            while (true) {
                await new Promise(r => setTimeout(r, 600));
                try {
                    const r = await fetch(pollUrl, { cache: 'no-store' });
                    if (!r.ok) {
                        if (r.status === 404 || r.status === 410) throw new Error(`Job ${jobId} not found (${r.status})`);
                        continue;
                    }
                    const job = await r.json();
                    if (job.status !== lastStatus) {
                        lastStatus = job.status;
                        if (logCallback) logCallback(`Job ${jobId}: ${job.status} ${job.queue_position != null ? `(queue ${job.queue_position})` : ''}`, 'info');
                    }
                    if (progressCallback) {
                        if (job.status === 'queued') progressCallback(10 + Math.min(20, (job.queue_position || 0) * 2), `Queued #${job.queue_position || 0}`);
                        else if (job.status === 'generating') progressCallback(50, 'Generating...');
                    }
                    if (job.status === 'completed') {
                        const images = job.result?.images || [];
                        if (!images.length) throw new Error('No images in completed job');
                        const b64 = images[0].b64_json;
                        if (!b64) throw new Error('No b64_json in result');
                        const blob = dataURLToBlob(`data:image/png;base64,${b64}`);
                        const elapsed = Math.floor((Date.now() - startTime) / 1000);
                        if (logCallback) logCallback(`✅ Done in ${elapsed}s — ${blob.size} bytes`, 'ok');
                        if (progressCallback) progressCallback(100, `Done in ${elapsed}s`);
                        const entry = this.addEphemeral({ blob, prompt: prompt || payload.prompt, assetName: assetName || null, payload });
                        return { blob, url: entry.url, ephemeralId: entry.id, jobId, elapsed, assetName };
                    } else if (job.status === 'failed') {
                        const errMsg = job.error?.message || 'Generation failed';
                        if (logCallback) logCallback(`❌ Failed: ${errMsg}`, 'error');
                        throw new Error(errMsg);
                    } else if (job.status === 'cancelled') {
                        if (logCallback) logCallback(`⏹ Cancelled`, 'warn');
                        throw new Error('Cancelled');
                    }
                } catch (e) {
                    if (e.message.includes('not found') || e.message.includes('Failed') || e.message.includes('Cancelled')) throw e;
                    if (logCallback) logCallback(`Poll error (retrying): ${e.message}`, 'warn');
                }
            }
        }

        async cancelJob(jobId) {
            if (!jobId) return;
            try {
                await fetch(`${this.urlBase}/sdcpp/v1/jobs/${jobId}/cancel`, { method: 'POST' });
            } catch {}
        }
    }

    function SEnsureEphemeral() {
        try {
            const VPState = window.VisualProjector?.state;
            if (!VPState) return;
            if (!VPState.ephemeral) VPState.ephemeral = {};
            if (!VPState.ephemeral.generated) VPState.ephemeral.generated = new Map();
        } catch {}
    }

    const singleton = new SDServerManager();
    window.VP_SD_SERVER = singleton;
    window.SDServerManager = SDServerManager;
    if (window.VisualProjector) {
        window.VisualProjector.sdServer = singleton;
    } else {
        const iv = setInterval(() => {
            if (window.VisualProjector) {
                window.VisualProjector.sdServer = singleton;
                clearInterval(iv);
            }
        }, 300);
        setTimeout(() => clearInterval(iv), 10000);
    }

    console.log('[SD Server] Manager loaded — ephemeral cache, server primary, dual-flag support');
})();
