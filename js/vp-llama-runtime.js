// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-llama-runtime.js                                             ║
// ║  Visual Projector — Local llama-server (Router Mode) Runtime     ║
// ║                                                                  ║
// ║  Owns: spawning/stopping bin/llama.cpp/llama-server.exe via      ║
// ║  Neutralino, router API (/v1/models, /models/load, /models/      ║
// ║  unload, /slots?autoload=false, /props?autoload=false), live     ║
// ║  context window tracking (n_ctx), reasoning_effort helper, and   ║
// ║  guaranteed process-tree cleanup on window close.                ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const DEFAULT_LLAMA = {
        binPath: 'bin/llama.cpp/llama-server.exe',
        presetPath: 'bin/llama.cpp/models.ini',
        port: 1234,
        modelsMax: 1,
        autoStart: false,
    };

    const MAX_LOG_LINES = 80;
    const SESSION_MANAGED_KEY = 'vp_llama_managed';

    function saveManagedSession(pid, port) {
        try {
            if (!pid) { sessionStorage.removeItem(SESSION_MANAGED_KEY); return; }
            sessionStorage.setItem(SESSION_MANAGED_KEY, JSON.stringify({
                pid: Number(pid) || null,
                port: Number(port) || null,
                nlPid: Number(window.NL_PID) || null,
            }));
        } catch {}
    }

    function readManagedSession() {
        try {
            const raw = sessionStorage.getItem(SESSION_MANAGED_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || !parsed.pid) return null;
            const curNlPid = Number(window.NL_PID) || null;
            if (curNlPid && parsed.nlPid && parsed.nlPid !== curNlPid) {
                sessionStorage.removeItem(SESSION_MANAGED_KEY);
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    function clearManagedSession() {
        try { sessionStorage.removeItem(SESSION_MANAGED_KEY); } catch {}
    }

    function encodePowerShellCommand(script) {
        const s = String(script || '');
        const bytes = new Uint8Array(s.length * 2);
        for (let i = 0; i < s.length; i++) {
            const code = s.charCodeAt(i);
            bytes[i * 2] = code & 0xff;
            bytes[i * 2 + 1] = (code >> 8) & 0xff;
        }
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    }

    // Windows safety net: if the Neutralino host process (NL_PID) terminates
    // unexpectedly (Task Manager, crash, or native close bypassing JS), kill
    // the llama-server process tree (/T) immediately so RAM & VRAM are freed.
    // Exits cleanly on its own as soon as llama-server stops normally.
    function spawnParentWatchdog(parentPid, childPid) {
        if (!isWindows() || !window.Neutralino?.os?.execCommand) return;
        const pId = parseInt(parentPid, 10);
        const cId = parseInt(childPid, 10);
        if (!Number.isInteger(pId) || pId <= 0 || !Number.isInteger(cId) || cId <= 0) return;

        const ps = [
            `$p = Get-Process -Id ${pId} -ErrorAction SilentlyContinue`,
            `$c = Get-Process -Id ${cId} -ErrorAction SilentlyContinue`,
            'if ($p -and $c) {',
            '  while (!$p.HasExited -and !$c.HasExited) { Start-Sleep -Milliseconds 500 }',
            '  if ($p.HasExited -and !$c.HasExited) {',
            `    & taskkill.exe /PID ${cId} /T /F | Out-Null`,
            '  }',
            '}',
        ].join('; ');

        const encoded = encodePowerShellCommand(ps);
        const cmd = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
        Neutralino.os.execCommand(cmd, { background: true }).catch(err => {
            console.warn('[VP Llama] Watchdog launch warning:', err);
        });
    }

    const state = {
        status: 'offline',     // 'offline' | 'starting' | 'loading' | 'ready' | 'stopping' | 'error'
        managed: false,        // true if VP Studio spawned the process
        isRouter: false,       // true if /v1/models returns router status objects
        processId: null,       // Neutralino spawned process id
        pid: null,             // OS PID (for Windows taskkill /T safety net)
        models: [],            // [{ id, status, failed, exitCode, nCtx, isEmbedding }]
        loadedModelId: null,   // currently loaded (or loading) chat model id
        ctxByModel: {},        // { [modelId]: n_ctx }
        lastUsage: null,       // { used, promptTokens, completionTokens, tps, modelId, at }
        lastError: '',
        logs: [],              // rolling stdout/stderr lines
    };

    const listeners = new Set();
    let _spawnListenerBound = false;
    let _loadPollTimer = null;
    let _loadPollDeadline = 0;
    let _shutdownPromise = null;
    let _startPromise = null;
    let _logRemainder = '';
    let _configReadyHandled = false;

    function getStateRoot() {
        return window.VisualProjector?.state || null;
    }

    function getModelConfig() {
        const S = getStateRoot();
        return S?.modelConfig || {};
    }

    function getLlamaConfig() {
        const cfg = getModelConfig();
        const raw = (cfg && typeof cfg.llama === 'object' && cfg.llama) ? cfg.llama : {};
        const portNum = parseInt(raw.port, 10);
        const maxNum = parseInt(raw.modelsMax, 10);
        return {
            binPath: String(raw.binPath || DEFAULT_LLAMA.binPath).trim() || DEFAULT_LLAMA.binPath,
            presetPath: String(raw.presetPath || DEFAULT_LLAMA.presetPath).trim() || DEFAULT_LLAMA.presetPath,
            port: (Number.isFinite(portNum) && portNum > 0 && portNum < 65536) ? portNum : DEFAULT_LLAMA.port,
            modelsMax: (Number.isFinite(maxNum) && maxNum >= 0 && maxNum <= 16) ? maxNum : DEFAULT_LLAMA.modelsMax,
            autoStart: !!raw.autoStart,
        };
    }

    function getBaseUrl(endpointOverride = null) {
        const ep = String(endpointOverride ?? getModelConfig().endpoint ?? '').trim();
        if (ep) {
            try {
                const u = new URL(ep);
                return `${u.protocol}//${u.host}`;
            } catch {}
            const m = ep.match(/^(https?:\/\/[^/]+)/i);
            if (m) return m[1];
        }
        return `http://127.0.0.1:${getLlamaConfig().port}`;
    }

    function getManagedBaseUrl() {
        return `http://127.0.0.1:${getLlamaConfig().port}`;
    }

    function buildHeaders(withJson = false) {
        const headers = {};
        if (withJson) headers['Content-Type'] = 'application/json';
        const key = String(getModelConfig().apiKey || '').trim();
        if (key) headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
        return headers;
    }

    function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
        const fetcher = window.VisualProjector?.state?.originalFetch || window.fetch;
        if (!timeoutMs || typeof AbortController === 'undefined') {
            return fetcher(url, options);
        }
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), timeoutMs);
        const merged = { ...options, signal: ac.signal };
        return fetcher(url, merged).finally(() => clearTimeout(timer));
    }

    function pushLog(chunk) {
        if (!chunk) return;
        const clean = String(chunk).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        const combined = _logRemainder + clean;
        const parts = combined.split('\n');
        _logRemainder = parts.pop() || '';
        let added = false;
        for (const line of parts) {
            const trimmed = line.trimEnd();
            if (!trimmed) continue;
            state.logs.push(trimmed);
            added = true;
        }
        if (state.logs.length > MAX_LOG_LINES) {
            state.logs.splice(0, state.logs.length - MAX_LOG_LINES);
        }
        if (added) notify('log');
    }

    function getActiveContextSize(modelIdOverride = null) {
        const targetId = String(modelIdOverride || state.loadedModelId || getModelConfig().model || '').trim();
        if (targetId && state.ctxByModel[targetId] > 0) return state.ctxByModel[targetId];
        if (state.loadedModelId && state.ctxByModel[state.loadedModelId] > 0) return state.ctxByModel[state.loadedModelId];
        const loaded = state.models.find(m => m.status === 'loaded' && !m.isEmbedding && m.nCtx > 0);
        if (loaded) return loaded.nCtx;
        const anyCtx = Object.values(state.ctxByModel).find(v => Number(v) > 0);
        return anyCtx || null;
    }

    function getSnapshot() {
        return {
            status: state.status,
            managed: state.managed,
            isRouter: state.isRouter,
            processId: state.processId,
            pid: state.pid,
            baseUrl: getBaseUrl(),
            models: state.models.map(m => ({ ...m })),
            loadedModelId: state.loadedModelId,
            activeCtx: getActiveContextSize(),
            ctxByModel: { ...state.ctxByModel },
            lastUsage: state.lastUsage ? { ...state.lastUsage } : null,
            lastError: state.lastError,
            logsCount: state.logs.length,
        };
    }

    function notify(reason = 'state') {
        const snap = getSnapshot();
        for (const fn of Array.from(listeners)) {
            try { fn(snap, reason); } catch (err) {
                console.warn('[VP Llama] listener error:', err);
            }
        }
        try { window.VP_HUB?.emit?.('llama:status', snap); } catch {}
    }

    function onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        listeners.add(fn);
        return () => listeners.delete(fn);
    }

    // ── Path helpers (Windows-safe) ──────────────────────────────────
    function isWindows() {
        const os = String(window.NL_OS || navigator.platform || '').toLowerCase();
        return os.includes('win');
    }

    function isAbsolutePath(p) {
        return /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(String(p || '').trim());
    }

    function normalizeSlashes(p, win) {
        const s = String(p || '').trim();
        return win ? s.replace(/\//g, '\\') : s.replace(/\\/g, '/');
    }

    function joinPath(base, rel, win) {
        const sep = win ? '\\' : '/';
        const b = normalizeSlashes(base, win).replace(/[\\/]+$/, '');
        const r = normalizeSlashes(rel, win).replace(/^[\\/]+/, '');
        return b ? `${b}${sep}${r}` : r;
    }

    function dirName(p, win) {
        const s = normalizeSlashes(p, win).replace(/[\\/]+$/, '');
        const idx = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
        return idx > 0 ? s.slice(0, idx) : '';
    }

    function quoteArg(p) {
        const s = String(p || '');
        if (!s) return '""';
        if (/[\s"&|<>^()]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
        return s;
    }

    // ── Reasoning effort helper ──────────────────────────────────────
    // Maps VP Studio thinkingMode ('off' | 'low' | 'high' | 'default')
    // to OpenAI/llama-server reasoning_effort ('none' | 'low' | 'high' | null).
    // Passing overrideMode='off' (e.g. for tagger / JSON judge) forces 'none'
    // unless global thinkingMode is explicitly 'default' (compat mode).
    function getReasoningEffortForRequest(overrideMode = null) {
        const globalMode = String(getModelConfig().thinkingMode ?? 'off').toLowerCase();
        if (globalMode === 'default') return null;
        const mode = String(overrideMode || globalMode).toLowerCase();
        if (mode === 'off' || mode === 'none') return 'none';
        if (mode === 'low') return 'low';
        if (mode === 'high') return 'high';
        return null;
    }

    // ── Model list & Router status parsing ───────────────────────────
    function parseModelsPayload(payload) {
        const rawList = Array.isArray(payload?.data) ? payload.data
            : Array.isArray(payload?.models) ? payload.models
            : [];
        const secondaryById = new Map();
        if (Array.isArray(payload?.models) && Array.isArray(payload?.data)) {
            for (const m of payload.models) {
                const id = m?.id || m?.name || m?.model;
                if (id) secondaryById.set(id, m);
            }
        }

        let detectedRouter = false;
        const parsed = [];

        for (const entry of rawList) {
            if (!entry) continue;
            const id = typeof entry === 'string' ? entry : String(entry.id || entry.name || entry.model || '').trim();
            if (!id) continue;
            const extra = secondaryById.get(id) || {};
            const st = entry.status ?? extra.status;

            let statusVal = 'loaded';
            let failed = false;
            let exitCode = null;
            let args = [];

            if (st && typeof st === 'object') {
                detectedRouter = true;
                statusVal = String(st.value || 'unloaded').toLowerCase();
                failed = !!(st.failed || entry.failed || extra.failed);
                exitCode = st.exit_code ?? entry.exit_code ?? null;
                if (Array.isArray(st.args)) args = st.args;
            } else if (typeof st === 'string') {
                detectedRouter = true;
                statusVal = st.toLowerCase();
                failed = !!(entry.failed || extra.failed);
            }

            if (failed && statusVal === 'unloaded') statusVal = 'failed';

            const meta = entry.meta || extra.meta || {};
            // Only trust meta.n_ctx (allocated runtime context), NOT n_ctx_train.
            const metaCtx = Number(meta.n_ctx) || Number(entry.n_ctx) || Number(extra.n_ctx) || 0;
            const isEmbedding = /embed/i.test(id)
                || meta.embedding === true
                || args.some(a => a === '--embedding' || a === '--embeddings');

            parsed.push({
                id,
                status: statusVal,
                failed,
                exitCode,
                nCtx: (statusVal === 'loaded' && metaCtx > 0) ? metaCtx : 0,
                isEmbedding,
            });
        }

        return { models: parsed, isRouter: detectedRouter };
    }

    function stopLoadPolling() {
        if (_loadPollTimer) {
            clearInterval(_loadPollTimer);
            _loadPollTimer = null;
        }
    }

    function ensureLoadPolling(durationMs = 120000) {
        _loadPollDeadline = Math.max(_loadPollDeadline, Date.now() + durationMs);
        if (_loadPollTimer) return;
        _loadPollTimer = setInterval(async () => {
            if (Date.now() > _loadPollDeadline) {
                stopLoadPolling();
                return;
            }
            const res = await refreshModels({ silent: true });
            const stillLoading = state.models.some(m => m.status === 'loading');
            if (!res.ok || !stillLoading) {
                stopLoadPolling();
            }
        }, 1500);
    }

    async function fetchModelContext(modelId = null, opts = {}) {
        const base = opts.baseUrl || getBaseUrl();
        const targetId = String(modelId || state.loadedModelId || getModelConfig().model || '').trim();
        const entry = state.models.find(m => m.id === targetId) || null;

        // 1. Fast path: already reported via /v1/models meta.n_ctx
        if (entry && entry.nCtx > 0) {
            state.ctxByModel[entry.id] = entry.nCtx;
            notify('ctx');
            return entry.nCtx;
        }

        // 2. Safety guard in router mode: NEVER probe /slots or /props unless model is loaded
        //    AND always pass autoload=false so probing never triggers a cold VRAM load.
        if (state.isRouter) {
            if (!entry || entry.status !== 'loaded') return state.ctxByModel[targetId] || null;
        }

        const qs = (state.isRouter && targetId)
            ? `?model=${encodeURIComponent(targetId)}&autoload=false`
            : '';

        // 3. Try /slots first (reports exact fit-allocated per-slot n_ctx)
        try {
            const resp = await fetchWithTimeout(`${base}/slots${qs}`, {
                method: 'GET',
                headers: buildHeaders(false),
            }, 2500);
            if (resp.ok) {
                const slots = await resp.json();
                const list = Array.isArray(slots) ? slots : (Array.isArray(slots?.slots) ? slots.slots : []);
                const nCtx = Number(list[0]?.n_ctx) || 0;
                if (nCtx > 0) {
                    if (targetId) state.ctxByModel[targetId] = nCtx;
                    if (entry) entry.nCtx = nCtx;
                    notify('ctx');
                    return nCtx;
                }
            }
        } catch {}

        // 4. Fallback to /props
        try {
            const resp = await fetchWithTimeout(`${base}/props${qs}`, {
                method: 'GET',
                headers: buildHeaders(false),
            }, 2500);
            if (resp.ok) {
                const props = await resp.json();
                const nCtx = Number(props?.default_generation_settings?.n_ctx) || Number(props?.n_ctx) || 0;
                if (nCtx > 0) {
                    if (targetId) state.ctxByModel[targetId] = nCtx;
                    if (entry) entry.nCtx = nCtx;
                    notify('ctx');
                    return nCtx;
                }
            }
        } catch {}

        return (targetId && state.ctxByModel[targetId]) || null;
    }

    async function refreshModels(opts = {}) {
        const base = opts.baseUrl || getBaseUrl();
        const timeoutMs = opts.timeoutMs || 3000;
        let payload = null;
        let lastErr = null;

        for (const path of ['/v1/models', '/models']) {
            try {
                const resp = await fetchWithTimeout(`${base}${path}`, {
                    method: 'GET',
                    headers: buildHeaders(false),
                }, timeoutMs);
                if (!resp.ok) {
                    const txt = await resp.text().catch(() => '');
                    lastErr = new Error(`HTTP ${resp.status}: ${txt.slice(0, 160)}`);
                    continue;
                }
                payload = await resp.json();
                break;
            } catch (err) {
                lastErr = err;
            }
        }

        if (!payload) {
            if (!state.managed && state.status !== 'starting' && state.status !== 'stopping') {
                state.status = 'offline';
                state.models = [];
                state.loadedModelId = null;
                state.isRouter = false;
                if (!opts.silent) state.lastError = lastErr?.message || 'Server unreachable';
                notify('models');
            }
            return { ok: false, error: lastErr?.message || 'Server unreachable', models: [] };
        }

        const { models, isRouter } = parseModelsPayload(payload);
        state.models = models;
        state.isRouter = isRouter;
        state.lastError = '';

        // Cache any meta.n_ctx already reported
        for (const m of models) {
            if (m.status === 'loaded' && m.nCtx > 0) {
                state.ctxByModel[m.id] = m.nCtx;
            }
        }

        const loadingModel = models.find(m => m.status === 'loading');
        const loadedChat = models.find(m => m.status === 'loaded' && !m.isEmbedding)
            || models.find(m => m.status === 'loaded')
            || null;

        state.loadedModelId = loadingModel?.id || loadedChat?.id || null;

        if (state.status !== 'stopping') {
            state.status = loadingModel ? 'loading' : 'ready';
        }

        if (loadingModel) {
            ensureLoadPolling();
        }

        notify('models');

        // Fetch real fit-allocated n_ctx for loaded model if not yet cached
        if (loadedChat && !state.ctxByModel[loadedChat.id]) {
            fetchModelContext(loadedChat.id, { baseUrl: base }).catch(() => {});
        }

        return { ok: true, models: state.models.map(m => ({ ...m })), isRouter };
    }

    async function probe(opts = {}) {
        return refreshModels({ silent: true, timeoutMs: opts.timeoutMs || 1800, baseUrl: opts.baseUrl });
    }

    async function loadModel(modelId) {
        const id = String(modelId || getModelConfig().model || '').trim();
        if (!id) throw new Error('Model id is empty');
        const base = getBaseUrl();
        state.status = 'loading';
        state.loadedModelId = id;
        notify('loading');

        const resp = await fetchWithTimeout(`${base}/models/load`, {
            method: 'POST',
            headers: buildHeaders(true),
            body: JSON.stringify({ model: id }),
        }, 15000);

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            await refreshModels({ silent: true });
            throw new Error(`Load failed (HTTP ${resp.status}): ${txt.slice(0, 200)}`);
        }

        ensureLoadPolling();
        await refreshModels({ silent: true });
        return { ok: true, model: id };
    }

    async function unloadModel(modelId) {
        const id = String(modelId || state.loadedModelId || '').trim();
        if (!id) return { ok: true, skipped: true };
        const base = getBaseUrl();
        const resp = await fetchWithTimeout(`${base}/models/unload`, {
            method: 'POST',
            headers: buildHeaders(true),
            body: JSON.stringify({ model: id }),
        }, 10000);

        if (!resp.ok) {
            const txt = await resp.text().catch(() => '');
            throw new Error(`Unload failed (HTTP ${resp.status}): ${txt.slice(0, 200)}`);
        }

        delete state.ctxByModel[id];
        await refreshModels({ silent: true });
        return { ok: true, model: id };
    }

    async function unloadAll(opts = {}) {
        const waitMs = opts.waitMs ?? 10000;
        const base = opts.baseUrl || getBaseUrl();
        const res = await refreshModels({ silent: true, timeoutMs: 2500, baseUrl: base });
        if (!res.ok) {
            return { ok: false, reachable: false, unloadedIds: [], waitedMs: 0, error: res.error };
        }
        if (!res.isRouter) {
            return { ok: false, reachable: true, isRouter: false, unloadedIds: [], waitedMs: 0, error: 'Server is not in llama.cpp router mode' };
        }

        const active = res.models.filter(m => m.status === 'loaded' || m.status === 'loading' || m.status === 'sleeping');
        if (!active.length) {
            return { ok: true, reachable: true, isRouter: true, unloadedIds: [], waitedMs: 0 };
        }

        const unloadedIds = [];
        for (const m of active) {
            try {
                const resp = await fetchWithTimeout(`${base}/models/unload`, {
                    method: 'POST',
                    headers: buildHeaders(true),
                    body: JSON.stringify({ model: m.id }),
                }, 5000);
                if (resp.ok) {
                    unloadedIds.push(m.id);
                    delete state.ctxByModel[m.id];
                }
            } catch (err) {
                console.warn('[VP Llama] unload error for', m.id, err);
            }
        }

        // Wait until router reports all target models as unloaded so VRAM is actually free
        const started = Date.now();
        let allFree = false;
        while (Date.now() - started < waitMs) {
            await new Promise(r => setTimeout(r, 300));
            const check = await refreshModels({ silent: true, timeoutMs: 2000, baseUrl: base });
            if (!check.ok) { allFree = true; break; }
            const stillBusy = check.models.some(m =>
                unloadedIds.includes(m.id) && (m.status === 'loaded' || m.status === 'loading' || m.status === 'sleeping')
            );
            if (!stillBusy) {
                allFree = true;
                break;
            }
        }

        return {
            ok: allFree,
            reachable: true,
            isRouter: true,
            unloadedIds,
            waitedMs: Date.now() - started,
        };
    }

    // ── Process lifecycle (Neutralino) ───────────────────────────────
    function bindSpawnEvents() {
        if (_spawnListenerBound || !window.Neutralino?.events?.on) return;
        _spawnListenerBound = true;
        Neutralino.events.on('spawnedProcess', (evt) => {
            const d = evt?.detail;
            if (!d || state.processId == null || d.id != state.processId) return;
            if (d.action === 'stdOut' || d.action === 'stdErr') {
                pushLog(d.data || '');
            } else if (d.action === 'exit') {
                const code = d.data;
                pushLog(`[llama-server exited with code ${code}]\n`);
                const wasStarting = state.status === 'starting';
                const wasStopping = state.status === 'stopping';
                state.processId = null;
                state.pid = null;
                state.managed = false;
                clearManagedSession();
                state.models = [];
                state.loadedModelId = null;
                state.isRouter = false;
                stopLoadPolling();
                if (wasStarting && !wasStopping) {
                    state.status = 'error';
                    state.lastError = `llama-server exited prematurely (code ${code}). Check paths in models.ini / logs.`;
                } else {
                    state.status = 'offline';
                    state.lastError = '';
                }
                notify('exit');
            }
        });
    }

    async function start() {
        if (_startPromise) return _startPromise;
        _startPromise = (async () => {
            const cfg = getLlamaConfig();
            const managedBase = getManagedBaseUrl();

            // 1. Check if already running (managed or external)
            const existing = await probe({ baseUrl: managedBase, timeoutMs: 1500 });
            if (existing.ok) {
                // Keep managed=true if it was already our process (incl. F5 re-adopted PID), otherwise mark external
                if (state.processId == null && state.pid == null) state.managed = false;
                notify('ready');
                return { ok: true, alreadyRunning: true, managed: state.managed };
            }

            if (!window.Neutralino?.os?.spawnProcess) {
                state.status = 'error';
                state.lastError = 'Neutralino OS API unavailable (browser mode). Start llama-server manually.';
                notify('error');
                return { ok: false, error: state.lastError };
            }

            const win = isWindows();
            const nlCwd = window.NL_CWD || '';
            const exeAbs = isAbsolutePath(cfg.binPath)
                ? normalizeSlashes(cfg.binPath, win)
                : joinPath(nlCwd, cfg.binPath, win);
            const presetAbs = isAbsolutePath(cfg.presetPath)
                ? normalizeSlashes(cfg.presetPath, win)
                : joinPath(nlCwd, cfg.presetPath, win);
            const spawnCwd = dirName(exeAbs, win) || nlCwd || '.';

            // Verify binary exists if filesystem API is available
            if (window.Neutralino?.filesystem?.getStats) {
                try {
                    await Neutralino.filesystem.getStats(exeAbs);
                } catch {
                    state.status = 'error';
                    state.lastError = `Binary not found: ${exeAbs}`;
                    notify('error');
                    return { ok: false, error: state.lastError };
                }
                try {
                    await Neutralino.filesystem.getStats(presetAbs);
                } catch {
                    state.status = 'error';
                    state.lastError = `Preset not found: ${presetAbs}`;
                    notify('error');
                    return { ok: false, error: state.lastError };
                }
            }

            // Bind strictly to 127.0.0.1 (no LAN exposure; allows both localhost & 127.0.0.1 WebView origins)
            const cmd = [
                quoteArg(exeAbs),
                '--models-preset', quoteArg(presetAbs),
                '--models-max', String(cfg.modelsMax),
                '--host', '127.0.0.1',
                '--port', String(cfg.port),
            ].join(' ');

            state.logs = [];
            _logRemainder = '';
            state.lastError = '';
            state.status = 'starting';
            state.managed = true;
            pushLog(`$ ${cmd}\n(cwd: ${spawnCwd})\n`);
            notify('starting');

            bindSpawnEvents();

            try {
                const proc = await Neutralino.os.spawnProcess(cmd, { cwd: spawnCwd });
                state.processId = proc?.id ?? null;
                state.pid = proc?.pid ?? null;
                if (state.pid) {
                    saveManagedSession(state.pid, cfg.port);
                    spawnParentWatchdog(window.NL_PID, state.pid);
                }
                pushLog(`[spawned id=${state.processId} pid=${state.pid ?? '?'}]\n`);
            } catch (err) {
                state.status = 'error';
                state.managed = false;
                state.lastError = `spawnProcess failed: ${err?.message || err}`;
                pushLog(`[ERROR] ${state.lastError}\n`);
                notify('error');
                return { ok: false, error: state.lastError };
            }

            // Poll until router API answers (up to 25s) or process exits early
            const deadline = Date.now() + 25000;
            while (Date.now() < deadline) {
                if (state.processId == null) {
                    // Process exited during startup
                    return { ok: false, error: state.lastError || 'llama-server exited during startup' };
                }
                await new Promise(r => setTimeout(r, 400));
                const res = await refreshModels({ silent: true, timeoutMs: 1500, baseUrl: managedBase });
                if (res.ok) {
                    // Sync endpoint to managed port if still on default/empty
                    const mc = getModelConfig();
                    if (!mc.endpoint) {
                        mc.endpoint = `${managedBase}/v1/chat/completions`;
                    }
                    return { ok: true, managed: true, models: res.models };
                }
            }

            state.status = 'error';
            state.lastError = 'Timed out waiting for llama-server to answer on ' + managedBase;
            notify('error');
            return { ok: false, error: state.lastError };
        })().finally(() => {
            _startPromise = null;
        });
        return _startPromise;
    }

    async function stop(opts = {}) {
        const fast = !!opts.fast;
        stopLoadPolling();

        if (!state.managed || (state.processId == null && state.pid == null)) {
            return { ok: true, skipped: true };
        }

        const procId = state.processId;
        const osPid = state.pid;
        state.status = 'stopping';
        notify('stopping');

        // 1. Gracefully ask router to unload active child models so VRAM is cleanly released
        try {
            await unloadAll({ waitMs: fast ? 1500 : 3000, baseUrl: getManagedBaseUrl() });
        } catch {}

        // 2. Ask Neutralino to terminate the spawned process
        if (procId != null && window.Neutralino?.os?.updateSpawnedProcess) {
            try {
                await Neutralino.os.updateSpawnedProcess(procId, 'exit');
            } catch (err) {
                console.warn('[VP Llama] updateSpawnedProcess exit warning:', err);
            }
        }

        // 3. Windows safety net: kill entire process tree (/T) so router child llama-server never lingers in VRAM
        if (isWindows() && osPid && window.Neutralino?.os?.execCommand) {
            try {
                await Promise.race([
                    Neutralino.os.execCommand(`taskkill /PID ${Number(osPid)} /T /F`),
                    new Promise(r => setTimeout(r, 1500)),
                ]);
            } catch {}
        }

        state.processId = null;
        state.pid = null;
        state.managed = false;
        clearManagedSession();
        state.status = 'offline';
        state.models = [];
        state.loadedModelId = null;
        state.isRouter = false;
        state.lastError = '';
        notify('stopped');
        return { ok: true };
    }

    async function shutdown() {
        if (!state.managed && state.processId == null && state.pid == null) return;
        if (_shutdownPromise) return _shutdownPromise;
        _shutdownPromise = Promise.race([
            stop({ fast: true }).catch(() => {}),
            new Promise(r => setTimeout(r, 3200)),
        ]);
        return _shutdownPromise;
    }

    // ── Usage reporting from chat session ────────────────────────────
    function reportUsage(usage, modelId = null, timings = null) {
        if (!usage || typeof usage !== 'object') return;
        const promptTokens = Number(usage.prompt_tokens) || 0;
        const completionTokens = Number(usage.completion_tokens) || 0;
        const used = (promptTokens + completionTokens) || Number(usage.total_tokens) || 0;
        const tps = Number(timings?.predicted_per_second) || null;
        const resolvedModel = String(modelId || state.loadedModelId || getModelConfig().model || '').trim();

        state.lastUsage = {
            used,
            promptTokens,
            completionTokens,
            tps: tps ? Math.round(tps * 10) / 10 : null,
            modelId: resolvedModel,
            at: Date.now(),
        };
        notify('usage');

        // After a real completion, the model is definitely loaded — refresh n_ctx if unknown
        if (resolvedModel && !state.ctxByModel[resolvedModel]) {
            refreshModels({ silent: true }).then(() => fetchModelContext(resolvedModel)).catch(() => {});
        }
    }

    function clearUsage() {
        state.lastUsage = null;
        notify('usage');
    }

    function getLogs() {
        return state.logs.slice();
    }

    function clearLogs() {
        state.logs = [];
        _logRemainder = '';
        notify('log');
    }

    // Called by projector-session.js after persistent modelConfig has hydrated
    async function onConfigReady() {
        if (_configReadyHandled) return;
        _configReadyHandled = true;
        try {
            if (window.VP_NATIVE_READY) await window.VP_NATIVE_READY;
        } catch {}

        const res = await probe({ timeoutMs: 1500 });
        if (res.ok) {
            // Re-adopt a server we spawned before an F5 page reload in the same Neutralino host
            const saved = readManagedSession();
            if (saved?.pid && (!saved.port || saved.port === getLlamaConfig().port)) {
                state.managed = true;
                state.pid = saved.pid;
                notify('reattached');
            }
        } else {
            clearManagedSession();
            if (getLlamaConfig().autoStart && window.Neutralino?.os?.spawnProcess) {
                console.log('[VP Llama] Auto-starting local llama-server…');
                start().catch(err => console.warn('[VP Llama] Auto-start failed:', err));
            }
        }
    }

    // Formatting helper shared by Log toolbar & Topbar pill
    function formatCompactTokens(n) {
        const v = Number(n) || 0;
        if (v >= 100000) return `${Math.round(v / 1000)}k`;
        if (v >= 10000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
        return String(Math.round(v));
    }

    window.VP_LLAMA = {
        DEFAULT_LLAMA,
        getState: getSnapshot,
        getConfig: getLlamaConfig,
        getBaseUrl,
        getActiveContextSize,
        getReasoningEffortForRequest,
        getLogs,
        clearLogs,
        onChange,
        onConfigReady,
        probe,
        start,
        stop,
        shutdown,
        refreshModels,
        fetchModelContext,
        loadModel,
        unloadModel,
        unloadAll,
        reportUsage,
        clearUsage,
        formatCompactTokens,
    };
})();
