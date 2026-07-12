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
// ║  Load order:  fx-core.js → visual-projector.js → projector-gallery ║
// ║  (this file captures window.VisualProjector synchronously)        ║
// ╚══════════════════════════════════════════════════════════════════╝
//
// ── ENGINE DEPENDENCY CONTRACT ──────────────────────────────────────
// This module talks to the projector engine exclusively through the
// `window.VisualProjector` (alias VP) facade. It expects:
//
//   VP.state                      shared single source of truth
//   VP.setCurrent(tag, src?, force?, transition?)
//   VP.clearCurrent()
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

    /** Persist a single asset (fire-and-forget; ephemeral fields stripped in VP_DB). */
    function persistAsset(asset) {
        if (!DB) return;
        DB.putAsset(asset).catch(e => console.warn('[VP Gallery] asset persist failed', e));
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
                            if (!existing) S.galleryData.tabs.push({ id: targetTabId, categoryId: catId, name: parentFolderName, desc: '', state: 'open' });
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
                VP.setCurrent(S.gallery.values().next().value.tag);
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
                VP.setCurrent(finalTag);
                await VP.gallery.maybeOfferAutoTag?.();
            } catch (err) {
                showToast('Ошибка загрузки', 'error');
            }
        };
        input.click();
    }

    /**
     * Universal single-image acceptor (Blob|File).
     * Used by paste, drag-and-drop, generation.
     * @returns {Promise<string|null>} the new tag, or null on failure.
     */
    async function addImageFromBlob(blob, opts = {}) {
        const { source = 'pasted', suggestedName = null, setAsCurrent = true } = opts;

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
                folderContext: null, tabId: TabsManager.getActiveTabIdForNewAsset(),
                hidden: false,
            };
            S.gallery.set(finalTag, asset);
            persistAsset(asset);
            markVisualInventoryDirty('asset-added');
            updateGalleryButton();
            renderGalleryGrid();
            if (setAsCurrent) VP.setCurrent(finalTag);
            return finalTag;
        } catch (err) {
            console.error('[VP Gallery] Failed to add image:', err);
            showToast('Failed to load image', 'error');
            return null;
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
            if (S.current?.tag === tag) VP.clearCurrent();
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
                    VP.setCurrent(restoredCurrent);
                } else if (loaded > 0 && !S.current) {
                    VP.setCurrent(Array.from(importedTagMap.values())[0]);
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
    // ════════════════════════════════════════════════════════════════
    //  SIDEBAR CONTEXT MENU (category / tab tree)
    // ════════════════════════════════════════════════════════════════

    function closeSidebarContextMenu() {
        if (activeContextMenuCleanup) {
            activeContextMenuCleanup();
        } else {
            document.querySelector('.vp-context-menu')?.remove();
        }
    }

    function showSidebarContextMenu(e, type, id = null) {
        e.preventDefault();
        e.stopPropagation();
        closeSidebarContextMenu();

        const menu = document.createElement('div');
        menu.className = 'vp-context-menu';
        menu.style.cssText = `
            position: fixed;
            left: ${e.clientX}px;
            top: ${e.clientY}px;
            background: var(--bg-tertiary, #252540);
            border: 1px solid var(--border, #383860);
            border-radius: 6px;
            z-index: 10005;
            box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            min-width: 190px;
            max-width: 260px;
            font-family: system-ui, sans-serif;
            padding: 4px 0;
            color: var(--text-primary, #cdd6f4);
        `;

        const addItem = (text, onClick, color = 'var(--text-primary, #cdd6f4)') => {
            const btn = document.createElement('div');
            btn.textContent = text;
            btn.style.cssText = `padding: 8px 12px; cursor: pointer; font-size: 13px; line-height: 1.25; color: ${color}; user-select: none;`;
            btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--accent, #6c5fa6)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = ''; });
            btn.addEventListener('click', (ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                cleanup();
                onClick?.();
            });
            menu.appendChild(btn);
            return btn;
        };

        const addSeparator = () => {
            const hr = document.createElement('hr');
            hr.style.cssText = 'border:0; border-top:1px solid var(--border, #383860); margin:4px 0;';
			menu.appendChild(hr);
        };

        const target = type === 'category'
            ? S.galleryData.categories.find(c => c.id === id)
            : type === 'tab'
                ? S.galleryData.tabs.find(t => t.id === id)
                : null;

        if (type === 'sidebar' || type === 'category') {
            addItem('➕ Создать категорию', () => TabsManager.createCategory());
        }
        if (type === 'category' && target) {
            addItem('➕ Создать таб здесь', () => TabsManager.createTab(id));
        }

        if (target) {
            addSeparator();

            addItem('✏️ Переименовать', async () => {
                const name = await showPrompt({
                    title: type === 'tab' ? 'Rename tab' : 'Rename category',
                    message: 'Введите новое имя:',
                    value: target.name || '',
                    placeholder: 'Name',
                    confirmLabel: 'Save',
                    required: true,
                });
                if (name === null) return;
                const trimmed = name.trim();
                if (!trimmed) return;
                target.name = trimmed;
                markVisualInventoryDirty(type === 'tab' ? 'tab-renamed' : 'category-renamed');
                TabsManager.renderSidebar();
                renderGalleryGrid();
                persistGalleryData();
            });

            addItem('📝 Изменить описание', async () => {
                const desc = await showPrompt({
                    title: type === 'tab' ? 'Tab description' : 'Category description',
                    message: 'Описание видно модели, когда категория/таб свернут.',
                    value: target.desc || '',
                    placeholder: 'Description',
                    confirmLabel: 'Save',
                    multiline: true,
                });
                if (desc === null) return;
                target.desc = desc.trim();
                TabsManager.renderSidebar();
                renderGalleryGrid();
                persistGalleryData();
            });

            if (type === 'tab') {
                const isMarked = !!target.markedForCollage;
                addItem(isMarked ? '➖ Убрать из Gallery View' : '🖼️ Добавить в Gallery View', () => {
                    target.markedForCollage = !isMarked;
                    markVisualInventoryDirty(target.markedForCollage ? 'tab-added-to-collage' : 'tab-removed-from-collage');
                    TabsManager.renderSidebar();
                    persistGalleryData();
                });
            }

            const states = [
                { s: 'open',      label: '👁 Открыт (Full Context)' },
                { s: 'collapsed', label: '📁 Свернут (Name + Desc only)' },
                { s: 'locked',    label: '🔒 Залочен (Hidden from LLM)' },
            ];

            addSeparator();
            states.forEach(({ s, label }) => {
                if (target.state !== s) {
                    addItem(`Переключить в: ${label}`, () => {
                        target.state = s;
                        markVisualInventoryDirty(`${type}-state-${s}`);
                        TabsManager.renderSidebar();
                        persistGalleryData();
                    });
                }
            });

            addSeparator();
            addItem('🗑️ Удалить', async () => {
                const label = type === 'category'
                    ? 'категорию и ВСЕ табы/ассеты внутри'
                    : 'таб и ВСЕ ассеты внутри';
                const ans = await showConfirm({
                    title: type === 'category' ? 'Delete category?' : 'Delete tab?',
                    message: `Удалить ${label}?`,
                    buttons: [
                        { id: 'cancel', label: 'Cancel', ghost: true },
                        { id: 'ok', label: 'Delete', danger: true },
                    ],
                });
                if (ans !== 'ok') return;
                if (type === 'category') TabsManager.deleteCategory(id);
                else TabsManager.deleteTab(id);
            }, 'var(--error, #e05555)');
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

        const close = (ev) => {
            if (!menu.contains(ev.target)) {
                cleanup();
            }
        };
        const cleanup = () => {
            menu.remove();
            document.removeEventListener('mousedown', close);
            document.removeEventListener('contextmenu', close);
            if (activeContextMenuCleanup === cleanup) {
                activeContextMenuCleanup = null;
            }
        };
        activeContextMenuCleanup = cleanup;
        setTimeout(() => {
            if (activeContextMenuCleanup === cleanup) {
                document.addEventListener('mousedown', close);
                document.addEventListener('contextmenu', close);
            }
        }, 0);
    }

    // ════════════════════════════════════════════════════════════════
    //  TABS MANAGER  (category/tab tree — the gallery sidebar)
    // ════════════════════════════════════════════════════════════════

    const TabsManager = {

        /** Ensure galleryData exists; adopt orphan assets (tabId → null). */
        init() {
            if (!S.galleryData) {
                S.galleryData = { categories: [], tabs: [], activeTabId: null, tagAliases: {} };
            }
            if (!S.galleryData.tagAliases) S.galleryData.tagAliases = {};
            for (const asset of S.gallery.values()) {
                if (!asset.tabId) asset.tabId = null;
            }
        },

        /** Resolve a home tab for a brand-new asset, creating one if needed. */
        getActiveTabIdForNewAsset() {
            if (S.galleryData.tabs.length === 0) {
                let catId;
                if (S.galleryData.categories.length === 0) {
                    catId = 'cat_' + Date.now();
                    S.galleryData.categories.push({ id: catId, name: 'Main', desc: '', state: 'open' });
                } else {
                    catId = S.galleryData.categories[0].id;
                }
                const tabId = 'tab_' + Date.now() + Math.random().toString(36).substr(2, 3);
                S.galleryData.tabs.push({ id: tabId, categoryId: catId, name: 'Assets', desc: '', state: 'open' });
                S.galleryData.activeTabId = tabId;
                S.ui.lastAssetTabId = tabId;
                this.renderSidebar();
                persistGalleryData();
                return tabId;
            }
            if (S.galleryData.activeTabId && S.galleryData.activeTabId !== 'effects'
                && S.galleryData.tabs.some(t => t.id === S.galleryData.activeTabId)) {
                return S.galleryData.activeTabId;
            }
            if (S.galleryData.tabs.length > 0) {
                const fb = S.galleryData.tabs[0].id;
                S.galleryData.activeTabId = fb;
                S.ui.lastAssetTabId = fb;
                this.renderSidebar();
                return fb;
            }
        },

        getUniqueName(baseName, existing) {
            if (!existing.includes(baseName)) return baseName;
            let n = 1, name = `${baseName}.${String(n).padStart(3, '0')}`;
            while (existing.includes(name)) { n++; name = `${baseName}.${String(n).padStart(3, '0')}`; }
            return name;
        },

        createCategory(name) {
            const id = 'cat_' + Date.now();
            const existing = S.galleryData.categories.map(c => c.name);
            const finalName = name || this.getUniqueName('New Category', existing);
            S.galleryData.categories.push({ id, name: finalName, desc: '', state: 'open' });
            // Auto-create a default tab so the newcomer sees where to drop assets.
            const tabId = 'tab_' + Date.now() + Math.random().toString(36).substr(2, 3);
            S.galleryData.tabs.push({ id: tabId, categoryId: id, name: 'Assets', desc: '', state: 'open' });
            if (!S.galleryData.activeTabId || S.galleryData.activeTabId === 'effects') {
                S.galleryData.activeTabId = tabId;
                S.ui.lastAssetTabId = tabId;
            }
            this.renderSidebar();
            persistGalleryData();
            return id;
        },

        createTab(categoryId, name) {
            const id = 'tab_' + Date.now();
            const existing = S.galleryData.tabs.filter(t => t.categoryId === categoryId).map(t => t.name);
            const finalName = name || this.getUniqueName('New Tab', existing);
            S.galleryData.tabs.push({ id, categoryId, name: finalName, desc: '', state: 'open' });
            this.renderSidebar();
            persistGalleryData();
            return id;
        },

        deleteCategory(id) {
            const tabs = S.galleryData.tabs.filter(t => t.categoryId === id);
            for (const t of tabs) this.deleteTab(t.id, true);
            S.galleryData.categories = S.galleryData.categories.filter(c => c.id !== id);
            this.renderSidebar();
            renderGalleryGrid();
            updateGalleryFooter();
            VP.updateProjectorUI();
            updateGalleryButton();
            persistGalleryData();
        },

        deleteTab(id, skipRender = false) {
            S.galleryData.tabs = S.galleryData.tabs.filter(t => t.id !== id);
            // Cascade: delete every asset that lived in this tab (handles IDB too).
            const orphans = [];
            for (const [tag, asset] of S.gallery.entries()) {
                if (asset.tabId === id) orphans.push(tag);
            }
            if (orphans.length) deleteAssets(orphans);

            if (S.ui.lastAssetTabId === id) S.ui.lastAssetTabId = S.galleryData.tabs[0]?.id || null;
            if (S.galleryData.activeTabId === id) {
                S.galleryData.activeTabId = S.galleryData.tabs[0]?.id || null;
                if (S.galleryData.activeTabId && S.galleryData.activeTabId !== 'effects') {
                    S.ui.lastAssetTabId = S.galleryData.activeTabId;
                }
            }
            if (!skipRender) {
                this.renderSidebar();
                renderGalleryGrid();
                updateGalleryFooter();
                persistGalleryData();
            }
        },

        /** Carousel: open → collapsed → locked → open. */
        toggleState(entityType, id) {
            const target = entityType === 'CAT'
                ? S.galleryData.categories.find(c => c.id === id)
                : S.galleryData.tabs.find(t => t.id === id);
            if (!target) return;
            if (target.state === 'open')      target.state = 'collapsed';
            else if (target.state === 'collapsed') target.state = 'locked';
            else                              target.state = 'open';
            markVisualInventoryDirty(`${entityType.toLowerCase()}-state-${target.state}`);
            this.renderSidebar();
            persistGalleryData();
        },

        /** Drag-move a tab onto another tab or a category header. */
        moveTab(draggedTabId, targetType, targetId) {
            const tabs = S.galleryData.tabs;
            const di = tabs.findIndex(t => t.id === draggedTabId);
            if (di === -1) return;
            const dragged = tabs[di];

            if (targetType === 'CAT') {
                if (dragged.categoryId !== targetId) {
                    dragged.categoryId = targetId;
                    tabs.splice(di, 1);
                    tabs.push(dragged);
                    this.renderSidebar();
                    persistGalleryData();
                    showToast('Moved tab to category', 'success');
                }
            } else if (targetType === 'TAB') {
                if (draggedTabId === targetId) return;
                const ti = tabs.findIndex(t => t.id === targetId);
                if (ti === -1) return;
                dragged.categoryId = tabs[ti].categoryId;
                tabs.splice(di, 1);
                let ni = tabs.findIndex(t => t.id === targetId);
                if (di < ti) ni += 1;   // dragged L→R: insert after target
                tabs.splice(ni, 0, dragged);
                this.renderSidebar();
                persistGalleryData();
            }
        },

        /** Execute an AI folder directive: [CAT:open:Name] / [TAB:collapse:Name]. */
        executeCommand(entityType, action, name) {
            const gd = S.galleryData;
            const targetName = String(name).trim().toLowerCase();
            const actionKey = String(action || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s\-]+/g, '_');
            const actionMap = {
                open: 'open', opened: 'open', expand: 'open', show: 'open', reveal: 'open', load: 'open',
                открыть: 'open', открой: 'open', развернуть: 'open', разверни: 'open', показать: 'open', покажи: 'open',
                collapse: 'collapsed', collapsed: 'collapsed', close: 'collapsed', fold: 'collapsed', hide: 'collapsed', unload: 'collapsed',
                свернуть: 'collapsed', сверни: 'collapsed', закрыть: 'collapsed', закрой: 'collapsed', скрыть: 'collapsed', спрячь: 'collapsed',
            };
            const normalizedAction = actionMap[actionKey] || actionKey;
            let changed = false;

            const find = entityType === 'CAT'
                ? fuzzyMatch(name, gd.categories, c => c.name)
                : fuzzyMatch(name, gd.tabs, t => t.name);

            if (find && find.state !== 'locked' && (normalizedAction === 'open' || normalizedAction === 'collapsed')) {
                const actionLabelRu = normalizedAction === 'collapsed' ? 'свернуто' : 'открыто';

                if (find.state !== normalizedAction) {
                    find.state = normalizedAction;
                    changed = true;

                    if (find.name.toLowerCase() !== targetName) {
                        showToast(`📂 ИИ сопоставил "${name}" ➜ "${find.name}" (${actionLabelRu})`, 'info');
                    } else {
                        showToast(`📂 ${entityType === 'CAT' ? 'Категория' : 'Таб'} "${find.name}" ${actionLabelRu} по команде ИИ`, 'info');
                    }
                } else if (find.name.toLowerCase() !== targetName) {
                    showToast(`📂 ИИ сопоставил "${name}" ➜ "${find.name}"`, 'info');
                }

                // If the model opened a tab, auto-generate the contact sheet collage and apply as cover.
                // Mark changes are part of galleryData and must persist even if the tab was already open.
                if (entityType === 'TAB' && normalizedAction === 'open') {
                    let marksChanged = false;
                    gd.tabs.forEach(t => {
                        const next = (t.id === find.id);
                        if (!!t.markedForCollage !== next) marksChanged = true;
                        t.markedForCollage = next;
                    });
                    if (marksChanged) changed = true;
                    generateCollageFromMarkedTabs({ reason: 'directory-command' }).catch(err =>
                        console.warn('[VP Gallery] AI-triggered collage generation failed:', err)
                    );
                }
            } else {
                console.warn(`[VP AI command] No matching active ${entityType} found for "${name}"`);
            }
            if (changed) { this.renderSidebar(); persistGalleryData(); }
        },

        /** Fly-to-textarea animation when an asset is dropped into the composer. */
        playFlyAnimation(tagList, targetElement, dropPoint = null) {
            if (!targetElement || !Array.isArray(tagList) || tagList.length === 0) return;

            const targetRect = targetElement.getBoundingClientRect();
            const targetViewportX = Number.isFinite(dropPoint?.x) ? dropPoint.x : (targetRect.left + targetRect.width / 2);
            const targetViewportY = Number.isFinite(dropPoint?.y) ? dropPoint.y : (targetRect.top + targetRect.height / 2);
            const galleryRoot = S.ui.galleryGrid || document;

            tagList.forEach((tag, index) => {
                const items = Array.from(galleryRoot.querySelectorAll('.vp-gallery-item'));
                const sourceEl = items.find(el => el.querySelector('img')?.alt === tag);
                if (!sourceEl) return;

                const sourceRect = sourceEl.getBoundingClientRect();
                const sourceImg = sourceEl.querySelector('img');
                const startCss = viewportRectToCssSpace(sourceRect, sourceEl);
                const targetCss = viewportPointToCssSpace(targetViewportX, targetViewportY, sourceEl);

                const ghost = document.createElement('div');
                ghost.className = 'vp-fly-ghost';
                ghost.style.cssText = `
                    position: fixed; left: ${startCss.left}px; top: ${startCss.top}px;
                    width: ${startCss.width}px; height: ${startCss.height}px; margin: 0;
                    z-index: 10006; pointer-events: none; opacity: 0.96; overflow: hidden;
                    border-radius: 8px; background: rgba(20,20,32,0.96);
                    box-shadow: 0 6px 18px rgba(0,0,0,0.45);
                    transition: transform 0.38s cubic-bezier(0.2,1,0.3,1), opacity 0.38s ease,
                                left 0.38s cubic-bezier(0.2,1,0.3,1), top 0.38s cubic-bezier(0.2,1,0.3,1);
                    transform: scale(1); transform-origin: center center;
                `;
                if (sourceImg) {
                    const img = document.createElement('img');
                    img.src = sourceImg.src; img.alt = tag;
                    img.style.cssText = `width:100%; height:calc(100% - 20px); object-fit:cover; display:block; pointer-events:none; user-select:none;`;
                    ghost.appendChild(img);
                }
                const caption = document.createElement('div');
                caption.textContent = tag;
                caption.style.cssText = `height:20px; padding:2px 6px; font-size:10px; line-height:16px; color:rgba(255,255,255,0.92); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; background:rgba(0,0,0,0.45); border-top:1px solid rgba(255,255,255,0.08); box-sizing:border-box;`;
                ghost.appendChild(caption);

                setTimeout(() => {
                    document.body.appendChild(ghost);
                    requestAnimationFrame(() => requestAnimationFrame(() => {
                        ghost.style.left = `${targetCss.x}px`;
                        ghost.style.top = `${targetCss.y}px`;
                        ghost.style.transform = 'translate(-50%, -50%) scale(0.12)';
                        ghost.style.opacity = '0';
                    }));
                    setTimeout(() => ghost.remove(), 420);
                }, index * 35);
            });
        },

        /** Render the category/tab tree into #vp-gallery-sidebar. */
        renderSidebar() {
            const sidebar = document.getElementById('vp-gallery-sidebar');
            if (!sidebar) return;
            const gd = S.galleryData;
            const allAssets = Array.from(S.gallery.values());
            let html = '';

            const isFxActive = gd.activeTabId === 'effects' ? 'active' : '';
            const fxBg = isFxActive ? 'var(--accent, #6c5fa6)' : 'rgba(255,255,255,0.05)';
            html += `<div style="display:flex; gap:8px; margin-bottom:8px; align-items:center; justify-content:space-between;">
                <div class="vp-add-btn" id="vp-btn-add-cat" title="Create new category" style="flex:1; text-align:center;">➕ Category</div>
                <div class="vp-tab-btn vp-sb-tab ${isFxActive}" data-id="effects" style="background:${fxBg}; border:1px solid rgba(255,255,255,0.1); border-radius:4px; padding:2px 8px; font-weight:600;" title="Effects shelf — click again to return to assets">
                    <span style="font-size:11px;">✨</span> <span style="color:white;">Effects</span>
                </div>
            </div>`;

            for (const cat of gd.categories) {
                const catTabs = gd.tabs.filter(t => t.categoryId === cat.id);
                const catAssetsCount = allAssets.filter(a => catTabs.some(t => t.id === a.tabId)).length;
                const stateIcons = { open: '🟢', collapsed: '🟡', locked: '🔴' };
                const stateIcon = stateIcons[cat.state] || '🟢';
                const isCatUICollapsed = !!cat.uiCollapsed;
                const toggleArrow = isCatUICollapsed ? '▶' : '▼';

                html += `<div class="vp-cat-row" data-cat-id="${cat.id}">
                    <div class="vp-cat-header vp-sb-cat" data-id="${cat.id}" title="${cat.desc || ''}">
                        <span class="vp-cat-toggle-ui" data-id="${cat.id}" style="font-size:11px; width:16px; cursor:pointer; text-align:center;" title="Click to fold/unfold UI">${toggleArrow}</span>
                        <span class="vp-sb-state state-${cat.state}" data-type="CAT" data-id="${cat.id}" title="Click to toggle state (Open/Collapsed/Locked)">${stateIcon}</span>
                        <span class="vp-editable-name" data-type="CAT" data-id="${cat.id}" style="flex:1;" title="Double-click to rename">${cat.name}</span> <span class="vp-badge">${catAssetsCount}</span>
                        <span class="vp-add-btn vp-btn-add-tab" data-cat="${cat.id}" title="Add tab to this category" style="padding:0 4px;">+ tab</span>
                    </div>`;

                if (!isCatUICollapsed && catTabs.length > 0) {
                    html += `<div style="display:flex; flex-wrap:wrap; gap:6px; width:100%; padding-left:20px; margin-top:2px;">`;
                    for (const tab of catTabs) {
                        const isActive = gd.activeTabId === tab.id ? 'active' : '';
                        const tabIcon = stateIcons[tab.state] || '🟢';
                        let inheritedClass = '', titleNote = '';
                        if (cat.state === 'locked') { inheritedClass = 'inherited-locked'; titleNote = ' [Category is Locked]'; }
                        else if (cat.state === 'collapsed') { inheritedClass = 'inherited-collapsed'; titleNote = ' [Category is Collapsed]'; }
                        const tabAssetsCount = allAssets.filter(a => a.tabId === tab.id).length;
                        const collageIcon = tab.markedForCollage ? `<span style="font-size:10px; color:#f0b450; margin-left:4px;" title="Помечен для Gallery View">🖼️</span>` : '';
                        html += `<div class="vp-tab-btn vp-sb-tab ${isActive} ${inheritedClass}" data-id="${tab.id}" draggable="true" title="${tab.desc || 'Tab'}${titleNote}">
                            <span class="vp-sb-state" data-type="TAB" data-id="${tab.id}" title="Click to toggle state">${tabIcon}</span>
                            <span class="vp-editable-name" data-type="TAB" data-id="${tab.id}" style="color:white; flex:1;" title="Double-click to rename">${tab.name}</span>${collageIcon} <span class="vp-badge">${tabAssetsCount}</span>
                        </div>`;
                    }
                    html += `</div>`;
                }
                html += `</div>`;
            }

            if (gd.categories.length === 0) {
                html += `<div style="padding:16px 10px; text-align:center; color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.5;">
                    <div style="font-size:24px; margin-bottom:6px;">📂</div>
                    Drop a folder or press ➕ to create a category
                </div>`;
            }
            sidebar.innerHTML = html;
            this.attachSidebarEvents(sidebar);
        },

        /** Wire up sidebar interactions (rename / state / add / select / drag-move). */
        attachSidebarEvents(sidebar) {
            // Inline rename (double-click on name)
            sidebar.querySelectorAll('.vp-editable-name').forEach(span => {
                span.addEventListener('dblclick', (e) => {
                    e.preventDefault(); e.stopPropagation();
                    const originalName = span.textContent;
                    const input = document.createElement('input');
                    input.type = 'text'; input.value = originalName;
                    input.style.cssText = `width:80px; background:rgba(0,0,0,0.5); border:1px solid var(--accent,#6c5fa6); color:white; border-radius:3px; padding:2px 4px; font-size:12px; font-family:inherit; outline:none;`;
                    span.replaceWith(input);
                    input.focus(); input.select();
                    input.addEventListener('click', e => e.stopPropagation());
                    input.addEventListener('dblclick', e => e.stopPropagation());
                    const commit = () => {
                        const newName = input.value.trim();
                        if (newName && newName !== originalName) {
                            const target = span.dataset.type === 'CAT'
                                ? S.galleryData.categories.find(c => c.id === span.dataset.id)
                                : S.galleryData.tabs.find(t => t.id === span.dataset.id);
                            if (target) { target.name = newName; markVisualInventoryDirty(span.dataset.type === 'TAB' ? 'tab-renamed' : 'category-renamed'); persistGalleryData(); }
                        }
                        TabsManager.renderSidebar();
                    };
                    input.addEventListener('blur', commit);
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') input.blur();
                        else if (e.key === 'Escape') TabsManager.renderSidebar();
                    });
                });
            });

            // Add category
            sidebar.querySelector('#vp-btn-add-cat')?.addEventListener('click', () => TabsManager.createCategory());

            // Add tab to a category
            sidebar.querySelectorAll('.vp-btn-add-tab').forEach(btn => {
                btn.addEventListener('click', (e) => { e.stopPropagation(); TabsManager.createTab(btn.dataset.cat); });
            });

            // Fold/unfold category UI
            sidebar.querySelectorAll('.vp-cat-toggle-ui').forEach(arrow => {
                arrow.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const cat = S.galleryData.categories.find(c => c.id === arrow.dataset.id);
                    if (cat) { cat.uiCollapsed = !cat.uiCollapsed; TabsManager.renderSidebar(); persistGalleryData(); }
                });
            });

            // State carousel (open / collapsed / locked)
            sidebar.querySelectorAll('.vp-sb-state').forEach(dot => {
                dot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    TabsManager.toggleState(dot.dataset.type, dot.dataset.id);
                });
            });

            // Context menus for category/tab tree.
            // Right-click on empty sidebar area: create a category.
            sidebar.oncontextmenu = (e) => {
                if (e.target.closest('.vp-sb-cat') || e.target.closest('.vp-sb-tab') || e.target.closest('.vp-add-btn')) return;
                showSidebarContextMenu(e, 'sidebar', null);
            };
            sidebar.querySelectorAll('.vp-sb-cat').forEach(catEl => {
                catEl.addEventListener('contextmenu', (e) => {
                    showSidebarContextMenu(e, 'category', catEl.dataset.id);
                });
            });
            sidebar.querySelectorAll('.vp-sb-tab:not([data-id="effects"])').forEach(tabEl => {
                tabEl.addEventListener('contextmenu', (e) => {
                    showSidebarContextMenu(e, 'tab', tabEl.dataset.id);
                });
            });

            // Tab / Effects select
            sidebar.querySelectorAll('.vp-sb-tab').forEach(tabEl => {
                tabEl.addEventListener('click', (e) => {
                    // Single-click anywhere on the tab — including the text label — selects it.
                    // Only the state dot and explicit add-tab controls keep their own behavior.
                    // Double-click on the label still starts inline rename via the handler above.
                    if (e.target.closest('.vp-sb-state') || e.target.closest('.vp-btn-add-tab')) return;
                    const id = tabEl.dataset.id;
                    if (id === 'effects') {
                        S.galleryData.activeTabId = 'effects';
                    } else {
                        S.galleryData.activeTabId = id;
                        S.ui.lastAssetTabId = id;
                    }
                    TabsManager.renderSidebar();
                    renderGalleryGrid();
                    persistGalleryData();
                });
            });

            // Drag-to-move tabs (skip the Effects pseudo-tab)
            sidebar.querySelectorAll('.vp-sb-tab[draggable="true"]').forEach(tabEl => {
                if (tabEl.dataset.id === 'effects') return;
                tabEl.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('vp/tab-move', tabEl.dataset.id);
                    e.dataTransfer.effectAllowed = 'move';
                });
                tabEl.addEventListener('dragover', (e) => {
                    const isTabMove = dataTransferHasType(e.dataTransfer, 'vp/tab-move');
                    const isAssetMove = dataTransferHasType(e.dataTransfer, 'vp/asset-move-batch');
                    if (isTabMove || isAssetMove) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = isAssetMove ? 'move' : 'move';
                        tabEl.style.outline = isAssetMove
                            ? '2px solid rgba(76,175,125,0.95)'
                            : '1px solid var(--accent,#6c5fa6)';
                    }
                });
                tabEl.addEventListener('dragleave', () => { tabEl.style.outline = ''; });
                tabEl.addEventListener('drop', (e) => {
                    const isAssetMove = dataTransferHasType(e.dataTransfer, 'vp/asset-move-batch');
                    const isTabMove = dataTransferHasType(e.dataTransfer, 'vp/tab-move');
                    if (!isAssetMove && !isTabMove) return;
                    e.preventDefault(); e.stopPropagation(); tabEl.style.outline = '';
                    if (isAssetMove) {
                        const tags = readAssetMoveBatchFromDataTransfer(e.dataTransfer);
                        moveAssetsToTab(tags, tabEl.dataset.id);
                        return;
                    }
                    const draggedId = e.dataTransfer.getData('vp/tab-move');
                    if (draggedId && draggedId !== tabEl.dataset.id) TabsManager.moveTab(draggedId, 'TAB', tabEl.dataset.id);
                });
            });
            sidebar.querySelectorAll('.vp-sb-cat').forEach(catEl => {
                catEl.addEventListener('dragover', (e) => {
                    if (dataTransferHasType(e.dataTransfer, 'vp/tab-move')) { e.preventDefault(); catEl.style.outline = '1px dashed var(--accent,#6c5fa6)'; }
                });
                catEl.addEventListener('dragleave', () => { catEl.style.outline = ''; });
                catEl.addEventListener('drop', (e) => {
                    e.preventDefault(); catEl.style.outline = '';
                    const draggedId = e.dataTransfer.getData('vp/tab-move');
                    if (draggedId) TabsManager.moveTab(draggedId, 'CAT', catEl.dataset.id);
                });
            });
        },
    };

    // ════════════════════════════════════════════════════════════════
    //  FLOATING GALLERY / SETTINGS PANEL
    // ════════════════════════════════════════════════════════════════

    let _panelStylesInjected = false;

    /** Inject the panel's own CSS once (self-contained module styles). */
    function injectPanelStyles() {
        if (_panelStylesInjected) return;
        _panelStylesInjected = true;
        const style = document.createElement('style');
        style.textContent = `
            #vp-gallery-panel {
                position: fixed; z-index: 10001;
                width: 340px; height: 560px;
                background: var(--bg-secondary, #1e1e2e);
                border: 1px solid var(--border, #383860);
                border-radius: 8px; box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                display: flex; flex-direction: column; overflow: hidden;
                font-family: system-ui, sans-serif; font-size: 13px;
                color: var(--text-primary, #cdd6f4); resize: none;
            }
            .vp-panel-header {
                display: flex; align-items: center; padding: 6px 10px;
                background: var(--bg-tertiary, #252540);
                border-bottom: 1px solid var(--border, #383860);
                cursor: move; user-select: none; flex-shrink: 0;
            }
            .vp-panel-tabs { display: flex; gap: 2px; flex: 1; }
            .vp-panel-tab {
                padding: 3px 10px; border-radius: 4px; cursor: pointer;
                font-size: 12px; opacity: 0.6; transition: all 0.15s;
            }
            .vp-panel-tab:hover { opacity: 0.9; }
            .vp-panel-tab.vp-panel-tab-active { background: var(--accent, #6c5fa6); opacity: 1; }
            .vp-panel-body { flex: 1; display: flex; flex-direction: column; overflow: hidden; min-height: 0; }
            .vp-panel-section { display: none; flex: 1; flex-direction: column; overflow: hidden; }
            .vp-panel-section.vp-panel-section-active { display: flex; }
            #vp-gallery-sidebar {
                padding: 8px; background: var(--bg-tertiary, #252540);
                border-bottom: 1px solid var(--border, #383860);
                max-height: 40%; overflow-y: auto;
            }
            .vp-cat-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
            .vp-cat-header {
                width: 100%; padding: 4px 8px; background: rgba(0,0,0,0.2);
                border-radius: 4px; font-weight: 600; color: var(--text-primary, #cdd6f4);
                font-size: 13px; cursor: pointer; display: flex; align-items: center;
                gap: 6px; user-select: none;
            }
            .vp-cat-header:hover { background: rgba(0,0,0,0.3); }
            .vp-tab-btn {
                padding: 4px 10px; background: rgba(255,255,255,0.05); border-radius: 16px;
                font-size: 12px; color: var(--text-primary, #cdd6f4); cursor: pointer;
                display: flex; align-items: center; gap: 4px; transition: background 0.2s;
                user-select: none; border: 1px solid transparent;
            }
            .vp-tab-btn.active { background: var(--accent, #6c5fa6); }
            .vp-tab-btn:hover:not(.active) { background: rgba(255,255,255,0.1); }
            .vp-sb-state { font-size: 13px; opacity: 0.8; cursor: pointer; transition: transform 0.1s, opacity 0.2s; }
            .vp-sb-state:hover { opacity: 1; transform: scale(1.15); }
            .state-open { color: var(--success, #4caf7d); }
            .state-collapsed { color: var(--accent, #6c5fa6); }
            .state-locked { color: var(--error, #e05555); }
            .vp-tab-btn.inherited-locked { border: 1px dashed var(--error, #e05555) !important; }
            .vp-tab-btn.inherited-collapsed { border: 1px dashed #e6c84c !important; }
            .vp-add-btn {
                background: transparent; border: 1px dashed rgba(255,255,255,0.2);
                color: rgba(255,255,255,0.5); border-radius: 4px; padding: 2px 8px;
                font-size: 11px; cursor: pointer; user-select: none; transition: all 0.2s;
            }
            .vp-add-btn:hover { background: rgba(255,255,255,0.1); color: white; border-color: rgba(255,255,255,0.4); }
            .vp-fly-ghost {
                position: fixed; z-index: 10006; pointer-events: none;
                transition: all 0.4s cubic-bezier(0.2,1,0.3,1); opacity: 0.8;
                box-shadow: 0 4px 12px rgba(0,0,0,0.5); border-radius: 4px;
            }
            .vp-badge {
                background: rgba(0,0,0,0.3); border-radius: 10px; padding: 1px 5px;
                font-size: 9px; margin-left: 4px; color: rgba(255,255,255,0.6);
            }
        `;
        document.head.appendChild(style);
    }

    /** The panel's inner HTML (sidebar slot, grid, footers, settings section). */
    function buildPanelHTML() {
        return `
            <div class="vp-panel-header" id="vp-panel-header">
                <div class="vp-panel-tabs">
                    <div class="vp-panel-tab vp-panel-tab-active" data-section="gallery">📚 Gallery</div>
                    <div class="vp-panel-tab" data-section="settings">⚙️ Settings</div>
                </div>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" id="vp-panel-close" title="Закрыть">✕</button>
            </div>
            <div class="vp-panel-body">
                <!-- ═══ GALLERY SECTION ═══ -->
                <div class="vp-panel-section vp-panel-section-active" id="vp-panel-gallery">
                    <div id="vp-gallery-sidebar" style="padding:8px; background:var(--bg-tertiary,#252540); border-bottom:1px solid var(--border,#383860); max-height:35%; overflow-y:auto; flex-shrink:0;"></div>
                    <div style="flex:1; display:flex; flex-direction:column; overflow:hidden; background:var(--bg-primary,#11111b);">
                        <div class="vp-gallery-tabs" style="display:flex; gap:6px; padding:6px 8px; align-items:center; border-bottom:1px solid var(--border,#383860);">
                            <span id="vp-current-tab-name" style="font-weight:600; color:var(--text-primary,#cdd6f4); font-size:13px;">Assets</span>
                            <div style="flex:1;"></div>
                            <div id="vp-fx-controls" style="display:none; align-items:center; gap:6px; font-size:11px; color:var(--text-secondary,#a6adc8); white-space:nowrap;">
                                <span id="vp-fx-hidden-stat"></span>
                                <button class="vp-fx-trash-toggle vp-btn vp-btn-ghost" style="padding:2px 8px; height:22px; font-size:11px;"></button>
                            </div>
                            <input class="vp-search-input" name="search" id="vp-search" type="text" placeholder="🔍" style="max-width:80px;">
                            <input name="galleryGridSize" type="range" id="vp-gallery-size" min="60" max="180" step="10" value="100" style="width:50px;" title="Размер превью">
                        </div>
                        <div class="vp-gallery-grid" id="vp-gallery-grid" style="flex:1; overflow-y:auto;">
                            <div class="vp-gallery-empty">Загрузите папку или файлы</div>
                        </div>
                        <div class="vp-gallery-footer" id="vp-gallery-footer-normal">
                            <div style="display:flex; gap:6px;">
                                <button class="vp-btn" id="vp-gallery-load-folder" title="Загрузить папку">📂</button>
                                <button class="vp-btn" id="vp-gallery-load-file" title="Загрузить файл">📎</button>
                                <button class="vp-btn" id="vp-gallery-paste-clipboard" title="Вставить из буфера">📋</button>
                                <button class="vp-btn" id="vp-gallery-autotag" title="Auto-tag with AI">✨</button>
                                <button class="vp-btn" id="vp-gallery-collage" title="Собрать Gallery View из помеченных табов" style="background:var(--accent,#6c5fa6); color:white;">🖼️</button>
                            </div>
                            <span class="vp-gallery-footer-count" id="vp-gallery-count-footer">0 ассетов</span>
                            <div style="display:flex; gap:6px;">
                                <button class="vp-btn vp-btn-ghost" id="vp-gallery-export" title="Экспорт">💾</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-gallery-import" title="Импорт">📥</button>
                            </div>
                        </div>
                        <div class="vp-gallery-footer" id="vp-gallery-footer-selection" style="display:none;">
                            <div style="display:flex; gap:6px;">
                                <button class="vp-btn" id="vp-sel-clear" title="Снять выделение">✕</button>
                                <button class="vp-btn vp-btn-danger" id="vp-sel-delete" title="Удалить выделенные">🗑</button>
                                <button class="vp-btn" id="vp-sel-tag" title="Auto-tag">✨</button>
                            </div>
                            <span class="vp-gallery-footer-count" id="vp-sel-count">0 selected</span>
                            <div style="display:flex; gap:6px;">
                                <button class="vp-btn vp-btn-ghost" id="vp-sel-export" title="Экспорт">💾</button>
                            </div>
                        </div>
                    </div>
                </div>
                <!-- ═══ SETTINGS SECTION ═══ -->
                <div class="vp-panel-section" id="vp-panel-settings" style="overflow-y:auto;">
                    <div style="padding:8px;">
                        <label class="vp-setting-row"><span>Visual Context Depth</span><input class="vp-depth-input" id="vp-depth" type="number" min="0" max="30" value="3" title="Кол-во кадров в контексте LLM"></label>
                        <label class="vp-setting-row"><span>Max History</span><input class="vp-depth-input" id="vp-max-history" type="number" min="5" max="200" value="20"></label>
                        <label class="vp-setting-row"><span>Fade duration (s)</span><input class="vp-depth-input" id="vp-fade-duration" type="number" min="0" max="5.0" step="0.1" value="0.3"></label>
                        <label class="vp-setting-row"><span>Transition</span>
                            <select id="vp-transition-style" style="background:var(--bg-tertiary); color:#fff; border:1px solid var(--border); border-radius:3px; font-size:11px; padding:2px;">
                                <option value="fade">Sequential Fade</option><option value="crossfade">Crossfade</option>
                                <option value="slide_left">Slide Left</option><option value="slide_up">Slide Up</option>
                                <option value="zoom">Zoom</option><option value="pop">Pop</option>
                                <option value="flip">3D Flip</option><option value="random">🎲 Random</option>
                            </select>
                        </label>
                        <label class="vp-setting-row" title="Подпись текущего кадра в шапке проектора"><span>Frame label</span>
                            <select class="vp-depth-input" id="vp-frame-label-mode" style="width:auto;">
                                <option value="title">Asset title</option>
                                <option value="debug">Debug [IMG:tag]</option>
                                <option value="hidden">Hidden</option>
                            </select>
                        </label>
                        <label class="vp-setting-row" title="Скругление углов ассета (картинки) на экране проектора"><span>Asset corner radius</span>
                            <span style="display:flex; align-items:center; gap:6px;">
                                <input id="vp-screen-radius" type="range" min="0" max="32" step="1" value="8" style="width:90px;">
                                <span id="vp-screen-radius-label" style="min-width:34px; text-align:right; font-size:11px; color:var(--text-secondary,#8888aa);">8px</span>
                            </span>
                        </label>
                        <label class="vp-setting-row"><span>Debug Tags</span><input type="checkbox" id="vp-debug-tags"></label>
                        <label class="vp-setting-row"><span>Descriptions in manifest</span><input type="checkbox" id="vp-manifest-desc"></label>
                        <label class="vp-setting-row"><span>Directory Commands</span><input type="checkbox" id="vp-allow-dir-cmds"></label>
                        <label class="vp-setting-row"><span>Auto-tag on load</span>
                            <select class="vp-depth-input" id="vp-autotag-mode" style="width:auto;"><option value="ask">Ask</option><option value="always">Always</option><option value="never">Never</option></select>
                        </label>
                        <label class="vp-setting-row"><span>Base subtitle speed (WPM)</span><input class="vp-depth-input" id="vp-subtitle-wpm" type="number" min="60" max="400" step="10" value="160"></label>
                        <label class="vp-setting-row"><span>Max Long Side (px)</span><input class="vp-depth-input" id="vp-max-long-side" type="number" min="256" max="4096" value="1024"></label>
                        <label class="vp-setting-row"><span>JPEG Quality</span><input class="vp-depth-input" id="vp-jpeg-quality" type="number" min="0.1" max="1.0" step="0.01" value="0.92"></label>
                        <div style="font-size:11px; color:var(--text-secondary,#8888aa); margin-top:8px; line-height:1.5;">
                            Prompt templates: <code>{{#if hasReady}}...{{/if}}</code>
                        </div>
                        <div class="vp-prompt-section" style="margin-top:6px;">
                            <div class="vp-prompt-label"><span>Manifest</span>
                                <button class="vp-btn vp-btn-ghost" id="vp-manifest-reset" title="Reset">↻</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-manifest-preview" title="Preview">👁</button>
                            </div>
                            <textarea class="vp-prompt-textarea" id="vp-manifest-template" placeholder="(default)" spellcheck="false"></textarea>
                            <div class="vp-prompt-hints" id="vp-manifest-hints"></div>
                        </div>
                        <div class="vp-prompt-section" style="margin-top:6px;">
                            <div class="vp-prompt-label"><span>Frame context</span>
                                <button class="vp-btn vp-btn-ghost" id="vp-frame-reset" title="Reset">↻</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-frame-preview" title="Preview">👁</button>
                            </div>
                            <textarea class="vp-prompt-textarea" id="vp-frame-template" placeholder="(default)" spellcheck="false"></textarea>
                            <div class="vp-prompt-hints" id="vp-frame-hints"></div>
                        </div>
                    </div>
                </div>
            </div>
            <div class="vp-resize-handle" id="vp-panel-resize-handle"></div>
        `;
    }

    /** Wire gallery action buttons (load/paste/autotag/export/import/search/size/selection). */
    function wireGalleryButtons(panel) {
        const p$ = (sel) => panel.querySelector(sel);
        p$('#vp-gallery-load-folder')?.addEventListener('click', loadGalleryFolder);
        p$('#vp-gallery-load-file')?.addEventListener('click', loadSingleFile);
        p$('#vp-gallery-paste-clipboard')?.addEventListener('click', pasteFromClipboard);
        p$('#vp-gallery-autotag')?.addEventListener('click', () => VP.gallery.Tagger?.tagAll());
        const collageBtn = p$('#vp-gallery-collage');
        if (collageBtn) {
            collageBtn.addEventListener('click', generateCollageFromMarkedTabs);
            collageBtn.addEventListener('contextmenu', showCollageContextMenu);
        }
        p$('#vp-gallery-export')?.addEventListener('click', () => exportGallery());
        p$('#vp-gallery-import')?.addEventListener('click', importGallery);
        p$('#vp-search')?.addEventListener('input', () => renderGalleryGrid());
        p$('#vp-gallery-size')?.addEventListener('input', () => renderGalleryGrid());
        p$('#vp-gallery-grid')?.addEventListener('click', (e) => {
            if (e.target === p$('#vp-gallery-grid')) clearSelection();
        });

        p$('#vp-sel-clear')?.addEventListener('click', () => clearSelection());
        p$('#vp-sel-tag')?.addEventListener('click', () => {
            const tags = Array.from(S.selection.tags);
            if (tags.length) VP.gallery.Tagger?.tagAll(tags);
        });
        p$('#vp-sel-delete')?.addEventListener('click', async () => {
            const tags = Array.from(S.selection.tags);
            if (!tags.length) return;
            const ans = await showConfirm({
                title: 'Delete selected assets?',
                message: `Удалить ${tags.length} ассет${tags.length === 1 ? '' : 'ов'}?`,
                buttons: [
                    { id: 'cancel', label: 'Cancel', ghost: true },
                    { id: 'ok', label: 'Delete', danger: true },
                ],
            });
            if (ans !== 'ok') return;
            deleteAssets(tags);
            S.selection.tags.clear();
            S.selection.anchor = null;
            renderGalleryGrid();
            updateGalleryFooter();
            updateGalleryButton();
            showToast(`Удалено: ${tags.length}`, 'success');
        });
        p$('#vp-sel-export')?.addEventListener('click', () => exportGallery(S.selection.tags));
    }

    /** Panel drag + resize; geometry persisted to IndexedDB. */
    function wirePanelDragResize(panel) {
        const header = panel.querySelector('#vp-panel-header');
        const handle = panel.querySelector('#vp-panel-resize-handle');
        let isDragging = false, isResizing = false;
        let offsetX, offsetY, startW, startH, startX, startY;
        let dragScaleX = 1, dragScaleY = 1, resizeScaleX = 1, resizeScaleY = 1;

        header?.addEventListener('mousedown', (e) => {
            if (panel.classList.contains('vp-shell-docked')) return;
            if (e.target.tagName === 'BUTTON' || e.target.classList.contains('vp-panel-tab')) return;
            e.preventDefault();
            const { rect, css } = getNormalizedElementPlacement(panel);
            panel.style.left = `${css.left}px`; panel.style.top = `${css.top}px`; panel.style.right = 'auto';
            offsetX = e.clientX - rect.left; offsetY = e.clientY - rect.top;
            dragScaleX = css.scaleX; dragScaleY = css.scaleY;
            isDragging = true;
        });
        handle?.addEventListener('mousedown', (e) => {
            if (panel.classList.contains('vp-shell-docked')) return;
            e.preventDefault(); e.stopPropagation();
            const { css } = getNormalizedElementPlacement(panel);
            startW = panel.offsetWidth; startH = panel.offsetHeight;
            startX = e.clientX; startY = e.clientY;
            resizeScaleX = css.scaleX; resizeScaleY = css.scaleY;
            isResizing = true;
        });
        document.addEventListener('mousemove', (e) => {
            if (isDragging) {
                panel.style.left = `${(e.clientX - offsetX) / dragScaleX}px`;
                panel.style.top  = `${(e.clientY - offsetY) / dragScaleY}px`;
                panel.style.right = 'auto';
            }
            if (isResizing) {
                const dx = (e.clientX - startX) / resizeScaleX;
                const dy = (e.clientY - startY) / resizeScaleY;
                panel.style.width  = Math.max(200, startW + dx) + 'px';
                panel.style.height = Math.max(150, startH + dy) + 'px';
            }
        });
        document.addEventListener('mouseup', () => {
            if (isDragging || isResizing) {
                const { css } = getNormalizedElementPlacement(panel);
                if (DB) DB.setPanelGeom({ left: css.left, top: css.top, width: panel.offsetWidth, height: panel.offsetHeight })
                    .catch(() => {});
            }
            isDragging = false; isResizing = false;
        });
    }

    /** Async-restore saved panel geometry from IndexedDB. */
    function restorePanelGeom(panel) {
        if (!DB) return;
        DB.getPanelGeom().then(g => {
            if (!g) return;
            panel.style.left = g.left + 'px';  panel.style.top = g.top + 'px';
            panel.style.width = g.width + 'px'; panel.style.height = g.height + 'px';
            panel.style.right = 'auto';
        }).catch(() => {});
    }

    /** Build + mount the floating Gallery/Settings panel. */
    function createGalleryPanel() {
        injectPanelStyles();
        const panel = document.createElement('div');
        panel.id = 'vp-gallery-panel';
        panel.innerHTML = buildPanelHTML();
        document.body.appendChild(panel);

        S.ui.galleryGrid  = panel.querySelector('#vp-gallery-grid');
        S.ui.galleryPanel = panel;

        TabsManager.renderSidebar();

        wireGalleryButtons(panel);
        wireSettings(panel);          // ← defined in Part 7
        wirePanelDragResize(panel);
        restorePanelGeom(panel);

        // Gallery ↔ Settings tabs
        panel.querySelectorAll('.vp-panel-tab').forEach(tab => {
            tab.addEventListener('click', () => activatePanelSection(tab.dataset.section));
        });
        // Close
        panel.querySelector('#vp-panel-close').addEventListener('click', () => togglePanel(false));
        // Raise z-index on focus
        panel.addEventListener('mousedown', () => {
            panel.style.zIndex = 10002;
            if (S.ui.vpWindow) S.ui.vpWindow.style.zIndex = 10001;
        });
        return panel;
    }

    // ════════════════════════════════════════════════════════════════
    //  SETTINGS WIRING  (two-way bind inputs ↔ State.config ↔ IDB)
    // ════════════════════════════════════════════════════════════════

    function wireSettings(panel) {
        const p$ = (sel) => panel.querySelector(sel);

        const bindNumber = (sel, key, { min = null, max = null, parse = Number, after = null } = {}) => {
            const el = p$(sel); if (!el) return;
            el.addEventListener('change', (e) => {
                let v = parse(e.target.value);
                if (!Number.isFinite(v)) { syncSettingsUI(); return; }
                if (min !== null) v = Math.max(min, v);
                if (max !== null) v = Math.min(max, v);
                S.config[key] = v;
                e.target.value = v;
                after?.(v);
                persistConfig();
            });
        };
        const bindCheckbox = (sel, key, after = null) => {
            const el = p$(sel); if (!el) return;
            el.addEventListener('change', (e) => { S.config[key] = !!e.target.checked; after?.(S.config[key]); persistConfig(); });
        };
        const bindSelect = (sel, key, after = null) => {
            const el = p$(sel); if (!el) return;
            el.addEventListener('change', (e) => { S.config[key] = e.target.value; after?.(S.config[key]); persistConfig(); });
        };
        const bindPromptEditor = (sel, promptKey, defaultValue, type) => {
            const ta = p$(sel); if (!ta) return;
            ta.addEventListener('input', () => {
                const raw = ta.value, trimmed = raw.trim();
                S.config.prompts[promptKey] = (!trimmed || trimmed === defaultValue.trim()) ? null : raw;
                ta.dataset.isDefault = S.config.prompts[promptKey] === null ? 'true' : 'false';
                VP.updatePromptHints?.(ta, type);
                VP.updateTemplateStatus?.(ta);
                persistConfig();
            });
        };

        bindNumber('#vp-depth', 'contextDepth', { min: 0, max: 30, parse: v => parseInt(v, 10) });
        bindNumber('#vp-max-history', 'maxHistory', {
            min: 5, max: 200, parse: v => parseInt(v, 10),
            after: (v) => { if (S.history.length > v) S.history = S.history.slice(-v); VP.updateProjectorUI?.(); },
        });
        bindNumber('#vp-fade-duration', 'fadeDuration', { min: 0, max: 5, parse: v => parseFloat(v) });
        bindNumber('#vp-subtitle-wpm', 'subtitleWPM', { min: 60, max: 400, parse: v => parseInt(v, 10) });
        bindNumber('#vp-max-long-side', 'maxLongSide', { min: 256, max: 4096, parse: v => parseInt(v, 10) });
        bindNumber('#vp-jpeg-quality', 'jpegQuality', {
            min: 0.1, max: 1.0, parse: v => parseFloat(v),
            after: (v) => { const el = p$('#vp-jpeg-quality'); if (el) el.value = v.toFixed(2); },
        });

        // Asset corner radius slider: live-apply via core, persist on change.
        {
            const slider = p$('#vp-screen-radius');
            const label  = p$('#vp-screen-radius-label');
            if (slider) {
                slider.addEventListener('input', () => {
                    const v = VP.applyAssetCornerRadius?.(slider.value) ?? parseInt(slider.value, 10);
                    if (label) label.textContent = v + 'px';
                });
                slider.addEventListener('change', () => persistConfig());
            }
        }

        bindCheckbox('#vp-debug-tags', 'debugTags');
        bindCheckbox('#vp-manifest-desc', 'manifestDescriptions');
        bindCheckbox('#vp-allow-dir-cmds', 'allowDirectoryCommands');
        bindSelect('#vp-autotag-mode', 'autoTagOnLoad');
        bindSelect('#vp-transition-style', 'transitionType');
        bindSelect('#vp-frame-label-mode', 'frameLabelMode', () => VP.updateProjectorUI?.());

        const MAN = VP.DEFAULT_MANIFEST_TEMPLATE;
        const FRM = VP.DEFAULT_FRAME_TEMPLATE;
        bindPromptEditor('#vp-manifest-template', 'manifest', MAN, 'manifest');
        bindPromptEditor('#vp-frame-template', 'frameContext', FRM, 'frame');

        p$('#vp-manifest-reset')?.addEventListener('click', () => {
            S.config.prompts.manifest = null;
            const ta = p$('#vp-manifest-template'); if (ta) ta.value = MAN;
            syncSettingsUI(); persistConfig();
        });
        p$('#vp-manifest-preview')?.addEventListener('click', () => {
            const tpl = p$('#vp-manifest-template')?.value?.trim() || MAN;
            const preview = VP.buildManifest?.(tpl) ||
                '[Manifest is currently empty]\nNo gallery assets or bot-visible effects are available right now.';
            showPromptPreview('Manifest preview (rendered)', preview);
        });
        p$('#vp-frame-reset')?.addEventListener('click', () => {
            S.config.prompts.frameContext = null;
            const ta = p$('#vp-frame-template'); if (ta) ta.value = FRM;
            syncSettingsUI(); persistConfig();
        });
        p$('#vp-frame-preview')?.addEventListener('click', () => {
            const tpl = p$('#vp-frame-template')?.value?.trim() || FRM;
            showPromptPreview('Frame context preview (rendered)', VP.buildFrameContextPreview?.(tpl));
        });
    }

    /** Populate settings inputs from State.config (called when entering Settings). */
    function syncSettingsUI() {
        const panel = S.ui.galleryPanel;
        const projector = S.ui.vpWindow;
        if (!projector) return;

        const speed = Number.isFinite(Number(S.config.subtitleSpeed)) ? Number(S.config.subtitleSpeed) : 1.0;
        const speedSlider = projector.querySelector('#vp-speed-slider');
        const speedLabel  = projector.querySelector('#vp-speed-label');
        if (speedSlider) speedSlider.value = speed;
        if (speedLabel)  speedLabel.textContent = `${speed.toFixed(1)}x`;

        if (!panel) return;
        const q = (sel) => panel.querySelector(sel);
        const setV = (sel, v) => { const el = q(sel); if (el) el.value = v; };
        const setC = (sel, v) => { const el = q(sel); if (el) el.checked = !!v; };

        setV('#vp-depth', S.config.contextDepth);
        setV('#vp-max-history', S.config.maxHistory);
        setC('#vp-debug-tags', S.config.debugTags);
        setC('#vp-manifest-desc', S.config.manifestDescriptions);
        setC('#vp-allow-dir-cmds', S.config.allowDirectoryCommands);
        setV('#vp-autotag-mode', S.config.autoTagOnLoad);
        setV('#vp-subtitle-wpm', S.config.subtitleWPM);
        setV('#vp-max-long-side', S.config.maxLongSide);
        setV('#vp-jpeg-quality', S.config.jpegQuality);
        setV('#vp-fade-duration', S.config.fadeDuration);
        setV('#vp-transition-style', S.config.transitionType || 'random');
        setV('#vp-frame-label-mode', S.config.frameLabelMode || 'title');
        {
            const rc = S.config.assetCornerRadius ?? S.config.screenCornerRadius;
            const r = Number.isFinite(Number(rc)) ? Number(rc) : 8;
            setV('#vp-screen-radius', r);
            const lbl = q('#vp-screen-radius-label'); if (lbl) lbl.textContent = r + 'px';
        }

        const MAN = VP.DEFAULT_MANIFEST_TEMPLATE;
        const FRM = VP.DEFAULT_FRAME_TEMPLATE;
        const mTA = q('#vp-manifest-template');
        const fTA = q('#vp-frame-template');
        if (mTA) {
            mTA.value = S.config.prompts?.manifest ?? MAN;
            mTA.dataset.isDefault = S.config.prompts?.manifest === null ? 'true' : 'false';
            VP.updatePromptHints?.(mTA, 'manifest');
            VP.updateTemplateStatus?.(mTA);
        }
        if (fTA) {
            fTA.value = S.config.prompts?.frameContext ?? FRM;
            fTA.dataset.isDefault = S.config.prompts?.frameContext === null ? 'true' : 'false';
            VP.updatePromptHints?.(fTA, 'frame');
            VP.updateTemplateStatus?.(fTA);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  PANEL SECTION / VISIBILITY TOGGLE
    // ════════════════════════════════════════════════════════════════

    function activatePanelSection(section = 'gallery') {
        const panel = S.ui.galleryPanel;
        if (!panel) return;
        const norm = section === 'settings' ? 'settings' : 'gallery';
        const galBtn  = S.ui.vpWindow?.querySelector('#vp-toggle-gallery');
        const settBtn = S.ui.vpWindow?.querySelector('#vp-toggle-settings');
        S.ui.panelSection = norm;

        panel.querySelectorAll('.vp-panel-tab').forEach(t => {
            t.classList.toggle('vp-panel-tab-active', t.dataset.section === norm);
        });
        panel.querySelectorAll('.vp-panel-section').forEach(s => {
            s.classList.toggle('vp-panel-section-active', s.id === `vp-panel-${norm}`);
        });

        if (norm === 'settings') {
            syncSettingsUI();
            settBtn?.classList.add('vp-btn-active');    settBtn?.classList.remove('vp-btn-ghost');
            galBtn?.classList.remove('vp-btn-active');  galBtn?.classList.add('vp-btn-ghost');
            if (galBtn) galBtn.textContent = '📚';
        } else {
            TabsManager.renderSidebar();
            renderGalleryGrid();
            updateGalleryFooter();
            galBtn?.classList.add('vp-btn-active');    galBtn?.classList.remove('vp-btn-ghost');
            settBtn?.classList.remove('vp-btn-active'); settBtn?.classList.add('vp-btn-ghost');
            if (galBtn) galBtn.textContent = '📺';
        }
        panel.style.zIndex = 10002;
        if (S.ui.vpWindow) S.ui.vpWindow.style.zIndex = 10001;
    }

    function isGalleryPanelDocked(panel = S.ui.galleryPanel) {
        return !!(panel && panel.closest && panel.closest('#vp-shell-root'));
    }

    function positionFloatingGalleryPanel(panel) {
        const proj = S.ui.vpWindow;
        const rect = proj?.getBoundingClientRect?.() || { left: 20, top: 20, right: 380 };
        let left = rect.right + 10;
        if (left + 340 > window.innerWidth) left = Math.max(10, rect.left - 350);
        panel.style.left = `${left}px`;
        panel.style.top = `${Math.max(10, rect.top)}px`;
        panel.style.right = 'auto';
        panel.style.width = panel.style.width && panel.style.width !== '100%' ? panel.style.width : '340px';
        panel.style.height = panel.style.height && panel.style.height !== '100%' ? panel.style.height : '560px';
    }

    function undockGalleryPanelForFloating(panel, { position = false } = {}) {
        if (!panel) return;
        if (panel.parentElement !== document.body) document.body.appendChild(panel);
        panel.classList.remove('vp-shell-docked', 'vp-shell-docked-gallery');
        panel.style.position = 'fixed';
        panel.style.maxWidth = '';
        panel.style.maxHeight = '';
        panel.style.zIndex = '10002';
        if (position) positionFloatingGalleryPanel(panel);
    }

    function togglePanel(show, section = 'gallery') {
        const galBtn  = S.ui.vpWindow?.querySelector('#vp-toggle-gallery');
        const settBtn = S.ui.vpWindow?.querySelector('#vp-toggle-settings');
        const target  = section === 'settings' ? 'settings' : 'gallery';

        if (!S.ui.galleryPanel) {
            if (show === false) return; // nothing to close
            S.ui.galleryPanel = createGalleryPanel();
            positionFloatingGalleryPanel(S.ui.galleryPanel);
            S.ui.galleryPanel.style.display = 'none';
        }

        const panel = S.ui.galleryPanel;

        // If Gallery is currently embedded in a shell area, the projector toolbar
        // button should not hide/blank that area. Treat the click as focus/section
        // activation. If the user wants a floating quick-edit gallery, they can
        // remove Gallery from the workspace; then the same button opens it floating.
        if (isGalleryPanelDocked(panel)) {
            S.ui.panelOpen = true;
            activatePanelSection(target);
            return;
        }

        // Shell layout rerenders can remove the docked DOM node while keeping the
        // JS reference. In that case, revive it as a proper floating window.
        if (!panel.isConnected || panel.classList.contains('vp-shell-docked-gallery')) {
            undockGalleryPanelForFloating(panel, { position: true });
            panel.style.display = 'none';
        }

        const wasVisible = panel.style.display !== 'none';
        const current = S.ui.panelSection || 'gallery';
        const shouldHide = show === false || (show === undefined && wasVisible && current === target);
        if (shouldHide) {
            panel.style.display = 'none';
            galBtn?.classList.remove('vp-btn-active');  galBtn?.classList.add('vp-btn-ghost');
            if (galBtn) galBtn.textContent = '📚';
            settBtn?.classList.remove('vp-btn-active'); settBtn?.classList.add('vp-btn-ghost');
            S.ui.panelOpen = false;
            return;
        }
        undockGalleryPanelForFloating(panel);
        panel.style.display = '';
        S.ui.panelOpen = true;
        activatePanelSection(target);
    }

    // ════════════════════════════════════════════════════════════════
    //  CONTACT SHEET / COLLAGE GENERATION
    // ════════════════════════════════════════════════════════════════

    const COLLAGE_TAG = '__SCENERY_COLLAGE__';
    const COLLAGE_LAYOUT_VERSION = 'contact-sheet-v2.1-adaptive-square-quality';
    const COLLAGE_FILENAME = 'scenery_collage.jpg';

    const _collageGeneration = {
        running: false,
        queued: false,
        promise: null,
        activeSignature: null,
        seq: 0,
    };

    function hashString(str) {
        // FNV-1a: tiny deterministic signature for cache keys, good enough for UI state.
        let h = 0x811c9dc5;
        const s = String(str || '');
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 0x01000193);
        }
        return (h >>> 0).toString(36);
    }

    function clampNumber(value, min, max, fallback = min) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(min, Math.min(max, n));
    }

    function getContactSheetHeightBudget() {
        // The gallery's image import limit is reused as a user intent signal:
        // 1024 → compact sheet, 2048+ → taller vertical sheet. Width stays 1024
        // to keep the card grid readable for small local vision models.
        const maxLongSide = clampNumber(S.config?.maxLongSide, 1024, 4096, 1024);
        return maxLongSide >= 1536 ? 2048 : 1024;
    }

    function countSectionAssets(sections) {
        return (sections || []).reduce((sum, sec) => sum + ((sec.assets || []).length), 0);
    }

    function chooseContactSheetPreset(totalAssets) {
        if (totalAssets <= 1)  return { cols: 1, cellSize: 480 };
        if (totalAssets <= 4)  return { cols: 2, cellSize: 340 };
        if (totalAssets <= 9)  return { cols: 3, cellSize: 292 };
        if (totalAssets <= 16) return { cols: 4, cellSize: 228 };
        if (totalAssets <= 25) return { cols: 5, cellSize: 184 };
        return { cols: 6, cellSize: 160 };
    }

    function contactSheetMetricsForCell(cellSize) {
        return {
            barHeight: Math.round(clampNumber(cellSize * 0.15, 24, 44, 24)),
            labelFontSize: Math.round(clampNumber(cellSize * 0.072, 11, 20, 11)),
            labelMinFontSize: 7,
            imagePadding: Math.round(clampNumber(cellSize * 0.035, 4, 12, 6)),
        };
    }

    function selectContactSheetImageSource(asset, layout) {
        if (!asset) return { src: null, createdUrl: null, sourceKind: 'missing' };

        // 128px thumbs are fast and OK for dense sheets, but large adaptive cards
        // should use the original downscaled asset so faces/poses stay crisp.
        const preferOriginal = (layout?.cellSize || 0) >= 184;
        const originalUrl = asset.url || asset.base64 || null;
        const thumbUrl = asset.thumbUrl || null;

        if (preferOriginal) {
            if (originalUrl) return { src: originalUrl, createdUrl: null, sourceKind: 'original' };
            if (asset.blob) {
                const src = URL.createObjectURL(asset.blob);
                return { src, createdUrl: src, sourceKind: 'blob-original' };
            }
            if (thumbUrl) return { src: thumbUrl, createdUrl: null, sourceKind: 'thumb-fallback' };
        } else {
            if (thumbUrl) return { src: thumbUrl, createdUrl: null, sourceKind: 'thumb' };
            if (originalUrl) return { src: originalUrl, createdUrl: null, sourceKind: 'original-fallback' };
            if (asset.blob) {
                const src = URL.createObjectURL(asset.blob);
                return { src, createdUrl: src, sourceKind: 'blob-original-fallback' };
            }
        }

        return { src: null, createdUrl: null, sourceKind: 'missing' };
    }

    function makeImageSourceStats() {
        return {
            preferred: 'mixed',
            originalCount: 0,
            thumbCount: 0,
            fallbackCount: 0,
            missingCount: 0,
        };
    }

    function updateImageSourceStats(stats, sourceKind) {
        if (!stats) return;
        const kind = String(sourceKind || 'missing');
        if (kind === 'original' || kind === 'blob-original') stats.originalCount++;
        else if (kind === 'thumb') stats.thumbCount++;
        else if (kind.includes('fallback')) stats.fallbackCount++;
        else if (kind === 'missing') stats.missingCount++;
    }

    function finalizeImageSourceStats(stats) {
        if (!stats) return null;
        if (stats.originalCount > 0 && stats.thumbCount === 0 && stats.fallbackCount === 0) stats.preferred = 'original';
        else if (stats.thumbCount > 0 && stats.originalCount === 0 && stats.fallbackCount === 0) stats.preferred = 'thumb';
        else stats.preferred = 'mixed';
        return stats;
    }

    function measureContactSheetLayout(sections, base) {
        const width = base.width;
        const cols = base.cols;
        const cellSize = base.cellSize;
        const gap = base.gap;
        const margin = base.margin;
        const headerHeight = base.headerHeight;
        const sectionSpacing = base.sectionSpacing;
        const metrics = contactSheetMetricsForCell(cellSize);
        const gridWidth = cols * cellSize + (cols - 1) * gap;
        const gridX = Math.max(margin, Math.floor((width - gridWidth) / 2));

        let currentY = margin;
        const sectionLayouts = [];
        for (const sec of sections || []) {
            const count = (sec.assets || []).length;
            if (count === 0) continue;
            const rows = Math.ceil(count / cols);
            const gridHeight = rows * cellSize + (rows - 1) * gap;
            sectionLayouts.push({
                sec,
                yHeader: currentY,
                yGrid: currentY + headerHeight + gap,
                rows,
                gridHeight,
                gridX,
                gridWidth,
            });
            currentY += headerHeight + gap + gridHeight + sectionSpacing;
        }

        const finalHeight = sectionLayouts.length
            ? Math.ceil(currentY - sectionSpacing + margin)
            : 0;

        return {
            ...base,
            ...metrics,
            gridWidth,
            gridX,
            sectionLayouts,
            finalHeight,
            overflow: finalHeight > base.maxHeight,
            longLabelCount: 0,
            totalAssets: countSectionAssets(sections),
        };
    }

    function calculateContactSheetLayout(sections, options = {}) {
        const totalAssets = countSectionAssets(sections);
        const width = clampNumber(options.width, 768, 1024, 1024);
        const maxHeight = clampNumber(options.maxHeight, 1024, 4096, getContactSheetHeightBudget());
        const margin = 12;
        const gap = totalAssets <= 4 ? 10 : 8;
        const headerHeight = 36;
        const sectionSpacing = 24;
        const minCellSize = 144;
        const maxCols = 6;
        const preset = chooseContactSheetPreset(totalAssets);

        let cols = Math.min(maxCols, Math.max(1, preset.cols));
        let cellSize = preset.cellSize;
        let layout = null;

        for (let attempt = 0; attempt < 48; attempt++) {
            const maxCellForCols = Math.floor((width - 2 * margin - gap * (cols - 1)) / cols);
            cellSize = Math.max(minCellSize, Math.min(cellSize, maxCellForCols));
            layout = measureContactSheetLayout(sections, {
                version: COLLAGE_LAYOUT_VERSION,
                width,
                maxHeight,
                cols,
                cellSize,
                minCellSize,
                maxCols,
                gap,
                margin,
                headerHeight,
                sectionSpacing,
            });

            if (!layout.overflow) break;
            if (cols < maxCols) {
                cols += 1;
                // Keep thumbnails large enough, but never larger than the new column budget.
                cellSize = Math.min(cellSize, Math.floor((width - 2 * margin - gap * (cols - 1)) / cols));
            } else if (cellSize > minCellSize) {
                cellSize = Math.max(minCellSize, cellSize - 8);
            } else {
                break;
            }
        }

        if (layout?.overflow) {
            console.warn('[VP Gallery] Contact sheet exceeds soft height budget', {
                finalHeight: layout.finalHeight,
                maxHeight: layout.maxHeight,
                totalAssets,
            });
        }
        return layout;
    }

    function buildCollageSignature(sections, layout) {
        const payload = {
            layout: {
                version: COLLAGE_LAYOUT_VERSION,
                width: layout?.width || 1024,
                maxHeight: layout?.maxHeight || getContactSheetHeightBudget(),
                cols: layout?.cols || null,
                cellSize: layout?.cellSize || null,
            },
            sections: (sections || []).map(sec => ({
                tabId: sec.tabId || null,
                tabName: sec.tabName || '',
                assets: (sec.assets || []).map(a => ({
                    tag: a.tag,
                    filename: a.filename || a.path || a.tag,
                    size: a.blob?.size || 0,
                    mime: a.blob?.type || a.mime || '',
                })),
            })),
        };
        return `${COLLAGE_LAYOUT_VERSION}:${hashString(JSON.stringify(payload))}`;
    }

    function collectCollagePlan() {
        const gd = S.galleryData;
        if (!gd) return { ok: false, reason: 'Нет данных галереи' };

        let markedTabs = (gd.tabs || []).filter(t => t.markedForCollage === true);

        // Fallback: if no tabs are marked, use the currently active tab (if it's not effects).
        if (markedTabs.length === 0) {
            const activeTabId = gd.activeTabId;
            if (activeTabId && activeTabId !== 'effects') {
                const activeTab = (gd.tabs || []).find(t => t.id === activeTabId);
                if (activeTab) markedTabs = [activeTab];
            }
        }

        if (markedTabs.length === 0) {
            return { ok: false, reason: 'Нет выбранных вкладок для Gallery View!' };
        }

        const allAssets = Array.from(S.gallery.values());
        const sections = [];
        let totalAssetsCount = 0;

        for (const tab of markedTabs) {
            const tabAssets = allAssets.filter(a => a.tabId === tab.id && a.tag !== COLLAGE_TAG);
            if (tabAssets.length > 0) {
                sections.push({
                    tabId: tab.id,
                    tabName: tab.name,
                    assets: tabAssets,
                });
                totalAssetsCount += tabAssets.length;
            }
        }

        if (totalAssetsCount === 0) {
            return { ok: false, reason: 'В выбранных вкладках нет ассетов для объединения!' };
        }

        const layout = calculateContactSheetLayout(sections, { width: 1024 });
        const signature = buildCollageSignature(sections, layout);
        return { ok: true, markedTabs, sections, totalAssetsCount, layout, signature };
    }

    function createCollageMeta(plan, blob) {
        const layout = plan.layout || {};
        return {
            kind: 'contact-sheet',
            layoutVersion: COLLAGE_LAYOUT_VERSION,
            signature: plan.signature,
            generatedAt: Date.now(),
            sectionCount: plan.sections.length,
            assetsCount: plan.totalAssetsCount,
            byteSize: blob?.size || 0,
            mime: blob?.type || 'image/jpeg',
            canvas: {
                width: layout.width || 1024,
                height: layout.finalHeight || null,
                maxHeight: layout.maxHeight || null,
                overflow: !!layout.overflow,
            },
            grid: {
                cols: layout.cols || null,
                cellSize: layout.cellSize || null,
                barHeight: layout.barHeight || null,
                labelFontSize: layout.labelFontSize || null,
                longLabelCount: layout.longLabelCount || 0,
            },
            imageSources: layout.imageSourceStats || null,
            tabs: plan.sections.map(sec => ({
                id: sec.tabId || null,
                name: sec.tabName || '',
                count: sec.assets.length,
                assetTags: sec.assets.map(a => a.tag),
            })),
        };
    }

    function isExistingCollageFresh(signature) {
        const existing = S.gallery.get(COLLAGE_TAG);
        return !!(existing && existing.blob && existing.collageMeta?.signature === signature);
    }

    function ensureContactSheetCoverLabel() {
        const current = String(S.coverLabel || '').trim();
        const key = current.toLowerCase();
        if (!current || key === 'cover' || key === 'contact sheet') S.coverLabel = 'Gallery View';
        // Keep custom labels and the default Gallery View label intact.
        if (DB) DB.setCoverLabel(S.coverLabel || 'Gallery View');
        return S.coverLabel;
    }

    function revokeAssetObjectUrls(asset) {
        if (!asset) return;
        if (asset.url) URL.revokeObjectURL(asset.url);
        if (asset.thumbUrl) URL.revokeObjectURL(asset.thumbUrl);
    }

    function refreshCollageUi(updateProjector = true) {
        renderGalleryGrid();
        updateGalleryFooter();
        updateGalleryButton();
        if (updateProjector && VP.updateProjectorUI) VP.updateProjectorUI();
    }

    let _visualInventoryRefreshTimer = null;
    let _visualInventoryDirtyReasons = new Set();

    function hasActiveVisualInventory() {
        return !!(S.coverTag === COLLAGE_TAG && S.gallery.has(COLLAGE_TAG));
    }

    function markVisualInventoryDirty(reason = 'asset-or-tab-changed', opts = {}) {
        if (!hasActiveVisualInventory()) return false;
        _visualInventoryDirtyReasons.add(reason);
        if (!S.visualInventoryDirty || typeof S.visualInventoryDirty !== 'object') S.visualInventoryDirty = {};
        S.visualInventoryDirty.active = true;
        S.visualInventoryDirty.reason = [..._visualInventoryDirtyReasons].join(',');
        S.visualInventoryDirty.updatedAt = Date.now();

        const delay = Math.max(150, Math.min(5000, Number(opts.delayMs ?? 900) || 900));
        clearTimeout(_visualInventoryRefreshTimer);
        _visualInventoryRefreshTimer = setTimeout(() => {
            const reasons = [..._visualInventoryDirtyReasons];
            _visualInventoryDirtyReasons.clear();
            S.visualInventoryDirty.active = false;
            if (!hasActiveVisualInventory()) return;
            console.log('[VP Gallery] Auto-refreshing visual inventory:', reasons.join(', '));
            showToast('Обновляю visual inventory…', 'info');
            generateCollageFromMarkedTabs({ reason: `auto-refresh:${reasons.join('+')}` })
                .catch(err => console.warn('[VP Gallery] visual inventory auto-refresh failed:', err));
        }, delay);
        return true;
    }

    const CONTACT_SHEET_WORKER_TIMEOUT_MS = 60_000;

    function canUseContactSheetWorker(sections, layout) {
        if (!window.Worker || !layout) return false;
        if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return false;
        if (!Array.isArray(sections) || sections.length === 0) return false;
        // Worker path currently uses original Blob sources. If any asset lacks a
        // Blob (rare legacy/import edge), main-thread fallback can still use URL/base64.
        return sections.every(sec => (sec.assets || []).every(asset =>
            asset?.blob && typeof asset.blob.arrayBuffer === 'function'
        ));
    }

    function serializeContactSheetSectionsForWorker(sections) {
        if (!canUseContactSheetWorker(sections, true)) return null;
        return (sections || []).map(sec => ({
            tabId: sec.tabId || null,
            tabName: sec.tabName || '',
            assets: (sec.assets || []).map(asset => ({
                tag: asset.tag,
                blob: asset.blob,
                mime: asset.blob?.type || asset.mime || 'image/jpeg',
            })),
        }));
    }

    function serializeContactSheetLayoutForWorker(layout) {
        return {
            version: layout.version,
            width: layout.width,
            maxHeight: layout.maxHeight,
            finalHeight: layout.finalHeight,
            cols: layout.cols,
            cellSize: layout.cellSize,
            minCellSize: layout.minCellSize,
            maxCols: layout.maxCols,
            gap: layout.gap,
            margin: layout.margin,
            headerHeight: layout.headerHeight,
            sectionSpacing: layout.sectionSpacing,
            barHeight: layout.barHeight,
            labelFontSize: layout.labelFontSize,
            labelMinFontSize: layout.labelMinFontSize,
            imagePadding: layout.imagePadding,
            totalAssets: layout.totalAssets,
        };
    }

    function getContactSheetWorkerUrl() {
        const script = document.querySelector('script[src*="projector-gallery.js"]');
        if (script?.src) return new URL('workers/contact-sheet-worker.js', script.src).href;
        return 'js/workers/contact-sheet-worker.js';
    }

    async function buildContactSheetInWorker(sections, layout) {
        if (!canUseContactSheetWorker(sections, layout)) return null;
        const workerSections = serializeContactSheetSectionsForWorker(sections);
        if (!workerSections) return null;

        const id = `contact_sheet_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        const workerUrl = getContactSheetWorkerUrl();

        return await new Promise((resolve, reject) => {
            let worker = null;
            let settled = false;
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                try { worker?.terminate(); } catch {}
                reject(new Error('Contact sheet worker timeout'));
            }, CONTACT_SHEET_WORKER_TIMEOUT_MS);

            const cleanup = () => {
                clearTimeout(timer);
                try { worker?.terminate(); } catch {}
            };

            try {
                worker = new Worker(workerUrl);
            } catch (err) {
                cleanup();
                reject(err);
                return;
            }

            worker.onmessage = (event) => {
                const msg = event.data || {};
                if (msg.id !== id) return;
                if (settled) return;
                settled = true;
                cleanup();
                if (!msg.ok || !msg.blob) {
                    reject(new Error(msg.error || 'Contact sheet worker failed'));
                    return;
                }
                if (msg.stats) {
                    const longLabelCount = Number(msg.stats.longLabelCount || 0);
                    layout.longLabelCount = longLabelCount;
                    layout.imageSourceStats = {
                        preferred: msg.stats.preferred || 'original',
                        originalCount: Number(msg.stats.originalCount || 0),
                        thumbCount: Number(msg.stats.thumbCount || 0),
                        fallbackCount: Number(msg.stats.fallbackCount || 0),
                        missingCount: Number(msg.stats.missingCount || 0),
                    };
                }
                resolve(msg.blob);
            };

            worker.onerror = (event) => {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error(event.message || 'Contact sheet worker error'));
            };

            worker.postMessage({
                id,
                type: 'build-contact-sheet',
                sections: workerSections,
                layout: serializeContactSheetLayoutForWorker(layout),
                quality: 0.90,
            });
        });
    }

    /**
     * Generates a Contact Sheet (collage) from a map of categories/tabs of assets.
     * @param {Array<{tabName: string, assets: Array}>} sections - Group of assets to draw per section
     * @param {number} size - width of the canvas (default 1024)
     * @returns {Promise<Blob>} A promise resolving to a Blob (image/jpeg)
     */
    async function buildContactSheet(sections, size = 1024, layoutOverride = null) {
        if (!sections || sections.length === 0) return null;

        const layout = layoutOverride || calculateContactSheetLayout(sections, { width: size });
        if (!layout || layout.finalHeight <= 0) return null;

        try {
            const workerBlob = await buildContactSheetInWorker(sections, layout);
            if (workerBlob) {
                console.log('[VP Gallery] Contact sheet built in worker', layout.imageSourceStats || {});
                return workerBlob;
            }
        } catch (err) {
            console.warn('[VP Gallery] Contact sheet worker unavailable; falling back to main thread:', err?.message || err);
        }

        const {
            width,
            finalHeight,
            cols,
            cellSize,
            gap,
            margin,
            headerHeight,
            barHeight,
            labelFontSize,
            labelMinFontSize,
            imagePadding,
            sectionLayouts,
        } = layout;

        // 1. Create canvas
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = finalHeight;
        const ctx = canvas.getContext('2d');

        // Draw solid dark background
        ctx.fillStyle = '#050509';
        ctx.fillRect(0, 0, width, finalHeight);

        // 2. Preload all images
        const loadImage = (src) => new Promise(res => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => res(img);
            img.onerror = () => res(null);
            img.src = src;
        });

        const loadedImages = new Map();
        const preloadPromises = [];
        const sourceStats = makeImageSourceStats();

        for (const sec of sections) {
            for (const asset of sec.assets || []) {
                const { src: imgSrc, createdUrl, sourceKind } = selectContactSheetImageSource(asset, layout);
                updateImageSourceStats(sourceStats, sourceKind);
                if (imgSrc) {
                    preloadPromises.push((async () => {
                        const img = await loadImage(imgSrc);
                        if (img) loadedImages.set(asset.tag, img);
                        if (createdUrl) URL.revokeObjectURL(createdUrl);
                    })());
                }
            }
        }

        await Promise.all(preloadPromises);
        layout.imageSourceStats = finalizeImageSourceStats(sourceStats);

        const rectForCover = (img, boxW, boxH) => {
            const ratio = Math.max(boxW / img.width, boxH / img.height);
            const w = img.width * ratio;
            const h = img.height * ratio;
            return { w, h, dx: (boxW - w) / 2, dy: (boxH - h) / 2 };
        };

        const rectForContain = (img, boxW, boxH) => {
            const ratio = Math.min(boxW / img.width, boxH / img.height);
            const w = img.width * ratio;
            const h = img.height * ratio;
            return { w, h, dx: (boxW - w) / 2, dy: (boxH - h) / 2 };
        };

        function drawSmartImage(img, x, y, w, h) {
            const imageH = Math.max(1, h - barHeight);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, imageH);
            ctx.clip();

            // Dark base. If the source exists, draw a dim cover background so
            // portrait/landscape assets still feel visually grounded in a square card.
            ctx.fillStyle = '#11111b';
            ctx.fillRect(x, y, w, imageH);

            if (img) {
                const bg = rectForCover(img, w, imageH);
                ctx.globalAlpha = 0.28;
                ctx.drawImage(img, x + bg.dx, y + bg.dy, bg.w, bg.h);
                ctx.globalAlpha = 1;
                ctx.fillStyle = 'rgba(0,0,0,0.28)';
                ctx.fillRect(x, y, w, imageH);

                const pad = imagePadding;
                const fgBoxW = Math.max(1, w - pad * 2);
                const fgBoxH = Math.max(1, imageH - pad * 2);
                const fg = rectForContain(img, fgBoxW, fgBoxH);
                const fx = x + pad + fg.dx;
                const fy = y + pad + fg.dy;

                // Subtle matte behind transparent PNGs / narrow portraits.
                ctx.fillStyle = 'rgba(0,0,0,0.22)';
                ctx.fillRect(fx - 2, fy - 2, fg.w + 4, fg.h + 4);
                ctx.drawImage(img, fx, fy, fg.w, fg.h);
            }

            ctx.restore();
        }

        function drawFittedLabel(label, x, y, w, h) {
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
            ctx.fillRect(x, y, w, h);
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();

            const maxTextWidth = Math.max(1, w - 8);
            let fontSize = labelFontSize;
            while (fontSize > labelMinFontSize) {
                ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
                if (ctx.measureText(label).width <= maxTextWidth) break;
                fontSize -= 1;
            }
            ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

            const fits = ctx.measureText(label).width <= maxTextWidth;
            if (!fits) layout.longLabelCount = (layout.longLabelCount || 0) + 1;

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.restore();
            return fits;
        }

        // 3. Draw each section
        for (const sectionLayout of sectionLayouts) {
            const { sec, yHeader, yGrid, gridX } = sectionLayout;

            // Draw header bar
            ctx.fillStyle = '#111122';
            ctx.fillRect(margin, yHeader, width - 2 * margin, headerHeight);

            // Left accent line
            ctx.fillStyle = '#6c5fa6';
            ctx.fillRect(margin, yHeader, 4, headerHeight);

            // Border around header bar
            ctx.strokeStyle = '#383860';
            ctx.lineWidth = 1;
            ctx.strokeRect(margin, yHeader, width - 2 * margin, headerHeight);

            // Header text
            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 15px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const headerText = `TAB: ${String(sec.tabName || '').toUpperCase()} (${(sec.assets || []).length} assets)`;
            ctx.fillText(headerText, margin + 16, yHeader + headerHeight / 2, width - margin * 2 - 26);

            // Draw assets grid
            for (let i = 0; i < (sec.assets || []).length; i++) {
                const asset = sec.assets[i];
                const col = i % cols;
                const row = Math.floor(i / cols);

                const x = gridX + col * (cellSize + gap);
                const y = yGrid + row * (cellSize + gap);

                // Draw card background and clipped smart-fit image.
                ctx.fillStyle = '#1e1e2e';
                ctx.fillRect(x, y, cellSize, cellSize);
                const img = loadedImages.get(asset.tag);
                drawSmartImage(img, x, y, cellSize, cellSize);

                // Draw OCR bottom label bar with exact command token.
                drawFittedLabel(`[IMG:${asset.tag}]`, x, y + cellSize - barHeight, cellSize, barHeight);

                // Border around card cell
                ctx.strokeStyle = '#383860';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, cellSize, cellSize);
            }
        }

        if (layout.longLabelCount > 0) {
            console.warn('[VP Gallery] Some contact-sheet labels had to shrink below preferred size. Shorter tags are recommended.', {
                longLabelCount: layout.longLabelCount,
                totalAssets: layout.totalAssets,
            });
        }

        // Return as Blob (JPEG for widest compatibility with local models/servers)
        return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.90));
    }

    /**
     * Gathers all tabs marked for collage (or falls back to active tab if none),
     * creates a dynamic-height grid, renders the contact sheet,
     * saves it as the special asset '__SCENERY_COLLAGE__', and sets it as the scenery cover.
     */
    async function generateCollageFromMarkedTabs(options = {}) {
        // The button event may be passed as the first argument by addEventListener.
        if (!options || typeof options !== 'object' || typeof options.preventDefault === 'function') options = {};
        const force = !!options.force;
        const reason = options.reason || 'manual';

        const plan = collectCollagePlan();
        console.log('[VP Gallery] Contact sheet requested', { reason, force, signature: plan.signature || null });
        if (!plan.ok) {
            showToast(plan.reason, 'warning');
            return null;
        }

        if (_collageGeneration.running) {
            if (plan.signature !== _collageGeneration.activeSignature) {
                _collageGeneration.queued = true;
                showToast('Gallery View уже собирается — новая версия поставлена в очередь.', 'info');
            } else {
                showToast('Gallery View уже собирается…', 'info');
            }
            return _collageGeneration.promise;
        }

        if (!force && isExistingCollageFresh(plan.signature)) {
            const existing = S.gallery.get(COLLAGE_TAG);
            ensureContactSheetCoverLabel();
            applyCover(COLLAGE_TAG, { showOnProjector: true });
            refreshCollageUi(false);
            showToast('Gallery View уже актуален — использую готовую версию.', 'info');
            return existing;
        }

        const seq = ++_collageGeneration.seq;
        _collageGeneration.running = true;
        _collageGeneration.queued = false;
        _collageGeneration.activeSignature = plan.signature;

        const task = (async () => {
            showToast(`Собираю Gallery View: ${plan.totalAssetsCount} ассет(ов), ${plan.sections.length} таб(ов)…`, 'info');

            try {
                const blob = await buildContactSheet(plan.sections, plan.layout?.width || 1024, plan.layout);
                if (!blob) {
                    showToast('Не удалось собрать Gallery View', 'error');
                    return null;
                }

                // If the user/model changed the selected tabs while canvas work was running,
                // never apply a stale contact sheet. Queue a fresh pass instead.
                const latestPlan = collectCollagePlan();
                if (!latestPlan.ok || latestPlan.signature !== plan.signature) {
                    _collageGeneration.queued = true;
                    showToast('Данные Gallery View изменились во время сборки — пересоберу свежую версию.', 'info');
                    return null;
                }

                const existing = S.gallery.get(COLLAGE_TAG);
                const existingDescription = existing?.description || 'Automatic scenery assets collage';
                revokeAssetObjectUrls(existing);

                const url = URL.createObjectURL(blob);
                const thumbUrl = await generateThumbUrl(blob);
                const collageMeta = createCollageMeta(plan, blob);

                const collageAsset = {
                    tag: COLLAGE_TAG,
                    filename: COLLAGE_FILENAME,
                    path: COLLAGE_FILENAME,
                    blob,
                    url,
                    thumbUrl,
                    description: existingDescription,
                    source: 'generated',
                    hidden: false,
                    tabId: null, // system asset, not attached to any tab
                    collageMeta,
                };

                S.gallery.set(COLLAGE_TAG, collageAsset);
                persistAsset(collageAsset);

                ensureContactSheetCoverLabel();
                applyCover(COLLAGE_TAG, { showOnProjector: true });
                refreshCollageUi(false);

                console.log('[VP Gallery] Contact sheet generated', collageMeta);
                showToast(`Gallery View обновлён: ${plan.totalAssetsCount} ассет(ов).`, 'success');
                return collageAsset;
            } catch (err) {
                console.error('[VP Gallery] Collage generation failed:', err);
                showToast('Ошибка при сборке Gallery View', 'error');
                return null;
            } finally {
                // Only the latest running task owns the lifecycle flags.
                if (_collageGeneration.seq === seq) {
                    const runQueued = _collageGeneration.queued;
                    _collageGeneration.running = false;
                    _collageGeneration.queued = false;
                    _collageGeneration.promise = null;
                    _collageGeneration.activeSignature = null;
                    if (runQueued) {
                        setTimeout(() => {
                            generateCollageFromMarkedTabs({ reason: 'queued' }).catch(err =>
                                console.warn('[VP Gallery] queued collage generation failed:', err)
                            );
                        }, 0);
                    }
                }
            }
        })();

        _collageGeneration.promise = task;
        return task;
    }

    /**
     * Context menu for the Collage button. Offers options to generate, rename, change description,
     * clear all marked tabs, and delete/unset.
     */
    function showCollageContextMenu(e) {
        e.preventDefault();
        e.stopPropagation();
        if (activeContextMenuCleanup) activeContextMenuCleanup();

        const menu = document.createElement('div');
        menu.className = 'vp-context-menu';
        menu.style.cssText = `position:fixed; left:${e.clientX}px; top:${e.clientY}px; background:var(--bg-tertiary,#252540); border:1px solid var(--border,#383860); border-radius:6px; z-index:10002; box-shadow:0 4px 16px rgba(0,0,0,0.5); overflow:hidden; min-width:215px; font-family:system-ui,sans-serif;`;

        const mkItem = (text, color, onClick) => {
            const d = document.createElement('div');
            d.textContent = text;
            d.style.cssText = `padding:8px 12px; cursor:pointer; font-size:13px; color:${color || 'var(--text-primary,#cdd6f4)'};`;
            d.addEventListener('mouseenter', () => d.style.background = 'var(--accent,#6c5fa6)');
            d.addEventListener('mouseleave', () => d.style.background = '');
            d.addEventListener('click', () => { cleanup(); onClick(); });
            return d;
        };

        // 1. Generate collage
        menu.appendChild(mkItem('🖼️ Собрать Gallery View', null, generateCollageFromMarkedTabs));

        // 2. Change Gallery View title
        menu.appendChild(mkItem('✏️ Название Gallery View', null, async () => {
            const nl = await showPrompt({
                title: 'Gallery View title',
                message: 'Короткое название текущей Gallery View.',
                value: S.coverLabel || 'Gallery View',
                placeholder: 'Emily emotions',
                confirmLabel: 'Save',
            });
            if (nl !== null) {
                S.coverLabel = nl.trim() || 'Gallery View';
                if (DB) DB.setCoverLabel(S.coverLabel);
                renderGalleryGrid();
                if (VP.updateProjectorUI) VP.updateProjectorUI();
                showToast('Gallery View title updated', 'success');
            }
        }));

        // 3. Change Gallery View note
        menu.appendChild(mkItem('📝 Заметка Gallery View', null, async () => {
            const collage = S.gallery.get('__SCENERY_COLLAGE__');
            if (!collage) { showToast('Сначала соберите Gallery View!', 'warning'); return; }
            const desc = await showPrompt({
                title: 'Gallery View note',
                message: 'Короткая заметка будет видна модели рядом с картинкой Gallery View.',
                value: collage.description || '',
                placeholder: 'Emily emotions / current location / scene props...',
                confirmLabel: 'Save',
                multiline: true,
            });
            if (desc !== null) {
                collage.description = desc.trim();
                persistAsset(collage);
                renderGalleryGrid();
                if (VP.updateProjectorUI) VP.updateProjectorUI();
                showToast('Gallery View note updated', 'success');
            }
        }));

        // 4. Clear collage marks from all tabs
        menu.appendChild(mkItem('🧹 Очистить пометки табов', null, () => {
            if (S.galleryData && S.galleryData.tabs) {
                S.galleryData.tabs.forEach(t => t.markedForCollage = false);
                TabsManager.renderSidebar();
                persistGalleryData();
                showToast('Пометки табов очищены', 'info');
            }
        }));

        // 5. Delete Gallery View
        const hasCollage = S.gallery.has('__SCENERY_COLLAGE__');
        if (hasCollage || S.coverTag) {
            const isCollageCover = (S.coverTag === '__SCENERY_COLLAGE__');
            menu.appendChild(mkItem('❌ Удалить Gallery View', 'var(--error,#e05555)', () => {
                if (isCollageCover) {
                    applyCover(null);
                }
                if (hasCollage) {
                    const collage = S.gallery.get('__SCENERY_COLLAGE__');
                    if (collage && collage.url) URL.revokeObjectURL(collage.url);
                    if (collage && collage.thumbUrl) URL.revokeObjectURL(collage.thumbUrl);
                    deleteAssets('__SCENERY_COLLAGE__');
                }
                renderGalleryGrid();
                updateGalleryFooter();
                updateGalleryButton();
                if (VP.updateProjectorUI) VP.updateProjectorUI();
                showToast('Gallery View удалён', 'success');
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
            if (activeContextMenuCleanup === cleanup) activeContextMenuCleanup = null;
        };
        activeContextMenuCleanup = cleanup;
        setTimeout(() => {
            if (activeContextMenuCleanup === cleanup) document.addEventListener('mousedown', close);
        }, 0);
    }

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
                VP.setCurrent?.(S.preparedTag, 'prepared', true);
                S.playback.cursor = S.playback.messages.length === 0 ? 0 : -1;
            } else {
                VP.updateProjectorUI?.();
            }
            VP.persistProjectorState?.();
            refreshGalleryPanelUI();
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
        if (shouldShowOnProjector && VP.setCurrent) {
            VP.setCurrent(tag, 'cover', true);
        } else {
            VP.updateProjectorUI?.();
        }
        VP.persistProjectorState?.();
        refreshGalleryPanelUI();
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

            // Source icon
            if (asset.source && asset.source !== 'user') {
                const srcIcon = document.createElement('div');
                srcIcon.style.cssText = `position:absolute; top:${isCoverAsset ? '22px' : '3px'}; left:3px; background:rgba(0,0,0,0.7); color:white; font-size:10px; padding:2px 4px; border-radius:3px; pointer-events:none;`;
                srcIcon.textContent = ({ pasted: '📋', imported: '📥', generated: '✨' })[asset.source] || '?';
                srcIcon.title = `Source: ${asset.source}`;
                item.appendChild(srcIcon);
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
                VP.setCurrent(tag);
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
                    const commit = () => { renameTag(tag, input.value); renderGalleryGrid(); if (VP.updateProjectorUI) VP.updateProjectorUI(); };
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
                        if (VP.updateProjectorUI) VP.updateProjectorUI();
                        showToast('Asset description updated', 'success');
                    }
                }));

                // 3. Re-tag with AI
                menu.appendChild(mkItem('✨ Re-tag with AI', null, () => VP.gallery.Tagger?.retagSingle(tag)));

                // 4. Delete
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
            if (cur && S.gallery.has(cur)) VP.setCurrent(cur, 'replay', true);
            const projectorState = await DB.getProjectorState?.();
            if (projectorState) VP.applyProjectorSnapshot?.(projectorState);
        }
        VP.updateProjectorUI?.();
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
        syncSettingsUI,
        // domain objects
        TabsManager, Tagger: null,
        // asset ops (used by engine drag-drop / paste shortcuts)
        addImageFromBlob, deleteAssets, setAssetVisibility, applyCover,
        exportGallery, importGallery, loadGalleryFolder, loadSingleFile, pasteFromClipboard,
        maybeOfferAutoTag: null,
        // collage/contact-sheet ops
        generateCollageFromMarkedTabs, buildContactSheet, collectCollagePlan, calculateContactSheetLayout,
        // persistence
        hydrateFromDB, persistAsset, persistAssetsBatch, persistGalleryData, persistConfig,
    };

    // ── Trigger boot (after the engine's own DOMContentLoaded fires). ──
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootGallery().catch(err => console.error('[VP Gallery] boot failed:', err)); });
    } else {
        bootGallery().catch(err => console.error('[VP Gallery] boot failed:', err));
    }

})();
