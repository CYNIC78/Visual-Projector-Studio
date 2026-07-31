// ╔══════════════════════════════════════════════════════════════════╗
// ║  gallery-hierarchy.js                                            ║
// ║  Visual Projector — Gallery satellite: HIERARCHY TREE            ║
// ║                                                                  ║
// ║  Owns: the category → tab tree controller (TabsManager), its     ║
// ║        strip rendering, inline rename, drag-to-move with fly     ║
// ║        animation, tab state carousel (open/collapsed/locked),    ║
// ║        the "effects" pseudo-tab, and the right-click context     ║
// ║        menus of that strip. (Legacy internal names say           ║
// ║        "sidebar" — the strip actually spans the gallery top.)    ║
// ║                                                                  ║
// ║  Extracted from projector-gallery.js (v02 refactor) — body is    ║
// ║  byte-identical except the boundary rewiring documented in       ║
// ║  CHANGELOG.md.                                                   ║
// ║                                                                  ║
// ║  Load order: visual-projector.js → gallery-hierarchy.js          ║
// ║              → projector-gallery.js                              ║
// ║  (registers window.VP_GALLERY_HIERARCHY; the gallery calls       ║
// ║   .init(deps) and re-exports the TabsManager object untouched)   ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP GalleryHierarchy] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE gallery-hierarchy.js.'
        );
        return;
    }

    const S  = VP.state;          // shared state (by reference)
    const DB = window.VP_DB;      // storage layer (vp-storage.js)

    const showToast         = VP.showToast         || ((m) => console.warn('[toast]', m));
    const showConfirm       = VP.showConfirm       || ((o) => Promise.resolve(window.confirm((o && o.message) || '') ? 'ok' : 'cancel'));
    const showPrompt        = VP.showPrompt        || ((o) => Promise.resolve(window.prompt((o && (o.message || o.title)) || '', o?.value || '')));

    // ── HOST DEPENDENCIES (injected by projector-gallery.js via init) ───────
    // Proxies keep the extracted body verbatim; _deps is assigned once at
    // gallery module-eval time, long before any of these can fire.
    let _deps = null;
    const deleteAssets = (...a) => _deps.deleteAssets(...a);
    const moveAssetsToTab = (...a) => _deps.moveAssetsToTab(...a);
    const renderGalleryGrid = (...a) => _deps.renderGalleryGrid(...a);
    const updateGalleryFooter = (...a) => _deps.updateGalleryFooter(...a);
    const updateGalleryButton = (...a) => _deps.updateGalleryButton(...a);
    const requestProjectorUiUpdate = (...a) => _deps.requestProjectorUiUpdate(...a);
    const persistGalleryData = (...a) => _deps.persistGalleryData(...a);
    const fuzzyMatch = (...a) => _deps.fuzzyMatch(...a);
    const viewportPointToCssSpace = (...a) => _deps.viewportPointToCssSpace(...a);
    const viewportRectToCssSpace = (...a) => _deps.viewportRectToCssSpace(...a);
    const dataTransferHasType = (...a) => _deps.dataTransferHasType(...a);
    const readAssetMoveBatchFromDataTransfer = (...a) => _deps.readAssetMoveBatchFromDataTransfer(...a);
    // collage satellite API (resolved lazily — it inits later in the gallery module):
    const markVisualInventoryDirty = (...a) => _deps.getCollageApi().markVisualInventoryDirty(...a);
    const generateCollageFromMarkedTabs = (...a) => _deps.getCollageApi().generateCollageFromMarkedTabs(...a);
    // shared cross-module context-menu slot (owned by the gallery module):
    const getActiveCtxMenuCleanup = () => _deps.getActiveContextMenuCleanup();
    const setActiveCtxMenuCleanup = (fn) => _deps.setActiveContextMenuCleanup(fn);

    // ════════════════════════════════════════════════════════════════
    //  TAB/CATEGORY HIERARCHY TREE + SIDEBAR CONTEXT MENUS
    //  (extracted from projector-gallery.js — see module header)
    // ════════════════════════════════════════════════════════════════

    function closeSidebarContextMenu() {
        const prevCtxMenuCleanup = getActiveCtxMenuCleanup();
        if (prevCtxMenuCleanup) {
            prevCtxMenuCleanup();
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

            // v27: закон активного состояния (docs/tab-fsm-design.md §8).
            // desc = витрина (меню свёрнутых), rules = закон активного таба —
            // текст-спутник коллажа + повтор при входе; fallback в манифесте.
            if (type === 'tab') {
                addItem('⚖️ Правила таба (закон для модели)', async () => {
                    const rules = await showPrompt({
                        title: 'Tab rules — закон активного состояния',
                        message: 'Читается моделью, пока таб на витрине (текст-спутник коллажа) и в момент входа. Без коллажа — строкой в манифесте. Пустое = без закона.',
                        value: target.rules || '',
                        placeholder: 'Напр.: используй [IMG:] только из этого набора; позы только сидя',
                        confirmLabel: 'Save',
                        multiline: true,
                    });
                    if (rules === null) return;
                    const trimmed = rules.trim();
                    if (trimmed) target.rules = trimmed;
                    else delete target.rules;
                    TabsManager.renderSidebar();
                    renderGalleryGrid();
                    persistGalleryData();
                });
            }

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
            if (getActiveCtxMenuCleanup() === cleanup) {
                setActiveCtxMenuCleanup(null);
            }
        };
        setActiveCtxMenuCleanup(cleanup);
        setTimeout(() => {
            if (getActiveCtxMenuCleanup() === cleanup) {
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
            const id = 'cat_' + Date.now() + Math.random().toString(36).substr(2, 3);
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
            const id = 'tab_' + Date.now() + Math.random().toString(36).substr(2, 3);
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
            requestProjectorUiUpdate('gallery')
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

        /**
         * Execute an AI folder directive: [CAT:open:Name] / [TAB:close:Name].
         * v17 semantics: [TAB:open:X] is a SOLO scene switch — X opens, every
         * other tab collapses and the collage marks follow X, in ONE batch.
         * CAT open/close stays a pack reveal and never touches tab states.
         *
         * FSM audit (2026-07-31): lock is INHERITED — a tab inside a locked
         * category is effectively locked (the manifest already hides it), so
         * the executor refuses it too and says so honestly. Opening a tab also
         * syncs the gallery UI focus (activeTabId/lastAssetTabId) to the FSM
         * state so the user's grid never drifts from what the model sees.
         * Returns a small result object so the command bus can log an honest
         * matched/miss outcome (docs/fsm-audit.md).
         */
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

            // A lock on a category is inherited by every tab inside it:
            // "locked" = "hidden from the LLM", and that must hold in the
            // executor, not just in the manifest tree.
            const catOf = (tab) => (gd.categories || []).find(c => c.id === tab?.categoryId);
            const effectivelyLocked = !!find && (
                find.state === 'locked' ||
                (entityType === 'TAB' && catOf(find)?.state === 'locked')
            );

            if (find && !effectivelyLocked && (normalizedAction === 'open' || normalizedAction === 'collapsed')) {
                const actionLabelRu = normalizedAction === 'collapsed' ? 'свернуто' : 'открыто';
                const fuzzyMatched = find.name.toLowerCase() !== targetName;
                const stateChanged = find.state !== normalizedAction;
                let soloClosed = 0;

                if (stateChanged) {
                    find.state = normalizedAction;
                    changed = true;
                }

                // v17 solo scene switch: [TAB:open:X] = X open, EVERY other tab
                // collapsed, collage marks follow X. Downstream cost stays one
                // batch (1×collage regen, 1×persist, 1×renderSidebar), not N.
                // The sweep runs even when X was already open, so repeating
                // open X is idempotent and heals stray open tabs left over from
                // manual sidebar clicks (which bypass executeCommand on purpose).
                if (entityType === 'TAB' && normalizedAction === 'open') {
                    gd.tabs.forEach(t => {
                        if (t.id !== find.id && t.state === 'open') {
                            t.state = 'collapsed';
                            soloClosed++;
                        }
                    });
                    if (soloClosed) changed = true;

                    // Auto-generate the contact sheet collage and apply as cover.
                    // Mark changes are part of galleryData and must persist even
                    // if the tab was already open.
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

                    // FSM audit: keep the gallery UI focus in sync with the FSM
                    // state — the grid follows activeTabId, the model follows
                    // tab.state; without this they drift apart.
                    if (gd.activeTabId !== find.id) {
                        gd.activeTabId = find.id;
                        if (find.id !== 'effects') S.ui.lastAssetTabId = find.id;
                        changed = true;
                    }
                } else if (entityType === 'TAB' && normalizedAction === 'collapsed' && gd.activeTabId === find.id) {
                    // Stepped back out of the scene that had UI focus — move the
                    // grid to the first remaining tab (same policy as deleteTab).
                    const nextTab = gd.tabs.find(t => t.id !== find.id) || null;
                    gd.activeTabId = nextTab ? nextTab.id : null;
                    S.ui.lastAssetTabId = nextTab ? nextTab.id : null;
                    changed = true;
                }

                if (stateChanged || soloClosed) {
                    const soloNote = soloClosed ? ` — соло: свёрнуты ещё ${soloClosed}` : '';
                    if (fuzzyMatched) {
                        showToast(`📂 ИИ сопоставил "${name}" ➜ "${find.name}" (${actionLabelRu}${soloNote})`, 'info');
                    } else {
                        showToast(`📂 ${entityType === 'CAT' ? 'Категория' : 'Таб'} "${find.name}" ${actionLabelRu} по команде ИИ${soloNote}`, 'info');
                    }
                } else if (fuzzyMatched) {
                    showToast(`📂 ИИ сопоставил "${name}" ➜ "${find.name}"`, 'info');
                }
            } else {
                if (effectivelyLocked) {
                    const lockReason = entityType === 'TAB' && catOf(find)?.state === 'locked'
                        ? 'залочена (родительская категория залочена)'
                        : 'залочена';
                    console.warn(`[VP AI command] ${entityType} "${name}" is locked — command refused`);
                    showToast(`📂 🔒 ${entityType === 'CAT' ? 'Категория' : 'Таб'} "${name}" ${lockReason} — команда не выполнена`, 'info');
                } else {
                    console.warn(`[VP AI command] No matching active ${entityType} found for "${name}"`);
                    showToast(`📂 ${entityType === 'CAT' ? 'Категория' : 'Таб'} "${name}" не найдена — команда не выполнена`, 'info');
                }
            }
            if (changed) {
                this.renderSidebar();
                renderGalleryGrid();
                updateGalleryFooter();
                persistGalleryData();
            }
            return {
                matched: !!(find && !effectivelyLocked && (normalizedAction === 'open' || normalizedAction === 'collapsed')),
                entityType,
                action: normalizedAction,
                name: find?.name || String(name || ''),
                opened: entityType === 'TAB' && normalizedAction === 'open' && !!find && !effectivelyLocked,
                closed: entityType === 'TAB' && normalizedAction === 'collapsed' && !!find && !effectivelyLocked,
                changed,
            };
        },

        /**
         * Read-only FSM snapshot for games/other modules (FSM audit,
         * 2026-07-31): "where are we and what is the law" without reaching
         * into galleryData. The collage/FSM layer answers "где мы", games.js
         * answers "кто считает тяжёлую механику" — this is the neutral seam
         * between them. Never mutates anything.
         */
        getFsmSnapshot() {
            const gd = S.galleryData || { categories: [], tabs: [] };
            const cats = Array.isArray(gd.categories) ? gd.categories : [];
            const tabs = Array.isArray(gd.tabs) ? gd.tabs : [];
            const catStateOf = (t) => cats.find(c => c.id === t?.categoryId)?.state || 'open';
            const effectivelyLocked = (t) => !t || t.state === 'locked' || catStateOf(t) === 'locked';
            const visible = tabs.filter(t => !effectivelyLocked(t));
            const openTabs = visible.filter(t => t.state === 'open');
            const openTab = openTabs[openTabs.length - 1] || null;
            const catName = (t) => cats.find(c => c.id === t?.categoryId)?.name || null;
            return {
                activeTabId: gd.activeTabId || null,
                openTabs: openTabs.map(t => ({ id: t.id, name: t.name, category: catName(t), rules: t.rules || null })),
                openTab: openTab
                    ? { id: openTab.id, name: openTab.name, category: catName(openTab), desc: openTab.desc || null, rules: openTab.rules || null }
                    : null,
                hall: visible.filter(t => t.state === 'collapsed').map(t => ({ id: t.id, name: t.name, desc: t.desc || null, category: catName(t) })),
                lockedHiddenCount: tabs.length - visible.length,
                markedForCollage: visible.filter(t => t.markedForCollage).map(t => t.name),
                categories: cats.map(c => ({ id: c.id, name: c.name, state: c.state })),
            };
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

    // ── INIT / PUBLIC API ────────────────────────────────────────────────────
    const REQUIRED_DEPS = [
        'deleteAssets', 'moveAssetsToTab', 'renderGalleryGrid', 'updateGalleryFooter', 'updateGalleryButton',
        'requestProjectorUiUpdate', 'persistGalleryData',
        'fuzzyMatch', 'viewportPointToCssSpace', 'viewportRectToCssSpace',
        'dataTransferHasType', 'readAssetMoveBatchFromDataTransfer',
        'getCollageApi', 'getActiveContextMenuCleanup', 'setActiveContextMenuCleanup',
    ];

    function init(deps) {
        const missing = REQUIRED_DEPS.filter(k => typeof deps?.[k] !== 'function');
        if (missing.length) {
            throw new Error('[VP GalleryHierarchy] init() missing deps: ' + missing.join(', '));
        }
        if (_deps) console.warn('[VP GalleryHierarchy] init() called twice — replacing deps.');
        _deps = deps;
        return {
            TabsManager,
            showSidebarContextMenu, closeSidebarContextMenu,
        };
    }

    window.VP_GALLERY_HIERARCHY = { init };

})();
