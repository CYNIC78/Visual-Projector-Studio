// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-dirty-tracker.js                                            ║
// ║  Visual Projector — RAM-first dirty-tracking persistence layer   ║
// ║                                                                  ║
// ║  Goals:                                                          ║
// ║  - Tier 0: RAM is the source of truth                            ║
// ║  - Tier 1: Dirty scopes accumulate in memory                     ║
// ║  - Tier 2: FS/IDB flush only on timer, explicit save, or exit    ║
// ║  - Prevent disk thrashing from rapid state mutations             ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const DEFAULT_FLUSH_MS = 5000;
    const MAX_FLUSH_MS = 30000;
    const MIN_FLUSH_MS = 500;

    let _flushInterval = DEFAULT_FLUSH_MS;
    const _scopes = new Map(); // scope -> { data, flushFn, timer, pending, lastMark }
    let _globalTimer = null;
    let _isFlushing = false;
    let _flushAllPromise = null;

    function getNow() { return Date.now(); }

    function ensureScope(scope) {
        if (!_scopes.has(scope)) {
            _scopes.set(scope, {
                data: undefined,
                flushFn: null,
                timer: null,
                pending: false,
                lastMark: 0,
            });
        }
        return _scopes.get(scope);
    }

    /**
     * Mark a scope as dirty. The latest `data` is kept in memory.
     * `flushFn` is called later with that data. If flushFn changes between
     * marks, the newest one wins.
     */
    function markDirty(scope, data, flushFn) {
        const q = ensureScope(scope);
        q.data = data;
        if (typeof flushFn === 'function') q.flushFn = flushFn;
        q.pending = true;
        q.lastMark = getNow();

        if (q.timer) clearTimeout(q.timer);
        q.timer = setTimeout(() => {
            q.timer = null;
            flushScope(scope);
        }, _flushInterval);

        // Global safety net: if no scope flushes itself, flush everything.
        if (_globalTimer) clearTimeout(_globalTimer);
        _globalTimer = setTimeout(() => {
            _globalTimer = null;
            flushAll();
        }, _flushInterval);
    }

    /**
     * Immediately flush a single scope if it is pending.
     */
    async function flushScope(scope) {
        const q = _scopes.get(scope);
        if (!q || !q.pending || typeof q.flushFn !== 'function') return;
        q.pending = false;
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
        const data = q.data;
        try {
            await q.flushFn(data);
        } catch (err) {
            console.warn(`[VP DirtyTracker] Flush failed for "${scope}":`, err);
            // Re-mark as dirty so the next auto-flush retries
            q.pending = true;
        }
    }

    /**
     * Flush all pending scopes sequentially.
     */
    async function flushAll() {
        if (_isFlushing) {
            // Return the in-flight promise so callers can await it
            return _flushAllPromise;
        }
        _isFlushing = true;
        if (_globalTimer) { clearTimeout(_globalTimer); _globalTimer = null; }

        const pendingScopes = Array.from(_scopes.entries())
            .filter(([, q]) => q.pending)
            .map(([s]) => s);

        _flushAllPromise = (async () => {
            for (const scope of pendingScopes) {
                await flushScope(scope);
            }
        })();

        try { await _flushAllPromise; }
        finally {
            _isFlushing = false;
            _flushAllPromise = null;
        }
    }

    /**
     * Cancel a pending scope without flushing.
     */
    function cancelScope(scope) {
        const q = _scopes.get(scope);
        if (!q) return;
        q.pending = false;
        if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    }

    function isPending(scope) {
        return !!_scopes.get(scope)?.pending;
    }

    function getPendingScopes() {
        return Array.from(_scopes.entries())
            .filter(([, q]) => q.pending)
            .map(([s]) => s);
    }

    function setFlushInterval(ms) {
        _flushInterval = Math.max(MIN_FLUSH_MS, Math.min(MAX_FLUSH_MS, Number(ms) || DEFAULT_FLUSH_MS));
    }

    function getFlushInterval() {
        return _flushInterval;
    }

    // Graceful exit flush
    window.addEventListener('beforeunload', (e) => {
        const pending = getPendingScopes();
        if (pending.length > 0) {
            // Synchronous best-effort: modern browsers allow async in beforeunload
            // but we fire it and hope. For Neutralino we also hook app exit.
            flushAll();
        }
    });

    window.VP_DIRTY_TRACKER = {
        markDirty,
        flushScope,
        flushAll,
        cancelScope,
        isPending,
        getPendingScopes,
        setFlushInterval,
        getFlushInterval,
    };

    console.log('[VP DirtyTracker] RAM-first persistence layer ready. Flush interval:', _flushInterval, 'ms');
})();
