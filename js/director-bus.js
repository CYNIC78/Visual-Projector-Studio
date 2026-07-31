// ╔══════════════════════════════════════════════════════════════════╗
// ║  director-bus.js                                                 ║
// ║  Visual Projector — Engine satellite: DIRECTOR COMMAND BUS       ║
// ║  (model/director text commands: validate · route · run · log)    ║
// ║                                                                  ║
// ║  Owns: VPCommandBus (one official registry for text commands     ║
// ║        like [IMG:tag], [FOCUS:top:zoom], [FX:name],              ║
// ║        [CAT:open:name], [TAB:collapse:name] + activity/game      ║
// ║        passthrough), the built-in command handlers,              ║
// ║        FOCUS_PRESETS and the rolling command log.                ║
// ║                                                                  ║
// ║  VPTags (in visual-projector.js) only PARSES syntax; this bus    ║
// ║  is what validates, routes, executes and logs.                   ║
// ║                                                                  ║
// ║  Extracted from visual-projector.js (v06 refactor) — the block   ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent / "beautify": it must stay diff-verifiable      ║
// ║  against backups/05-extract-projector-focus.zip.                 ║
// ║                                                                  ║
// ║  Load order: director-bus.js → visual-projector.js               ║
// ║  (this satellite registers window.VP_DIRECTOR_BUS at load; the   ║
// ║   engine calls createCommandBus(deps) at its bridge site and     ║
// ║   passes the handful of engine helpers the handlers need;        ║
// ║   function declarations are hoisted, so the deps exist by then). ║
// ║                                                                  ║
// ║  Public contract (unchanged): VP.commands on the engine facade — ║
// ║  vp-subtitles.js, vp-interactive.js and other modules consume    ║
// ║  it exactly as before.                                           ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    // Called ONCE by visual-projector.js at its bridge site (engine boot).
    // deps = { State, VPTags, setCurrent, showToast, getProjectorViewportState,
    //          ensureViewportGlideLoopActive, updateProjectorDepthLayer }
    function createCommandBus(deps = {}) {
        const State = deps.State;
        const VPTags = deps.VPTags;
        const setCurrent = deps.setCurrent;
        const showToast = deps.showToast || function () {};
        const getProjectorViewportState = deps.getProjectorViewportState;
        const ensureViewportGlideLoopActive = deps.ensureViewportGlideLoopActive || function () {};
        const updateProjectorDepthLayer = deps.updateProjectorDepthLayer || function () { return Promise.resolve(); };
        if (!State || !VPTags || typeof setCurrent !== 'function' || typeof getProjectorViewportState !== 'function') {
            throw new Error(
                '[VP CommandBus] createCommandBus: required engine deps missing.\n' +
                'Expected { State, VPTags, setCurrent, getProjectorViewportState, ... } ' +
                'from visual-projector.js.'
            );
        }

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

    // v14: pruned to the actually REACHABLE presets only. The keyword branches
    // in the handler below (face/top/bottom/left/right/reset/...) always ran
    // first, so the 14 same-named rows here were unreachable dead weight.
    // The model-facing grammar is unchanged: all keywords still parse exactly
    // as before, presets only add the "cinematic family". vignette field cut
    // in v14 (owner call); pivot + strength stay (pivot is live in the
    // WebGL1 fallback shader and is semantic gaze depth; strength is the
    // FOV/parallax multiplier).
    const FOCUS_PRESETS = {
        'background': { zoom: 1.1, x: 0.5, y: 0.5, pivot: 0.15, strength: 1.0 },
        'landscape': { zoom: 1.1, x: 0.5, y: 0.5, pivot: 0.15, strength: 1.0 },
        'foreground': { zoom: 1.1, x: 0.5, y: 0.5, pivot: 0.85, strength: 1.0 },
        'cinematic': { zoom: 1.4, x: 0.5, y: 0.3, pivot: 0.50, strength: 1.6 },
        'extreme': { zoom: 1.5, x: 0.5, y: 0.3, pivot: 0.50, strength: 2.0 },
    };

    VPCommandBus.register('FOCUS', {
        target: 'projector-viewport',
        description: 'Set camera viewport zoom and pan: [FOCUS:position:zoom] (e.g. [FOCUS:bottom:zoom] or [FOCUS:top] wide) or [FOCUS:zoom:x:y:pivot] (legacy 5th slot vignette is ignored since v14)',
        queueable: true,
        handler(cmd, meta = {}) {
            const body = String(cmd.body || '').trim().toLowerCase();
            const parts = body.split(':').map(p => p.trim());
            const posArg = parts[0] || 'reset';
            const zoomArg = parts[1] || '';

            let zoom = 1.0;
            let x = 0.5;
            let y = 0.0;
            let pivot = null;
            let strength = null;
            // vignette: removed in v14 (owner call — flat screen effects are
            // FX-engine business). A legacy 5th numeric slot is harmlessly
            // unparsed now.

            const current = getProjectorViewportState();

            if (body === 'zoom') {
                zoom = 1.5;
                x = current.x;
                y = current.y;
            } else if (posArg === 'top' || posArg === 'face' || posArg === 'portrait') {
                x = 0.5;
                y = 0.0; // very top!
            } else if (posArg === 'bottom' || posArg === 'hands' || posArg === 'detail') {
                x = 0.5;
                y = 1.0; // very bottom!
            } else if (posArg === 'middle' || posArg === 'center') {
                x = 0.5;
                y = 0.5;
            } else if (posArg === 'left') {
                x = 0.0;
                y = 0.5;
            } else if (posArg === 'right') {
                x = 1.0;
                y = 0.5;
            } else if (posArg === 'reset' || posArg === 'wide' || posArg === 'flat' || posArg === 'default') {
                x = 0.5;
                y = 0.0;
                zoom = 1.0;
            } else if (FOCUS_PRESETS[posArg]) {
                const preset = FOCUS_PRESETS[posArg];
                zoom = preset.zoom;
                x = preset.x;
                y = preset.y;
                pivot = preset.pivot;
                strength = preset.strength;
            } else {
                // Fallback to raw numeric parsing (parts[4] legacy vignette slot intentionally ignored, v14)
                zoom = parts[0] != null && parts[0] !== '' ? Number(parts[0]) : null;
                x = parts[1] != null && parts[1] !== '' ? Number(parts[1]) : null;
                y = parts[2] != null && parts[2] !== '' ? Number(parts[2]) : null;
                pivot = parts[3] != null && parts[3] !== '' ? Number(parts[3]) : null;
            }

            // Apply two-layered zoom suffix if position keyword is used
            const isPresetOrKeyword = FOCUS_PRESETS[posArg] || ['top', 'bottom', 'middle', 'center', 'left', 'right', 'reset', 'wide', 'flat', 'default', 'face', 'portrait', 'hands', 'detail'].includes(posArg);
            if (isPresetOrKeyword && posArg !== 'reset' && posArg !== 'wide' && posArg !== 'flat' && posArg !== 'default') {
                if (zoomArg === 'zoom' || zoomArg === 'in') {
                    zoom = 1.5;
                } else if (zoomArg !== '' && !isNaN(Number(zoomArg))) {
                    zoom = Number(zoomArg);
                } else {
                    zoom = 1.0; // default to wide view if no zoom suffix is passed!
                }
            }

            const patch = {};
            if (zoom !== null && !isNaN(zoom)) patch.zoom = zoom;
            if (x !== null && !isNaN(x)) patch.x = x;
            if (y !== null && !isNaN(y)) patch.y = y;

            patch.enabled = true;
            patch.aspect = '4:3';
            patch.touched = true;

            // Apply viewport changes smoothly via LERP glide!
            // (glide targets live in the focus satellite; null targets
            //  self-seed from the current viewport inside the glide loop)
            const _f = window.VP_FOCUS;
            if (patch.zoom !== undefined) _f?.setGlideTarget('zoom', patch.zoom);
            if (patch.x !== undefined) _f?.setGlideTarget('x', patch.x);
            if (patch.y !== undefined) _f?.setGlideTarget('y', patch.y);

            ensureViewportGlideLoopActive();

            // Apply Pivot and Strength if specified (vignette cut in v14).
            // focusViewport bootstrap lives in the focus satellite helper —
            // degrades to "global state only" if VP_FOCUS failed to load.
            if (pivot !== null && !isNaN(pivot)) {
                State.projectorDepth.pivot = pivot;
                const fv = _f?.ensureAssetFocusViewport?.(State.current);
                if (fv) fv.pivot = pivot;
            }
            if (strength !== null && !isNaN(strength)) {
                State.projectorDepth.strengthMultiplier = strength;
                const fv = _f?.ensureAssetFocusViewport?.(State.current);
                if (fv) fv.strengthMultiplier = strength;
            }

            // Update sliders UI if visible (pivot/vignette sliders removed from the HUD in v14)
            const screen = State.ui.screen;
            if (screen) {
                const strengthSlider = screen.querySelector('#vp-focus-strength-slider');
                const strengthVal = screen.querySelector('#vp-focus-strength-val');
                if (strengthSlider && strengthVal && strength !== null && !isNaN(strength)) {
                    strengthSlider.value = String(strength);
                    strengthVal.textContent = strength.toFixed(1) + 'x';
                }
            }

            updateProjectorDepthLayer().catch(() => {});

            if (meta.showToast !== false) {
                showToast(`🎥 FOCUS: ${body}`, 'info');
            }
            return { ok: true, zoom, x, y, pivot, delayMs: 400 };
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
        // FSM audit (2026-07-31): executeCommand returns a small result, so the
        // bus logs an HONEST outcome — a miss or a lock is not a silent success.
        // ok stays true (the command RAN); `matched: false` is the honesty flag
        // for the command log, loop observers and any future feedback channel.
        const res = TM.executeCommand(entityType || cmd.type, action, name) || {};
        return {
            ok: true,
            entityType: entityType || cmd.type,
            action,
            name,
            matched: res.matched !== false,
            changed: !!res.changed,
            opened: !!res.opened,
            closed: !!res.closed,
            delayMs: 0,
        };
    }

    VPCommandBus.register('CAT', {
        target: 'gallery-tabs',
        // v17: 'close' is the canonical verb ('collapse' kept as parser alias);
        // a category command reveals/packs a whole scene pack, tab states untouched.
        description: 'Open/close a category pack: [CAT:open:name] / [CAT:close:name]',
        queueable: true,
        handler: executeDirectoryCommand,
    });
    VPCommandBus.register('TAB', {
        target: 'gallery-tabs',
        // v17: [TAB:open] is a solo scene switch — it closes every other tab.
        description: 'Enter a tab scene (solo; closes the other tabs): [TAB:open:name] / Step back out: [TAB:close:name]',
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

        return VPCommandBus;
    }

    window.VP_DIRECTOR_BUS = { createCommandBus };
})();
