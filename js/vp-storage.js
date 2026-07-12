// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-storage.js                                                  ║
// ║  Visual Projector — unified browser storage lifecycle            ║
// ║                                                                  ║
// ║  Goals:                                                          ║
// ║  - one storage facade for gallery/session/shell/projector state  ║
// ║  - IndexedDB first                                               ║
// ║  - memory fallback + optional ephemeral policy                   ║
// ║  - keep legacy window.VP_DB compatibility for older modules      ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const DB_NAME = 'visual-projector-storage';
    const DB_VERSION = 1;
    const KV_STORE = 'kv';
    const ASSET_STORE = 'assets';
    const MODE_KEY = 'vp-storage-mode';
    const VALID_MODES = new Set(['persistent', 'semi-persistent', 'ephemeral']);

    let _dbPromise = null;
    const _memoryKV = new Map();
    const _memoryAssets = new Map();

    function normalizeMode(mode) {
        const m = String(mode || '').trim().toLowerCase();
        return VALID_MODES.has(m) ? m : 'persistent';
    }

    let _mode = normalizeMode((() => {
        try { return localStorage.getItem(MODE_KEY) || 'persistent'; }
        catch { return 'persistent'; }
    })());

    function rememberMode(mode) {
        _mode = normalizeMode(mode);
        try { localStorage.setItem(MODE_KEY, _mode); } catch {}
        return _mode;
    }

    function shouldPersist(scope) {
        if (_mode === 'ephemeral') return false;
        if (_mode === 'semi-persistent') {
            return !new Set(['session', 'projector-state']).has(scope);
        }
        return true;
    }

    function clonePlain(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch { return value; }
    }

    const lsKey = (key) => `vp-storage-fallback:${key}`;

    function cloneAssetRecord(asset) {
        if (!asset) return asset;
        return {
            tag: asset.tag,
            filename: asset.filename || asset.tag,
            path: asset.path || asset.filename || asset.tag,
            blob: asset.blob || null,
            description: asset.description || '',
            hidden: !!asset.hidden,
            source: asset.source || 'user',
            folderContext: asset.folderContext || null,
            tabId: asset.tabId || null,
            collageMeta: clonePlain(asset.collageMeta || null),
        };
    }

    function sanitizeAssetForStorage(asset) {
        if (!asset || !asset.tag) return null;
        return cloneAssetRecord(asset);
    }

    function openDb() {
        if (!('indexedDB' in window)) return Promise.resolve(null);
        if (_dbPromise) return _dbPromise;
        _dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(KV_STORE)) db.createObjectStore(KV_STORE, { keyPath: 'key' });
                if (!db.objectStoreNames.contains(ASSET_STORE)) db.createObjectStore(ASSET_STORE, { keyPath: 'tag' });
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        }).catch((err) => {
            console.warn('[VP Storage] IndexedDB unavailable, using memory fallback:', err);
            return null;
        });
        return _dbPromise;
    }

    async function withStore(storeName, mode, runner) {
        const db = await openDb();
        if (!db) return null;
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            try { result = runner(store, tx); }
            catch (err) { reject(err); return; }
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error(`Transaction failed: ${storeName}`));
            tx.onabort = () => reject(tx.error || new Error(`Transaction aborted: ${storeName}`));
        });
    }

    async function kvSet(key, value, scope = 'misc') {
        const record = { key, scope, value: clonePlain(value), updatedAt: Date.now() };
        _memoryKV.set(key, clonePlain(value));
        if (!shouldPersist(scope)) return record.value;
        const db = await openDb();
        if (!db) {
            try { localStorage.setItem(lsKey(key), JSON.stringify(record.value)); } catch {}
            return record.value;
        }
        await new Promise((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readwrite');
            const store = tx.objectStore(KV_STORE);
            store.put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`kvSet failed for ${key}`));
            tx.onabort = () => reject(tx.error || new Error(`kvSet aborted for ${key}`));
        });
        return record.value;
    }

    async function kvGet(key, scope = 'misc', fallback = null) {
        if (!shouldPersist(scope)) {
            return _memoryKV.has(key) ? clonePlain(_memoryKV.get(key)) : fallback;
        }
        const db = await openDb();
        if (!db) {
            if (_memoryKV.has(key)) return clonePlain(_memoryKV.get(key));
            try {
                const saved = JSON.parse(localStorage.getItem(lsKey(key)) || 'null');
                if (saved !== null) {
                    _memoryKV.set(key, clonePlain(saved));
                    return clonePlain(saved);
                }
            } catch {}
            return fallback;
        }
        return new Promise((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readonly');
            const store = tx.objectStore(KV_STORE);
            const req = store.get(key);
            req.onsuccess = () => {
                const value = req.result?.value;
                if (value !== undefined) {
                    _memoryKV.set(key, clonePlain(value));
                    resolve(clonePlain(value));
                } else {
                    resolve(fallback);
                }
            };
            req.onerror = () => reject(req.error || new Error(`kvGet failed for ${key}`));
        });
    }

    async function kvDelete(key, scope = 'misc') {
        _memoryKV.delete(key);
        try { localStorage.removeItem(lsKey(key)); } catch {}
        if (!shouldPersist(scope)) return;
        const db = await openDb();
        if (!db) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readwrite');
            tx.objectStore(KV_STORE).delete(key);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`kvDelete failed for ${key}`));
            tx.onabort = () => reject(tx.error || new Error(`kvDelete aborted for ${key}`));
        });
    }

    async function putAsset(asset) {
        const record = sanitizeAssetForStorage(asset);
        if (!record) return null;
        _memoryAssets.set(record.tag, record);
        if (!shouldPersist('gallery-assets')) return record;
        const db = await openDb();
        if (!db) return record;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE, 'readwrite');
            tx.objectStore(ASSET_STORE).put(record);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`putAsset failed for ${record.tag}`));
            tx.onabort = () => reject(tx.error || new Error(`putAsset aborted for ${record.tag}`));
        });
        return record;
    }

    async function bulkPutAssets(assets) {
        const rows = (assets || []).map(sanitizeAssetForStorage).filter(Boolean);
        rows.forEach(row => _memoryAssets.set(row.tag, row));
        if (!rows.length || !shouldPersist('gallery-assets')) return rows;
        const db = await openDb();
        if (!db) return rows;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE, 'readwrite');
            const store = tx.objectStore(ASSET_STORE);
            rows.forEach(row => store.put(row));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('bulkPutAssets failed'));
            tx.onabort = () => reject(tx.error || new Error('bulkPutAssets aborted'));
        });
        return rows;
    }

    async function getAllAssets() {
        if (!shouldPersist('gallery-assets')) {
            return Array.from(_memoryAssets.values()).map(cloneAssetRecord);
        }
        const db = await openDb();
        if (!db) return Array.from(_memoryAssets.values()).map(cloneAssetRecord);
        return new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE, 'readonly');
            const store = tx.objectStore(ASSET_STORE);
            const req = store.getAll();
            req.onsuccess = () => {
                const rows = (req.result || []).map(cloneAssetRecord);
                _memoryAssets.clear();
                rows.forEach(row => _memoryAssets.set(row.tag, row));
                resolve(rows);
            };
            req.onerror = () => reject(req.error || new Error('getAllAssets failed'));
        });
    }

    async function deleteAsset(tag) {
        _memoryAssets.delete(tag);
        if (!shouldPersist('gallery-assets')) return;
        const db = await openDb();
        if (!db) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE, 'readwrite');
            tx.objectStore(ASSET_STORE).delete(tag);
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error(`deleteAsset failed for ${tag}`));
            tx.onabort = () => reject(tx.error || new Error(`deleteAsset aborted for ${tag}`));
        });
    }

    async function bulkDeleteAssets(tags) {
        (tags || []).forEach(tag => _memoryAssets.delete(tag));
        if (!shouldPersist('gallery-assets')) return;
        const db = await openDb();
        if (!db) return;
        await new Promise((resolve, reject) => {
            const tx = db.transaction(ASSET_STORE, 'readwrite');
            const store = tx.objectStore(ASSET_STORE);
            (tags || []).forEach(tag => store.delete(tag));
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error || new Error('bulkDeleteAssets failed'));
            tx.onabort = () => reject(tx.error || new Error('bulkDeleteAssets aborted'));
        });
    }

    async function exportAll() {
        const db = await openDb();
        const out = {
            mode: _mode,
            exportedAt: Date.now(),
            kv: [],
            assets: [],
        };
        if (!db) {
            out.kv = Array.from(_memoryKV.entries()).map(([key, value]) => ({ key, value: clonePlain(value), scope: 'memory' }));
            out.assets = Array.from(_memoryAssets.values()).map(cloneAssetRecord);
            return out;
        }
        out.kv = await new Promise((resolve, reject) => {
            const tx = db.transaction(KV_STORE, 'readonly');
            const req = tx.objectStore(KV_STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error || new Error('export kv failed'));
        });
        out.assets = await getAllAssets();
        return out;
    }

    async function clearScope(scope) {
        const db = await openDb();
        if (!db) return;
        await withStore(KV_STORE, 'readwrite', (store) => {
            store.openCursor().onsuccess = (e) => {
                const cursor = e.target.result;
                if (!cursor) return;
                if (cursor.value?.scope === scope) cursor.delete();
                cursor.continue();
            };
        });
    }

    const Storage = {
        ready: () => openDb(),
        getMode() { return _mode; },
        setMode(mode) { return rememberMode(mode); },
        shouldPersist,

        async getGalleryData() { return kvGet('galleryData', 'gallery-meta', null); },
        async setGalleryData(data) { return kvSet('galleryData', data, 'gallery-meta'); },

        async getConfig() { return kvGet('config', 'config', null); },
        async setConfig(config) { return kvSet('config', config, 'config'); },

        async getCoverTag() { return kvGet('coverTag', 'gallery-meta', null); },
        async setCoverTag(tag) { return kvSet('coverTag', tag, 'gallery-meta'); },

        async getPreparedTag() { return kvGet('preparedTag', 'gallery-meta', null); },
        async setPreparedTag(tag) { return kvSet('preparedTag', tag, 'gallery-meta'); },

        async getCoverLabel() { return kvGet('coverLabel', 'gallery-meta', null); },
        async setCoverLabel(label) { return kvSet('coverLabel', label, 'gallery-meta'); },

        async getCurrentTag() { return kvGet('currentTag', 'projector-state', null); },
        async setCurrentTag(tag) { return kvSet('currentTag', tag, 'projector-state'); },

        async getProjectorState() { return kvGet('projectorState', 'projector-state', null); },
        async setProjectorState(state) { return kvSet('projectorState', state, 'projector-state'); },

        async getWinGeom() { return kvGet('windowGeom', 'shell', null); },
        async setWinGeom(geom) { return kvSet('windowGeom', geom, 'shell'); },

        async getPanelGeom() { return kvGet('panelGeom', 'gallery-meta', null); },
        async setPanelGeom(geom) { return kvSet('panelGeom', geom, 'gallery-meta'); },

        async getShellState() { return kvGet('shellState', 'shell', null); },
        async setShellState(state) { return kvSet('shellState', state, 'shell'); },

        async getModelConfig() { return kvGet('modelConfig', 'model', null); },
        async setModelConfig(config) { return kvSet('modelConfig', config, 'model'); },

        async getSessionState() { return kvGet('sessionState', 'session', null); },
        async setSessionState(state) { return kvSet('sessionState', state, 'session'); },

        async getProfiles() { return kvGet('profilesStore', 'profiles', null); },
        async setProfiles(store) { return kvSet('profilesStore', store, 'profiles'); },

        async getChatStore() { return kvGet('chatStore', 'chats', null); },
        async setChatStore(store) { return kvSet('chatStore', store, 'chats'); },

        putAsset,
        bulkPutAssets,
        getAllAssets,
        deleteAsset,
        bulkDeleteAssets,

        async clearSessionState() { return kvDelete('sessionState', 'session'); },
        async clearProjectorState() { await kvDelete('projectorState', 'projector-state'); await kvDelete('currentTag', 'projector-state'); },
        clearScope,
        exportAll,
    };

    window.VP_STORAGE = Storage;
    window.VP_DB = Storage; // legacy compatibility layer for existing modules
})();
