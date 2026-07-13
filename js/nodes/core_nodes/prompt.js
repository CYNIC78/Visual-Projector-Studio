// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/prompt.js  (v2 — Prompt Tabs)                        ║
// ║  Asset Studio — Prompt tower with per-variation tabs.            ║
// ║                                                                  ║
// ║  Внутри ноды живут tab'ы. Каждый таб = имя + текст промпта.      ║
// ║  Активный таб отправляет свой текст на генерацию.                 ║
// ║  Команды в {фигурных скобках} вырезаются перед отправкой модели.  ║
// ║  {name:тэг} — задаёт имя итогового ассета в галерее.             ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeBase, NodeRegistry, Arg, utils } = VP_AS;
    const TOWER = 'prompt';

    // ── Обычные аргументы промпта (negative, cfg, и т.д.) ──
    // positive и reference обрабатываются через табы и дропзону,
    // остальное — обычные пилюли.
    const TAB_EXCLUDED_KEYS = new Set(['positive', 'reference']);

    class PromptNode extends NodeBase {
        constructor(id, x, y) {
            super('prompt', id, x, y);
            this.title = 'Prompt';
            this.color = '#e06b9f';
            this.height = 360;
            this.resizeMode = 'both';
            this.isVisual = true;
        }

        defineSockets() {
            this.inputs = [{ id: 'in', label: 'In', hint: 'Argument stream' }];
            this.outputs = [{ id: 'out', label: 'Out', hint: 'Argument stream' }];
        }

        // ── Миграция со старого формата ──
        _migrateIfNeeded() {
            // Старый формат: this.data.positive и this.data.negative
            if (this.data.positive !== undefined && !Array.isArray(this.data.tabs)) {
                const oldPositive = String(this.data.positive || '');
                const oldNegative = String(this.data.negative || '');
                const combined = oldNegative
                    ? `${oldPositive}\n\nNegative prompt: ${oldNegative}`
                    : oldPositive;
                const tabId = utils.uid('tab');
                this.data.tabs = [{
                    id: tabId,
                    name: 'default',
                    text: combined,
                }];
                this.data.activeTabId = tabId;
                delete this.data.positive;
                delete this.data.negative;
                console.log('[PromptNode] Migrated old data → tabs');
            }

            // Гарантируем массив табов
            if (!Array.isArray(this.data.tabs)) {
                const tabId = utils.uid('tab');
                this.data.tabs = [{
                    id: tabId,
                    name: 'default',
                    text: '',
                }];
                this.data.activeTabId = tabId;
            }

            // Гарантируем activeTabId
            if (!this.data.activeTabId || !this.data.tabs.some(t => t.id === this.data.activeTabId)) {
                this.data.activeTabId = this.data.tabs[0].id;
            }

            // Гарантируем reference
            if (!Array.isArray(this.data.reference)) {
                this.data.reference = [];
            }
        }

        getActiveTab() {
            return (this.data.tabs || []).find(t => t.id === this.data.activeTabId) || null;
        }

        /** Извлечь {name:...} из текста, вернуть имя и очищенный текст */
        extractName(text) {
            if (!text) return { name: null, clean: '' };
            let name = null;
            const clean = text.replace(/\{[^}]+\}/g, (match) => {
                const nameMatch = match.match(/^\{\s*name\s*:\s*(.+?)\s*\}$/i);
                if (nameMatch) name = nameMatch[1].trim();
                return '';
            }).trim();
            return { name, clean };
        }

        // ── Рендер ──
        renderBody(body) {
            body.classList.add('vp-as-pill-stack', 'vp-as-prompt-body');
            body.style.cssText = 'display:flex; flex-direction:column; gap:0; padding:0; overflow:hidden;';
            this._migrateIfNeeded();
            this._renderTabBar(body);
            this._renderEditor(body);
            this._renderExtraArgs(body);
            this._renderDropzone(body);
        }

        _renderTabBar(body) {
            const existing = body.querySelector('.vp-as-tab-bar');
            if (existing) existing.remove();

            const bar = document.createElement('div');
            bar.className = 'vp-as-tab-bar';
            bar.style.cssText = `
                display:flex; align-items:center; gap:4px; padding:6px 8px;
                border-bottom:1px solid rgba(255,255,255,0.08);
                background:rgba(0,0,0,0.12); flex-wrap:wrap;
            `;

            this.data.tabs.forEach((tab, idx) => {
                const isActive = tab.id === this.data.activeTabId;
                const el = document.createElement('div');
                el.className = 'vp-as-tab-tab' + (isActive ? ' active' : '');
                el.dataset.tabId = tab.id;
                el.style.cssText = `
                    display:flex; align-items:center; gap:4px;
                    padding:3px 10px; border-radius:6px; cursor:pointer;
                    font-size:11px; font-weight:${isActive ? '700' : '500'};
                    background:${isActive ? 'var(--accent,#6c5fa6)' : 'rgba(255,255,255,0.06)'};
                    color:${isActive ? '#fff' : 'var(--text-primary,#cdd6f4)'};
                    border:1px solid ${isActive ? 'transparent' : 'rgba(255,255,255,0.08)'};
                    transition:background 0.12s, color 0.12s;
                    user-select:none; max-width:120px; white-space:nowrap;
                    overflow:hidden; text-overflow:ellipsis;
                `;
                el.title = tab.name + (isActive ? ' (active)' : '');
                el.textContent = tab.name;

                if (!isActive) {
                    el.addEventListener('click', () => {
                        this._selectTab(tab.id);
                    });
                }

                // Delete on middle-click
                el.addEventListener('auxclick', (e) => {
                    if (e.button === 1 && this.data.tabs.length > 1) {
                        e.preventDefault();
                        this._deleteTab(tab.id);
                    }
                });

                // Right-click → rename
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._renameTabInteractive(tab.id);
                });

                bar.appendChild(el);
            });

            // + add tab
            const addBtn = document.createElement('button');
            addBtn.textContent = '+';
            addBtn.title = 'Add tab';
            addBtn.style.cssText = `
                border:1px dashed rgba(255,255,255,0.2); background:transparent;
                color:var(--text-secondary,#a6adc8); border-radius:6px;
                padding:3px 8px; font-size:12px; cursor:pointer; line-height:1;
                transition:color 0.12s, border-color 0.12s;
            `;
            addBtn.addEventListener('mouseenter', () => { addBtn.style.color = 'var(--text-primary)'; addBtn.style.borderColor = 'rgba(255,255,255,0.4)'; });
            addBtn.addEventListener('mouseleave', () => { addBtn.style.color = 'var(--text-secondary)'; addBtn.style.borderColor = 'rgba(255,255,255,0.2)'; });
            addBtn.addEventListener('click', () => this._addTab());
            bar.appendChild(addBtn);

            // Tab count badge
            const badge = document.createElement('span');
            badge.textContent = `${this.data.tabs.length}`;
            badge.style.cssText = `font-size:10px; color:var(--text-secondary,#a6adc8); margin-left:auto; opacity:0.6;`;
            bar.appendChild(badge);

            body.insertBefore(bar, body.firstChild);
        }

        _renderEditor(body) {
            const existing = body.querySelector('.vp-as-tab-editor');
            if (existing) existing.remove();

            const activeTab = this.getActiveTab();
            if (!activeTab) return;

            const wrap = document.createElement('div');
            wrap.className = 'vp-as-tab-editor';
            wrap.style.cssText = 'padding:8px; flex-shrink:0;';

            const ta = document.createElement('textarea');
            ta.className = 'vp-as-tab-textarea';
            ta.value = activeTab.text || '';
            ta.placeholder = 'Write your prompt here...\nUse {name:tag} to set the asset name in gallery.';
            ta.style.cssText = `
                width:100%; min-height:80px; resize:vertical; box-sizing:border-box;
                border-radius:6px; border:1px solid rgba(255,255,255,0.12);
                background:rgba(0,0,0,0.22); color:var(--text-primary,#cdd6f4);
                padding:8px; font:12px/1.45 system-ui, sans-serif; outline:none;
            `;
            ta.addEventListener('focus', () => { ta.style.borderColor = 'var(--accent,#6c5fa6)'; });
            ta.addEventListener('blur', () => { ta.style.borderColor = 'rgba(255,255,255,0.12)'; });
            ta.addEventListener('input', () => {
                if (activeTab && this.data.activeTabId === activeTab.id) {
                    activeTab.text = ta.value;
                }
                this._updateHint(ta, body);
            });

            wrap.appendChild(ta);

            // Hint bar
            const hint = document.createElement('div');
            hint.className = 'vp-as-tab-hint';
            hint.style.cssText = `
                font-size:10px; color:var(--text-secondary,#a6adc8);
                margin-top:2px; min-height:16px; line-height:1.3;
            `;
            wrap.appendChild(hint);

            // Insert after tab bar
            const tabBar = body.querySelector('.vp-as-tab-bar');
            if (tabBar) tabBar.after(wrap);
            else body.prepend(wrap);
            this._updateHint(ta, body);
        }

        _updateHint(ta, body) {
            const hintEl = body.querySelector('.vp-as-tab-hint');
            if (!hintEl) return;
            const text = ta.value;
            const nameMatch = text.match(/\{\s*name\s*:\s*(.+?)\s*\}/i);
            if (nameMatch) {
                hintEl.textContent = `→ Gallery tag: ${nameMatch[1].trim()}`;
                hintEl.style.color = '#a6e3a1';
            } else {
                hintEl.textContent = 'No {name:...} — asset will get a technical name (gen_1, gen_2...)';
                hintEl.style.color = 'var(--text-secondary,#a6adc8)';
            }
        }

        _renderExtraArgs(body) {
            const existing = body.querySelector('.vp-as-extra-args');
            if (existing) existing.remove();

            const wrap = document.createElement('div');
            wrap.className = 'vp-as-extra-args';
            wrap.style.cssText = 'padding:4px 8px 0; flex-shrink:0;';

            // Render pills for non-tab, non-reference args
            this._renderPills(wrap);
            this._renderAddButton(wrap);

            body.appendChild(wrap);
        }

        _renderPills(container) {
            container.querySelectorAll('.vp-as-pill').forEach(el => el.remove());
            const defs = Arg.getTowerArgs(TOWER).filter(d => !TAB_EXCLUDED_KEYS.has(d.key) && d.key in this.data);
            for (const def of defs) {
                const pill = VP_AS.Pill.create({
                    key: def.key,
                    label: def.label,
                    value: this.data[def.key],
                    category: def.category,
                    expandable: Arg.isExpandableArg?.(def),
                    renderBody: Arg.renderPillControl(def, this.data[def.key], (v) => {
                        this.data[def.key] = v;
                    }),
                    onChange: () => VP_AS.Graph.persist(),
                    onRemove: () => {
                        delete this.data[def.key];
                        this._renderPills(container);
                        this._renderAddButton(container);
                        VP_AS.Graph.persist();
                    }
                });
                container.appendChild(pill.el);
            }
        }

        _renderAddButton(container) {
            const existing = container.querySelector('.vp-as-add-arg');
            if (existing) existing.remove();
            const currentKeys = Object.keys(this.data).filter(k => k !== 'tabs' && k !== 'activeTabId' && k !== 'reference');
            const defs = Arg.getMissingTowerArgs(TOWER, currentKeys).filter(d => !TAB_EXCLUDED_KEYS.has(d.key));
            if (!defs.length) return;
            const wrap = document.createElement('div');
            wrap.className = 'vp-as-add-arg';
            const btn = document.createElement('button');
            btn.className = 'vp-btn vp-btn-sm';
            btn.textContent = '＋ Add argument';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                Arg.showAddMenu(btn, defs, (def) => {
                    this.data[def.key] = def.control === 'multi-file' ? [] : (def.default ?? '');
                    this._renderPills(container);
                    this._renderAddButton(container);
                    VP_AS.Graph.persist();
                });
            });
            wrap.appendChild(btn);
            container.appendChild(wrap);
        }

        _renderDropzone(body) {
            const existing = body.querySelector('.vp-as-node-dropzone');
            if (existing) existing.remove();
            const refs = Array.isArray(this.data.reference) ? this.data.reference : [];

            const zone = document.createElement('div');
            zone.className = 'vp-as-node-dropzone';
            zone.style.cssText = `
                margin:4px 8px 6px; border-radius:8px;
                transition:border-color 0.15s, background 0.15s;
                cursor:default; flex-shrink:0; overflow:hidden;
            `;

            const setState = (active) => zone.classList.toggle('is-active', !!active);
            zone.addEventListener('dragover', (e) => { e.preventDefault(); setState(true); });
            zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) setState(false); });
            zone.addEventListener('drop', async (e) => {
                e.preventDefault();
                setState(false);
                await this._handleDrop(e.dataTransfer);
            });

            if (refs.length > 0) {
                zone.style.minHeight = '80px';
                zone.style.display = 'flex';
                zone.style.flexDirection = 'column';
                zone.style.overflow = 'hidden';
                zone.style.background = 'rgba(108,95,166,0.06)';
                zone.style.border = '1px solid rgba(108,95,166,0.35)';

                const shown = refs.slice(0, 3);
                const extra = refs.length - 3;

                // Image row — fills available vertical space
                let html = '<div style="display:flex; gap:6px; align-items:stretch; padding:8px 8px 4px; justify-content:space-around;">';
                shown.forEach((ref, i) => {
                    const canImg = ref.startsWith('data:image/') || ref.startsWith('blob:') || ref.startsWith('http://') || ref.startsWith('https://');
                    if (canImg) {
                        html += `<div style="flex:1; min-width:0; display:flex; align-items:center; justify-content:center; overflow:hidden;">
                            <img src="${ref}" style="width:100%; max-height:200px; object-fit:contain; border-radius:6px; border:1px solid rgba(255,255,255,0.1); background:rgba(0,0,0,0.2);"
                                alt="ref${i+1}" title="Reference ${i+1}"
                                onerror="this.outerHTML='<span style=\'font-size:11px;color:var(--text-secondary);padding:8px;\'>✗ ref${i+1}</span>'">
                        </div>`;
                    } else {
                        const name = ref.split('/').pop().split('\\').pop().slice(0, 20);
                        html += `<div style="flex:1; display:flex; align-items:center; justify-content:center; padding:10px; background:rgba(0,0,0,0.15); border-radius:6px; font-size:10px; color:var(--text-secondary,#a6adc8); text-align:center;">${name}</div>`;
                    }
                });
                if (extra > 0) {
                    html += '<div style="flex:0 0 28px; display:flex; align-items:center; justify-content:center;"><span style="font-size:12px; font-weight:700; color:var(--accent);">+'+extra+'</span></div>';
                }
                html += '</div>';

                // Bottom bar — fixed height
                html += '<div style="flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:4px 10px 6px;"><span style="font-size:10px; font-weight:700; color:var(--accent);">📎 '+refs.length+'</span><span style="flex:1;"></span><button class="vp-btn vp-btn-sm" id="vp-as-clear-refs" style="height:20px;padding:0 8px;font-size:10px;">✕ Clear</button></div>';
                zone.innerHTML = html;

                const clearBtn = zone.querySelector('#vp-as-clear-refs');
                if (clearBtn) {
                    clearBtn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        this.data.reference = [];
                        this._renderDropzone(body);
                        VP_AS.Graph.persist();
                    });
                }
            } else {
                zone.style.display = 'flex';
                zone.style.flexDirection = 'column';
                zone.style.alignItems = 'center';
                zone.style.justifyContent = 'center';
                zone.style.minHeight = '50px';
                zone.style.padding = '10px 12px';
                zone.style.border = '1px dashed rgba(255,255,255,0.12)';
                zone.style.background = 'rgba(255,255,255,0.03)';
                zone.style.color = 'var(--text-secondary,#a6adc8)';
                zone.style.fontSize = '11px';
                zone.style.textAlign = 'center';
                zone.innerHTML = '<b>Reference Images</b><span>Drop source here or use gallery drag-n-drop</span>';
            }

            body.appendChild(zone);
        }


        async _handleDrop(dataTransfer) {
            // Try gallery assets first (vp/asset-move-batch)
            if (VP_AS.utils.dataTransferHasType?.(dataTransfer, 'vp/asset-move-batch')) {
                try {
                    const raw = dataTransfer.getData('vp/asset-move-batch');
                    const tags = JSON.parse(raw || '[]');
                    if (Array.isArray(tags) && tags.length) {
                        await this._addGalleryRefs(tags);
                        return;
                    }
                } catch {}
            }

            // Files / paths
            const refs = await utils.extractDroppedImageRefs(dataTransfer, 8);
            if (!refs.length) {
                VP.showToast?.('Unsupported drop payload', 'warn');
                return;
            }
            if (!Array.isArray(this.data.reference)) this.data.reference = [];
            let added = 0;
            for (const ref of refs) {
                if (!this.data.reference.includes(ref)) {
                    this.data.reference.push(ref);
                    added++;
                }
            }
            if (!added) { VP.showToast?.('These references are already attached', 'info'); return; }
            this._syncDropzoneUI();
            await VP_AS.Graph.persist();
            VP.showToast?.(`Attached ${added} reference image${added === 1 ? '' : 's'}`, 'success');
        }

        async _addGalleryRefs(tags) {
            if (!Array.isArray(this.data.reference)) this.data.reference = [];
            let added = 0;
            for (const tag of tags) {
                const asset = VP.state?.gallery?.get(tag);
                if (!asset) continue;
                const ref = asset.url || asset.base64 || null;
                if (!ref || this.data.reference.includes(ref)) continue;
                // Convert blob to base64 for persistence
                if (asset.blob && !ref.startsWith('data:')) {
                    try {
                        const b64 = await VP.blobToBase64?.(asset.blob);
                        if (b64) { this.data.reference.push(b64); added++; continue; }
                    } catch {}
                }
                this.data.reference.push(ref);
                added++;
            }
            if (added) {
                this._syncDropzoneUI();
                await VP_AS.Graph.persist();
                VP.showToast?.(`Added ${added} reference${added === 1 ? '' : 's'} from gallery`, 'success');
            } else {
                VP.showToast?.('No new references to add', 'info');
            }
        }

        _syncDropzoneUI() {
            const el = this.element;
            if (!el) return;
            const body = el.querySelector('.vp-as-pill-stack');
            if (!body) return;
            // Re-render the whole body to show/hide dropzone and reference pills
            this._renderPills(body.querySelector('.vp-as-extra-args'));
            this._renderAddButton(body.querySelector('.vp-as-extra-args'));
            this._renderDropzone(body);
        }

        _selectTab(tabId) {
            if (!this.data.tabs.some(t => t.id === tabId)) return;
            const wasSame = this.data.activeTabId === tabId;
            if (wasSame) return;

            // Save current editor text before switching
            const body = this.element?.querySelector('.vp-as-pill-stack');
            const ta = body?.querySelector('.vp-as-tab-textarea');
            const activeTab = this.getActiveTab();
            if (ta && activeTab) {
                activeTab.text = ta.value;
            }

            this.data.activeTabId = tabId;

            // Re-render editor and tab bar
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        _addTab() {
            const baseName = 'tab';
            const names = this.data.tabs.map(t => t.name);
            let n = 1, name = `${baseName}_${n}`;
            while (names.includes(name)) { n++; name = `${baseName}_${n}`; }

            const tabId = utils.uid('tab');
            this.data.tabs.push({ id: tabId, name, text: '{name:new_asset} ' });
            this.data.activeTabId = tabId;

            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        _deleteTab(tabId) {
            if (this.data.tabs.length <= 1) {
                VP.showToast?.('Need at least one tab', 'warn');
                return;
            }
            this.data.tabs = this.data.tabs.filter(t => t.id !== tabId);
            if (this.data.activeTabId === tabId) {
                this.data.activeTabId = this.data.tabs[0].id;
            }

            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        async _renameTabInteractive(tabId) {
            const tab = this.data.tabs.find(t => t.id === tabId);
            if (!tab) return;

            const newName = await VP.showPrompt?.({
                title: 'Rename tab',
                message: 'Tab name (used for organization only):',
                value: tab.name,
                placeholder: 'smile, angry, sad...',
                confirmLabel: 'Rename',
                required: true,
            });
            if (newName == null) return;
            const trimmed = newName.trim();
            if (!trimmed || trimmed === tab.name) return;

            tab.name = trimmed;
            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) this._renderTabBar(body);
            VP_AS.Graph.persist();
        }

        // ── process() — вызывается при Graph.produce() ──
        process(bag) {
            this._migrateIfNeeded();
            const activeTab = this.getActiveTab();
            if (!activeTab) return;

            // Извлекаем {name:...} и чистим все {...}
            const { name: assetName, clean: cleanText } = this.extractName(activeTab.text);

            // Сохраняем имя ассета в bag.meta
            if (assetName) {
                bag.meta.set('assetName', assetName);
            }

            // Positive prompt — из активного таба
            let v = cleanText;
            if (v) {
                // LoRA tags still inject (from lora tower)
                if (bag.loraTags && bag.loraTags.length > 0) {
                    v = v + ' ' + bag.loraTags.join(' ');
                }
                bag.set('-p', v);
            } else if (bag.loraTags && bag.loraTags.length > 0) {
                bag.set('-p', bag.loraTags.join(' '));
            }

            // Reference images
            if (Array.isArray(this.data.reference)) {
                for (const ref of this.data.reference) {
                    bag.addMulti('-r', ref);
                }
            }

            // Прочие аргументы (negative, cfg-scale, etc.)
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (TAB_EXCLUDED_KEYS.has(def.key)) continue;
                if (!(def.key in this.data)) continue;
                const val = this.data[def.key];
                if (val === '' || val == null) continue;
                if (def.control === 'multi-file') {
                    const arr = Array.isArray(val) ? val : (val ? [val] : []);
                    for (const path of arr) bag.addMulti(def.flag, path);
                } else {
                    bag.set(def.flag, val);
                }
            }
        }

        serialize() {
            // Clean up: remove _migrateIfNeeded cruft, store only what's needed
            return {
                type: this.type,
                id: this.id,
                x: this.x,
                y: this.y,
                width: this.width,
                height: this.height,
                data: {
                    tabs: (this.data.tabs || []).map(t => ({
                        id: t.id,
                        name: t.name,
                        text: t.text,
                    })),
                    activeTabId: this.data.activeTabId || (this.data.tabs?.[0]?.id) || null,
                    reference: Array.isArray(this.data.reference) ? [...this.data.reference] : [],
                    // Сохраняем только "не-табные" аргументы (negative, cfg-scale...)
                    ...Object.fromEntries(
                        Object.entries(this.data)
                            .filter(([k]) => !['tabs', 'activeTabId', 'reference', 'positive'].includes(k))
                    ),
                },
            };
        }

        deserialize(state) {
            super.deserialize(state);
            // Сохраняем reference отдельно, т.к. super.deserialize может перезатереть
            if (state?.data?.reference && Array.isArray(state.data.reference)) {
                this.data.reference = [...state.data.reference];
            }
            if (state?.data?.tabs && Array.isArray(state.data.tabs)) {
                this.data.tabs = state.data.tabs.map(t => ({ ...t }));
                this.data.activeTabId = state.data.activeTabId || this.data.tabs[0]?.id || null;
            }
            this._migrateIfNeeded();
        }
    }

    NodeRegistry.register('prompt', PromptNode, { title: 'Prompt', icon: '💬', color: '#e06b9f' });
})();
