// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-persistence-manager.js — Unified debounced persistence      ║
// ║  RAM-first, explicit Save, QuickSave, AutoSave to backups       ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const DB = () => window.VP_DB || window.VP_STORAGE;

    const VALID_MODES = new Set(['blender', 'auto', 'ephemeral']);

    function normalizeMode(m) {
        const s = String(m || 'blender').trim().toLowerCase();
        if (s === 'persistent' || s === 'auto-save') return 'auto';
        if (s === 'semi-persistent') return 'blender';
        return VALID_MODES.has(s) ? s : 'blender';
    }

    const PM = {
        mode: normalizeMode((() => {
            try { return localStorage.getItem('vp-save-mode') || 'blender'; } catch { return 'blender'; }
        })()),

        _dirty: new Map(), // scope -> { data, ts }
        _timer: null,
        _debounceMs: 1200,

        init() {
            console.log(`[VP Persist] Mode: ${this.mode} (blender=explicit Save, auto=debounced, ephemeral=RAM only)`);
            // Load quicksave interval from storage if needed
            this._bindStorageModeUI();
        },

        setMode(newMode) {
            const m = normalizeMode(newMode);
            this.mode = m;
            try { localStorage.setItem('vp-save-mode', m); } catch {}
            console.log(`[VP Persist] Mode set to ${m}`);
            VP.showToast?.(`Save mode: ${m}`, 'info');
            return m;
        },

        getMode() { return this.mode; },

        // ── Mark dirty — called instead of direct DB.setX ──
        mark(scope, data) {
            if (this.mode === 'ephemeral') {
                // RAM only, no FS ever — your RAM-disk workaround becomes official
                this._dirty.set(scope, { data, ts: Date.now() });
                window.VP_WORLD?.markDirty(scope);
                return Promise.resolve(data);
            }

            if (this.mode === 'blender') {
                // Blender-like: only mark dirty, no FS write until explicit Save
                this._dirty.set(scope, { data, ts: Date.now() });
                window.VP_WORLD?.markDirty(scope);
                // Still schedule quicksave (RAM/sessionStorage, cheap)
                return Promise.resolve(data);
            }

            if (this.mode === 'auto') {
                // Old behavior but debounced: write after 1.2s of silence
                this._dirty.set(scope, { data, ts: Date.now() });
                window.VP_WORLD?.markDirty(scope);
                this._scheduleFlush();
                return Promise.resolve(data);
            }

            return Promise.resolve(data);
        },

        _scheduleFlush() {
            clearTimeout(this._timer);
            this._timer = setTimeout(() => this.flush(), this._debounceMs);
        },

        async flush() {
            if (this._dirty.size === 0) return;
            if (this.mode === 'ephemeral') {
                console.log('[VP Persist] ephemeral mode — skipping FS flush');
                return;
            }

            const batch = new Map(this._dirty);
            this._dirty.clear();

            const db = DB();
            if (!db) return;

            console.log(`[VP Persist] Flushing ${batch.size} scopes: ${Array.from(batch.keys()).join(', ')}`);

            for (const [scope, { data }] of batch) {
                try {
                    switch (scope) {
                        case 'shell':
                            if (db.setShellState) await db.setShellState(data);
                            break;
                        case 'config':
                            if (db.setConfig) await db.setConfig(data);
                            break;
                        case 'model':
                            if (db.setModelConfig) await db.setModelConfig(data);
                            break;
                        case 'galleryData':
                        case 'gallery-meta':
                            if (db.setGalleryData) await db.setGalleryData(data);
                            break;
                        case 'chatStore':
                        case 'chats':
                            if (db.setChatStore) await db.setChatStore(data);
                            break;
                        case 'session':
                            if (db.setSessionState) await db.setSessionState(data);
                            break;
                        case 'profiles':
                            if (db.setProfiles) await db.setProfiles(data);
                            break;
                        case 'projector':
                        case 'projector-state':
                            if (db.setProjectorState) await db.setProjectorState(data);
                            break;
                        case 'window':
                        case 'shell-geom':
                            if (db.setWinGeom) await db.setWinGeom(data);
                            break;
                        default:
                            // Generic fallback
                            if (db.setCustomCss && scope === 'customCss') await db.setCustomCss(data);
                            break;
                    }
                } catch (e) {
                    console.warn(`[VP Persist] Flush failed for ${scope}`, e);
                }
            }
        },

        // ── Explicit Save — writes all dirty + optionally full ──
        async saveAll(opts = {}) {
            const world = window.VP_WORLD;
            if (!world) return false;
            // Flush any pending debounced first
            await this.flush();
            return world.save(opts);
        },

        // ── QuickSave / AutoSave helpers ──
        _bindStorageModeUI() {
            // Hook into existing storage mode selector if present
            // We have our own save-mode, separate from old storage mode
        }
    };

    // ── Wrap DB methods to enforce RAM-first (intercept old direct calls) ──
    function wrapDB() {
        const db = DB();
        if (!db || db._vpWrapped) return;
        db._vpWrapped = true;
        db._vpOriginal = db._vpOriginal || {};

        const wrap = (method, scope) => {
            if (typeof db[method] !== 'function') return;
            const orig = db[method].bind(db);
            db._vpOriginal[method] = orig;
            db[method] = (data) => {
                // Always mark dirty
                window.VP_WORLD?.markDirty(scope);
                // In blender mode, don't write immediately
                if (PM.mode === 'blender' || PM.mode === 'ephemeral') {
                    PM._dirty.set(scope, { data, ts: Date.now() });
                    return Promise.resolve(data);
                }
                // In auto mode, debounced
                PM.mark(scope, data);
                return Promise.resolve(data);
            };
        };

        wrap('setShellState', 'shell');
        wrap('setConfig', 'config');
        wrap('setModelConfig', 'model');
        wrap('setGalleryData', 'galleryData');
        wrap('setChatStore', 'chatStore');
        wrap('setSessionState', 'session');
        wrap('setProfiles', 'profiles');
        wrap('setProjectorState', 'projector');
        wrap('setWinGeom', 'window');
        wrap('setPanelGeom', 'panel');
        wrap('setCustomCss', 'customCss');

        // putAsset / deleteAsset are special — blobs should still be written immediately (user expects file)
        // but we mark dirty for metadata
        const origPut = db.putAsset?.bind(db);
        if (origPut) {
            db._vpOriginal.putAsset = origPut;
            db.putAsset = (asset) => {
                window.VP_WORLD?.markDirty('assets');
                // To respect philosophy: if asset is _draft, don't write
                if (asset?._draft) {
                    return Promise.resolve(asset);
                }
                return origPut(asset);
            };
        }
        const origBulkPut = db.bulkPutAssets?.bind(db);
        if (origBulkPut) {
            db._vpOriginal.bulkPutAssets = origBulkPut;
            db.bulkPutAssets = (assets) => {
                window.VP_WORLD?.markDirty('assets');
                const drafts = (assets || []).filter(a => !a._draft);
                const toWrite = drafts.length ? drafts : assets;
                if (!toWrite.length) return Promise.resolve([]);
                return origBulkPut(toWrite);
            };
        }

        console.log('[VP Persist] DB methods wrapped — RAM-first enforced');
    }

    function getOriginalDBMethod(method) {
        const db = DB();
        if (db?._vpOriginal?.[method]) return db._vpOriginal[method];
        if (db?.[method]) return db[method].bind(db);
        return null;
    }

    // Expose for World.save to bypass wrapper
    PM._getOriginalDBMethod = getOriginalDBMethod;

    window.VP_PERSIST = PM;
    window.VisualProjector.persist = PM;

    // Init
    function boot() {
        PM.init();
        // Wrap DB after a short delay to ensure native storage ready
        setTimeout(() => {
            wrapDB();
            // Also re-wrap when DB becomes available later (native storage loads async)
            const iv = setInterval(() => {
                const db = DB();
                if (db && !db._vpWrapped) wrapDB();
                else if (db && db._vpWrapped) clearInterval(iv);
            }, 500);
            setTimeout(() => clearInterval(iv), 10000);
        }, 300);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => boot());
    } else {
        setTimeout(() => boot(), 0);
    }

})();
