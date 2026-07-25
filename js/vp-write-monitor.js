// ╔══════════════════════════════════════════════════════════════════╗
// ║ vp-write-monitor.js                                             ║
// ║ Visual Projector — dev-only write monitor for storage/FS noise   ║
// ║                                                                  ║
// ║ Default: loaded but OFF.                                         ║
// ║ Enable in console:                                               ║
// ║   VP_WRITE_MONITOR.enable({ summaryEveryMs: 5000 })              ║
// ║ Disable:                                                         ║
// ║   VP_WRITE_MONITOR.disable()                                     ║
// ║ Auto-enable on F5:                                                ║
// ║   localStorage.setItem('vp-write-monitor', '1')                  ║
// ║ Auto-enable quiet:                                                ║
// ║   localStorage.setItem('vp-write-monitor', 'quiet')              ║
// ║ Disable auto-enable:                                              ║
// ║   localStorage.removeItem('vp-write-monitor')                    ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const AUTO_KEY = 'vp-write-monitor';
    const API_NAME = 'VP_WRITE_MONITOR';

    if (window[API_NAME]?.version) {
        console.warn('[VP Write Monitor] already installed');
        return;
    }

    const DEFAULT_OPTIONS = {
        logEach: false,          // true = log every write; noisy, use only for hunts
        stack: false,            // true = keep a stack sample for each key
        summaryEveryMs: 0,       // 0 = no periodic summary; use report() manually
        top: 18,
        includeReads: false,     // reserved; monitor focuses on writes by default
    };

    const state = {
        version: '0.1.0',
        enabled: false,
        options: { ...DEFAULT_OPTIONS },
        records: new Map(),
        startedAt: 0,
        lastSummaryAt: 0,
        writesSinceSummary: 0,
        summaryTimer: null,
        originalStorageSetItem: null,
        originalDbMethods: new WeakMap(),
        originalFsMethods: new Map(),
        wrappedDb: null,
    };

    const DB_METHODS = [
        'setMode',
        'setGalleryData', 'setConfig',
        'setCoverTag', 'setPreparedTag', 'setCoverLabel', 'setCurrentTag', 'setProjectorState',
        'setWinGeom', 'setPanelGeom', 'setShellState', 'setAssetStudioState', 'setModelConfig', 'setSessionState',
        'setProfiles', 'setChatStore', 'setCustomCss',
        'putAsset', 'bulkPutAssets', 'deleteAsset', 'bulkDeleteAssets',
        'setGameState', 'setActiveGameId', 'clearActiveGameId',
        'writeGameFile', 'writeGameBinaryFile', 'deleteGame',
        'createWorld', 'renameWorld', 'setActiveWorld', 'duplicateWorld', 'deleteWorld',
        'exportWorld', 'backupWorld', 'importWorldFromFile', 'importGameFromFile', 'exportGame',
    ];

    const FS_METHODS = [
        'writeFile', 'writeBinaryFile', 'appendFile', 'appendBinaryFile',
        'remove', 'copy', 'move', 'createDirectory',
    ];

    function nowIsoTime() {
        try { return new Date().toLocaleTimeString(); }
        catch { return String(Date.now()); }
    }

    function safeString(value, max = 220) {
        let s = '';
        try {
            if (typeof value === 'string') s = value;
            else if (value == null) s = String(value);
            else s = JSON.stringify(value);
        } catch {
            try { s = String(value); } catch { s = '[unprintable]'; }
        }
        if (s.length > max) s = s.slice(0, max) + '…';
        return s;
    }

    function estimateBytes(value) {
        try {
            if (value == null) return 0;
            if (typeof value === 'string') return value.length * 2;
            if (value instanceof Blob) return value.size || 0;
            if (value instanceof ArrayBuffer) return value.byteLength || 0;
            if (ArrayBuffer.isView(value)) return value.byteLength || 0;
            if (typeof value === 'number' || typeof value === 'boolean') return 8;
            // Dev monitor only: approximate structured data size.
            return JSON.stringify(value).length * 2;
        } catch {
            return 0;
        }
    }

    function stackSample() {
        if (!state.options.stack) return null;
        try {
            return String(new Error().stack || '')
                .split('\n')
                .slice(3, 11)
                .join('\n');
        } catch { return null; }
    }

    function normalizeTarget(target) {
        return String(target || '(unknown)').replace(/\\/g, '/');
    }

    function record(kind, target, bytes = 0, meta = {}) {
        if (!state.enabled) return;
        const cleanTarget = normalizeTarget(target);
        const key = `${kind} ${cleanTarget}`;
        const t = Date.now();
        let r = state.records.get(key);
        if (!r) {
            r = {
                key,
                kind,
                target: cleanTarget,
                count: 0,
                bytes: 0,
                firstAt: t,
                lastAt: t,
                lastTime: nowIsoTime(),
                lastMeta: '',
                stack: null,
            };
            state.records.set(key, r);
        }
        r.count += 1;
        r.bytes += Number(bytes) || 0;
        r.lastAt = t;
        r.lastTime = nowIsoTime();
        r.lastMeta = meta && Object.keys(meta).length ? safeString(meta, 260) : '';
        if (state.options.stack && !r.stack) r.stack = stackSample();
        state.writesSinceSummary += 1;

        if (state.options.logEach) {
            console.debug(`[VP Write] ${kind}`, cleanTarget, bytes ? `~${formatBytes(bytes)}` : '', meta || '');
        }
    }

    function formatBytes(bytes) {
        bytes = Number(bytes) || 0;
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
    }

    function rows(limit = state.options.top) {
        return Array.from(state.records.values())
            .sort((a, b) => (b.count - a.count) || (b.bytes - a.bytes) || (b.lastAt - a.lastAt))
            .slice(0, limit)
            .map(r => ({
                count: r.count,
                bytes: formatBytes(r.bytes),
                kind: r.kind,
                target: r.target,
                last: r.lastTime,
                meta: r.lastMeta,
            }));
    }

    function summary(force = false) {
        if (!state.enabled) return [];
        if (!force && !state.writesSinceSummary) return rows();
        const data = rows();
        const totalWrites = Array.from(state.records.values()).reduce((n, r) => n + r.count, 0);
        const totalBytes = Array.from(state.records.values()).reduce((n, r) => n + r.bytes, 0);
        console.groupCollapsed(
            `%c[VP Write Monitor]%c writes: ${totalWrites}, approx: ${formatBytes(totalBytes)}, keys: ${state.records.size}`,
            'color:#f9c74f;font-weight:700', 'color:inherit'
        );
        console.table(data);
        console.log('Commands:', 'VP_WRITE_MONITOR.report()', 'VP_WRITE_MONITOR.reset()', 'VP_WRITE_MONITOR.disable()');
        console.groupEnd();
        state.writesSinceSummary = 0;
        state.lastSummaryAt = Date.now();
        return data;
    }

    function installSummaryTimer() {
        if (state.summaryTimer) {
            clearInterval(state.summaryTimer);
            state.summaryTimer = null;
        }
        const ms = Number(state.options.summaryEveryMs) || 0;
        if (ms > 0) {
            state.summaryTimer = setInterval(() => summary(false), Math.max(1000, ms));
        }
    }

    function wrapStorageSetItem() {
        if (state.originalStorageSetItem || !window.Storage?.prototype?.setItem) return;
        state.originalStorageSetItem = window.Storage.prototype.setItem;
        window.Storage.prototype.setItem = function (key, value) {
            const area = this === window.localStorage ? 'localStorage'
                : this === window.sessionStorage ? 'sessionStorage'
                : 'Storage';
            record(area, key, estimateBytes(value), { op: 'setItem' });
            return state.originalStorageSetItem.apply(this, arguments);
        };
    }

    function unwrapStorageSetItem() {
        if (state.originalStorageSetItem && window.Storage?.prototype) {
            window.Storage.prototype.setItem = state.originalStorageSetItem;
            state.originalStorageSetItem = null;
        }
    }

    function wrapNeutralinoFs() {
        const fs = window.Neutralino?.filesystem;
        if (!fs) return;
        for (const name of FS_METHODS) {
            if (typeof fs[name] !== 'function') continue;
            if (state.originalFsMethods.has(name)) continue;
            const original = fs[name];
            state.originalFsMethods.set(name, original);
            fs[name] = function () {
                const path = arguments[0] || arguments[0]?.path || '(unknown)';
                const data = name.includes('Binary') || name.includes('File') || name.startsWith('append')
                    ? arguments[1]
                    : null;
                record(`FS.${name}`, path, estimateBytes(data), { args: Array.from(arguments).slice(0, 2).map(x => safeString(x, 120)) });
                return original.apply(this, arguments);
            };
        }
    }

    function unwrapNeutralinoFs() {
        const fs = window.Neutralino?.filesystem;
        if (!fs) return;
        for (const [name, original] of state.originalFsMethods.entries()) {
            try { fs[name] = original; } catch {}
        }
        state.originalFsMethods.clear();
    }

    function dbTargetFor(name, args) {
        if (name === 'putAsset' || name === 'deleteAsset') return args[0]?.tag || args[0] || '(asset)';
        if (name === 'bulkPutAssets' || name === 'bulkDeleteAssets') return `${Array.isArray(args[0]) ? args[0].length : 0} item(s)`;
        if (name === 'writeGameFile' || name === 'writeGameBinaryFile') return `${args[0] || '(game)'}/${args[1] || '(path)'}`;
        if (name === 'setGameState') return args[0] || '(game)';
        if (name.toLowerCase().includes('world')) return args[0]?.id || args[0]?.title || args[0] || '(world)';
        return name;
    }

    function wrapDb(db = window.VP_DB) {
        if (!db || typeof db !== 'object') return false;
        if (state.wrappedDb === db) return true;
        const originals = state.originalDbMethods.get(db) || new Map();
        for (const name of DB_METHODS) {
            if (typeof db[name] !== 'function') continue;
            if (originals.has(name)) continue;
            const original = db[name];
            originals.set(name, original);
            db[name] = function () {
                const args = Array.from(arguments);
                const target = dbTargetFor(name, args);
                const bytes = estimateBytes(args[0]) + estimateBytes(args[1]);
                record(`DB.${name}`, target, bytes, { mode: db.getMode?.(), persist: db.shouldPersist?.('unknown') });
                return original.apply(this, arguments);
            };
        }
        state.originalDbMethods.set(db, originals);
        state.wrappedDb = db;
        return true;
    }

    function unwrapDb() {
        for (const [db, originals] of Array.from(state.originalDbMethods.entries())) {
            for (const [name, original] of originals.entries()) {
                try { db[name] = original; } catch {}
            }
        }
        state.originalDbMethods = new WeakMap();
        state.wrappedDb = null;
    }

    function enable(opts = {}) {
        state.options = { ...state.options, ...opts };
        if (state.enabled) {
            wrapDb();
            wrapNeutralinoFs();
            installSummaryTimer();
            return api;
        }
        state.enabled = true;
        state.startedAt = Date.now();
        state.lastSummaryAt = state.startedAt;
        wrapStorageSetItem();
        wrapNeutralinoFs();
        wrapDb();
        installSummaryTimer();
        console.info('[VP Write Monitor] enabled', state.options);
        return api;
    }

    function disable() {
        if (!state.enabled) return api;
        summary(true);
        state.enabled = false;
        if (state.summaryTimer) {
            clearInterval(state.summaryTimer);
            state.summaryTimer = null;
        }
        unwrapStorageSetItem();
        unwrapNeutralinoFs();
        unwrapDb();
        console.info('[VP Write Monitor] disabled');
        return api;
    }

    function reset() {
        state.records.clear();
        state.writesSinceSummary = 0;
        state.startedAt = Date.now();
        console.info('[VP Write Monitor] counters reset');
        return api;
    }

    function report(limit = state.options.top) {
        const data = rows(limit);
        const totalWrites = Array.from(state.records.values()).reduce((n, r) => n + r.count, 0);
        const totalBytes = Array.from(state.records.values()).reduce((n, r) => n + r.bytes, 0);
        console.group('[VP Write Monitor] report');
        console.log('enabled:', state.enabled, 'uptime:', `${((Date.now() - (state.startedAt || Date.now())) / 1000).toFixed(1)}s`);
        console.log('writes:', totalWrites, 'approx bytes:', formatBytes(totalBytes), 'keys:', state.records.size);
        console.table(data);
        if (state.options.stack) {
            for (const r of Array.from(state.records.values()).filter(x => x.stack).slice(0, limit)) {
                console.groupCollapsed(`stack: ${r.key}`);
                console.log(r.stack);
                console.groupEnd();
            }
        }
        console.groupEnd();
        return data;
    }

    function exportJson() {
        return {
            version: state.version,
            enabled: state.enabled,
            startedAt: state.startedAt,
            options: { ...state.options },
            records: Array.from(state.records.values()).map(r => ({ ...r })),
        };
    }

    function autoOptionsFromStorage() {
        let flag = '';
        try { flag = String(localStorage.getItem(AUTO_KEY) || '').trim().toLowerCase(); } catch {}
        const urlFlag = /[?&]vpwm(=1|=true|=quiet)?\b/i.test(location.search || '') || /(^|[#&])vpwm(=1|=true)?\b/i.test(location.hash || '');
        if (urlFlag) return { summaryEveryMs: 5000 };
        // Stable default: monitor is loaded but OFF. Enable from console when needed:
        //   VP_WRITE_MONITOR.enable()
        // or persist auto-enable:
        //   localStorage.setItem('vp-write-monitor', 'quiet')
        if (!flag || flag === '0' || flag === 'false' || flag === 'off') return null;
        if (flag === 'quiet') return { summaryEveryMs: 0 };
        if (flag === 'verbose') return { summaryEveryMs: 5000, logEach: true };
        if (flag === 'stack') return { summaryEveryMs: 5000, stack: true };
        return { summaryEveryMs: 5000 };
    }

    const api = {
        version: state.version,
        get enabled() { return state.enabled; },
        get options() { return { ...state.options }; },
        enable,
        disable,
        reset,
        report,
        summary: () => summary(true),
        rows,
        exportJson,
        wrapDb,
        help() {
            console.log(`VP Write Monitor commands:\n\n  VP_WRITE_MONITOR.enable({ summaryEveryMs: 5000 })\n  VP_WRITE_MONITOR.enable({ logEach: true, stack: true })\n  VP_WRITE_MONITOR.report()\n  VP_WRITE_MONITOR.reset()\n  VP_WRITE_MONITOR.disable()\n\nAuto-enable on reload:\n  localStorage.setItem('vp-write-monitor', '1')      // periodic summary\n  localStorage.setItem('vp-write-monitor', 'quiet')  // enabled, no periodic spam\n  localStorage.setItem('vp-write-monitor', 'stack')  // keep stack samples\n  localStorage.setItem('vp-write-monitor', 'off')      // off after reload\n`);
            return api;
        },
    };

    window[API_NAME] = api;

    const auto = autoOptionsFromStorage();
    if (auto) {
        // Let the current script chain finish installing VP_DB/Neutralino wrappers.
        setTimeout(() => enable(auto), 0);
    } else {
        console.info('[VP Write Monitor] loaded but off. Run VP_WRITE_MONITOR.help()');
    }
})();
