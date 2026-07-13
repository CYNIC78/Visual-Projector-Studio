// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-persistence-manager.js — Unified debounced persistence      ║
// ║  RAM-first, explicit Save, QuickSave, AutoSave to backups       ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const getVP = () => window.VisualProjector || null;
    const DB = () => window.VP_DB || window.VP_STORAGE || null;

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

        _dirty: new Map(),
        _timer: null,
        _debounceMs: 1200,

        init() {
            console.log(`[VP Persist] Mode: ${this.mode} (blender=explicit Save, auto=debounced, ephemeral=RAM only)`);
        },

        setMode(newMode) {
            const m = normalizeMode(newMode);
            this.mode = m;
            try { localStorage.setItem('vp-save-mode', m); } catch {}
            console.log(`[VP Persist] Mode set to ${m}`);
            getVP()?.showToast?.(`Save mode: ${m}`, 'info');
            return m;
        },

        getMode() { return this.mode; },

        mark(scope, data) {
            if (this.mode === 'ephemeral') {
                this._dirty.set(scope, { data, ts: Date.now() });
                window.VP_WORLD?.markDirty(scope);
                return Promise.resolve(data);
            }
            if (this.mode === 'blender') {
                this._dirty.set(scope, { data, ts: Date.now() });
                window.VP_WORLD?.markDirty(scope);
                return Promise.resolve(data);
            }
            if (this.mode === 'auto') {
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
                            if (db.setCustomCss && scope === 'customCss') await db.setCustomCss(data);
                            break;
                    }
                } catch (e) {
                    console.warn(`[VP Persist] Flush failed for ${scope}`, e);
                }
            }
        },

        async saveAll(opts = {}) {
            const world = window.VP_WORLD;
            if (!world) return false;
            await this.flush();
            return world.save(opts);
        },

        _bindStorageModeUI() {}
    };

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
                window.VP_WORLD?.markDirty(scope);
                if (PM.mode === 'blender' || PM.mode === 'ephemeral') {
                    PM._dirty.set(scope, { data, ts: Date.now() });
                    return Promise.resolve(data);
                }
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

        const origPut = db.putAsset?.bind(db);
        if (origPut) {
            db._vpOriginal.putAsset = origPut;
            db.putAsset = (asset) => {
                window.VP_WORLD?.markDirty('assets');
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

    PM._getOriginalDBMethod = getOriginalDBMethod;

    window.VP_PERSIST = PM;
    // Safe attach — don't crash if VisualProjector not yet loaded
    if (window.VisualProjector) {
        window.VisualProjector.persist = PM;
    } else {
        try {
            Object.defineProperty(window, '_vp_persist_pending', { value: PM, writable: true });
            const iv = setInterval(() => {
                if (window.VisualProjector && !window.VisualProjector.persist) {
                    window.VisualProjector.persist = PM;
                    clearInterval(iv);
                }
            }, 300);
            setTimeout(() => clearInterval(iv), 10000);
        } catch {}
    }

    function boot() {
        PM.init();
        setTimeout(() => {
            wrapDB();
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
