// ╔══════════════════════════════════════════════════════════════════╗
// ║  as-core.js                                                      ║
// ║  Asset Studio — shared core: utils, ArgumentBag, Viewport,       ║
// ║  NodeBase and NodeRegistry.                                      ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP) return;

    const S = VP.state;
    const DB = window.VP_DB;

    // ════════════════════════════════════════════════════════════════
    //  UTILS
    // ════════════════════════════════════════════════════════════════
    const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
    const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/"/g, '');
    const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

    async function pickFile(opts = {}) {
        if (window.Neutralino?.os?.showOpenDialog) {
            try {
                const res = await Neutralino.os.showOpenDialog(opts.title || 'Select file', {
                    filters: opts.filters || [{ name: 'All files', extensions: ['*'] }],
                    multiSelections: false,
                });
                if (typeof res === 'string') return res || null;
                if (Array.isArray(res) && res.length) return res[0];
                if (res?.selectedEntry) return res.selectedEntry;
                if (Array.isArray(res?.selectedEntries) && res.selectedEntries.length) return res.selectedEntries[0];
                return null;
            } catch (err) {
                console.warn('[Asset Studio] Native file dialog failed:', err);
            }
        }
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = opts.accept || '';
            input.addEventListener('change', () => {
                const f = input.files?.[0];
                resolve(f ? (f.path || f.name) : null);
            });
            input.click();
        });
    }

    function detectModelType(path) {
        const p = normPath(path).toLowerCase();
        if (p.includes('/checkpoints/') || p.endsWith('.ckpt')) return 'checkpoint';
        if (p.includes('/unet/')) return 'unet';
        if (p.includes('/text_encoders/')) return 'llm';
        if (p.includes('/vae/')) return 'vae';
        if (p.includes('/loras/')) return 'lora';
        return 'unknown';
    }

    function normalizeDroppedImageRef(raw) {
        if (!raw) return null;
        if (typeof raw === 'object') {
            for (const key of ['path', 'filePath', 'sourcePath', 'url', 'base64']) {
                if (raw[key]) return normalizeDroppedImageRef(raw[key]);
            }
            if (raw.tag && S?.gallery?.get) {
                const asset = S.gallery.get(raw.tag);
                if (asset) return normalizeDroppedImageRef(asset);
            }
            return null;
        }
        let value = String(raw).trim();
        if (!value) return null;

        if (S?.gallery?.get) {
            const asset = S.gallery.get(value);
            if (asset) {
                const resolved = normalizeDroppedImageRef(asset);
                if (resolved) return resolved;
            }
        }

        if (/^file:\/\//i.test(value)) value = value.replace(/^file:\/\//i, '');
        if (/^\/{3}[a-zA-Z]:/.test(value)) value = value.replace(/^\//, '');
        if (/^data:image\//i.test(value)) return value;
        if (/^https?:\/\//i.test(value) || /^blob:/i.test(value)) return value;
        if (IMAGE_EXT_RE.test(value) || /^[a-zA-Z]:[\/]/.test(value) || value.startsWith('./') || value.startsWith('../') || value.startsWith('/')) {
            return normPath(value);
        }
        return null;
    }

    async function extractDroppedImageRefs(dataTransfer, max = 8) {
        const found = [];
        const pushRef = (ref) => {
            const normalized = normalizeDroppedImageRef(ref);
            if (!normalized) return;
            if (!found.includes(normalized)) found.push(normalized);
        };

        if (!dataTransfer) return found;

        const files = Array.from(dataTransfer.files || []);
        for (const file of files) {
            if (found.length >= max) break;
            const path = file.path || file.name || '';
            if (path) pushRef(path);
        }

        for (const type of Array.from(dataTransfer.types || [])) {
            if (found.length >= max) break;
            let raw = '';
            try { raw = dataTransfer.getData(type) || ''; }
            catch { raw = ''; }
            if (!raw) continue;

            if (type === 'application/json' || type === 'application/x-vp-asset' || type === 'application/x-vp-gallery-asset') {
                try {
                    const parsed = JSON.parse(raw);
                    if (Array.isArray(parsed)) parsed.forEach(pushRef);
                    else pushRef(parsed);
                    continue;
                } catch {}
            }

            const lines = raw
                .split(/\r?\n/)
                .map(x => x.trim())
                .filter(Boolean)
                .filter(x => !x.startsWith('#'));
            lines.forEach(pushRef);
        }

        return found.slice(0, max);
    }

    // ════════════════════════════════════════════════════════════════
    //  ARGUMENT BAG
    // ════════════════════════════════════════════════════════════════
    class ArgumentBag {
        constructor() {
            this.map = new Map();
            this.meta = new Map();
        }

        set(key, value) {
            this.map.set(key, value);
            this.meta.set(key, { multi: false });
            return this;
        }

        addMulti(key, value) {
            if (!this.map.has(key)) {
                this.map.set(key, []);
                this.meta.set(key, { multi: true });
            }
            this.map.get(key).push(value);
            return this;
        }

        get(key) {
            return this.map.get(key);
        }

        toCLI() {
            const parts = [];
            for (const [key, val] of this.map) {
                if (Array.isArray(val)) {
                    for (const v of val) parts.push(key, String(v));
                } else if (val === true) {
                    parts.push(key);
                } else if (val !== false) {
                    parts.push(key, String(val));
                }
            }
            return parts;
        }

        toCommandString(executable = './bin/sd.cpp/sd-cli.exe') {
            const parts = [executable, ...this.toCLI()];
            return parts.map(p => (p.includes(' ') ? `"${p}"` : p)).join(' ');
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  VIEWPORT (zoom/pan) — Blender-style navigation
    // ════════════════════════════════════════════════════════════════
    class Viewport {
        constructor(canvas, world) {
            this.canvas = canvas;
            this.world = world;
            this.x = 0;
            this.y = 0;
            this.scale = 1;
            this.minScale = 0.2;
            this.maxScale = 3.0;
            this.isPanning = false;
            this.panStart = { x: 0, y: 0 };
            this.viewStart = { x: 0, y: 0 };
            this.spaceDown = false;
            this.onChange = null;
            this.onFrameAll = null;
            this._lastCanvasSize = this._measureCanvas();
            this._bindEvents();
            this._apply();
        }

        _measureCanvas() {
            const rect = this.canvas?.getBoundingClientRect?.() || { width: 0, height: 0 };
            return {
                width: Math.max(0, Number(rect.width) || 0),
                height: Math.max(0, Number(rect.height) || 0),
            };
        }

        _hasInteractiveTransform() {
            return Math.abs(this.x) > 0.001 || Math.abs(this.y) > 0.001 || Math.abs(this.scale - 1) > 0.001;
        }

        centerWorldPoint(worldX, worldY, screenX, screenY) {
            this.x = screenX - worldX * this.scale;
            this.y = screenY - worldY * this.scale;
            this._apply();
        }

        handleResize({ preserveCenter = true } = {}) {
            const previous = this._lastCanvasSize || this._measureCanvas();
            const current = this._measureCanvas();
            this._lastCanvasSize = current;

            if (!current.width || !current.height) return false;
            if (Math.abs(previous.width - current.width) < 0.5 && Math.abs(previous.height - current.height) < 0.5) return false;

            if (preserveCenter && this._hasInteractiveTransform() && previous.width > 0 && previous.height > 0) {
                const worldCenter = this.screenToWorld(previous.width / 2, previous.height / 2);
                this.x = current.width / 2 - worldCenter.x * this.scale;
                this.y = current.height / 2 - worldCenter.y * this.scale;
            }

            this._apply();
            return true;
        }

        screenToWorld(sx, sy) {
            return {
                x: (sx - this.x) / this.scale,
                y: (sy - this.y) / this.scale,
            };
        }

        worldToScreen(wx, wy) {
            return {
                x: wx * this.scale + this.x,
                y: wy * this.scale + this.y,
            };
        }

        zoom(delta, centerX, centerY) {
            const oldScale = this.scale;
            const newScale = clamp(oldScale * (1 - delta * 0.1), this.minScale, this.maxScale);
            if (newScale === oldScale) return;
            const worldBefore = this.screenToWorld(centerX, centerY);
            this.scale = newScale;
            const worldAfter = this.screenToWorld(centerX, centerY);
            this.x += (worldAfter.x - worldBefore.x) * newScale;
            this.y += (worldAfter.y - worldBefore.y) * newScale;
            this._apply();
        }

        pan(dx, dy) {
            this.x += dx;
            this.y += dy;
            this._apply();
        }

        setPan(x, y) {
            this.x = x;
            this.y = y;
            this._apply();
        }

        reset() {
            this.x = 0;
            this.y = 0;
            this.scale = 1;
            this._apply();
        }

        frameNodes(nodes) {
            if (!nodes.length) { this.reset(); return; }
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const n of nodes) {
                minX = Math.min(minX, n.x);
                minY = Math.min(minY, n.y);
                maxX = Math.max(maxX, n.x + n.width);
                maxY = Math.max(maxY, n.y + n.height);
            }
            const padding = 60;
            const canvasRect = this.canvas.getBoundingClientRect();
            const availW = canvasRect.width - padding * 2;
            const availH = canvasRect.height - padding * 2;
            const contentW = maxX - minX;
            const contentH = maxY - minY;
            const scale = Math.min(this.maxScale, Math.max(this.minScale, Math.min(availW / contentW, availH / contentH)));
            this.scale = scale;
            this.x = padding - minX * scale;
            this.y = padding - minY * scale;
            this._apply();
        }

        _apply() {
            this.world.style.transform = `translate(${this.x.toFixed(2)}px, ${this.y.toFixed(2)}px) scale(${this.scale.toFixed(4)})`;
            if (this.onChange) this.onChange(this);
        }

        _bindEvents() {
            this.canvas.addEventListener('wheel', (e) => {
                if (e.target.closest('input, textarea, select')) return;
                e.preventDefault();
                const rect = this.canvas.getBoundingClientRect();
                this.zoom(e.deltaY > 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top);
            }, { passive: false });

            this.canvas.addEventListener('mousedown', (e) => {
                if (e.button === 1 || (e.button === 0 && (this.spaceDown || e.altKey))) {
                    e.preventDefault();
                    this.isPanning = true;
                    this.panStart = { x: e.clientX, y: e.clientY };
                    this.viewStart = { x: this.x, y: this.y };
                    this.canvas.style.cursor = 'grabbing';
                }
            });

            document.addEventListener('mousemove', (e) => {
                if (!this.isPanning) return;
                this.x = this.viewStart.x + (e.clientX - this.panStart.x);
                this.y = this.viewStart.y + (e.clientY - this.panStart.y);
                this._apply();
            });

            document.addEventListener('mouseup', () => {
                if (this.isPanning) {
                    this.isPanning = false;
                    this.canvas.style.cursor = '';
                }
            });

            document.addEventListener('keydown', (e) => {
                if (e.code === 'Space' && !this.spaceDown) {
                    this.spaceDown = true;
                    this.canvas.style.cursor = 'grab';
                }
                if (e.code === 'KeyF' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                    if (this.onFrameAll) this.onFrameAll(this);
                }
            });
            document.addEventListener('keyup', (e) => {
                if (e.code === 'Space') {
                    this.spaceDown = false;
                    if (!this.isPanning) this.canvas.style.cursor = '';
                }
            });
        }

        serialize() {
            const size = this._lastCanvasSize || this._measureCanvas();
            return { x: this.x, y: this.y, scale: this.scale, canvasW: size.width, canvasH: size.height };
        }

        deserialize(state) {
            if (!state) return;
            this.x = state.x ?? this.x;
            this.y = state.y ?? this.y;
            this.scale = clamp(state.scale ?? this.scale, this.minScale, this.maxScale);

            const current = this._measureCanvas();
            const savedW = Number(state.canvasW) || 0;
            const savedH = Number(state.canvasH) || 0;

            if (current.width > 0 && current.height > 0) {
                // Canvas is laid out — adjust if size changed since save
                if (savedW > 0 && savedH > 0 && (Math.abs(savedW - current.width) >= 0.5 || Math.abs(savedH - current.height) >= 0.5)) {
                    const worldCenterX = (savedW / 2 - this.x) / this.scale;
                    const worldCenterY = (savedH / 2 - this.y) / this.scale;
                    this.x = current.width / 2 - worldCenterX * this.scale;
                    this.y = current.height / 2 - worldCenterY * this.scale;
                }
                this._lastCanvasSize = current;
            } else {
                // Canvas not laid out yet — use saved canvas size as stand-in
                // so handleResize can properly adjust when the real size arrives
                this._lastCanvasSize = { width: savedW, height: savedH };
            }
            this._apply();
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  NODE BASE CLASS
    // ════════════════════════════════════════════════════════════════
    class NodeBase {
        constructor(type, id, x = 0, y = 0) {
            this.type = type;
            this.id = id || uid(type);
            this.x = x;
            this.y = y;
            this.width = 240;
            this.height = 120;
            this.resizeMode = 'horizontal';
            this.isVisual = false;
            this.title = 'Node';
            this.color = '#6c5fa6';
            this.inputs = [];
            this.outputs = [];
            this.data = {};
            this.element = null;
            this.rendered = false;
        }

        defineSockets() {}
        renderBody(body) {}
        process(bag) {}

        serialize() {
            return {
                type: this.type,
                id: this.id,
                x: this.x,
                y: this.y,
                width: this.width,
                height: this.height,
                data: JSON.parse(JSON.stringify(this.data || {})),
            };
        }

        deserialize(state) {
            this.x = state.x ?? this.x;
            this.y = state.y ?? this.y;
            this.width = state.width ?? 240;
            this.height = state.height ?? this.height;
            this.data = { ...this.data, ...(state.data || {}) };
        }

        render(world, ctx = {}) {
            if (this.element) return this.element;
            this.defineSockets();

            const el = document.createElement('div');
            el.className = 'vp-as-node';
            if (this.isVisual) el.classList.add('vp-as-node-visual');
            el.dataset.nodeId = this.id;
            el.dataset.nodeType = this.type;
            el.style.left = `${this.x}px`;
            el.style.top = `${this.y}px`;
            el.style.width = `${this.width}px`;
            if (this.isVisual || (this.resizeMode && this.resizeMode !== 'horizontal')) {
                el.style.height = `${this.height}px`;
            } else {
                el.style.height = 'auto';
            }
            el.style.resize = this.resizeMode || 'horizontal';
            el.style.setProperty('--node-color', this.color);
            el.innerHTML = `
                <div class="vp-as-node-header">${this.title}</div>
                <div class="vp-as-node-sockets vp-as-node-inputs"></div>
                <div class="vp-as-node-body"></div>
                <div class="vp-as-node-sockets vp-as-node-outputs"></div>
            `;

            const header = el.querySelector('.vp-as-node-header');
            this._wireDrag(header, el, ctx.viewport);

            const inputsWrap = el.querySelector('.vp-as-node-inputs');
            const outputsWrap = el.querySelector('.vp-as-node-outputs');
            const body = el.querySelector('.vp-as-node-body');

            this.inputs.forEach(sock => this._renderSocket(inputsWrap, sock, 'input', ctx));
            this.outputs.forEach(sock => this._renderSocket(outputsWrap, sock, 'output', ctx));
            this.renderBody(body);

            world.appendChild(el);
            this.element = el;
            this.rendered = true;

            let resizeTid;
            if (window.ResizeObserver) {
                new ResizeObserver(() => {
                    const newW = el.offsetWidth;
                    const newH = el.offsetHeight;
                    let changed = false;
                    if (newW && newW !== this.width) {
                        this.width = newW;
                        changed = true;
                    }
                    if (newH && newH !== this.height) {
                        this.height = newH;
                        changed = true;
                    }
                    if (changed) {
                        if (this.onMove) this.onMove();
                        clearTimeout(resizeTid);
                        resizeTid = setTimeout(() => {
                            if (this.onMoved) this.onMoved();
                        }, 500);
                    }
                }).observe(el);
            }

            return el;
        }

        _renderSocket(container, sock, kind, ctx) {
            const s = document.createElement('div');
            s.className = `vp-as-socket ${kind}`;
            s.dataset.socketId = sock.id;
            s.dataset.socketKind = kind;
            s.dataset.nodeId = this.id;
            s.innerHTML = `<span class="vp-as-socket-dot"></span><span class="vp-as-socket-label">${sock.label}</span>`;
            s.title = sock.hint || sock.label;
            s.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                if (ctx.onSocketMouseDown) ctx.onSocketMouseDown(e, this, sock, kind);
            });
            container.appendChild(s);
        }

        _wireDrag(handle, el, viewport) {
            let dragging = false;
            let startX, startY, origX, origY;
            const onDown = (e) => {
                dragging = true;
                startX = e.clientX;
                startY = e.clientY;
                origX = this.x;
                origY = this.y;
                el.style.zIndex = '100';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
            };
            const onMove = (e) => {
                if (!dragging) return;
                const scale = viewport ? viewport.scale : 1;
                this.x = clamp(origX + (e.clientX - startX) / scale, -4000, 4000);
                this.y = clamp(origY + (e.clientY - startY) / scale, -4000, 4000);
                el.style.left = `${this.x}px`;
                el.style.top = `${this.y}px`;
                if (this.onMove) this.onMove();
            };
            const onUp = () => {
                dragging = false;
                el.style.zIndex = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                if (this.onMoved) this.onMoved();
            };
            handle.addEventListener('mousedown', onDown);
        }

        getSocketRect(socketId, kind) {
            if (!this.element) return null;
            const dot = this.element.querySelector(`[data-socket-id="${socketId}"][data-socket-kind="${kind}"] .vp-as-socket-dot`);
            if (!dot) return null;
            const r = dot.getBoundingClientRect();
            const canvas = this.element.closest('.vp-as-canvas')?.getBoundingClientRect();
            if (!canvas) return null;
            return {
                x: r.left - canvas.left + r.width / 2,
                y: r.top - canvas.top + r.height / 2,
            };
        }

        dispose() {
            if (this.element) {
                this.element.remove();
                this.element = null;
            }
            this.rendered = false;
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  ARGUMENT CATALOG (extendable CLI flag → pill mapping)
    // ════════════════════════════════════════════════════════════════
    const ARG_CATALOG = {
        // Loader
        '-m': { tower: 'loader', key: 'coreModel', label: 'Model', category: 'file', control: 'file', libraryKind: 'core', accept: '.gguf,.safetensors,.ckpt,.pt,.bin' },
        '--model': { alias: '-m' },
        '--diffusion-model': { alias: '-m' },
        '--llm': { tower: 'loader', key: 'clip1', label: 'CLIP 1', category: 'file', control: 'file', libraryKind: 'text', accept: '.gguf,.safetensors,.bin' },
        '--clip_l': { alias: '--llm' },
        '--clip2': { tower: 'loader', key: 'clip2', label: 'CLIP 2', category: 'file', control: 'file', libraryKind: 'text', accept: '.gguf,.safetensors,.bin' },
        '--t5xxl': { tower: 'loader', key: 't5xxl', label: 'T5XXL Model', category: 'file', control: 'file', libraryKind: 'text', accept: '.gguf,.safetensors,.bin' },
        '--vae': { tower: 'loader', key: 'vae', label: 'VAE', category: 'file', control: 'file', libraryKind: 'vae', accept: '.safetensors,.pt,.ckpt,.bin' },
        '--control-net': { tower: 'loader', key: 'controlNet', label: 'ControlNet', category: 'file', control: 'file', libraryKind: 'core', accept: '.gguf,.safetensors,.bin' },
        '--params-backend': { tower: 'loader', key: 'paramsBackend', label: 'Params Backend', category: 'hardware', control: 'select', options: ['default', 'cpu'], default: 'default' },
        '--clip-on-cpu': { tower: 'loader', key: 'clipOnCpu', label: 'CLIP on CPU', category: 'hardware', control: 'checkbox', default: false },
        '--vae-on-cpu': { tower: 'loader', key: 'vaeOnCpu', label: 'VAE on CPU', category: 'hardware', control: 'checkbox', default: false },
        '--offload-to-cpu': { tower: 'loader', key: 'offloadToCpu', label: 'Offload to CPU', category: 'hardware', control: 'checkbox', default: false },
        '--diffusion-fa': { tower: 'loader', key: 'diffusionFa', label: 'Flash Attention (DiT)', category: 'hardware', control: 'checkbox', default: false },
        '--model-args': { tower: 'loader', key: 'modelArgs', label: 'Model Args', category: 'hardware', control: 'text', default: '' },
        '--threads': { tower: 'loader', key: 'threads', label: 'Threads', category: 'hardware', control: 'number', min: 1, max: 64, default: 4 },
        '-t': { alias: '--threads' },

        // LoRA
        '--lora-model-dir': { tower: 'lora', key: 'loraDir', label: 'LoRA Directory', category: 'file', control: 'text', default: '' },
        '--lora-apply-mode': { tower: 'lora', key: 'loraApplyMode', label: 'Apply Mode', category: 'hardware', control: 'select', options: ['default', 'immediately', 'at_runtime'], default: 'default' },

        // Prompt
        '-p': { tower: 'prompt', key: 'positive', label: 'Positive Prompt', category: 'prompt', control: 'textarea', rows: 4 },
        '--prompt': { alias: '-p' },
        '--negative-prompt': { tower: 'prompt', key: 'negative', label: 'Negative Prompt', category: 'prompt', control: 'textarea', rows: 2 },
        '-n': { alias: '--negative-prompt' },
        '-r': { tower: 'prompt', key: 'reference', label: 'Reference Images', category: 'file', control: 'multi-file', accept: '.png,.jpg,.jpeg,.webp', max: 8 },
        '--reference': { alias: '-r' },

        // Sampler
        '--steps': { tower: 'sampler', key: 'steps', label: 'Steps', category: 'math', control: 'number', min: 1, max: 150, default: 8 },
        '--cfg-scale': { tower: 'sampler', key: 'cfg', label: 'CFG Scale', category: 'math', control: 'number', step: 0.1, min: 0, max: 30, default: 1.0 },
        '--guidance': { tower: 'sampler', key: 'guidance', label: 'Guidance (FLUX)', category: 'math', control: 'number', step: 0.1, min: 0, max: 10, default: 3.5 },
        '--flow-shift': { tower: 'sampler', key: 'flowShift', label: 'Flow Shift', category: 'math', control: 'number', step: 0.1, min: 0, max: 10, default: 3.0 },
        '--seed': { tower: 'sampler', key: 'seed', label: 'Seed', category: 'math', control: 'number', default: -1 },
        '-s': { alias: '--seed' },
        '--batch-count': { tower: 'sampler', key: 'batchCount', label: 'Batch Count', category: 'math', control: 'number', min: 1, max: 100, default: 1 },
        '-b': { alias: '--batch-count' },
        '--strength': { tower: 'sampler', key: 'strength', label: 'Denoising Strength', category: 'math', control: 'number', step: 0.01, min: 0.0, max: 1.0, default: 0.75 },
        '--clip-skip': { tower: 'sampler', key: 'clipSkip', label: 'CLIP Skip', category: 'math', control: 'number', min: 1, max: 12, default: 1 },
        '--slg-scale': { tower: 'sampler', key: 'slgScale', label: 'SLG Scale', category: 'math', control: 'number', step: 0.1, min: 0, max: 10, default: 0 },
        '--skip-layers': { tower: 'sampler', key: 'skipLayers', label: 'Skip Layers', category: 'math', control: 'number', min: 0, max: 50, default: 0 },
        '--sampling-method': { tower: 'sampler', key: 'sampler', label: 'Sampling Method', category: 'hardware', control: 'select', options: ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2m', 'lcm'], default: 'euler' },
        '--schedule': { tower: 'sampler', key: 'scheduler', label: 'Scheduler', category: 'hardware', control: 'select', options: ['default', 'karras', 'exponential', 'polyexponential', 'sgm_uniform', 'normal', 'simple', 'ddim_uniform'], default: 'default' },
        '-W': { tower: 'sampler', key: 'width', label: 'Width', category: 'math', control: 'number', min: 64, max: 4096, step: 64, default: 512 },
        '--width': { alias: '-W' },
        '-H': { tower: 'sampler', key: 'height', label: 'Height', category: 'math', control: 'number', min: 64, max: 4096, step: 64, default: 512 },
        '--height': { alias: '-H' },
        '--video-frames': { tower: 'sampler', key: 'videoFrames', label: 'Video Frames', category: 'math', control: 'number', min: 1, max: 256, default: 16 },

        // Output
        '-o': { tower: 'output', key: 'outputPath', label: 'Output Path', category: 'output', control: 'text', default: '' },
        '--output': { alias: '-o' },
        '--upscale': { tower: 'output', key: 'upscale', label: 'Upscale', category: 'math', control: 'number', min: 1, max: 8, default: 1 },
        '--color': { tower: 'output', key: 'color', label: 'Colored Log', category: 'output', control: 'checkbox', default: true },
        '-v': { tower: 'output', key: 'verbose', label: 'Verbose Logging', category: 'output', control: 'checkbox', default: false },
        '--verbose': { alias: '-v' },
    };

    function getArgDef(flag) {
        let def = ARG_CATALOG[flag];
        const seen = new Set();
        while (def?.alias && !seen.has(def.alias)) {
            seen.add(def.alias);
            def = ARG_CATALOG[def.alias];
        }
        return def && !def.alias ? def : null;
    }

    function getTowerArgs(tower) {
        const out = [];
        for (const [flag, def] of Object.entries(ARG_CATALOG)) {
            if (def.alias) continue;
            if (def.tower === tower) out.push({ flag, ...def });
        }
        return out;
    }

    function renderPillControl(entry, value, onChange) {
        return (wrap, update) => {
            const ctrl = entry.control;
            if (wrap?.dataset) wrap.dataset.ctrlType = ctrl;
            if (ctrl === 'textarea') {
                const ta = document.createElement('textarea');
                ta.className = 'vp-as-pill-textarea';
                ta.rows = entry.rows || 3;
                ta.value = value || '';
                ta.addEventListener('input', () => { onChange?.(ta.value); update(ta.value); });
                wrap.appendChild(ta);
            } else if (ctrl === 'number') {
                const step = Number(entry.step || 1);
                const parseAndClamp = (raw) => {
                    let v = parseFloat(raw);
                    if (Number.isNaN(v)) v = entry.default ?? 0;
                    if (entry.min !== undefined) v = Math.max(entry.min, v);
                    if (entry.max !== undefined) v = Math.min(entry.max, v);
                    if (step < 1 && Number.isFinite(step)) {
                        const decimals = String(step).includes('.') ? String(step).split('.').pop().length : 0;
                        v = Number(v.toFixed(decimals));
                    } else if (Number.isFinite(step) && step >= 1) {
                        v = Math.round(v);
                    }
                    return v;
                };
                const commit = (nextRaw) => {
                    const v = parseAndClamp(nextRaw);
                    input.value = v;
                    onChange?.(v);
                    update(v);
                };
                const stepper = document.createElement('div');
                stepper.className = 'vp-as-number-stepper';
                const minus = document.createElement('button');
                minus.type = 'button';
                minus.className = 'vp-as-step-btn';
                minus.textContent = '−';
                minus.title = 'Decrease';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'vp-as-pill-number';
                input.step = step;
                if (entry.min !== undefined) input.min = entry.min;
                if (entry.max !== undefined) input.max = entry.max;
                input.value = value ?? entry.default ?? 0;
                const plus = document.createElement('button');
                plus.type = 'button';
                plus.className = 'vp-as-step-btn';
                plus.textContent = '+';
                plus.title = 'Increase';
                input.addEventListener('change', () => commit(input.value));
                input.addEventListener('blur', () => commit(input.value));
                minus.addEventListener('click', () => commit((parseFloat(input.value) || 0) - step));
                plus.addEventListener('click', () => commit((parseFloat(input.value) || 0) + step));
                stepper.appendChild(minus);
                stepper.appendChild(input);
                stepper.appendChild(plus);
                wrap.appendChild(stepper);
            } else if (ctrl === 'select') {
                const select = document.createElement('select');
                select.className = 'vp-as-pill-select';
                for (const opt of entry.options || []) {
                    const o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt;
                    if (opt === (value ?? entry.default)) o.selected = true;
                    select.appendChild(o);
                }
                select.addEventListener('change', () => { onChange?.(select.value); update(select.value); });
                wrap.appendChild(select);
            } else if (ctrl === 'checkbox') {
                const label = document.createElement('label');
                label.className = 'vp-as-pill-checkbox-wrap';
                label.style.display = 'flex';
                label.style.alignItems = 'center';
                label.style.gap = '8px';
                label.style.color = 'var(--text-primary)';
                label.style.fontSize = '11px';
                label.style.cursor = 'pointer';
                const input = document.createElement('input');
                input.type = 'checkbox';
                const initVal = value !== undefined ? value : (entry.default === true);
                input.checked = !!initVal;
                input.addEventListener('change', () => {
                    onChange?.(input.checked);
                    update(input.checked);
                });
                label.appendChild(input);
                wrap.appendChild(label);
                // Also initialize the summary text properly
                requestAnimationFrame(() => update(input.checked));
            } else if (ctrl === 'file') {
                const fmt = (raw) => {
                    const clean = normPath(raw || '');
                    if (!clean) return entry.libraryKind ? 'Choose model...' : 'Choose file...';
                    return clean.split('/').pop() || clean;
                };
                const picker = document.createElement('button');
                picker.type = 'button';
                picker.className = 'vp-as-file-picker';
                picker.innerHTML = `<span class="vp-as-file-picker-name"></span><span class="vp-as-file-picker-caret">▾</span>`;
                const nameEl = picker.querySelector('.vp-as-file-picker-name');
                const applyValue = (raw) => {
                    const clean = normPath(raw || '');
                    nameEl.textContent = fmt(clean);
                    picker.title = clean || (entry.libraryKind ? 'Choose model' : 'Choose file');
                    picker.classList.toggle('is-empty', !clean);
                };
                applyValue(value);
                picker.addEventListener('click', async () => {
                    let clean = null;
                    if (entry.libraryKind && window.VisualProjector?.assetStudio?.pickLibraryModel) {
                        clean = await window.VisualProjector.assetStudio.pickLibraryModel(entry.libraryKind, {
                            title: entry.label,
                            currentValue: value || '',
                            accept: entry.accept || '',
                        });
                    }
                    if (clean === '__BROWSE_FILE__') {
                        const path = await pickFile({
                            title: `Select ${entry.label}`,
                            filters: [{ name: 'Files', extensions: entry.accept ? entry.accept.replace(/\./g, '').split(',') : ['*'] }],
                            accept: entry.accept,
                        });
                        if (!path) return;
                        clean = normPath(path);
                    } else if (!clean && !entry.libraryKind) {
                        const path = await pickFile({
                            title: `Select ${entry.label}`,
                            filters: [{ name: 'Files', extensions: entry.accept ? entry.accept.replace(/\./g, '').split(',') : ['*'] }],
                            accept: entry.accept,
                        });
                        if (!path) return;
                        clean = normPath(path);
                    }
                    if (!clean) return;
                    applyValue(clean);
                    onChange?.(clean);
                    update(clean);
                    await VP_AS.Graph.persist();
                });
                wrap.appendChild(picker);
            } else if (ctrl === 'multi-file') {
                const list = document.createElement('div');
                list.className = 'vp-as-multi-file-list';
                const arr = Array.isArray(value) ? value : (value ? [value] : []);
                const max = entry.max || 8;

                const commit = async () => {
                    onChange?.(arr.slice());
                    update(arr.slice());
                    await VP_AS.Graph.persist();
                };

                const appendRefs = async (refs = []) => {
                    let added = 0;
                    for (const ref of refs) {
                        if (!ref || arr.includes(ref) || arr.length >= max) continue;
                        arr.push(ref);
                        added += 1;
                    }
                    if (!added) return false;
                    refresh();
                    await commit();
                    return true;
                };

                const refresh = () => {
                    list.innerHTML = '';
                    arr.forEach((path, idx) => {
                        const row = document.createElement('div');
                        row.className = 'vp-as-multi-file-row';
                        const isImg = /\.(png|jpe?g|webp|gif|bmp)$/i.test(path);
                        const cleanPath = normPath(path);
                        let imgId = '';
                        
                        if (isImg) {
                            imgId = 'preview-' + Math.random().toString(36).slice(2, 10);
                            row.style.marginBottom = '6px';
                            row.innerHTML = `
                                <div class="vp-as-multi-img-wrap">
                                    <img id="${imgId}" class="vp-as-multi-img" style="display:none;" onerror="this.style.display='none'">
                                    <div class="vp-as-multi-img-meta">
                                        <span>${cleanPath.split('/').pop()}</span>
                                    </div>
                                </div>
                            `;
                            const wrap = row.querySelector('.vp-as-multi-img-wrap');

                            wrap.addEventListener('contextmenu', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                ContextMenu.show(e.clientX, e.clientY, [
                                    { label: 'Remove Image', danger: true, icon: '✕', action: () => {
                                        arr.splice(idx, 1);
                                        refresh();
                                        commit();
                                    }}
                                ]);
                            });

                            list.appendChild(row);

                            // Image Loading
                            if (window.Neutralino?.filesystem?.readBinaryFile) {
                                Neutralino.filesystem.readBinaryFile(cleanPath).then(buf => {
                                    const ext = cleanPath.split('.').pop().toLowerCase();
                                    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/jpeg';
                                    const blob = new Blob([buf], { type: mime });
                                    const url = URL.createObjectURL(blob);
                                    const imgEl = row.querySelector(`#${imgId}`);
                                    if (imgEl) {
                                        imgEl.src = url;
                                        imgEl.style.display = 'block';
                                    }
                                }).catch(err => {
                                    console.warn('[Asset Studio] Failed to read image preview:', err);
                                    let src = cleanPath;
                                    if (src.match(/^[a-zA-Z]:/)) src = `file:///${src}`;
                                    else if (src.startsWith('/')) src = `file://${src}`;
                                    const imgEl = row.querySelector(`#${imgId}`);
                                    if (imgEl) {
                                        imgEl.src = src;
                                        imgEl.style.display = 'block';
                                    }
                                });
                            } else {
                                let src = cleanPath;
                                if (src.match(/^[a-zA-Z]:/)) src = `file:///${src}`;
                                else if (src.startsWith('/')) src = `file://${src}`;
                                const imgEl = row.querySelector(`#${imgId}`);
                                if (imgEl) {
                                    imgEl.src = src;
                                    imgEl.style.display = 'block';
                                }
                            }
                        } else {
                            // Non-image file layout
                            row.style.alignItems = 'center';
                            row.style.display = 'flex';
                            row.style.justifyContent = 'space-between';
                            row.style.width = '100%';
                            row.style.marginBottom = '6px';
                            row.innerHTML = `
                                <span class="vp-as-multi-file-name" style="font-size:10px; color:var(--text-secondary); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; margin-right:8px;" title="${cleanPath}">${cleanPath.split('/').pop()}</span>
                            `;
                            
                            row.addEventListener('contextmenu', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                ContextMenu.show(e.clientX, e.clientY, [
                                    { label: 'Remove File', danger: true, icon: '✕', action: () => {
                                        arr.splice(idx, 1);
                                        refresh();
                                        commit();
                                    }}
                                ]);
                            });
                            
                            list.appendChild(row);
                        }
                    });
                };
                const addBtn = document.createElement('button');
                addBtn.className = 'vp-btn vp-btn-sm';
                addBtn.textContent = '＋ Add image';
                addBtn.addEventListener('click', async () => {
                    if (arr.length >= max) {
                        VP.showToast?.(`Maximum ${max} reference images`, 'warn');
                        return;
                    }
                    const path = await pickFile({
                        title: `Select reference image ${arr.length + 1}`,
                        filters: [{ name: 'Images', extensions: entry.accept ? entry.accept.replace(/\./g, '').split(',') : ['*'] }],
                        accept: entry.accept,
                    });
                    if (!path) return;
                    await appendRefs([normPath(path)]);
                });

                const dropHint = document.createElement('div');
                dropHint.className = 'vp-as-drop-hint';
                dropHint.textContent = 'Drop images here from files or gallery';

                const footer = document.createElement('div');
                footer.className = 'vp-as-multi-footer';
                footer.appendChild(addBtn);
                footer.appendChild(dropHint);

                const setDropState = (active) => list.classList.toggle('is-drop-target', !!active);
                list.addEventListener('dragover', (e) => {
                    e.preventDefault();
                    setDropState(true);
                });
                list.addEventListener('dragleave', (e) => {
                    if (!list.contains(e.relatedTarget)) setDropState(false);
                });
                list.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    setDropState(false);
                    const refs = await extractDroppedImageRefs(e.dataTransfer, Math.max(0, max - arr.length));
                    if (!refs.length) {
                        VP.showToast?.('Unsupported drop payload', 'warn');
                        return;
                    }
                    const added = await appendRefs(refs);
                    if (added) VP.showToast?.(`Added ${refs.length} reference image${refs.length === 1 ? '' : 's'}`, 'success');
                });

                refresh();
                wrap.appendChild(list);
                wrap.appendChild(footer);
            } else {
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'vp-as-pill-text';
                input.value = value || '';
                input.addEventListener('change', () => { onChange?.(input.value); update(input.value); });
                wrap.appendChild(input);
            }
        };
    }

    function buildAddMenu(defs, onSelect) {
        if (!defs.length) return null;
        const menu = document.createElement('div');
        menu.className = 'vp-as-arg-menu';
        for (const def of defs) {
            const item = document.createElement('button');
            item.className = 'vp-as-arg-menu-item';
            item.innerHTML = `<span class="vp-as-arg-menu-dot" style="background:${PILL_CATEGORIES[def.category]?.color || '#888'}"></span><span>${def.label}</span><code>${def.flag}</code>`;
            item.addEventListener('click', () => { onSelect(def); closeArgMenu(); });
            menu.appendChild(item);
        }
        return menu;
    }

    const MENU_ID = 'vp-as-arg-menu';
    let _activeMenu = null;
    let _activeMenuButton = null;
    let _menuOutsideClick = null;

    function closeArgMenu() {
        const old = document.getElementById(MENU_ID);
        if (old) old.remove();
        const oldOverlay = document.getElementById('vp-as-arg-menu-overlay');
        if (oldOverlay) oldOverlay.remove();
        _activeMenu = null;
        _activeMenuButton = null;
        if (_menuOutsideClick) {
            document.removeEventListener('mousedown', _menuOutsideClick);
            _menuOutsideClick = null;
        }
    }

    function showAddMenu(button, defs, onSelect) {
        console.log('[showAddMenu] click', { defsCount: defs?.length, buttonExists: !!button });
        if (_activeMenuButton === button) {
            closeArgMenu();
            return;
        }
        closeArgMenu();
        const menu = buildAddMenu(defs, onSelect);
        if (!menu) {
            console.log('[showAddMenu] no menu items');
            return;
        }
        menu.id = MENU_ID;
        menu.style.position = 'fixed';
        menu.style.zIndex = '50001';
        const rect = button.getBoundingClientRect();
        menu.style.left = `${rect.left}px`;
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.maxHeight = `${Math.min(320, window.innerHeight - 40)}px`;
        document.body.appendChild(menu);
        _activeMenu = menu;
        _activeMenuButton = button;
        console.log('[showAddMenu] appended', { left: rect.left, top: rect.bottom + 4, children: menu.children.length });

        _menuOutsideClick = (e) => {
            if (!menu.contains(e.target) && e.target !== button) {
                console.log('[showAddMenu] outside click close');
                closeArgMenu();
            }
        };
        document.addEventListener('mousedown', _menuOutsideClick);

        requestAnimationFrame(() => {
            const mRect = menu.getBoundingClientRect();
            console.log('[showAddMenu] rAF rect', { w: mRect.width, h: mRect.height, right: mRect.right, bottom: mRect.bottom, vw: window.innerWidth });
            if (mRect.right > window.innerWidth - 8) {
                // align right edge of menu with right edge of button
                let nextLeft = rect.right - mRect.width;
                if (nextLeft < 8) nextLeft = 8;
                menu.style.left = `${nextLeft}px`;
            }
            if (mRect.bottom > window.innerHeight - 8) {
                menu.style.top = `${Math.max(8, rect.top - mRect.height - 4)}px`;
            }
        });
    }

    function getMissingTowerArgs(tower, currentKeys) {
        return getTowerArgs(tower).filter(d => !currentKeys.includes(d.key));
    }

    function isExpandableArg(def) {
        return !!def && (def.control === 'textarea' || def.control === 'multi-file');
    }

    // ════════════════════════════════════════════════════════════════
    //  PILL UI HELPERS (Tower-style argument pills)
    // ════════════════════════════════════════════════════════════════
    const PILL_CATEGORIES = {
        hardware: { color: '#8b6cff', label: 'Hardware' },
        file:     { color: '#4f8cff', label: 'File' },
        math:     { color: '#e5a042', label: 'Math' },
        prompt:   { color: '#e0c65e', label: 'Prompt' },
        output:   { color: '#c88735', label: 'Output' },
    };

    function formatPillValue(v) {
        if (v == null || v === '') return '—';
        if (typeof v === 'boolean') return v ? 'Enabled' : 'Disabled';
        if (Array.isArray(v)) {
            if (!v.length) return '—';
            if (v.length === 1) {
                const s = v[0].split('/').pop();
                return s.length > 28 ? s.slice(0, 26) + '…' : s;
            }
            return `${v.length} files`;
        }
        const s = String(v);
        if (s.length > 28) return s.slice(0, 26) + '…';
        return s;
    }

    const ContextMenu = {
        active: null,
        close() {
            if (this.active) { this.active.remove(); this.active = null; }
        },
        show(x, y, items) {
            this.close();
            if (!items || !items.length) return;
            const menu = document.createElement('div');
            menu.className = 'vp-as-context-menu';
            items.forEach(item => {
                const el = document.createElement('div');
                el.className = 'vp-as-context-menu-item' + (item.danger ? ' danger' : '');
                el.innerHTML = item.icon ? `<span style="width:16px;text-align:center;">${item.icon}</span><span>${item.label}</span>` : `<span>${item.label}</span>`;
                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.close();
                    item.action();
                });
                menu.appendChild(el);
            });
            document.body.appendChild(menu);
            this.active = menu;
            const rect = menu.getBoundingClientRect();
            let left = x;
            let top = y;
            if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 4;
            if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 4;
            menu.style.left = left + 'px';
            menu.style.top = top + 'px';

            setTimeout(() => {
                const outClick = (e) => {
                    if (!menu.contains(e.target)) {
                        this.close();
                        document.removeEventListener('mousedown', outClick);
                    }
                };
                document.addEventListener('mousedown', outClick);
            }, 10);
        }
    };

    function createPill({ key, label, value, category = 'math', renderBody, onChange, onRemove, open = false, expandable = true }) {
        const cat = PILL_CATEGORIES[category] || PILL_CATEGORIES.math;

        if (!expandable) {
            const row = document.createElement('div');
            row.className = 'vp-as-pill vp-as-pill-inline';
            row.dataset.argKey = key;
            row.dataset.pillCategory = category;
            row.style.setProperty('--pill-color', cat.color);
            row.innerHTML = `
                <div class="vp-as-pill-inline-row" title="${key}">
                    <span class="vp-as-pill-key">${label || key}</span>
                    <div class="vp-as-pill-inline-spacer"></div>
                    <div class="vp-as-pill-inline-control"></div>
                </div>`;
            const body = row.querySelector('.vp-as-pill-inline-control');
            renderBody(body, (newValue) => {
                if (onChange) onChange(newValue);
            });
            row.addEventListener('contextmenu', (e) => {
                if (!e.target.closest('.vp-as-pill-inline-row')) return;
                e.preventDefault();
                e.stopPropagation();
                const items = [];
                if (onRemove) items.push({ label: 'Remove Argument', danger: true, icon: '✕', action: onRemove });
                if (items.length) ContextMenu.show(e.clientX, e.clientY, items);
            });
            return { el: row, setValue: () => {} };
        }

        const details = document.createElement('details');
        details.className = 'vp-as-pill';
        details.dataset.argKey = key;
        details.dataset.pillCategory = category;
        if (open) details.setAttribute('open', '');
        details.style.setProperty('--pill-color', cat.color);
        details.innerHTML = `
            <summary class="vp-as-pill-summary" title="${key}">
                <span class="vp-as-pill-key">${label || key}</span>
                <span class="vp-as-pill-value">${formatPillValue(value)}</span>
                <span class="vp-as-pill-wing right">›</span>
            </summary>
            <div class="vp-as-pill-body"></div>
        `;
        const body = details.querySelector('.vp-as-pill-body');
        const valueEl = details.querySelector('.vp-as-pill-value');
        renderBody(body, (newValue) => {
            valueEl.textContent = formatPillValue(newValue);
            if (onChange) onChange(newValue);
        });
        details.addEventListener('toggle', () => {
            if (window.VP_AS?.Graph?.links) window.VP_AS.Graph.links._render();
        });
        details.addEventListener('contextmenu', (e) => {
            if (!e.target.closest('.vp-as-pill-summary')) return;
            e.preventDefault();
            e.stopPropagation();
            const items = [];
            if (onRemove) {
                items.push({ label: 'Remove Argument', danger: true, icon: '✕', action: onRemove });
            }
            if (items.length) {
                ContextMenu.show(e.clientX, e.clientY, items);
            }
        });
        return { el: details, setValue: (v) => { valueEl.textContent = formatPillValue(v); } };
    }

    // ════════════════════════════════════════════════════════════════
    //  NODE REGISTRY
    // ════════════════════════════════════════════════════════════════
    const NodeRegistry = {
        map: new Map(),
        register(type, cls, meta) {
            this.map.set(type, { cls, meta: meta || {} });
        },
        create(type, id, x, y) {
            const def = this.map.get(type);
            if (!def) throw new Error(`Unknown node type: ${type}`);
            return new def.cls(id, x, y);
        },
        getMeta(type) { return this.map.get(type)?.meta || {}; },
        list() { return Array.from(this.map.entries()).map(([type, def]) => ({ type, ...def.meta })); },
    };

    // ════════════════════════════════════════════════════════════════
    //  EXPORT TO GLOBAL NAMESPACE
    // ════════════════════════════════════════════════════════════════

function dataTransferHasType(dt, type) {
    try { return Array.from(dt?.types || []).includes(type); }
    catch { return false; }
}

    window.VP_AS = window.VP_AS || {};
    window.VP_AS.ARG = { ArgumentBag };
    window.VP_AS.Viewport = Viewport;
    window.VP_AS.NodeBase = NodeBase;
    window.VP_AS.NodeRegistry = NodeRegistry;
    window.VP_AS.utils = { uid, clamp, normPath, pickFile, detectModelType, normalizeDroppedImageRef, extractDroppedImageRefs, dataTransferHasType };
    window.VP_AS.Pill = { categories: PILL_CATEGORIES, create: createPill, formatValue: formatPillValue };
    window.VP_AS.Arg = { catalog: ARG_CATALOG, getDef: getArgDef, getTowerArgs, renderPillControl, buildAddMenu, getMissingTowerArgs, isExpandableArg, showAddMenu, closeArgMenu };
    window.VP_AS.ContextMenu = ContextMenu;
    window.VP_AS.S = S;
    window.VP_AS.DB = DB;
})();
