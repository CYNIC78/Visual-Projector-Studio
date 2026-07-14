/**
 * @fileoverview Neutralino Native API wrapper — typed, promise-based, with fallbacks.
 * All calls guarded; works in browser dev (no Neutralino) and production.
 */

(function () {
  'use strict';

  /** @type {boolean} */
  let _ready = false;
  /** @type {Promise<void> | null} */
  let _initPromise = null;

  // ─── Helpers ───
  function _hasNeutralino() {
    return typeof window.Neutralino !== 'undefined' && window.Neutralino.init;
  }

  function _guard(promise, fallback) {
    if (!_hasNeutralino()) return Promise.resolve(fallback);
    return promise.catch(err => {
      console.warn('[NativeAPI] Call failed:', err);
      return fallback;
    });
  }

  // ─── Window ───
  /** @type {NativeWindow} */
  const windowApi = {
    minimize: () => _guard(Neutralino.window.minimize(), undefined),
    maximize: () => _guard(Neutralino.window.maximize(), undefined),
    close: () => _guard(Neutralino.window.close(), undefined),
    center: () => _guard(Neutralino.window.center(), undefined),
    setSize: (w, h) => _guard(Neutralino.window.setSize(w, h), undefined),
    getSize: () => _guard(Neutralino.window.getSize(), { width: window.innerWidth, height: window.innerHeight }),
  };

  // ─── Filesystem ───
  /** @type {NativeFilesystem} */
  const filesystemApi = {
    readFile: (path) => _guard(Neutralino.filesystem.readFile(path), { data: '' }),
    writeFile: (path, data) => _guard(Neutralino.filesystem.writeFile(path, data), undefined),
    writeBinaryFile: (path, data) => _guard(Neutralino.filesystem.writeBinaryFile(path, data), undefined),
    readBinaryFile: (path) => _guard(Neutralino.filesystem.readBinaryFile(path), new Uint8Array()),
    readDirectory: (path) => _guard(Neutralino.filesystem.readDirectory(path), { entries: [] }),
    createDirectory: (path) => _guard(Neutralino.filesystem.createDirectory(path), undefined),
    remove: (path) => _guard(Neutralino.filesystem.remove(path), undefined),
    getStats: (path) => _guard(Neutralino.filesystem.getStats(path), { size: 0, type: 'unknown', createdAt: 0, modifiedAt: 0 }),
    showOpenDialog: (options) => _guard(Neutralino.os.showOpenDialog(options), ''),
    showSaveDialog: (options) => _guard(Neutralino.os.showSaveDialog(options), ''),
    openPath: (path) => _guard(Neutralino.os.openPath(path), undefined),
  };

  // ─── OS / Process ───
  /** @type {NativeOS} */
  const osApi = {
    spawnProcess: (cmd, opts) => _guard(Neutralino.os.spawnProcess(cmd, opts), { id: -1 }),
    updateSpawnedProcess: (id, action) => _guard(Neutralino.os.updateSpawnedProcess(id, action), undefined),
    execCommand: (cmd, opts) => _guard(Neutralino.os.execCommand(cmd, opts), { exitCode: -1, stdOut: '', stdErr: '' }),
  };

  // ─── App ───
  /** @type {NativeApp} */
  const appApi = {
    exit: () => _guard(Neutralino.app.exit(), undefined),
    getInfo: () => _guard(Neutralino.app.getInfo(), { version: '0.0.0', arch: 'unknown', platform: 'browser' }),
  };

  // ─── Clipboard ───
  /** @type {NativeClipboard} */
  const clipboardApi = {
    read: () => _guard(Neutralino.clipboard.read(), []),
    writeText: (text) => _guard(Neutralino.clipboard.writeText(text), undefined),
  };

  // ─── Debug ───
  /** @type {NativeDebug} */
  const debugApi = {
    log: (msg) => _guard(Neutralino.debug.log(msg), undefined),
  };

  // ─── Init ───
  /**
   * @returns {Promise<void>}
   */
  async function init() {
    if (_ready) return;
    if (_initPromise) return _initPromise;

    _initPromise = (async () => {
      if (!_hasNeutralino()) {
        console.warn('[NativeAPI] Neutralino not available — running in browser fallback mode');
        _ready = true;
        return;
      }

      try {
        await Neutralino.init();
        _ready = true;
        console.log('[NativeAPI] Neutralino initialized');
      } catch (err) {
        console.error('[NativeAPI] Neutralino.init failed:', err);
        _ready = true; // Don't block app, run in fallback
      }
    })();

    return _initPromise;
  }

  // ─── Public API ───
  /** @type {NativeAPI} */
  export const NativeAPI = {
    window: windowApi,
    filesystem: filesystemApi,
    os: osApi,
    app: appApi,
    clipboard: clipboardApi,
    debug: debugApi,
    get ready() { return _ready; },
    init,
  };
})();