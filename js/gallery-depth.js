// ╔══════════════════════════════════════════════════════════════════╗
// ║  gallery-depth.js                                                ║
// ║  Visual Projector — Gallery satellite: DEPTH-ANYTHING CLI        ║
// ║                                                                  ║
// ║  Owns: da3-cli spawn/exec bridge (Neutralino os API), depth      ║
// ║        sidecar storage wiring (via VP_DB native helpers), CLI    ║
// ║        output parsing, hub progress events, per-asset depthMap    ║
// ║        lifecycle for the depth renderer.                         ║
// ║                                                                  ║
// ║  Extracted from projector-gallery.js (v02 refactor) — body is    ║
// ║  byte-identical; only host functions go through the deps proxy.  ║
// ║                                                                  ║
// ║  Load order: visual-projector.js → gallery-depth.js              ║
// ║              → projector-gallery.js                              ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP GalleryDepth] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE gallery-depth.js.'
        );
        return;
    }

    const S  = VP.state;          // shared state (by reference)
    const DB = window.VP_DB;      // storage layer (vp-storage.js)

    const showToast         = VP.showToast         || ((m) => console.warn('[toast]', m));

    // ── HOST DEPENDENCIES (injected by projector-gallery.js via init) ───────
    let _deps = null;
    const resolveGalleryTag = (...a) => _deps.resolveGalleryTag(...a);
    const getPublicAssetDescriptor = (...a) => _deps.getPublicAssetDescriptor(...a);
    const persistAsset = (...a) => _deps.persistAsset(...a);
    const renderGalleryGrid = (...a) => _deps.renderGalleryGrid(...a);
    const updateGalleryFooter = (...a) => _deps.updateGalleryFooter(...a);

    function getDepthAnythingConfig() {
        const root = window.NL_CWD || window.NL_PATH || '.';
        return {
            executablePath: `${root}/bin/depth-anything/da3-cli.exe`,
            modelPath: `${root}/bin/depth-anything/models/depth-anything-base-q8_0.gguf`,
            modelName: 'depth-anything-base-q8_0.gguf',
            threads: 6,
        };
    }

    function toNativePath(path) {
        const value = String(path || '');
        const isWin = String(window.NL_OS || '').toLowerCase().includes('windows') || /^[a-zA-Z]:\//.test(value);
        return isWin ? value.replace(/\//g, '\\') : value;
    }

    function quoteArg(value) {
        return `"${String(value || '').replace(/"/g, '\"')}"`;
    }

    function parseDepthCliOutput(text) {
        const raw = String(text || '');
        const m = raw.match(/depth\s+(\d+)x(\d+)\s+min=([\d.+-eE]+)\s+max=([\d.+-eE]+)/i);
        return m ? {
            width: Number(m[1]) || null,
            height: Number(m[2]) || null,
            min: Number(m[3]),
            max: Number(m[4]),
        } : null;
    }

    async function runDepthAnythingCli({ inputPath, outputPath, modelPath = null, threads = null } = {}) {
        if (!window.Neutralino?.os) throw new Error('Neutralino OS API is required for depth generation');
        const cfg = getDepthAnythingConfig();
        const exe = toNativePath(cfg.executablePath);
        const model = toNativePath(modelPath || cfg.modelPath);
        const input = toNativePath(inputPath);
        const output = toNativePath(outputPath);
        const t = Math.max(1, Math.min(64, Number(threads || cfg.threads) || 6));
        const cmd = `${quoteArg(exe)} depth --model ${quoteArg(model)} --input ${quoteArg(input)} --png ${quoteArg(output)} --threads ${t}`;
        const cwd = window.NL_CWD || '.';

        if (Neutralino.os.execCommand) {
            const result = await Neutralino.os.execCommand(cmd, { cwd });
            const exitCode = result?.exitCode ?? 0;
            const out = [result?.stdOut || result?.stdout || '', result?.stdErr || result?.stderr || ''].filter(Boolean).join('\\n');
            if (exitCode !== 0) throw new Error(`depth-anything.cpp exited with code ${exitCode}: ${out.slice(0, 800)}`);
            return { output: out, parsed: parseDepthCliOutput(out), command: cmd };
        }

        if (!Neutralino.os.spawnProcess || !Neutralino.events?.on) throw new Error('Neutralino execCommand/spawnProcess API is unavailable');
        const processInfo = await Neutralino.os.spawnProcess(cmd, { cwd });
        let fullOutput = '';
        await new Promise((resolve, reject) => {
            const onSpawnedProcess = (e) => {
                if (e.detail.id != processInfo.id) return;
                if (e.detail.action === 'stdOut' || e.detail.action === 'stdErr') fullOutput += e.detail.data || '';
                if (e.detail.action === 'exit') {
                    Neutralino.events.off?.('spawnedProcess', onSpawnedProcess);
                    const exitCode = e.detail.data;
                    if (exitCode === 0 || exitCode == null) resolve();
                    else reject(new Error(`depth-anything.cpp exited with code ${exitCode}: ${fullOutput.slice(0, 800)}`));
                }
            };
            Neutralino.events.on('spawnedProcess', onSpawnedProcess);
        });
        return { output: fullOutput, parsed: parseDepthCliOutput(fullOutput), command: cmd };
    }

    async function generateDepthSidecarForAsset(payload = {}) {
        const tag = resolveGalleryTag(payload.tag || payload.assetTag);
        if (!tag) throw new Error('gallery:depth-generate requires an existing asset tag');
        if (String(tag).startsWith('__')) throw new Error('System assets cannot have depth sidecars');
        const asset = S.gallery.get(tag);
        if (!asset) throw new Error(`Asset not found: ${tag}`);
        if (asset._draft) throw new Error('Draft assets must be applied before depth generation');
        if (asset.depthMap?.status === 'ready' && payload.force !== true) {
            return { ok: true, skipped: true, reason: 'already-ready', tag, depthMap: asset.depthMap, asset: getPublicAssetDescriptor(asset) };
        }
        if (!asset.file) {
            const record = await persistAsset(asset);
            if (record?.file) asset.file = record.file;
        }
        if (!asset.file) throw new Error(`Asset has no persisted file: ${tag}`);

        const info = DB?.getBackendInfo?.();
        const worldRoot = info?.worldRoot;
        if (!worldRoot) throw new Error('Native worldRoot is unavailable');
        if (!DB?.ensureAssetDepthDir || !DB?.getAssetDepthPath || !DB?.makeAssetDepthFileName) {
            throw new Error('Depth sidecar storage helpers are unavailable');
        }

        await DB.ensureAssetDepthDir();
        const depthFile = DB.makeAssetDepthFileName(tag);
        const inputPath = `${worldRoot}/assets/files/${asset.file}`;
        const outputPath = DB.getAssetDepthPath(depthFile);
        const cfg = getDepthAnythingConfig();

        const hub = window.VP_HUB;
        try { hub?.emit?.('gallery:depth-item-started', { tag, inputPath, outputPath, model: cfg.modelName }, { moduleId: 'gallery' }); } catch {}
        showToast?.(`Depth: ${tag}…`, 'info');

        try {
            const startedAt = Date.now();
            const result = await runDepthAnythingCli({
                inputPath,
                outputPath,
                modelPath: payload.modelPath || cfg.modelPath,
                threads: payload.threads || cfg.threads,
            });
            const depthMap = {
                file: depthFile,
                kind: 'depth-anything.cpp',
                model: (payload.modelName || cfg.modelName),
                status: 'ready',
                width: result.parsed?.width || null,
                height: result.parsed?.height || null,
                min: Number.isFinite(result.parsed?.min) ? result.parsed.min : null,
                max: Number.isFinite(result.parsed?.max) ? result.parsed.max : null,
                generatedAt: Date.now(),
                durationMs: Date.now() - startedAt,
                inverted: false,
                strength: 0.035,
            };
            asset.depthMap = depthMap;
            await persistAsset(asset);
            renderGalleryGrid();
            updateGalleryFooter();
            showToast?.(`Depth ready: ${tag}`, 'success');
            try { hub?.emit?.('gallery:depth-item-completed', { tag, depthMap, durationMs: depthMap.durationMs }, { moduleId: 'gallery' }); } catch {}
            return { ok: true, tag, depthMap, asset: getPublicAssetDescriptor(asset), output: outputPath, cli: result.parsed };
        } catch (err) {
            asset.depthMap = {
                file: depthFile,
                kind: 'depth-anything.cpp',
                model: cfg.modelName,
                status: 'error',
                error: err?.message || String(err),
                updatedAt: Date.now(),
            };
            await persistAsset(asset);
            renderGalleryGrid();
            showToast?.(`Depth failed: ${err?.message || err}`, 'error');
            try { hub?.emit?.('gallery:depth-item-failed', { tag, error: err?.message || String(err) }, { moduleId: 'gallery' }); } catch {}
            throw err;
        }
    }

    // ── INIT / PUBLIC API ────────────────────────────────────────────────────
    const REQUIRED_DEPS = [
        'resolveGalleryTag', 'getPublicAssetDescriptor',
        'persistAsset', 'renderGalleryGrid', 'updateGalleryFooter',
    ];

    function init(deps) {
        const missing = REQUIRED_DEPS.filter(k => typeof deps?.[k] !== 'function');
        if (missing.length) {
            throw new Error('[VP GalleryDepth] init() missing deps: ' + missing.join(', '));
        }
        if (_deps) console.warn('[VP GalleryDepth] init() called twice — replacing deps.');
        _deps = deps;
        return {
            generateDepthSidecarForAsset, runDepthAnythingCli,
            getDepthAnythingConfig, parseDepthCliOutput,
        };
    }

    window.VP_GALLERY_DEPTH = { init };

})();
