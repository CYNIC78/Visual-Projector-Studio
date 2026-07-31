// ╔══════════════════════════════════════════════════════════════════╗
// ║  gallery-panel.js                                                ║
// ║  Visual Projector — Gallery satellite: FLOATING WINDOW +         ║
// ║  SETTINGS PANEL                                                  ║
// ║                                                                  ║
// ║  Owns: the floating Gallery/Settings window (own scoped CSS,     ║
// ║        drag/resize, persisted geometry), the gallery toolbar     ║
// ║        (import/export/selection/collage buttons) and the         ║
// ║        settings section (projector config bindings, manifest/    ║
// ║        frame-template editors, previews).                        ║
// ║                                                                  ║
// ║  Extracted from projector-gallery.js (v03 refactor) — body is    ║
// ║  byte-identical except the 2 documented boundary lines in        ║
// ║  CHANGELOG.md. Engine/Tagger are reached via the VP facade and   ║
// ║  the window.VisualProjector.gallery reverse bridge at runtime.   ║
// ║                                                                  ║
// ║  Load order: visual-projector.js (+ other gallery satellites)    ║
// ║              → gallery-panel.js → projector-gallery.js           ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP GalleryPanel] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE gallery-panel.js.'
        );
        return;
    }

    const S  = VP.state;          // shared state (by reference)
    const DB = window.VP_DB;      // storage layer (vp-storage.js)

    const showToast         = VP.showToast         || ((m) => console.warn('[toast]', m));
    const showConfirm       = VP.showConfirm       || ((o) => Promise.resolve(window.confirm((o && o.message) || '') ? 'ok' : 'cancel'));
    const showPromptPreview = VP.showPromptPreview || ((t, c) => alert(t + '\n\n' + c));

    // ── HOST DEPENDENCIES (injected by projector-gallery.js via init) ───────
    // Proxies keep the extracted body verbatim; _deps is assigned once at
    // gallery module-eval time, long before any of these can fire.
    let _deps = null;
    const renderGalleryGrid = (...a) => _deps.renderGalleryGrid(...a);
    const updateGalleryButton = (...a) => _deps.updateGalleryButton(...a);
    const updateGalleryFooter = (...a) => _deps.updateGalleryFooter(...a);
    const requestProjectorUiUpdate = (...a) => _deps.requestProjectorUiUpdate(...a);
    const clearSelection = (...a) => _deps.clearSelection(...a);
    const deleteAssets = (...a) => _deps.deleteAssets(...a);
    const exportGallery = (...a) => _deps.exportGallery(...a);
    const importGallery = (...a) => _deps.importGallery(...a);
    const loadGalleryFolder = (...a) => _deps.loadGalleryFolder(...a);
    const loadSingleFile = (...a) => _deps.loadSingleFile(...a);
    const pasteFromClipboard = (...a) => _deps.pasteFromClipboard(...a);
    const applyAllDrafts = (...a) => _deps.applyAllDrafts(...a);
    const discardAllDrafts = (...a) => _deps.discardAllDrafts(...a);
    const persistConfig = (...a) => _deps.persistConfig(...a);
    const getNormalizedElementPlacement = (...a) => _deps.getNormalizedElementPlacement(...a);
    // hierarchy satellite (already initialized in the gallery module):
    const getTabsManager = () => _deps.getTabsManager();
    // collage satellite (resolved lazily — it inits later in the gallery module):
    const generateCollageFromMarkedTabs = (...a) => _deps.getCollageApi().generateCollageFromMarkedTabs(...a);
    const showCollageContextMenu = (...a) => _deps.getCollageApi().showCollageContextMenu(...a);

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
                                <button class="vp-btn" id="vp-gallery-apply-drafts" title="Apply all drafts" style="display:none;">✅ Apply All</button>
                                <button class="vp-btn vp-btn-danger" id="vp-gallery-discard-drafts" title="Discard all drafts" style="display:none;">🗑️ Discard All</button>
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
                        <label class="vp-setting-row"><span>Gallery Navigation</span><input type="checkbox" id="vp-allow-dir-cmds"></label>
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
            // LAYER SEPARATION (13): building the sheet no longer seizes the
            // screen (the stage belongs to the artistic layer). This button is
            // the human's EXPLICIT "show me the under-the-hood sheet" gesture,
            // so it answers by opening the pill popup — the designated window
            // into the model's view — instead of overwriting the current frame.
            collageBtn.addEventListener('click', async () => {
                const asset = await generateCollageFromMarkedTabs({ reason: 'manual-button' });
                if (asset) window.VP_COLLAGE_PILL?.open?.();
            });
            collageBtn.addEventListener('contextmenu', showCollageContextMenu);
        }
        p$('#vp-gallery-apply-drafts')?.addEventListener('click', applyAllDrafts);
        p$('#vp-gallery-discard-drafts')?.addEventListener('click', discardAllDrafts);
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

    /** Async-restore saved panel geometry from storage before first reveal. */
    function restorePanelGeom(panel) {
        if (!panel) return Promise.resolve();
        const applyGeom = (g) => {
            if (!g) return;
            panel.style.left = g.left + 'px';  panel.style.top = g.top + 'px';
            panel.style.width = g.width + 'px'; panel.style.height = g.height + 'px';
            panel.style.right = 'auto';
        };
        const markReady = () => {
            panel.dataset.vpGeomReady = '1';
            if (panel.dataset.vpPendingReveal === '1') {
                delete panel.dataset.vpPendingReveal;
                panel.style.visibility = '';
            }
        };
        panel.dataset.vpGeomReady = '0';
        const promise = DB?.getPanelGeom
            ? DB.getPanelGeom().then(applyGeom).catch(() => {})
            : Promise.resolve();
        panel._vpGeomReady = promise.finally(markReady);
        return panel._vpGeomReady;
    }

    /** Build + mount the floating Gallery/Settings panel. */
    function createGalleryPanel() {
        injectPanelStyles();
        const panel = document.createElement('div');
        panel.id = 'vp-gallery-panel';
        // Keep the first mount invisible until stored geometry is restored.
        // Otherwise the panel can flash at its default position and jump a frame later.
        panel.style.display = 'none';
        panel.style.visibility = 'hidden';
        panel.innerHTML = buildPanelHTML();
        document.body.appendChild(panel);

        S.ui.galleryGrid  = panel.querySelector('#vp-gallery-grid');
        S.ui.galleryPanel = panel;

        getTabsManager().renderSidebar();

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
            after: (v) => { if (S.history.length > v) S.history = S.history.slice(-v); requestProjectorUiUpdate('gallery') },
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
        bindSelect('#vp-frame-label-mode', 'frameLabelMode', () => requestProjectorUiUpdate('frame-label-mode')); 

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
            getTabsManager().renderSidebar();
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
            delete panel.dataset.vpPendingReveal;
            panel.style.visibility = '';
            panel.style.display = 'none';
            galBtn?.classList.remove('vp-btn-active');  galBtn?.classList.add('vp-btn-ghost');
            if (galBtn) galBtn.textContent = '📚';
            settBtn?.classList.remove('vp-btn-active'); settBtn?.classList.add('vp-btn-ghost');
            S.ui.panelOpen = false;
            return;
        }
        undockGalleryPanelForFloating(panel);
        if (panel.dataset.vpGeomReady !== '1' && panel._vpGeomReady?.finally) {
            panel.dataset.vpPendingReveal = '1';
            panel.style.visibility = 'hidden';
            panel._vpGeomReady.finally(() => {
                if (panel.dataset.vpPendingReveal === '1') {
                    delete panel.dataset.vpPendingReveal;
                    panel.style.visibility = '';
                }
            });
        } else {
            delete panel.dataset.vpPendingReveal;
            panel.style.visibility = '';
        }
        panel.style.display = '';
        S.ui.panelOpen = true;
        activatePanelSection(target);
    }

    // ── INIT / PUBLIC API ────────────────────────────────────────────────────
    const REQUIRED_DEPS = [
        'renderGalleryGrid', 'updateGalleryButton', 'updateGalleryFooter', 'requestProjectorUiUpdate',
        'clearSelection', 'deleteAssets', 'exportGallery', 'importGallery',
        'loadGalleryFolder', 'loadSingleFile', 'pasteFromClipboard', 'applyAllDrafts', 'discardAllDrafts',
        'persistConfig', 'getNormalizedElementPlacement', 'getTabsManager', 'getCollageApi',
    ];

    function init(deps) {
        const missing = REQUIRED_DEPS.filter(k => typeof deps?.[k] !== 'function');
        if (missing.length) {
            throw new Error('[VP GalleryPanel] init() missing deps: ' + missing.join(', '));
        }
        if (_deps) console.warn('[VP GalleryPanel] init() called twice — replacing deps.');
        _deps = deps;
        return {
            createGalleryPanel, togglePanel, syncSettingsUI, activatePanelSection,
            isGalleryPanelDocked, positionFloatingGalleryPanel, undockGalleryPanelForFloating,
        };
    }

    window.VP_GALLERY_PANEL = { init };

})();
