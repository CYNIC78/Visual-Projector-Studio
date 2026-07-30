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
// ║    fx-core.js → visual-projector.js → projector-focus.js →  ║\n// ║    projector-gallery.js                                    ║
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

        projectorViewport: {
            enabled: false,
            aspect: '4:3',
            x: 0.5,
            y: 0,
            step: 0.5,
            zoom: 1,
            focusZoom: 1.5,
            zoomStep: 0.10,
            dirty: false,
            touchedAt: null,
            updatedAt: null,
        },

		 projectorDepth: {
			 enabled: true,
			 strength: 0.09,
			 zoomBoost: 0.05,
			 zoomCurve: 1.2,
			 status: 'idle',
			 activeTag: null,
			 depthFile: null,
			 error: null,
		 pivot: 1.0,
		 strengthMultiplier: 1.0,
		 // vignette removed in v14 (owner call: flat screen effects belong
		 // to the FX engine; renderer uniform stays dormant/unfed)
		 dofStrength: 0.0,
			 aberration: 0.0,
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
            gazeAutoReaction: true,
            gazeHoldDuration: 6,
            gazeCooldown:     50,
            // v15 Gaze Attention Layer flags
            gazeLabelsInContext: true,   // pin region/x/y/zoom/dwell label onto the gaze crop message
            gazeManifestState:   false,  // also append an explicit [GAZE STATE] block to the scene manifest
            gazeDeckChip:        true,   // live attention chip under the screen (deck, above the player bar)
            // v18 Gallery View pill flag
            collagePill:         true,   // 🖼️ deck pill with the contact-sheet state + click-popup
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
            focusModeDefault:  false,   // v10: enable Focus Mode camera at boot ("focus as the main mode")
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
        _TYPE_PATTERN: 'IMG|SET|PLAY|FRAME|IMAGE|FX|CAT|TAB|ACTIVITY_REQUEST|ACTIVITY_CHALLENGE|ACTIVITY_START|ACTIVITY_AUTO|ACTIVITY_ACCEPT|ACTIVITY_DECLINE|FOCUS',
        _IMAGE_TYPES: new Set(['IMG', 'SET', 'PLAY', 'FRAME', 'IMAGE']),
        _ACTIVITY_TYPES: new Set(['ACTIVITY_REQUEST', 'ACTIVITY_CHALLENGE', 'ACTIVITY_START', 'ACTIVITY_AUTO', 'ACTIVITY_ACCEPT', 'ACTIVITY_DECLINE']),
        _ACTION_ALIASES: {
            open: 'open', opened: 'open', expand: 'open', show: 'open', reveal: 'open', load: 'open',
            открыть: 'open', открой: 'open', открыть_папку: 'open', развернуть: 'open', разверни: 'open', показать: 'open', покажи: 'open',
            // v17: 'close' is the canonical verb; 'collapse' stays a forever-alias
            // so old chats, prompts and hardcoded strings keep working.
            close: 'close', closed: 'close', collapse: 'close', collapsed: 'close', fold: 'close', hide: 'close', unload: 'close',
            свернуть: 'close', сверни: 'close', закрыть: 'close', закрой: 'close', скрыть: 'close', спрячь: 'close',
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
            // v17: grammar is exactly 4 verbs — open/close × TAB/CAT.
            // 'collapse' never reaches this point: _ACTION_ALIASES maps it to 'close'.
            if (!name || (action !== 'open' && action !== 'close')) return null;
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
    //  DIRECTOR COMMAND BUS v1 — SATELLITE BRIDGE → js/director-bus.js
    //
    //  The registry, built-in handlers (IMG / FOCUS / FX / CAT / TAB +
    //  activity-game passthrough), FOCUS_PRESETS and the rolling command
    //  log now live in js/director-bus.js (v06 extraction — byte-verbatim
    //  bodies). That satellite loads BEFORE this file (see index.html
    //  script order); deps below are function declarations, i.e. hoisted,
    //  so passing them from this point is safe. The facade contract is
    //  unchanged: VP.commands === the bus created here.
    // ════════════════════════════════════════════════════════════════
    if (!window.VP_DIRECTOR_BUS || typeof window.VP_DIRECTOR_BUS.createCommandBus !== 'function') {
        throw new Error(
            '[VP] js/director-bus.js is missing or loaded out of order.\n' +
            'Script order must be: js/director-bus.js BEFORE js/visual-projector.js (see index.html).'
        );
    }
    const VPCommandBus = window.VP_DIRECTOR_BUS.createCommandBus({
        State, VPTags, setCurrent, showToast,
        getProjectorViewportState, ensureViewportGlideLoopActive, updateProjectorDepthLayer,
    });

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
        // v23: the deck collage pill reads its state lazily (only on events).
        // Snapshot applies — boot restore AND chat switches — carry no event,
        // so without this nudge a persisted collage cover stayed pill-less
        // after F5 (owner micro-bug report).
        window.VP_COLLAGE_PILL?.refresh?.();
        return true;
    }

    // ════════════════════════════════════════════════════════════════
    //  PROJECTOR  (active frame + history)
    // ════════════════════════════════════════════════════════════════
    function getCurrentDescriptor() {
        const asset = State.current || null;
        return asset ? {
            tag: asset.tag,
            filename: asset.filename || null,
            path: asset.path || null,
            source: asset.source || null,
            tabId: asset.tabId || null,
            hidden: !!asset.hidden,
        } : null;
    }

    function getProjectorPublicState() {
        return {
            current: getCurrentDescriptor(),
            currentTag: State.current?.tag || null,
            coverTag: State.coverTag || null,
            preparedTag: State.preparedTag || null,
            history: Array.isArray(State.history)
                ? State.history.map(frame => ({
                    tag: frame.tag || null,
                    filename: frame.filename || null,
                    source: frame.source || null,
                    timestamp: frame.timestamp || null,
                }))
                : [],
            playback: {
                mode: State.playback?.mode || 'live',
                cursor: State.playback?.cursor ?? -1,
                messageCount: Array.isArray(State.playback?.messages) ? State.playback.messages.length : 0,
            },
            viewport: getProjectorViewportState(),
            depth: getProjectorDepthState(),
        };
    }

    function emitProjectorCurrentChanged(previousTag, source, reason = 'set-current') {
        try {
            window.VP_HUB?.emit?.('projector:current-changed', {
                previousTag: previousTag || null,
                currentTag: State.current?.tag || null,
                current: getCurrentDescriptor(),
                source: source || null,
                reason,
            }, { moduleId: 'projector' });
        } catch (err) {
            console.warn('[VP Projector] hub emit projector:current-changed failed:', err);
        }
    }

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

        const previousTag = State.current?.tag || null;
        State.current = asset;

        // Clear active gliding targets (owned by the focus satellite)
        window.VP_FOCUS?.clearGlideTargets();

        // Auto-load / apply viewport settings for the active asset, or reset to default
        if (asset.focusViewport) {
            setProjectorViewport({
                enabled: getProjectorViewportState().enabled,
                x: asset.focusViewport.x,
                y: asset.focusViewport.y,
                zoom: asset.focusViewport.zoom,
                dirty: true,
                silent: true,
            }, 'asset-loaded-viewport');
        } else {
            const d = getDefaultProjectorViewport();
            setProjectorViewport({
                enabled: getProjectorViewportState().enabled,
                x: d.x,
                y: d.y,
                zoom: 1,
                dirty: false,
                silent: true,
            }, 'asset-loaded-default-viewport');
        }

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
        emitProjectorCurrentChanged(previousTag, source, 'set-current');
        console.log(`[VP] Текущий кадр: "${tag}" (source: ${source})`);
        return true;
    }

    function clearCurrent(source = 'user') {
        const previousTag = State.current?.tag || null;
        State.current = null;
        State.history = State.history.filter(h => h.source !== 'user');
        if (State.playback.messages.length === 0) State.preparedTag = null;
        updateProjectorUI();
        persistProjectorState();
        const db = window.VP_DB;
        if (db?.setCurrentTag) db.setCurrentTag(null).catch(() => {});
        window.VisualProjector?.gallery?.refreshGalleryPanelUI?.();
        if (previousTag) emitProjectorCurrentChanged(previousTag, source, 'clear-current');
    }

    // ════════════════════════════════════════════════════════════════
    //  TEMPLATE (manifest + frame context) — SATELLITE BRIDGE → js/vp-templates.js
    //
    //  The whole template domain (DEFAULT_*_TEMPLATE, renderTemplate,
    //  TEMPLATE_VARS, buildManifest, buildCollagePromptData,
    //  buildVisualContextFrames, buildFrameContextPreview, the settings-UI
    //  prompt helpers, isAssetReady) now lives in js/vp-templates.js
    //  (v07 extraction — byte-verbatim bodies). The satellite loads right
    //  AFTER this file (see index.html) and registers window.VP_TEMPLATES.
    //  Same mirror as the focus bridge: names below are delegates, so all
    //  internal call-sites and the facade keep working; if the satellite
    //  is missing they degrade to safe empties (and the boot smoke fails
    //  loudly — check the console / smoke-templates).
    // ════════════════════════════════════════════════════════════════
    function renderTemplate(...a) { return window.VP_TEMPLATES?.renderTemplate(...a) ?? null; }
    function buildManifest(...a) { return window.VP_TEMPLATES?.buildManifest(...a) ?? ''; }
    function buildVisualContextFrames(...a) { return window.VP_TEMPLATES?.buildVisualContextFrames(...a) ?? []; }
    function buildCollageRulesNote(...a) { return window.VP_TEMPLATES?.buildCollageRulesNote?.(...a) ?? ''; } // v27
    function buildFrameContextPreview(...a) { return window.VP_TEMPLATES?.buildFrameContextPreview(...a) ?? ''; }
    function updatePromptHints(...a) { return window.VP_TEMPLATES?.updatePromptHints(...a); }
    function updateTemplateStatus(...a) { return window.VP_TEMPLATES?.updateTemplateStatus(...a); }
    function insertAtCursor(...a) { return window.VP_TEMPLATES?.insertAtCursor(...a); }
    function escapeAttr(...a) { return window.VP_TEMPLATES?.escapeAttr ? window.VP_TEMPLATES.escapeAttr(...a) : String(a[0] ?? ''); }
    function getDefaultManifestTemplate() { return window.VP_TEMPLATES?.DEFAULT_MANIFEST_TEMPLATE || ''; }
    function getDefaultFrameTemplate() { return window.VP_TEMPLATES?.DEFAULT_FRAME_TEMPLATE || ''; }

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

    function loadImageForCanvas(src) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error('Failed to load image for Focus Mode crop'));
            img.src = src;
        });
    }

    async function getCurrentAssetImageSource() {
        const asset = State.current;
        if (!asset) return { src: '', revoke: null };
        if (asset.url || asset.base64) return { src: asset.url || asset.base64, revoke: null };
        if (asset.blob) {
            const url = URL.createObjectURL(asset.blob);
            return { src: url, revoke: () => { try { URL.revokeObjectURL(url); } catch {} } };
        }
        return { src: '', revoke: null };
    }

    function captureDepthCanvasDataUrl(viewport) {
        const screen = State.ui.screen;
        const depthCanvas = screen?.querySelector?.('.vp-depth-canvas');
        if (!screen?.classList?.contains('vp-depth-active') || !depthCanvas || !depthCanvas.width || !depthCanvas.height) return null;
        try {
            const outW = 768;
            const outH = 576;
            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) return null;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, outW, outH);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(depthCanvas, 0, 0, outW, outH);
            const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
            if (!dataUrl || dataUrl.length < 64) return null;
            return {
                dataUrl,
                width: outW,
                height: outH,
                sourceTag: State.current?.tag || null,
                viewport,
                renderedDepth: true,
            };
        } catch (err) {
            console.warn('[VP Focus Mode] Depth canvas capture failed:', err);
            return null;
        }
    }

    async function captureFocusViewportDataUrl() {
        const viewport = getProjectorViewportState();
        if (!viewport.enabled || !viewport.dirty || !State.current) return null;

        // Prefer the actual Projector screen when the depth renderer is active.
        // This captures the same 2.5D WebGL result the user sees, not just the
        // flat source asset crop. If depth is unavailable, fall back to source crop.
        try {
            if (State.current?.depthMap?.status === 'ready') {
                await updateProjectorDepthLayer();
                const rendered = captureDepthCanvasDataUrl(viewport);
                if (rendered) return rendered;
            }
        } catch (err) {
            console.warn('[VP Focus Mode] Falling back to flat focus crop after depth capture failure:', err);
        }

        const { src, revoke } = await getCurrentAssetImageSource();
        if (!src) return null;
        try {
            const img = await loadImageForCanvas(src);
            const outW = 768;
            const outH = 576;
            const srcW = img.naturalWidth || img.width;
            const srcH = img.naturalHeight || img.height;
            if (!srcW || !srcH) return null;

            const scale = Math.max(outW / srcW, outH / srcH) * (viewport.zoom || 1);
            const viewW = Math.min(srcW, outW / scale);
            const viewH = Math.min(srcH, outH / scale);
            const sx = Math.max(0, Math.min(srcW - viewW, (srcW - viewW) * viewport.x));
            const sy = Math.max(0, Math.min(srcH - viewH, (srcH - viewH) * viewport.y));

            const canvas = document.createElement('canvas');
            canvas.width = outW;
            canvas.height = outH;
            const ctx = canvas.getContext('2d', { alpha: false });
            if (!ctx) return null;
            ctx.fillStyle = '#000';
            ctx.fillRect(0, 0, outW, outH);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, sx, sy, viewW, viewH, 0, 0, outW, outH);
            return {
                dataUrl: canvas.toDataURL('image/jpeg', 0.9),
                width: outW,
                height: outH,
                sourceTag: State.current.tag,
                viewport,
                renderedDepth: false,
            };
        } catch (err) {
            console.warn('[VP Focus Mode] Failed to capture focused crop:', err);
            return null;
        } finally {
            if (revoke) revoke();
        }
    }

    async function buildFocusContextMessage() {
        const focus = await captureFocusViewportDataUrl();
        if (!focus?.dataUrl) return null;
        const tag = focus.sourceTag || State.current?.tag || 'current frame';
        let text = `This focused crop of the active scene shows exactly where the camera/user's gaze is resting right now on your current frame [${tag}]. Respond dynamically to what is visible in this frame.`;
        // v15 Gaze Attention Layer: pin *computable* coordinates onto the gaze
        // crop (region/x/y/zoom/dwell) so the model can react to attention CHANGES,
        // not just to the crop's pixels. Flag-controlled (default on).
        if (State.config?.gazeLabelsInContext !== false) {
            const g = window.VP_FOCUS?.getGazeState?.();
            if (g && g.enabled) {
                const dwellMs = window.VP_FOCUS?.getGazeDwell?.() || 0;
                const dwellSec = Math.round(dwellMs / 1000);
                const dwellTxt = dwellSec >= 4 ? ` — held here for ${dwellSec}s` : '';
                text += ` Gaze pin: region "${g.region}" (x=${g.x.toFixed(2)}, y=${g.y.toFixed(2)}), zoom ${g.zoom.toFixed(2)}x${g.anchor ? `, anchor "${g.anchor}"` : ''}${dwellTxt}. If the user is clearly staring at a detail, acknowledge it.`;
            }
        }
        return {
            role: 'user',
            content: [
                { type: 'text', text },
                { type: 'image_url', image_url: { url: focus.dataUrl } },
            ],
            // Add a marker so we can identify this as a replacement for the full frame
            __focusData: focus
        };
    }

    async function getContextMessages() {
        const frames = buildVisualContextFrames();
        if (frames.length === 0) return [];

        const focusMessage = await buildFocusContextMessage();
        
        const template = State.config.prompts?.frameContext || getDefaultFrameTemplate(); // DEFAULT_FRAME_TEMPLATE lives in vp-templates.js (v07)
        const contextMessages = await Promise.all(frames.map(async (h, index) => {
            const base64Str = await ensureBase64(h);

            if (h.tag === '__SCENERY_COLLAGE__') {
                // v27: active-state law rides as the collage's text companion —
                // scene rules of the displayed tabs travel WITH the scene image
                // in this high-attention zone (docs/tab-fsm-design.md §8).
                const rulesNote = buildCollageRulesNote(State.galleryData);
                return {
                    role: 'user',
                    content: [
                        ...(rulesNote ? [{ type: 'text', text: rulesNote }] : []),
                        { type: 'image_url', image_url: { url: base64Str }, __isCollageMarker: true },
                    ],
                };
            }

            const isLast = index === frames.length - 1;
            
            // SIMMETRY & PROACTIVITY: 
            // We append the focus message AFTER the full frame, rather than replacing it!
            // This gives the model the macro-context (the whole room/character) PLUS 
            // the micro-context (what the user is currently staring at). 
            // This allows the model to see the big picture and decide to pan the camera elsewhere!

            const data = {
                n: index + 1, total: frames.length,
                position: isLast ? 'CURRENT ACTIVE frame' : 'previous frame',
                tag: h.tag,
                source: h.source === 'model' ? 'set by you' : 'set by the director',
            };
            let rendered = renderTemplate(template, data);
            if (rendered === null) rendered = renderTemplate(getDefaultFrameTemplate(), data);
            
            return {
                role: 'user',
                content: [
                    { type: 'text', text: rendered },
                    { type: 'image_url', image_url: { url: base64Str } },
                ],
            };
        }));

        if (focusMessage) {
            delete focusMessage.__focusData; // clean up internal marker
            contextMessages.push(focusMessage);
        }

        return contextMessages;
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
            // Split out the collage message (if any)
            const collageMsgIndex = projectorMessages.findIndex(m => 
                Array.isArray(m.content) && m.content.some(c => c.image_url && c.__isCollageMarker)
            );
            
            let collageMsg = null;
            if (collageMsgIndex !== -1) {
                collageMsg = projectorMessages.splice(collageMsgIndex, 1)[0];
                // Clean up the marker
                collageMsg.content.forEach(c => delete c.__isCollageMarker);
            }

            // Insert frames right before the last user message
            const lastUserIdx = body.messages.map(m => m.role).lastIndexOf('user');
            if (lastUserIdx !== -1 && projectorMessages.length > 0) {
                body.messages.splice(lastUserIdx, 0, ...projectorMessages);
            }

            // If we have a collage, insert it right after the system prompt (high-attention zone)
            if (collageMsg) {
                const sysIdx = body.messages.findIndex(m => m.role === 'system');
                body.messages.splice(sysIdx !== -1 ? sysIdx + 1 : 0, 0, collageMsg);
            }
        }

        return body;
    }

    const _contextPreparedBodies = new Map();

    function describeContextMessage(message) {
        if (!message) return null;
        const content = message.content;
        let text = '';
        let imageCount = 0;
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part?.type === 'text') text += (text ? '\n' : '') + String(part.text || '');
                if (part?.type === 'image_url') imageCount += 1;
            }
        } else {
            text = String(content || '');
        }
        return {
            role: message.role || null,
            textPreview: text.slice(0, 360),
            textLength: text.length,
            imageCount,
            hasImages: imageCount > 0,
        };
    }

    function summarizeRequestBodyForContext(body) {
        const messages = Array.isArray(body?.messages) ? body.messages : [];
        let imageCount = 0;
        let textPartCount = 0;
        for (const msg of messages) {
            if (Array.isArray(msg.content)) {
                for (const part of msg.content) {
                    if (part?.type === 'image_url') imageCount += 1;
                    if (part?.type === 'text') textPartCount += 1;
                }
            } else if (typeof msg.content === 'string') {
                textPartCount += 1;
            }
        }
        return {
            messageCount: messages.length,
            imageCount,
            textPartCount,
            hasVision: imageCount > 0,
            roles: messages.map(m => m.role || 'unknown'),
            model: body?.model || null,
            stream: body?.stream ?? null,
            maxTokens: body?.max_tokens ?? body?.maxTokens ?? null,
        };
    }

    function getContextPublicState() {
        const frames = buildVisualContextFrames();
        const manifest = buildManifest();
        return {
            frameCount: frames.length,
            frames: frames.map(frame => ({
                tag: frame.tag || null,
                filename: frame.filename || null,
                source: frame.source || null,
                hasBlob: !!frame.blob,
                hasUrl: !!frame.url,
                hasThumb: !!frame.thumbUrl,
                isCollage: frame.tag === '__SCENERY_COLLAGE__',
                collageAssetCount: Number(frame.collageMeta?.assetsCount || 0) || null,
            })),
            manifestLength: manifest.length,
            hasManifest: !!manifest.trim(),
            currentTag: State.current?.tag || null,
            coverTag: State.coverTag || null,
            preparedTag: State.preparedTag || null,
            focusMode: getProjectorViewportState(),
            pendingPreparedBodies: _contextPreparedBodies.size,
        };
    }

    async function getContextMessageDescriptors() {
        const messages = await getContextMessages();
        return messages.map(describeContextMessage).filter(Boolean);
    }

    async function prepareContextRequestBody(parsedBody, opts = {}) {
        const body = await injectProjectorRequestBody(parsedBody || {});
        const ticket = `ctx_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        const ttlMs = Math.max(1000, Math.min(120000, Number(opts.ttlMs) || 30000));
        const record = {
            ticket,
            body,
            summary: summarizeRequestBodyForContext(body),
            createdAt: Date.now(),
            expiresAt: Date.now() + ttlMs,
        };
        _contextPreparedBodies.set(ticket, record);
        setTimeout(() => {
            const current = _contextPreparedBodies.get(ticket);
            if (current && current.expiresAt <= Date.now()) _contextPreparedBodies.delete(ticket);
        }, ttlMs + 250);
        return { ticket, summary: record.summary, expiresAt: record.expiresAt };
    }

    function consumePreparedContextBody(ticket, { keep = false } = {}) {
        const id = String(ticket || '').trim();
        const record = _contextPreparedBodies.get(id);
        if (!record) return null;
        if (record.expiresAt <= Date.now()) {
            _contextPreparedBodies.delete(id);
            return null;
        }
        const body = record.body;
        if (!keep) _contextPreparedBodies.delete(id);
        return body;
    }

    function releasePreparedContextBody(ticket) {
        return _contextPreparedBodies.delete(String(ticket || '').trim());
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

    function getPlaybackPublicState() {
        return {
            mode: State.playback?.mode || 'live',
            cursor: State.playback?.cursor ?? -1,
            streaming: !!State.playback?.streaming,
            activeRole: State.playback?.activeRole || null,
            activeStartFrame: State.playback?.activeStartFrame || null,
            messageCount: Array.isArray(State.playback?.messages) ? State.playback.messages.length : 0,
            totalSlots: (State.playback?.messages?.length || 0) + (State.coverTag ? 1 : 0),
            coverTag: State.coverTag || null,
            currentMessage: (() => {
                if (State.playback.cursor < 0) return null;
                if (State.coverTag && State.playback.cursor === 0) return null;
                const msgIdx = State.coverTag ? State.playback.cursor - 1 : State.playback.cursor;
                const msg = State.playback.messages[msgIdx] || null;
                return msg ? {
                    id: msg.id || null,
                    role: msg.role || null,
                    textPreview: String(msg.text || '').slice(0, 260),
                    textLength: String(msg.text || '').length,
                    timestamp: msg.timestamp || null,
                    frameTagAtStart: msg.frameTagAtStart || null,
                } : null;
            })(),
        };
    }

    function emitPlaybackEvent(eventName, payload = {}) {
        try {
            window.VP_HUB?.emit?.(eventName, {
                ...payload,
                state: getPlaybackPublicState(),
            }, { moduleId: 'projector' });
        } catch (err) {
            console.warn(`[VP Playback] hub emit ${eventName} failed:`, err);
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
            emitPlaybackEvent('playback:opened', {
                role,
                textLength: String(metadata.text || '').length,
                startFrame: State.playback.activeStartFrame || null,
            });
        },

        push(delta) {
            if (!State.playback.streaming) return;
            // Fire FX triggers on the fly during streaming
            fireEmojiTriggers(delta);
            
            // Studio 2.0: If the delta is a technical thinking block, adjust role context
            const isThinking = delta.startsWith('... [Thinking');
            window.VisualProjector?.subtitles?.pushDelta(delta, isThinking ? 'system' : (State.playback.activeRole || 'assistant'));
            emitPlaybackEvent('playback:pushed', {
                role: isThinking ? 'system' : (State.playback.activeRole || 'assistant'),
                deltaPreview: String(delta || '').slice(0, 180),
                deltaLength: String(delta || '').length,
                thinking: !!isThinking,
            });
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
            emitPlaybackEvent('playback:committed', {
                role,
                textPreview: String(fullText || '').slice(0, 260),
                textLength: String(fullText || '').length,
                startFrame: metadata.startFrame || null,
            });
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
            emitPlaybackEvent('playback:synced', { messageCount: synced.length });
            console.log(`[VP Playback] History synced. Total: ${synced.length}`);
        },

        abort() {
            window.VisualProjector?.subtitles?.stop();
            State.playback.streaming = false;
            State.playback.activeRole = null;
            State.playback.activeStartFrame = null;
            emitPlaybackEvent('playback:aborted', {});
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
            emitPlaybackEvent('playback:cursor-changed', { cursor: State.playback.cursor, mode: State.playback.mode });
        },

        play() {
            if (State.playback.messages.length === 0) return;
            if (State.playback.cursor === -1) State.playback.cursor = this.totalSlots - 1;
            window.VisualProjector.subtitles.stop();
            if (typeof FX !== 'undefined') { FX.clearMood(); FX.clearTransients?.(); }
            State.playback.mode = 'playing';
            updatePlayerBar();
            emitPlaybackEvent('playback:started', { cursor: State.playback.cursor });

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
            emitPlaybackEvent('playback:paused', { cursor: State.playback.cursor });
        },

        goLive() {
            window.VisualProjector.subtitles.stop();
            State.playback.cursor = -1;
            State.playback.mode = 'live';
            updatePlayerBar();
            emitPlaybackEvent('playback:live', {});
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
    //  FOCUS DOMAIN — SATELLITE BRIDGE (js/projector-focus.js)
    //  Focus mode (camera viewport), the WebGL depth layer + focal
    //  lock and the on-screen focus controls were extracted to
    //  js/projector-focus.js, loaded AFTER this file (the VP facade is
    //  assembled at EOF) and registering window.VP_FOCUS.
    //  Delegates below forward by name, keeping every internal
    //  call-site and the facade untouched; before the satellite
    //  registers they degrade to safe no-ops/defaults.
    // ════════════════════════════════════════════════════════════════

    function getDefaultProjectorViewport() {
        return window.VP_FOCUS?.getDefaultProjectorViewport() || { x: 0.5, y: 0 };
    }
    function getProjectorViewportState() {
        return window.VP_FOCUS?.getProjectorViewportState() || {
            enabled: false, aspect: '4:3', x: 0.5, y: 0,
            step: 0.5, zoom: 1, focusZoom: 1.5, zoomStep: 0.10,
            dirty: false, touchedAt: null, updatedAt: null,
            currentTag: State?.current?.tag || null,
        };
    }
    function getProjectorDepthState() {
        return window.VP_FOCUS?.getProjectorDepthState() || {
            enabled: true, strength: 0.045, zoomBoost: 0.035, zoomCurve: 1.2,
            effectiveStrength: 0, status: 'idle',
            activeTag: null, depthFile: null, error: null,
            webglAvailable: !!window.VPDepthRenderer,
        };
    }
    function applyProjectorViewportUI(...a) { return window.VP_FOCUS?.applyProjectorViewportUI(...a); }
    function setProjectorViewport(...a) { return window.VP_FOCUS?.setProjectorViewport(...a); }
    function panProjectorViewport(...a) { return window.VP_FOCUS?.panProjectorViewport(...a); }
    function resetProjectorViewport(...a) { return window.VP_FOCUS?.resetProjectorViewport(...a); }
    function setProjectorViewportMode(...a) { return window.VP_FOCUS?.setProjectorViewportMode(...a); }
    function setProjectorViewportZoom(...a) { return window.VP_FOCUS?.setProjectorViewportZoom(...a); }
    function toggleProjectorViewportZoom(...a) { return window.VP_FOCUS?.toggleProjectorViewportZoom(...a); }
    function setProjectorDepthMode(...a) { return window.VP_FOCUS?.setProjectorDepthMode(...a); }
    function setProjectorDepthStrength(...a) { return window.VP_FOCUS?.setProjectorDepthStrength(...a); }
    function setProjectorDepthZoomBoost(...a) { return window.VP_FOCUS?.setProjectorDepthZoomBoost(...a); }
    function updateProjectorDepthLayer(...a) { return window.VP_FOCUS?.updateProjectorDepthLayer(...a); }
    function ensureFocusControls(...a) { return window.VP_FOCUS?.ensureFocusControls(...a); }
    function ensureViewportGlideLoopActive(...a) { return window.VP_FOCUS?.ensureViewportGlideLoopActive(...a); }


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
                img.draggable = false;
                img.style.setProperty('border-radius', 'var(--vp-asset-radius, 8px)', 'important');
                screen.appendChild(img);
                applyProjectorViewportUI();
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
            newImg.draggable = false;
            newImg.style.setProperty('border-radius', 'var(--vp-asset-radius, 8px)', 'important');
            if (trType !== 'fade') { newImg.style.position = 'absolute'; newImg.style.inset = '0'; newImg.style.margin = 'auto'; }
            newImg.style.setProperty('--vp-tr-dur', `${dur}s`);
            screen.appendChild(newImg);
            applyProjectorViewportUI();
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
        const focus = w.querySelector('#vp-toggle-focus');
        const focusZoom = w.querySelector('#vp-toggle-focus-zoom');
        const autogaze = w.querySelector('#vp-toggle-autogaze');
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

        if (focus) {
            const vp = getProjectorViewportState();
            focus.classList.toggle('vp-btn-active', !!vp.enabled);
            focus.classList.toggle('vp-btn-ghost', !vp.enabled);
            focus.textContent = vp.enabled ? 'FOCUS' : 'focus';
            focus.title = vp.enabled
                ? `Focus Mode ON · x=${vp.x.toFixed(2)}, y=${vp.y.toFixed(2)}, zoom=${vp.zoom.toFixed(2)}x`
                : 'Focus Mode: 4:3 gaze crop';
        }
        if (focusZoom) {
            const vp = getProjectorViewportState();
            const active = vp.enabled && vp.zoom > 1.001;
            focusZoom.disabled = !vp.enabled;
            focusZoom.classList.toggle('vp-btn-active', active);
            focusZoom.classList.toggle('vp-btn-ghost', !active);
            focusZoom.textContent = active ? `${vp.zoom.toFixed(1)}×` : '1×';
            focusZoom.title = vp.enabled ? 'Toggle Focus Zoom' : 'Enable Focus Mode first';
        }
        if (autogaze) {
            const active = State.config.gazeAutoReaction !== false;
            autogaze.classList.toggle('vp-btn-active', active);
            autogaze.classList.toggle('vp-btn-ghost', !active);
            autogaze.title = active ? 'Auto-Gaze Reaction is ON (model reacts silently when staring)' : 'Auto-Gaze Reaction is OFF';
        }

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

    // ═══════════════════════════════════════════════════════════════
    //  DRAG / RESIZE (projector window) — SATELLITE BRIDGE → js/vp-window-drag.js
    //
    //  setupDragAndResize + win-geometry persistence now live in
    //  js/vp-window-drag.js (v09 extraction — byte-verbatim bodies).
    //  Drag state (State.drag / State.resize) remains on shared State.
    //  Delegates no-op safely if the satellite is missing.
    // ═══════════════════════════════════════════════════════════════
    function setupDragAndResize(...a) { return window.VP_WINDOW_DRAG?.setupDragAndResize(...a); }
    function saveWindowState(...a) { return window.VP_WINDOW_DRAG?.saveWindowState(...a); }
    function loadWindowState(...a) { return window.VP_WINDOW_DRAG?.loadWindowState ? window.VP_WINDOW_DRAG.loadWindowState(...a) : Promise.resolve(); }

    // ════════════════════════════════════════════════════════════════
    //  CONFIRM / PROMPT PREVIEW DIALOGS — SATELLITE BRIDGE → js/vp-dialogs.js
    //
    //  The three shared modal primitives now live in js/vp-dialogs.js
    //  (v08 extraction — byte-verbatim bodies; that module is fully
    //  self-contained DOM building, zero engine deps). Delegates below
    //  keep the facade entry points identical for every studio module;
    //  if the satellite is missing they resolve to safe cancels.
    // ════════════════════════════════════════════════════════════════
    function showConfirm(...a) { return window.VP_DIALOGS?.showConfirm ? window.VP_DIALOGS.showConfirm(...a) : Promise.resolve('cancel'); }
    function showPrompt(...a) { return window.VP_DIALOGS?.showPrompt ? window.VP_DIALOGS.showPrompt(...a) : Promise.resolve(null); }
    function showPromptPreview(...a) { return window.VP_DIALOGS?.showPromptPreview ? window.VP_DIALOGS.showPromptPreview(...a) : undefined; }

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
        // Native storage restores window geometry asynchronously. Hide the shell
        // until the first geometry read completes to avoid a cold-start jump.
        vpWindow.style.visibility = 'hidden';
        vpWindow.innerHTML = `
            <!-- Шапка -->
            <div class="vp-header" id="vp-header">
                <button class="vp-btn vp-btn-ghost vp-btn-sm vp-focus-toggle" id="vp-toggle-focus" title="Focus Mode: 4:3 gaze crop">FOCUS</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm vp-focus-zoom-toggle" id="vp-toggle-focus-zoom" title="Focus Zoom 1.5x">1.5×</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-toggle-autogaze" title="Auto-Gaze Reaction: Toggle model auto-responses when staring">👀 GAZE</button>
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
        ensureFocusControls();

        // Keep Focus Mode's 4:3 crop honest across ANY resize of the screen's
        // own box — panel splitter drags, shell dock/undock, window resize,
        // OS DPI changes, etc. — not just the events we happen to already
        // hook (drag/click on the image). Re-applying object-position/scale
        // here is cheap and idempotent, so this is a safety net rather than
        // the primary fix for any one specific resize path.
        try {
            const screenRo = new ResizeObserver(() => {
                if (getProjectorViewportState().enabled) applyProjectorViewportUI();
            });
            screenRo.observe(State.ui.screen);
        } catch (e) { /* ResizeObserver unavailable — keep static layout */ }
        State.ui.tagLabel  = vpWindow.querySelector('#vp-tag-label');
        State.ui.playerBar = vpWindow.querySelector('#vp-player-bar');
        State.ui.galleryBtn = vpWindow.querySelector('#vp-toggle-gallery');

        setupUIEvents(vpWindow);
        setupDragAndResize(vpWindow);
        Promise.resolve(loadWindowState(vpWindow)).finally(() => {
            vpWindow.style.visibility = '';
        });
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

        $('#vp-toggle-focus')?.addEventListener('click', () => {
            const current = getProjectorViewportState();
            setProjectorViewportMode({ enabled: !current.enabled, aspect: '4:3' });
            updatePlayerBar();
            showToast?.(current.enabled ? 'Focus Mode off' : 'Focus Mode on', current.enabled ? 'info' : 'success');
        });
        $('#vp-toggle-focus-zoom')?.addEventListener('click', () => {
            if (!getProjectorViewportState().enabled) return;
            const next = toggleProjectorViewportZoom('focus-zoom-toggle');
            updatePlayerBar();
            showToast?.(next.zoom > 1 ? `Focus Zoom ${next.zoom.toFixed(1)}×` : 'Focus Zoom off', 'info');
        });
        $('#vp-toggle-autogaze')?.addEventListener('click', () => {
            const active = State.config.gazeAutoReaction !== false;
            State.config.gazeAutoReaction = !active;
            updatePlayerBar();
            showToast?.(State.config.gazeAutoReaction ? 'Авто-взгляд включен' : 'Авто-взгляд выключен', 'info');
            schedulePersist?.();
            requestGallerySettingsSync('projector-settings-autogaze');
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

    // ── Focus Mode as the default mode (v10, opt-in flag) ─────────────────
    // When config.focusModeDefault is set, enable the camera viewport at boot.
    // Enabled-but-NOT-dirty: the camera starts at the default wide view — no
    // forced crop capture until the model/user actually moves it. Everything
    // downstream (glide, depth lock, UI appendices) is owned by
    // projector-focus.js; without that satellite this is a safe no-op.
    // Projector snapshots intentionally don't carry the viewport, so no later
    // restore can clobber this. Flip the flag at runtime, e.g. from the dev
    // console: VP.state.config.focusModeDefault = true; VP.schedulePersist();
    function applyFocusModeBootDefault() {
        try {
            if (!State.config || !State.config.focusModeDefault) return false;
            setProjectorViewport({ enabled: true }, 'boot-default');
            return !!getProjectorViewportState().enabled;
        } catch (err) {
            console.warn('[VP] focusModeDefault boot-apply failed:', err);
            return false;
        }
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
            applyFocusModeBootDefault(); // v10 — opt-in "focus as the main mode"
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

    function registerContextHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'context');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'context', title: 'Context Builder', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Context] Hub module registration failed:', err); }
        }

        if (!hasCommand('context:get-state')) {
            hub.handle('context:get-state', () => ({ ok: true, state: getContextPublicState() }), { moduleId: 'context' });
        }
        if (!hasCommand('context:get-manifest')) {
            hub.handle('context:get-manifest', (payload = {}) => {
                const manifest = buildManifest(payload.templateOverride ?? payload.template ?? null);
                return { ok: true, manifest, length: manifest.length };
            }, { moduleId: 'context' });
        }
        if (!hasCommand('context:get-frame-context-preview')) {
            hub.handle('context:get-frame-context-preview', (payload = {}) => {
                const preview = buildFrameContextPreview(payload.templateOverride ?? payload.template ?? null);
                return { ok: true, preview, length: preview.length };
            }, { moduleId: 'context' });
        }
        if (!hasCommand('context:get-message-descriptors')) {
            hub.handle('context:get-message-descriptors', async () => {
                const messages = await getContextMessageDescriptors();
                return { ok: true, total: messages.length, messages };
            }, { moduleId: 'context' });
        }
        if (!hasCommand('context:prepare-request-body')) {
            hub.handle('context:prepare-request-body', async (payload = {}) => {
                const prepared = await prepareContextRequestBody(payload.body || payload.requestBody || {}, payload);
                return { ok: true, ...prepared };
            }, { moduleId: 'context' });
        }
        // Alias with explicit warning in the contract: Hub returns a ticket, not the body,
        // because the body may contain base64 image data and Hub transports references only.
        if (!hasCommand('context:inject-request-body')) {
            hub.handle('context:inject-request-body', async (payload = {}) => {
                const prepared = await prepareContextRequestBody(payload.body || payload.requestBody || {}, payload);
                return { ok: true, transport: 'ticket', ...prepared };
            }, { moduleId: 'context' });
        }
        if (!hasCommand('context:release-prepared-body')) {
            hub.handle('context:release-prepared-body', (payload = {}) => ({
                ok: releasePreparedContextBody(payload.ticket || payload.id),
            }), { moduleId: 'context' });
        }
    }

    function registerProjectorHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'projector');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'projector', title: 'Projector Core', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Projector] Hub module registration failed:', err); }
        }
        if (!hasCommand('projector:get-viewport')) {
            hub.handle('projector:get-viewport', () => ({ ok: true, viewport: getProjectorViewportState() }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-viewport')) {
            hub.handle('projector:set-viewport', (payload = {}) => ({ ok: true, viewport: setProjectorViewport(payload, 'hub:set-viewport') }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-viewport-mode')) {
            hub.handle('projector:set-viewport-mode', (payload = {}) => ({ ok: true, viewport: setProjectorViewportMode(payload) }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:pan-viewport')) {
            hub.handle('projector:pan-viewport', (payload = {}) => ({ ok: true, viewport: panProjectorViewport(payload.dx || 0, payload.dy || 0, 'hub:pan-viewport') }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:reset-viewport')) {
            hub.handle('projector:reset-viewport', () => ({ ok: true, viewport: resetProjectorViewport('hub:reset-viewport') }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-viewport-zoom')) {
            hub.handle('projector:set-viewport-zoom', (payload = {}) => ({ ok: true, viewport: setProjectorViewportZoom(payload.zoom ?? 1, 'hub:set-viewport-zoom') }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:toggle-viewport-zoom')) {
            hub.handle('projector:toggle-viewport-zoom', () => ({ ok: true, viewport: toggleProjectorViewportZoom('hub:toggle-viewport-zoom') }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:get-depth-state')) {
            hub.handle('projector:get-depth-state', () => ({ ok: true, depth: getProjectorDepthState() }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-depth-mode')) {
            hub.handle('projector:set-depth-mode', (payload = {}) => ({ ok: true, depth: setProjectorDepthMode(payload) }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-depth-strength')) {
            hub.handle('projector:set-depth-strength', (payload = {}) => ({ ok: true, depth: setProjectorDepthStrength(payload.strength) }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-depth-zoom-boost')) {
            hub.handle('projector:set-depth-zoom-boost', (payload = {}) => ({ ok: true, depth: setProjectorDepthZoomBoost(payload.zoomBoost ?? payload.boost) }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:get-state')) {
            hub.handle('projector:get-state', () => getProjectorPublicState(), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:set-current')) {
            hub.handle('projector:set-current', (payload = {}) => {
                const tag = String(payload.tag || '').trim();
                if (!tag) throw new Error('projector:set-current requires payload.tag');
                const ok = setCurrent(tag, payload.source || 'hub', !!payload.force, payload.transition || null);
                return { ok, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:clear-current')) {
            hub.handle('projector:clear-current', (payload = {}) => {
                clearCurrent(payload.source || 'hub');
                return { ok: true, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:update-ui')) {
            hub.handle('projector:update-ui', (payload = {}) => {
                updateProjectorUI();
                if (payload.updatePlayerBar === true) updatePlayerBar();
                return { ok: true, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:get-snapshot')) {
            hub.handle('projector:get-snapshot', () => ({
                ok: true,
                snapshot: buildProjectorSnapshot(),
                state: getProjectorPublicState(),
            }), { moduleId: 'projector' });
        }
        if (!hasCommand('projector:apply-snapshot')) {
            hub.handle('projector:apply-snapshot', (payload = {}) => {
                const snapshot = payload.snapshot || payload;
                if (!snapshot || typeof snapshot !== 'object') throw new Error('projector:apply-snapshot requires payload.snapshot');
                const ok = !!applyProjectorSnapshot(snapshot);
                if (ok && payload.persist !== false) persistProjectorState();
                try {
                    hub.emit('projector:snapshot-applied', {
                        ok,
                        currentTag: State.current?.tag || null,
                        historyCount: Array.isArray(State.history) ? State.history.length : 0,
                    }, { moduleId: 'projector' });
                } catch {}
                return { ok, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:persist-state')) {
            hub.handle('projector:persist-state', () => {
                persistProjectorState();
                return { ok: true, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:get-history')) {
            hub.handle('projector:get-history', (payload = {}) => {
                const limitRaw = Number(payload.limit ?? 100);
                const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 100));
                const history = Array.isArray(State.history) ? State.history.slice(-limit).map(frame => ({
                    tag: frame.tag || null,
                    filename: frame.filename || null,
                    source: frame.source || null,
                    timestamp: frame.timestamp || null,
                })) : [];
                return { ok: true, total: State.history?.length || 0, history };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('projector:clear-history')) {
            hub.handle('projector:clear-history', (payload = {}) => {
                State.history = [];
                if (payload.clearPlayback === true) {
                    State.playback.messages = [];
                    State.playback.cursor = -1;
                    State.playback.mode = 'live';
                }
                updatePlayerBar();
                updateProjectorUI();
                persistProjectorState();
                try { hub.emit('projector:history-changed', { reason: 'clear-history', count: 0 }, { moduleId: 'projector' }); } catch {}
                return { ok: true, state: getProjectorPublicState() };
            }, { moduleId: 'projector' });
        }

        if (!hasCommand('playback:get-state')) {
            hub.handle('playback:get-state', () => ({ ok: true, state: getPlaybackPublicState() }), { moduleId: 'projector' });
        }
        if (!hasCommand('playback:open')) {
            hub.handle('playback:open', (payload = {}) => {
                Playback.open(payload.role || 'assistant', payload.metadata || payload);
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:push')) {
            hub.handle('playback:push', (payload = {}) => {
                Playback.push(String(payload.delta ?? payload.text ?? ''));
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:commit')) {
            hub.handle('playback:commit', (payload = {}) => {
                Playback.commit(String(payload.text ?? payload.fullText ?? ''), payload.metadata || payload);
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:abort')) {
            hub.handle('playback:abort', () => {
                Playback.abort();
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:sync')) {
            hub.handle('playback:sync', (payload = {}) => {
                const messages = Array.isArray(payload.messages) ? payload.messages : [];
                Playback.sync(messages);
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:go-to')) {
            hub.handle('playback:go-to', (payload = {}) => {
                Playback.goTo(Number(payload.index));
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:play')) {
            hub.handle('playback:play', () => {
                Playback.play();
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:pause')) {
            hub.handle('playback:pause', () => {
                Playback.pause();
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
        if (!hasCommand('playback:go-live')) {
            hub.handle('playback:go-live', () => {
                Playback.goLive();
                return { ok: true, state: getPlaybackPublicState() };
            }, { moduleId: 'projector' });
        }
    }

    // ── Public facade (captured by projector-gallery.js at load) ──
    window.VisualProjector = {
        state: State,
        ready: coreReady,
        init,
        // projector core
        setCurrent, clearCurrent,
        getCurrentDescriptor, getProjectorPublicState, getPlaybackPublicState,
        getProjectorViewportState, setProjectorViewport, panProjectorViewport, resetProjectorViewport,
        setProjectorViewportZoom, toggleProjectorViewportZoom, captureFocusViewportDataUrl,
        getProjectorDepthState, setProjectorDepthMode, setProjectorDepthStrength, setProjectorDepthZoomBoost,
        // v15 Gaze Attention Layer — read-only attention channel (facade-safe
        // delegates: degrade to null/empty until projector-focus.js registers)
        getGazeState: () => window.VP_FOCUS?.getGazeState?.() ?? null,
        getGazeDwell: () => window.VP_FOCUS?.getGazeDwell?.() ?? 0,
        getGazeTrail: (limit) => window.VP_FOCUS?.getGazeTrail?.(limit) ?? [],
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
        // template constants (live in vp-templates.js since v07 — lazy getters)
        get DEFAULT_MANIFEST_TEMPLATE() { return getDefaultManifestTemplate(); },
        get DEFAULT_FRAME_TEMPLATE() { return getDefaultFrameTemplate(); },
        // lightweight module registries
        registerPanel, unregisterPanel, getPanels, getPanel,
        registerPromptProvider, unregisterPromptProvider, getPromptProviders, buildPromptProviderContext,
        context: {
            getState: getContextPublicState,
            getMessageDescriptors: getContextMessageDescriptors,
            prepareRequestBody: prepareContextRequestBody,
            consumePreparedBody: consumePreparedContextBody,
            releasePreparedBody: releasePreparedContextBody,
        },
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
        _applyFocusModeBootDefault: applyFocusModeBootDefault, // internal/test hook (v10)
        playback: Playback,
        _playback: Playback, // legacy alias
        // gallery attaches itself here on load:
        gallery: null,
    };

    registerProjectorHubCommands();
    registerContextHubCommands();

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { init().catch(() => {}); });
    else init().catch(() => {});

})();
