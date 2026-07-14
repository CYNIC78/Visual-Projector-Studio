/**
 * @fileoverview Config Adapter — typed, reactive, scoped configuration.
 * Schemas defined in JSDoc for IDE; runtime = plain objects with optional validation.
 */

'use strict';

/** @type {Object<string, any>} */
let _config = {};

/** @type {Map<string, Set<Function>>} */
const _watchers = new Map();

/** @type {StorageAdapter} */
let _storage = null;

// ─── Default Schema (JSDoc for IDE) ───
/**
 * @typedef {Object} ProjectorConfig
 * @property {number} contextDepth
 * @property {number} maxHistory
 * @property {number} fadeDuration
 * @property {'random'|'fade'|'crossfade'|'slide_left'|'slide_up'|'zoom'|'pop'|'flip'} transitionType
 * @property {number} assetCornerRadius
 * @property {'title'|'debug'|'hidden'} frameLabelMode
 * @property {number} subtitleWPM
 * @property {number} subtitleSpeed
 * @property {boolean} effectsEnabled
 * @property {boolean} debugTags
 * @property {boolean} manifestDescriptions
 * @property {boolean} allowDirectoryCommands
 * @property {'ask'|'always'|'never'} autoTagOnLoad
 * @property {number} maxLongSide
 * @property {number} jpegQuality
 * @property {Object<string, string|null>} prompts
 */

/**
 * @typedef {Object} SessionConfig
 * @property {string} endpoint
 * @property {string} apiKey
 * @property {string} model
 * @property {number} temperature
 * @property {number} maxTokens
 * @property {boolean} stream
 * @property {'off'|'native'|'text-tags'} toolsMode
 * @property {number} toolLoopLimit
 */

/**
 * @typedef {Object} GalleryConfig
 * @property {number} maxLongSide
 * @property {number} jpegQuality
 * @property {'ask'|'always'|'never'} autoTagOnLoad
 * @property {boolean} manifestDescriptions
 * @property {boolean} allowDirectoryCommands
 */

/**
 * @typedef {Object} RootConfig
 * @property {ProjectorConfig} projector
 * @property {SessionConfig} session
 * @property {GalleryConfig} gallery
 * @property {string} userName
 * @property {string} userPersona
 * @property {string} storageMode
 */

// ─── Defaults ───
const DEFAULTS = {
  projector: {
    contextDepth: 3,
    maxHistory: 20,
    fadeDuration: 0.3,
    transitionType: 'random',
    assetCornerRadius: 8,
    frameLabelMode: 'title',
    subtitleWPM: 160,
    subtitleSpeed: 1.0,
    effectsEnabled: true,
    debugTags: false,
    manifestDescriptions: true,
    allowDirectoryCommands: false,
    autoTagOnLoad: 'ask',
    maxLongSide: 1024,
    jpegQuality: 0.92,
    prompts: { manifest: null, frameContext: null },
  },
  session: {
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    apiKey: '',
    model: 'local-model',
    temperature: 0.7,
    maxTokens: 2048,
    stream: true,
    toolsMode: 'off',
    toolLoopLimit: 4,
  },
  gallery: {
    maxLongSide: 1024,
    jpegQuality: 0.92,
    autoTagOnLoad: 'ask',
    manifestDescriptions: true,
    allowDirectoryCommands: false,
  },
  userName: 'User',
  userPersona: '',
  storageMode: 'persistent',
};

// ─── Helpers ───
function _deepClone(obj) {
  if (obj == null) return obj;
  try { return JSON.parse(JSON.stringify(obj)); } catch { return obj; }
}

function _deepMerge(target, source) {
  for (const k of Object.keys(source)) {
    const sv = source[k];
    const tv = target[k];
    if (sv && typeof sv === 'object' && !Array.isArray(sv) && tv && typeof tv === 'object' && !Array.isArray(tv)) {
      _deepMerge(tv, sv);
    } else if (sv !== undefined) {
      target[k] = _deepClone(sv);
    }
  }
}

function _getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
}

function _setPath(obj, path, value) {
  const parts = path.split('.');
  const last = parts.pop();
  let cur = obj;
  for (const p of parts) {
    if (!cur[p] || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[last] = value;
}

function _notify(path, value) {
  const watchers = _watchers.get(path);
  if (watchers) watchers.forEach(fn => { try { fn(value); } catch (e) { console.warn('[Config] watcher error:', e); } });
  // Also notify parent paths
  const parts = path.split('.');
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join('.');
    const pw = _watchers.get(parent);
    if (pw) pw.forEach(fn => { try { fn(_getPath(_config, parent)); } catch (e) {} });
  }
}

// ─── Public API ───
/** @type {ConfigAdapter} */
export const Config = {
  /**
   * Initialize with storage backend (call once at boot)
   * @param {StorageAdapter} storage
   */
  init(storage) {
    _storage = storage;
  },

  /**
   * Load from storage (IndexedDB/localStorage)
   */
  async load() {
    if (!_storage) { console.warn('[Config] Storage not initialized'); return; }
    try {
      const saved = await _storage.loadPersisted('config');
      if (saved) {
        _config = _deepClone(DEFAULTS);
        _deepMerge(_config, saved);
        console.log('[Config] Loaded from storage');
      } else {
        _config = _deepClone(DEFAULTS);
      }
    } catch (e) {
      console.warn('[Config] Load failed, using defaults:', e);
      _config = _deepClone(DEFAULTS);
    }
    // Ensure all nested defaults exist
    _deepMerge(_config, _deepClone(DEFAULTS));
  },

  /**
   * Persist current config to storage
   */
  async persist() {
    if (!_storage) return;
    try {
      await _storage.set('config', _deepClone(_config), 'config');
      await _storage.persist('config');
      console.log('[Config] Persisted');
    } catch (e) {
      console.warn('[Config] Persist failed:', e);
    }
  },

  /**
   * @template T
   * @param {string} path - dot notation (e.g., 'projector.fadeDuration')
   * @param {T} [defaultValue]
   * @returns {T}
   */
  get(path, defaultValue) {
    const val = _getPath(_config, path);
    return val !== undefined ? val : defaultValue;
  },

  /**
   * @param {string} path
   * @param {any} value
   */
  set(path, value) {
    const old = _getPath(_config, path);
    if (old === value) return;
    _setPath(_config, path, value);
    _notify(path, value);
  },

  /**
   * @param {string} path
   * @param {(value: any) => void} handler
   * @returns {() => void} unsubscribe
   */
  watch(path, handler) {
    if (!_watchers.has(path)) _watchers.set(path, new Set());
    _watchers.get(path).add(handler);
    return () => { _watchers.get(path)?.delete(handler); };
  },

  /**
   * @param {string} scope - e.g., 'projector', 'session', 'gallery'
   * @returns {ConfigAdapter} scoped adapter
   */
  scope(scope) {
    const base = this;
    return {
      get(path, def) { return base.get(`${scope}.${path}`, def); },
      set(path, value) { base.set(`${scope}.${path}`, value); },
      watch(path, handler) { return base.watch(`${scope}.${path}`, handler); },
      scope(sub) { return base.scope(`${scope}.${sub}`); },
      getAll() { return _getPath(_config, scope) || {}; },
      setAll(obj) { Object.entries(obj).forEach(([k, v]) => base.set(`${scope}.${k}`, v)); },
      async persist() { return base.persist(); },
      async load() { return base.load(); },
    };
  },

  /** @returns {RootConfig} */
  getAll() { return _deepClone(_config); },

  /** @param {RootConfig} obj */
  setAll(obj) {
    _config = _deepClone(DEFAULTS);
    _deepMerge(_config, obj);
    // Notify all watchers
    _watchers.forEach((_, path) => _notify(path, _getPath(_config, path)));
  },

  /** Reset to defaults */
  reset() {
    _config = _deepClone(DEFAULTS);
    _watchers.forEach((_, path) => _notify(path, _getPath(_config, path)));
  },
};