// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-gallery.js                                            ║
// ║  Visual Projector — STANDALONE frontend · Right-panel controller  ║
// ║                                                                  ║
// ║  Owns: asset management, folder/category/tab tree (TabsManager),  ║
// ║        AI autotagger, gallery grid + selection, settings panel,   ║
// ║        the floating Gallery/Settings window.                      ║
// ║                                                                  ║
// ║  Persistence: browser storage via window.VP_DB / window.VP_STORAGE║
// ║  (IndexedDB first; assets as real Blobs, metadata in kv store).   ║
// ║  Object URLs (asset.url / asset.thumbUrl) are EPHEMERAL —          ║
// ║  regenerated at runtime, never stored.                            ║
// ║                                                                  ║
// ║  Load order:  fx-core → visual-projector                         ║
// ║             → gallery-depth / gallery-hierarchy /                ║
// ║               gallery-panel / gallery-collage                    ║
// ║             → projector-gallery                                  ║
// ║  (this file captures window.VisualProjector synchronously)        ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// ── ENGINE DEPENDENCY CONTRACT ──────────────────────────────────────
// This module talks to the projector engine exclusively through the
// `window.VisualProjector` (alias VP) facade. It expects:
//
//   VP.state                      shared single source of truth
//   VP.setCurrent(tag, src?, force?, transition?)
//   clearProjectorCurrent('gallery-delete')
//   VP.updateProjectorUI()
//   VP.updatePlayerBar()
//   VP.buildManifest(templateOverride?)
//   VP.buildFrameContextPreview(templateOverride?)
//   VP.schedulePersist()          (config persistence hook; gallery also
//                                  writes config to IDB directly)
//   VP.showToast(msg, type?)
//   VP.showConfirm({title,message,buttons}) → Promise<id>
//   VP.showPromptPreview(title, content)
//   VP.updatePromptHints(textarea, type)
//   VP.updateTemplateStatus(textarea)
//   VP.DEFAULT_MANIFEST_TEMPLATE
//   VP.DEFAULT_FRAME_TEMPLATE
//   VP.FX                         (=== window.FX)
//
// Shared PURE utils are PREFERRED from VP, with local fallback copies so
// the module stays self-contained & testable in isolation:
//   sanitizeTag, blobToBase64, escapeRegex, escapeAttr, insertAtCursor,
//   getElementScale, viewportPointToCssSpace, viewportRectToCssSpace,
//   getNormalizedElementPlacement.
//
// Reverse bridge: on boot this module registers
//   window.VisualProjector.gallery = { ... }
// so the engine can call back into grid renders / TabsManager / Tagger.
// ────────────────────────────────────────────────────────────────────

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP Gallery] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE projector-gallery.js.'
        );
        return;
    }

    const S  = VP.state;          // shared state (by reference)
    const DB = window.VP_DB;      // storage layer (vp-storage.js)

    let activeContextMenuCleanup = null;

    // ════════════════════════════════════════════════════════════════
    //  PURE UTILITIES  (local fallbacks; VP copy preferred)
    // ════════════════════════════════════════════════════════════════

    /** a-z, 0-9, _ only; trimmed; ≤32 chars */
    function _sanitizeTag(str) {
        return String(str == null ? '' : str)
            .toLowerCase()
            .replace(/[\s\-\.]+/g, '_')
            .replace(/[^a-z0-9_]/g, '')
            .replace(/^_+|_+$/g, '')
            .slice(0, 32);
    }

    function _blobToBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror   = reject;
            reader.readAsDataURL(blob);
        });
    }

    function _escapeRegex(str) {
        return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function _escapeAttr(str) {
        return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function _insertAtCursor(textarea, text) {
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + text + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
    }

    // ── geometry helpers (used by panel drag/resize + fly animation) ──
    function _getElementScale(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return { x: 1, y: 1 };
        const rect = el.getBoundingClientRect();
        const sx = el.offsetWidth  > 0 ? (rect.width  / el.offsetWidth)  : 1;
        const sy = el.offsetHeight > 0 ? (rect.height / el.offsetHeight) : 1;
        return {
            x: Number.isFinite(sx) && sx > 0 ? sx : 1,
            y: Number.isFinite(sy) && sy > 0 ? sy : 1,
        };
    }

    function _viewportPointToCssSpace(x, y, el) {
        const scale = _getElementScale(el);
        return { x: x / scale.x, y: y / scale.y, scaleX: scale.x, scaleY: scale.y };
    }

    function _viewportRectToCssSpace(rect, el) {
        const scale = _getElementScale(el);
        return {
            left: rect.left / scale.x, top: rect.top / scale.y,
            width: rect.width / scale.x, height: rect.height / scale.y,
            right: rect.right / scale.x, bottom: rect.bottom / scale.y,
            scaleX: scale.x, scaleY: scale.y,
        };
    }

    function _getNormalizedElementPlacement(el) {
        const rect = el.getBoundingClientRect();
        return { rect, css: _viewportRectToCssSpace(rect, el) };
    }

    function _getLevenshteinDistance(a, b) {
        const matrix = [];
        for (let i = 0; i <= b.length; i++) matrix[i] = [i];
        for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }
        return matrix[b.length][a.length];
    }

    function _fuzzyMatch(target, options, keySelector = (x) => x) {
        if (!target || !options || options.length === 0) return null;
        const normTarget = target.trim().toLowerCase();
        if (!normTarget) return null;

        // 1. Exact match
        let bestMatch = options.find(opt => keySelector(opt).trim().toLowerCase() === normTarget);
        if (bestMatch) return bestMatch;

        // Helper to strip plural/singular differences in Russian/English
        const stripSuffixes = (str) => {
            return str.replace(/(s|es|и|ы|а|я|ов|ей|ям|ам|ами|ями|ах|ях)$/i, '');
        };
        const targetStem = stripSuffixes(normTarget);

        // 2. Suffix-agnostic exact match
        bestMatch = options.find(opt => {
            const normOpt = keySelector(opt).trim().toLowerCase();
            return stripSuffixes(normOpt) === targetStem;
        });
        if (bestMatch) return bestMatch;

        // 3. Substring match (if one contains another)
        bestMatch = options.find(opt => {
            const normOpt = keySelector(opt).trim().toLowerCase();
            return normOpt.includes(normTarget) || normTarget.includes(normOpt);
        });
        if (bestMatch) return bestMatch;

        // 4. Levenshtein match
        let minDistance = Infinity;
        let matchedOption = null;

        for (const opt of options) {
            const optName = keySelector(opt).trim().toLowerCase();
            const dist = _getLevenshteinDistance(normTarget, optName);
            
            // Allow up to 35% length mismatch, with minimum threshold of 2 characters
            const maxAllowedDist = Math.max(2, Math.floor(optName.length * 0.35));
            if (dist <= maxAllowedDist && dist < minDistance) {
                minDistance = dist;
                matchedOption = opt;
            }
        }

        return matchedOption;
    }

    // Prefer engine-shared copies (single source of truth) when present.
    const sanitizeTag                 = VP.sanitizeTag                 || _sanitizeTag;
    const blobToBase64                = VP.blobToBase64                || _blobToBase64;
    const escapeRegex                 = VP.escapeRegex                 || _escapeRegex;
    const escapeAttr                  = VP.escapeAttr                  || _escapeAttr;
    const insertAtCursor              = VP.insertAtCursor              || _insertAtCursor;
    const getElementScale             = VP.getElementScale             || _getElementScale;
    const viewportPointToCssSpace     = VP.viewportPointToCssSpace     || _viewportPointToCssSpace;
    const viewportRectToCssSpace      = VP.viewportRectToCssSpace      || _viewportRectToCssSpace;
    const getNormalizedElementPlacement = VP.getNormalizedElementPlacement || _getNormalizedElementPlacement;
    const getLevenshteinDistance      = VP.getLevenshteinDistance      || _getLevenshteinDistance;
    const fuzzyMatch                  = VP.fuzzyMatch                  || _fuzzyMatch;

    // Engine UI helpers (no local state) — minimal fallbacks for isolation.
    const showToast         = VP.showToast         || ((m) => console.warn('[toast]', m));
    const showConfirm       = VP.showConfirm       || ((o) => Promise.resolve(window.confirm((o && o.message) || '') ? 'ok' : 'cancel'));
    const showPrompt        = VP.showPrompt        || ((o) => Promise.resolve(window.prompt((o && (o.message || o.title)) || '', o?.value || '')));
    const showPromptPreview = VP.showPromptPreview || ((t, c) => alert(t + '\n\n' + c));

    // ════════════════════════════════════════════════════════════════
    //  IMAGE PIPELINE
    // ════════════════════════════════════════════════════════════════

    /**
     * Decode a File, downscale to maxLongSide, re-encode as JPEG Blob.
     * Returns { blob, url } where url is an ephemeral object URL.
     */
    function fileToBlobData(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();

            img.onload = () => {
                URL.revokeObjectURL(url);
                let { naturalWidth: w, naturalHeight: h } = img;
                const maxSide = S.config.maxLongSide || 1024;

                if (Math.max(w, h) > maxSide) {
                    if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; }
                    else        { w = Math.round(w * maxSide / h); h = maxSide; }
                }

                const canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, w, h);
                ctx.drawImage(img, 0, 0, w, h);

                canvas.toBlob((blob) => {
                    if (!blob) return reject(new Error('Canvas toBlob failed'));
                    resolve({ blob, url: URL.createObjectURL(blob) });
                }, 'image/jpeg', S.config.jpegQuality ?? 0.92);
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error(`Не удалось загрузить: ${file.name}`));
            };
            img.src = url;
        });
    }

    /** 128×128 center-cropped JPEG thumbnail as an object URL (ephemeral). */
    function generateThumbUrl(blob) {
        return new Promise((resolve) => {
            const url = URL.createObjectURL(blob);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const SIZE = 128;
                const canvas = document.createElement('canvas');
                canvas.width = SIZE; canvas.height = SIZE;
                const ctx = canvas.getContext('2d');
                const min = Math.min(img.width, img.height);
                const sx  = (img.width  - min) / 2;
                const sy  = (img.height - min) / 2;
                ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
                canvas.toBlob((tb) => {
                    resolve(tb ? URL.createObjectURL(tb) : null);
                }, 'image/jpeg', 0.7);
            };
            img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
            img.src = url;
        });
    }

    /**
     * Lazy thumbnail generator — caches on the asset object.
     * Thumbs are EPHEMERAL (never persisted), so they're rebuilt per session.
     * Returns a usable image src immediately (falls back to asset.url).
     */
    async function ensureThumb(asset) {
        if (asset.thumbUrl) return asset.thumbUrl;
        if (!asset.blob)    return asset.url || null;
        const t = await generateThumbUrl(asset.blob);
        asset.thumbUrl = t;          // cache for this session
        return t;
    }

    /** Import-time helper: accept legacy base64 OR url payload → Blob. */
    async function importAssetPayloadToBlob(asset) {
        const src = asset?.base64 || asset?.url || null;
        if (!src) throw new Error('Asset has neither base64 nor url');
        const res = await fetch(src);
        if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
        return await res.blob();
    }

    // ════════════════════════════════════════════════════════════════
    //  TAG / FOLDER HELPERS
    // ════════════════════════════════════════════════════════════════

    /** Detect junk filenames (numeric, DSC_0001, hashes, untitled…). */
    function isMeaningfulName(name) {
        const junk = [
            /^\d+$/, /^img_?\d+$/i, /^dsc_?\d+$/i, /^photo_?\d+$/i, /^pic_?\d+$/i,
            /^image_?\d+$/i, /^screenshot/i, /^[a-f0-9]{8,}$/i, /^untitled/i, /^\w{1,2}\d{4,}$/,
        ];
        return name.length >= 2 && !junk.some(p => p.test(name));
    }

    /** Folder-tag de-dupe counter (session-scoped, lives on State). */
    function getNextFolderIndex(folder) {
        if (!S.folderIndexCounter) S.folderIndexCounter = {};
        S.folderIndexCounter[folder] = (S.folderIndexCounter[folder] || 0) + 1;
        return S.folderIndexCounter[folder];
    }

    /**
     * Derive a tag from a file's relative path + filename.
     * Meaningful name → sanitized; otherwise folder_index; else asset_N.
     */
    function pathToTag(webkitRelativePath, filename) {
        const nameOnly = String(filename).toLowerCase().replace(/\.[^.]+$/, '');
        const parts  = String(webkitRelativePath).toLowerCase().split('/');
        const folder = parts.length >= 2 ? sanitizeTag(parts[parts.length - 2]) : null;

        let baseTag;
        if (isMeaningfulName(nameOnly)) {
            baseTag = sanitizeTag(nameOnly);
        } else if (folder) {
            return `${folder}_${getNextFolderIndex(folder)}`;
        } else {
            return `asset_${S.gallery.size + 1}`;
        }

        if (folder && !baseTag.startsWith(folder + '_') && baseTag !== folder) {
            return `${folder}_${baseTag}`;
        }
        return baseTag;
    }

    /** Unique tag for an imported asset, dodging collisions. */
    function getUniqueImportedTag(baseTag) {
        const safe = sanitizeTag(baseTag || `asset_${S.gallery.size + 1}`) || `asset_${S.gallery.size + 1}`;
        let final = safe, n = 1;
        while (S.gallery.has(final)) { final = `${safe}_${n++}`.slice(0, 32); }
        return final;
    }

    // ════════════════════════════════════════════════════════════════
    //  IDB WRITE-THROUGH  (replaces the old no-op schedulePersist)
    // ════════════════════════════════════════════════════════════════

    /** Persist a single asset; ephemeral fields are stripped in VP_DB. */
    function persistAsset(asset) {
        if (!DB) return Promise.resolve(null);
        return DB.putAsset(asset)
            .then(record => {
                // Native storage returns the stable file name. Keep it in RAM too so
                // Asset Studio can pass the real world asset file to sd.cpp CLI.
                if (record && asset) {
                    if (record.file) asset.file = record.file;
                    if (record.mime) asset.mime = record.mime;
                }
                return record;
            })
            .catch(e => { console.warn('[VP Gallery] asset persist failed', e); return null; });
    }

    /** Bulk-persist many assets in one transaction (fast for folder imports). */
    function persistAssetsBatch(assets) {
        if (!DB || !assets.length) return;
        DB.bulkPutAssets(assets).catch(e => console.warn('[VP Gallery] bulk persist failed', e));
    }

    /** Persist the category/tab tree (galleryData). */
    function persistGalleryData() {
        if (!DB) return;
        DB.setGalleryData(S.galleryData).catch(e => console.warn('[VP Gallery] galleryData persist failed', e));
    }

    /** Debounced config persist (settings inputs fire rapidly). */
    let _cfgTimer = null;
    function persistConfig() {
        if (!DB) return;
        clearTimeout(_cfgTimer);
        _cfgTimer = setTimeout(() => {
            DB.setConfig(S.config).catch(e => console.warn('[VP Gallery] config persist failed', e));
        }, 400);
    }

    // ════════════════════════════════════════════════════════════════
    //  ASSET LOADING
    // ════════════════════════════════════════════════════════════════

    /** Load a whole folder: builds Category/Tab tree from path, batch-creates assets. */
    function loadGalleryFolder() {
        const input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;

        input.onchange = async (e) => {
            const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
            if (!files.length) { showToast('Нет изображений в папке', 'error'); return; }

            showToast(`Загружаю ${files.length} файлов...`, 'info');
            let loaded = 0, tagConflicts = 0;

            // Caches to avoid per-file DOM re-renders during batch creation.
            const createdCategories = new Map(); // rootName -> catId
            const createdTabs       = new Map(); // catId_parentName -> tabId
            const batchAssets       = [];        // collected for one IDB write

            for (const file of files) {
                try {
                    const { blob, url } = await fileToBlobData(file);
                    const thumbUrl = await generateThumbUrl(blob);
                    const parts = file.webkitRelativePath.split('/');

                    let targetTabId = null;
                    let folderContext = null;

                    if (parts.length > 1) {
                        const rootFolderName   = parts[0];
                        const parentFolderName = parts[parts.length - 2];

                        // 1. Find or create Category
                        let catId = createdCategories.get(rootFolderName);
                        if (!catId) {
                            const existing = S.galleryData.categories.find(c => c.name === rootFolderName);
                            catId = existing ? existing.id
                                : 'cat_' + Date.now() + Math.random().toString(36).substr(2, 5);
                            if (!existing) S.galleryData.categories.push({ id: catId, name: rootFolderName, desc: '', state: 'open' });
                            createdCategories.set(rootFolderName, catId);
                        }

                        // 2. Find or create Tab
                        const tabKey = catId + '_' + parentFolderName;
                        targetTabId = createdTabs.get(tabKey);
                        if (!targetTabId) {
                            const existing = S.galleryData.tabs.find(t => t.categoryId === catId && t.name === parentFolderName);
                            targetTabId = existing ? existing.id
                                : 'tab_' + Date.now() + Math.random().toString(36).substr(2, 5);
                            if (!existing) S.galleryData.tabs.push({ id: targetTabId, categoryId: catId, name: parentFolderName, desc: '', state: 'collapsed' });
                            createdTabs.set(tabKey, targetTabId);
                        }

                        // 3. Middle path → tag prefix (Root / Middle / Parent / File)
                        if (parts.length > 3) {
                            folderContext = parts.slice(1, parts.length - 2).map(sanitizeTag).join('_');
                        }
                    } else {
                        targetTabId = TabsManager.getActiveTabIdForNewAsset();
                    }

                    let tag = pathToTag(file.webkitRelativePath, file.name);
                    if (folderContext && !tag.startsWith(folderContext + '_')) {
                        tag = `${folderContext}_${tag}`.slice(0, 32);
                    }
                    const finalTag = S.gallery.has(tag) ? `${tag}_${++tagConflicts}` : tag;

                    const asset = {
                        tag: finalTag, filename: file.name, path: file.webkitRelativePath,
                        blob, url, thumbUrl, description: '', source: 'user',
                        folderContext: folderContext || (parts.length >= 2 ? sanitizeTag(parts[parts.length - 2]) : null),
                        hidden: false, tabId: targetTabId,
                    };
                    S.gallery.set(finalTag, asset);
                    batchAssets.push(asset);
                    loaded++;
                } catch (err) {
                    console.error(`[VP Gallery] Ошибка: ${file.name}`, err);
                }
            }

            // Focus the last created tab so the user sees their new assets.
            if (createdTabs.size > 0) {
                const last = Array.from(createdTabs.values()).pop();
                if (last) {
                    S.galleryData.activeTabId = last;
                    S.ui.lastAssetTabId = last;
                }
            } else if (S.galleryData.tabs.length > 0 && !S.galleryData.tabs.some(t => t.id === S.galleryData.activeTabId)) {
                S.galleryData.activeTabId = S.galleryData.tabs[0].id;
                S.ui.lastAssetTabId = S.galleryData.activeTabId;
            }

            TabsManager.renderSidebar();
            persistGalleryData();
            persistAssetsBatch(batchAssets);
            if (batchAssets.length) markVisualInventoryDirty('assets-imported-folder');
            updateGalleryButton();
            showToast(`Загружено ${loaded} ассетов`, 'success');

            if (!S.current && S.gallery.size > 0) {
                setProjectorCurrent(S.gallery.values().next().value.tag);
            }
            renderGalleryGrid();
            await VP.gallery.maybeOfferAutoTag?.();
        };

        input.click();
    }

    /** Load a single image file. */
    function loadSingleFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const { blob, url } = await fileToBlobData(file);
                const thumbUrl = await generateThumbUrl(blob);
                const tag = sanitizeTag(file.name.toLowerCase().replace(/\.[^.]+$/, ''));
                const finalTag = isMeaningfulName(tag) ? tag : `asset_${S.gallery.size + 1}`;

                const asset = {
                    tag: finalTag, filename: file.name, path: file.name,
                    blob, url, thumbUrl, description: '', source: 'user',
                    hidden: false, tabId: TabsManager.getActiveTabIdForNewAsset(),
                };
                S.gallery.set(finalTag, asset);
                persistAsset(asset);
                markVisualInventoryDirty('asset-added');
                renderGalleryGrid();
                setProjectorCurrent(finalTag);
                await VP.gallery.maybeOfferAutoTag?.();
            } catch (err) {
                showToast('Ошибка загрузки', 'error');
            }
        };
        input.click();
    }

    function getPublicAssetDescriptor(asset) {
        if (!asset) return null;
        return {
            tag: asset.tag,
            filename: asset.filename || null,
            path: asset.path || null,
            file: asset.file || null,
            mime: asset.mime || asset.blob?.type || null,
            source: asset.source || null,
            tabId: asset.tabId || null,
            hidden: !!asset.hidden,
            draft: !!asset._draft,
            description: asset.description || '',
            hasDescription: !!String(asset.description || '').trim(),
            bytes: Number.isFinite(asset.blob?.size) ? asset.blob.size : null,
            createdAt: asset.createdAt || null,
            updatedAt: asset.updatedAt || null,
            depthMap: asset.depthMap ? {
                file: asset.depthMap.file || null,
                kind: asset.depthMap.kind || null,
                model: asset.depthMap.model || null,
                status: asset.depthMap.status || null,
                width: asset.depthMap.width || null,
                height: asset.depthMap.height || null,
                generatedAt: asset.depthMap.generatedAt || null,
                error: asset.depthMap.error || null,
            } : null,
            hasDepth: asset.depthMap?.status === 'ready',
        };
    }

    function resolveGalleryTag(tag) {
        let cur = String(tag || '').trim();
        if (!cur) return null;
        const visited = new Set();
        while (!S.gallery?.has?.(cur) && S.galleryData?.tagAliases?.[cur]?.to && !visited.has(cur)) {
            visited.add(cur);
            cur = String(S.galleryData.tagAliases[cur].to || '').trim();
        }
        return S.gallery?.has?.(cur) ? cur : null;
    }

    function getPublicTabDescriptor(tab) {
        if (!tab) return null;
        return {
            id: tab.id,
            name: tab.name || tab.title || tab.id,
            categoryId: tab.categoryId || null,
            icon: tab.icon || null,
            order: tab.order || 0,
            assetCount: Array.from(S.gallery.values()).filter(asset => asset.tabId === tab.id && !asset.hidden).length,
        };
    }

    function getGalleryPublicState() {
        const gd = S.galleryData || { categories: [], tabs: [], activeTabId: null, tagAliases: {} };
        const assets = Array.from(S.gallery.values());
        return {
            assetCount: assets.length,
            visibleAssetCount: assets.filter(asset => !asset.hidden).length,
            hiddenAssetCount: assets.filter(asset => !!asset.hidden).length,
            activeTabId: gd.activeTabId || null,
            currentTag: S.current?.tag || null,
            coverTag: S.coverTag || null,
            preparedTag: S.preparedTag || null,
            selectedTags: S.selection?.tags ? Array.from(S.selection.tags) : [],
            tabs: Array.isArray(gd.tabs) ? gd.tabs.map(getPublicTabDescriptor).filter(Boolean) : [],
            categories: Array.isArray(gd.categories) ? gd.categories.map(category => ({
                id: category.id,
                name: category.name || category.title || category.id,
                icon: category.icon || null,
                order: category.order || 0,
            })) : [],
            aliasCount: gd.tagAliases ? Object.keys(gd.tagAliases).length : 0,
        };
    }

    function getGalleryMemorySummary(payload = {}) {
        const includeSamples = payload.samples !== false;
        const assets = Array.from(S.gallery?.values?.() || []);
        const bySource = {};
        const byMime = {};
        const depthStatus = {};
        let blobAssetCount = 0;
        let pathAssetCount = 0;
        let objectUrlCount = 0;
        let thumbUrlCount = 0;
        let totalBlobBytes = 0;
        let unknownByteCount = 0;

        const largeAssets = [];
        for (const asset of assets) {
            const source = String(asset.source || 'unknown');
            bySource[source] = (bySource[source] || 0) + 1;
            const mime = String(asset.mime || asset.blob?.type || 'unknown');
            byMime[mime] = (byMime[mime] || 0) + 1;
            const status = asset.depthMap?.status || (asset.depthMap ? 'unknown' : 'none');
            depthStatus[status] = (depthStatus[status] || 0) + 1;

            if (asset.blob) blobAssetCount += 1;
            if (asset.path || asset.file) pathAssetCount += 1;
            if (asset.url) objectUrlCount += 1;
            if (asset.thumbUrl) thumbUrlCount += 1;
            const bytes = Number(asset.blob?.size);
            if (Number.isFinite(bytes)) {
                totalBlobBytes += bytes;
                if (includeSamples) {
                    largeAssets.push({
                        tag: asset.tag || null,
                        bytes,
                        source: asset.source || null,
                        mime: asset.mime || asset.blob?.type || null,
                        hasThumb: !!asset.thumbUrl,
                    });
                }
            } else {
                unknownByteCount += 1;
            }
        }

        largeAssets.sort((a, b) => b.bytes - a.bytes);
        return {
            ok: true,
            memory: {
                assetCount: assets.length,
                blobAssetCount,
                pathAssetCount,
                objectUrlCount,
                thumbUrlCount,
                totalBlobBytes,
                totalBlobMB: Math.round((totalBlobBytes / (1024 * 1024)) * 100) / 100,
                unknownByteCount,
                bySource,
                byMime,
                depthStatus,
                largestAssets: includeSamples ? largeAssets.slice(0, 10) : [],
            },
        };
    }

    function getGalleryHealth(payload = {}) {
        const includeSamples = payload.samples !== false;
        const gd = S.galleryData || { categories: [], tabs: [], activeTabId: null, tagAliases: {} };
        const assets = Array.from(S.gallery?.values?.() || []);
        const tabs = Array.isArray(gd.tabs) ? gd.tabs : [];
        const categories = Array.isArray(gd.categories) ? gd.categories : [];
        const tabIds = new Set(tabs.map(tab => tab.id));
        const categoryIds = new Set(categories.map(cat => cat.id));
        const tags = new Set(assets.map(asset => asset.tag).filter(Boolean));

        const assetsWithoutTag = assets.filter(asset => !asset.tag).map(asset => asset.filename || asset.path || '(untagged)');
        const assetsWithoutTab = assets.filter(asset => !asset.tabId).map(asset => asset.tag || asset.filename || '(untagged)');
        const assetsWithMissingTab = assets
            .filter(asset => asset.tabId && !tabIds.has(asset.tabId))
            .map(asset => ({ tag: asset.tag || null, tabId: asset.tabId }));
        const tabsWithMissingCategory = tabs
            .filter(tab => tab.categoryId && !categoryIds.has(tab.categoryId))
            .map(tab => ({ id: tab.id, name: tab.name || tab.id, categoryId: tab.categoryId }));
        const emptyTabs = tabs
            .filter(tab => assets.every(asset => asset.tabId !== tab.id || asset.hidden))
            .map(tab => ({ id: tab.id, name: tab.name || tab.id }));
        const aliases = gd.tagAliases && typeof gd.tagAliases === 'object' ? gd.tagAliases : {};
        const staleAliases = Object.entries(aliases)
            .filter(([, rec]) => !tags.has(String(rec?.to || '').trim()))
            .map(([from, rec]) => ({ from, to: rec?.to || null }));
        const selectedTags = S.selection?.tags ? Array.from(S.selection.tags) : [];
        const missingSelection = selectedTags.filter(tag => !tags.has(tag));
        const activeTabValid = !gd.activeTabId || gd.activeTabId === 'effects' || tabIds.has(gd.activeTabId);
        const currentTag = S.current?.tag || null;
        const coverTag = S.coverTag || null;
        const preparedTag = S.preparedTag || null;

        const issues = [];
        if (!activeTabValid) issues.push({ code: 'active-tab-missing', severity: 'warn', detail: gd.activeTabId });
        if (currentTag && !tags.has(currentTag)) issues.push({ code: 'current-tag-missing', severity: 'warn', detail: currentTag });
        if (coverTag && !tags.has(coverTag)) issues.push({ code: 'cover-tag-missing', severity: 'warn', detail: coverTag });
        if (preparedTag && !tags.has(preparedTag)) issues.push({ code: 'prepared-tag-missing', severity: 'warn', detail: preparedTag });
        if (assetsWithoutTag.length) issues.push({ code: 'assets-without-tag', severity: 'warn', count: assetsWithoutTag.length });
        if (assetsWithMissingTab.length) issues.push({ code: 'assets-with-missing-tab', severity: 'info', count: assetsWithMissingTab.length });
        if (tabsWithMissingCategory.length) issues.push({ code: 'tabs-with-missing-category', severity: 'info', count: tabsWithMissingCategory.length });
        if (staleAliases.length) issues.push({ code: 'stale-aliases', severity: 'info', count: staleAliases.length });
        if (missingSelection.length) issues.push({ code: 'selection-missing-tags', severity: 'info', count: missingSelection.length });

        return {
            ok: true,
            healthy: issues.length === 0,
            summary: {
                assetCount: assets.length,
                visibleAssetCount: assets.filter(asset => !asset.hidden).length,
                hiddenAssetCount: assets.filter(asset => !!asset.hidden).length,
                categoryCount: categories.length,
                tabCount: tabs.length,
                emptyTabCount: emptyTabs.length,
                aliasCount: Object.keys(aliases).length,
                selectedCount: selectedTags.length,
                activeTabId: gd.activeTabId || null,
                activeTabValid,
                panelOpen: !!S.ui?.panelOpen,
                panelSection: S.ui?.panelSection || null,
                panelDocked: !!(S.ui?.galleryPanel && isGalleryPanelDocked(S.ui.galleryPanel)),
                currentTag,
                currentTagValid: !currentTag || tags.has(currentTag),
                coverTag,
                coverTagValid: !coverTag || tags.has(coverTag),
                preparedTag,
                preparedTagValid: !preparedTag || tags.has(preparedTag),
            },
            issues,
            samples: includeSamples ? {
                assetsWithoutTag: assetsWithoutTag.slice(0, 20),
                assetsWithoutTab: assetsWithoutTab.slice(0, 20),
                assetsWithMissingTab: assetsWithMissingTab.slice(0, 20),
                tabsWithMissingCategory: tabsWithMissingCategory.slice(0, 20),
                staleAliases: staleAliases.slice(0, 20),
                missingSelection: missingSelection.slice(0, 20),
                emptyTabs: emptyTabs.slice(0, 20),
            } : null,
        };
    }

    function listPublicAssets(payload = {}) {
        const limitRaw = Number(payload.limit ?? 200);
        const offsetRaw = Number(payload.offset ?? 0);
        const limit = Math.max(1, Math.min(1000, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 200));
        const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);
        const includeHidden = payload.includeHidden === true;
        const tabId = payload.tabId ? String(payload.tabId) : null;
        const source = payload.source ? String(payload.source) : null;
        const query = String(payload.query || '').trim().toLowerCase();

        let items = Array.from(S.gallery.values()).filter(asset => {
            if (!includeHidden && asset.hidden) return false;
            if (tabId && asset.tabId !== tabId) return false;
            if (source && asset.source !== source) return false;
            if (query) {
                const haystack = `${asset.tag || ''} ${asset.filename || ''} ${asset.description || ''}`.toLowerCase();
                if (!haystack.includes(query)) return false;
            }
            return true;
        });
        items = items.sort((a, b) => String(a.tag || '').localeCompare(String(b.tag || '')));
        const total = items.length;
        return {
            total,
            offset,
            limit,
            items: items.slice(offset, offset + limit).map(getPublicAssetDescriptor),
        };
    }

    function listPublicTabs() {
        const gd = S.galleryData || { tabs: [], categories: [] };
        return {
            activeTabId: gd.activeTabId || null,
            tabs: Array.isArray(gd.tabs) ? gd.tabs.map(getPublicTabDescriptor).filter(Boolean) : [],
            categories: Array.isArray(gd.categories) ? gd.categories.map(category => ({
                id: category.id,
                name: category.name || category.title || category.id,
                desc: category.desc || category.description || '',
                state: category.state || 'open',
            })) : [],
        };
    }

    function setActiveGalleryTab(tabId) {
        const id = String(tabId || '').trim();
        if (!id) throw new Error('gallery:set-active-tab requires payload.id');
        if (id !== 'effects' && !S.galleryData?.tabs?.some?.(tab => tab.id === id)) {
            throw new Error(`Unknown gallery tab: ${id}`);
        }
        S.galleryData.activeTabId = id;
        if (id !== 'effects') S.ui.lastAssetTabId = id;
        TabsManager.renderSidebar();
        renderGalleryGrid();
        updateGalleryFooter();
        updateGalleryButton();
        persistGalleryData();
        markVisualInventoryDirty('active-tab-changed');
        return S.galleryData.tabs.find(tab => tab.id === id) || { id, name: id };
    }

    function renameGalleryTab(tabId, name) {
        const id = String(tabId || '').trim();
        const finalName = String(name || '').trim();
        if (!id || !finalName) throw new Error('gallery:rename-tab requires id/name');
        const tab = S.galleryData?.tabs?.find?.(t => t.id === id);
        if (!tab) throw new Error(`Unknown gallery tab: ${id}`);
        tab.name = finalName;
        TabsManager.renderSidebar();
        renderGalleryGrid();
        updateGalleryFooter();
        persistGalleryData();
        markVisualInventoryDirty('tab-renamed');
        return tab;
    }

    /**
     * LEGACY / back-compat only (FSM mark-derivation, build 12).
     * `markedForCollage` is no longer an independent axis — it is a pure
     * consequence of the GREEN active scene, owned by `TabsManager._soloOpenTab`.
     * Setting a mark on a tab that is not the active scene would desync the
     * manifest from the collage image, so it is refused here. Callers that want
     * a tab on the showcase must make it the scene instead (dot click /
     * `[TAB:open:Name]`). Unmarking is likewise refused: dissolve the showcase
     * via the collage menu, don't strip the scene of its picture.
     */
    function setGalleryTabCollageMark(tabId, marked = true) {
        const id = String(tabId || '').trim();
        if (!id) throw new Error('gallery:set-tab-collage-mark requires payload.id');
        const tab = S.galleryData?.tabs?.find?.(t => t.id === id);
        if (!tab) throw new Error(`Unknown gallery tab: ${id}`);
        const wantMark = !!marked;
        if (wantMark !== !!tab.markedForCollage) {
            const isScene = tab.state === 'open';
            if (wantMark && !isScene) {
                throw new Error(`Tab "${tab.name || id}" is not the active scene — открой его как сцену ([TAB:open] / зелёный дот), метка выставляется автоматически`);
            }
            if (!wantMark && isScene) {
                throw new Error(`Tab "${tab.name || id}" is the active scene — метку нельзя снять, смените сцену или удалите Gallery View`);
            }
        }
        tab.markedForCollage = wantMark;
        TabsManager.renderSidebar();
        persistGalleryData();
        markVisualInventoryDirty(tab.markedForCollage ? 'tab-added-to-collage' : 'tab-removed-from-collage');
        return tab;
    }

    function openGalleryEphemeral(payload = {}) {
        const section = payload.section === 'settings' ? 'settings' : 'gallery';
        if (!S.ui.galleryPanel) {
            S.ui.galleryPanel = createGalleryPanel();
            positionFloatingGalleryPanel(S.ui.galleryPanel);
            S.ui.galleryPanel.style.display = 'none';
        }
        if (payload.floating !== false && isGalleryPanelDocked(S.ui.galleryPanel)) {
            undockGalleryPanelForFloating(S.ui.galleryPanel, { position: payload.position !== false });
        }
        togglePanel(true, section);
        return {
            ok: true,
            open: true,
            section,
            floating: !!S.ui.galleryPanel && !isGalleryPanelDocked(S.ui.galleryPanel),
        };
    }

    function getGallerySelectionDescriptor() {
        const tags = S.selection?.tags ? Array.from(S.selection.tags) : [];
        return {
            tags,
            count: tags.length,
            anchor: S.selection?.anchor || null,
            assets: tags.map(tag => getPublicAssetDescriptor(S.gallery.get(tag))).filter(Boolean),
        };
    }

    function setGallerySelection(tags = [], anchor = null) {
        if (!S.selection) S.selection = { tags: new Set(), anchor: null };
        S.selection.tags.clear();
        for (const tag of (Array.isArray(tags) ? tags : [tags])) {
            const resolved = resolveGalleryTag(tag);
            if (resolved) S.selection.tags.add(resolved);
        }
        S.selection.anchor = anchor && S.selection.tags.has(anchor) ? anchor : (Array.from(S.selection.tags)[0] || null);
        renderGalleryGrid();
        updateGalleryFooter();
        return getGallerySelectionDescriptor();
    }

    function getCollagePublicState() {
        const collage = S.gallery.get(COLLAGE_TAG);
        const markedTabs = (S.galleryData?.tabs || []).filter(t => t.markedForCollage === true);
        return {
            tag: COLLAGE_TAG,
            exists: !!collage,
            activeAsCover: S.coverTag === COLLAGE_TAG,
            coverTag: S.coverTag || null,
            coverLabel: S.coverLabel || null,
            ...getCollageGenerationState(),
            markedTabs: markedTabs.map(getPublicTabDescriptor).filter(Boolean),
            asset: getPublicAssetDescriptor(collage),
            meta: collage?.collageMeta || null,
        };
    }

    function emitGalleryAssetAdded(asset, reason = 'asset-added') {
        const descriptor = getPublicAssetDescriptor(asset);
        if (!descriptor) return;
        try {
            window.VP_HUB?.emit?.('gallery:asset-added', descriptor, { moduleId: 'gallery', reason });
        } catch (err) {
            console.warn('[VP Gallery] hub emit gallery:asset-added failed:', err);
        }
    }

    function setProjectorCurrent(tag, source = 'user', force = false, transition = null) {
        if (!tag) return false;
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('projector:set-current', { tag, source, force, transition })
                .catch((err) => {
                    console.warn('[VP Gallery] Hub projector:set-current failed; using legacy fallback:', err);
                    VP.setCurrent?.(tag, source, force, transition);
                });
            return true;
        }
        return !!VP.setCurrent?.(tag, source, force, transition);
    }

    function clearProjectorCurrent(source = 'gallery') {
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('projector:clear-current', { source })
                .catch((err) => {
                    console.warn('[VP Gallery] Hub projector:clear-current failed; using legacy fallback:', err);
                    VP.clearCurrent?.(source);
                });
            return true;
        }
        return !!VP.clearCurrent?.(source);
    }

    function requestProjectorUiUpdate(reason = 'gallery') {
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('projector:update-ui', { reason })
                .catch((err) => {
                    console.warn('[VP Gallery] Hub projector:update-ui failed; using legacy fallback:', err);
                    requestProjectorUiUpdate('gallery')
                });
            return true;
        }
        requestProjectorUiUpdate('gallery')
        return false;
    }

    /**
     * Universal single-image acceptor (Blob|File).
     * Used by paste, drag-and-drop, generation.
     * @returns {Promise<string|null>} the new tag, or null on failure.
     */
    async function addImageFromBlob(blob, opts = {}) {
        const { source = 'pasted', suggestedName = null, setAsCurrent = true, instantPersist = true, tabId = null } = opts;

        if (!blob || !blob.type?.startsWith('image/')) {
            showToast('Clipboard has no image', 'error');
            return null;
        }
        try {
            const file = blob instanceof File ? blob
                : new File([blob], suggestedName || 'pasted.png', { type: blob.type });
            const { blob: outBlob, url } = await fileToBlobData(file);
            const thumbUrl = await generateThumbUrl(outBlob);

            let tag;
            if (suggestedName) {
                const nameOnly = suggestedName.toLowerCase().replace(/\.[^.]+$/, '');
                tag = isMeaningfulName(nameOnly) ? sanitizeTag(nameOnly) : null;
            }
            if (!tag) {
                const now = new Date();
                const stamp = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
                tag = `${source}_${stamp}`;
            }
            let finalTag = tag, counter = 1;
            while (S.gallery.has(finalTag)) finalTag = `${tag}_${counter++}`;

            const asset = {
                tag: finalTag,
                filename: file.name || `${finalTag}.png`,
                path: file.name || `${finalTag}.png`,
                blob: outBlob, url, thumbUrl, description: '', source,
                folderContext: null,
                tabId: (tabId && S.galleryData?.tabs?.some(t => t.id === tabId)) ? tabId : TabsManager.getActiveTabIdForNewAsset(),
                hidden: false,
                _draft: !instantPersist,
            };
            S.gallery.set(finalTag, asset);
            if (!asset._draft) {
                await persistAsset(asset);
            }
            markVisualInventoryDirty('asset-added');
            updateGalleryButton();
            renderGalleryGrid();
            if (setAsCurrent) setProjectorCurrent(finalTag);
            emitGalleryAssetAdded(asset, source);
            return finalTag;
        } catch (err) {
            console.error('[VP Gallery] Failed to add image:', err);
            showToast('Failed to load image', 'error');
            return null;
        }
    }

    /**
     * Hub-safe image acceptor. Payload carries only a path + metadata; Gallery
     * becomes the owner that reads binary data and creates Blob/object URLs.
     * No Blob/base64 may cross the Hub boundary.
     * @returns {Promise<string|null>} the new tag, or null on failure.
     */
    async function addImageFromPath(payload = {}) {
        if (!payload || typeof payload !== 'object') {
            throw new Error('gallery:add-image-from-path payload must be an object');
        }
        if ('blob' in payload || 'base64' in payload || 'dataUrl' in payload || 'url' in payload) {
            throw new Error('gallery:add-image-from-path accepts path references only, not Blob/base64/url payloads');
        }

        const filePath = String(payload.path || payload.filePath || '').trim();
        if (!filePath) throw new Error('gallery:add-image-from-path requires payload.path');
        if (!window.Neutralino?.filesystem?.readBinaryFile) {
            throw new Error('Neutralino filesystem is required to import image by path');
        }

        const nameFromPath = filePath.split(/[\\/]/).pop() || 'generated.png';
        const suggestedName = payload.suggestedName || nameFromPath;
        const type = payload.mimeType || mimeForFileName(suggestedName);
        const bytes = await Neutralino.filesystem.readBinaryFile(filePath);
        const blob = new Blob([bytes], { type });

        return addImageFromBlob(blob, {
            source: payload.source || 'generated',
            suggestedName,
            setAsCurrent: payload.setAsCurrent !== false,
            instantPersist: payload.instantPersist !== false,
            tabId: payload.tabId || null,
        });
    }

    function mimeForFileName(name) {
        const ext = String(name || '').toLowerCase().split('.').pop();
        const map = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
        return map[ext] || 'image/png';
    }

    // ════════════════════════════════════════════════════════════════
    //  DEPTH-ANYTHING CLI — SATELLITE BRIDGE
    //  The da3-cli bridge and depth sidecar generator were extracted to
    //  js/gallery-depth.js (loaded BEFORE this file; registers
    //  window.VP_GALLERY_DEPTH). Only the public entry point is re-aliased.
    // ════════════════════════════════════════════════════════════════

    if (!window.VP_GALLERY_DEPTH || typeof window.VP_GALLERY_DEPTH.init !== 'function') {
        console.error(
            '[VP Gallery] window.VP_GALLERY_DEPTH not found.\n' +
            'Load js/gallery-depth.js BEFORE projector-gallery.js.'
        );
        return;
    }

    const _depth = window.VP_GALLERY_DEPTH.init({
        resolveGalleryTag, getPublicAssetDescriptor,
        persistAsset, renderGalleryGrid, updateGalleryFooter,
    });

    const { generateDepthSidecarForAsset } = _depth;


    function registerGalleryHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const hasCommand = (name) => !!hub.inspect?.().commands?.some?.((cmd) => cmd.name === name);
        const hasModule = () => !!hub.inspect?.().modules?.some?.((mod) => mod.id === 'gallery');
        if (!hasModule() && hub.registerModule) {
            try { hub.registerModule({ id: 'gallery', title: 'Gallery', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Gallery] Hub module registration failed:', err); }
        }

        if (!hasCommand('gallery:get-state')) {
            hub.handle('gallery:get-state', () => getGalleryPublicState(), { moduleId: 'gallery' });
        }

        // FSM audit (2026-07-31): read-only FSM snapshot — "where are we and
        // what is the law" (open tab, hall menu, locked-hidden count). The
        // neutral seam for games/FSM modules to query the tab automaton
        // without reaching into galleryData (docs/fsm-audit.md).
        if (!hasCommand('gallery:get-fsm-state')) {
            hub.handle('gallery:get-fsm-state', () => ({
                ok: true,
                state: window.VisualProjector?.gallery?.TabsManager?.getFsmSnapshot?.() || null,
            }), { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:list-assets')) {
            hub.handle('gallery:list-assets', (payload = {}) => listPublicAssets(payload), { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:get-health')) {
            hub.handle('gallery:get-health', (payload = {}) => getGalleryHealth(payload), { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:get-memory-summary')) {
            hub.handle('gallery:get-memory-summary', (payload = {}) => getGalleryMemorySummary(payload), { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:get-asset')) {
            hub.handle('gallery:get-asset', (payload = {}) => {
                const tag = resolveGalleryTag(payload.tag || payload.assetTag);
                if (!tag) return { ok: false, asset: null, error: 'asset-not-found' };
                return { ok: true, tag, asset: getPublicAssetDescriptor(S.gallery.get(tag)) };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:resolve-tag')) {
            hub.handle('gallery:resolve-tag', (payload = {}) => {
                const requestedTag = String(payload.tag || '').trim();
                const tag = resolveGalleryTag(requestedTag);
                return { ok: !!tag, requestedTag, tag };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:refresh-ui')) {
            hub.handle('gallery:refresh-ui', (payload = {}) => {
                if (payload.full !== false) refreshGalleryPanelUI();
                else {
                    renderGalleryGrid();
                    updateGalleryFooter();
                    updateGalleryButton();
                }
                return { ok: true, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:sync-settings-ui')) {
            hub.handle('gallery:sync-settings-ui', () => {
                syncSettingsUI();
                return { ok: true, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:open')) {
            hub.handle('gallery:open', (payload = {}) => openGalleryEphemeral(payload), { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:close')) {
            hub.handle('gallery:close', () => {
                togglePanel(false);
                return { ok: true, open: false, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:toggle')) {
            hub.handle('gallery:toggle', (payload = {}) => {
                if (payload.show === true) return openGalleryEphemeral(payload);
                if (payload.show === false) {
                    togglePanel(false);
                    return { ok: true, open: false, state: getGalleryPublicState() };
                }
                togglePanel(undefined, payload.section === 'settings' ? 'settings' : 'gallery');
                return { ok: true, open: !!S.ui.panelOpen, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:list-tabs')) {
            hub.handle('gallery:list-tabs', () => ({ ok: true, ...listPublicTabs() }), { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:set-active-tab')) {
            hub.handle('gallery:set-active-tab', (payload = {}) => {
                const tab = setActiveGalleryTab(payload.id || payload.tabId);
                return { ok: true, tab: getPublicTabDescriptor(tab), state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:create-tab')) {
            hub.handle('gallery:create-tab', (payload = {}) => {
                const categoryId = payload.categoryId || S.galleryData?.categories?.[0]?.id || TabsManager.createCategory('Main');
                const id = TabsManager.createTab(categoryId, payload.name || payload.title || null);
                if (payload.activate === true) setActiveGalleryTab(id);
                markVisualInventoryDirty('tab-created');
                return { ok: true, tab: getPublicTabDescriptor(S.galleryData.tabs.find(t => t.id === id)), state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:rename-tab')) {
            hub.handle('gallery:rename-tab', (payload = {}) => {
                const tab = renameGalleryTab(payload.id || payload.tabId, payload.name || payload.title);
                return { ok: true, tab: getPublicTabDescriptor(tab), state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:delete-tab')) {
            hub.handle('gallery:delete-tab', (payload = {}) => {
                const id = String(payload.id || payload.tabId || '').trim();
                if (!id) throw new Error('gallery:delete-tab requires payload.id');
                TabsManager.deleteTab(id);
                markVisualInventoryDirty('tab-deleted');
                return { ok: true, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:set-tab-collage-mark')) {
            hub.handle('gallery:set-tab-collage-mark', (payload = {}) => {
                const tab = setGalleryTabCollageMark(payload.id || payload.tabId, payload.marked !== false);
                return { ok: true, tab: getPublicTabDescriptor(tab), state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:rename-asset')) {
            hub.handle('gallery:rename-asset', (payload = {}) => {
                const oldTag = String(payload.oldTag || payload.tag || '').trim();
                const newTag = String(payload.newTag || payload.to || '').trim();
                if (!oldTag || !newTag) throw new Error('gallery:rename-asset requires oldTag/newTag');
                const ok = renameTag(oldTag, newTag);
                renderGalleryGrid();
                updateGalleryFooter();
                requestProjectorUiUpdate('gallery:rename-asset');
                return { ok, asset: ok ? getPublicAssetDescriptor(S.gallery.get(newTag)) : null, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:delete-assets')) {
            hub.handle('gallery:delete-assets', (payload = {}) => {
                const tags = Array.isArray(payload.tags) ? payload.tags : [payload.tag].filter(Boolean);
                const count = deleteAssets(tags);
                renderGalleryGrid();
                updateGalleryFooter();
                updateGalleryButton();
                requestProjectorUiUpdate('gallery:delete-assets');
                return { ok: true, count, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:set-asset-visibility')) {
            hub.handle('gallery:set-asset-visibility', (payload = {}) => {
                const tags = Array.isArray(payload.tags) ? payload.tags : [payload.tag].filter(Boolean);
                const count = setAssetVisibility(tags, payload.hidden !== false);
                renderGalleryGrid();
                updateGalleryFooter();
                return { ok: true, count, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:move-assets-to-tab')) {
            hub.handle('gallery:move-assets-to-tab', (payload = {}) => {
                const tags = Array.isArray(payload.tags) ? payload.tags : [payload.tag].filter(Boolean);
                const tabId = String(payload.tabId || payload.targetTabId || '').trim();
                if (!tabId) throw new Error('gallery:move-assets-to-tab requires payload.tabId');
                const count = moveAssetsToTab(tags, tabId);
                return { ok: true, count, state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:get-selection')) {
            hub.handle('gallery:get-selection', () => ({ ok: true, selection: getGallerySelectionDescriptor() }), { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:set-selection')) {
            hub.handle('gallery:set-selection', (payload = {}) => ({ ok: true, selection: setGallerySelection(payload.tags || payload.tag || [], payload.anchor || null) }), { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:clear-selection')) {
            hub.handle('gallery:clear-selection', () => { clearSelection(); return { ok: true, selection: getGallerySelectionDescriptor() }; }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:get-collage-state')) {
            hub.handle('gallery:get-collage-state', () => ({ ok: true, collage: getCollagePublicState() }), { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:build-collage')) {
            hub.handle('gallery:build-collage', async (payload = {}) => {
                const asset = await generateCollageFromMarkedTabs({ reason: payload.reason || 'hub', force: payload.force === true });
                return { ok: !!asset, asset: getPublicAssetDescriptor(asset), collage: getCollagePublicState() };
            }, { moduleId: 'gallery' });
        }
        if (!hasCommand('gallery:apply-gallery-view')) {
            hub.handle('gallery:apply-gallery-view', () => {
                applyCover(COLLAGE_TAG, { showOnProjector: true });
                return { ok: true, collage: getCollagePublicState(), state: getGalleryPublicState() };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:depth-generate')) {
            hub.handle('gallery:depth-generate', async (payload = {}) => generateDepthSidecarForAsset(payload), { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:add-image-from-path')) {
            hub.handle('gallery:add-image-from-path', async (payload) => {
                const tag = await addImageFromPath(payload);
                return {
                    ok: !!tag,
                    tag,
                    asset: tag ? getPublicAssetDescriptor(S.gallery.get(tag)) : null,
                };
            }, { moduleId: 'gallery' });
        }

        if (!hasCommand('gallery:import-generated-asset')) {
            hub.handle('gallery:import-generated-asset', async (payload = {}) => {
                const tag = await addImageFromPath({
                    ...payload,
                    source: payload.source || 'generated',
                    setAsCurrent: payload.setAsCurrent === true,
                    instantPersist: payload.instantPersist === true,
                });
                return {
                    ok: !!tag,
                    tag,
                    asset: tag ? getPublicAssetDescriptor(S.gallery.get(tag)) : null,
                };
            }, { moduleId: 'gallery' });
        }
    }

    /** Paste an image from the system clipboard. */
    async function pasteFromClipboard() {
        if (!navigator.clipboard?.read) {
            showToast('Clipboard API not supported in this browser', 'error');
            return;
        }
        try {
            const items = await navigator.clipboard.read();
            for (const item of items) {
                const imageType = item.types.find(t => t.startsWith('image/'));
                if (imageType) {
                    const blob = await item.getType(imageType);
                    const tag = await addImageFromBlob(blob, { source: 'pasted', setAsCurrent: true });
                    if (tag) showToast(`📋 Pasted as "${tag}"`, 'success');
                    return;
                }
            }
            showToast('No image in clipboard', 'info');
        } catch (err) {
            if (err.name === 'NotAllowedError') showToast('Clipboard permission denied', 'error');
            else { console.error('[VP Gallery] Paste error:', err); showToast('Failed to read clipboard', 'error'); }
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  ASSET MUTATIONS  (rename / delete / visibility)
    // ════════════════════════════════════════════════════════════════

    /** Rename a tag (key change). Keeps history/current/cover in sync. */
    function renameTag(oldTag, newTag) {
        newTag = sanitizeTag(newTag);
        if (!newTag) { showToast('Пустой тег — отмена', 'error'); return false; }
        if (oldTag === newTag) return true;
        if (S.gallery.has(newTag)) { showToast(`Тег "${newTag}" уже занят`, 'error'); return false; }

        const asset = S.gallery.get(oldTag);
        asset.tag = newTag;
        S.gallery.delete(oldTag);
        S.gallery.set(newTag, asset);

        if (S.current?.tag === oldTag) S.current = asset;
        S.history.forEach(h => { if (h.tag === oldTag) h.tag = newTag; });
        if (S.coverTag === oldTag) { S.coverTag = newTag; if (DB) DB.setCoverTag(newTag); }
        if (S.preparedTag === oldTag) { S.preparedTag = newTag; if (DB) DB.setPreparedTag(newTag); }
        registerTagAlias(oldTag, newTag, 'asset-rename-before-visual-inventory-refresh');
        markVisualInventoryDirty('asset-renamed');

        // IDB: key changed → delete old record, write new one.
        if (DB) { DB.deleteAsset(oldTag); DB.putAsset(asset); }
        updateGalleryButton();
        showToast(`${oldTag} → ${newTag}`, 'success');
        return true;
    }

    /**
     * Delete one or more assets; cascades current/cover/prepared/selection
     * and removes them from IndexedDB in a single transaction.
     */
    function deleteAssets(tags) {
        const list = Array.isArray(tags) ? tags.slice() : [tags];
        if (!list.length) return 0;
        for (const tag of list) {
            S.gallery.delete(tag);
            if (S.current?.tag === tag) clearProjectorCurrent('gallery-delete');
            if (S.coverTag === tag) { S.coverTag = null; if (DB) DB.setCoverTag(null); }
            if (S.preparedTag === tag) { S.preparedTag = null; if (DB) DB.setPreparedTag(null); }
            S.selection.tags.delete(tag);
            if (S.selection.anchor === tag) S.selection.anchor = null;
        }
        if (DB) DB.bulkDeleteAssets(list).catch(e => console.warn('[VP Gallery] bulk delete failed', e));
        markVisualInventoryDirty('asset-deleted');
        return list.length;
    }

    /** Toggle hidden-flag for a set of assets (hidden = invisible to the model). */
    function setAssetVisibility(tags, hidden) {
        const list = Array.isArray(tags) ? tags : [tags];
        let changed = 0;
        for (const tag of list) {
            const a = S.gallery.get(tag);
            if (a && a.hidden !== hidden) { a.hidden = hidden; changed++; persistAsset(a); }
        }
        if (changed > 0) markVisualInventoryDirty('asset-visibility-changed');
        return changed;
    }

    /** Apply a single draft: persist to IDB and clear the draft flag. */
    function applyDraft(tag) {
        const asset = S.gallery.get(tag);
        if (!asset || !asset._draft) return false;
        asset._draft = false;
        persistAsset(asset);
        markVisualInventoryDirty('draft-applied');
        showToast(`✅ Applied: ${tag}`, 'success');
        return true;
    }

    /** Apply all drafts in one batch. */
    function applyAllDrafts() {
        const drafts = Array.from(S.gallery.values()).filter(a => a._draft);
        if (!drafts.length) { showToast('No drafts to apply', 'info'); return 0; }
        const batch = [];
        for (const asset of drafts) {
            asset._draft = false;
            batch.push(asset);
        }
        if (batch.length) persistAssetsBatch(batch);
        markVisualInventoryDirty('drafts-applied-all');
        renderGalleryGrid();
        updateGalleryFooter();
        showToast(`✅ Applied ${batch.length} draft(s)`, 'success');
        return batch.length;
    }

    /** Discard (delete) all drafts at once. */
    async function discardAllDrafts() {
        const drafts = Array.from(S.gallery.values()).filter(a => a._draft);
        if (!drafts.length) { showToast('No drafts to discard', 'info'); return 0; }
        const ans = await showConfirm({
            title: 'Discard all drafts?',
            message: `Удалить все ${drafts.length} черновик(ов)? Они не сохранены на диск.`,
            buttons: [
                { id: 'cancel', label: 'Cancel', ghost: true },
                { id: 'ok', label: 'Discard All', danger: true },
            ],
        });
        if (ans !== 'ok') return 0;
        const tags = drafts.map(a => a.tag);
        deleteAssets(tags);
        S.selection.tags.clear();
        S.selection.anchor = null;
        renderGalleryGrid();
        updateGalleryFooter();
        showToast(`🗑️ Discarded ${tags.length} draft(s)`, 'success');
        return tags.length;
    }

    const TAG_ALIAS_TTL_MS = 10 * 60 * 1000;

    function registerTagAlias(oldTag, newTag, reason = 'asset-rename') {
        if (!oldTag || !newTag || oldTag === newTag) return;
        if (!S.galleryData.tagAliases || typeof S.galleryData.tagAliases !== 'object') {
            S.galleryData.tagAliases = {};
        }
        // Studio 2.0: Permanent aliases to prevent broken links in old chats
        S.galleryData.tagAliases[oldTag] = {
            to: newTag,
            reason,
            createdAt: Date.now()
            // No expiresAt — renames are permanent
        };
        persistGalleryData();
    }

    function dataTransferHasType(dt, type) {
        try { return Array.from(dt?.types || []).includes(type); }
        catch { return false; }
    }

    function readAssetMoveBatchFromDataTransfer(dt) {
        if (!dt || !dataTransferHasType(dt, 'vp/asset-move-batch')) return [];
        try {
            const raw = dt.getData('vp/asset-move-batch');
            const list = JSON.parse(raw || '[]');
            return Array.isArray(list) ? list.map(String).filter(Boolean) : [];
        } catch {
            return [];
        }
    }

    function moveAssetsToTab(tags, targetTabId) {
        const targetTab = S.galleryData?.tabs?.find(t => t.id === targetTabId);
        if (!targetTab || targetTab.id === 'effects') return 0;

        const uniqueTags = [...new Set((Array.isArray(tags) ? tags : [tags]).map(String).filter(Boolean))]
            .filter(tag => tag !== '__SCENERY_COLLAGE__');
        if (uniqueTags.length === 0) return 0;

        const moved = [];
        for (const tag of uniqueTags) {
            const asset = S.gallery.get(tag);
            if (!asset || asset.tabId === targetTab.id) continue;
            asset.tabId = targetTab.id;
            moved.push(asset);
        }

        if (moved.length === 0) return 0;
        persistAssetsBatch(moved);
        S.selection.tags.clear();
        S.selection.anchor = null;
        renderGalleryGrid();
        updateGalleryFooter();
        TabsManager.renderSidebar();
        showToast(`Перемещено в «${targetTab.name}»: ${moved.length} ассет${moved.length === 1 ? '' : 'ов'}`, 'success');
        markVisualInventoryDirty('asset-moved-to-tab');
        return moved.length;
    }

    // ════════════════════════════════════════════════════════════════
    //  EXPORT / IMPORT  (JSON — portable, cross-install)
    // ════════════════════════════════════════════════════════════════

    /**
     * Export assets (all or a selection) to a downloadable JSON.
     * Blobs are serialized to base64 so the file is self-contained.
     */
    async function exportGallery(filterTags = null) {
        const filter = filterTags
            ? (filterTags instanceof Set ? filterTags : new Set(filterTags))
            : null;

        if (S.gallery.size === 0) { showToast('Галерея пуста — нечего сохранять', 'error'); return; }

        let assets = Array.from(S.gallery.values());
        if (filter) assets = assets.filter(a => filter.has(a.tag));
        if (assets.length === 0) { showToast('Нечего экспортировать — выделение пустое', 'error'); return; }

        const data = {
            version: 2,
            exported: Date.now(),
            current: S.current?.tag || null,
            cover: S.coverTag || null,
            coverLabel: S.coverLabel || 'cover',
            prepared: S.preparedTag || null,
            galleryData: S.galleryData,
            assets: await Promise.all(assets.map(async a => ({
                tag: a.tag, filename: a.filename, path: a.path,
                base64: a.blob ? await blobToBase64(a.blob) : (a.base64 || null),
                description: a.description || '',
                hidden: false,
                source: a.source || 'user',
                folderContext: a.folderContext || null,
                tabId: a.tabId || null,
                collageMeta: a.collageMeta || null,
            }))),
        };

        const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `vp-gallery${filter ? '-selection' : ''}-${new Date().toISOString().slice(0,10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        showToast(`Сохранено ${data.assets.length} ассет${data.assets.length === 1 ? '' : 'ов'}`, 'success');
    }

    /** Import assets + tree from a previously exported JSON file. */
    function importGallery() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';

        input.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            try {
                const data = JSON.parse(await file.text());
                if (!Array.isArray(data.assets)) { showToast('Неверный формат файла', 'error'); return; }

                if (data.galleryData) {
                    S.galleryData = data.galleryData;
                    TabsManager.init();
                }

                let loaded = 0, failed = 0;
                const importedTagMap = new Map();   // originalTag → finalTag
                const batchAssets = [];

                for (const asset of data.assets) {
                    if (!asset?.tag) { failed++; continue; }
                    try {
                        const blob = await importAssetPayloadToBlob(asset);
                        const url = URL.createObjectURL(blob);
                        const thumbUrl = await generateThumbUrl(blob);
                        const finalTag = getUniqueImportedTag(asset.tag);

                        const rec = {
                            tag: finalTag,
                            filename: asset.filename || finalTag,
                            path: asset.path || asset.filename || finalTag,
                            blob, url, thumbUrl,
                            description: asset.description || '',
                            source: asset.source || 'imported',
                            folderContext: asset.folderContext || null,
                            hidden: false,
                            tabId: asset.tabId || null,
                            collageMeta: asset.collageMeta || null,
                        };
                        S.gallery.set(finalTag, rec);
                        batchAssets.push(rec);
                        importedTagMap.set(asset.tag, finalTag);
                        loaded++;
                    } catch (err) {
                        failed++;
                        console.warn('[VP Gallery] Import asset failed:', asset?.tag, err);
                    }
                }

                TabsManager.init();
                TabsManager.renderSidebar();

                // Restore cover + label + prepared (after assets exist).
                const restoredCover = data.cover ? importedTagMap.get(data.cover) : null;
                if (restoredCover && S.gallery.has(restoredCover)) {
                    S.coverTag = restoredCover;
                    if (DB) DB.setCoverTag(restoredCover);
                }
                if (data.coverLabel) { S.coverLabel = data.coverLabel; if (DB) DB.setCoverLabel(data.coverLabel); }
                const restoredPrepared = data.prepared ? importedTagMap.get(data.prepared) : null;
                if (restoredPrepared && S.gallery.has(restoredPrepared)) {
                    S.preparedTag = restoredPrepared;
                    if (DB) DB.setPreparedTag(restoredPrepared);
                }

                // Restore active frame.
                const restoredCurrent = data.current ? importedTagMap.get(data.current) : null;
                if (restoredCurrent && S.gallery.has(restoredCurrent)) {
                    setProjectorCurrent(restoredCurrent);
                } else if (loaded > 0 && !S.current) {
                    setProjectorCurrent(Array.from(importedTagMap.values())[0]);
                }

                if (S.galleryData.activeTabId && S.galleryData.activeTabId !== 'effects') {
                    S.ui.lastAssetTabId = S.galleryData.activeTabId;
                }

                updateGalleryButton();
                refreshGalleryPanelUI();
                persistGalleryData();
                persistAssetsBatch(batchAssets);
                if (batchAssets.length) markVisualInventoryDirty('assets-imported-json');

                showToast(failed > 0 ? `Импорт: ${loaded} ок, ${failed} пропущено` : `Загружено ${loaded} ассетов`,
                          failed > 0 ? 'info' : 'success');
            } catch (err) {
                showToast('Ошибка чтения файла', 'error');
                console.error('[VP Gallery] Import error:', err);
            }
        };
        input.click();
    }

    // ════════════════════════════════════════════════════════════════
    //  HIERARCHY TREE (categories/tabs) + CONTEXT MENUS — SATELLITE BRIDGE
    //  The category/tab tree controller (TabsManager), its strip rendering,
    //  inline rename, drag-to-move and the right-click menus were extracted
    //  to js/gallery-hierarchy.js (loaded BEFORE this file; registers
    //  window.VP_GALLERY_HIERARCHY). TabsManager is re-aliased here so the
    //  rest of the module and the reverse bridge stay untouched.
    // ════════════════════════════════════════════════════════════════

    if (!window.VP_GALLERY_HIERARCHY || typeof window.VP_GALLERY_HIERARCHY.init !== 'function') {
        console.error(
            '[VP Gallery] window.VP_GALLERY_HIERARCHY not found.\n' +
            'Load js/gallery-hierarchy.js BEFORE projector-gallery.js.'
        );
        return;
    }

    const _hierarchy = window.VP_GALLERY_HIERARCHY.init({
        // host functions owned by this module:
        deleteAssets, moveAssetsToTab, renderGalleryGrid, updateGalleryButton, updateGalleryFooter,
        requestProjectorUiUpdate, persistGalleryData,
        fuzzyMatch, viewportPointToCssSpace, viewportRectToCssSpace,
        dataTransferHasType, readAssetMoveBatchFromDataTransfer,
        // collage satellite handle, resolved lazily (it inits later in this file):
        getCollageApi: () => _collage,
        // shared cross-module context-menu slot (owned here):
        getActiveContextMenuCleanup: () => activeContextMenuCleanup,
        setActiveContextMenuCleanup: (fn) => { activeContextMenuCleanup = fn; },
    });

    const { TabsManager } = _hierarchy;


    // ════════════════════════════════════════════════════════════════
    //  FLOATING GALLERY / SETTINGS PANEL — SATELLITE BRIDGE
    //  The floating window (styles, drag/resize, persisted geometry),
    //  the gallery toolbar and the settings section were extracted to
    //  js/gallery-panel.js (loaded BEFORE this file; registers
    //  window.VP_GALLERY_PANEL). Public surface re-aliased below so the
    //  rest of the module and the reverse bridge stay untouched.
    // ════════════════════════════════════════════════════════════════

    if (!window.VP_GALLERY_PANEL || typeof window.VP_GALLERY_PANEL.init !== 'function') {
        console.error(
            '[VP Gallery] window.VP_GALLERY_PANEL not found.\n' +
            'Load js/gallery-panel.js BEFORE projector-gallery.js.'
        );
        return;
    }

    const _panel = window.VP_GALLERY_PANEL.init({
        // host functions owned by this module:
        renderGalleryGrid, updateGalleryButton, updateGalleryFooter, requestProjectorUiUpdate,
        clearSelection, deleteAssets, exportGallery, importGallery,
        loadGalleryFolder, loadSingleFile, pasteFromClipboard, applyAllDrafts, discardAllDrafts,
        persistConfig, getNormalizedElementPlacement,
        // hierarchy satellite (already initialized above):
        getTabsManager: () => TabsManager,
        // collage satellite handle, resolved lazily (it inits later in this file):
        getCollageApi: () => _collage,
    });

    const {
        createGalleryPanel, togglePanel, syncSettingsUI, activatePanelSection,
        isGalleryPanelDocked, positionFloatingGalleryPanel, undockGalleryPanelForFloating,
    } = _panel;


    // ════════════════════════════════════════════════════════════════
    //  CONTACT SHEET / COLLAGE — SATELLITE BRIDGE
    //  The collage engine (layout solver, canvas/worker rendering,
    //  generation lifecycle, collage context menu) was extracted to
    //  js/gallery-collage.js (loaded BEFORE this file; registers
    //  window.VP_GALLERY_COLLAGE). Here we only inject host deps and
    //  re-alias the public API so the rest of the module is unchanged.
    // ════════════════════════════════════════════════════════════════

    if (!window.VP_GALLERY_COLLAGE || typeof window.VP_GALLERY_COLLAGE.init !== 'function') {
        console.error(
            '[VP Gallery] window.VP_GALLERY_COLLAGE not found.\n' +
            'Load js/gallery-collage.js BEFORE projector-gallery.js.'
        );
        return;
    }

    const _collage = window.VP_GALLERY_COLLAGE.init({
        // host functions owned by this module:
        applyCover, deleteAssets, generateThumbUrl, persistAsset, persistGalleryData,
        renderGalleryGrid, updateGalleryFooter, updateGalleryButton, requestProjectorUiUpdate,
        // lazily-resolved host objects / shared cross-module state:
        getTabsManager: () => TabsManager,
        getActiveContextMenuCleanup: () => activeContextMenuCleanup,
        setActiveContextMenuCleanup: (fn) => { activeContextMenuCleanup = fn; },
    });

    const {
        COLLAGE_TAG,
        getCollageGenerationState,
        markVisualInventoryDirty,
        generateCollageFromMarkedTabs, showCollageContextMenu,
        buildContactSheet, collectCollagePlan, calculateContactSheetLayout,
    } = _collage;


    function toggleMode()     { togglePanel(undefined, 'gallery'); }
    function toggleSettings() { togglePanel(undefined, 'settings'); }

    // ┌──────────────────────────────────────────────────────────────┐
    // ════════════════════════════════════════════════════════════════
    //  COVER MANAGEMENT  (set from asset context menu; persisted)
    // ════════════════════════════════════════════════════════════════

    /**
     * Canonical cover setter.
     * Hides the previous cover from the model, sets coverTag, and (in the
     * pre-send no-messages state) remembers the active frame as `prepared`.
     */
    function applyCover(tag, options = {}) {
        if (!options || typeof options !== 'object') options = {};

        if (!tag) {
            const wasCurrentCover = !!(S.coverTag && S.current?.tag === S.coverTag);
            S.coverTag = null;
            if (DB) DB.setCoverTag(null);
            if (wasCurrentCover && S.preparedTag && S.gallery.has(S.preparedTag)) {
                setProjectorCurrent(S.preparedTag, 'prepared', true);
                S.playback.cursor = S.playback.messages.length === 0 ? 0 : -1;
            } else {
                requestProjectorUiUpdate('gallery')
            }
            VP.persistProjectorState?.();
            refreshGalleryPanelUI();
            window.VP_COLLAGE_PILL?.refresh?.();   // v18: cover cleared → pill leaves "live"
            return;
        }
        if (!S.gallery.has(tag)) return;

        const previousCurrentTag = S.current?.tag || null;
        const shouldShowOnProjector = options.showOnProjector ?? (S.playback.messages.length === 0);

        S.coverTag = tag;
        if (DB) DB.setCoverTag(tag);

        if (S.playback.messages.length === 0) {
            if (previousCurrentTag && previousCurrentTag !== tag) {
                S.preparedTag = previousCurrentTag;
                if (DB) DB.setPreparedTag(previousCurrentTag);
            } else {
                S.preparedTag = null;
                if (DB) DB.setPreparedTag(null);
            }
            if (shouldShowOnProjector) S.playback.cursor = 0;
        }

        showToast(`Cover установлен: ${tag}`, 'success');
        if (shouldShowOnProjector) {
            setProjectorCurrent(tag, 'cover', true);
        } else {
            requestProjectorUiUpdate('gallery')
        }
        VP.persistProjectorState?.();
        refreshGalleryPanelUI();
        window.VP_COLLAGE_PILL?.refresh?.();   // v18: cover changed → pill updates live marker
    }

    // ════════════════════════════════════════════════════════════════
    //  FX SHELF  (renders the Effects tab of the grid)
    // ════════════════════════════════════════════════════════════════

    function getFXRegistryEntries() {
        const FX = VP.FX;
        if (!FX || !FX.registry) return [];
        return FX.registry instanceof Map ? Array.from(FX.registry.entries()) : Object.entries(FX.registry);
    }

    function renderEffectsGalleryGrid(grid, countLabel, filterVal) {
        const FX = VP.FX;
        const showDeleted = !!S.ui.fxShowDeleted;
        const allEntries = getFXRegistryEntries();

        const deletedNames = FX ? allEntries.map(([n]) => n).filter(n => FX.isDeleted(n)) : [];
        const hiddenCount  = FX ? allEntries.map(([n]) => n).filter(n => FX.isHidden(n) && !FX.isDeleted(n)).length : 0;

        const fxControls = (S.ui.galleryPanel || S.ui.vpWindow)?.querySelector('#vp-fx-controls');
        if (fxControls) {
            fxControls.style.display = 'flex';
            const stat = fxControls.querySelector('#vp-fx-hidden-stat');
            if (stat) stat.innerHTML = `🙈 <b style="color:var(--text-primary,#cdd6f4)">${hiddenCount}</b>`;
            const trashBtn = fxControls.querySelector('.vp-fx-trash-toggle');
            if (trashBtn) {
                trashBtn.textContent = showDeleted ? '↩ Назад' : `🗑 Корзина (${deletedNames.length})`;
                trashBtn.title = showDeleted ? 'Вернуться к списку эффектов' : 'Показать удалённые эффекты';
                const fresh = trashBtn.cloneNode(true);
                trashBtn.replaceWith(fresh);
                fresh.addEventListener('click', () => { S.ui.fxShowDeleted = !showDeleted; renderGalleryGrid(); });
            }
        }

        const pool = allEntries.filter(([name]) => {
            const deleted = FX ? FX.isDeleted(name) : false;
            return showDeleted ? deleted : !deleted;
        });
        const effects = pool
            .filter(([name, fx]) => {
                const hay = [name, fx?.type || '', fx?.description || '', FX ? FX.getEffectSource(name) : ''].join(' ').toLowerCase();
                return !filterVal || hay.includes(filterVal);
            })
            .sort(([a], [b]) => a.localeCompare(b));

        if (effects.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'vp-gallery-empty';
            empty.style.gridColumn = '1 / -1';
            empty.textContent = showDeleted
                ? (filterVal ? 'В корзине ничего не найдено' : 'Корзина пуста 🎉')
                : (filterVal ? 'Эффекты не найдены' : 'В реестре FX пока нет эффектов');
            grid.appendChild(empty);
            countLabel.textContent = showDeleted ? `${deletedNames.length} в корзине` : '0 эффектов';
            return;
        }
        countLabel.textContent = showDeleted ? `${effects.length} в корзине` : `${effects.length} эффект${effects.length === 1 ? '' : 'ов'}`;

        const mkBtn = (label, title, onClick) => {
            const b = document.createElement('button');
            b.textContent = label; b.title = title;
            b.style.cssText = `border:none; cursor:pointer; width:22px; height:22px; line-height:1; border-radius:5px; font-size:12px; background:rgba(0,0,0,0.55); color:#fff; display:flex; align-items:center; justify-content:center; padding:0;`;
            b.addEventListener('mouseenter', () => b.style.background = 'rgba(0,0,0,0.8)');
            b.addEventListener('mouseleave', () => b.style.background = 'rgba(0,0,0,0.55)');
            b.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); onClick(); });
            b.addEventListener('dragstart', (e) => { e.preventDefault(); e.stopPropagation(); });
            return b;
        };

        for (const [name, fx] of effects) {
            const source = FX ? FX.getEffectSource(name) : 'builtin';
            const isBuiltin = source === 'builtin';
            const hidden = FX ? FX.isHidden(name) : false;
            const deleted = FX ? FX.isDeleted(name) : false;

            const item = document.createElement('div');
            item.className = 'vp-gallery-item vp-gallery-item-fx';
            item.draggable = !deleted;
            item.title = deleted ? `«${name}» в корзине — восстановите, чтобы использовать` : `Перетащите, чтобы вставить [FX:${name}]`;
            item.style.cssText = `display:flex; flex-direction:column; cursor:${deleted ? 'default' : 'grab'}; position:relative; opacity:${deleted ? '0.7' : (hidden ? '0.5' : '1')};`;

            if (!deleted) {
                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.clearData();
                    e.dataTransfer.setData('text/plain', `[FX:${name}] `);
                    e.dataTransfer.effectAllowed = 'copy';
                    if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(item, 20, 20);
                });
            }

            const preview = document.createElement('div');
            preview.style.cssText = `position:relative; min-height:56px; max-height:64px; display:flex; align-items:center; justify-content:center; gap:4px; font-size:22px; line-height:1; padding:6px; background:linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03)); border-bottom:1px solid rgba(255,255,255,0.08); user-select:none; overflow:hidden; white-space:nowrap;`;
            const emojiRaw = (fx && fx.emoji) ? String(fx.emoji) : '✨';
            const emojiParts = Array.from(emojiRaw).filter(ch => ch.trim().length > 0).slice(0, 3);
            const emojiText = document.createElement('span');
            emojiText.textContent = emojiParts.length ? emojiParts.join(' ') : '✨';
            preview.appendChild(emojiText);

            if (hidden && !deleted) {
                const hideTag = document.createElement('div');
                hideTag.textContent = '🙈 скрыт';
                hideTag.style.cssText = `position:absolute; top:4px; left:4px; font-size:9px; padding:1px 5px; border-radius:999px; background:rgba(0,0,0,0.55); color:#f5c542;`;
                preview.appendChild(hideTag);
            }

            const actions = document.createElement('div');
            actions.style.cssText = `position:absolute; top:4px; right:4px; display:flex; gap:4px;`;
            if (deleted) {
                actions.appendChild(mkBtn('↩', 'Восстановить эффект', () => {
                    FX.restoreEffect(name); showToast(`Восстановлен: ${name}`, 'success'); renderGalleryGrid();
                }));
            } else {
                actions.appendChild(mkBtn(hidden ? '👁' : '👁‍🗨', hidden ? 'Показать боту' : 'Скрыть от бота', () => {
                    const now = FX.toggleHidden(name);
                    showToast(now ? `Скрыт от бота: ${name}` : `Виден боту: ${name}`, 'info'); renderGalleryGrid();
                }));
                actions.appendChild(mkBtn('🗑', isBuiltin ? 'Удалить (можно восстановить)' : 'Удалить (в корзину)', () => {
                    FX.deleteEffect(name); showToast(`Удалён: ${name} (см. Корзину)`, 'info'); renderGalleryGrid();
                }));
            }
            preview.appendChild(actions);

            const body = document.createElement('div');
            body.style.cssText = `padding:6px 8px; display:flex; flex-direction:column; gap:4px;`;
            const topRow = document.createElement('div');
            topRow.style.cssText = `display:flex; align-items:center; justify-content:space-between; gap:8px;`;
            const nameEl = document.createElement('div');
            nameEl.className = 'vp-gallery-item-tag'; nameEl.textContent = name; nameEl.title = name; nameEl.style.margin = '0';
            const typeBadge = document.createElement('div');
            typeBadge.textContent = (fx && fx.type) ? fx.type : 'fx';
            typeBadge.style.cssText = `font-size:10px; text-transform:uppercase; letter-spacing:0.04em; padding:2px 6px; border-radius:999px; background:rgba(255,255,255,0.10); color:var(--text-secondary,#a6adc8); flex:0 0 auto;`;
            topRow.appendChild(nameEl); topRow.appendChild(typeBadge);
            const descEl = document.createElement('div');
            descEl.textContent = (fx && fx.description) ? fx.description : 'Без описания';
            descEl.title = descEl.textContent;
            descEl.style.cssText = `font-size:11px; line-height:1.3; color:var(--text-secondary,#a6adc8); overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;`;
            const srcRow = document.createElement('div');
            srcRow.style.cssText = `display:flex; align-items:center; gap:6px; margin-top:2px;`;
            const srcBadge = document.createElement('div');
            srcBadge.textContent = isBuiltin ? '⚙ base' : `📦 ${source}`;
            srcBadge.title = isBuiltin ? 'Встроенный эффект (из fx-core.js)' : `Импортирован из пака: ${source}`;
            srcBadge.style.cssText = `font-size:9px; padding:1px 6px; border-radius:999px; background:${isBuiltin ? 'rgba(108,95,166,0.25)' : 'rgba(66,153,225,0.22)'}; color:${isBuiltin ? '#b9aee8' : '#8ec5ff'}; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;`;
            srcRow.appendChild(srcBadge);

            if (deleted && !isBuiltin) {
                const purgeBtn = document.createElement('button');
                purgeBtn.textContent = '🧹 удалить пак';
                purgeBtn.title = `Полностью удалить пак «${source}» из памяти (необратимо)`;
                purgeBtn.style.cssText = `border:none; cursor:pointer; font-size:9px; padding:2px 6px; border-radius:999px; background:rgba(220,80,80,0.25); color:#ff9b9b;`;
                purgeBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ans = await showConfirm({
                        title: `Удалить пак «${source}»?`,
                        message: `Все эффекты из этого пака будут удалены, а сам пак стёрт из памяти. Повторно появится только при повторном импорте файла.`,
                        buttons: [ { id: 'cancel', label: 'Отмена', ghost: true }, { id: 'ok', label: 'Удалить пак' } ],
                    });
                    if (ans === 'ok') {
                        const removed = VP.FX.removePack(source);
                        showToast(`Пак «${source}» удалён (${removed.length} эффект${removed.length === 1 ? '' : 'ов'})`, 'success');
                        renderGalleryGrid();
                    }
                });
                srcRow.appendChild(purgeBtn);
            }

            body.appendChild(topRow); body.appendChild(descEl); body.appendChild(srcRow);
            item.appendChild(preview); item.appendChild(body);
            grid.appendChild(item);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  SELECTION + FOOTER + PANEL REFRESH
    // ════════════════════════════════════════════════════════════════

    function getVisibleGalleryTags() {
        const filterVal = (S.ui.galleryPanel || S.ui.vpWindow)?.querySelector('#vp-search')?.value?.toLowerCase().trim() || '';
        const activeTabId = S.galleryData.activeTabId;
        return Array.from(S.gallery.entries())
            .filter(([, a]) => {
                if (activeTabId === 'effects') return false;
                if (a?.tabId !== activeTabId) return false;
                return !filterVal || a.tag.includes(filterVal);
            })
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([tag]) => tag);
    }

    function clearSelection() {
        if (S.selection.tags.size === 0 && !S.selection.anchor) return;
        S.selection.tags.clear();
        S.selection.anchor = null;
        renderGalleryGrid();
        updateGalleryFooter();
    }

    function handleAssetClick(tag, evt) {
        const sel = S.selection;
        if (evt.shiftKey && sel.anchor) {
            const visible = getVisibleGalleryTags();
            const i1 = visible.indexOf(sel.anchor), i2 = visible.indexOf(tag);
            if (i1 !== -1 && i2 !== -1) {
                const [from, to] = i1 < i2 ? [i1, i2] : [i2, i1];
                for (let i = from; i <= to; i++) sel.tags.add(visible[i]);
            } else sel.tags.add(tag);
        } else if (evt.ctrlKey || evt.metaKey) {
            if (sel.tags.has(tag)) sel.tags.delete(tag); else sel.tags.add(tag);
            sel.anchor = tag;
        } else {
            if (sel.tags.size === 1 && sel.tags.has(tag)) { sel.tags.clear(); sel.anchor = null; }
            else { sel.tags.clear(); sel.tags.add(tag); sel.anchor = tag; }
        }
        renderGalleryGrid();
        updateGalleryFooter();
    }

    function updateGalleryFooter() {
        const w = S.ui.galleryPanel || S.ui.vpWindow;
        if (!w) return;
        const normal    = w.querySelector('#vp-gallery-footer-normal');
        const selection = w.querySelector('#vp-gallery-footer-selection');
        const countEl   = w.querySelector('#vp-sel-count');
        if (!normal || !selection) return;

        const n = S.selection.tags.size;
        if (n === 0) {
            normal.style.display = 'flex'; selection.style.display = 'none';
        } else {
            normal.style.display = 'none'; selection.style.display = 'flex';
            if (countEl) countEl.textContent = `${n} selected`;
        }

        // Show/hide draft action buttons when drafts exist
        const applyBtn = w.querySelector('#vp-gallery-apply-drafts');
        const discardBtn = w.querySelector('#vp-gallery-discard-drafts');
        if (applyBtn || discardBtn) {
            const hasDrafts = Array.from(S.gallery.values()).some(a => a._draft);
            if (applyBtn) applyBtn.style.display = hasDrafts ? 'inline-block' : 'none';
            if (discardBtn) discardBtn.style.display = hasDrafts ? 'inline-block' : 'none';
        }
    }

    function refreshGalleryPanelUI() {
        updateGalleryButton();
        if (!S.ui.galleryPanel || !S.ui.panelOpen || S.ui.panelSection !== 'gallery') return;
        renderGalleryGrid();
        updateGalleryFooter();
    }

    function updateGalleryButton() {
        const btn = S.ui.vpWindow?.querySelector('#vp-toggle-gallery');
        const count = S.gallery.size;
        if (btn) btn.title = `Галерея (${count} ассетов)`;
        const panel = S.ui.galleryPanel;
        const labels = panel?.querySelectorAll('[id^="vp-gallery-count"]');
        if (labels) {
            const text = count > 0 ? `${count} ассет${count === 1 ? '' : 'ов'}` : 'Галерея пуста';
            labels.forEach(el => el.textContent = text);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  GALLERY GRID  (asset cards)
    // ════════════════════════════════════════════════════════════════

    /** Render the asset grid for the active tab (or the FX shelf). */
    function renderGalleryGrid() {
        const grid = S.ui.galleryGrid;
        if (!grid) return;
        const panel = S.ui.galleryPanel;
        const sizeSlider = panel?.querySelector('#vp-gallery-size') || document.getElementById('vp-gallery-size');
        if (sizeSlider && grid) {
            const size = parseInt(sizeSlider.value) || 100;
            grid.style.gridTemplateColumns = `repeat(auto-fill, ${size}px)`;
            grid.style.gridAutoRows = `${size}px`;
        }
        const countLabel = panel?.querySelector('#vp-gallery-count-footer');
        const filterVal  = panel?.querySelector('#vp-search')?.value?.toLowerCase().trim() || '';

        const titleEl = panel?.querySelector('#vp-current-tab-name');
        if (titleEl) {
            if (S.galleryData.activeTabId === 'effects') titleEl.textContent = '✨ Effects';
            else if (!S.galleryData.activeTabId || S.galleryData.tabs.length === 0) titleEl.textContent = '🖼️ Gallery';
            else {
                const tab = S.galleryData.tabs.find(t => t.id === S.galleryData.activeTabId);
                titleEl.textContent = tab ? tab.name : '🖼️ Gallery';
            }
        }
        grid.innerHTML = '';

        const fxControls = (S.ui.galleryPanel || S.ui.vpWindow)?.querySelector('#vp-fx-controls');

        // ── Effects tab ──
        if (S.galleryData.activeTabId === 'effects') {
            renderEffectsGalleryGrid(grid, countLabel, filterVal);
            return;
        }
        if (fxControls) fxControls.style.display = 'none';

        // ── Empty: no tabs at all ──
        if (S.galleryData.tabs.length === 0) {
            grid.innerHTML = `<div class="vp-gallery-empty" style="grid-column:1/-1; text-align:center; padding:40px 20px; line-height:1.6;">
                <div style="font-size:36px; margin-bottom:12px;">🖼️</div>
                <div style="font-size:14px; color:var(--text-primary,#cdd6f4); margin-bottom:8px;">Gallery is empty</div>
                <div style="font-size:12px; color:var(--text-secondary,#a6adc8);">Drop a folder here or use 📂 📎 — a category is created automatically</div>
            </div>`;
            countLabel.textContent = '0 ассетов';
            return;
        }

        let assetsInTab = Array.from(S.gallery.entries()).filter(([, a]) => a.tabId === S.galleryData.activeTabId);
        if (assetsInTab.length === 0) {
            grid.innerHTML = '<div class="vp-gallery-empty">Таб пуст. Загрузите файлы или перетащите сюда ассеты.</div>';
            countLabel.textContent = '0 ассетов';
            return;
        }

        const sorted = assetsInTab.filter(([t]) => !filterVal || t.includes(filterVal)).sort(([a], [b]) => a.localeCompare(b));
        countLabel.textContent = `${sorted.length} ассет${sorted.length === 1 ? '' : 'ов'}`;
        if (sorted.length === 0) { grid.innerHTML = '<div class="vp-gallery-empty">Ничего не найдено</div>'; return; }

        // v18: assets of collage-marked tabs carry a 🖼️ badge (same glyph the
        // sidebar shows on marked tabs and the deck pill shows under the screen).
        const collageMarkedTabs = new Set((S.galleryData?.tabs || []).filter(t => t.markedForCollage).map(t => t.id));

        for (const [tag, asset] of sorted) {
            const item = document.createElement('div');
            item.className = 'vp-gallery-item';
            item.style.position = 'relative';

            const isActiveAsset = S.current?.tag === tag;
            const isCoverAsset  = S.coverTag === tag;
            if (isActiveAsset) item.classList.add('vp-active');

            const ringShadows = [];
            if (isActiveAsset) {
                item.style.border = '2px solid rgba(76, 175, 125, 0.95)';
                ringShadows.push('0 0 0 1px rgba(20, 30, 24, 0.55) inset', '0 0 16px rgba(76, 175, 125, 0.30)');
            }
            if (isCoverAsset) {
                item.style.border = '2px solid rgba(240, 180, 80, 0.98)';
                ringShadows.push('0 0 18px rgba(240, 180, 80, 0.28)');
            }
            if (isActiveAsset && isCoverAsset) ringShadows.push('0 0 0 2px rgba(76, 175, 125, 0.90) inset');
            if (ringShadows.length) item.style.boxShadow = ringShadows.join(', ');

            // Drag-to-insert: card → [IMG:tag] (or batch from selection)
            item.draggable = true;
            item.addEventListener('dragstart', (e) => {
                e.dataTransfer.clearData();
                let tagsToMove = [tag];
                if (S.selection.tags.has(tag)) tagsToMove = Array.from(S.selection.tags);
                const txt = tagsToMove.map(t => `[IMG:${t}]`).join(' ') + ' ';
                e.dataTransfer.setData('text/plain', txt);
                e.dataTransfer.setData('vp/asset-move-batch', JSON.stringify(tagsToMove));
                e.dataTransfer.effectAllowed = 'copyMove';
                if (e.dataTransfer.setDragImage) e.dataTransfer.setDragImage(item, 20, 20);
            });

            const img = document.createElement('img');
            img.src = asset.thumbUrl || asset.url;
            img.alt = tag;
            img.draggable = false;

            // v18: 🖼️ badge for assets whose tab is marked for the Gallery View.
            // Inline styles on purpose: grid card css lives in an external
            // stylesheet, the badge must render regardless.
            if (collageMarkedTabs.has(asset.tabId)) {
                const cm = document.createElement('div');
                cm.className = 'vp-asset-collage-mark';
                cm.textContent = '🖼️';
                cm.title = 'Входит в Gallery View (таб помечен 🖼️)';
                cm.draggable = false;
                cm.style.cssText = 'position:absolute; top:4px; left:4px; z-index:2; font-size:10px; line-height:1; padding:2px 4px; border-radius:6px; background:rgba(20,20,32,0.72); border:1px solid rgba(240,180,80,0.45); color:#f0d7a8; pointer-events:none;';
                item.appendChild(cm);
            }
            // Lazy thumbnail: regenerate from blob if missing.
            if (!asset.thumbUrl && asset.blob) {
                ensureThumb(asset).then(t => { if (t && item.isConnected) img.src = t; });
            }

            // Delete ✕ (hover)
            const xBtn = document.createElement('div');
            xBtn.className = 'vp-asset-x';
            xBtn.textContent = '✕';
            xBtn.title = 'Удалить';
            xBtn.draggable = false;
            xBtn.addEventListener('click', async (e) => {
                e.stopPropagation(); e.preventDefault();
                const ans = await showConfirm({
                    title: 'Delete asset?',
                    message: `Удалить ассет "${tag}"?`,
                    buttons: [
                        { id: 'cancel', label: 'Cancel', ghost: true },
                        { id: 'ok', label: 'Delete', danger: true },
                    ],
                });
                if (ans !== 'ok') return;
                deleteAssets(tag);
                renderGalleryGrid();
                updateGalleryFooter();
                updateGalleryButton();
            });
            item.appendChild(xBtn);

            const label = document.createElement('div');
            label.className = 'vp-gallery-item-tag';
            label.textContent = tag;
            label.title = asset.description ? `${tag}: ${asset.description}` : tag;
            item.appendChild(img);
            item.appendChild(label);

            // Draft badge
            if (asset._draft) {
                const draftBadge = document.createElement('div');
                draftBadge.textContent = '✨';
                draftBadge.title = 'Draft — not saved to disk. Apply to keep.';
                draftBadge.style.cssText = `position:absolute; top:3px; left:3px; background:rgba(0,0,0,0.7); color:white; font-size:12px; padding:2px 5px; border-radius:3px; pointer-events:none; z-index:4; line-height:1;`;
                item.appendChild(draftBadge);
            }
            // Cover badge
            if (isCoverAsset) {
                const cb = document.createElement('div');
                cb.textContent = '★ ' + (S.coverLabel || 'COVER');
                cb.style.cssText = `position:absolute; top:3px; left:3px; background:linear-gradient(180deg,rgba(255,214,102,0.98),rgba(231,171,51,0.96)); color:#2a1a00; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; pointer-events:none; z-index:4; box-shadow:0 1px 4px rgba(0,0,0,0.35);`;
                item.appendChild(cb);
            }
            // Active badge
            if (isActiveAsset) {
                const ab = document.createElement('div');
                ab.textContent = '● ACTIVE';
                ab.style.cssText = `position:absolute; top:3px; right:3px; background:linear-gradient(180deg,rgba(111,231,160,0.96),rgba(53,163,102,0.96)); color:#062612; font-size:9px; font-weight:700; padding:1px 5px; border-radius:3px; pointer-events:none; z-index:4; box-shadow:0 1px 4px rgba(0,0,0,0.35);`;
                ab.title = 'Currently loaded in projector';
                item.appendChild(ab);
            }
            // Depth sidecar badge
            if (asset.depthMap?.status) {
                const db = document.createElement('div');
                const ready = asset.depthMap.status === 'ready';
                const error = asset.depthMap.status === 'error';
                db.textContent = ready ? '3D' : (error ? 'D!' : 'D…');
                db.title = ready
                    ? `Depth sidecar: ${asset.depthMap.file || 'ready'}`
                    : (error ? `Depth error: ${asset.depthMap.error || 'unknown'}` : 'Depth sidecar pending');
                db.style.cssText = `position:absolute; ${isActiveAsset ? 'top:20px;' : 'top:3px;'} right:3px; background:${ready ? 'linear-gradient(180deg,rgba(137,180,250,.96),rgba(76,119,210,.94))' : (error ? 'linear-gradient(180deg,rgba(255,110,110,.96),rgba(185,58,58,.94))' : 'linear-gradient(180deg,rgba(240,180,80,.96),rgba(170,120,35,.94))')}; color:#07111f; font-size:9px; font-weight:900; padding:1px 5px; border-radius:3px; pointer-events:none; z-index:4; box-shadow:0 1px 4px rgba(0,0,0,0.35); letter-spacing:.03em;`;
                item.appendChild(db);
            }
            item.appendChild(label);

            if (S.selection.tags.has(tag)) item.classList.add('vp-selected');

            // Click → selection (with Shift/Ctrl/Cmd)
            item.addEventListener('click', (e) => handleAssetClick(tag, e));

            // Double-click → load into projector (+ pre-send slots)
            item.addEventListener('dblclick', (e) => {
                e.preventDefault();
                S.selection.tags.clear();
                S.selection.anchor = null;
                if (S.playback.messages.length === 0) {
                    const isCoverClick = S.coverTag && tag === S.coverTag;
                    if (isCoverClick) {
                        S.playback.cursor = 0;
                    } else if (S.coverTag) {
                        S.preparedTag = tag; S.playback.cursor = 1;
                        if (DB) DB.setPreparedTag(tag);
                    } else {
                        S.preparedTag = tag; S.playback.cursor = 0;
                        if (DB) DB.setPreparedTag(tag);
                    }
                } else if (S.coverTag && tag === S.coverTag) {
                    S.playback.cursor = 0;
                }
                setProjectorCurrent(tag);
                showToast(`▶ ${tag}`, 'success');
            });

            // Right-click → context menu
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                if (activeContextMenuCleanup) {
                    activeContextMenuCleanup();
                }

                const menu = document.createElement('div');
                menu.className = 'vp-context-menu';
                menu.style.cssText = `position:fixed; left:${e.clientX}px; top:${e.clientY}px; background:var(--bg-tertiary,#252540); border:1px solid var(--border,#383860); border-radius:6px; z-index:10002; box-shadow:0 4px 16px rgba(0,0,0,0.5); overflow:hidden; min-width:140px; font-family:system-ui,sans-serif;`;
                const mkItem = (text, color, onClick) => {
                    const d = document.createElement('div');
                    d.textContent = text;
                    d.style.cssText = `padding:8px 12px; cursor:pointer; font-size:13px; color:${color || 'var(--text-primary,#cdd6f4)'};`;
                    d.addEventListener('mouseenter', () => d.style.background = 'var(--accent,#6c5fa6)');
                    d.addEventListener('mouseleave', () => d.style.background = '');
                    d.addEventListener('click', () => { cleanup(); onClick(); });
                    return d;
                };

                // 1. Rename
                menu.appendChild(mkItem('✏️ Переименовать', null, () => {
                    const input = document.createElement('input');
                    input.className = 'vp-rename-input';
                    input.value = tag;
                    label.replaceWith(input);
                    input.focus(); input.select();
                    const commit = () => { renameTag(tag, input.value); renderGalleryGrid(); requestProjectorUiUpdate('gallery') };
                    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } else if (e.key === 'Escape') renderGalleryGrid(); });
                    input.addEventListener('blur', commit);
                }));

                // 2. Edit description
                menu.appendChild(mkItem('📝 Изменить описание', null, async () => {
                    const desc = await showPrompt({
                        title: 'Asset description',
                        message: `Описание ассета "${tag}".`,
                        value: asset.description || '',
                        placeholder: 'Short visual note',
                        confirmLabel: 'Save',
                        multiline: true,
                    });
                    if (desc !== null) {
                        asset.description = desc.trim();
                        persistAsset(asset);
                        renderGalleryGrid();
                        requestProjectorUiUpdate('gallery')
                        showToast('Asset description updated', 'success');
                    }
                }));

                // 3. Re-tag with AI
                menu.appendChild(mkItem('✨ Re-tag with AI', null, () => VP.gallery.Tagger?.retagSingle(tag)));

                // 3b. Generate / regenerate hidden depth sidecar
                if (!String(tag).startsWith('__') && !asset._draft) {
                    const depthReady = asset.depthMap?.status === 'ready';
                    menu.appendChild(mkItem(depthReady ? '🧊 Regenerate Depth' : '🧊 Generate Depth', null, async () => {
                        try {
                            await generateDepthSidecarForAsset({ tag, force: true });
                        } catch (err) {
                            console.error('[VP Gallery] depth generation from context menu failed:', err);
                        }
                    }));
                }

                // 4a. Apply draft (shown only for temporary assets)
                if (asset._draft) {
                    menu.appendChild(mkItem('✅ Apply', null, () => { applyDraft(tag); renderGalleryGrid(); updateGalleryFooter(); }));
                    menu.appendChild(mkItem('🗑️ Discard', 'var(--error,#e05555)', async () => {
                        const ans = await showConfirm({
                            title: 'Discard draft?',
                            message: `Удалить черновик "${tag}"? Он не сохранён на диск.`,
                            buttons: [
                                { id: 'cancel', label: 'Cancel', ghost: true },
                                { id: 'ok', label: 'Delete', danger: true },
                            ],
                        });
                        if (ans === 'ok') { deleteAssets(tag); renderGalleryGrid(); updateGalleryButton(); }
                    }));
                } else {
                    // 4b. Delete (persisted assets only)
                    menu.appendChild(mkItem('🗑️ Удалить', 'var(--error,#e05555)', async () => {
                        const ans = await showConfirm({
                            title: 'Delete asset?',
                            message: `Удалить ассет "${tag}"?`,
                            buttons: [
                                { id: 'cancel', label: 'Cancel', ghost: true },
                                { id: 'ok', label: 'Delete', danger: true },
                            ],
                        });
                        if (ans === 'ok') { deleteAssets(tag); renderGalleryGrid(); updateGalleryButton(); }
                    }));
                }

                document.body.appendChild(menu);

                // Keep the menu inside the viewport if the click was near an edge.
                requestAnimationFrame(() => {
                    const rect = menu.getBoundingClientRect();
                    const margin = 8;
                    if (rect.right > window.innerWidth - margin) {
                        menu.style.left = `${Math.max(margin, window.innerWidth - rect.width - margin)}px`;
                    }
                    if (rect.bottom > window.innerHeight - margin) {
                        menu.style.top = `${Math.max(margin, window.innerHeight - rect.height - margin)}px`;
                    }
                });

                const close = (ev) => { if (!menu.contains(ev.target)) { cleanup(); } };
                const cleanup = () => {
                    menu.remove();
                    document.removeEventListener('mousedown', close);
                    if (activeContextMenuCleanup === cleanup) {
                        activeContextMenuCleanup = null;
                    }
                };
                activeContextMenuCleanup = cleanup;
                setTimeout(() => {
                    if (activeContextMenuCleanup === cleanup) {
                        document.addEventListener('mousedown', close);
                    }
                }, 0);
            });

            grid.appendChild(item);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  HYDRATION  (load everything from IndexedDB on boot)
    // ════════════════════════════════════════════════════════════════

    /**
     * Populate State from IndexedDB: galleryData tree, all assets (with
     * object URLs regenerated from stored Blobs), cover/prepared/label,
     * and a config overlay. Thumbnails are left null and rebuilt lazily.
     */
    async function hydrateFromDB() {
        if (!DB) return;
        try {
            // 1. Category/tab tree
            const gd = await DB.getGalleryData();
            if (gd && gd.categories && gd.tabs) S.galleryData = gd;

            // 2. Assets — regenerate the ephemeral object URL from the Blob.
            const assets = await DB.getAllAssets();
            for (const a of assets) {
                if (a.blob) a.url = URL.createObjectURL(a.blob);
                if (a.hidden) {
                    a.hidden = false;
                    persistAsset(a);
                }
                // a.thumbUrl stays undefined → ensureThumb() rebuilds it lazily.
                S.gallery.set(a.tag, a);
            }

            // 3. Cover / prepared / label
            const cover = await DB.getCoverTag();
            if (cover && S.gallery.has(cover)) S.coverTag = cover;
            const label = await DB.getCoverLabel();
            if (label) S.coverLabel = label;
            const prepared = await DB.getPreparedTag();
            if (prepared && S.gallery.has(prepared)) S.preparedTag = prepared;

            // 4. Config overlay (engine defines defaults; saved values win).
            const cfg = await DB.getConfig();
            if (cfg) {
                if (!S.config.prompts) S.config.prompts = { manifest: null, frameContext: null };
                Object.assign(S.config, cfg);
                VP.syncPlaybackSpeedUI?.();
            }
        } catch (err) {
            console.error('[VP Gallery] hydration failed:', err);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  BOOT  +  REVERSE BRIDGE FACADE
    // ════════════════════════════════════════════════════════════════

    /**
     * Gallery boot sequence. Runs after the engine has built its UI
     * (engine's DOMContentLoaded listener registers first because it
     * loads first, so State.ui.vpWindow is already set when we run).
     */
    async function bootGallery() {
        if (VP.ready) await VP.ready;
        if (VP.chats?.ready) await VP.chats.ready;
        if (!S.ui) S.ui = {};
        S.ui.panelOpen    = false;
        S.ui.panelSection = 'gallery';
        S.ui.fxShowDeleted = false;

        TabsManager.init();
        await hydrateFromDB();
        TabsManager.init();          // adopt orphans after assets are loaded
        TabsManager.renderSidebar(); // no-op until the panel exists
        updateGalleryButton();

        // Restore the active frame + semantic projector state.
        let restoredFromChat = false;
        const activeChat = VP.chats?.getActiveChat?.();
        if (activeChat?.projector) {
            restoredFromChat = !!VP.chats.applyActiveChatProjectorToRuntime?.();
        }
        if (!restoredFromChat && DB) {
            const cur = await DB.getCurrentTag();
            if (cur && S.gallery.has(cur)) setProjectorCurrent(cur, 'replay', true);
            const projectorState = await DB.getProjectorState?.();
            if (projectorState) VP.applyProjectorSnapshot?.(projectorState);
        }
        requestProjectorUiUpdate('gallery')
        VP.shell?.render?.();

        console.log(`[VP Gallery] ready — ${S.gallery.size} asset(s), ${S.galleryData.categories.length} categor(y/ies).`);
    }

    // ── Reverse bridge: let the engine call back into the gallery. ──
    window.VisualProjector.gallery = {
        // rendering / refresh
        renderGalleryGrid, updateGalleryFooter, updateGalleryButton,
        refreshGalleryPanelUI, clearSelection,
        // panel lifecycle
        createGalleryPanel, togglePanel, toggleMode, toggleSettings, activatePanelSection,
        isGalleryPanelDocked, undockGalleryPanelForFloating,
        syncSettingsUI,
        // domain objects
        TabsManager, Tagger: null,
        // hub/public read models
        getPublicAssetDescriptor, getGalleryPublicState, listPublicAssets, listPublicTabs, resolveGalleryTag,
        openGalleryEphemeral, setActiveGalleryTab,
        getGallerySelectionDescriptor, setGallerySelection, getCollagePublicState,
        generateDepthSidecarForAsset,
        // asset ops (used by engine drag-drop / paste shortcuts)
        addImageFromBlob, addImageFromPath, deleteAssets, setAssetVisibility, applyCover,
        exportGallery, importGallery, loadGalleryFolder, loadSingleFile, pasteFromClipboard,
        maybeOfferAutoTag: null,
        // collage/contact-sheet ops
        generateCollageFromMarkedTabs, buildContactSheet, collectCollagePlan, calculateContactSheetLayout,
        // persistence
        hydrateFromDB, persistAsset, persistAssetsBatch, persistGalleryData, persistConfig,
        // draft ops
        applyDraft, applyAllDrafts, discardAllDrafts,
    };

    registerGalleryHubCommands();

    // ── Trigger boot (after the engine's own DOMContentLoaded fires). ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootGallery().catch(err => console.error('[VP Gallery] boot failed:', err)); });
    } else {
        bootGallery().catch(err => console.error('[VP Gallery] boot failed:', err));
    }

})();
