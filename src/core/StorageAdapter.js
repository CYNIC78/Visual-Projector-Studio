/**
 * @fileoverview Storage Adapter — Ephemeral-first (RAM) with explicit IndexedDB persistence.
 * No automatic writes. Modules call persist() on user Save or graceful shutdown.
 */

(function () {
  'use strict';

  const DB_NAME = 'vp-studio-storage';
  const DB_VERSION = 1;
  const STORES = { kv: 'kv', assets: 'assets' };

  /** @type {'persistent' | 'semi-persistent' | 'ephemeral'} */
  let _mode = 'persistent';
  const _validModes = new Set(['persistent', 'semi-persistent', 'ephemeral']);

  /** @type {Promise<IDBDatabase> | null} */
  let _dbPromise = null;
  /** @type {Map<string, any>} */
  const _memoryKV = new Map();
  /** @type {Map<string, any>} */
  const _memoryAssets = new Map();

  // ─── Mode ───
  function _normalizeMode(mode) {
    const m = String(mode || '').trim().toLowerCase();
    return _validModes.has(m) ? m : 'persistent';
  }

  function _shouldPersist(scope) {
    if (_mode === 'ephemeral') return false;
    if (_mode === 'semi-persistent') {
      return !new Set(['session', 'projector-state', 'playback']).has(scope);
    }
    return true;
  }

  // ─── IndexedDB ───
  function _openDB() {
    if (!('indexedDB' in window)) return Promise.resolve(null);
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORES.kv)) db.createObjectStore(STORES.kv, { keyPath: 'key' });
        if (!db.objectStoreNames.contains(STORES.assets)) db.createObjectStore(STORES.assets, { keyPath: 'tag' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    }).catch(err => {
      console.warn('[Storage] IndexedDB unavailable, RAM only:', err);
      return null;
    });
    return _dbPromise;
  }

  function _withStore(storeName, mode, fn) {
    return _openDB().then(db => {
      if (!db) return null;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let result;
        try { result = fn(store, tx); }
        catch (e) { reject(e); return; }
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error || new Error(`TX failed: ${storeName}`));
        tx.onabort = () => reject(tx.error || new Error(`TX aborted: ${storeName}`));
      });
    });
  }

  function _clone(v) {
    if (v == null) return v;
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
  }

  function _sanitizeAsset(a) {
    if (!a || !a.tag) return null;
    return {
      tag: a.tag,
      filename: a.filename || a.tag,
      path: a.path || a.filename || a.tag,
      blob: a.blob || null,
      description: a.description || '',
      hidden: !!a.hidden,
      source: a.source || 'user',
      folderContext: a.folderContext || null,
      tabId: a.tabId || null,
      collageMeta: _clone(a.collageMeta || null),
    };
  }

  // ─── Public API ───
  /** @type {StorageAdapter} */
  export const Storage = {
    // Mode
    getMode() { return _mode; },
    setMode(mode) { _mode = _normalizeMode(mode); try { localStorage.setItem('vp-storage-mode', _mode); } catch {} return _mode; },
    shouldPersist: _shouldPersist,

    // ─── KV (config, state, geometry, etc.) ───
    /**
     * @param {string} key
     * @returns {any}
     */
    get(key) {
      return _memoryKV.has(key) ? _clone(_memoryKV.get(key)) : undefined;
    },

    /**
     * @param {string} key
     * @param {any} value
     * @param {string} [scope]
     */
    async set(key, value, scope = 'misc') {
      const cloned = _clone(value);
      _memoryKV.set(key, cloned);
      if (!_shouldPersist(scope)) return cloned;

      const db = await _openDB();
      if (!db) return cloned;

      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.kv, 'readwrite');
        tx.objectStore(STORES.kv).put({ key, scope, value: cloned, updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return cloned;
    },

    /**
     * @param {string} key
     * @param {string} [scope]
     */
    async delete(key, scope = 'misc') {
      _memoryKV.delete(key);
      if (!_shouldPersist(scope)) return;
      const db = await _openDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.kv, 'readwrite');
        tx.objectStore(STORES.kv).delete(key);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },

    // ─── Assets (gallery) ───
    /**
     * @param {AssetRecord} asset
     */
    async putAsset(asset) {
      const rec = _sanitizeAsset(asset);
      if (!rec) return null;
      _memoryAssets.set(rec.tag, rec);
      if (!_shouldPersist('gallery-assets')) return rec;

      const db = await _openDB();
      if (!db) return rec;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.assets, 'readwrite');
        tx.objectStore(STORES.assets).put(rec);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return rec;
    },

    /**
     * @param {AssetRecord[]} assets
     */
    async bulkPutAssets(assets) {
      const rows = (assets || []).map(_sanitizeAsset).filter(Boolean);
      rows.forEach(r => _memoryAssets.set(r.tag, r));
      if (!rows.length || !_shouldPersist('gallery-assets')) return rows;

      const db = await _openDB();
      if (!db) return rows;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.assets, 'readwrite');
        const store = tx.objectStore(STORES.assets);
        rows.forEach(r => store.put(r));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      return rows;
    },

    /** @returns {Promise<AssetRecord[]>} */
    async getAllAssets() {
      if (!_shouldPersist('gallery-assets')) {
        return Array.from(_memoryAssets.values()).map(_clone);
      }
      const db = await _openDB();
      if (!db) return Array.from(_memoryAssets.values()).map(_clone);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.assets, 'readonly');
        const req = tx.objectStore(STORES.assets).getAll();
        req.onsuccess = () => {
          const rows = (req.result || []).map(_clone);
          _memoryAssets.clear();
          rows.forEach(r => _memoryAssets.set(r.tag, r));
          resolve(rows);
        };
        req.onerror = () => reject(req.error);
      });
    },

    /**
     * @param {string} tag
     */
    async deleteAsset(tag) {
      _memoryAssets.delete(tag);
      if (!_shouldPersist('gallery-assets')) return;
      const db = await _openDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.assets, 'readwrite');
        tx.objectStore(STORES.assets).delete(tag);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },

    /**
     * @param {string[]} tags
     */
    async bulkDeleteAssets(tags) {
      tags.forEach(t => _memoryAssets.delete(t));
      if (!_shouldPersist('gallery-assets')) return;
      const db = await _openDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.assets, 'readwrite');
        const store = tx.objectStore(STORES.assets);
        tags.forEach(t => store.delete(t));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },

    // ─── Explicit persistence helpers ───
    /**
     * @param {string} key
     */
    async persist(key) {
      const val = _memoryKV.get(key);
      if (val === undefined) return;
      const db = await _openDB();
      if (!db) return;
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.kv, 'readwrite');
        tx.objectStore(STORES.kv).put({ key, scope: 'explicit', value: _clone(val), updatedAt: Date.now() });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
    },

    /**
     * @param {string} key
     */
    async loadPersisted(key) {
      const db = await _openDB();
      if (!db) return _memoryKV.has(key) ? _clone(_memoryKV.get(key)) : undefined;
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORES.kv, 'readonly');
        const req = tx.objectStore(STORES.kv).get(key);
        req.onsuccess = () => {
          const val = req.result?.value;
          if (val !== undefined) {
            _memoryKV.set(key, _clone(val));
            resolve(_clone(val));
          } else resolve(undefined);
        };
        req.onerror = () => reject(req.error);
      });
    },

    // ─── Namespacing ───
    /**
     * @param {string} prefix
     * @returns {StorageAdapter}
     */
    namespace(prefix) {
      const base = this;
      const ns = `${prefix}:`;
      return {
        get(k) { return base.get(ns + k); },
        set(k, v, scope) { return base.set(ns + k, v, scope); },
        delete(k, scope) { return base.delete(ns + k, scope); },
        clear() { /* iterate base keys */ },
        namespace(p) { return base.namespace(`${prefix}:${p}`); },
        persist(k) { return base.persist(ns + k); },
        loadPersisted(k) { return base.loadPersisted(ns + k); },
      };
    },

    // ─── Bulk ops for migration/export ───
    async exportAll() {
      const db = await _openDB();
      const out = { mode: _mode, exportedAt: Date.now(), kv: [], assets: [] };
      if (!db) {
        out.kv = Array.from(_memoryKV.entries()).map(([k, v]) => ({ key: k, value: _clone(v) }));
        out.assets = Array.from(_memoryAssets.values()).map(_clone);
        return out;
      }
      out.kv = await _withStore(STORES.kv, 'readonly', store => new Promise((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      }));
      out.assets = await this.getAllAssets();
      return out;
    },

    async clearScope(scope) {
      const db = await _openDB();
      if (!db) return;
      await _withStore(STORES.kv, 'readwrite', store => new Promise((resolve, reject) => {
        const req = store.openCursor();
        req.onsuccess = e => {
          const cursor = e.target.result;
          if (!cursor) return resolve();
          if (cursor.value?.scope === scope) cursor.delete();
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      }));
    },
  };
})();