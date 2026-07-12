// ╔══════════════════════════════════════════════════════════════╗
// ║  visual-projector.js — STANDALONE ENGINE (slimmed)           ║
// ║  v4.0 — Modular split: gallery domain moved to               ║
// ║         projector-gallery.js                                  ║
// ║                                                              ║
// ║  This file now contains ONLY the Player/Canvas engine:       ║
// ║    State, VPTags, geometry, Projector (setCurrent…),         ║
// ║    Template (manifest/frames), Interceptor (fetch),          ║
// ║    Playback, projector UI, SubtitlePlayer (→ vp-subtitles.js)   ║
// ║    DragResize, Confirm, Utils, Init.                          ║
// ║                                                              ║
// ║  REMOVED (→ projector-gallery.js):                           ║
// ║    Gallery asset CRUD, TabsManager, Tagger + Tagger UI,       ║
// ║    gallery/settings panel, grid render, selection,            ║
// ║    settings wiring.                                           ║
// ║                                                              ║
// ║  The engine talks to the gallery via window.VisualProjector   ║
// ║  (this file) and window.VisualProjector.gallery (the panel    ║
// ║  module). Load order:                                         ║
// ║    fx-core.js → visual-projector.js → projector-gallery.js   ║
// ║                                                              ║
// ║  CSS auto-loads from visual-projector.css next to the script.║
// ╚══════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    // ════════════════════════════════════════════════════════════════
    //  STATE  (shared single source of truth — gallery writes into
    //  the gallery* fields; engine reads them via the same object)
    // ════════════════════════════════════════════════════════════════
    const State = {

        current: null,
        coverTag: null,
        coverLabel: "cover",
        preparedTag: null,

        history: [],

        playback: {
            messages: [],
            cursor:   -1,
            mode:     'live',
            streaming: false,
            lastUserFingerprint: null,
            // Studio 2.0: Technical network tracking fields removed
        },

        // ── Gallery-owned fields (populated by projector-gallery.js) ──
        galleryData: { categories: [], tabs: [], activeTabId: null },
        gallery: new Map(),
        tagAliases: {},       // ephemeral oldTag -> { to, expiresAt, reason } bridges after rename until visual inventory refresh catches up
        selection: { tags: new Set(), anchor: null },
        tagger: { running: false, cancelled: false, total: 0, done: 0, failed: 0, current: null, lastDesc: '' },
        folderIndexCounter: {},

        config: {
            contextDepth:     3,
            maxHistory:       20,
            enabled:          true,
            debugTags:        false,
            maxLongSide:      1024,
            jpegQuality:      0.92,
            manifestDescriptions: true,
            persistGallery:   false,
            autoTagOnLoad:    'ask',
            fadeDuration:     0.3,
            transitionType:   'random',
            assetCornerRadius: 8,
            frameLabelMode:   'title',   // 'title' | 'debug' | 'hidden'
            subtitleWPM:      160,
            subtitleSpeed:    1.0,
            maxPlaybackMessages: 50,
            effectsEnabled:   true,
            showUserInPlayback: true,
            allowUserCommands:  false,
            allowDirectoryCommands: false,
            mergeUserDrafts:   true,
            userDraftMergeWindowMs: 3000,
            prompts: {
                manifest:     null,
                frameContext: null,
            },
        },

        ui: {
            vpWindow:       null,
            screen:         null,
            tagLabel:       null,
            playerBar:      null,
            galleryGrid:    null,   // set by gallery module
            depthInput:     null,
            galleryBtn:     null,
            fileBtn:        null,
            folderBtn:      null,
            mode:           'projector',
            panelOpen:      false,   // owned by gallery
            panelSection:   'gallery',
            lastAssetTabId: null,
        },

        originalFetch: window.fetch.bind(window),

        api: { endpoint: null, headers: null, model: null },
    };

    // ════════════════════════════════════════════════════════════════
    //  VPTags  (single source of truth for command-tag parsing)
    // ════════════════════════════════════════════════════════════════
    const VPTags = {
        // Robust, Unicode-safe command parser. It intentionally accepts a
        // little more than the prompt asks for because small/local models tend
        // to add spaces or use aliases under pressure.
        _TYPE_PATTERN: 'IMG|SET|PLAY|FRAME|IMAGE|FX|CAT|TAB|ACTIVITY_REQUEST|ACTIVITY_CHALLENGE|ACTIVITY_START|ACTIVITY_AUTO|ACTIVITY_ACCEPT|ACTIVITY_DECLINE',
        _IMAGE_TYPES: new Set(['IMG', 'SET', 'PLAY', 'FRAME', 'IMAGE']),
        _ACTIVITY_TYPES: new Set(['ACTIVITY_REQUEST', 'ACTIVITY_CHALLENGE', 'ACTIVITY_START', 'ACTIVITY_AUTO', 'ACTIVITY_ACCEPT', 'ACTIVITY_DECLINE']),
        _ACTION_ALIASES: {
            open: 'open', opened: 'open', expand: 'open', show: 'open', reveal: 'open', load: 'open',
            открыть: 'open', открой: 'open', открыть_папку: 'open', развернуть: 'open', разверни: 'open', показать: 'open', покажи: 'open',
            collapse: 'collapse', collapsed: 'collapse', close: 'collapse', fold: 'collapse', hide: 'collapse', unload: 'collapse',
            свернуть: 'collapse', сверни: 'collapse', закрыть: 'collapse', закрой: 'collapse', скрыть: 'collapse', спрячь: 'collapse',
        },

        _rx(flags = 'giu') {
            return new RegExp(`\\[\\s*(${this._TYPE_PATTERN})\\s*(?::|：)?\\s*([^\\]\\r\\n]*)?\\]`, flags);
        },
        one(type) {
            const normalized = this.normalizeType(type);
            const types = normalized === 'IMG' ? 'IMG|SET|PLAY|FRAME|IMAGE' : normalized;
            return new RegExp(`\\[\\s*(${types})\\s*(?::|：)\\s*([^\\]\\r\\n]+?)\\s*\\]`, 'giu');
        },
        all() { return this._rx('giu'); },
        command() { return this._rx('giu'); },
        dir() { return /\[\s*(CAT|TAB)\s*(?::|：)\s*([^:\]：\r\n]+?)\s*(?::|：)\s*([^\]\r\n]+?)\s*\]/giu; },

        cleanBody(value) {
            return String(value == null ? '' : value)
                .normalize('NFKC')
                .replace(/[\u200B-\u200D\uFEFF]/g, '')
                .replace(/[“”]/g, '"')
                .replace(/[‘’]/g, "'")
                .trim()
                .replace(/^['"`]+|['"`]+$/g, '')
                .replace(/\s+/g, ' ')
                .trim();
        },
        normalizeType(type) {
            const t = String(type || '').normalize('NFKC').trim().toUpperCase().replace(/[\s\-]+/g, '_');
            return this._IMAGE_TYPES.has(t) ? 'IMG' : t;
        },
        normalizeAction(action) {
            const a = String(action || '')
                .normalize('NFKC')
                .trim()
                .toLowerCase()
                .replace(/ё/g, 'е')
                .replace(/[\s\-]+/g, '_');
            return this._ACTION_ALIASES[a] || a;
        },
        normalizeLookup(value) {
            return String(value || '')
                .normalize('NFKC')
                .trim()
                .toLowerCase()
                .replace(/ё/g, 'е')
                .replace(/[\s\-]+/g, '_')
                .replace(/[^\p{L}\p{N}_]+/gu, '')
                .replace(/_+/g, '_')
                .replace(/^_+|_+$/g, '');
        },
        sanitizeLooseTag(value) {
            return this.normalizeLookup(value)
                .replace(/[^a-z0-9_]+/g, '')
                .replace(/^_+|_+$/g, '');
        },
        distance(a, b) {
            a = String(a || ''); b = String(b || '');
            if (a === b) return 0;
            if (!a) return b.length;
            if (!b) return a.length;
            const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
            const curr = new Array(b.length + 1);
            for (let i = 1; i <= a.length; i++) {
                curr[0] = i;
                for (let j = 1; j <= b.length; j++) {
                    curr[j] = a[i - 1] === b[j - 1]
                        ? prev[j - 1]
                        : Math.min(prev[j - 1] + 1, prev[j] + 1, curr[j - 1] + 1);
                }
                for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
            }
            return prev[b.length];
        },

        parseMatch(match) {
            if (!match) return null;
            const type = this.normalizeType(match[1] || '');
            if (!type || !new RegExp(`^(?:${this._TYPE_PATTERN})$`, 'i').test(match[1] || '')) return null;
            return {
                raw: match[0] || '',
                originalType: String(match[1] || '').trim().toUpperCase(),
                type,
                body: this.cleanBody(match[2] || ''),
            };
        },
        parseImageBody(body) {
            const parts = String(body || '').split(/\s*[:：]\s*/);
            const rawTag = this.cleanBody(parts.shift() || '');
            const transition = this.cleanBody(parts.join(':')) || null;
            const tag = this.resolveImageTag(rawTag) || rawTag;
            return tag ? { tag, transition } : null;
        },
        parseDirBody(body) {
            const parts = String(body || '').split(/\s*[:：]\s*/);
            if (parts.length < 2) return null;
            const action = this.normalizeAction(parts.shift());
            const name = this.cleanBody(parts.join(':'));
            if (!name || (action !== 'open' && action !== 'collapse')) return null;
            return { action, name };
        },
        toQueueItem(cmd) {
            // Backward-compatible helper. The Director Command Bus is the
            // canonical executor; queueable commands are wrapped for it.
            if (!cmd) return null;
            const type = this.normalizeType(cmd.type || cmd.originalType || '');
            if (type === 'IMG' || type === 'FX' || type === 'CAT' || type === 'TAB') {
                return { type: 'vp_command', command: cmd };
            }
            return null;
        },

        strip(text) { return String(text == null ? '' : text).replace(this.all(), ''); },
        commands(text) {
            const out = [];
            const re = this.command();
            let m;
            while ((m = re.exec(String(text == null ? '' : text))) !== null) {
                const cmd = this.parseMatch(m);
                if (cmd) out.push(cmd);
            }
            return out;
        },
        split(raw) {
            const parsed = this.parseImageBody(raw);
            if (parsed) return { tag: parsed.tag, extra: parsed.transition };
            const s = this.cleanBody(raw);
            return { tag: s, extra: null };
        },
        images(text) {
            return this.commands(text)
                .filter(cmd => cmd.type === 'IMG')
                .map(cmd => {
                    const img = this.parseImageBody(cmd.body);
                    return img ? { raw: cmd.body, tag: img.tag, extra: img.transition, command: cmd.raw } : null;
                })
                .filter(Boolean);
        },
        fx(text) {
            return this.commands(text)
                .filter(cmd => cmd.type === 'FX')
                .map(cmd => this.cleanBody(cmd.body))
                .filter(Boolean);
        },
        activity(text) {
            return this.commands(text).filter(cmd => this._ACTIVITY_TYPES.has(cmd.type));
        },
        findOpenCommandStart(text) {
            const s = String(text == null ? '' : text);
            const idx = s.lastIndexOf('[');
            if (idx === -1 || s.indexOf(']', idx) !== -1) return -1;
            const tail = s.slice(idx);
            if (new RegExp(`^\\[\\s*(?:${this._TYPE_PATTERN})(?:\\s*(?::|：)[^\\]\\r\\n]*)?$`, 'iu').test(tail)) return idx;

            // Streaming chunks often split a command name: "[I" → "[IMG:".
            // Keep likely command prefixes out of the visible stream until the
            // closing bracket arrives or the prefix proves unrelated.
            const inner = tail.slice(1).trimStart().normalize('NFKC').toUpperCase().replace(/[\s\-]+/g, '_');
            if (!inner) return idx;
            const head = (inner.match(/^[A-Z_]+/) || [''])[0];
            if (!head) return -1;
            const types = this._TYPE_PATTERN.split('|');
            return types.some(t => t.startsWith(head)) ? idx : -1;
        },
        resolveImageTag(rawTag) {
            let tag = this.cleanBody(rawTag);
            if (!tag || !State?.gallery) return tag || null;

            // 1. Priority: If the tag exists exactly as requested, use it immediately.
            if (State.gallery.has(tag)) return tag;

            // 2. Permanent Aliases (Studio 2.0 Chain Resolver)
            const aliases = State.galleryData?.tagAliases || {};
            let currentLookup = tag;
            let depth = 0;
            
            // Follow the redirect chain (e.g., A -> B -> C)
            while (aliases[currentLookup] && depth < 10) {
                const target = aliases[currentLookup].to;
                if (State.gallery.has(target)) {
                    return target; // Found a living asset!
                }
                currentLookup = target; // Move to next link in chain
                depth++;
            }

            // 3. Fallback: Fuzzy matching and typos
            const loose = this.normalizeLookup(tag);
            const ascii = this.sanitizeLooseTag(tag);
            if (ascii && State.gallery.has(ascii)) return ascii;

            for (const [from, rec] of Object.entries(aliases)) {
                if (this.normalizeLookup(from) === loose && rec?.to && State.gallery.has(rec.to)) return rec.to;
            }

            for (const tag of State.gallery.keys()) {
                if (this.normalizeLookup(tag) === loose) return tag;
            }

            // Conservative typo repair: only for sufficiently distinctive tags.
            if (loose.length < 5) return null;
            let best = null;
            let bestDist = Infinity;
            for (const tag of State.gallery.keys()) {
                const candidate = this.normalizeLookup(tag);
                if (!candidate) continue;
                const dist = this.distance(loose, candidate);
                if (dist < bestDist) { bestDist = dist; best = tag; }
            }
            const maxDist = loose.length <= 8 ? 1 : 2;
            return best && bestDist <= maxDist && (bestDist / Math.max(loose.length, 1)) <= 0.2 ? best : null;
        },
    };

    // ════════════════════════════════════════════════════════════════
    //  DIRECTOR COMMAND BUS v1
    //  One official registry for model/director commands. VPTags parses
    //  syntax; the bus validates, routes, executes and logs commands.
    // ════════════════════════════════════════════════════════════════
    function cloneForLog(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch { return String(value); }
    }

    const VPCommandBus = {
        _registry: new Map(),
        _log: [],
        maxLog: 300,
        _seq: 0,

        register(type, spec = {}) {
            const normalized = VPTags.normalizeType(type);
            if (!normalized) return false;
            const entry = {
                type: normalized,
                target: spec.target || 'unknown',
                description: spec.description || '',
                queueable: spec.queueable !== false,
                handler: typeof spec === 'function' ? spec : spec.handler,
                meta: spec.meta || null,
            };
            this._registry.set(normalized, entry);
            return true;
        },

        unregister(type) { return this._registry.delete(VPTags.normalizeType(type)); },
        has(type) { return this._registry.has(VPTags.normalizeType(type)); },

        getRegistry() {
            return Array.from(this._registry.values()).map(entry => ({
                type: entry.type,
                target: entry.target,
                description: entry.description,
                queueable: !!entry.queueable,
                meta: cloneForLog(entry.meta),
            }));
        },

        getLog(limit = this.maxLog) {
            const n = Math.max(0, Number(limit) || this.maxLog);
            return this._log.slice(-n).map(cloneForLog);
        },

        clearLog() { this._log = []; },

        _pushLog(entry) {
            const row = {
                id: ++this._seq,
                time: Date.now(),
                ...entry,
            };
            this._log.push(row);
            if (this._log.length > this.maxLog) this._log.splice(0, this._log.length - this.maxLog);
            return row;
        },

        _payloadFor(type, body) {
            if (type === 'IMG') {
                const img = VPTags.parseImageBody(body);
                if (!img?.tag) return { ok: false, error: 'Empty image tag' };
                return { ok: true, payload: { tag: img.tag, transition: img.transition || null } };
            }
            if (type === 'FX') {
                const name = VPTags.cleanBody(body);
                if (!name) return { ok: false, error: 'Empty FX name' };
                return { ok: true, payload: { name } };
            }
            if (type === 'CAT' || type === 'TAB') {
                const dir = VPTags.parseDirBody(body);
                if (!dir) return { ok: false, error: 'Invalid directory command; expected [TAB:open:name] or [CAT:collapse:name]' };
                return { ok: true, payload: { entityType: type, action: dir.action, name: dir.name } };
            }
            if (VPTags._ACTIVITY_TYPES.has(type)) {
                return { ok: true, payload: { arg: VPTags.cleanBody(body) } };
            }
            return { ok: true, payload: { body: VPTags.cleanBody(body) } };
        },

        normalize(command) {
            if (!command) return { ok: false, error: 'Empty command' };
            if (command.__vpCommand) return { ok: true, command };

            let parsed = command;
            if (typeof command === 'string') {
                const found = VPTags.commands(command);
                parsed = found[0] || null;
            }
            if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Command is not parseable', raw: String(command || '') };

            const type = VPTags.normalizeType(parsed.type || parsed.originalType || '');
            const originalType = String(parsed.originalType || parsed.type || type || '').trim().toUpperCase();
            const body = VPTags.cleanBody(parsed.body ?? parsed.arg ?? '');
            const raw = parsed.raw || (type ? `[${type}${body ? ':' + body : ''}]` : '');
            if (!type) return { ok: false, error: 'Missing command type', raw, body };

            const payloadResult = this._payloadFor(type, body);
            if (!payloadResult.ok) {
                return { ok: false, error: payloadResult.error, raw, type, originalType, body };
            }

            return {
                ok: true,
                command: {
                    __vpCommand: true,
                    raw,
                    originalType,
                    type,
                    body,
                    payload: payloadResult.payload,
                },
            };
        },

        toQueueItem(command) {
            const rawType = command?.type || command?.originalType || '';
            const type = VPTags.normalizeType(rawType);
            const entry = this._registry.get(type);
            if (!entry || entry.queueable === false) return null;
            // Do not validate payload here: invalid queueable commands should still
            // pass through execute() so they are logged instead of disappearing.
            return { type: 'vp_command', command };
        },

        async execute(command, meta = {}) {
            const normalized = this.normalize(command);
            const baseMeta = {
                source: meta.source || 'unknown',
                role: meta.role || null,
                raw: normalized.command?.raw || normalized.raw || command?.raw || String(command || ''),
                type: normalized.command?.type || normalized.type || null,
                originalType: normalized.command?.originalType || normalized.originalType || null,
                body: normalized.command?.body || normalized.body || '',
                payload: cloneForLog(normalized.command?.payload || null),
            };

            if (!normalized.ok) {
                const row = this._pushLog({ ...baseMeta, status: 'invalid', target: null, error: normalized.error || 'Invalid command' });
                console.warn('[VP CommandBus] Invalid command:', row);
                return { ...row, ok: false, delayMs: 0 };
            }

            const cmd = normalized.command;
            const entry = this._registry.get(cmd.type);
            if (!entry) {
                const row = this._pushLog({ ...baseMeta, status: 'unknown', target: null, error: `Command ${cmd.type} is not registered` });
                console.warn(`[VP CommandBus] Unknown command: ${cmd.raw}`);
                return { ...row, ok: false, delayMs: 0 };
            }

            if (typeof entry.handler !== 'function') {
                const row = this._pushLog({ ...baseMeta, status: 'unhandled', target: entry.target, error: `Command ${cmd.type} has no handler` });
                console.warn(`[VP CommandBus] Unhandled command: ${cmd.raw}`);
                return { ...row, ok: false, delayMs: 0 };
            }

            try {
                const result = await entry.handler(cmd, meta, entry);
                const ok = !(result && result.ok === false);
                const row = this._pushLog({
                    ...baseMeta,
                    target: entry.target,
                    status: ok ? 'success' : 'failed',
                    result: cloneForLog(result || null),
                    error: ok ? null : (result?.error || 'Command handler returned failure'),
                });
                if (!ok) console.warn('[VP CommandBus] Command failed:', row);
                return { ...row, ok, delayMs: Number(result?.delayMs || 0) };
            } catch (err) {
                const row = this._pushLog({
                    ...baseMeta,
                    target: entry.target,
                    status: 'error',
                    error: err?.message || String(err),
                });
                console.error('[VP CommandBus] Command handler error:', err);
                return { ...row, ok: false, delayMs: 0 };
            }
        },

        async executeText(text, meta = {}) {
            const commands = VPTags.commands(text);
            const types = meta.types ? new Set(meta.types.map(t => VPTags.normalizeType(t))) : null;
            const out = [];
            for (const cmd of commands) {
                const type = VPTags.normalizeType(cmd.type);
                const entry = this._registry.get(type);
                if (types && !types.has(type)) continue;
                if (entry?.queueable === false && !meta.allowNonQueueable) continue;
                out.push(await this.execute(cmd, meta));
            }
            return out;
        },
    };

    VPCommandBus.register('IMG', {
        target: 'projector',
        description: 'Switch projector to a visual asset: [IMG:tag]',
        queueable: true,
        handler(cmd, meta = {}) {
            const { tag, transition } = cmd.payload || {};
            const ok = !!tag && setCurrent(tag, meta.setCurrentSource || 'model', true, transition || null);
            if (ok && meta.showToast !== false) showToast(`▶ ${tag}`, 'info');
            return { ok, tag, transition: transition || null, delayMs: ok ? 400 : 0, error: ok ? null : `Image tag not found: ${tag || '(empty)'}` };
        },
    });

    VPCommandBus.register('FX', {
        target: 'fx-core',
        description: 'Trigger a visual effect: [FX:name] or [FX:name:intensity]',
        queueable: true,
        handler(cmd) {
            if (typeof FX === 'undefined') return { ok: false, error: 'FX engine is not loaded' };
            FX.fire(cmd.payload?.name || cmd.body);
            return { ok: true, name: cmd.payload?.name || cmd.body, delayMs: 0 };
        },
    });

    function executeDirectoryCommand(cmd) {
        const TM = window.VisualProjector?.gallery?.TabsManager;
        if (!TM?.executeCommand) return { ok: false, error: 'Gallery TabsManager is not ready' };
        const { entityType, action, name } = cmd.payload || {};
        TM.executeCommand(entityType || cmd.type, action, name);
        return { ok: true, entityType: entityType || cmd.type, action, name, delayMs: 0 };
    }

    VPCommandBus.register('CAT', {
        target: 'gallery-tabs',
        description: 'Open/collapse a category: [CAT:open:name] / [CAT:collapse:name]',
        queueable: true,
        handler: executeDirectoryCommand,
    });
    VPCommandBus.register('TAB', {
        target: 'gallery-tabs',
        description: 'Open/collapse a tab: [TAB:open:name] / [TAB:collapse:name]',
        queueable: true,
        handler: executeDirectoryCommand,
    });

    for (const type of VPTags._ACTIVITY_TYPES) {
        VPCommandBus.register(type, {
            target: 'games',
            description: 'Activity/game command. Full-text processing is delegated to VP_GAMES.',
            queueable: false,
            async handler(cmd, meta = {}) {
                if (!window.VP_GAMES?.processActivityCommands) return { ok: false, error: 'VP_GAMES is not ready' };
                const res = await window.VP_GAMES.processActivityCommands(cmd.raw, meta);
                return { ok: true, resultCount: Array.isArray(res) ? res.length : 0, delayMs: 0 };
            },
        });
    }

    function routeActivityCommandsThroughBus(text, meta = {}, warnPrefix = '[VP]') {
        if (!text || !window.VP_GAMES?.processActivityCommands) return;
        VPCommandBus.executeText(text, {
            ...meta,
            allowNonQueueable: true,
            types: [...VPTags._ACTIVITY_TYPES],
        }).catch(err => console.warn(`${warnPrefix} activity command processing failed:`, err));
    }

    // ════════════════════════════════════════════════════════════════
    //  LIGHTWEIGHT MODULE REGISTRIES
    //  Optional modules (shell/session/profiles/lore/games) can register
    //  UI panels and prompt providers without coupling to each other.
    // ════════════════════════════════════════════════════════════════

    const PanelRegistry = new Map();
    const PromptProviderRegistry = new Map();
    let _resolveCoreReady = null;
    let _rejectCoreReady = null;
    let _coreInitStarted = false;
    let _coreInitDone = false;
    const coreReady = new Promise((resolve, reject) => {
        _resolveCoreReady = resolve;
        _rejectCoreReady = reject;
    });

    function registerPanel(def) {
        if (!def || !def.id || typeof def.create !== 'function') {
            console.warn('[VP] registerPanel: invalid panel definition', def);
            return false;
        }
        PanelRegistry.set(def.id, {
            title: def.title || def.id,
            icon: def.icon || '□',
            order: Number.isFinite(def.order) ? def.order : 100,
            ...def,
        });
        return true;
    }

    function unregisterPanel(id) {
        return PanelRegistry.delete(id);
    }

    function getPanels() {
        return Array.from(PanelRegistry.values()).sort((a, b) => (a.order || 100) - (b.order || 100));
    }

    function getPanel(id) {
        return PanelRegistry.get(id) || null;
    }

    function registerPromptProvider(def) {
        if (!def || !def.id || typeof def.build !== 'function') {
            console.warn('[VP] registerPromptProvider: invalid provider definition', def);
            return false;
        }
        PromptProviderRegistry.set(def.id, {
            order: Number.isFinite(def.order) ? def.order : 100,
            enabled: true,
            ...def,
        });
        return true;
    }

    function unregisterPromptProvider(id) {
        return PromptProviderRegistry.delete(id);
    }

    function getPromptProviders() {
        return Array.from(PromptProviderRegistry.values()).sort((a, b) => (a.order || 100) - (b.order || 100));
    }

    function buildPromptProviderContext() {
        return getPromptProviders()
            .filter(p => p.enabled !== false)
            .map(p => {
                try { return p.build(State); }
                catch (err) { console.warn(`[VP] Prompt provider failed: ${p.id}`, err); return ''; }
            })
            .filter(Boolean)
            .join('\n\n');
    }

    // ════════════════════════════════════════════════════════════════
    //  GEOMETRY HELPERS  (shared with gallery via VP facade)
    // ════════════════════════════════════════════════════════════════
    function getElementScale(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return { x: 1, y: 1 };
        const rect = el.getBoundingClientRect();
        const sx = el.offsetWidth  > 0 ? (rect.width  / el.offsetWidth)  : 1;
        const sy = el.offsetHeight > 0 ? (rect.height / el.offsetHeight) : 1;
        return { x: Number.isFinite(sx) && sx > 0 ? sx : 1, y: Number.isFinite(sy) && sy > 0 ? sy : 1 };
    }
    function viewportPointToCssSpace(x, y, el) {
        const scale = getElementScale(el);
        return { x: x / scale.x, y: y / scale.y, scaleX: scale.x, scaleY: scale.y };
    }
    function viewportRectToCssSpace(rect, el) {
        const scale = getElementScale(el);
        return {
            left: rect.left / scale.x, top: rect.top / scale.y,
            width: rect.width / scale.x, height: rect.height / scale.y,
            right: rect.right / scale.x, bottom: rect.bottom / scale.y,
            scaleX: scale.x, scaleY: scale.y,
        };
    }
    function getNormalizedElementPlacement(el) {
        const rect = el.getBoundingClientRect();
        return { rect, css: viewportRectToCssSpace(rect, el) };
    }

    function stripInjectedManifest(text) {
        let out = String(text == null ? '' : text);
        out = out.replace(/\n{0,2}\[SCENE CONTROL\][\s\S]*?\[\/SCENE CONTROL\]\s*$/i, '');
        out = out.replace(/\n{0,2}\[VISUAL PROJECTOR\][\s\S]*?(?=\n\n|\n\[|$)/i, '');
        return out.trimEnd();
    }

    function buildProjectorSnapshot() {
        return {
            currentTag: State.current?.tag || null,
            coverTag: State.coverTag || null,
            preparedTag: State.preparedTag || null,
            history: (State.history || []).map(h => ({
                tag: h.tag,
                filename: h.filename || h.tag,
                timestamp: h.timestamp || Date.now(),
                source: h.source || 'user',
            })),
            playbackMessages: (State.playback?.messages || []).map(m => ({
                id: m.id,
                role: m.role || 'assistant',
                text: m.text || '',
                timestamp: m.timestamp || Date.now(),
                frameTagAtStart: m.frameTagAtStart ?? null,
            })),
        };
    }

    let _projectorPersistTimer = null;
    function persistProjectorState() {
        const db = window.VP_DB;
        const snapshot = buildProjectorSnapshot();
        clearTimeout(_projectorPersistTimer);
        _projectorPersistTimer = setTimeout(() => {
            if (db?.setProjectorState) {
                db.setProjectorState(snapshot).catch(err => console.warn('[VP] Projector state persist failed:', err));
            }
            window.VisualProjector?.chats?.syncProjectorFromRuntime?.();
        }, 120);
    }

    function applyProjectorSnapshot(snapshot) {
        if (!snapshot || typeof snapshot !== 'object') return false;

        const restoredHistory = Array.isArray(snapshot.history) ? snapshot.history
            .map(h => {
                const asset = State.gallery.get(h.tag);
                if (!asset) return null;
                return {
                    tag: asset.tag,
                    blob: asset.blob,
                    url: asset.url,
                    filename: asset.filename || h.filename || asset.tag,
                    timestamp: h.timestamp || Date.now(),
                    source: h.source || 'user',
                };
            })
            .filter(Boolean)
            : [];

        const restoredPlayback = Array.isArray(snapshot.playbackMessages) ? snapshot.playbackMessages
            .filter(m => m && String(m.text || '').trim())
            .map(m => ({
                id: m.id || (Date.now() + Math.random()),
                role: m.role || 'assistant',
                text: String(m.text || ''),
                timestamp: m.timestamp || Date.now(),
                frameTagAtStart: m.frameTagAtStart ?? null,
            }))
            : [];

        State.coverTag = snapshot.coverTag && State.gallery.has(snapshot.coverTag) ? snapshot.coverTag : null;
        State.preparedTag = snapshot.preparedTag && State.gallery.has(snapshot.preparedTag) ? snapshot.preparedTag : null;
        State.current = snapshot.currentTag && State.gallery.has(snapshot.currentTag)
            ? State.gallery.get(snapshot.currentTag)
            : null;
        State.history = restoredHistory.slice(-(State.config.maxHistory || 20));
        State.playback.messages = restoredPlayback.slice(-(State.config.maxPlaybackMessages || 50));
        State.playback.cursor = -1;
        State.playback.mode = 'live';
        updatePlayerBar();
        updateProjectorUI();
        return true;
    }

    // ════════════════════════════════════════════════════════════════
    //  PROJECTOR  (active frame + history)
    // ════════════════════════════════════════════════════════════════
    function setCurrent(tag, source = 'user', force = false, transition = null) {
        const requestedTag = tag;
        tag = VPTags.resolveImageTag(tag) || tag;
        State.currentTransition = transition || State.config.transitionType || 'crossfade';
        if (State.currentTransition === 'random') {
            const list = ['crossfade', 'slide_left', 'slide_up', 'zoom', 'pop', 'flip'];
            State.currentTransition = list[Math.floor(Math.random() * list.length)];
        }
        const asset = State.gallery.get(tag);
        if (!asset) { console.warn(`[VP] Тег не найден: "${requestedTag}"`); return false; }
        if (requestedTag !== tag) console.log(`[VP] Resolved image tag "${requestedTag}" → "${tag}"`);

        if (!force && State.current?.tag === tag) { console.log(`[VP] Кадр "${tag}" уже активен — пропускаем`); return true; }

        State.current = asset;
        const makeFrame = () => ({
            tag: asset.tag, blob: asset.blob, url: asset.url,
            filename: asset.filename || asset.tag, timestamp: Date.now(), source: source,
        });

        if (source === 'user') {
            State.history = State.history.filter(h => h.source !== 'user');
            State.history.push(makeFrame());
            if (State.history.length > State.config.maxHistory) State.history.shift();
        } else if (!new Set(['replay', 'cover', 'prepared']).has(source)) {
            // Replay/cover display is UI navigation, not new scene history.
            // Model/game-driven switches are still recorded for future visual context.
            const isSameTag = State.history[State.history.length - 1]?.tag === tag;
            if (!isSameTag) {
                State.history.push(makeFrame());
                if (State.history.length > State.config.maxHistory) State.history.shift();
            }
        }

        updateProjectorUI();
        persistProjectorState();
        const db = window.VP_DB;
        if (db?.setCurrentTag) db.setCurrentTag(tag).catch(() => {});
        window.VisualProjector?.gallery?.refreshGalleryPanelUI?.();
        console.log(`[VP] Текущий кадр: "${tag}" (source: ${source})`);
        return true;
    }

    function clearCurrent() {
        State.current = null;
        State.history = State.history.filter(h => h.source !== 'user');
        if (State.playback.messages.length === 0) State.preparedTag = null;
        updateProjectorUI();
        persistProjectorState();
        const db = window.VP_DB;
        if (db?.setCurrentTag) db.setCurrentTag(null).catch(() => {});
        window.VisualProjector?.gallery?.refreshGalleryPanelUI?.();
    }

    function isAssetReady(asset) {
        return !!(asset.description && asset.description.trim().length > 0);
    }

    // ════════════════════════════════════════════════════════════════
    //  TEMPLATE  (manifest + frame context builder)
    // ════════════════════════════════════════════════════════════════

    const DEFAULT_MANIFEST_TEMPLATE =
`[SCENE CONTROL]
{{#if hasGallery}}You are an improv actor playing out a seamless narrative using the provided assets. Match the visual style and emotional tone of the assets while progressing the scene

Use [IMG:tag] to cut to a frame.

GUIDELINES:
- The active frame is the scene's live visual — let it inspire and ground what happens next.
- Pick one or more [IMG:tag] from the frame list to illustrate actions or emotions.
- Put [IMG:tag] before the lines that match that frame.
- Don't use same tags in a row.

{{/if}}{{#if hasReady}}AVAILABLE FRAMES (tag — description):
{{assetsList}}

{{/if}}{{#if hasEffects}}VISUAL EFFECTS:
Trigger an effect that overlays the current frame: insert [FX:name] and it fires automatically. Optional intensity 1-10: [FX:name:8] (default 5). Effects fade on their own; a new one replaces the active effect. Use them sparingly, only when they fit the moment.

Available effects:
{{/if}}{{#if hasTransient}}{{effectsList}}
{{/if}}{{#if hasMood}}{{moodList}}
{{/if}}{{#if hasGallery}}
Currently showing: {{currentTag}}
{{/if}}[/SCENE CONTROL]`;

    const DEFAULT_FRAME_TEMPLATE =
`[STAGE — frame {{n}} of {{total}}, {{position}}]
The scene's current visual. Let it ground and inspire what happens next.
Frame: {{tag}} ({{source}})`;

    const CONTACT_SHEET_PROMPT_TEMPLATE =
`[CURRENT GALLERY VIEW]
{{#if collageTitle}}Title: {{collageTitle}}
{{/if}}{{#if collageDescription}}Director note: {{collageDescription}}
{{/if}}Visible tabs: {{collageSections}}

This image shows the current gallery view available for choosing scene frames.
It may change when tabs are opened or collapsed.
Preview cards are grouped by "TAB: <Name>". Use a preview card's [IMG:tag] label only when you want to switch the visible scene frame.
{{#if allowDirectoryCommands}}You may request another gallery view with [TAB:open:name], [TAB:collapse:name], [CAT:open:name], or [CAT:collapse:name].{{/if}}`;



    function renderTemplate(template, data) {
        try {
            let result = template;
            result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => data[key] ? content : '');
            result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] !== undefined ? String(data[key]) : match);
            return result;
        } catch (err) {
            console.warn('[VP] Template render failed:', err);
            return null;
        }
    }

    const TEMPLATE_VARS = {
        manifest: {
            '{{currentTag}}':   'tag of the currently shown asset',
            '{{assetsList}}':   'list of tagged assets (with descriptions if enabled)',
            '{{pendingList}}':  'list of untagged assets',
            '{{galleryCount}}': 'total number of assets',
            '{{readyCount}}':   'number of tagged assets',
            '{{pendingCount}}': 'number of untagged assets',
            '{{effectsList}}':  'list of transient effects available to the bot',
            '{{moodList}}':     'list of mood effects available to the bot',
            '{{#if hasGallery}}...{{/if}}': 'shown only if the gallery has assets',
            '{{#if hasReady}}...{{/if}}':   'shown only if there are tagged assets',
            '{{#if hasPending}}...{{/if}}': 'shown only if there are untagged assets',
            '{{#if noReady}}...{{/if}}':    'shown only if no tagged assets exist',
            '{{#if hasEffects}}...{{/if}}': 'shown only if any effect is available to the bot',
            '{{#if hasTransient}}...{{/if}}': 'shown only if a transient effect is available',
            '{{#if hasMood}}...{{/if}}':      'shown only if a mood effect is available',
        },
        frame: {
            '{{n}}':        'frame number in history (1-based)',
            '{{total}}':    'total frames in history',
            '{{position}}': '"CURRENT ACTIVE frame" or "previous frame"',
            '{{tag}}':      'tag of this frame\'s asset',
            '{{source}}':   'who set this shot',
        },
    };

    function updatePromptHints(textarea, type) {
        const hintsEl = textarea.parentElement.querySelector('.vp-prompt-hints');
        if (!hintsEl) return;
        const content = textarea.value;
        const allVars = TEMPLATE_VARS[type] || {};
        const used = [], unused = [];
        for (const [varName, description] of Object.entries(allVars)) {
            const checkStr = varName.startsWith('{{#if') ? varName.match(/\{\{#if\s+\w+\}\}/)[0] : varName;
            if (content.includes(checkStr)) used.push({ name: varName, desc: description });
            else unused.push({ name: varName, desc: description });
        }
        const usedHTML = used.length > 0
            ? `<div class="vp-hints-section"><div class="vp-hints-title">✓ Using:</div>${used.map(v => `<code class="vp-hint-used" title="${v.desc}">${v.name}</code>`).join(' ')}</div>`
            : '';
        const unusedHTML = unused.length > 0
            ? `<div class="vp-hints-section"><div class="vp-hints-title">+ Available (click to insert):</div>${unused.map(v => `<code class="vp-hint-available" data-insert="${escapeAttr(v.name)}" title="${v.desc}">${v.name}</code>`).join(' ')}</div>`
            : '';
        hintsEl.innerHTML = usedHTML + unusedHTML;
        hintsEl.querySelectorAll('.vp-hint-available').forEach(el => {
            el.addEventListener('click', () => {
                insertAtCursor(textarea, el.dataset.insert);
                textarea.focus();
                updatePromptHints(textarea, type);
                if (type === 'manifest') State.config.prompts.manifest = textarea.value.trim() || null;
                else State.config.prompts.frameContext = textarea.value.trim() || null;
                schedulePersist?.();
            });
        });
    }

    function updateTemplateStatus(textarea) {
        const section = textarea.closest('.vp-prompt-section');
        if (!section) return;
        let badge = section.querySelector('.vp-prompt-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'vp-prompt-badge';
            section.querySelector('.vp-prompt-label span').appendChild(badge);
        }
        const isDefault = textarea.dataset.isDefault === 'true';
        badge.textContent = isDefault ? ' · default' : ' · custom';
        badge.classList.toggle('vp-prompt-badge-default', isDefault);
        badge.classList.toggle('vp-prompt-badge-custom', !isDefault);
    }

    function insertAtCursor(textarea, text) {
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + text + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
    }

    function escapeAttr(str) {
        return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function buildManifest(templateOverride = null) {
        const fxEnabled = (typeof FX !== 'undefined') && FX.enabled;
        if (State.gallery.size === 0 && !fxEnabled) return '';

        const currentTag = State.current ? State.current.tag : 'none';
        const allAssets = Array.from(State.gallery.values()).filter(a => !a.hidden && a.tag !== '__SCENERY_COLLAGE__');
        const activeCollageAsset = State.coverTag === '__SCENERY_COLLAGE__' ? State.gallery.get('__SCENERY_COLLAGE__') : null;
        const activeCollageTags = new Set((activeCollageAsset?.collageMeta?.tabs || [])
            .flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []));
        const hasActiveCollageFilter = activeCollageTags.size > 0;
        const isInActiveCollage = (asset) => !hasActiveCollageFilter || asset?.tag === '__SCENERY_COLLAGE__' || activeCollageTags.has(asset?.tag);

        let treeList = '';
        let readyCount = 0;
        let pendingCount = 0;

        const hasCollapsibles = State.config.allowDirectoryCommands && State.galleryData &&
            (State.galleryData.categories.some(c => c.state !== 'locked') || State.galleryData.tabs.some(t => t.state !== 'locked'));
        if (hasCollapsibles) {
            treeList += `# DIRECTORY COMMANDS\nSome folders are collapsed below. To pull their assets into your NEXT turn, use [TAB:open:Name] or [CAT:open:Name]. To put a folder away again, use [TAB:collapse:Name] or [CAT:collapse:Name].\n`;
        }

        const processedTags = new Set();

        if (State.galleryData && State.galleryData.categories) {
            for (const cat of State.galleryData.categories) {
                if (cat.state === 'locked') {
                    const lockedTabs = State.galleryData.tabs.filter(t => t.categoryId === cat.id);
                    lockedTabs.forEach(tab => { allAssets.filter(a => a.tabId === tab.id).forEach(a => processedTags.add(a.tag)); });
                    continue;
                }
                const catTabs = State.galleryData.tabs.filter(t => {
                    if (t.categoryId === cat.id) {
                        if (t.state === 'locked') { allAssets.filter(a => a.tabId === t.id).forEach(a => processedTags.add(a.tag)); return false; }
                        return true;
                    }
                    return false;
                });
                if (catTabs.length === 0) continue;

                if (cat.state === 'collapsed') {
                    let catAssetsTotal = 0;
                    catTabs.forEach(tab => {
                        const tabAssets = allAssets.filter(a => a.tabId === tab.id);
                        catAssetsTotal += tabAssets.length;
                        tabAssets.forEach(a => processedTags.add(a.tag));
                    });
                    if (State.config.allowDirectoryCommands) {
                        catTabs.forEach(tab => { allAssets.filter(a => a.tabId === tab.id).forEach(a => isAssetReady(a) ? readyCount++ : pendingCount++); });
                        treeList += `\n# 📦 ${cat.name} — collapsed (${catTabs.length} tabs, ${catAssetsTotal} assets)${cat.desc ? ' — '+cat.desc : ''}. Request with [CAT:open:${cat.name}].\n`;
                    }
                    continue;
                }

                treeList += `\n# 📁 ${cat.name}${cat.desc ? ' — '+cat.desc : ''}\n`;
                for (const tab of catTabs) {
                    const tabAssets = allAssets.filter(a => a.tabId === tab.id);
                    if (tab.state === 'collapsed') {
                        tabAssets.forEach(a => processedTags.add(a.tag));
                        if (State.config.allowDirectoryCommands) {
                            tabAssets.forEach(a => isAssetReady(a) ? readyCount++ : pendingCount++);
                            treeList += `  ▸ ${tab.name} — collapsed (${tabAssets.length} assets)${tab.desc ? ' — '+tab.desc : ''}. Request with [TAB:open:${tab.name}].\n`;
                        }
                    } else {
                        const isCollageActive = (State.coverTag === '__SCENERY_COLLAGE__');
                        const visibleTabAssets = tabAssets.filter(isInActiveCollage);
                        const tabIsRepresentedInCollage = hasActiveCollageFilter && visibleTabAssets.length > 0;
                        const tabHiddenByContactSheet = isCollageActive && hasActiveCollageFilter && !tabIsRepresentedInCollage;

                        if (tabHiddenByContactSheet) {
                            // The tab is open in the gallery UI, but not part of the current
                            // Gallery View. Do not leak even its tab name unless directory
                            // navigation hints are explicitly enabled.
                            tabAssets.forEach(a => processedTags.add(a.tag));
                            if (State.config.allowDirectoryCommands) {
                                treeList += `  ▸ ${tab.name}:${tab.desc ? ' '+tab.desc : ''}\n`;
                                treeList += `    [not in current Gallery View — ${tabAssets.length} asset(s) hidden from current gallery view]\n`;
                            }
                        } else {
                            treeList += `  ▸ ${tab.name}:${tab.desc ? ' '+tab.desc : ''}\n`;
                            if (tabAssets.length === 0) treeList += `    (empty)\n`;
                            else if (isCollageActive && tabIsRepresentedInCollage) {
                                tabAssets.forEach(a => processedTags.add(a.tag));
                                visibleTabAssets.forEach(a => { if (isAssetReady(a)) readyCount++; else pendingCount++; });
                                treeList += `    [GALLERY VIEW ACTIVE — use the visible preview-card [IMG:tag] labels in the current Gallery View]\n`;
                            } else {
                                for (const a of tabAssets) {
                                    processedTags.add(a.tag);
                                    if (isAssetReady(a)) {
                                        treeList += State.config.manifestDescriptions ? `    ${a.tag} — ${a.description}\n` : `    ${a.tag}\n`;
                                        readyCount++;
                                    } else { treeList += `    ${a.tag}\n`; pendingCount++; }
                                }
                            }
                        }
                    }
                }
            }
        }

        let strayAssets = allAssets.filter(a => !processedTags.has(a.tag));
        if (hasActiveCollageFilter) strayAssets = strayAssets.filter(isInActiveCollage);
        if (strayAssets.length > 0) {
            treeList += `\n# 📁 Uncategorized\n`;
            for (const a of strayAssets) {
                if (isAssetReady(a)) { treeList += State.config.manifestDescriptions ? `    ${a.tag} — ${a.description}\n` : `    ${a.tag}\n`; readyCount++; }
                else { treeList += `    ${a.tag}\n`; pendingCount++; }
            }
        }

        const transientEntries = fxEnabled ? Object.entries(FX.catalog) : [];
        const moodEntries      = fxEnabled ? Object.entries(FX.moodCatalog) : [];
        const fxLine = (name, info) => { const desc = (info.desc || '').trim(); return desc ? `  [FX:${name}] — ${desc}` : `  [FX:${name}]`; };
        const effectsList = transientEntries.map(([name, info]) => fxLine(name, info)).join('\n');
        const moodList    = moodEntries.map(([name, info]) => fxLine(name, info)).join('\n');
        const hasTransient = transientEntries.length > 0;
        const hasMood      = moodEntries.length > 0;
        const hasGallery = State.gallery.size > 0;

        const data = {
            currentTag,
            assetsList: treeList.trim(),
            pendingList: '(See untagged items in tree above)',
            galleryCount: State.gallery.size,
            readyCount, pendingCount,
            hasGallery,
            hasReady: readyCount > 0 || pendingCount > 0,
            hasPending: pendingCount > 0,
            noReady: readyCount === 0 && pendingCount === 0,
            hasEffects: fxEnabled && (hasTransient || hasMood),
            hasTransient, hasMood, effectsList, moodList,
        };

        const template = (templateOverride ?? State.config.prompts?.manifest) || DEFAULT_MANIFEST_TEMPLATE;
        let rendered = renderTemplate(template, data);
        if (rendered === null && (templateOverride || State.config.prompts?.manifest)) {
            rendered = renderTemplate(DEFAULT_MANIFEST_TEMPLATE, data);
        }
        return rendered;
    }

    function buildCollagePromptData(tag) {
        const asset = State.gallery.get(tag);
        const meta = asset?.collageMeta || null;
        const tabs = Array.isArray(meta?.tabs) ? meta.tabs : [];
        const assetTags = tabs.flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []);
        const label = String(State.coverLabel || '').trim();
        const labelKey = label.toLowerCase();
        const collageTitle = label && !new Set(['cover', 'contact sheet', 'gallery view', 'current gallery view']).has(labelKey) ? label : '';
        const desc = String(asset?.description || '').trim();
        const descKey = desc.toLowerCase();
        const collageDescription = desc && descKey !== 'automatic scenery assets collage' ? desc : '';
        return {
            collageTitle,
            collageDescription,
            allowDirectoryCommands: !!State.config.allowDirectoryCommands,
            collageSignature: meta?.signature || meta?.generatedAt || 'not-recorded',
            collageSections: tabs.length
                ? tabs.map(t => `${t.name || 'tab'} (${Number(t.count || 0)} cards)`).join('; ')
                : '(sections are visible in the image)',
            collageAssetCount: Number(meta?.assetsCount || assetTags.length || 0) || 'unknown',
        };
    }

    function buildVisualContextFrames() {
        const depth = State.config.contextDepth;
        let frames = [];
        const hasCover = !!State.coverTag;
        const coverIsCurrent = !!(hasCover && State.current?.tag === State.coverTag);

        if (hasCover) {
            const cover = State.gallery.get(State.coverTag);
            if (cover) {
                frames.push({
                    tag: cover.tag,
                    blob: cover.blob,
                    url: cover.url,
                    thumbUrl: cover.thumbUrl,
                    filename: cover.filename || cover.tag,
                    source: 'cover',
                    collageMeta: cover.collageMeta || null,
                });
            }
        }

        // If the cover/contact-sheet is the active frame, older history should not
        // become the "CURRENT ACTIVE frame" after it. This was confusing small
        // vision models and could make them report stale assets as currently seen.
        if (!coverIsCurrent && depth > 0 && State.history.length > 0) {
            const history = State.history
                .slice(-depth)
                .filter(h => h && h.tag && (!State.coverTag || h.tag !== State.coverTag));
            frames = frames.concat(history);
        }

        return frames;
    }

    function buildFrameContextPreview(templateOverride = null) {
        const chosenTemplate = (templateOverride ?? State.config.prompts?.frameContext) || DEFAULT_FRAME_TEMPLATE;
        let frames = buildVisualContextFrames().map(h => ({ tag: h.tag, source: h.source, collageMeta: h.collageMeta || null }));
        if (frames.length === 0) frames = [{ tag: State.current?.tag || 'sample_tag', source: 'user' }];
        return frames.map((h, index) => {
            const isLast = index === frames.length - 1;
            const data = {
                n: index + 1, total: frames.length,
                position: isLast ? 'CURRENT ACTIVE frame' : 'previous frame',
                tag: h.tag,
                source: h.source === 'model' ? 'set by you' : 'set by the director',
                ...buildCollagePromptData(h.tag),
            };
            let rendered;
            if (h.tag === '__SCENERY_COLLAGE__') {
                rendered = renderTemplate(CONTACT_SHEET_PROMPT_TEMPLATE, data);
            } else {
                rendered = renderTemplate(chosenTemplate, data);
                if (rendered === null && templateOverride) rendered = renderTemplate(DEFAULT_FRAME_TEMPLATE, data);
            }
            return rendered;
        }).join('\n\n---\n\n');
    }

    function blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    function convertWebPToBase64JPEG(base64WebP) {
        return new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/jpeg', 0.9));
            };
            img.onerror = () => resolve(base64WebP); // fallback if drawing/loading fails
            img.src = base64WebP;
        });
    }

    async function ensureBase64(h) {
        if (!h) return '';
        let base64Str = '';

        const isBlob = h.blob && (h.blob instanceof Blob || typeof h.blob.arrayBuffer === 'function');
        if (isBlob) {
            try {
                base64Str = await blobToBase64(h.blob);
            } catch (e) {
                console.error('[VP] failed to convert h.blob to base64:', e);
            }
        }

        if (!base64Str && h.base64 && h.base64.startsWith('data:image/')) {
            base64Str = h.base64;
        }

        if (!base64Str && h.url && h.url.startsWith('data:image/')) {
            base64Str = h.url;
        }

        if (!base64Str && h.url) {
            try {
                // IMPORTANT: Use originalFetch instead of global fetch to prevent infinite interceptor recursion loops!
                const fetchFn = State.originalFetch || window.fetch;
                const res = await fetchFn(h.url);
                const blob = await res.blob();
                base64Str = await blobToBase64(blob);
            } catch (e) {
                console.error('[VP] failed to fetch and convert url to base64:', h.url, e);
            }
        }

        if (!base64Str) {
            base64Str = h.base64 || h.url || '';
        }

        if (base64Str && base64Str.startsWith('data:image/webp;base64,')) {
            try {
                base64Str = await convertWebPToBase64JPEG(base64Str);
            } catch (e) {
                console.error('[VP] failed to convert WebP to JPEG:', e);
            }
        }

        return base64Str;
    }

    async function getContextMessages() {
        const frames = buildVisualContextFrames();
        if (frames.length === 0) return [];

        const template = State.config.prompts?.frameContext || DEFAULT_FRAME_TEMPLATE;
        return await Promise.all(frames.map(async (h, index) => {
            const isLast = index === frames.length - 1;
            const data = {
                n: index + 1, total: frames.length,
                position: isLast ? 'CURRENT ACTIVE frame' : 'previous frame',
                tag: h.tag,
                source: h.source === 'model' ? 'set by you' : 'set by the director',
                ...buildCollagePromptData(h.tag),
            };
            let rendered;
            if (h.tag === '__SCENERY_COLLAGE__') {
                rendered = renderTemplate(CONTACT_SHEET_PROMPT_TEMPLATE, data);
            } else {
                rendered = renderTemplate(template, data);
                if (rendered === null) rendered = renderTemplate(DEFAULT_FRAME_TEMPLATE, data);
            }
            const base64Str = await ensureBase64(h);
            return {
                role: 'user',
                content: [
                    { type: 'text', text: rendered },
                    { type: 'image_url', image_url: { url: base64Str } },
                ],
            };
        }));
    }

    // ════════════════════════════════════════════════════════════════
    //  PROMPT & REQUEST BUILDERS (Studio 2.0)
    //  Core logic for building manifests and injecting context.
    // ════════════════════════════════════════════════════════════════

    function captureApiContext(endpoint, headers, model = null) {
        State.api.endpoint = endpoint || null;
        State.api.headers = headers instanceof Headers ? Object.fromEntries(headers.entries())
            : typeof headers === 'object' && headers ? { ...headers } : headers;
        if (model) State.api.model = model;
    }

    async function injectProjectorRequestBody(parsedBody) {
        const body = JSON.parse(JSON.stringify(parsedBody || {}));
        if (!Array.isArray(body.messages)) body.messages = [];

        const manifest = buildManifest();
        const providerContext = buildPromptProviderContext();
        const additions = [providerContext, manifest].filter(Boolean).join('\n\n');
        const sysMsg = body.messages.find(m => m.role === 'system');

        if (sysMsg) {
            const originalSystem = typeof sysMsg.content === 'string'
                ? sysMsg.content
                : Array.isArray(sysMsg.content)
                    ? sysMsg.content.filter(part => part && part.type === 'text').map(part => part.text || '').join('\n')
                    : '';
            const cleanedSystem = stripInjectedManifest(originalSystem);
            sysMsg.content = additions ? [cleanedSystem, additions].filter(Boolean).join('\n\n') : cleanedSystem;
        } else if (additions) {
            body.messages.unshift({ role: 'system', content: additions });
        }

        body.messages = body.messages.filter(msg =>
            !(msg.role === 'system' && typeof msg.content === 'string' && msg.content.includes('[VISUAL PROJECTOR — Frame'))
        );

        for (let i = 0; i < body.messages.length - 1; i++) {
            const msg = body.messages[i];
            if (Array.isArray(msg.content)) {
                msg.content = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            }
        }

        const projectorMessages = await getContextMessages();
        if (projectorMessages.length > 0) {
            const lastUserIdx = body.messages.map(m => m.role).lastIndexOf('user');
            if (lastUserIdx !== -1) body.messages.splice(lastUserIdx, 0, ...projectorMessages);
        }

        return body;
    }

    async function fetchWithImageFallback(endpoint, headers, body, signal) {
        const fetchFn = State.originalFetch || window.fetch;
        let response = await fetchFn(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal,
        });

        if (response.status === 400) {
            console.warn('[VP] 400 from server — trying fallback without images');
            try {
                const errBody = await response.clone().json();
                const errMsg  = JSON.stringify(errBody).toLowerCase();
                if (errMsg.includes('image') || errMsg.includes('url') || errMsg.includes('base64')) {
                    const fallbackBody = JSON.parse(JSON.stringify(body));
                    for (const msg of fallbackBody.messages || []) {
                        if (Array.isArray(msg.content)) {
                            msg.content = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
                        } else if (typeof msg.content === 'string' && msg.content.includes('data:image/')) {
                            // Basic string search/replace for cases where image is embedded in text
                            // This is a safety measure.
                        }
                    }
                    console.warn('[VP] Fallback: sending text-only');
                    showToast('⚠️ Model rejected images — sending text-only', 'error');
                    response = await fetchFn(endpoint, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(fallbackBody),
                        signal,
                    });
                }
            } catch {}
        }
        return response;
    }

    function savePlaybackMessage(rawText, startFrameTag = null, role = 'assistant') {
        if (!rawText || !rawText.trim()) return;
        // Studio 2.0: Use showUserInPlayback instead of allowUserCommands for history registration
        const cleanCheck = (role === 'assistant' || role === 'system' || State.config.showUserInPlayback);
        if (!cleanCheck) return;
        const frameTag = startFrameTag !== null ? startFrameTag : (State.current?.tag || null);
        State.playback.messages.push({
            id: Date.now() + Math.random(), role, text: rawText,
            timestamp: Date.now(), frameTagAtStart: frameTag,
        });
        while (State.playback.messages.length > State.config.maxPlaybackMessages) State.playback.messages.shift();
        State.playback.cursor = -1;
        State.playback.mode = 'live';
        State.preparedTag = null;
        updatePlayerBar();
        persistProjectorState();
        console.log(`[VP Playback] Saved ${role} message #${State.playback.messages.length}`);
    }

    function fireEmojiTriggers(content) {
        if (!content || typeof FX === 'undefined' || !FX.enabled || !FX.emojiMap) return;
        for (const emoji of Object.keys(FX.emojiMap)) {
            const regex = new RegExp(`(^|[\\s.!?,;:])${escapeRegex(emoji)}(?=[\\s.!?,;:]|$)`, 'g');
            if (regex.test(content)) FX.fire(FX.emojiMap[emoji]);
        }
    }

    // ════════════════════════════════════════════════════════════════
    const Playback = {
        get totalSlots() { return State.playback.messages.length + (State.coverTag ? 1 : 0); },

        getCurrentMessage() {
            if (State.playback.cursor < 0) return null;
            if (State.coverTag && State.playback.cursor === 0) return null;
            const msgIdx = State.coverTag ? State.playback.cursor - 1 : State.playback.cursor;
            return State.playback.messages[msgIdx] || null;
        },

        // ── Playback API v2 (Studio 2.0) ──
        // Explicit turn management for streaming and tool calls.
        // Replaces implicit "fetch sniffing" logic.

        open(role, metadata = {}) {
            console.log(`[VP Playback] Turn opened: ${role}`);
            
            // If we are already in live mode, don't hard-reset (to allow user cues to persist)
            if (State.playback.mode !== 'live') {
                this.goLive();
            }
            
            State.playback.streaming = true;
            State.playback.activeRole = role;
            State.playback.activeStartFrame = metadata.startFrame || State.current?.tag || null;
            
            if (role === 'user' && metadata.text) {
                window.VisualProjector?.subtitles?.playLiveUserCue(metadata.text);
            }
        },

        push(delta) {
            if (!State.playback.streaming) return;
            // Fire FX triggers on the fly during streaming
            fireEmojiTriggers(delta);
            
            // Studio 2.0: If the delta is a technical thinking block, adjust role context
            const isThinking = delta.startsWith('... [Thinking');
            window.VisualProjector?.subtitles?.pushDelta(delta, isThinking ? 'system' : (State.playback.activeRole || 'assistant'));
        },

        commit(fullText, metadata = {}) {
            const role = metadata.role || State.playback.activeRole || 'assistant';

            if (State.playback.streaming) {
                window.VisualProjector?.subtitles?.flushStream();
            } else if (fullText && fullText.trim() && role === 'assistant') {
                window.VisualProjector?.subtitles?.play(fullText, role);
            }

            // Studio 2.0: We no longer call savePlaybackMessage here if a session manager is active.
            // History is managed via VP.playback.sync() from the session side.
            // We only save here if there's NO session history yet (fallback for legacy).
            if (State.playback.messages.length === 0 && fullText && fullText.trim()) {
                savePlaybackMessage(fullText, metadata.startFrame || State.playback.activeStartFrame, role);
            }

            State.playback.streaming = false;
            State.playback.activeRole = null;
            State.playback.activeStartFrame = null;
            console.log(`[VP Playback] Turn committed: ${role}`);
        },

        // Overwrite projector history with actual session messages
        sync(sessionMessages) {
            if (!Array.isArray(sessionMessages)) return;
            
            // Map session messages to projector playback format.
            const synced = sessionMessages
                .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
                .filter(m => (m.raw && m.raw.trim()) || (m.text && m.text.trim()))
                .map(m => {
                    let text = m.raw || m.text || '';
                    
                    // Studio 2.0: Artistic translation for technical Scene Events in subtitles
                    if (m.role === 'system' && text.includes('[SCENE EVENT:')) {
                        const typeMatch = text.match(/SCENE EVENT:\s*([^\]]+)/i);
                        const type = typeMatch ? typeMatch[1].replace(/_/g, ' ') : 'EVENT';
                        
                        // Try to find a summary or outcome line
                        const summaryMatch = text.match(/(?:Summary|Outcome|Replay summary):\s*(.*)/i);
                        const body = summaryMatch ? summaryMatch[1].trim() : type;
                        
                        // Clean up emoji/junk from start
                        const cleanBody = body.replace(/^[^\p{L}\p{N}"'(]+/u, '').trim();
                        text = `[ ${cleanBody} ]`;
                    }

                    return {
                        id: m.id || (Date.now() + Math.random()),
                        role: m.role,
                        text: text,
                        timestamp: m.createdAt || Date.now(),
                        frameTagAtStart: m.frameTagAtStart || null,
                        tool_calls: m.tool_calls || null,
                        tool_results: m.tool_results || null,
                    };
                })
                .slice(-State.config.maxPlaybackMessages);

            State.playback.messages = synced;
            // Only reset cursor if we are NOT in the middle of a replay
            if (State.playback.mode === 'live') {
                State.playback.cursor = -1;
            }
            updatePlayerBar();
            persistProjectorState();
            console.log(`[VP Playback] History synced. Total: ${synced.length}`);
        },

        abort() {
            window.VisualProjector?.subtitles?.stop();
            State.playback.streaming = false;
            State.playback.activeRole = null;
            State.playback.activeStartFrame = null;
            console.log(`[VP Playback] Turn aborted`);
        },

        goTo(index) {
            if (State.playback.messages.length === 0) return;
            index = Math.max(-1, Math.min(index, this.totalSlots - 1));
            if (State.playback.mode === 'playing') window.VisualProjector.subtitles.stop();
            State.playback.cursor = index;
            if (index === -1) {
                State.playback.mode = 'live'; window.VisualProjector.subtitles.stop();
            } else {
                State.playback.mode = 'paused'; window.VisualProjector.subtitles.stop();
                if (State.coverTag && index === 0) {
                    const coverAsset = State.gallery.get(State.coverTag);
                    if (coverAsset) {
                        setCurrent(coverAsset.tag, 'replay', true);
                        if (typeof FX !== 'undefined') { FX.clearMood?.(); FX.clearTransients?.(); }
                    }
                } else {
                    const msg = this.getCurrentMessage();
                    if (msg && msg.frameTagAtStart && State.gallery.has(msg.frameTagAtStart)) setCurrent(msg.frameTagAtStart, 'replay', true);
                }
            }
            updatePlayerBar();
        },

        play() {
            if (State.playback.messages.length === 0) return;
            if (State.playback.cursor === -1) State.playback.cursor = this.totalSlots - 1;
            window.VisualProjector.subtitles.stop();
            if (typeof FX !== 'undefined') { FX.clearMood(); FX.clearTransients?.(); }
            State.playback.mode = 'playing';
            updatePlayerBar();

            if (State.coverTag && State.playback.cursor === 0) {
                const coverAsset = State.gallery.get(State.coverTag);
                if (coverAsset) setCurrent(coverAsset.tag, 'replay', true);
                setTimeout(() => { if (State.playback.mode === 'playing') this.onPlaybackComplete(); }, 2500);
                return;
            }
            const msg = this.getCurrentMessage();
            if (!msg) { this.goLive(); return; }
            if (msg.frameTagAtStart && State.gallery.has(msg.frameTagAtStart)) setCurrent(msg.frameTagAtStart, 'replay', true);
            setTimeout(() => { if (State.playback.mode === 'playing') window.VisualProjector.subtitles.play(msg.text, msg.role || 'assistant'); }, 100);
        },

        pause() {
            if (State.playback.mode !== 'playing') return;
            window.VisualProjector.subtitles.stop();
            State.playback.mode = 'paused';
            updatePlayerBar();
        },

        goLive() {
            window.VisualProjector.subtitles.stop();
            State.playback.cursor = -1;
            State.playback.mode = 'live';
            updatePlayerBar();
        },

        onPlaybackComplete() {
            if (State.playback.mode !== 'playing') return;
            if (State.playback.cursor !== -1 && State.playback.cursor < this.totalSlots - 1) {
                const nextIndex = State.playback.cursor + 1;
                State.playback.cursor = nextIndex;
                updatePlayerBar();
                const nextMsg = this.getCurrentMessage();
                if (nextMsg && nextMsg.frameTagAtStart && State.gallery.has(nextMsg.frameTagAtStart)) setCurrent(nextMsg.frameTagAtStart, 'replay', true);
                setTimeout(() => { if (State.playback.mode === 'playing' && nextMsg) window.VisualProjector.subtitles.play(nextMsg.text, nextMsg.role || 'assistant'); }, 800);
                return;
            }
            this.goLive();
        },
    };

    // ════════════════════════════════════════════════════════════════
    //  PROJECTOR UI  (screen render + transitions + player bar)
    // ════════════════════════════════════════════════════════════════

    function updateProjectorUI() {
        const screen   = State.ui.screen;
        const tagLabel = State.ui.tagLabel;

        // Studio 2.0 Polish: Visual feedback for frame change
        if (State.current) {
            screen.style.transition = 'box-shadow 0.3s ease';
            screen.style.boxShadow = 'inset 0 0 40px rgba(108,95,166,0.2)';
            setTimeout(() => { screen.style.boxShadow = ''; }, 400);
        }

        // Frame label lives in the projector header now (saves vertical space).
        // Modes: 'title' — clean asset tag (immersive, default),
        //        'debug' — raw [IMG:tag] command form,
        //        'hidden' — no label at all.
        const labelMode = State.config.frameLabelMode || 'title';
        if (labelMode === 'hidden') {
            tagLabel.style.display = 'none';
        } else {
            tagLabel.style.display = '';
            if (State.current) {
                if (State.coverTag && State.current.tag === State.coverTag) {
                    tagLabel.textContent = State.coverLabel || 'cover';
                    tagLabel.style.color = '#f0b450';
                } else {
                    tagLabel.textContent = labelMode === 'debug' ? `[IMG:${State.current.tag}]` : State.current.tag;
                    tagLabel.style.color = '';
                }
            } else {
                tagLabel.textContent = '';
                tagLabel.style.color = '';
            }
        }
        updatePlayerBar();

        const dur = State.config.fadeDuration || 0;
        const durMs = dur * 1000;

        if (dur <= 0) {
            screen.querySelectorAll('img, .vp-screen-empty').forEach(el => el.remove());
            if (State.current) {
                const img = document.createElement('img');
                img.src = State.current.url || State.current.base64;
                img.alt = State.current.tag;
                img.style.setProperty('border-radius', 'var(--vp-asset-radius, 8px)', 'important');
                screen.appendChild(img);
                showCoverTitleOverlay();
            } else {
                maybeShowEmptyHint(screen);
            }
            return;
        }

        const existing = screen.querySelectorAll('img');
        const trType = State.currentTransition || 'crossfade';
        const empty = screen.querySelector('.vp-screen-empty');
        if (empty) empty.remove();

        existing.forEach(img => {
            if (img.dataset.outgoing) return;
            img.dataset.outgoing = 'true';
            img.style.position = 'absolute';
            img.style.inset = '0';
            img.style.margin = 'auto';
            img.style.setProperty('--vp-tr-dur', `${dur}s`);
            if (trType === 'fade') {
                img.style.transition = `opacity ${dur}s ease, filter ${dur}s ease`;
                img.style.opacity = '0';
                img.style.filter = 'blur(16px)';
            } else {
                img.className = '';
                img.classList.add(`vp-tr-${trType}-out`);
            }
            setTimeout(() => { if (img.parentNode) img.remove(); }, durMs + 50);
        });

        if (State.current) {
            const newImg = document.createElement('img');
            newImg.src = State.current.url || State.current.base64;
            newImg.alt = State.current.tag;
            newImg.style.setProperty('border-radius', 'var(--vp-asset-radius, 8px)', 'important');
            if (trType !== 'fade') { newImg.style.position = 'absolute'; newImg.style.inset = '0'; newImg.style.margin = 'auto'; }
            newImg.style.setProperty('--vp-tr-dur', `${dur}s`);
            screen.appendChild(newImg);
            showCoverTitleOverlay();
            if (trType === 'fade') {
                newImg.style.opacity = '0';
                newImg.style.filter = 'blur(16px)';
                newImg.style.transition = `opacity ${dur}s ease, filter ${dur}s ease`;
                setTimeout(() => { newImg.style.opacity = '1'; newImg.style.filter = 'blur(0)'; newImg.style.position = ''; }, durMs + 10);
            } else {
                newImg.classList.add(`vp-tr-${trType}-in`);
                setTimeout(() => {
                    if (newImg.parentNode) { newImg.classList.remove(`vp-tr-${trType}-in`); newImg.style.position = ''; newImg.style.inset = ''; newImg.style.margin = ''; }
                }, durMs + 50);
            }
        } else {
            setTimeout(() => { if (!State.current) maybeShowEmptyHint(screen); }, durMs + 10);
        }
    }

    function maybeShowEmptyHint(screen) {
        if (!screen) return;
        if (screen.querySelector('.vp-subtitle-overlay')) return;
        if (screen.querySelector('.vp-screen-empty')) return;
        screen.querySelectorAll('.vp-screen-empty').forEach(el => el.remove());
        const empty = document.createElement('div');
        empty.className = 'vp-screen-empty';
        empty.innerHTML = `Загрузите ассеты<br>через 📂 или 📎`;
        screen.appendChild(empty);
    }

    function showCoverTitleOverlay() {
        const screen = State.ui.screen;
        if (!screen) return;
        screen.querySelectorAll('.vp-cover-title').forEach(el => el.remove());
        if (!State.current || !State.coverTag || State.current.tag !== State.coverTag) return;
        if (State.playback.mode !== 'live' && State.playback.cursor !== 0) return;
        if (State.playback.mode === 'live' && State.playback.messages.length > 0) return;

        const title = document.createElement('div');
        title.className = 'vp-cover-title';
        title.textContent = State.coverLabel || 'cover';
        title.style.cssText = `
            position: absolute; top: 0px; left: 50%; transform: translateX(-50%);
            color: #ffcc33; font-size: 48px; font-weight: 800;
            padding: 0; border-radius: 0; letter-spacing: 2px; text-align: center;
            text-shadow: 0 2px 4px rgba(0,0,0,0.9), 0 0 3px rgba(0,0,0,0.7);
            pointer-events: none; z-index: 30;
            font-family: system-ui, -apple-system, sans-serif; white-space: nowrap;
            animation: vpCoverTitleFadeOut 6s ease-in-out forwards;
        `;
        if (!document.getElementById('vp-cover-title-style')) {
            const style = document.createElement('style');
            style.id = 'vp-cover-title-style';
            style.textContent = `
                @keyframes vpCoverTitleFadeOut {
                    0%   { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                    10%  { opacity: 1; transform: translateX(-50%) translateY(0); }
                    80%  { opacity: 1; transform: translateX(-50%) translateY(0); }
                    100% { opacity: 0; transform: translateX(-50%) translateY(-10px); }
                }
            `;
            document.head.appendChild(style);
        }
        screen.appendChild(title);
    }

    function updatePlayerBar() {
        const w = State.ui.vpWindow;
        if (!w) return;
        const info = w.querySelector('#vp-player-info');
        const first = w.querySelector('#vp-first');
        const prev  = w.querySelector('#vp-prev');
        const play  = w.querySelector('#vp-play');
        const next  = w.querySelector('#vp-next');
        const last  = w.querySelector('#vp-last');
        const fx    = w.querySelector('#vp-toggle-fx');
        if (!info || !play) return;

        const { mode, cursor, messages } = State.playback;
        const total = messages.length;
        const isPlaying = mode === 'playing';
        const isLive    = mode === 'live';
        const hasCover = !!State.coverTag;
        const slotTotal = total + (hasCover ? 1 : 0);
        const hasPrepared = !!State.preparedTag && (!State.coverTag || State.preparedTag !== State.coverTag);
        const canNavigate = !isPlaying && (total > 0 || hasCover || hasPrepared);

        info.classList.remove('is-live', 'is-playing', 'is-empty');

        if (hasCover && cursor === 0) {
            info.textContent = '★ COVER'; info.title = 'Cover frame (position 0)';
        } else if (total === 0) {
            if (hasCover && hasPrepared && cursor === 1) { info.textContent = 'PREPARED'; info.title = 'Prepared active picture'; }
            else { info.textContent = '∅'; info.title = 'No messages'; }
            info.classList.add('is-empty');
        } else if (isLive) {
            info.textContent = '● LIVE'; info.title = 'Live mode'; info.classList.add('is-live');
        } else {
            const msgIdx = hasCover ? cursor - 1 : cursor;
            const msg = messages[msgIdx];
            const roleIcon = msg?.role === 'user' ? '👤' : (msg?.role === 'system' ? '🎭' : '🤖');
            const safeIdx = Math.max(0, Math.min(total - 1, msgIdx));
            info.textContent = `${roleIcon} ${safeIdx + 1}/${total}`;
            info.title = `${isPlaying ? 'Playing' : 'Paused'} — message ${safeIdx + 1} of ${total}`;
            if (isPlaying) info.classList.add('is-playing');
        }

        if (isPlaying) { play.textContent = '⏸'; play.title = 'Pause'; play.classList.add('vp-btn-active'); play.classList.remove('vp-btn-ghost'); }
        else { play.textContent = '▶'; play.title = 'Play'; play.classList.remove('vp-btn-active'); play.classList.add('vp-btn-ghost'); }
        play.disabled = total === 0;

        if (total === 0) {
            first.disabled = !hasCover;
            prev.disabled = !(hasCover && cursor === 1);
            next.disabled = !(hasCover && hasPrepared && cursor === 0);
            last.disabled = true;
            play.disabled = true;
        } else {
            first.disabled = !canNavigate || cursor === 0;
            prev.disabled  = !canNavigate || (cursor !== -1 && cursor === 0);
            next.disabled  = !canNavigate || cursor === -1 || cursor >= slotTotal - 1;
            last.disabled  = !canNavigate || isLive || cursor >= slotTotal - 1;
        }

        if (State.config.effectsEnabled !== false) { fx.classList.add('vp-btn-active'); fx.classList.remove('vp-btn-ghost'); }
        else { fx.classList.remove('vp-btn-active'); fx.classList.add('vp-btn-ghost'); }

        const timeline  = w.querySelector('#vp-timeline');
        const tlMarker  = w.querySelector('#vp-timeline-marker');
        const tlProgress = w.querySelector('#vp-timeline-progress');
        if (timeline && tlMarker && tlProgress) {
            let pct = 0;
            if (slotTotal === 0) { pct = 0; tlProgress.style.opacity = '1'; }
            else if (isLive || cursor === -1) { pct = 1; tlProgress.style.opacity = '0.2'; }
            else {
                const denom = Math.max(1, slotTotal - 1);
                pct = slotTotal === 1 ? 0 : cursor / denom;
                pct = Math.max(0, Math.min(1, pct));
                tlProgress.style.opacity = '1';
            }
            tlMarker.style.left    = `${pct * 100}%`;
            tlProgress.style.width = `${pct * 100}%`;
            timeline.classList.toggle('is-live', isLive && total > 0);
            timeline.classList.toggle('is-disabled', slotTotal === 0);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  DRAG / RESIZE  (projector window)
    // ════════════════════════════════════════════════════════════════

    function setupDragAndResize(vpWindow, opts = {}) {
        const headerSel = opts.headerSel || '#vp-header';
        const handleSel = opts.handleSel || '#vp-resize-handle';
        const storageKey = opts.storageKey || 'vp-state';
        const header = vpWindow.querySelector(headerSel);
        const handle = vpWindow.querySelector(handleSel);

        header.addEventListener('mousedown', e => {
            if (vpWindow.classList.contains('vp-shell-docked')) return;
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const { rect, css } = getNormalizedElementPlacement(vpWindow);
            vpWindow.style.left = `${css.left}px`; vpWindow.style.top = `${css.top}px`; vpWindow.style.right = 'auto';
            State.drag = { isDragging: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, scaleX: css.scaleX, scaleY: css.scaleY };
            document.body.classList.add('vp-dragging');
        });
        handle.addEventListener('mousedown', e => {
            if (vpWindow.classList.contains('vp-shell-docked')) return;
            e.preventDefault(); e.stopPropagation();
            const { css } = getNormalizedElementPlacement(vpWindow);
            State.resize = { isResizing: true, startX: e.clientX, startY: e.clientY, startWidth: vpWindow.offsetWidth, startHeight: vpWindow.offsetHeight, scaleX: css.scaleX, scaleY: css.scaleY };
            document.body.classList.add('vp-resizing');
        });
        document.addEventListener('mousemove', e => {
            if (State.drag?.isDragging) {
                vpWindow.style.left = `${(e.clientX - State.drag.offsetX) / State.drag.scaleX}px`;
                vpWindow.style.top  = `${(e.clientY - State.drag.offsetY) / State.drag.scaleY}px`;
            }
            if (State.resize?.isResizing) {
                const deltaX = (e.clientX - State.resize.startX) / State.resize.scaleX;
                const deltaY = (e.clientY - State.resize.startY) / State.resize.scaleY;
                vpWindow.style.width  = `${Math.max(400, State.resize.startWidth  + deltaX)}px`;
                vpWindow.style.height = `${Math.max(340, State.resize.startHeight + deltaY)}px`;
            }
        });
        document.addEventListener('mouseup', () => {
            if (State.drag?.isDragging) { State.drag.isDragging = false; document.body.classList.remove('vp-dragging'); saveWindowState(vpWindow, storageKey); }
            if (State.resize?.isResizing) { State.resize.isResizing = false; document.body.classList.remove('vp-resizing'); saveWindowState(vpWindow, storageKey); }
        });
    }

    function saveWindowState(vpWindow, storageKey) {
        const key = storageKey || 'vp-state';
        const { css } = getNormalizedElementPlacement(vpWindow);
        const geom = { left: css.left, top: css.top, width: vpWindow.offsetWidth, height: vpWindow.offsetHeight };
        const db = window.VP_DB;
        if (db?.setWinGeom) db.setWinGeom(geom).catch(() => {});
        else {
            try { localStorage.setItem(key, JSON.stringify(geom)); } catch {}
        }
    }

    function loadWindowState(vpWindow, storageKey) {
        const key = storageKey || 'vp-state';
        const applyGeom = (s) => {
            if (!s) return;
            vpWindow.style.left = `${s.left}px`; vpWindow.style.top = `${s.top}px`;
            vpWindow.style.right = 'auto'; vpWindow.style.width = `${s.width}px`;
            if (s.height) vpWindow.style.height = `${s.height}px`;
        };

        const db = window.VP_DB;
        if (db?.getWinGeom) {
            db.getWinGeom().then((s) => {
                if (s) applyGeom(s);
                else {
                    try { applyGeom(JSON.parse(localStorage.getItem(key) || 'null')); } catch {}
                }
            }).catch(() => {
                try { applyGeom(JSON.parse(localStorage.getItem(key) || 'null')); } catch {}
            });
            return;
        }

        try { applyGeom(JSON.parse(localStorage.getItem(key) || 'null')); } catch {}
    }

    // ════════════════════════════════════════════════════════════════
    //  CONFIRM / PROMPT PREVIEW DIALOGS
    // ════════════════════════════════════════════════════════════════

    function showConfirm({ title, message, buttons }) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10003; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
            const modal = document.createElement('div');
            modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 10px; padding: 20px 24px; max-width: 380px; box-shadow: 0 12px 48px rgba(0,0,0,0.7);`;
            const titleEl = document.createElement('div');
            titleEl.style.cssText = `color: var(--text-primary, #cdd6f4); font-size: 15px; font-weight: 600; margin-bottom: 8px;`;
            titleEl.textContent = title;
            const msgEl = document.createElement('div');
            msgEl.style.cssText = `color: var(--text-secondary, #8888aa); font-size: 13px; line-height: 1.5; margin-bottom: 16px;`;
            msgEl.textContent = message;
            const btnsEl = document.createElement('div');
            btnsEl.style.cssText = `display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;`;
            let done = false;
            let onKey = null;
            const finish = (id) => {
                if (done) return;
                done = true;
                if (onKey) document.removeEventListener('keydown', onKey);
                backdrop.style.animation = 'vpFadeOut 0.15s ease forwards';
                setTimeout(() => { backdrop.remove(); resolve(id); }, 150);
            };
            buttons.forEach(btn => {
                const b = document.createElement('button');
                b.textContent = btn.label;
                b.className = `vp-btn ${btn.ghost ? 'vp-btn-ghost' : ''} ${btn.danger ? 'vp-btn-danger' : ''}`;
                b.style.cssText = `padding: 6px 12px; height: 28px; font-size: 12px;`;
                b.addEventListener('click', () => finish(btn.id));
                btnsEl.appendChild(b);
            });
            modal.appendChild(titleEl); modal.appendChild(msgEl); modal.appendChild(btnsEl);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish('cancel'); });
            onKey = e => { if (e.key === 'Escape') finish('cancel'); };
            document.addEventListener('keydown', onKey);
        });
    }

    function showPrompt(options = {}) {
        const {
            title = 'Input',
            message = '',
            value = '',
            placeholder = '',
            confirmLabel = 'OK',
            cancelLabel = 'Cancel',
            multiline = false,
            required = false,
            trim = true,
            maxLength = 0,
        } = options || {};

        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.56); z-index: 10004; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
            const modal = document.createElement('div');
            modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 12px; padding: 18px 20px; max-width: 520px; width: min(92vw, 520px); box-shadow: 0 12px 48px rgba(0,0,0,0.72); display:flex; flex-direction:column; gap:10px;`;

            const titleEl = document.createElement('div');
            titleEl.style.cssText = `color: var(--text-primary, #cdd6f4); font-size: 15px; font-weight: 700;`;
            titleEl.textContent = title;
            modal.appendChild(titleEl);

            if (message) {
                const msgEl = document.createElement('div');
                msgEl.style.cssText = `color: var(--text-secondary, #a6adc8); font-size: 12px; line-height: 1.45; white-space: pre-wrap;`;
                msgEl.textContent = message;
                modal.appendChild(msgEl);
            }

            const input = document.createElement(multiline ? 'textarea' : 'input');
            if (!multiline) input.type = 'text';
            input.value = String(value ?? '');
            input.placeholder = placeholder || '';
            if (maxLength > 0) input.maxLength = maxLength;
            input.style.cssText = `width:100%; ${multiline ? 'min-height:110px; resize:vertical;' : 'height:32px;'} background: var(--bg-tertiary, #252540); color: var(--text-primary, #cdd6f4); border:1px solid rgba(255,255,255,.14); border-radius:7px; padding:7px 9px; font: 12px ${multiline ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : 'system-ui, sans-serif'}; outline:none; box-sizing:border-box;`;
            input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent,#6c5fa6)'; });
            input.addEventListener('blur', () => { input.style.borderColor = 'rgba(255,255,255,.14)'; });
            modal.appendChild(input);

            const hintEl = document.createElement('div');
            hintEl.style.cssText = `min-height:14px; color: var(--error,#e05555); font-size: 11px;`;
            modal.appendChild(hintEl);

            const btnsEl = document.createElement('div');
            btnsEl.style.cssText = `display:flex; justify-content:flex-end; gap:8px; margin-top:2px;`;
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'vp-btn vp-btn-ghost';
            cancelBtn.textContent = cancelLabel;
            const okBtn = document.createElement('button');
            okBtn.className = 'vp-btn';
            okBtn.textContent = confirmLabel;
            btnsEl.appendChild(cancelBtn);
            btnsEl.appendChild(okBtn);
            modal.appendChild(btnsEl);

            let done = false;
            let onKey = null;
            const finish = (result) => {
                if (done) return;
                done = true;
                if (onKey) document.removeEventListener('keydown', onKey);
                backdrop.style.animation = 'vpFadeOut 0.15s ease forwards';
                setTimeout(() => { backdrop.remove(); resolve(result); }, 150);
            };
            const submit = () => {
                const raw = String(input.value ?? '');
                const result = trim ? raw.trim() : raw;
                if (required && !result) {
                    hintEl.textContent = 'Value is required.';
                    input.focus();
                    return;
                }
                finish(result);
            };

            cancelBtn.addEventListener('click', () => finish(null));
            okBtn.addEventListener('click', submit);
            backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(null); });
            onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
                if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
            };
            document.addEventListener('keydown', onKey);

            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            setTimeout(() => { input.focus(); if (!multiline) input.select(); }, 0);
        });
    }

    function showPromptPreview(title, content) {
        const backdrop = document.createElement('div');
        backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 10003; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
        const modal = document.createElement('div');
        modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 10px; padding: 16px 20px; max-width: 600px; max-height: 70vh; width: 90%; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 12px 48px rgba(0,0,0,0.7);`;
        modal.innerHTML = `
            <div style="color: var(--text-primary, #cdd6f4); font-size: 13px; font-weight: 600;">${title}</div>
            <pre style="background: var(--bg-tertiary, #252540); border: 1px solid var(--border, #383860); border-radius: 4px; padding: 10px; font-family: 'Consolas','Monaco',monospace; font-size: 11px; line-height: 1.4; color: var(--text-primary, #cdd6f4); overflow: auto; max-height: 50vh; margin: 0; white-space: pre-wrap; word-wrap: break-word;"></pre>
            <div style="display: flex; justify-content: flex-end;"><button class="vp-btn" id="vp-preview-close">Close</button></div>`;
        modal.querySelector('pre').textContent = content;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        const close = () => { backdrop.style.animation = 'vpFadeOut 0.15s ease forwards'; setTimeout(() => backdrop.remove(), 150); };
        modal.querySelector('#vp-preview-close').addEventListener('click', close);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); } });
    }

    // ════════════════════════════════════════════════════════════════
    //  UTILS  (toast + escapeRegex)
    // ════════════════════════════════════════════════════════════════

    const activeToasts = [];
    function repositionToasts() { activeToasts.forEach((t, i) => { t.style.bottom = `${20 + i * 44}px`; }); }

    function showToast(message, type = 'info') {
        const colors = { info: 'var(--accent, #6c5fa6)', success: 'var(--success, #4caf7d)', error: 'var(--error, #e05555)' };
        const toast = document.createElement('div');
        toast.className = 'vp-toast';
        toast.style.background = colors[type] || colors.info;
        toast.textContent = message;
        document.body.appendChild(toast);
        activeToasts.push(toast);
        repositionToasts();
        setTimeout(() => {
            toast.style.animation = 'vpFadeOut 0.25s ease forwards';
            setTimeout(() => {
                toast.remove();
                const idx = activeToasts.indexOf(toast);
                if (idx !== -1) activeToasts.splice(idx, 1);
                repositionToasts();
            }, 250);
        }, 2500);
    }

    function escapeRegex(str) { return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    function getSubtitleSpeed() {
        const n = Number(State.config?.subtitleSpeed);
        return Number.isFinite(n) ? Math.max(0.5, Math.min(2.0, n)) : 1.0;
    }

    function syncPlaybackSpeedUI() {
        const speed = getSubtitleSpeed();
        State.config.subtitleSpeed = speed;
        const root = State.ui?.vpWindow || document;
        const speedSlider = root.querySelector?.('#vp-speed-slider');
        const speedLabel  = root.querySelector?.('#vp-speed-label');
        if (speedSlider) speedSlider.value = speed.toFixed(1);
        if (speedLabel)  speedLabel.textContent = `${speed.toFixed(1)}x`;
    }

    // ════════════════════════════════════════════════════════════════
    //  CONFIG PERSISTENCE  (storage layer first, localStorage fallback)
    // ════════════════════════════════════════════════════════════════

    async function loadConfig() {
        let saved = null;
        const db = window.VP_DB;
        if (db?.getConfig) {
            try { saved = await db.getConfig(); }
            catch (e) { console.warn('[VP] Не удалось загрузить конфиг из storage:', e); }
        }
        if (!saved) {
            try { saved = JSON.parse(localStorage.getItem('vp-config-v3') || 'null'); }
            catch (e) { console.warn('[VP] Не удалось загрузить конфиг из localStorage:', e); }
        }
        if (saved) {
            State.config = { ...State.config, ...saved };
            if (!State.config.prompts) State.config.prompts = { manifest: null, frameContext: null };
        }
    }

    /** Apply asset (image on projector screen) corner radius from config.
     *  Sets a CSS variable + inline style on current imgs, so it wins over
     *  stale cached stylesheets and injected theme styles. */
    function applyAssetCornerRadius(px) {
        let v = Number(px);
        if (!Number.isFinite(v)) v = Number(State.config.assetCornerRadius ?? State.config.screenCornerRadius);
        if (!Number.isFinite(v)) v = 8;
        v = Math.max(0, Math.min(32, Math.round(v)));
        State.config.assetCornerRadius = v;
        try { document.documentElement.style.setProperty('--vp-asset-radius', v + 'px'); } catch (e) {}
        const screen = State.ui?.screen || document.getElementById('vp-screen');
        if (screen) screen.querySelectorAll('img').forEach(img => img.style.setProperty('border-radius', v + 'px', 'important'));
        return v;
    }

	function saveConfig() {
		const db = window.VP_DB;
		if (db?.setConfig) {
			db.setConfig(State.config).catch(err => console.warn('[VP] IDB config save failed:', err));
		}
		// Always mirror to localStorage as a safety net
		try { 
			localStorage.setItem('vp-config-v3', JSON.stringify(State.config)); 
		} catch (err) {
			console.warn('[VP] localStorage config save failed:', err);
		}
	}

    /**
     * Persist config. Prefer the shared storage layer via the gallery module
     * when present; otherwise fall back to the core storage helper.
     */
    function schedulePersist() {
        const g = window.VisualProjector?.gallery;
        if (g && typeof g.persistConfig === 'function') { g.persistConfig(); return; }
        saveConfig();
    }

    // ════════════════════════════════════════════════════════════════
    //  CREATE UI  (projector window ONLY — gallery panel is built by
    //  projector-gallery.js via window.VisualProjector.gallery)
    // ════════════════════════════════════════════════════════════════

    function createUI() {
        // Auto-load external CSS (visual-projector.css next to the script).
        (function () {
            if (document.querySelector('link[href*="visual-projector.css"]')) return;
            const script = document.currentScript || document.querySelector('script[src*="visual-projector.js"]');
            if (!script) return;
            const base = script.src.substring(0, script.src.lastIndexOf('/') + 1);
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = base + 'visual-projector.css';
            document.head.appendChild(link);
        })();

        const vpWindow = document.createElement('div');
        vpWindow.id = 'visual-projector';
        vpWindow.innerHTML = `
            <!-- Шапка -->
            <div class="vp-header" id="vp-header">
                <span class="vp-title">👁 Visual Projector</span>
                <span class="vp-tag-label" id="vp-tag-label" title="Текущий кадр"></span>
                <div class="vp-header-btns">
                    <button class="vp-btn vp-btn-ghost" id="vp-toggle-gallery"  title="Галерея">📚</button>
                    <button class="vp-btn vp-btn-ghost" id="vp-toggle-settings" title="Настройки">⚙️</button>
                    <button class="vp-btn vp-btn-ghost" id="vp-minimize"        title="Свернуть">−</button>
                </div>
            </div>

            <!-- РЕЖИМ: ПРОЕКТОР -->
            <div id="vp-projector-mode">
                <div class="vp-screen" id="vp-screen">
                    <div class="vp-screen-actions" id="vp-screen-actions">
                        <button class="vp-btn vp-btn-ghost" id="vp-paste-clipboard" title="Вставить из буфера">📋</button>
                        <button class="vp-btn vp-btn-ghost vp-clear-btn" id="vp-clear-current"   title="Очистить экран">✕</button>
                    </div>
                </div>

                <div class="vp-player-bar" id="vp-player-bar">
                    <div class="vp-player-status" id="vp-player-info" title="Status">— live —</div>
                    <div class="vp-player-spacer"></div>
                    <div class="vp-player-controls">
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-first" title="To first message">⏮</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-prev"  title="Previous message">«</button>
                        <button class="vp-btn vp-btn-ghost"           id="vp-play"  title="Play">▶</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-next"  title="Next message">»</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-last"  title="To last / live">⏭</button>
                    </div>
                    <div class="vp-player-spacer"></div>
                    <div class="vp-player-speed" title="Playback speed">
                        <input name="subtitleSpeed" type="range" id="vp-speed-slider" min="0.5" max="2.0" step="0.1" value="1.0">
                        <span id="vp-speed-label">1.0x</span>
                    </div>
                    <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-toggle-fx" title="Toggle visual effects">FX</button>
                </div>

                <div class="vp-timeline" id="vp-timeline" title="Click or drag to navigate" style="margin-bottom: 6px;">
                    <div class="vp-timeline-track">
                        <div class="vp-timeline-progress" id="vp-timeline-progress"></div>
                        <div class="vp-timeline-marker" id="vp-timeline-marker"></div>
                    </div>
                </div>
            </div>

            <div class="vp-resize-handle" id="vp-resize-handle"></div>
        `;
        document.body.appendChild(vpWindow);

        // Adaptive squeeze: as the projector window narrows, progressively
        // hide secondary player-bar elements instead of letting them overlap
        // the centered transport controls or overflow the window edge.
        try {
            const ro = new ResizeObserver(entries => {
                const w = entries[0]?.contentRect?.width || vpWindow.offsetWidth;
                vpWindow.classList.toggle('vp-narrow', w < 340);
                vpWindow.classList.toggle('vp-tiny', w < 250);
            });
            ro.observe(vpWindow);
        } catch (e) { /* ResizeObserver unavailable — keep static layout */ }

        // Cache projector element refs (gallery-owned refs are set by the gallery).
        State.ui.vpWindow  = vpWindow;
        State.ui.screen    = vpWindow.querySelector('#vp-screen');
        State.ui.tagLabel  = vpWindow.querySelector('#vp-tag-label');
        State.ui.playerBar = vpWindow.querySelector('#vp-player-bar');
        State.ui.galleryBtn = vpWindow.querySelector('#vp-toggle-gallery');

        setupUIEvents(vpWindow);
        setupDragAndResize(vpWindow);
        loadWindowState(vpWindow);
    }

    /** Drag-and-drop images / .js FX packs onto the projector window. */
    function setupDragAndDrop(vpWindow) {
        let dragCounter = 0;
        const showOverlay = () => {
            if (vpWindow.querySelector('#vp-drop-overlay')) return;
            const overlay = document.createElement('div');
            overlay.id = 'vp-drop-overlay';
            overlay.style.cssText = `position:absolute; inset:0; background:rgba(108,95,166,0.85); display:flex; align-items:center; justify-content:center; color:white; font-size:16px; font-weight:600; border:3px dashed rgba(255,255,255,0.6); border-radius:10px; z-index:200; pointer-events:none; font-family:system-ui,sans-serif;`;
            overlay.innerHTML = `📥 Drop image(s) here`;
            vpWindow.appendChild(overlay);
        };
        const hideOverlay = () => { vpWindow.querySelector('#vp-drop-overlay')?.remove(); };

        vpWindow.addEventListener('dragenter', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault(); dragCounter++; showOverlay();
        });
        vpWindow.addEventListener('dragover', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
        });
        vpWindow.addEventListener('dragleave', (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            dragCounter--; if (dragCounter <= 0) { dragCounter = 0; hideOverlay(); }
        });
        vpWindow.addEventListener('drop', async (e) => {
            if (!e.dataTransfer?.types.includes('Files')) return;
            e.preventDefault(); dragCounter = 0; hideOverlay();
            const allFiles = Array.from(e.dataTransfer.files);

            // 1. .js FX pack?
            const jsFile = allFiles.find(f => f.name.endsWith('.js'));
            if (jsFile) {
                const reader = new FileReader();
                reader.onload = (ev) => {
                    try {
                        const code = ev.target.result;
                        if (window.FX) window.FX._loadingPackName = jsFile.name;
                        const script = document.createElement('script');
                        script.textContent = `(function(){ ${code} })();`;
                        document.head.appendChild(script);
                        if (window.FX) window.FX._loadingPackName = null;
                        const customPacks = JSON.parse(localStorage.getItem('vp-fx-packs') || '{}');
                        customPacks[jsFile.name] = code;
                        localStorage.setItem('vp-fx-packs', JSON.stringify(customPacks));
                        showToast(`Успешно загружен FX Pack: ${jsFile.name}`, 'success');
                        if (State.ui.panelOpen && State.galleryData.activeTabId === 'effects') {
                            window.VisualProjector?.gallery?.renderGalleryGrid?.();
                        }
                    } catch (err) { showToast(`Ошибка загрузки FX: ${err.message}`, 'error'); }
                };
                reader.readAsText(jsFile);
                return;
            }

            // 2. Images → route to gallery's addImageFromBlob.
            const files = allFiles.filter(f => f.type.startsWith('image/'));
            const G = window.VisualProjector?.gallery;
            if (!G || typeof G.addImageFromBlob !== 'function') {
                showToast('Gallery module not loaded', 'error'); return;
            }
            if (files.length === 0) { showToast('Поддерживаются только изображения и .js файлы', 'error'); return; }
            if (files.length === 1) {
                const tag = await G.addImageFromBlob(files[0], { source: 'user', suggestedName: files[0].name, setAsCurrent: true });
                if (tag) showToast(`📥 Dropped "${tag}"`, 'success');
            } else {
                let lastTag = null;
                for (const file of files) lastTag = await G.addImageFromBlob(file, { source: 'user', suggestedName: file.name, setAsCurrent: false });
                if (lastTag) setCurrent(lastTag);
                showToast(`📥 Added ${files.length} images`, 'success');
                await G.maybeOfferAutoTag?.();
            }
        });
    }

    /** Wire projector-window buttons (gallery-domain buttons route via facade). */
    function setupUIEvents(vpWindow) {
        const $ = id => vpWindow.querySelector(id);

        // Gallery / Settings toggles → gallery module.
        $('#vp-toggle-gallery').addEventListener('click', () => window.VisualProjector?.gallery?.toggleMode?.());
        $('#vp-toggle-settings').addEventListener('click', () => window.VisualProjector?.gallery?.toggleSettings?.());

        // Header Quick Actions
        $('#vp-paste-clipboard').addEventListener('click', () => window.VisualProjector?.gallery?.pasteFromClipboard?.());
        $('#vp-clear-current').addEventListener('click', () => { clearCurrent(); showToast('Экран очищен', 'info'); });

        setupDragAndDrop(vpWindow);

        // === Player bar ===
        $('#vp-first').addEventListener('click', () => {
            if (State.playback.messages.length === 0) {
                if (State.coverTag) {
                    const cover = State.gallery.get(State.coverTag);
                    if (cover) { State.playback.cursor = 0; setCurrent(cover.tag, 'replay', true); }
                }
                return;
            }
            Playback.goTo(0);
        });
        $('#vp-prev').addEventListener('click', () => {
            const { cursor, messages } = State.playback;
            if (messages.length === 0) {
                if (cursor === 1 && State.coverTag) {
                    const cover = State.gallery.get(State.coverTag);
                    if (cover) { setCurrent(cover.tag, 'replay', true); State.playback.cursor = 0; updatePlayerBar(); }
                }
                return;
            }
            if (cursor === -1) Playback.goTo(messages.length - 1);
            else if (cursor > 0) Playback.goTo(cursor - 1);
        });
        $('#vp-play').addEventListener('click', () => {
            if (State.playback.mode === 'playing') Playback.pause(); else Playback.play();
        });
        $('#vp-next').addEventListener('click', () => {
            const { cursor, messages } = State.playback;
            if (messages.length === 0) {
                if (cursor === 0 && State.coverTag) {
                    if (State.preparedTag) {
                        const prep = State.gallery.get(State.preparedTag);
                        if (prep) { setCurrent(prep.tag, 'replay', true); State.playback.cursor = 1; }
                    }
                    return;
                }
                return;
            }
            if (cursor === -1) return;
            if (cursor === 0 && State.coverTag) {
                State.playback.cursor = 1;
                const firstMsg = messages[0];
                if (firstMsg && firstMsg.frameTagAtStart && State.gallery.has(firstMsg.frameTagAtStart)) setCurrent(firstMsg.frameTagAtStart, 'replay', true);
                else updatePlayerBar();
                return;
            }
            const maxMsgCursor = messages.length - 1 + (State.coverTag ? 1 : 0);
            if (cursor >= maxMsgCursor) Playback.goLive();
            else Playback.goTo(cursor + 1);
        });
        $('#vp-last').addEventListener('click', () => Playback.goLive());

        $('#vp-toggle-fx').addEventListener('click', () => {
            State.config.effectsEnabled = !State.config.effectsEnabled;
            updatePlayerBar();
            if (!State.config.effectsEnabled && typeof FX !== 'undefined' && FX.clearMood) FX.clearMood();
            schedulePersist();
        });

        // === Timeline (scrub / click) ===
        const timeline = $('#vp-timeline');
        if (timeline) {
            const track = timeline.querySelector('.vp-timeline-track');
            let isDragging = false;
            const getPercent = (e) => { const rect = track.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)); };
            const jumpToPercent = (pct) => {
                const total = State.playback.messages.length + (State.coverTag ? 1 : 0);
                if (total === 0) return;
                Playback.goTo(Math.round(pct * (total - 1)));
            };
            timeline.addEventListener('mousedown', (e) => {
                if (State.playback.messages.length === 0) return;
                e.preventDefault(); isDragging = true; timeline.classList.add('is-dragging');
                if (State.playback.mode === 'playing') Playback.pause();
                jumpToPercent(getPercent(e));
            });
            document.addEventListener('mousemove', (e) => { if (isDragging) jumpToPercent(getPercent(e)); });
            document.addEventListener('mouseup', () => { if (!isDragging) return; isDragging = false; timeline.classList.remove('is-dragging'); });
        }

        // === Speed slider ===
        const speedSlider = $('#vp-speed-slider');
        const speedLabel  = $('#vp-speed-label');
        if (speedSlider) {
            syncPlaybackSpeedUI();
            speedSlider.addEventListener('input', e => {
                const val = Math.max(0.5, Math.min(2.0, parseFloat(e.target.value) || 1.0));
                State.config.subtitleSpeed = val;
                if (speedLabel) speedLabel.textContent = `${val.toFixed(1)}x`;
                saveConfig();
            });
            speedSlider.addEventListener('dblclick', () => {
                State.config.subtitleSpeed = 1.0;
                syncPlaybackSpeedUI();
                saveConfig();
            });
        }

        // Minimize / restore
        State.ui.projectorCollapsed = false;
        State.ui.projectorSavedHeight = null;
        $('#vp-minimize').addEventListener('click', () => {
            State.ui.projectorCollapsed = !State.ui.projectorCollapsed;
            const projMode = vpWindow.querySelector('#vp-projector-mode');
            if (State.ui.projectorCollapsed) {
                State.ui.projectorSavedHeight = vpWindow.style.height || `${vpWindow.offsetHeight}px`;
                projMode.style.display = 'none'; vpWindow.classList.add('vp-collapsed');
                vpWindow.style.height = 'auto'; vpWindow.style.overflow = 'hidden';
            } else {
                projMode.style.display = ''; vpWindow.classList.remove('vp-collapsed');
                const isDocked = vpWindow.classList.contains('vp-shell-docked-stage');
                if (isDocked) {
                    vpWindow.style.height = '100%';
                } else {
                    const saved = State.ui.projectorSavedHeight;
                    vpWindow.style.height = (saved && saved !== '100%' && saved !== 'auto') ? saved : '430px';
                }
                vpWindow.style.overflow = '';
            }
            $('#vp-minimize').textContent = State.ui.projectorCollapsed ? '+' : '−';
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  BOOT  +  PUBLIC FACADE
    // ════════════════════════════════════════════════════════════════

    function loadCustomFXPacks() {
        try {
            const customPacks = JSON.parse(localStorage.getItem('vp-fx-packs') || '{}');
            for (const [name, code] of Object.entries(customPacks)) {
                try {
                    if (window.FX) window.FX._loadingPackName = name;
                    const script = document.createElement('script');
                    script.textContent = `(function(){ ${code} })();`;
                    document.head.appendChild(script);
                    if (window.FX) window.FX._loadingPackName = null;
                    console.log(`[VP] Loaded custom FX Pack: ${name}`);
                } catch (e) { if (window.FX) window.FX._loadingPackName = null; }
            }
        } catch (e) {}
    }

    async function init() {
        if (_coreInitDone) return coreReady;
        if (_coreInitStarted) return coreReady;
        _coreInitStarted = true;
        try {
            console.log('[VP] Visual Projector v4.0 (Studio 2.0 Foundation) — initializing...');
            loadCustomFXPacks();
            createUI();
            await loadConfig();
            applyAssetCornerRadius();
            syncPlaybackSpeedUI();
            updateProjectorUI();
            // Studio 2.0: Network interceptor removed. 
            // The frontend now controls playback explicitly.
            _coreInitDone = true;
            _resolveCoreReady?.(window.VisualProjector);
            console.log('[VP] Ready. Gallery module will attach via window.VisualProjector.gallery.');
        } catch (err) {
            console.error('[VP] Core init failed:', err);
            _rejectCoreReady?.(err);
            throw err;
        }
        return coreReady;
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init().catch(() => {}); });
    else init().catch(() => {});

    // ── Public facade (captured by projector-gallery.js at load) ──
    window.VisualProjector = {
        state: State,
        ready: coreReady,
        init,
        // projector core
        setCurrent, clearCurrent,
        updateProjectorUI, updatePlayerBar, syncPlaybackSpeedUI,
        applyAssetCornerRadius,
        getProjectorSnapshot: buildProjectorSnapshot,
        applyProjectorSnapshot, persistProjectorState,
        // manifest / context
        buildManifest, buildFrameContextPreview, getContextMessages,
        // robust command parser / tag utilities
        tags: VPTags,
        commands: VPCommandBus,
        tools: null, // populated by vp-tools.js after load
        // persistence hook (routes to gallery IDB when present)
        schedulePersist,
        // shared UI helpers (gallery calls these via VP.*)
        showToast, showConfirm, showPrompt, showPromptPreview,
        updatePromptHints, updateTemplateStatus,
        insertAtCursor, escapeAttr, escapeRegex,
        sanitizeTag: (typeof sanitizeTag !== 'undefined') ? sanitizeTag : undefined,
        blobToBase64,
        // geometry helpers (gallery prefers these)
        getElementScale, viewportPointToCssSpace, viewportRectToCssSpace,
        getNormalizedElementPlacement,
        // template constants
        DEFAULT_MANIFEST_TEMPLATE, DEFAULT_FRAME_TEMPLATE,
        // lightweight module registries
        registerPanel, unregisterPanel, getPanels, getPanel,
        registerPromptProvider, unregisterPromptProvider, getPromptProviders, buildPromptProviderContext,
        // Studio 2.0: Unified request logic
        utils: {
            injectProjectorRequestBody,
            fetchWithImageFallback,
            captureApiContext,
        },
        // legacy compat (will be removed)
        chat: {
            sendRequest: async (opts) => {
                const body = await injectProjectorRequestBody(opts.body);
                const response = await fetchWithImageFallback(opts.endpoint, opts.headers, body, opts.signal);
                return { response, preparedBody: body, requestId: Date.now() };
            },
        },
        // engines
        get FX() { return window.FX; },
        _subtitle: null, // populated by vp-subtitles.js after load
        _maybeShowEmptyHint: maybeShowEmptyHint,
        playback: Playback,
        _playback: Playback, // legacy alias
        // gallery attaches itself here on load:
        gallery: null,
    };

})();
