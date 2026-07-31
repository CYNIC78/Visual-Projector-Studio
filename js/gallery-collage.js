// ╔══════════════════════════════════════════════════════════════════╗
// ║  gallery-collage.js                                              ║
// ║  Visual Projector — Gallery satellite: CONTACT SHEET / COLLAGE    ║
// ║                                                                  ║
// ║  Owns: contact-sheet layout solver, canvas rendering + Web  ║
// ║        Worker offloading, collage generation lifecycle, the       ║
// ║        collage ("Gallery View") context menu, auto-refresh        ║
// ║        of the visual inventory.                                   ║
// ║                                                                  ║
// ║  Extracted from projector-gallery.js (v01 refactor) — the code    ║
// ║  below is byte-identical to the original except the rewiring      ║
// ║  documented in CHANGELOG.md.                                      ║
// ║                                                                  ║
// ║  Load order: visual-projector.js → gallery-collage.js             ║
// ║              → projector-gallery.js                               ║
// ║  (registers window.VP_GALLERY_COLLAGE; the gallery then calls     ║
// ║   .init(deps) to inject host functions and receives the API)      ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP GalleryCollage] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE gallery-collage.js.'
        );
        return;
    }

    const S  = VP.state;          // shared state (by reference)

    // FSM audit (2026-07-31): shared "effectively locked" check for the
    // collage domain. A tab hidden by its own lock or by a locked parent
    // category must never render into the LLM-visible collage (and must not
    // be counted in the pill/popup section lists) — the manifest already
    // hides such tags, the image must not leak them back in.
    function _collageTabEffectivelyLocked(tab) {
        if (!tab) return true;
        if (tab.state === 'locked') return true;
        const gd = S.galleryData || {};
        const cat = (gd.categories || []).find(c => c.id === tab.categoryId);
        return !!cat && cat.state === 'locked';
    }
    const DB = window.VP_DB;      // storage layer (vp-storage.js)

    const showToast         = VP.showToast         || ((m) => console.warn('[toast]', m));
    const showPrompt        = VP.showPrompt        || ((o) => Promise.resolve(window.prompt((o && (o.message || o.title)) || '', o?.value || '')));

    // ── HOST DEPENDENCIES (injected by projector-gallery.js via init) ───────
    // Proxies keep the extracted body verbatim; _deps is assigned once at
    // gallery module-eval time, long before any of these can fire.
    let _deps = null;
    const applyCover = (...a) => _deps.applyCover(...a);
    const deleteAssets = (...a) => _deps.deleteAssets(...a);
    const generateThumbUrl = (...a) => _deps.generateThumbUrl(...a);
    const persistAsset = (...a) => _deps.persistAsset(...a);
    const persistGalleryData = (...a) => _deps.persistGalleryData(...a);
    const renderGalleryGrid = (...a) => _deps.renderGalleryGrid(...a);
    const updateGalleryFooter = (...a) => _deps.updateGalleryFooter(...a);
    const updateGalleryButton = (...a) => _deps.updateGalleryButton(...a);
    const requestProjectorUiUpdate = (...a) => _deps.requestProjectorUiUpdate(...a);
    const getTabsManager = () => _deps.getTabsManager();
    const getActiveCtxMenuCleanup = () => _deps.getActiveContextMenuCleanup();
    const setActiveCtxMenuCleanup = (fn) => _deps.setActiveContextMenuCleanup(fn);

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

    function collectCollagePlan(opts = {}) {
        // v21: the active-tab fallback is for EXPLICIT manual builds only (the
        // 🖼️ button). Auto-refresh must not use it — otherwise unmarking the
        // last marked tab rebuilt the plan from that very active tab, the
        // signature matched and the collage stubbornly "stayed fresh" (owner
        // bug report 2026-07-29).
        const allowActiveTabFallback = opts.allowActiveTabFallback !== false;
        const gd = S.galleryData;
        if (!gd) return { ok: false, reason: 'Нет данных галереи' };

        let markedTabs = (gd.tabs || []).filter(t => t.markedForCollage === true && !_collageTabEffectivelyLocked(t));

        // Fallback: if no tabs are marked, use the currently active tab (if it's not effects).
        if (markedTabs.length === 0 && allowActiveTabFallback) {
            const activeTabId = gd.activeTabId;
            if (activeTabId && activeTabId !== 'effects') {
                const activeTab = (gd.tabs || []).find(t => t.id === activeTabId && !_collageTabEffectivelyLocked(t));
                if (activeTab) markedTabs = [activeTab];
            }
        }

        if (markedTabs.length === 0) {
            return { ok: false, reason: 'Нет выбранных вкладок для Gallery View!' };
        }

        const allAssets = Array.from(S.gallery.values());
        const cats = gd.categories || [];
        const sections = [];
        let totalAssetsCount = 0;

        for (const tab of markedTabs) {
            const tabAssets = allAssets.filter(a => a.tabId === tab.id && a.tag !== COLLAGE_TAG);
            if (tabAssets.length > 0) {
                // v22: headers always carry the pack name ("CAT: X › TAB: Y")
                // — the model sees which corridor the scene lives in, matching
                // the manifest tree. Uncategorized tabs keep the bare TAB form.
                const cat = cats.find(c => c.id === tab.categoryId);
                sections.push({
                    tabId: tab.id,
                    tabName: tab.name,
                    categoryName: (cat && cat.name) || '',
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
        if (updateProjector) requestProjectorUiUpdate('gallery')
        updateCollagePill();
    }

    // ═══ v18: Gallery View pill — deck indicator + click-popup ═══
    // Pattern mirrors the v15 gaze chip: lazy-mounted into State.ui.vpWindow
    // before #vp-player-bar, degrades silently when the window host is absent
    // (or the flag is off). The pill mirrors the CURRENT contact sheet —
    // "на экране" when the sheet IS the projector cover, "в кулуарах" when it
    // waits backstage. Click opens a popup with the sheet itself: see the
    // showcase exactly as the model sees it in her context.
    // v19: the pill sheds its text (all info moves to the tooltip) and becomes
    // an inline toggle ICON inside the existing player bar — vertical space is
    // expensive, no extra row under the screen. .open marks the popup state.
    const COLLAGE_PILL_CSS = `
#vp-collage-pill{display:none;align-items:center;justify-content:center;flex:0 0 auto;padding:1px 7px;margin:0 6px 0 0;font-size:11px;line-height:1.5;color:#8f9bbd;background:rgba(20,20,32,0.55);border:1px solid rgba(255,255,255,0.10);border-radius:999px;cursor:pointer;user-select:none;}
#vp-collage-pill.on{display:inline-flex;}
#vp-collage-pill:hover{border-color:rgba(240,180,80,0.55);color:#cdd6f4;}
#vp-collage-pill .vp-pill-glyph{filter:grayscale(.5);}
#vp-collage-pill.live{color:#f0d7a8;border-color:rgba(240,180,80,0.45);}
#vp-collage-pill.live .vp-pill-glyph{filter:none;}
#vp-collage-pill.open{background:rgba(240,180,80,0.16);border-color:rgba(240,180,80,0.65);color:#f0d7a8;}
#vp-collage-popup{position:absolute;left:0;right:0;top:0;bottom:0;z-index:60;display:flex;align-items:center;justify-content:center;padding:10px;box-sizing:border-box;background:rgba(10,10,18,0.72);backdrop-filter:blur(4px);}
#vp-collage-popup .vp-collage-popup-card{max-width:100%;max-height:100%;display:flex;flex-direction:column;align-items:center;gap:6px;}
#vp-collage-popup img{max-width:100%;max-height:calc(100% - 58px);object-fit:contain;border-radius:8px;border:1px solid rgba(255,255,255,0.14);box-shadow:0 12px 40px rgba(0,0,0,0.5);cursor:zoom-in;}
#vp-collage-popup.inspect{overflow:auto;align-items:flex-start;}
#vp-collage-popup.inspect .vp-collage-popup-card{max-height:none;}
#vp-collage-popup.inspect img{max-height:none;width:100%;cursor:zoom-out;}
#vp-collage-popup .vp-collage-popup-info{font-size:11px;color:#cdd6f4;text-align:center;line-height:1.5;max-width:90%;}
#vp-collage-popup .vp-collage-popup-hint{font-size:10px;color:#8f9bbd;text-align:center;}
#vp-collage-popup .vp-collage-popup-close{position:absolute;top:10px;right:12px;font-size:12px;color:#cdd6f4;background:rgba(20,20,32,0.7);border:1px solid rgba(255,255,255,0.14);border-radius:8px;padding:2px 8px;cursor:pointer;}
#vp-collage-popup .vp-collage-popup-close:hover{border-color:rgba(240,180,80,0.55);}
`;

    let _collagePopupEl = null;

    function _pillHost() {
        return (typeof S !== 'undefined' && S && S.ui && S.ui.vpWindow) ? S.ui.vpWindow : null;
    }

    function ensureCollagePill() {
        const host = _pillHost();
        if (!host || typeof document === 'undefined') return null;
        try {
            const head = document.head || host;
            if (!head.querySelector('#vp-collage-pill-style')) {
                const style = document.createElement('style');
                style.id = 'vp-collage-pill-style';
                style.textContent = COLLAGE_PILL_CSS;
                head.appendChild(style);
            }
            let pill = host.querySelector('#vp-collage-pill');
            if (!pill) {
                pill = document.createElement('div');
                pill.id = 'vp-collage-pill';
                pill.setAttribute('role', 'button');
                const glyph = document.createElement('span');
                glyph.className = 'vp-pill-glyph';
                glyph.textContent = '🖼️';
                pill.appendChild(glyph);
                pill.addEventListener('click', (e) => {
                    if (e && e.stopPropagation) e.stopPropagation();
                    toggleCollagePopup();
                });
                // v19: inline into the player bar, left of the sender/counter
                // (#vp-player-info) — no extra row under the screen. Fallback
                // (window without a bar): the old own-row mount, degraded.
                const playerBar = host.querySelector('#vp-player-bar');
                const playerInfo = playerBar ? playerBar.querySelector('#vp-player-info') : null;
                if (playerBar && playerInfo) playerBar.insertBefore(pill, playerInfo);
                else if (playerBar) playerBar.appendChild(pill);
                else host.appendChild(pill);
            }
            return pill;
        } catch (err) {
            console.warn('[VP Gallery] collage pill mount failed (degrading silently):', err);
            return null;
        }
    }

    function updateCollagePill() {
        const host = _pillHost();
        if (!host) return;
        try {
            const cfgEnabled = S?.config?.collagePill !== false;
            const collage = S?.gallery?.get?.(COLLAGE_TAG) || null;
            let pill = host.querySelector('#vp-collage-pill');
            if (!cfgEnabled || !collage) {
                closeCollagePopup();
                if (pill) { if (typeof pill.remove === 'function') pill.remove(); else pill.parentNode?.removeChild?.(pill); }
                return;
            }
            pill = ensureCollagePill();
            if (!pill) return;
            const meta = collage.collageMeta || {};
            const markedTabs = (S?.galleryData?.tabs || []).filter(t => t.markedForCollage && !_collageTabEffectivelyLocked(t));
            const sections = Number.isFinite(meta.sectionCount) ? meta.sectionCount : markedTabs.length;
            const assetsCount = Number.isFinite(meta.assetsCount) ? meta.assetsCount : null;
            const isLive = S?.coverTag === COLLAGE_TAG;
            pill.classList.toggle('on', true);
            pill.classList.toggle('live', isLive);
            pill.classList.toggle('open', !!_collagePopupEl);
            // v19: ALL info lives in the tooltip (the pill itself stays an icon).
            const allAssets = S?.gallery ? Array.from(S.gallery.values()) : [];
            const cats = (S?.galleryData?.categories) || [];
            const partNames = markedTabs.map(t => {
                const cat = cats.find(c => c.id === t.categoryId);
                return `${cat && cat.name ? cat.name + ' › ' : ''}${t.name} (${allAssets.filter(a => a.tabId === t.id && a.tag !== COLLAGE_TAG).length})`;
            });
            const when = meta.generatedAt ? new Date(meta.generatedAt).toLocaleTimeString() : null;
            pill.title = `Gallery View: ${sections} таб(ов)${assetsCount != null ? ' · ' + assetsCount + ' кадр(ов)' : ''}\n` +
                (isLive ? 'Витрина сейчас — кадр проектора.' : 'Витрина в кулуарах — на экране другой кадр.') +
                (partNames.length ? `\nСекции: ${partNames.join(' · ')}` : '') +
                (when ? `\nСобрана в ${when}` : '') +
                '\nКлик — показать/скрыть витрину глазами модели.';
        } catch (err) {
            console.warn('[VP Gallery] collage pill update failed (degrading silently):', err);
        }
    }

    function _syncPillOpen(on) {
        try {
            const pill = _pillHost()?.querySelector?.('#vp-collage-pill');
            if (pill) pill.classList.toggle('open', !!on);
        } catch { /* degrade */ }
    }

    function closeCollagePopup() {
        if (_collagePopupEl) {
            try { _collagePopupEl.remove?.(); } catch { /* degrade */ }
            _collagePopupEl = null;
        }
        _syncPillOpen(false);
    }

    function toggleCollagePopup() {
        if (_collagePopupEl) closeCollagePopup();
        else openCollagePopup();
    }

    function openCollagePopup() {
        const host = _pillHost();
        const collage = S?.gallery?.get?.(COLLAGE_TAG) || null;
        if (!host || !collage || typeof document === 'undefined') return;
        // v20: the popup fits the SCREEN box (#vp-screen) so it never covers
        // the deck/player-bar below; fallback — the whole window (legacy).
        const popupHost = host.querySelector('#vp-screen') || host;
        try {
            closeCollagePopup();
            const overlay = document.createElement('div');
            overlay.id = 'vp-collage-popup';
            overlay.setAttribute('role', 'dialog');
            overlay.addEventListener('click', (e) => {
                if (e && e.target !== overlay) return;
                closeCollagePopup();
            });

            const closeBtn = document.createElement('div');
            closeBtn.className = 'vp-collage-popup-close';
            closeBtn.textContent = '✕ закрыть';
            closeBtn.addEventListener('click', (e) => { if (e && e.stopPropagation) e.stopPropagation(); closeCollagePopup(); });
            overlay.appendChild(closeBtn);

            const card = document.createElement('div');
            card.className = 'vp-collage-popup-card';

            // v21: the sheet is fitted to the screen HEIGHT by default (the
            // collage is vertically dynamic); clicking the image toggles the
            // "inspect" mode — natural size with scroll inside the screen box.
            const src = collage.url || collage.thumbUrl || null;
            if (src) {
                const img = document.createElement('img');
                img.src = src;
                img.alt = 'Gallery View';
                img.title = 'Клик — натуральный размер с прокруткой / обратно во весь экран';
                img.addEventListener('click', (e) => {
                    if (e && e.stopPropagation) e.stopPropagation();
                    overlay.classList.toggle('inspect');
                });
                card.appendChild(img);
            }

            // Section list mirrors the CURRENT marks (fresh view of the showcase).
            const info = document.createElement('div');
            info.className = 'vp-collage-popup-info';
            const markedTabs = (S?.galleryData?.tabs || []).filter(t => t.markedForCollage && !_collageTabEffectivelyLocked(t));
            const allAssets = S?.gallery ? Array.from(S.gallery.values()) : [];
            const cats = (S?.galleryData?.categories) || [];
            const parts = markedTabs.map(t => {
                const n = allAssets.filter(a => a.tabId === t.id && a.tag !== COLLAGE_TAG).length;
                const cat = cats.find(c => c.id === t.categoryId);
                return `${cat && cat.name ? cat.name + ' › ' : ''}${t.name} (${n})`;
            });
            const when = collage.collageMeta?.generatedAt ? new Date(collage.collageMeta.generatedAt).toLocaleTimeString() : null;
            info.textContent = (parts.length ? `Витрина: ${parts.join(' · ')}` : 'Витрина без помеченных табов (собрана из активного таба).') +
                (when ? `\nСобрана в ${when}` : '');
            card.appendChild(info);

            const hint = document.createElement('div');
            hint.className = 'vp-collage-popup-hint';
            hint.textContent = 'Так эту витрину видит модель в своём контексте. Клик по картинке — прокрутка в натуральном размере; по фону или ✕ — закрыть.';
            card.appendChild(hint);

            overlay.appendChild(card);
            popupHost.appendChild(overlay);
            _collagePopupEl = overlay;
            _syncPillOpen(true);
        } catch (err) {
            console.warn('[VP Gallery] collage popup failed (degrading silently):', err);
            _collagePopupEl = null;
        }
    }


    let _visualInventoryRefreshTimer = null;
    let _visualInventoryDirtyReasons = new Set();

    function hasActiveVisualInventory() {
        return !!(S.coverTag === COLLAGE_TAG && S.gallery.has(COLLAGE_TAG));
    }

    // v21: the collage asset itself, regardless of cover state.
    function hasCollageAsset() {
        return !!(S.gallery && S.gallery.has(COLLAGE_TAG));
    }

    // v21: single point of collage disposal — used by the context menu AND by
    // auto-refresh when the last mark goes away (empty marks = no showcase).
    function deleteCollageAsset() {
        if (S.coverTag === COLLAGE_TAG) applyCover(null);
        const collage = S.gallery.get(COLLAGE_TAG);
        if (collage) {
            if (collage.url) URL.revokeObjectURL(collage.url);
            if (collage.thumbUrl) URL.revokeObjectURL(collage.thumbUrl);
            deleteAssets(COLLAGE_TAG);
        }
        renderGalleryGrid();
        updateGalleryFooter();
        updateGalleryButton();
        requestProjectorUiUpdate('gallery');
        updateCollagePill();
    }

    // v21: auto-refresh router. Empty marks = the showcase is honestly
    // dissolved; otherwise rebuild — applying to the projector ONLY when the
    // collage is already the cover (backstage refreshes stay backstage).
    function autoRefreshCollage(reasons) {
        const applyLive = hasActiveVisualInventory();
        const plan = collectCollagePlan({ allowActiveTabFallback: false });
        if (!plan.ok || !plan.sections || plan.sections.length === 0) {
            deleteCollageAsset();
            showToast('Gallery View расформирован: метки с табов сняты', 'info');
            return;
        }
        showToast('Обновляю visual inventory…', 'info');
        generateCollageFromMarkedTabs({
            reason: `auto-refresh:${reasons.join('+')}`,
            applyToProjector: applyLive,
            allowActiveTabFallback: false,
        }).catch(err => console.warn('[VP Gallery] visual inventory auto-refresh failed:', err));
    }

    function markVisualInventoryDirty(reason = 'asset-or-tab-changed', opts = {}) {
        // v21: arm whenever the collage asset EXISTS (not only when it is the
        // cover) — backstage refresh keeps the showcase and the pill fresh.
        if (!hasCollageAsset()) return false;
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
            if (!hasCollageAsset()) return;
            console.log('[VP Gallery] Auto-refreshing visual inventory:', reasons.join(', '));
            autoRefreshCollage(reasons);
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
            categoryName: sec.categoryName || '',
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
        const script = document.querySelector('script[src*="gallery-collage.js"], script[src*="projector-gallery.js"]');
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
            const catPart = sec.categoryName ? `CAT: ${String(sec.categoryName).toUpperCase()} › ` : '';
            const headerText = `${catPart}TAB: ${String(sec.tabName || '').toUpperCase()} (${(sec.assets || []).length} assets)`;
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
        // v21: backstage refreshes rebuild without stealing the screen; and
        // they must never fall back onto the active tab (see collectCollagePlan).
        const applyToProjector = options.applyToProjector !== false;
        const allowActiveTabFallback = options.allowActiveTabFallback !== false;

        const plan = collectCollagePlan({ allowActiveTabFallback });
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
            if (applyToProjector) applyCover(COLLAGE_TAG, { showOnProjector: true });
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
                if (applyToProjector) applyCover(COLLAGE_TAG, { showOnProjector: true });
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
                            generateCollageFromMarkedTabs({ reason: 'queued', applyToProjector, allowActiveTabFallback }).catch(err =>
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
        const prevCtxMenuCleanup = getActiveCtxMenuCleanup();
        if (prevCtxMenuCleanup) prevCtxMenuCleanup();

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
                requestProjectorUiUpdate('gallery')
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
                requestProjectorUiUpdate('gallery')
                showToast('Gallery View note updated', 'success');
            }
        }));

        // 4. (retired in 12) "🧹 Очистить пометки табов" wiped `markedForCollage`
        // on every tab, including the GREEN active scene — the tab stayed green
        // and the manifest kept announcing "current scene" while the showcase
        // was gone. Marks are a consequence of the active scene now, so there is
        // nothing standalone to clear; "❌ Удалить Gallery View" below is the
        // honest way to dissolve the showcase.

        // 5. Delete Gallery View
        const hasCollage = S.gallery.has('__SCENERY_COLLAGE__');
        if (hasCollage || S.coverTag) {
            menu.appendChild(mkItem('❌ Удалить Gallery View', 'var(--error,#e05555)', () => {
                deleteCollageAsset();
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
            if (getActiveCtxMenuCleanup() === cleanup) setActiveCtxMenuCleanup(null);
        };
        setActiveCtxMenuCleanup(cleanup);
        setTimeout(() => {
            if (getActiveCtxMenuCleanup() === cleanup) document.addEventListener('mousedown', close);
        }, 0);
    }

    /** Snapshot for getCollagePublicState() in the host gallery module. */
    function getCollageGenerationState() {
        return {
            running: !!_collageGeneration.running,
            queued: !!_collageGeneration.queued,
            activeSignature: _collageGeneration.activeSignature || null,
        };
    }

    // ── INIT / PUBLIC API ────────────────────────────────────────────────────
    const REQUIRED_DEPS = [
        'applyCover', 'deleteAssets', 'generateThumbUrl', 'persistAsset', 'persistGalleryData',
        'renderGalleryGrid', 'updateGalleryFooter', 'updateGalleryButton', 'requestProjectorUiUpdate',
        'getTabsManager', 'getActiveContextMenuCleanup', 'setActiveContextMenuCleanup',
    ];

    function init(deps) {
        const missing = REQUIRED_DEPS.filter(k => typeof deps?.[k] !== 'function');
        if (missing.length) {
            throw new Error('[VP GalleryCollage] init() missing deps: ' + missing.join(', '));
        }
        if (_deps) console.warn('[VP GalleryCollage] init() called twice — replacing deps.');
        _deps = deps;
        // v18: tiny cross-module facade so hosts (e.g. applyCover in
        // projector-gallery) can refresh the deck pill without importing the
        // satellite — degrades silently when the facade is absent.
        if (typeof window !== 'undefined') {
            window.VP_COLLAGE_PILL = { refresh: updateCollagePill };
        }
        return {
            COLLAGE_TAG, COLLAGE_FILENAME, COLLAGE_LAYOUT_VERSION,
            getCollageGenerationState,
            markVisualInventoryDirty, hasActiveVisualInventory, refreshCollageUi,
            ensureContactSheetCoverLabel, revokeAssetObjectUrls,
            generateCollageFromMarkedTabs, showCollageContextMenu,
            buildContactSheet, collectCollagePlan, calculateContactSheetLayout,
            buildCollageSignature, createCollageMeta, isExistingCollageFresh,
            updateCollagePill, deleteCollageAsset,
        };
    }

    window.VP_GALLERY_COLLAGE = { init };

})();
