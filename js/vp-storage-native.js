// ╔══════════════════════════════════════════════════════════════════╗
// ║ vp-storage-native.js                                            ║
// ║ Visual Projector — Neutralino filesystem storage backend         ║
// ║ v4: world-aware file storage                                     ║
// ║                                                                  ║
// ║ Drop-in override for window.VP_DB / window.VP_STORAGE.           ║
// ║ Loads AFTER vp-storage.js and BEFORE visual-projector.js.        ║
// ║ If Neutralino native API is unavailable, does nothing.           ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    if (!window.Neutralino || !Neutralino.filesystem) {
        console.warn('[VP Native Storage] Neutralino filesystem is not available; keeping IndexedDB fallback.');
        return;
    }

    const FS = Neutralino.filesystem;
    const nativeReady = window.VP_NATIVE_READY || Promise.resolve(true);

    const VALID_MODES = new Set(['persistent', 'semi-persistent', 'ephemeral']);
    const DEFAULT_WORLD_ID = 'default';
    const STORAGE_VERSION = 4;
    let _mode = 'persistent';
    let _activeWorldId = DEFAULT_WORLD_ID;
    let _initPromise = null;

    const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^([a-zA-Z]):\//, '$1:/');
    const join = (...parts) => norm(parts.filter(Boolean).join('/'));
    const dirname = (p) => { const x = norm(p); const i = x.lastIndexOf('/'); return i <= 0 ? '.' : x.slice(0, i); };
    const appRoot = () => norm(window.NL_CWD || window.NL_PATH || '.');
    const DATA_ROOT = () => join(appRoot(), 'data');
    const WORLD_ROOT = (id = _activeWorldId) => join(DATA_ROOT(), 'worlds', safeId(id || DEFAULT_WORLD_ID));

    const paths = {
        root: () => DATA_ROOT(),
        app: () => join(DATA_ROOT(), 'app.json'),
        worldsRoot: () => join(DATA_ROOT(), 'worlds'),
        worldsIndex: () => join(DATA_ROOT(), 'worlds', 'index.json'),
        library: () => join(DATA_ROOT(), 'library'),
        legacyGlobal: () => join(DATA_ROOT(), 'global'),
        legacyAssets: () => join(DATA_ROOT(), 'assets'),
        legacyAssetFiles: () => join(DATA_ROOT(), 'assets', 'files'),

        worldRoot: (id) => WORLD_ROOT(id),
        assets: () => join(WORLD_ROOT(), 'assets'),
        assetFiles: () => join(WORLD_ROOT(), 'assets', 'files'),
        worldInfo: () => join(WORLD_ROOT(), 'world.json'),
        config: () => join(WORLD_ROOT(), 'config.json'),
        galleryData: () => join(WORLD_ROOT(), 'gallery.json'),
        assetsMeta: () => join(WORLD_ROOT(), 'assets', 'assets.json'),
        projector: () => join(WORLD_ROOT(), 'projector.json'),
        windowGeom: () => join(WORLD_ROOT(), 'window.json'),
        panelGeom: () => join(WORLD_ROOT(), 'panel.json'),
        shell: () => join(WORLD_ROOT(), 'shell.json'),
        model: () => join(WORLD_ROOT(), 'model.json'),
        session: () => join(WORLD_ROOT(), 'session.json'),
        profiles: () => join(WORLD_ROOT(), 'profiles.json'),
        chats: () => join(WORLD_ROOT(), 'chats.json'),
        storageMode: () => join(WORLD_ROOT(), 'storage-mode.json'),
        customCss: () => join(WORLD_ROOT(), 'custom.css'),
        gamesRoot: () => join(WORLD_ROOT(), 'games'),
        gamesIndex: () => join(WORLD_ROOT(), 'games', 'index.json'),
        gameRoot: (gameId) => join(WORLD_ROOT(), 'games', safeId(gameId)),
        gameInfo: (gameId) => join(WORLD_ROOT(), 'games', safeId(gameId), 'vpgame.json'),
        gameState: (gameId) => join(WORLD_ROOT(), 'games', safeId(gameId), 'state.json'),
    };

    function normalizeMode(mode) {
        const m = String(mode || '').trim().toLowerCase();
        return VALID_MODES.has(m) ? m : 'persistent';
    }

    function shouldPersist(scope) {
        if (_mode === 'ephemeral') return false;
        if (_mode === 'semi-persistent') return !new Set(['session', 'projector-state']).has(scope);
        return true;
    }

    function clonePlain(value) {
        if (value == null) return value;
        try { return JSON.parse(JSON.stringify(value)); }
        catch { return value; }
    }

    function safeId(name) {
        return String(name || DEFAULT_WORLD_ID)
            .trim()
            .toLowerCase()
            .replace(/[\s\-\.]+/g, '_')
            .replace(/[^a-z0-9_]/g, '')
            .replace(/^_+|_+$/g, '')
            .slice(0, 48) || DEFAULT_WORLD_ID;
    }

    function titleToId(title) {
        let base = safeId(title || 'world');
        if (!base || base === 'world') base = `world_${Date.now().toString(36)}`;
        return base;
    }

    function extensionForMime(mime) {
        const m = String(mime || '').toLowerCase();
        if (m.includes('png')) return '.png';
        if (m.includes('webp')) return '.webp';
        if (m.includes('gif')) return '.gif';
        if (m.includes('bmp')) return '.bmp';
        return '.jpg';
    }

    function safeName(name) {
        return String(name || 'asset')
            .toLowerCase()
            .replace(/[^a-z0-9_\-.]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80) || 'asset';
    }

    function sanitizeAssetForStorage(asset) {
        if (!asset || !asset.tag) return null;
        const mime = asset.blob?.type || asset.mime || 'image/jpeg';
        return {
            tag: asset.tag,
            filename: asset.filename || asset.tag,
            path: asset.path || asset.filename || asset.tag,
            description: asset.description || '',
            hidden: !!asset.hidden,
            source: asset.source || 'user',
            folderContext: asset.folderContext || null,
            tabId: asset.tabId || null,
            collageMeta: clonePlain(asset.collageMeta || null),
            mime,
            file: asset.file || `${safeName(asset.tag)}${extensionForMime(mime)}`,
        };
    }

    async function exists(path) {
        try { await FS.getStats(path); return true; }
        catch { return false; }
    }

    async function ensureDir(path) {
        try { await FS.createDirectory(path); }
        catch (err) {
            if (!(await exists(path))) throw err;
        }
    }

    async function readText(path, fallback = '', ensure = true) {
        if (ensure) await ensureDirs();
        try { return await FS.readFile(path); }
        catch { return fallback; }
    }

    async function writeText(path, text) {
        await ensureDirs();
        await FS.writeFile(path, String(text || ''));
        return String(text || '');
    }

    async function readJson(path, fallback = null, ensure = true) {
        if (ensure) await ensureDirs();
        try {
            const text = await FS.readFile(path);
            if (!String(text || '').trim()) return fallback;
            return JSON.parse(text);
        } catch {
            return fallback;
        }
    }

    async function writeJson(path, data) {
        await ensureDirs();
        await FS.writeFile(path, JSON.stringify(data, null, 2));
        return data;
    }

    async function removeFile(path) {
        await ensureDirs();
        try { await FS.remove(path); } catch {}
    }

    async function writeJsonRaw(path, data) {
        await FS.writeFile(path, JSON.stringify(data, null, 2));
        return data;
    }

    async function readJsonRaw(path, fallback = null) {
        try {
            const text = await FS.readFile(path);
            if (!String(text || '').trim()) return fallback;
            return JSON.parse(text);
        } catch { return fallback; }
    }

    async function copyFileIfExists(src, dst) {
        if (!(await exists(src))) return false;
        try {
            if (FS.copy) await FS.copy(src, dst);
            else {
                const text = await FS.readFile(src);
                await FS.writeFile(dst, text);
            }
            return true;
        } catch {
            try {
                const bin = await FS.readBinaryFile(src);
                await FS.writeBinaryFile(dst, bin);
                return true;
            } catch (err) {
                console.warn('[VP Native Storage] copy failed:', src, '->', dst, err);
                return false;
            }
        }
    }

    async function copyBinaryIfExists(src, dst) {
        if (!(await exists(src))) return false;
        try {
            const bin = await FS.readBinaryFile(src);
            await FS.writeBinaryFile(dst, bin);
            return true;
        } catch (err) {
            console.warn('[VP Native Storage] binary copy failed:', src, '->', dst, err);
            return false;
        }
    }

    async function ensureWorldDirs(worldId = _activeWorldId) {
        await ensureDir(paths.worldRoot(worldId));
        await ensureDir(join(paths.worldRoot(worldId), 'assets'));
        await ensureDir(join(paths.worldRoot(worldId), 'assets', 'files'));
        await ensureDir(join(paths.worldRoot(worldId), 'games'));
    }

    async function loadAppRaw() {
        return await readJsonRaw(paths.app(), null);
    }

    async function saveAppRaw(app) {
        return await writeJsonRaw(paths.app(), app);
    }

    async function loadWorldIndexRaw() {
        return await readJsonRaw(paths.worldsIndex(), null);
    }

    async function saveWorldIndexRaw(index) {
        return await writeJsonRaw(paths.worldsIndex(), index);
    }

    function defaultWorldRecord() {
        const t = Date.now();
        return { id: DEFAULT_WORLD_ID, title: 'Default', description: 'Migrated/default world', createdAt: t, updatedAt: t };
    }

    async function hasLegacyFlatData() {
        const legacyFiles = ['config.json', 'gallery.json', 'projector.json', 'session.json', 'shell.json', 'chats.json', 'custom.css'];
        for (const f of legacyFiles) if (await exists(join(DATA_ROOT(), f))) return true;
        if (await exists(join(DATA_ROOT(), 'assets', 'assets.json'))) return true;
        if (await exists(join(DATA_ROOT(), 'global', 'model.json'))) return true;
        if (await exists(join(DATA_ROOT(), 'global', 'profiles.json'))) return true;
        return false;
    }

    async function migrateLegacyFlatDataToDefaultWorld() {
        const target = WORLD_ROOT(DEFAULT_WORLD_ID);
        const marker = join(target, '.legacy-migrated.json');
        if (await exists(marker)) return false;
        if (!(await hasLegacyFlatData())) return false;

        await ensureWorldDirs(DEFAULT_WORLD_ID);
        console.log('[VP Native Storage] migrating flat data/ into worlds/default/ ...');

        const simpleFiles = [
            'config.json', 'gallery.json', 'projector.json', 'session.json', 'shell.json',
            'chats.json', 'window.json', 'panel.json', 'storage-mode.json', 'custom.css'
        ];
        for (const f of simpleFiles) await copyFileIfExists(join(DATA_ROOT(), f), join(target, f));
        await copyFileIfExists(join(DATA_ROOT(), 'global', 'model.json'), join(target, 'model.json'));
        await copyFileIfExists(join(DATA_ROOT(), 'global', 'profiles.json'), join(target, 'profiles.json'));
        await copyFileIfExists(join(DATA_ROOT(), 'assets', 'assets.json'), join(target, 'assets', 'assets.json'));

        const meta = await readJsonRaw(join(DATA_ROOT(), 'assets', 'assets.json'), { items: [] });
        for (const item of (meta?.items || [])) {
            if (!item?.file) continue;
            await copyBinaryIfExists(join(DATA_ROOT(), 'assets', 'files', item.file), join(target, 'assets', 'files', item.file));
        }

        const t = Date.now();
        const existingInfo = await readJsonRaw(join(target, 'world.json'), null);
        if (!existingInfo) await writeJsonRaw(join(target, 'world.json'), { id: DEFAULT_WORLD_ID, title: 'Default', description: 'Migrated from old data layout', createdAt: t, updatedAt: t });
        await writeJsonRaw(marker, { migratedAt: t, from: 'flat-data-v3' });
        return true;
    }

    async function ensureWorldRegistry() {
        await ensureDir(paths.root());
        await ensureDir(paths.worldsRoot());
        await ensureDir(paths.library());

        let app = await loadAppRaw();
        let index = await loadWorldIndexRaw();
        if (!index || !Array.isArray(index.items)) {
            index = { version: 1, items: [defaultWorldRecord()] };
        }
        if (!index.items.some(w => w.id === DEFAULT_WORLD_ID)) index.items.unshift(defaultWorldRecord());

        const active = safeId(app?.activeWorldId || DEFAULT_WORLD_ID);
        _activeWorldId = index.items.some(w => w.id === active) ? active : DEFAULT_WORLD_ID;

        await ensureWorldDirs(_activeWorldId);
        await migrateLegacyFlatDataToDefaultWorld();

        const defaultRoot = WORLD_ROOT(DEFAULT_WORLD_ID);
        if (!(await exists(join(defaultRoot, 'world.json')))) {
            const rec = index.items.find(w => w.id === DEFAULT_WORLD_ID) || defaultWorldRecord();
            await writeJsonRaw(join(defaultRoot, 'world.json'), rec);
        }

        const t = Date.now();
        app = { version: STORAGE_VERSION, activeWorldId: _activeWorldId, updatedAt: t, ...(app || {}) };
        app.version = STORAGE_VERSION;
        app.activeWorldId = _activeWorldId;
        app.updatedAt = t;
        index.version = 1;
        index.items = index.items.map(w => ({ createdAt: t, updatedAt: t, description: '', ...w, id: safeId(w.id), title: w.title || w.id }));
        await saveAppRaw(app);
        await saveWorldIndexRaw(index);
    }

    function applyCustomCss(css) {
        let style = document.getElementById('vp-world-custom-style');
        if (!style) {
            style = document.createElement('style');
            style.id = 'vp-world-custom-style';
            document.head.appendChild(style);
        }
        style.textContent = String(css || '');
    }

    async function ensureDirs() {
        if (_initPromise) return _initPromise;
        _initPromise = (async () => {
            const ok = await nativeReady.catch(() => false);
            if (!ok && !(window.NL_TOKEN && window.NL_PORT)) {
                console.warn('[VP Native Storage] Native bridge did not report ready; trying filesystem anyway.');
            }
            await ensureWorldRegistry();
            try {
                const saved = await readJson(paths.storageMode(), null, false);
                _mode = normalizeMode(saved?.mode || 'persistent');
            } catch { _mode = 'persistent'; }
            try { applyCustomCss(await readText(paths.customCss(), '', false)); } catch {}
            console.log('[VP Native Storage] data root:', paths.root());
            console.log('[VP Native Storage] active world:', _activeWorldId, paths.worldRoot());
            return true;
        })();
        return _initPromise;
    }

    async function loadProjector() {
        return await readJson(paths.projector(), {});
    }

    let _pendingProjector = null;
    async function saveProjectorPatch(patch) {
        if (!shouldPersist('projector-state')) return patch;
        if (!_pendingProjector) {
            _pendingProjector = await loadProjector();
        }
        Object.assign(_pendingProjector, patch, { updatedAt: Date.now() });
        if (window.VP_DIRTY_TRACKER) {
            window.VP_DIRTY_TRACKER.markDirty('projector', _pendingProjector, async (data) => {
                await writeJson(paths.projector(), clonePlain(data));
                _pendingProjector = null;
            });
        } else {
            await writeJson(paths.projector(), clonePlain(_pendingProjector));
            _pendingProjector = null;
        }
        return _pendingProjector;
    }

    // ════════════════════════════════════════════════════════════════
    //  ASSET BATCH QUEUE (RAM-first)
    //  Accumulate put/delete ops in memory; flush to FS every 3 s.
    // ════════════════════════════════════════════════════════════════
    const _assetQueue = new Map(); // tag -> { type: 'put'|'delete', asset? }
    let _assetFlushTimer = null;

    function scheduleAssetFlush() {
        if (_assetFlushTimer) clearTimeout(_assetFlushTimer);
        _assetFlushTimer = setTimeout(() => {
            _assetFlushTimer = null;
            flushAssetQueue();
        }, 3000);
    }

    async function flushAssetQueue() {
        if (_assetFlushTimer) { clearTimeout(_assetFlushTimer); _assetFlushTimer = null; }
        const queue = Array.from(_assetQueue.entries());
        if (!queue.length) return;
        _assetQueue.clear();

        const puts = queue.filter(([, v]) => v.type === 'put').map(([, v]) => v.asset);
        const deletes = queue.filter(([, v]) => v.type === 'delete').map(([tag]) => tag);

        if (puts.length) {
            const meta = await readJson(paths.assetsMeta(), { items: [] });
            if (!Array.isArray(meta.items)) meta.items = [];
            for (const record of puts) {
                if (!record) continue;
                // Note: the asset blob must be present at queue time; we do not retain blobs in memory.
                // If the caller already discarded the blob, the write will skip binary.
                // Gallery module retains blobs on assets, so this is safe for normal use.
                const idx = meta.items.findIndex(x => x.tag === record.tag);
                if (idx >= 0) meta.items[idx] = record;
                else meta.items.push(record);
            }
            meta.updatedAt = Date.now();
            await writeJson(paths.assetsMeta(), meta);
        }

        if (deletes.length) {
            const meta = await readJson(paths.assetsMeta(), { items: [] });
            const items = Array.isArray(meta.items) ? meta.items : [];
            for (const tag of deletes) {
                const rec = items.find(x => x.tag === tag);
                meta.items = items.filter(x => x.tag !== tag);
                if (rec?.file) await removeFile(join(paths.assetFiles(), rec.file));
            }
            meta.updatedAt = Date.now();
            await writeJson(paths.assetsMeta(), meta);
        }
    }

    async function putAsset(asset) {
        await ensureDirs();
        const record = sanitizeAssetForStorage(asset);
        if (!record) return null;
        if (!shouldPersist('gallery-assets')) return record;

        // Binary is written immediately because we cannot hold Blobs in the
        // deferred queue safely (callers may mutate/release them). Metadata
        // is batched.
        if (asset.blob) {
            const buffer = await asset.blob.arrayBuffer();
            await FS.writeBinaryFile(join(paths.assetFiles(), record.file), buffer);
        }

        _assetQueue.set(record.tag, { type: 'put', asset: record });
        scheduleAssetFlush();
        return record;
    }

    async function bulkPutAssets(assets) {
        const out = [];
        for (const asset of assets || []) {
            const saved = await putAsset(asset);
            if (saved) out.push(saved);
        }
        return out;
    }

    async function getAllAssets() {
        await flushAssetQueue(); // ensure pending metadata writes are visible
        await ensureDirs();
        const meta = await readJson(paths.assetsMeta(), { items: [] });
        const items = Array.isArray(meta.items) ? meta.items : [];
        const out = [];
        for (const item of items) {
            try {
                const filePath = join(paths.assetFiles(), item.file || `${safeName(item.tag)}.jpg`);
                const buffer = await FS.readBinaryFile(filePath);
                const blob = new Blob([buffer], { type: item.mime || 'image/jpeg' });
                out.push({ ...item, blob, url: URL.createObjectURL(blob) });
            } catch (err) {
                console.warn('[VP Native Storage] Failed to read asset file:', item.tag, err);
            }
        }
        return out;
    }

    async function deleteAsset(tag) {
        await ensureDirs();
        if (_assetQueue.has(tag)) {
            _assetQueue.set(tag, { type: 'delete' });
            scheduleAssetFlush();
            return;
        }
        const meta = await readJson(paths.assetsMeta(), { items: [] });
        const items = Array.isArray(meta.items) ? meta.items : [];
        const rec = items.find(x => x.tag === tag);
        meta.items = items.filter(x => x.tag !== tag);
        meta.updatedAt = Date.now();
        await writeJson(paths.assetsMeta(), meta);
        if (rec?.file) await removeFile(join(paths.assetFiles(), rec.file));
    }

    async function bulkDeleteAssets(tags) {
        for (const tag of tags || []) {
            _assetQueue.set(tag, { type: 'delete' });
        }
        if ((tags || []).length) scheduleAssetFlush();
    }

    async function clearScope(scope) {
        if (scope === 'session') await removeFile(paths.session());
        if (scope === 'projector-state') await removeFile(paths.projector());
    }

    function getBackendInfo() {
        return {
            backend: 'neutralino-filesystem-worlds',
            native: true,
            ready: !!(window.NL_TOKEN && window.NL_PORT),
            appRoot: appRoot(),
            dataRoot: paths.root(),
            worldId: _activeWorldId,
            worldRoot: paths.worldRoot(),
            mode: _mode,
        };
    }

    async function openDataFolder() {
        await ensureDirs();
        if (window.Neutralino?.os?.open) return Neutralino.os.open(paths.root());
        return false;
    }

    async function openWorldFolder(worldId = _activeWorldId) {
        await ensureDirs();
        const root = paths.worldRoot(worldId);
        await ensureWorldDirs(worldId);
        if (window.Neutralino?.os?.open) return Neutralino.os.open(root);
        return false;
    }

    async function getCustomCss() {
        await ensureDirs();
        return readText(paths.customCss(), '');
    }

    async function setCustomCss(css) {
        applyCustomCss(css); // Apply to DOM synchronously immediately to prevent visual race conditions
        if (window.VP_DIRTY_TRACKER) {
            window.VP_DIRTY_TRACKER.markDirty('custom-css', css, async (text) => {
                try { await writeText(paths.customCss(), text || ''); }
                catch (err) { console.error('[VP Native Storage] Failed to write custom CSS:', err); }
            });
        } else {
            try { await writeText(paths.customCss(), css || ''); }
            catch (err) { console.error('[VP Native Storage] Failed to write custom CSS:', err); }
        }
        return css;
    }

    async function listWorlds() {
        await ensureDirs();
        const index = await readJson(paths.worldsIndex(), { items: [] });
        return (index.items || []).map(w => ({ ...w, active: w.id === _activeWorldId }));
    }

    async function getActiveWorld() {
        await ensureDirs();
        const worlds = await listWorlds();
        return worlds.find(w => w.id === _activeWorldId) || { id: _activeWorldId, title: _activeWorldId, active: true };
    }

    async function createWorld(opts = {}) {
        await ensureDirs();
        const index = await readJson(paths.worldsIndex(), { version: 1, items: [] });
        const title = String(opts.title || 'New World').trim() || 'New World';
        let id = safeId(opts.id || titleToId(title));
        const base = id;
        let n = 2;
        while ((index.items || []).some(w => w.id === id)) id = `${base}_${n++}`.slice(0, 48);
        const t = Date.now();
        const rec = { id, title, description: String(opts.description || ''), createdAt: t, updatedAt: t };
        index.items = [...(index.items || []), rec];
        await saveWorldIndexRaw(index);
        await ensureWorldDirs(id);
        await writeJsonRaw(join(WORLD_ROOT(id), 'world.json'), rec);
        // Light bootstrap files keep the folder understandable even before first save.
        await writeJsonRaw(join(WORLD_ROOT(id), 'gallery.json'), { categories: [], tabs: [], activeTabId: null });
        await writeJsonRaw(join(WORLD_ROOT(id), 'assets', 'assets.json'), { items: [], updatedAt: t });
        await writeJsonRaw(join(WORLD_ROOT(id), 'chats.json'), { activeChatId: null, items: [] });
        return rec;
    }

    async function renameWorld(worldId, title) {
        await ensureDirs();
        const id = safeId(worldId);
        const index = await readJson(paths.worldsIndex(), { version: 1, items: [] });
        const rec = (index.items || []).find(w => w.id === id);
        if (!rec) return null;
        rec.title = String(title || rec.title || id).trim() || id;
        rec.updatedAt = Date.now();
        await saveWorldIndexRaw(index);
        const infoPath = join(WORLD_ROOT(id), 'world.json');
        const info = await readJsonRaw(infoPath, rec);
        await writeJsonRaw(infoPath, { ...info, title: rec.title, updatedAt: rec.updatedAt });
        return rec;
    }

    async function setActiveWorld(worldId) {
        await ensureDirs();
        const id = safeId(worldId);
        const index = await readJson(paths.worldsIndex(), { items: [] });
        if (!(index.items || []).some(w => w.id === id)) throw new Error(`World not found: ${id}`);
        _activeWorldId = id;
        const app = await readJson(paths.app(), { version: STORAGE_VERSION });
        app.version = STORAGE_VERSION;
        app.activeWorldId = id;
        app.updatedAt = Date.now();
        await writeJson(paths.app(), app);
        return id;
    }

    async function duplicateWorld(worldId, title = null) {
        await ensureDirs();
        const srcId = safeId(worldId || _activeWorldId);
        const src = (await listWorlds()).find(w => w.id === srcId);
        if (!src) throw new Error(`World not found: ${srcId}`);
        const dst = await createWorld({ title: title || `${src.title || src.id} Copy` });
        const files = ['config.json','gallery.json','projector.json','session.json','shell.json','chats.json','window.json','panel.json','model.json','profiles.json','storage-mode.json','custom.css'];
        for (const f of files) await copyFileIfExists(join(WORLD_ROOT(srcId), f), join(WORLD_ROOT(dst.id), f));
        await copyFileIfExists(join(WORLD_ROOT(srcId), 'assets', 'assets.json'), join(WORLD_ROOT(dst.id), 'assets', 'assets.json'));
        const meta = await readJsonRaw(join(WORLD_ROOT(srcId), 'assets', 'assets.json'), { items: [] });
        for (const item of (meta?.items || [])) {
            if (item?.file) await copyBinaryIfExists(join(WORLD_ROOT(srcId), 'assets', 'files', item.file), join(WORLD_ROOT(dst.id), 'assets', 'files', item.file));
        }
        return dst;
    }



    async function deleteWorld(worldId) {
        await ensureDirs();
        const id = safeId(worldId);
        if (!id) throw new Error('World id is empty');
        const index = await readJson(paths.worldsIndex(), { version: 1, items: [] });
        const items = Array.isArray(index.items) ? index.items : [];
        if (items.length <= 1) throw new Error('Cannot delete the last world');
        if (id === DEFAULT_WORLD_ID) throw new Error('Default world is protected');
        const rec = items.find(w => w.id === id);
        if (!rec) throw new Error(`World not found: ${id}`);
        index.items = items.filter(w => w.id !== id);
        index.updatedAt = Date.now();
        await saveWorldIndexRaw(index);
        try { await FS.remove(WORLD_ROOT(id)); } catch (err) { console.warn('[VP Native Storage] world folder remove failed:', err); }
        if (_activeWorldId === id) {
            _activeWorldId = DEFAULT_WORLD_ID;
            const app = await readJson(paths.app(), { version: STORAGE_VERSION });
            app.activeWorldId = DEFAULT_WORLD_ID;
            app.updatedAt = Date.now();
            await writeJson(paths.app(), app);
        }
        return rec;
    }





    function ensureVpworldExtension(path) {
        return String(path || '').toLowerCase().endsWith('.vpworld') ? String(path) : `${path}.vpworld`;
    }

    function timestampForFile() {
        const d = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
    }

    function getEntryName(entry) {
        const raw = entry?.entry || entry?.name || entry?.path || '';
        return String(raw).replace(/\\/g, '/').split('/').filter(Boolean).pop() || '';
    }

    function isDirectoryEntry(entry) {
        const t = String(entry?.type || '').toUpperCase();
        return t.includes('DIR') || entry?.isDirectory === true;
    }

    async function addDirectoryToZip(zip, absDir, relDir = '') {
        let entries = [];
        try { entries = await FS.readDirectory(absDir); }
        catch (err) { throw new Error(`Cannot read directory ${absDir}: ${err.message || err}`); }
        for (const entry of entries || []) {
            const name = getEntryName(entry);
            if (!name || name === '.' || name === '..') continue;
            const abs = join(absDir, name);
            const rel = relDir ? `${relDir}/${name}` : name;
            if (isDirectoryEntry(entry)) {
                await addDirectoryToZip(zip, abs, rel);
                continue;
            }
            // Some Neutralino builds don't set entry.type reliably. Try dir read first
            // for ambiguous entries, otherwise treat as a binary file.
            if (!entry?.type && entry?.isFile !== true) {
                try {
                    await addDirectoryToZip(zip, abs, rel);
                    continue;
                } catch {}
            }
            try {
                const bin = await FS.readBinaryFile(abs);
                zip.file(rel, bin);
            } catch (err) {
                console.warn('[VP Native Storage] zip add file failed:', abs, err);
            }
        }
    }

    async function askSaveVpworldPath(world) {
        const title = safeName(world?.title || world?.id || 'world');
        const defaultName = `${title}.vpworld`;
        if (!window.Neutralino?.os?.showSaveDialog) return join(paths.root(), defaultName);
        const res = await Neutralino.os.showSaveDialog('Export Visual Projector world', {
            defaultPath: defaultName,
            filters: [{ name: 'Visual Projector World', extensions: ['vpworld'] }],
        });
        const selected = typeof res === 'string' ? res : (res?.selectedEntry || res?.file || res?.path || res?.filename || '');
        return selected ? ensureVpworldExtension(selected) : null;
    }

    async function buildWorldVpworld(worldId = _activeWorldId) {
        await ensureDirs();
        if (!window.JSZip) throw new Error('JSZip is not loaded. Missing js/vendor/jszip.min.js');
        const id = safeId(worldId || _activeWorldId);
        const worlds = await listWorlds();
        const world = worlds.find(w => w.id === id) || { id, title: id };
        const root = WORLD_ROOT(id);
        if (!(await exists(root))) throw new Error(`World folder not found: ${root}`);

        const zip = new JSZip();
        zip.file('vpworld.json', JSON.stringify({
            format: 'visual-projector-world',
            formatVersion: 1,
            app: 'Visual Projector',
            exportedAt: Date.now(),
            worldId: id,
            title: world.title || id,
            description: world.description || '',
        }, null, 2));
        await addDirectoryToZip(zip, root, 'world');
        const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        return { buffer, world };
    }

    async function exportWorld(worldId = _activeWorldId, targetPath = null) {
        await ensureDirs();
        const worlds = await listWorlds();
        const world = worlds.find(w => w.id === safeId(worldId || _activeWorldId)) || { id: worldId || _activeWorldId, title: worldId || _activeWorldId };
        const path = targetPath ? ensureVpworldExtension(targetPath) : await askSaveVpworldPath(world);
        if (!path) return null;
        const built = await buildWorldVpworld(world.id);
        await FS.writeBinaryFile(path, built.buffer);
        return { path, world: built.world, bytes: built.buffer.byteLength };
    }

    async function backupWorld(worldId = _activeWorldId) {
        await ensureDirs();
        await ensureDir(join(paths.root(), 'backups'));
        const worlds = await listWorlds();
        const world = worlds.find(w => w.id === safeId(worldId || _activeWorldId)) || { id: worldId || _activeWorldId, title: worldId || _activeWorldId };
        const filename = `${safeName(world.title || world.id)}_${timestampForFile()}.vpworld`;
        return exportWorld(world.id, join(paths.root(), 'backups', filename));
    }

    async function openBackupsFolder() {
        await ensureDirs();
        const dir = join(paths.root(), 'backups');
        await ensureDir(dir);
        if (window.Neutralino?.os?.open) return Neutralino.os.open(dir);
        return false;
    }



    async function askOpenVpworldPath() {
        if (!window.Neutralino?.os?.showOpenDialog) return null;
        const res = await Neutralino.os.showOpenDialog('Import Visual Projector world', {
            filters: [{ name: 'Visual Projector World', extensions: ['vpworld', 'zip'] }],
            multiple: false,
        });
        if (typeof res === 'string') return res || null;
        if (Array.isArray(res)) return res[0] || null;
        if (Array.isArray(res?.selectedEntries)) return res.selectedEntries[0] || null;
        return res?.selectedEntry || res?.file || res?.path || res?.filename || null;
    }

    function safeZipRelPath(path) {
        const rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const parts = rel.split('/').filter(Boolean);
        if (!parts.length) return '';
        if (parts.some(p => p === '..' || p.includes(':'))) return '';
        return parts.join('/');
    }

    async function importWorldFromFile(filePath = null) {
        await ensureDirs();
        if (!window.JSZip) throw new Error('JSZip is not loaded. Missing js/vendor/jszip.min.js');
        const path = filePath || await askOpenVpworldPath();
        if (!path) return null;

        const bin = await FS.readBinaryFile(path);
        const zip = await JSZip.loadAsync(bin);
        const manifestFile = zip.file('vpworld.json');
        if (!manifestFile) throw new Error('Invalid .vpworld: vpworld.json not found');
        const manifest = JSON.parse(await manifestFile.async('string'));
        if (manifest.format !== 'visual-projector-world') throw new Error('Invalid .vpworld format');

        const infoFile = zip.file('world/world.json');
        let worldInfo = null;
        if (infoFile) {
            try { worldInfo = JSON.parse(await infoFile.async('string')); } catch {}
        }
        const title = worldInfo?.title || manifest.title || manifest.worldId || 'Imported World';
        const rec = await createWorld({ title, description: worldInfo?.description || `Imported from ${path}` });
        const root = WORLD_ROOT(rec.id);
        await ensureWorldDirs(rec.id);

        const writes = [];
        zip.forEach((zipPath, file) => {
            if (file.dir) return;
            if (!zipPath.startsWith('world/')) return;
            const rel = safeZipRelPath(zipPath.slice('world/'.length));
            if (!rel) return;
            writes.push((async () => {
                const outPath = join(root, rel);
                await ensureDir(dirname(outPath));
                const data = await file.async('arraybuffer');
                await FS.writeBinaryFile(outPath, data);
            })());
        });
        await Promise.all(writes);

        const t = Date.now();
        const patchedInfo = {
            ...(worldInfo || {}),
            id: rec.id,
            title: title,
            importedAt: t,
            importedFrom: path,
            sourceWorldId: manifest.worldId || worldInfo?.id || null,
            updatedAt: t,
        };
        await writeJsonRaw(join(root, 'world.json'), patchedInfo);

        const index = await readJson(paths.worldsIndex(), { version: 1, items: [] });
        const idx = (index.items || []).findIndex(w => w.id === rec.id);
        if (idx >= 0) {
            index.items[idx] = { ...index.items[idx], title, description: patchedInfo.description || index.items[idx].description || '', updatedAt: t };
            await writeJson(paths.worldsIndex(), index);
        }

        return { world: { ...rec, title }, path, manifest };
    }



    async function ensureGamesIndex() {
        await ensureDirs();
        await ensureDir(paths.gamesRoot());
        let index = await readJson(paths.gamesIndex(), null);
        if (!index || !Array.isArray(index.items)) {
            index = { version: 1, items: [] };
            await writeJson(paths.gamesIndex(), index);
        }
        return index;
    }

    async function saveGamesIndex(index) {
        index.version = index.version || 1;
        index.updatedAt = Date.now();
        if (window.VP_DIRTY_TRACKER) {
            window.VP_DIRTY_TRACKER.markDirty('games-index', clonePlain(index), async (data) => {
                await writeJson(paths.gamesIndex(), data);
            });
        } else {
            await writeJson(paths.gamesIndex(), clonePlain(index));
        }
        return index;
    }

    async function listGames() {
        const index = await ensureGamesIndex();
        const items = [];
        for (const item of index.items || []) {
            const id = safeId(item.id);
            const info = await readJson(paths.gameInfo(id), null);
            items.push({ ...item, ...(info || {}), id });
        }
        return items.sort((a, b) => String(a.title || a.id).localeCompare(String(b.title || b.id)));
    }

    async function getGameInfo(gameId) {
        await ensureDirs();
        return readJson(paths.gameInfo(gameId), null);
    }

    async function readGameFile(gameId, relPath, fallback = '') {
        await ensureDirs();
        const rel = safeZipRelPath(relPath);
        if (!rel) throw new Error('Invalid game file path');
        return readText(join(paths.gameRoot(gameId), rel), fallback);
    }

    async function writeGameFile(gameId, relPath, data) {
        await ensureDirs();
        const rel = safeZipRelPath(relPath);
        if (!rel) throw new Error('Invalid game file path');
        const out = join(paths.gameRoot(gameId), rel);
        await ensureDir(dirname(out));
        return writeText(out, data);
    }

    async function readGameBinaryFile(gameId, relPath) {
        await ensureDirs();
        const rel = safeZipRelPath(relPath);
        if (!rel) throw new Error('Invalid game file path');
        return FS.readBinaryFile(join(paths.gameRoot(gameId), rel));
    }

    async function writeGameBinaryFile(gameId, relPath, data) {
        await ensureDirs();
        const rel = safeZipRelPath(relPath);
        if (!rel) throw new Error('Invalid game file path');
        const out = join(paths.gameRoot(gameId), rel);
        await ensureDir(dirname(out));
        await FS.writeBinaryFile(out, data);
        return true;
    }

    async function listGameFiles(gameId, relDir = '') {
        await ensureDirs();
        const rel = relDir ? safeZipRelPath(relDir) : '';
        const dir = rel ? join(paths.gameRoot(gameId), rel) : paths.gameRoot(gameId);
        let entries = [];
        try { entries = await FS.readDirectory(dir); } catch { return []; }
        return (entries || []).map(e => {
            const name = getEntryName(e);
            const type = isDirectoryEntry(e) ? 'directory' : 'file';
            return { name, type, path: rel ? `${rel}/${name}` : name };
        }).filter(e => e.name && e.name !== '.' && e.name !== '..');
    }

    async function getGameState(gameId, fallback = {}) {
        await ensureDirs();
        return readJson(paths.gameState(gameId), fallback);
    }

    async function setGameState(gameId, state) {
        await ensureDirs();
        await ensureDir(paths.gameRoot(gameId));
        const scope = `game-state:${gameId}`;
        if (window.VP_DIRTY_TRACKER) {
            window.VP_DIRTY_TRACKER.markDirty(scope, clonePlain(state || {}), async (data) => {
                await writeJson(paths.gameState(gameId), data);
            });
        } else {
            await writeJson(paths.gameState(gameId), clonePlain(state || {}));
        }
        return true;
    }

    async function openGameFolder(gameId) {
        await ensureDirs();
        await ensureDir(paths.gameRoot(gameId));
        if (window.Neutralino?.os?.open) return Neutralino.os.open(paths.gameRoot(gameId));
        return false;
    }

    async function openGamesFolder() {
        await ensureDirs();
        await ensureDir(paths.gamesRoot());
        if (window.Neutralino?.os?.open) return Neutralino.os.open(paths.gamesRoot());
        return false;
    }



    async function askOpenVpgamePath() {
        if (!window.Neutralino?.os?.showOpenDialog) return null;
        const res = await Neutralino.os.showOpenDialog('Import Visual Projector game', {
            filters: [{ name: 'Visual Projector Game', extensions: ['vpgame', 'zip'] }],
            multiple: false,
        });
        if (typeof res === 'string') return res || null;
        if (Array.isArray(res)) return res[0] || null;
        if (Array.isArray(res?.selectedEntries)) return res.selectedEntries[0] || null;
        return res?.selectedEntry || res?.file || res?.path || res?.filename || null;
    }

    async function importGameFromFile(filePath = null) {
        await ensureDirs();
        if (!window.JSZip) throw new Error('JSZip is not loaded. Missing js/vendor/jszip.min.js');
        const path = filePath || await askOpenVpgamePath();
        if (!path) return null;

        const bin = await FS.readBinaryFile(path);
        const zip = await JSZip.loadAsync(bin);
        const manifestFile = zip.file('vpgame.json');
        if (!manifestFile) throw new Error('Invalid .vpgame: vpgame.json not found');
        const manifest = JSON.parse(await manifestFile.async('string'));
        if (manifest.format !== 'visual-projector-game') throw new Error('Invalid .vpgame format');
        if (!manifest.entry && !manifest.scripts) throw new Error('Invalid .vpgame: entry or scripts required');

        const index = await ensureGamesIndex();
        let id = safeId(manifest.id || manifest.title || 'imported_game');
        const base = id;
        let n = 2;
        while ((index.items || []).some(g => g.id === id)) id = `${base}_${n++}`.slice(0, 48);

        const root = paths.gameRoot(id);
        await ensureDir(root);

        const writes = [];
        zip.forEach((zipPath, file) => {
            if (file.dir) return;
            const rel = safeZipRelPath(zipPath);
            if (!rel) return;
            writes.push((async () => {
                const outPath = join(root, rel);
                await ensureDir(dirname(outPath));
                const data = await file.async('arraybuffer');
                await FS.writeBinaryFile(outPath, data);
            })());
        });
        await Promise.all(writes);

        const t = Date.now();
        const patched = {
            ...manifest,
            id,
            importedAt: t,
            importedFrom: path,
            sourceGameId: manifest.id || null,
            updatedAt: t,
        };
        await writeJsonRaw(paths.gameInfo(id), patched);

        const row = { id, title: patched.title || id, version: patched.version || '0.0.0', updatedAt: t, importedAt: t };
        index.items = Array.isArray(index.items) ? index.items : [];
        index.items.push(row);
        await saveGamesIndex(index);
        return { game: row, manifest: patched, path };
    }


    async function askSaveVpgamePath(game) {
        const title = safeName(game?.title || game?.id || 'game');
        const defaultName = `${title}.vpgame`;
        if (!window.Neutralino?.os?.showSaveDialog) return join(paths.root(), defaultName);
        const res = await Neutralino.os.showSaveDialog('Export Visual Projector game', {
            defaultPath: defaultName,
            filters: [{ name: 'Visual Projector Game', extensions: ['vpgame'] }],
        });
        const selected = typeof res === 'string' ? res : (res?.selectedEntry || res?.file || res?.path || res?.filename || '');
        return selected ? (String(selected).toLowerCase().endsWith('.vpgame') ? selected : `${selected}.vpgame`) : null;
    }

    async function exportGame(gameId, targetPath = null, opts = {}) {
        await ensureDirs();
        if (!window.JSZip) throw new Error('JSZip is not loaded. Missing js/vendor/jszip.min.js');
        const id = safeId(gameId);
        const info = await getGameInfo(id);
        if (!info) throw new Error(`Game not found: ${id}`);
        const path = targetPath || await askSaveVpgamePath(info);
        if (!path) return null;

        const zip = new JSZip();
        const root = paths.gameRoot(id);
        const includeState = !!opts.includeState;
        const exportedAt = Date.now();

        const addGameDir = async (absDir, relDir = '') => {
            let entries = [];
            try { entries = await FS.readDirectory(absDir); }
            catch (err) { throw new Error(`Cannot read game directory ${absDir}: ${err.message || err}`); }
            for (const entry of entries || []) {
                const name = getEntryName(entry);
                if (!name || name === '.' || name === '..') continue;
                if (!includeState && name === 'state.json' && !relDir) continue;
                const abs = join(absDir, name);
                const rel = relDir ? `${relDir}/${name}` : name;
                if (isDirectoryEntry(entry)) {
                    await addGameDir(abs, rel);
                    continue;
                }
                if (!entry?.type && entry?.isFile !== true) {
                    try { await addGameDir(abs, rel); continue; } catch {}
                }
                const bin = await FS.readBinaryFile(abs);
                zip.file(rel, bin);
            }
        };
        await addGameDir(root, '');

        // Patch manifest metadata on export, while preserving the installed file.
        const manifestFile = zip.file('vpgame.json');
        let manifest = info;
        if (manifestFile) {
            try { manifest = JSON.parse(await manifestFile.async('string')); } catch {}
        }
        manifest = {
            ...manifest,
            format: 'visual-projector-game',
            formatVersion: manifest.formatVersion || 1,
            exportedAt,
            exportedFromWorld: _activeWorldId,
            packageIncludesState: includeState,
        };
        zip.file('vpgame.json', JSON.stringify(manifest, null, 2));
        const buffer = await zip.generateAsync({ type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        await FS.writeBinaryFile(path, buffer);
        return { path, game: manifest, bytes: buffer.byteLength, includeState };
    }


    async function deleteGame(gameId) {
        await ensureDirs();
        const id = safeId(gameId);
        if (!id) throw new Error('Game id is empty');
        const index = await ensureGamesIndex();
        const items = Array.isArray(index.items) ? index.items : [];
        const rec = items.find(g => safeId(g.id) === id);
        if (!rec && !(await exists(paths.gameRoot(id)))) throw new Error(`Game not found: ${id}`);
        if (index.activeGameId === id) index.activeGameId = null;
        index.items = items.filter(g => safeId(g.id) !== id);
        await saveGamesIndex(index);
        try { await FS.remove(paths.gameRoot(id)); }
        catch (err) { console.warn('[VP Native Storage] game folder remove failed:', err); }
        return rec || { id };
    }

    async function createHelloGame() {
        await ensureDirs();
        const id = 'hello_game';
        const root = paths.gameRoot(id);
        await ensureDir(root);
        const t = Date.now();
        const info = {
            format: 'visual-projector-game',
            formatVersion: 1,
            id,
            title: 'Hello Game',
            version: '0.1.0',
            entry: 'main.js',
            style: 'style.css',
            description: 'Minimal trusted game module that tests VP Game API, state persistence, profiles, gallery and projector bridge.',
            trusted: true,
            createdAt: t,
            updatedAt: t,
        };
        const mainJs = "(function(){\n'use strict';\n\nVP_GAMES.register({\n  id: 'hello_game',\n  title: 'Hello Game',\n  async mount(container, api) {\n    const state = await api.storage.getState({ clicks: 0, mountedAt: Date.now(), log: [], overlayWins: 0 });\n    if (!Array.isArray(state.log)) state.log = [];\n    const profiles = api.profiles.list();\n    const assets = api.gallery.listAssets();\n    container.innerHTML = `\n      <div class=\"hello-game-root\">\n        <div class=\"hello-game-card\">\n          <div class=\"hello-game-title\">🎮 Hello Game</div>\n          <div class=\"hello-game-note\">Trusted game module test. It persists state, reads profiles/gallery, builds controlled game context, calls LLM, loads its own assets, and can launch a full-screen activity overlay like a mini-game.</div>\n          <div class=\"hello-game-stats\">\n            <span>Profiles: <b>${profiles.length}</b></span>\n            <span>Assets: <b>${assets.length}</b></span>\n            <span>Clicks: <b data-role=\"clicks\">${state.clicks || 0}</b></span>\n            <span>Overlay wins: <b data-role=\"wins\">${state.overlayWins || 0}</b></span>\n            <span>Log: <b data-role=\"log-count\">${state.log.length}</b></span>\n          </div>\n          <div class=\"hello-game-actions\">\n            <button class=\"vp-btn\" data-act=\"click\">Click + Save</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"overlay\">Open mini-game overlay</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"subtitle\">Projector subtitle</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"first-asset\">Show first asset</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"ask-llm\">Ask LLM + Context</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"ask-json\">Ask JSON</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"copy-context\">Copy context</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"clear-log\">Clear log</button>\n          </div>\n          <div class=\"hello-game-log\" data-role=\"log\"></div>\n          <pre data-role=\"dump\"></pre>\n        </div>\n      </div>`;\n    const clicksEl = container.querySelector('[data-role=\"clicks\"]');\n    const winsEl = container.querySelector('[data-role=\"wins\"]');\n    const logCountEl = container.querySelector('[data-role=\"log-count\"]');\n    const logEl = container.querySelector('[data-role=\"log\"]');\n    const dump = container.querySelector('[data-role=\"dump\"]');\n    const buildContext = () => api.context.compose([\n      'You are a tiny game narrator inside a Visual Projector trusted game module.',\n      'Use the provided game context only. Do not assume the full Visual Projector gallery/chat context unless it is included here.',\n      api.context.world(),\n      api.context.user(),\n      api.context.activeProfile(),\n      api.context.profiles({ mode: 'summary', max: 5 }),\n      api.context.gallery({ mode: 'summary', maxAssets: 8 }),\n      api.context.projector(),\n      api.context.gameState({ clicks: state.clicks || 0, overlayWins: state.overlayWins || 0, logEntries: state.log.length }),\n      api.context.commands([\n        { name: 'HELLO_CLICK', description: 'The player clicked the Hello Game button.' },\n        { name: 'OVERLAY_ACTIVITY', description: 'The player can complete a temporary full-screen activity overlay.' },\n        { name: 'SHOW_FIRST_ASSET', description: 'The game may show the first visible gallery asset if one exists.' }\n      ])\n    ]);\n    const renderLog = async () => {\n      const log = await api.log.list();\n      logCountEl.textContent = log.length;\n      logEl.innerHTML = log.length ? '' : '<div class=\"hello-game-log-empty\">Game log is empty.</div>';\n      log.slice(-8).reverse().forEach(row => {\n        const item = document.createElement('div');\n        item.className = 'hello-game-log-item';\n        item.innerHTML = `<b>${row.type}</b><span>${new Date(row.createdAt || Date.now()).toLocaleTimeString()}</span><div></div>`;\n        item.querySelector('div').textContent = row.text || '';\n        logEl.appendChild(item);\n      });\n    };\n    const renderDump = async () => {\n      const gameAssets = await api.assets.list('assets');\n      dump.textContent = JSON.stringify({\n        state: await api.storage.getState({}),\n        activeWorld: api.world.getInfo(),\n        gameAssets,\n        contextPreview: buildContext().slice(0, 1600),\n        firstProfiles: profiles.slice(0, 3).map(p => p.name),\n        firstAssets: assets.slice(0, 5).map(a => a.tag)\n      }, null, 2);\n    };\n    await renderLog();\n    await renderDump();\n    container.querySelector('[data-act=\"click\"]').addEventListener('click', async () => {\n      state.clicks = (state.clicks || 0) + 1;\n      state.updatedAt = Date.now();\n      await api.storage.setState(state);\n      await api.log.add('event', `Click counter saved: ${state.clicks}`);\n      clicksEl.textContent = state.clicks;\n      await renderLog();\n      await renderDump();\n      api.ui.toast('Hello Game state saved', 'success');\n    });\n    container.querySelector('[data-act=\"overlay\"]').addEventListener('click', () => {\n      let score = 0;\n      let timeLeft = 5;\n      let timer = null;\n      let started = false;\n      let demoUrl = null;\n      const overlay = api.ui.openOverlay({\n        title: '🎯 Hello Mini-Game Overlay',\n        onClose: async (result) => {\n          if (timer) clearInterval(timer);\n          if (demoUrl) api.assets.revokeUrl(demoUrl);\n          if (result && result.completed) {\n            state.overlayWins = (state.overlayWins || 0) + 1;\n            state.updatedAt = Date.now();\n            await api.storage.setState(state);\n            await api.activities.complete({\n              activityId: 'hello_overlay_demo',\n              status: 'completed',\n              outcome: result.score >= 8 ? 'excellent_score' : result.score >= 4 ? 'solid_score' : 'low_score',\n              success: true,\n              score: result.score,\n              quality: result.score >= 8 ? 'excellent' : result.score >= 4 ? 'good' : 'rough',\n              effects: { overlayWins: +1 },\n              tags: ['demo', 'overlay', 'timed_clicks'],\n              summary: `Hello overlay demo completed with score ${result.score}.`,\n              payload: { timeLimitSeconds: 5 }\n            });\n            winsEl.textContent = state.overlayWins;\n            await renderLog();\n            await renderDump();\n          } else if (result && result.reason === 'user') {\n            await api.activities.complete({\n              activityId: 'hello_overlay_demo',\n              status: 'cancelled',\n              outcome: 'user_exit',\n              success: false,\n              tags: ['demo', 'overlay', 'cancelled'],\n              summary: 'Hello overlay demo exited before completion.'\n            });\n            await renderLog();\n            await renderDump();\n          }\n        },\n        mount(body, ov) {\n          body.innerHTML = `\n            <div class=\"hello-overlay-demo\">\n              <div class=\"hello-overlay-card\">\n                <div class=\"hello-overlay-title\">Temporary Activity Overlay</div>\n                <div class=\"hello-overlay-note\">Rules: after pressing Start, you have 5 seconds to hit the target as many times as possible. This placeholder also loads an SVG from the game's own assets folder via api.assets.objectUrl().</div>\n                <img class=\"hello-overlay-asset\" data-role=\"asset\" alt=\"Demo game asset\">\n                <div class=\"hello-overlay-score\">Score: <b data-role=\"score\">0</b> · Time: <b data-role=\"time\">5</b></div>\n                <button class=\"vp-btn\" data-act=\"start\">Start</button>\n                <button class=\"vp-btn\" data-act=\"hit\" disabled>Hit target</button>\n                <button class=\"vp-btn vp-btn-ghost\" data-act=\"finish\" disabled>Finish with result</button>\n              </div>\n            </div>`;\n          const scoreEl = body.querySelector('[data-role=\"score\"]');\n          const timeEl = body.querySelector('[data-role=\"time\"]');\n          const assetEl = body.querySelector('[data-role=\"asset\"]');\n          api.assets.objectUrl('assets/demo.svg', 'image/svg+xml').then(url => { demoUrl = url; assetEl.src = url; }).catch(() => { assetEl.style.display = 'none'; });\n          const startBtn = body.querySelector('[data-act=\"start\"]');\n          const hitBtn = body.querySelector('[data-act=\"hit\"]');\n          const finishBtn = body.querySelector('[data-act=\"finish\"]');\n          const finish = () => ov.close({ completed: true, score });\n          startBtn.addEventListener('click', () => {\n            if (started) return;\n            started = true;\n            startBtn.disabled = true;\n            hitBtn.disabled = false;\n            finishBtn.disabled = false;\n            timer = setInterval(() => {\n              timeLeft--;\n              timeEl.textContent = timeLeft;\n              if (timeLeft <= 0) finish();\n            }, 1000);\n          });\n          hitBtn.addEventListener('click', () => { if (!started) return; score++; scoreEl.textContent = score; });\n          finishBtn.addEventListener('click', finish);\n        }\n      });\n    });\n    container.querySelector('[data-act=\"subtitle\"]').addEventListener('click', async () => {\n      await api.projector.say('Hello from a Visual Projector game module.', { role: 'assistant', type: 'subtitle' });\n      await renderLog();\n      await renderDump();\n    });\n    container.querySelector('[data-act=\"first-asset\"]').addEventListener('click', async () => {\n      if (assets[0]) {\n        api.projector.showImage(assets[0].tag);\n        await api.log.add('projector', `Showed first asset: ${assets[0].tag}`);\n      }\n      else api.ui.toast('No gallery assets in this world yet', 'info');\n      await renderLog();\n      await renderDump();\n    });\n    container.querySelector('[data-act=\"ask-llm\"]').addEventListener('click', async () => {\n      try {\n        api.ui.toast('Asking LLM through game API...', 'info');\n        const reply = await api.llm.complete({\n          system: buildContext(),\n          prompt: 'Greet the player in one short sentence and mention the click count and one thing you noticed in the provided world/game context.',\n          maxTokens: 100,\n          temperature: 0.7\n        });\n        await api.log.add('llm', reply || '(empty reply)', { usedContext: true });\n        await api.projector.say(reply || 'The game narrator stays silent.', { role: 'assistant', type: 'llm' });\n      } catch (err) {\n        await api.log.add('error', err.message || String(err));\n        api.ui.toast(`LLM error: ${err.message || err}`, 'error');\n      }\n      await renderLog();\n      await renderDump();\n    });\n    container.querySelector('[data-act=\"ask-json\"]').addEventListener('click', async () => {\n      try {\n        api.ui.toast('Asking LLM for structured JSON...', 'info');\n        const result = await api.llm.json({\n          system: buildContext(),\n          prompt: 'Return JSON for a game event reaction. Include a short line and optional commands. Use this exact shape: {\"line\":\"...\",\"commands\":[{\"type\":\"fx\",\"name\":\"sparkle\"}]}',\n          shape: { line: 'string', commands: 'array' },\n          fallback: { line: 'The game director nods silently.', commands: [] },\n          maxTokens: 140,\n          temperature: 0.6\n        });\n        const data = result.data || { line: '', commands: [] };\n        await api.log.add(result.ok ? 'llm-json' : 'llm-json-fallback', JSON.stringify(data), { ok: result.ok, error: result.error || null });\n        if (data.line) await api.projector.say(data.line, { role: 'assistant', type: 'llm-json' });\n        for (const cmd of data.commands || []) {\n          if (cmd && cmd.type === 'fx' && cmd.name) api.projector.fireEffect(cmd.name);\n        }\n      } catch (err) {\n        await api.log.add('error', err.message || String(err));\n        api.ui.toast(`LLM JSON error: ${err.message || err}`, 'error');\n      }\n      await renderLog();\n      await renderDump();\n    });\n    container.querySelector('[data-act=\"copy-context\"]').addEventListener('click', async () => {\n      try {\n        await navigator.clipboard.writeText(buildContext());\n        api.ui.toast('Game context copied', 'success');\n      } catch {\n        api.ui.toast('Clipboard unavailable', 'error');\n      }\n    });\n    container.querySelector('[data-act=\"clear-log\"]').addEventListener('click', async () => {\n      await api.log.clear();\n      await renderLog();\n      await renderDump();\n      api.ui.toast('Game log cleared', 'info');\n    });\n  },\n  async unmount() {}\n});\n})();\n";
        const styleCss = ".hello-game-root { height:100%; min-height:0; padding:12px; display:flex; align-items:center; justify-content:center; }\n.hello-game-card { width:min(720px, 100%); border:1px solid rgba(255,255,255,.10); border-radius:14px; background:rgba(255,255,255,.045); padding:16px; box-shadow:0 12px 30px rgba(0,0,0,.22); }\n.hello-game-title { font-weight:900; font-size:18px; margin-bottom:8px; }\n.hello-game-note { color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.5; margin-bottom:12px; }\n.hello-game-stats { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }\n.hello-game-stats span { border-radius:999px; background:rgba(255,255,255,.07); padding:4px 9px; font-size:12px; color:var(--text-secondary,#a6adc8); }\n.hello-game-stats b { color:var(--text-primary,#cdd6f4); }\n.hello-game-actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }\n.hello-game-log { display:flex; flex-direction:column; gap:6px; max-height:190px; overflow:auto; margin-bottom:12px; }\n.hello-game-log-empty { color:var(--text-secondary,#a6adc8); font-size:12px; text-align:center; padding:10px; border:1px dashed rgba(255,255,255,.14); border-radius:9px; }\n.hello-game-log-item { border:1px solid rgba(255,255,255,.08); border-radius:8px; background:rgba(0,0,0,.18); padding:7px 8px; font-size:11px; }\n.hello-game-log-item b { color:var(--accent,#6c5fa6); margin-right:8px; text-transform:uppercase; font-size:10px; }\n.hello-game-log-item span { color:var(--text-secondary,#a6adc8); font-size:10px; }\n.hello-game-log-item div { margin-top:4px; color:var(--text-primary,#cdd6f4); white-space:pre-wrap; line-height:1.35; }\n.hello-game-card pre { max-height:190px; overflow:auto; white-space:pre-wrap; word-break:break-word; border-radius:9px; background:rgba(0,0,0,.24); padding:10px; font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--text-primary,#cdd6f4); }\n.hello-overlay-demo { height:100%; display:flex; align-items:center; justify-content:center; padding:24px; }\n.hello-overlay-card { width:min(680px, 100%); border:1px solid rgba(255,255,255,.12); border-radius:18px; background:rgba(255,255,255,.055); padding:24px; text-align:center; box-shadow:0 18px 50px rgba(0,0,0,.35); }\n.hello-overlay-title { font-size:24px; font-weight:900; margin-bottom:10px; }\n.hello-overlay-note { color:var(--text-secondary,#a6adc8); line-height:1.55; margin-bottom:18px; }\n.hello-overlay-asset { display:block; width:min(320px, 90%); height:auto; margin:0 auto 18px; border-radius:14px; border:1px solid rgba(255,255,255,.14); box-shadow:0 10px 28px rgba(0,0,0,.28); }\n.hello-overlay-score { display:inline-flex; gap:8px; border-radius:999px; background:rgba(255,255,255,.08); padding:6px 12px; margin-bottom:18px; }\n.hello-overlay-card .vp-btn { margin:4px; }\n";
        const demoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180" viewBox="0 0 320 180">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#6c5fa6"/><stop offset="1" stop-color="#1ba64e"/></linearGradient>
  </defs>
  <rect width="320" height="180" rx="18" fill="#11111b"/>
  <circle cx="88" cy="88" r="46" fill="url(#g)" opacity="0.95"/>
  <path d="M56 91c22-30 49-30 68 0-19 29-47 29-68 0Z" fill="#e7eaff" opacity="0.92"/>
  <circle cx="90" cy="91" r="12" fill="#11111b"/>
  <text x="154" y="75" fill="#cdd6f4" font-family="system-ui,Segoe UI,sans-serif" font-size="24" font-weight="800">VP Game Asset</text>
  <text x="154" y="108" fill="#a6adc8" font-family="system-ui,Segoe UI,sans-serif" font-size="14">Loaded via api.assets.objectUrl()</text>
</svg>`;
        await writeJson(paths.gameInfo(id), info);
        await writeText(join(root, 'main.js'), mainJs);
        await writeText(join(root, 'style.css'), styleCss);
        await ensureDir(join(root, 'assets'));
        await writeText(join(root, 'assets/demo.svg'), demoSvg);
        if (!(await exists(paths.gameState(id)))) await writeJson(paths.gameState(id), { clicks: 0, createdAt: t });
        const index = await ensureGamesIndex();
        const idx = (index.items || []).findIndex(g => g.id === id);
        const row = { id, title: info.title, version: info.version, updatedAt: t };
        if (idx >= 0) index.items[idx] = { ...index.items[idx], ...row };
        else index.items.push(row);
        await saveGamesIndex(index);
        return info;
    }


    async function createMessengerGame() {
        await ensureDirs();
        const id = 'messenger_game';
        const root = paths.gameRoot(id);
        await ensureDir(root);
        const t = Date.now();
        const info = {
            format: 'visual-projector-game',
            formatVersion: 1,
            id,
            title: 'Messenger Game',
            version: '0.1.0',
            entry: 'main.js',
            style: 'style.css',
            description: 'Prototype physical-constraint messenger game: if characters are apart, only messenger communication is available.',
            trusted: true,
            createdAt: t,
            updatedAt: t,
        };
        const mainJs = "(function(){\n'use strict';\n\nfunction defaultState(activeProfile) {\n  return {\n    messages: [],\n    tick: 0,\n    user: { location: 'home' },\n    npc: {\n      name: activeProfile?.name || 'Character',\n      location: 'university',\n      activity: 'class',\n      mood: 'neutral',\n      available: false\n    }\n  };\n}\n\nVP_GAMES.register({\n  id: 'messenger_game',\n  title: 'Messenger Game',\n  async activate(api) {\n    this._api = api;\n    const activeProfile = api.profiles.getActive();\n    this._state = await api.storage.getState(defaultState(activeProfile));\n    if (!Array.isArray(this._state.messages)) this._state.messages = [];\n    if (!this._state.user) this._state.user = { location: 'home' };\n    if (!this._state.npc) this._state.npc = defaultState(activeProfile).npc;\n    if (!this._state.npc.name || this._state.npc.name === 'Character') this._state.npc.name = activeProfile?.name || this._state.npc.name || 'Character';\n    return this._state;\n  },\n  async deactivate(api) {\n    if (this._api && this._state) await this._api.storage.setState(this._state);\n  },\n  buildPromptContext(api) {\n    const liveApi = this._api || api;\n    const state = this._state;\n    if (!liveApi || !state) return '';\n    return this._buildContext(liveApi, state, '', true);\n  },\n  _isTogether(state) {\n    return state.user?.location && state.npc?.location && state.user.location === state.npc.location;\n  },\n  _recentDialogue(state) {\n    return (state.messages || []).slice(-8).map(m => `${m.role === 'user' ? 'User' : state.npc.name}: ${m.text}`).join('\\n');\n  },\n  _buildContext(api, state, userText = '', forMainChat = false) {\n    const together = this._isTogether(state);\n    return api.context.compose([\n      forMainChat\n        ? '[ACTIVE GAME CONTEXT: Messenger Game]\\nThis context is injected into the main Visual Projector chat because Messenger Game is active. The main chat assistant must respect this game state when discussing physical actions.\\n[/ACTIVE GAME CONTEXT]'\n        : 'You are running inside a Visual Projector game module called Messenger Game.',\n      'The GAME STATE is the physical truth. Do not override it. If characters are apart, physical interaction is impossible and communication happens only through messenger.',\n      'The LLM/NPC may express intentions, feelings, suggestions, or schedule a meeting, but the game decides whether physical actions happen.',\n      'If the user claims an impossible physical action in normal chat, do not accept it as already happened. Respond in-world and suggest available actions.',\n      api.context.world(),\n      api.context.user(),\n      api.context.activeProfile(),\n      api.context.gameState({\n        user: state.user,\n        npc: state.npc,\n        together,\n        mode: together ? 'in_person' : 'messenger_only',\n        tick: state.tick || 0,\n        recentMessengerDialogue: this._recentDialogue(state)\n      }),\n      api.context.commands([\n        { name: 'MESSENGER_REPLY', description: 'Allowed when characters are apart. Reply as a message, short and situated.' },\n        { name: 'SCHEDULE_MEETING', description: 'Allowed when user asks to meet while apart. You may suggest a time/place, but do not make the meeting happen instantly.' },\n        { name: 'IN_PERSON_REPLY', description: 'Allowed only when user and NPC are in the same location.' }\n      ]),\n      userText ? `Current user message:\\n${userText}` : ''\n    ]);\n  },\n  async mount(container, api) {\n    await this.activate(api);\n    const state = this._state;\n    const isTogether = () => this._isTogether(state);\n    const statusText = () => isTogether()\n      ? `${state.npc.name} is here with you at ${state.user.location}. Physical interaction is available.`\n      : `${state.npc.name} is away at ${state.npc.location}, currently: ${state.npc.activity}. Messenger only.`;\n\n    container.innerHTML = `\n      <div class=\"messenger-game-root\">\n        <div class=\"messenger-game-header\">\n          <div>\n            <div class=\"messenger-game-title\">💬 Messenger Game</div>\n            <div class=\"messenger-game-sub\" data-role=\"status\"></div>\n          </div>\n          <div class=\"messenger-game-header-actions\">\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"toggle-location\">Toggle meet/apart</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"advance\">Advance time</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"copy-context\">Copy context</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"clear\">Clear</button>\n          </div>\n        </div>\n        <div class=\"messenger-game-messages\" data-role=\"messages\"></div>\n        <div class=\"messenger-game-input\">\n          <textarea data-role=\"input\" placeholder=\"Send a message or try to ask for a meeting...\"></textarea>\n          <button class=\"vp-btn\" data-act=\"send\">Send</button>\n        </div>\n        <div class=\"messenger-game-note\">Messenger Game can be activated headless. When active, its physical-state context is injected into the main Visual Projector chat even if this panel is not mounted.</div>\n      </div>`;\n\n    const statusEl = container.querySelector('[data-role=\"status\"]');\n    const messagesEl = container.querySelector('[data-role=\"messages\"]');\n    const inputEl = container.querySelector('[data-role=\"input\"]');\n\n    const save = async () => { this._state = state; await api.storage.setState(state); };\n    const render = () => {\n      statusEl.textContent = statusText();\n      messagesEl.innerHTML = '';\n      if (!state.messages.length) {\n        messagesEl.innerHTML = '<div class=\"messenger-game-empty\">No messenger messages yet.</div>';\n      } else {\n        state.messages.slice(-80).forEach(m => {\n          const row = document.createElement('div');\n          row.className = `messenger-game-msg ${m.role}`;\n          row.innerHTML = `<div class=\"messenger-game-msg-head\"></div><div class=\"messenger-game-msg-text\"></div>`;\n          row.querySelector('.messenger-game-msg-head').textContent = `${m.role === 'user' ? 'You' : state.npc.name} · ${new Date(m.createdAt || Date.now()).toLocaleTimeString()}`;\n          row.querySelector('.messenger-game-msg-text').textContent = m.text || '';\n          messagesEl.appendChild(row);\n        });\n        messagesEl.scrollTop = messagesEl.scrollHeight;\n      }\n    };\n\n    const addMessage = (role, text) => {\n      state.messages.push({ role, text: String(text || ''), createdAt: Date.now(), mode: isTogether() ? 'in_person' : 'messenger' });\n      if (state.messages.length > 200) state.messages = state.messages.slice(-200);\n    };\n\n    const send = async () => {\n      const text = inputEl.value.trim();\n      if (!text) return;\n      inputEl.value = '';\n      addMessage('user', text);\n      render();\n      await save();\n      try {\n        const reply = await api.llm.complete({\n          system: this._buildContext(api, state, text, false),\n          prompt: isTogether()\n            ? 'Reply in character as an in-person response. One or two short sentences.'\n            : 'Reply in character as a messenger text. If the user attempts physical action, gently enforce distance and suggest scheduling or messaging. One or two short sentences.',\n          maxTokens: 140,\n          temperature: 0.75\n        });\n        addMessage('assistant', reply || '(no reply)');\n        await api.log.add('messenger', reply || '(empty reply)', { together: isTogether() });\n        if (isTogether()) await api.projector.say(reply || '', { role: 'assistant', type: 'in_person_reply' });\n      } catch (err) {\n        addMessage('assistant', `⚠ ${err.message || err}`);\n        await api.log.add('error', err.message || String(err));\n        api.ui.toast(`Messenger LLM error: ${err.message || err}`, 'error');\n      }\n      await save();\n      render();\n    };\n\n    container.querySelector('[data-act=\"send\"]').addEventListener('click', send);\n    inputEl.addEventListener('keydown', (e) => {\n      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }\n    });\n    container.querySelector('[data-act=\"toggle-location\"]').addEventListener('click', async () => {\n      if (isTogether()) {\n        state.npc.location = 'university';\n        state.npc.activity = 'class';\n      } else {\n        state.npc.location = state.user.location || 'home';\n        state.npc.activity = 'visiting you';\n      }\n      state.tick = (state.tick || 0) + 1;\n      await api.log.add('state', `Location toggled. ${statusText()}`);\n      await save();\n      render();\n    });\n    container.querySelector('[data-act=\"advance\"]').addEventListener('click', async () => {\n      state.tick = (state.tick || 0) + 1;\n      const phases = [\n        { location: 'university', activity: 'class' },\n        { location: 'bus', activity: 'commuting' },\n        { location: 'home', activity: 'resting' },\n        { location: 'park', activity: 'walking' }\n      ];\n      const next = phases[state.tick % phases.length];\n      state.npc.location = next.location;\n      state.npc.activity = next.activity;\n      await api.log.add('time', `Advanced time: ${state.npc.name} is now at ${state.npc.location}, ${state.npc.activity}.`);\n      await save();\n      render();\n    });\n    container.querySelector('[data-act=\"copy-context\"]').addEventListener('click', async () => {\n      try { await navigator.clipboard.writeText(this._buildContext(api, state, '(no current message)', true)); api.ui.toast('Messenger context copied', 'success'); }\n      catch { api.ui.toast('Clipboard unavailable', 'error'); }\n    });\n    container.querySelector('[data-act=\"clear\"]').addEventListener('click', async () => {\n      state.messages = [];\n      await api.log.add('state', 'Messenger messages cleared');\n      await save();\n      render();\n    });\n\n    render();\n  },\n  async unmount() {\n    if (this._api && this._state) await this._api.storage.setState(this._state);\n  }\n});\n})();\n";
        const styleCss = ".messenger-game-root { height:100%; min-height:0; display:flex; flex-direction:column; gap:10px; padding:10px; }\n.messenger-game-header { flex:0 0 auto; display:flex; justify-content:space-between; gap:10px; align-items:flex-start; border:1px solid rgba(255,255,255,.09); border-radius:12px; background:rgba(255,255,255,.04); padding:10px; }\n.messenger-game-title { font-weight:900; font-size:16px; color:var(--text-primary,#cdd6f4); }\n.messenger-game-sub { margin-top:3px; color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.4; }\n.messenger-game-header-actions { display:flex; gap:6px; flex-wrap:wrap; justify-content:flex-end; }\n.messenger-game-messages { flex:1; min-height:0; overflow:auto; display:flex; flex-direction:column; gap:8px; padding:4px; }\n.messenger-game-empty { margin:auto; color:var(--text-secondary,#a6adc8); font-size:12px; text-align:center; }\n.messenger-game-msg { max-width:min(78%, 620px); border:1px solid rgba(255,255,255,.08); border-radius:12px; padding:8px 10px; background:rgba(255,255,255,.045); }\n.messenger-game-msg.user { align-self:flex-end; background:rgba(108,95,166,.18); }\n.messenger-game-msg.assistant { align-self:flex-start; }\n.messenger-game-msg-head { color:var(--text-secondary,#a6adc8); font-size:10px; text-transform:uppercase; letter-spacing:.05em; margin-bottom:4px; }\n.messenger-game-msg-text { color:var(--text-primary,#cdd6f4); font-size:13px; line-height:1.45; white-space:pre-wrap; }\n.messenger-game-input { flex:0 0 auto; display:flex; gap:8px; }\n.messenger-game-input textarea { flex:1; min-height:56px; resize:vertical; border-radius:9px; border:1px solid rgba(255,255,255,.12); background:rgba(0,0,0,.22); color:var(--text-primary,#cdd6f4); padding:8px; }\n.messenger-game-input button { align-self:stretch; height:auto; min-width:80px; }\n.messenger-game-note { flex:0 0 auto; color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.35; opacity:.78; }\n";
        await writeJson(paths.gameInfo(id), info);
        await writeText(join(root, 'main.js'), mainJs);
        await writeText(join(root, 'style.css'), styleCss);
        if (!(await exists(paths.gameState(id)))) await writeJson(paths.gameState(id), { messages: [], tick: 0, createdAt: t });
        const index = await ensureGamesIndex();
        const idx = (index.items || []).findIndex(g => g.id === id);
        const row = { id, title: info.title, version: info.version, updatedAt: t };
        if (idx >= 0) index.items[idx] = { ...index.items[idx], ...row };
        else index.items.push(row);
        await saveGamesIndex(index);
        return info;
    }


    async function getActiveGameId() {
        const index = await ensureGamesIndex();
        return index.activeGameId || null;
    }

    async function setActiveGameId(gameId) {
        const id = safeId(gameId);
        const index = await ensureGamesIndex();
        if (!(index.items || []).some(g => g.id === id)) throw new Error(`Game not found: ${id}`);
        index.activeGameId = id;
        await saveGamesIndex(index);
        return id;
    }

    async function clearActiveGameId() {
        const index = await ensureGamesIndex();
        index.activeGameId = null;
        await saveGamesIndex(index);
        return true;
    }


    async function createLifeSimGame() {
        await ensureDirs();
        const id = 'life_sim';
        const root = paths.gameRoot(id);
        await ensureDir(root);
        const t = Date.now();
        const info = {
            format: 'visual-projector-game',
            formatVersion: 1,
            id,
            title: 'LifeSim Core',
            version: '0.1.0',
            entry: 'main.js',
            style: 'style.css',
            description: 'Headless/orchestrator life simulation skeleton: time, locations, availability, relationship and physical-state context.',
            trusted: true,
            createdAt: t,
            updatedAt: t,
        };
        const mainJs = "(function(){\n'use strict';\n\nfunction defaultState(api) {\n  const profile = api.profiles.getActive();\n  const name = profile?.name || 'Companion';\n  return {\n    version: 1,\n    time: { day: 1, phase: 'morning', tick: 0 },\n    phases: ['morning', 'day', 'afternoon', 'evening', 'night'],\n    locations: ['home', 'university', 'bus', 'park', 'store', 'dacha'],\n    user: { name: 'User', location: 'home', activity: 'idle', travelTo: null, etaTicks: 0 },\n    character: {\n      profileId: profile?.id || null,\n      name,\n      location: 'university',\n      activity: 'class',\n      availability: 'delayed_messenger',\n      mood: 'focused',\n      energy: 0.8,\n      affection: 0.1,\n      trust: 0.1\n    },\n    relationship: { affection: 0.1, trust: 0.1, tension: 0.0 },\n    schedule: [\n      { phase: 'morning', location: 'university', activity: 'class', availability: 'delayed_messenger' },\n      { phase: 'day', location: 'university', activity: 'class', availability: 'delayed_messenger' },\n      { phase: 'afternoon', location: 'bus', activity: 'commuting', availability: 'messenger' },\n      { phase: 'evening', location: 'park', activity: 'walking', availability: 'messenger' },\n      { phase: 'night', location: 'home', activity: 'resting', availability: 'unavailable' }\n    ],\n    events: [],\n    log: []\n  };\n}\n\nVP_GAMES.register({\n  id: 'life_sim',\n  title: 'LifeSim Core',\n\n  async activate(api) {\n    this._api = api;\n    this._state = await api.storage.getState(defaultState(api));\n    this._normalize(api);\n    await api.storage.setState(this._state);\n    return this._state;\n  },\n\n  async deactivate(api) {\n    if (this._api && this._state) await this._api.storage.setState(this._state);\n  },\n\n  _normalize(api) {\n    const base = defaultState(api);\n    const s = this._state || base;\n    s.version = s.version || 1;\n    s.time = { ...base.time, ...(s.time || {}) };\n    s.phases = Array.isArray(s.phases) && s.phases.length ? s.phases : base.phases;\n    s.locations = Array.isArray(s.locations) && s.locations.length ? s.locations : base.locations;\n    s.user = { ...base.user, ...(s.user || {}) };\n    s.character = { ...base.character, ...(s.character || {}) };\n    s.relationship = { ...base.relationship, ...(s.relationship || {}) };\n    s.schedule = Array.isArray(s.schedule) && s.schedule.length ? s.schedule : base.schedule;\n    s.events = Array.isArray(s.events) ? s.events : [];\n    s.log = Array.isArray(s.log) ? s.log : [];\n    this._state = s;\n  },\n\n  _sameLocation(state = this._state) {\n    return !!(state?.user?.location && state?.character?.location && state.user.location === state.character.location);\n  },\n\n  _channel(state = this._state) {\n    if (this._sameLocation(state)) return 'in_person';\n    const a = state.character?.availability || 'messenger';\n    if (a === 'unavailable') return 'unavailable';\n    if (a === 'delayed_messenger') return 'delayed_messenger';\n    return 'messenger';\n  },\n\n  _physicalFlags(state = this._state) {\n    const channel = this._channel(state);\n    const together = this._sameLocation(state);\n    return {\n      together,\n      communicationChannel: channel,\n      physicalInteractionAllowed: together,\n      characterCanReply: channel === 'in_person' || channel === 'messenger' || channel === 'delayed_messenger',\n      messengerOnly: channel === 'messenger' || channel === 'delayed_messenger',\n      unavailable: channel === 'unavailable'\n    };\n  },\n\n  _factsBlock(state = this._state) {\n    const flags = this._physicalFlags(state);\n    return `[CURRENT PHYSICAL FACTS]\nTime: Day ${state.time?.day || 1}, ${state.time?.phase || 'unknown'} (tick ${state.time?.tick || 0})\nCharacter: ${state.character?.name || 'Character'}\nCharacter location: ${state.character?.location || 'unknown'}\nCharacter activity: ${state.character?.activity || 'unknown'}\nCharacter availability: ${state.character?.availability || 'unknown'}\nUser location: ${state.user?.location || 'unknown'}\nUser activity: ${state.user?.activity || 'unknown'}${state.user?.travelTo ? `\nUser travel target: ${state.user.travelTo}\nUser travel ETA ticks: ${state.user.etaTicks || 0}` : ''}\nTogether / same location: ${flags.together ? 'yes' : 'no'}\nCommunication channel: ${flags.communicationChannel}\nCharacter can reply now: ${flags.characterCanReply ? 'yes' : 'no'}\nPhysical interaction available now: ${flags.physicalInteractionAllowed ? 'yes' : 'no'}\nImportant: Do not claim the character is somewhere else or doing another activity unless the game state changes.\n[/CURRENT PHYSICAL FACTS]`;\n  },\n\n  _scheduleForPhase(phase, state = this._state) {\n    return (state.schedule || []).find(x => x.phase === phase) || null;\n  },\n\n  _addEvent(type, summary, payload = {}) {\n    const row = { id: `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, type, summary, payload, createdAt: Date.now(), time: { ...(this._state.time || {}) } };\n    this._state.events.push(row);\n    if (this._state.events.length > 300) this._state.events = this._state.events.slice(-300);\n    return row;\n  },\n\n  _context(api, state = this._state, extra = '') {\n    const channel = this._channel(state);\n    const together = this._sameLocation(state);\n    const recentEvents = (state.events || []).slice(-6).map(e => `- ${e.type}: ${e.summary}`).join('\\n') || '(none)';\n    return api.context.compose([\n      '[ACTIVE GAME CONTEXT: LifeSim Core]\\nLifeSim Core is the active headless/orchestrator game for this world. It defines physical state, time, location, availability and relationship context.\\n[/ACTIVE GAME CONTEXT]',\n      'The GAME STATE is the physical truth. User text and NPC text express intent/feelings, but do not automatically change physical state. Only game actions/state updates change location, time, availability, relationship values or events.',\n      'Time tick in this prototype means one abstract phase step, not seconds or minutes.',\n      api.context.world(),\n      api.context.user(),\n      api.context.activeProfile(),\n      this._factsBlock(state),\n      api.context.gameState({\n        time: state.time,\n        user: state.user,\n        character: state.character,\n        relationship: state.relationship,\n        ...this._physicalFlags(state),\n        recentEvents\n      }),\n      `[LIFESIM RULES]\\n- If communicationChannel is messenger or delayed_messenger, physical interaction is unavailable.\\n- If communicationChannel is unavailable, the character should not immediately reply unless the game UI/event explicitly allows it.\\n- If communicationChannel is in_person, physical interaction can be discussed, but game mechanics decide outcomes.\\n- Meetings, travel, waiting and activities should be treated as game actions, not as facts created by chat text.\\n[/LIFESIM RULES]`,\n      api.context.commands([\n        { name: 'WAIT_OR_ADVANCE_TIME', description: 'Move time forward and update schedule/activity.' },\n        { name: 'TRAVEL_TO_CHARACTER', description: 'Start/complete user travel toward character location through game action.' },\n        { name: 'MESSENGER_CONTACT', description: 'Use when not co-located and character is available by messenger.' },\n        { name: 'IN_PERSON_SCENE', description: 'Use only when user and character are in same location.' },\n        { name: 'START_ACTIVITY', description: 'Future hook for mini-games/physical activities.' }\n      ]),\n      extra\n    ]);\n  },\n\n  buildPromptContext(api) {\n    const liveApi = this._api || api;\n    if (!liveApi || !this._state) return '';\n    return this._context(liveApi, this._state);\n  },\n\n  async _save(api = this._api) {\n    this._normalize(api);\n    await api.storage.setState(this._state);\n  },\n\n  _advanceTime() {\n    const s = this._state;\n    const before = `${s.time.phase} / ${s.character.location} / ${s.character.activity}`;\n    if (s.user.activity === 'traveling') {\n      s.user.etaTicks = Math.max(0, Number(s.user.etaTicks || 0) - 1);\n      if (s.user.etaTicks <= 0 && s.user.travelTo) {\n        s.user.location = s.user.travelTo;\n        s.user.travelTo = null;\n        s.user.activity = 'idle';\n        this._addEvent('travel_arrived', `User arrived at ${s.user.location}.`);\n      }\n    }\n    const idx = Math.max(0, s.phases.indexOf(s.time.phase));\n    const nextIdx = (idx + 1) % s.phases.length;\n    if (nextIdx === 0) s.time.day = Number(s.time.day || 1) + 1;\n    s.time.phase = s.phases[nextIdx];\n    s.time.tick = Number(s.time.tick || 0) + 1;\n    const sched = this._scheduleForPhase(s.time.phase, s);\n    if (sched) {\n      s.character.location = sched.location || s.character.location;\n      s.character.activity = sched.activity || s.character.activity;\n      s.character.availability = sched.availability || s.character.availability;\n    }\n    s.character.energy = Math.max(0, Math.min(1, Number(s.character.energy ?? 0.8) + (s.time.phase === 'night' ? 0.2 : -0.05)));\n    const after = `${s.time.phase} / ${s.character.location} / ${s.character.activity}`;\n    this._addEvent('advance_time', `Advanced time: ${before} → ${after}.`);\n  },\n\n  async mount(container, api) {\n    await this.activate(api);\n    container.innerHTML = `\n      <div class=\"lifesim-root\">\n        <div class=\"lifesim-card\">\n          <div class=\"lifesim-title\">🌱 LifeSim Core</div>\n          <div class=\"lifesim-note\">Headless/orchestrator prototype. It can stay active without this panel and inject physical state into the main chat. Tick = one abstract phase step, not seconds/minutes.</div>\n          <div class=\"lifesim-grid\">\n            <div><b>Time</b><span data-role=\"time\"></span></div>\n            <div><b>Channel</b><span data-role=\"channel\"></span></div>\n            <div><b>User</b><span data-role=\"user\"></span></div>\n            <div><b>Character</b><span data-role=\"character\"></span></div>\n            <div><b>Relationship</b><span data-role=\"relationship\"></span></div>\n            <div><b>Recent event</b><span data-role=\"event\"></span></div>\n          </div>\n          <div class=\"lifesim-actions\">\n            <button class=\"vp-btn\" data-act=\"advance\">Advance time</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"travel\">Travel to character</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"home\">Go home</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"ask\">Ask LLM status</button>\n            <button class=\"vp-btn vp-btn-ghost\" data-act=\"copy\">Copy context</button>\n          </div>\n          <pre data-role=\"dump\"></pre>\n        </div>\n      </div>`;\n    const q = (sel) => container.querySelector(sel);\n    const render = () => {\n      const s = this._state;\n      q('[data-role=\"time\"]').textContent = `Day ${s.time.day}, ${s.time.phase} · tick ${s.time.tick}`;\n      const flags = this._physicalFlags(s);\n      q('[data-role=\"channel\"]').textContent = `${flags.communicationChannel} · physical: ${flags.physicalInteractionAllowed ? 'yes' : 'no'} · reply: ${flags.characterCanReply ? 'yes' : 'no'}`;\n      q('[data-role=\"user\"]').textContent = `${s.user.location}, ${s.user.activity}${s.user.travelTo ? ` → ${s.user.travelTo} (${s.user.etaTicks})` : ''}`;\n      q('[data-role=\"character\"]').textContent = `${s.character.name}: ${s.character.location}, ${s.character.activity}, ${s.character.availability}`;\n      q('[data-role=\"relationship\"]').textContent = `affection ${Number(s.relationship.affection || 0).toFixed(2)}, trust ${Number(s.relationship.trust || 0).toFixed(2)}, tension ${Number(s.relationship.tension || 0).toFixed(2)}`;\n      q('[data-role=\"event\"]').textContent = s.events.slice(-1)[0]?.summary || 'none';\n      q('[data-role=\"dump\"]').textContent = JSON.stringify(s, null, 2);\n    };\n    q('[data-act=\"advance\"]').addEventListener('click', async () => { this._advanceTime(); await this._save(api); render(); api.ui.toast('LifeSim time advanced', 'success'); });\n    q('[data-act=\"travel\"]').addEventListener('click', async () => {\n      const s = this._state;\n      if (this._sameLocation(s)) { api.ui.toast('You are already in the same location', 'info'); return; }\n      s.user.activity = 'traveling';\n      s.user.travelTo = s.character.location;\n      s.user.etaTicks = 1;\n      this._addEvent('travel_started', `User started traveling to ${s.character.location}.`);\n      await this._save(api); render();\n    });\n    q('[data-act=\"home\"]').addEventListener('click', async () => {\n      const s = this._state;\n      s.user.location = 'home'; s.user.activity = 'idle'; s.user.travelTo = null; s.user.etaTicks = 0;\n      this._addEvent('travel_home', 'User returned home.');\n      await this._save(api); render();\n    });\n    q('[data-act=\"ask\"]').addEventListener('click', async () => {\n      try {\n        const reply = await api.llm.complete({\n          system: this._context(api, this._state),\n          prompt: 'Give a short LifeSim status line in character or narrator voice. Use CURRENT PHYSICAL FACTS exactly. Mention where the character is, what they are doing, and whether in-person interaction is possible.',\n          maxTokens: 120,\n          temperature: 0.7\n        });\n        await api.log.add('lifesim', reply || '(empty)');\n        await api.projector.say(reply || '', { role: 'assistant', type: 'lifesim-status' });\n      } catch (err) { api.ui.toast(`LifeSim LLM error: ${err.message || err}`, 'error'); }\n    });\n    q('[data-act=\"copy\"]').addEventListener('click', async () => {\n      try { await navigator.clipboard.writeText(this._context(api, this._state)); api.ui.toast('LifeSim context copied', 'success'); }\n      catch { api.ui.toast('Clipboard unavailable', 'error'); }\n    });\n    render();\n  },\n\n  async unmount() {\n    if (this._api && this._state) await this._api.storage.setState(this._state);\n  }\n});\n})();\n";
        const styleCss = ".lifesim-root { height:100%; min-height:0; display:flex; align-items:center; justify-content:center; padding:12px; }\n.lifesim-card { width:min(820px,100%); border:1px solid rgba(255,255,255,.10); border-radius:16px; background:rgba(255,255,255,.045); padding:16px; box-shadow:0 14px 36px rgba(0,0,0,.24); }\n.lifesim-title { font-size:20px; font-weight:900; margin-bottom:6px; }\n.lifesim-note { color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.5; margin-bottom:12px; }\n.lifesim-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); gap:8px; margin-bottom:12px; }\n.lifesim-grid > div { border:1px solid rgba(255,255,255,.08); border-radius:10px; background:rgba(0,0,0,.16); padding:8px; display:flex; flex-direction:column; gap:4px; }\n.lifesim-grid b { font-size:11px; color:var(--text-secondary,#a6adc8); text-transform:uppercase; letter-spacing:.05em; }\n.lifesim-grid span { font-size:13px; color:var(--text-primary,#cdd6f4); line-height:1.35; }\n.lifesim-actions { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }\n.lifesim-card pre { max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-word; border-radius:10px; background:rgba(0,0,0,.24); padding:10px; font:11px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; color:var(--text-primary,#cdd6f4); }\n";
        await writeJson(paths.gameInfo(id), info);
        await writeText(join(root, 'main.js'), mainJs);
        await writeText(join(root, 'style.css'), styleCss);
        if (!(await exists(paths.gameState(id)))) await writeJson(paths.gameState(id), { createdAt: t });
        const index = await ensureGamesIndex();
        const idx = (index.items || []).findIndex(g => g.id === id);
        const row = { id, title: info.title, version: info.version, updatedAt: t };
        if (idx >= 0) index.items[idx] = { ...index.items[idx], ...row };
        else index.items.push(row);
        await saveGamesIndex(index);
        return info;
    }

    async function healthCheck() {
        await ensureDirs();
        const report = {
            checkedAt: Date.now(),
            backend: getBackendInfo(),
            ok: true,
            items: [],
            counts: {},
            missingAssets: [],
            orphanFiles: [],
        };
        const add = (level, label, detail = '') => {
            if (level === 'error') report.ok = false;
            report.items.push({ level, label, detail });
        };
        const checkExists = async (label, path, required = true) => {
            const ok = await exists(path);
            add(ok ? 'ok' : (required ? 'error' : 'warn'), label, ok ? path : `Missing: ${path}`);
            return ok;
        };
        const checkJson = async (label, path, fallback = null, required = true) => {
            if (!(await exists(path))) {
                add(required ? 'error' : 'warn', label, `Missing: ${path}`);
                return fallback;
            }
            try {
                const text = await FS.readFile(path);
                const parsed = JSON.parse(text || 'null');
                add('ok', label, path);
                return parsed;
            } catch (err) {
                add('error', label, `Invalid JSON: ${path} — ${err.message || err}`);
                return fallback;
            }
        };

        add(window.Neutralino?.filesystem ? 'ok' : 'error', 'Neutralino filesystem API', window.Neutralino?.filesystem ? 'available' : 'unavailable');
        await checkExists('Data root', paths.root(), true);
        await checkExists('Worlds index folder', paths.worldsRoot(), true);
        await checkExists('Active world folder', paths.worldRoot(), true);
        await checkJson('app.json', paths.app(), null, true);
        await checkJson('worlds/index.json', paths.worldsIndex(), null, true);

        const world = await checkJson('world.json', paths.worldInfo(), null, false);
        const config = await checkJson('config.json', paths.config(), null, false);
        const gallery = await checkJson('gallery.json', paths.galleryData(), { categories: [], tabs: [] }, false);
        const projector = await checkJson('projector.json', paths.projector(), null, false);
        const session = await checkJson('session.json', paths.session(), null, false);
        const shell = await checkJson('shell.json', paths.shell(), null, false);
        const chats = await checkJson('chats.json', paths.chats(), { items: [] }, false);
        const profiles = await checkJson('profiles.json', paths.profiles(), { items: [] }, false);
        const model = await checkJson('model.json', paths.model(), null, false);
        await checkExists('assets folder', paths.assets(), true);
        await checkExists('assets/files folder', paths.assetFiles(), true);
        const assetsMeta = await checkJson('assets/assets.json', paths.assetsMeta(), { items: [] }, false);

        report.counts.worldTitle = world?.title || _activeWorldId;
        report.counts.categories = Array.isArray(gallery?.categories) ? gallery.categories.length : 0;
        report.counts.tabs = Array.isArray(gallery?.tabs) ? gallery.tabs.length : 0;
        report.counts.assetsListed = Array.isArray(assetsMeta?.items) ? assetsMeta.items.length : 0;
        report.counts.chats = Array.isArray(chats?.items) ? chats.items.length : 0;
        report.counts.profiles = Array.isArray(profiles?.items) ? profiles.items.length : 0;
        report.counts.hasModelEndpoint = !!model?.endpoint;
        report.counts.hasCustomCss = await exists(paths.customCss());
        try { report.counts.games = (await listGames()).length; report.counts.activeGameId = await getActiveGameId() || 'none'; } catch { report.counts.games = 0; report.counts.activeGameId = 'unknown'; }
        report.counts.hasShell = !!shell;
        report.counts.hasSession = !!session;
        report.counts.hasProjector = !!projector;
        report.counts.hasConfig = !!config;

        const listedFiles = new Set();
        for (const item of (assetsMeta?.items || [])) {
            if (!item?.tag) {
                add('warn', 'Asset metadata row without tag', JSON.stringify(item).slice(0, 160));
                continue;
            }
            if (!item.file) {
                add('error', `Asset ${item.tag}`, 'No file field in metadata');
                report.missingAssets.push({ tag: item.tag, file: null, reason: 'no file field' });
                continue;
            }
            listedFiles.add(item.file);
            const filePath = join(paths.assetFiles(), item.file);
            if (!(await exists(filePath))) {
                add('error', `Missing asset file: ${item.tag}`, filePath);
                report.missingAssets.push({ tag: item.tag, file: item.file, path: filePath });
            }
        }

        let dirEntries = [];
        try {
            dirEntries = await FS.readDirectory(paths.assetFiles());
            add('ok', 'Read assets/files directory', `${dirEntries.length} entr${dirEntries.length === 1 ? 'y' : 'ies'}`);
        } catch (err) {
            add('warn', 'Read assets/files directory', err.message || String(err));
        }
        const diskFiles = [];
        for (const e of dirEntries || []) {
            const name = e.entry || e.name || e.path?.split(/[\\/]/).pop();
            const type = e.type || (e.isFile ? 'FILE' : e.isDirectory ? 'DIRECTORY' : '');
            if (!name || String(name).startsWith('.')) continue;
            if (String(type).toUpperCase().includes('DIR')) continue;
            diskFiles.push(name);
            if (!listedFiles.has(name)) {
                const path = join(paths.assetFiles(), name);
                report.orphanFiles.push({ file: name, path });
                add('warn', `Orphan asset file`, path);
            }
        }
        report.counts.assetFilesOnDisk = diskFiles.length;
        report.counts.missingAssets = report.missingAssets.length;
        report.counts.orphanFiles = report.orphanFiles.length;

        if (report.missingAssets.length === 0) add('ok', 'Missing asset files', 'none');
        if (report.orphanFiles.length === 0) add('ok', 'Orphan asset files', 'none');
        return report;
    }

    async function exportAll() {
        return {
            mode: _mode,
            activeWorld: await getActiveWorld(),
            exportedAt: Date.now(),
            config: await Storage.getConfig(),
            galleryData: await Storage.getGalleryData(),
            projector: await Storage.getProjectorState(),
            shell: await Storage.getShellState(),
            model: await Storage.getModelConfig(),
            session: await Storage.getSessionState(),
            profiles: await Storage.getProfiles(),
            chats: await Storage.getChatStore(),
            customCss: await Storage.getCustomCss(),
            assets: await getAllAssets(),
        };
    }

    const Storage = {
        ready: () => ensureDirs(),
        getMode() { return _mode; },
        setMode(mode) {
            _mode = normalizeMode(mode);
            writeJson(paths.storageMode(), { mode: _mode, updatedAt: Date.now() }).catch(() => {});
            return _mode;
        },
        shouldPersist,

        getGalleryData: () => readJson(paths.galleryData(), null),
        setGalleryData: data => {
            if (!shouldPersist('gallery-meta')) return Promise.resolve(data);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('gallery-data', clonePlain(data), async (d) => {
                    await writeJson(paths.galleryData(), d);
                });
                return Promise.resolve(data);
            }
            return writeJson(paths.galleryData(), clonePlain(data));
        },

        getConfig: () => readJson(paths.config(), null),
        setConfig: config => {
            if (!shouldPersist('config')) return Promise.resolve(config);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('config', clonePlain(config), async (d) => {
                    await writeJson(paths.config(), d);
                });
                return Promise.resolve(config);
            }
            return writeJson(paths.config(), clonePlain(config));
        },

        getCoverTag: async () => (await loadProjector()).coverTag || null,
        setCoverTag: tag => saveProjectorPatch({ coverTag: tag || null }),

        getPreparedTag: async () => (await loadProjector()).preparedTag || null,
        setPreparedTag: tag => saveProjectorPatch({ preparedTag: tag || null }),

        getCoverLabel: async () => (await loadProjector()).coverLabel || null,
        setCoverLabel: label => saveProjectorPatch({ coverLabel: label || 'cover' }),

        getCurrentTag: async () => (await loadProjector()).currentTag || null,
        setCurrentTag: tag => saveProjectorPatch({ currentTag: tag || null }),

        getProjectorState: () => readJson(paths.projector(), null),
        setProjectorState: state => {
            if (!shouldPersist('projector-state')) return Promise.resolve(state);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('projector', clonePlain(state), async (d) => {
                    await writeJson(paths.projector(), d);
                });
                return Promise.resolve(state);
            }
            return writeJson(paths.projector(), clonePlain(state));
        },

        getWinGeom: () => readJson(paths.windowGeom(), null),
        setWinGeom: geom => {
            if (!shouldPersist('shell')) return Promise.resolve(geom);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('window-geom', clonePlain(geom), async (d) => {
                    await writeJson(paths.windowGeom(), d);
                });
                return Promise.resolve(geom);
            }
            return writeJson(paths.windowGeom(), clonePlain(geom));
        },

        getPanelGeom: () => readJson(paths.panelGeom(), null),
        setPanelGeom: geom => {
            if (!shouldPersist('gallery-meta')) return Promise.resolve(geom);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('panel-geom', clonePlain(geom), async (d) => {
                    await writeJson(paths.panelGeom(), d);
                });
                return Promise.resolve(geom);
            }
            return writeJson(paths.panelGeom(), clonePlain(geom));
        },

        getShellState: () => readJson(paths.shell(), null),
        setShellState: state => {
            if (!shouldPersist('shell')) return Promise.resolve(state);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('shell', clonePlain(state), async (d) => {
                    await writeJson(paths.shell(), d);
                });
                return Promise.resolve(state);
            }
            return writeJson(paths.shell(), clonePlain(state));
        },

        getModelConfig: () => readJson(paths.model(), null),
        setModelConfig: config => {
            if (!shouldPersist('model')) return Promise.resolve(config);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('model', clonePlain(config), async (d) => {
                    await writeJson(paths.model(), d);
                });
                return Promise.resolve(config);
            }
            return writeJson(paths.model(), clonePlain(config));
        },

        getSessionState: () => readJson(paths.session(), null),
        setSessionState: state => {
            if (!shouldPersist('session')) return Promise.resolve(state);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('session', clonePlain(state), async (d) => {
                    await writeJson(paths.session(), d);
                });
                return Promise.resolve(state);
            }
            return writeJson(paths.session(), clonePlain(state));
        },

        getProfiles: () => readJson(paths.profiles(), null),
        setProfiles: store => {
            if (!shouldPersist('profiles')) return Promise.resolve(store);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('profiles', clonePlain(store), async (d) => {
                    await writeJson(paths.profiles(), d);
                });
                return Promise.resolve(store);
            }
            return writeJson(paths.profiles(), clonePlain(store));
        },

        getChatStore: () => readJson(paths.chats(), null),
        setChatStore: store => {
            if (!shouldPersist('chats')) return Promise.resolve(store);
            if (window.VP_DIRTY_TRACKER) {
                window.VP_DIRTY_TRACKER.markDirty('chats', clonePlain(store), async (d) => {
                    await writeJson(paths.chats(), d);
                });
                return Promise.resolve(store);
            }
            return writeJson(paths.chats(), clonePlain(store));
        },

        putAsset,
        bulkPutAssets,
        getAllAssets,
        deleteAsset,
        bulkDeleteAssets,

        clearSessionState: () => removeFile(paths.session()),
        clearProjectorState: () => removeFile(paths.projector()),
        clearScope,
        exportAll,

        getBackendInfo,
        openDataFolder,
        openWorldFolder,
        getCustomCss,
        setCustomCss,
        applyCustomCss,

        listWorlds,
        getActiveWorld,
        createWorld,
        renameWorld,
        setActiveWorld,
        duplicateWorld,
        deleteWorld,
        healthCheck,
        exportWorld,
        backupWorld,
        openBackupsFolder,
        importWorldFromFile,
        listGames,
        getGameInfo,
        readGameFile,
        writeGameFile,
        readGameBinaryFile,
        writeGameBinaryFile,
        listGameFiles,
        getGameState,
        setGameState,
        openGameFolder,
        openGamesFolder,
        importGameFromFile,
        exportGame,
        deleteGame,
        createHelloGame,
        createMessengerGame,
        createLifeSimGame,
        getActiveGameId,
        setActiveGameId,
        clearActiveGameId,
    };

    window.VP_NATIVE_STORAGE = Storage;
    window.VP_STORAGE = Storage;
    window.VP_DB = Storage;

    Storage.ready()
        .then(() => console.log('[VP Native Storage] enabled — saving visible files to active world'))
        .catch(err => console.error('[VP Native Storage] init failed:', err));
})();
