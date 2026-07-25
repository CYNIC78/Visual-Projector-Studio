// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/prompt.js  (v2 — Prompt Variants)                    ║
// ║  Asset Studio — Prompt tower with per-variation variants.        ║
// ║                                                                  ║
// ║  Внутри ноды живут варианты. Каждый вариант = имя + текст промпта.║
// ║  Активный вариант отправляет свой текст на генерацию.            ║
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
    const VARIANT_EXCLUDED_KEYS = new Set(['positive', 'reference']);

    let _draggedRefIndex = null;

    class PromptNode extends NodeBase {
        constructor(id, x, y) {
            super('prompt', id, x, y);
            this.title = 'Prompt';
            this.color = '#e06b9f';
            this.height = 420;
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
            if (this.data.positive !== undefined && !Array.isArray(this.data.variants)) {
                const oldPositive = String(this.data.positive || '');
                const oldNegative = String(this.data.negative || '');
                const combined = oldNegative
                    ? `${oldPositive}\n\nNegative prompt: ${oldNegative}`
                    : oldPositive;
                const varId = utils.uid('variant');
                this.data.variants = [{
                    id: varId,
                    name: 'default',
                    text: combined,
                }];
                this.data.activeVariantId = varId;
                delete this.data.positive;
                delete this.data.negative;
                console.log('[PromptNode] Migrated old data → variants');
            }

            // Миграция tabs -> variants (если данные были сохранены как tabs)
            if (this.data.tabs && Array.isArray(this.data.tabs)) {
                this.data.variants = this.data.tabs.map(t => ({
                    id: t.id ? t.id.replace('tab', 'variant') : utils.uid('variant'),
                    name: t.name,
                    text: t.text
                }));
                this.data.activeVariantId = this.data.activeTabId ? this.data.activeTabId.replace('tab', 'variant') : this.data.variants[0].id;
                delete this.data.tabs;
                delete this.data.activeTabId;
            }

            // Гарантируем массив вариантов
            if (!Array.isArray(this.data.variants)) {
                const varId = utils.uid('variant');
                this.data.variants = [{
                    id: varId,
                    name: 'default',
                    text: '',
                }];
                this.data.activeVariantId = varId;
            }

            // Гарантируем activeVariantId
            if (!this.data.activeVariantId || !this.data.variants.some(v => v.id === this.data.activeVariantId)) {
                this.data.activeVariantId = this.data.variants[0].id;
            }

            // Гарантируем reference
            if (!Array.isArray(this.data.reference)) {
                this.data.reference = [];
            }
        }

        getActiveVariant() {
            return (this.data.variants || []).find(v => v.id === this.data.activeVariantId) || null;
        }

        _escapeHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, ch => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
            }[ch]));
        }

        _makeGalleryRef(tag) {
            return { type: 'gallery', tag: String(tag || '') };
        }

        _refKey(ref) {
            if (ref && typeof ref === 'object') return `gallery:${ref.tag || ''}`;
            return String(ref || '');
        }

        _hasRef(ref) {
            const key = this._refKey(ref);
            return (this.data.reference || []).some(x => this._refKey(x) === key);
        }

        _refPreview(ref) {
            if (ref && typeof ref === 'object' && ref.type === 'gallery') {
                const tag = String(ref.tag || '');
                const asset = VP.state?.gallery?.get(tag);
                return {
                    src: asset?.thumbUrl || asset?.url || null,
                    label: tag || 'gallery ref',
                    title: `Gallery: ${tag}`,
                };
            }
            const value = String(ref || '');
            return {
                src: /^(data:image\/|blob:|https?:\/\/)/i.test(value) ? value : null,
                label: value.split('/').pop().split('\\').pop().slice(0, 24) || 'reference',
                title: value,
            };
        }

        _syncActiveEditorText() {
            const body = this.element?.querySelector('.vp-as-pill-stack');
            const ta = body?.querySelector('.vp-as-variant-textarea');
            const activeVariant = this.getActiveVariant();
            if (ta && activeVariant && this.data.activeVariantId === activeVariant.id) {
                activeVariant.text = ta.value;
            }
        }

        _promptJsonData() {
            this._syncActiveEditorText();
            this._migrateIfNeeded();
            return {
                variants: (this.data.variants || []).map(v => ({
                    id: v.id,
                    name: v.name,
                    text: v.text,
                })),
                activeVariantId: this.data.activeVariantId || this.data.variants?.[0]?.id || null,
                reference: Array.isArray(this.data.reference)
                    ? this.data.reference.map(r => (r && typeof r === 'object') ? { ...r } : r)
                    : [],
                ...Object.fromEntries(
                    Object.entries(this.data || {})
                        .filter(([k]) => !['variants', 'activeVariantId', 'tabs', 'activeTabId', 'reference', 'positive'].includes(k))
                        .map(([k, v]) => [k, (v && typeof v === 'object') ? JSON.parse(JSON.stringify(v)) : v])
                ),
            };
        }

        _normalizePromptJsonPayload(payload) {
            let data = payload;
            if (typeof data === 'string') data = JSON.parse(data);
            
            // Migrate pasted data
            if (Array.isArray(data)) data = { variants: data };
            if (data?.tabs && Array.isArray(data.tabs)) {
                data.variants = data.tabs.map(t => ({
                    id: t.id ? t.id.replace('tab', 'variant') : utils.uid('variant'),
                    name: t.name,
                    text: t.text
                }));
                data.activeVariantId = data.activeTabId ? data.activeTabId.replace('tab', 'variant') : data.variants[0].id;
                delete data.tabs;
                delete data.activeTabId;
            }
            
            if (data?.type === 'prompt' && data.data) data = data.data;
            if (data?.format === 'vp-prompt-node-v1' && data.data) data = data.data;
            if (!data || typeof data !== 'object') throw new Error('JSON object expected');
            if (!Array.isArray(data.variants) || !data.variants.length) throw new Error('No variants in JSON');

            const variants = data.variants.map(v => ({
                id: String(v.id || utils.uid('variant')),
                name: String(v.name || 'variant').trim() || 'variant',
                text: String(v.text || ''),
            })).filter(v => v.text || v.name);
            if (!variants.length) throw new Error('No valid variants in JSON');

            const out = {
                ...data,
                variants,
                activeVariantId: data.activeVariantId && variants.some(v => v.id === data.activeVariantId)
                    ? data.activeVariantId
                    : variants[0].id,
                reference: Array.isArray(data.reference)
                    ? data.reference.map(r => (r && typeof r === 'object') ? { ...r } : r)
                    : [],
            };
            delete out.positive;
            delete out.tabs;
            delete out.activeTabId;
            return out;
        }

        async _copyJsonToClipboard() {
            const payload = {
                format: 'vp-prompt-node-v1',
                exportedAt: Date.now(),
                data: this._promptJsonData(),
            };
            const text = JSON.stringify(payload, null, 2);
            try {
                await navigator.clipboard?.writeText(text);
                VP.showToast?.('Prompt Node JSON copied', 'success');
            } catch {
                window.prompt('Copy Prompt Node JSON:', text);
            }
        }

        async _pasteJsonFromClipboard() {
            let text = '';
            try { text = await navigator.clipboard?.readText(); }
            catch { text = window.prompt('Paste Prompt Node JSON:') || ''; }
            if (!String(text || '').trim()) return;
            try {
                const data = this._normalizePromptJsonPayload(text);
                this.data = data;
                this._migrateIfNeeded();
                const body = this.element?.querySelector('.vp-as-pill-stack');
                if (body) {
                    body.innerHTML = '';
                    this._renderTabBar(body);
                    this._renderEditor(body);
                    this._renderExtraArgs(body);
                    this._renderDropzone(body);
                }
                VP_AS.Graph.persist();
                VP.showToast?.(`Prompt JSON pasted: ${this.data.variants.length} variant(s)`, 'success');
            } catch (err) {
                console.warn('[PromptNode] Paste JSON failed:', err);
                VP.showToast?.(`Invalid Prompt JSON: ${err.message || err}`, 'error');
            }
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

            this.data.variants.forEach((variant, idx) => {
                const isActive = variant.id === this.data.activeVariantId;
                const el = document.createElement('div');
                el.className = 'vp-as-variant-tab' + (isActive ? ' active' : '');
                el.dataset.variantId = variant.id;
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
                el.title = variant.name + (isActive ? ' (active)' : '');
                el.textContent = variant.name;

                if (!isActive) {
                    el.addEventListener('click', () => {
                        this._selectVariant(variant.id);
                    });
                }

                // Delete on middle-click
                el.addEventListener('auxclick', (e) => {
                    if (e.button === 1 && this.data.variants.length > 1) {
                        e.preventDefault();
                        this._deleteVariant(variant.id);
                    }
                });

                // Right-click → rename
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._renameVariantInteractive(variant.id);
                });

                bar.appendChild(el);
            });

            // + add variant
            const addBtn = document.createElement('button');
            addBtn.textContent = '+';
            addBtn.title = 'Add variant';
            addBtn.style.cssText = `
                border:1px dashed rgba(255,255,255,0.2); background:transparent;
                color:var(--text-secondary,#a6adc8); border-radius:6px;
                padding:3px 8px; font-size:12px; cursor:pointer; line-height:1;
                transition:color 0.12s, border-color 0.12s;
            `;
            addBtn.addEventListener('mouseenter', () => { addBtn.style.color = 'var(--text-primary)'; addBtn.style.borderColor = 'rgba(255,255,255,0.4)'; });
            addBtn.addEventListener('mouseleave', () => { addBtn.style.color = 'var(--text-secondary)'; addBtn.style.borderColor = 'rgba(255,255,255,0.2)'; });
            addBtn.addEventListener('click', () => this._addVariant());
            bar.appendChild(addBtn);

            const spacer = document.createElement('span');
            spacer.style.cssText = 'flex:1 1 auto; min-width:6px;';
            bar.appendChild(spacer);

            // Variant count badge
            const badge = document.createElement('span');
            badge.textContent = `${this.data.variants.length}`;
            badge.style.cssText = `font-size:10px; color:var(--text-secondary,#a6adc8); opacity:0.6; padding:0 2px;`;
            bar.appendChild(badge);

            body.insertBefore(bar, body.firstChild);
        }

        _renderEditor(body) {
            const existing = body.querySelector('.vp-as-variant-editor');
            if (existing) existing.remove();

            const activeVariant = this.getActiveVariant();
            if (!activeVariant) return;

            const wrap = document.createElement('div');
            wrap.className = 'vp-as-variant-editor';
            wrap.style.cssText = 'padding:8px; flex-shrink:0;';

            const ta = document.createElement('textarea');
            ta.className = 'vp-as-variant-textarea';
            ta.value = activeVariant.text || '';
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
                if (activeVariant && this.data.activeVariantId === activeVariant.id) {
                    activeVariant.text = ta.value;
                }
                this._updateHint(ta, body);
            });

            wrap.appendChild(ta);

            // Hint/action row — tag info on the left, JSON utilities on the right.
            const hintRow = document.createElement('div');
            hintRow.className = 'vp-as-variant-hint-row';
            hintRow.style.cssText = `
                display:flex; align-items:center; gap:6px; margin-top:3px;
                min-height:22px; line-height:1.3;
            `;

            const hint = document.createElement('div');
            hint.className = 'vp-as-variant-hint';
            hint.style.cssText = `
                flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
                font-size:10px; color:var(--text-secondary,#a6adc8);
            `;
            hintRow.appendChild(hint);

            const jsonActions = document.createElement('div');
            jsonActions.className = 'vp-as-variant-json-actions';
            jsonActions.style.cssText = 'flex:0 0 auto; display:flex; align-items:center; gap:4px;';
            const makeJsonBtn = (label, title, handler) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = label;
                btn.title = title;
                btn.style.cssText = `
                    border:1px solid rgba(255,255,255,0.12); background:rgba(255,255,255,0.05);
                    color:var(--text-secondary,#a6adc8); border-radius:6px; height:20px;
                    padding:0 7px; font-size:10px; cursor:pointer; line-height:1;
                `;
                btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); handler(); });
                return btn;
            };
            jsonActions.appendChild(makeJsonBtn('⧉ JSON', 'Copy Prompt Node JSON to clipboard', () => this._copyJsonToClipboard()));
            jsonActions.appendChild(makeJsonBtn('⇩ JSON', 'Paste Prompt Node JSON from clipboard', () => this._pasteJsonFromClipboard()));
            hintRow.appendChild(jsonActions);
            wrap.appendChild(hintRow);

            // Insert after variant bar
            const variantBar = body.querySelector('.vp-as-tab-bar');
            if (variantBar) variantBar.after(wrap);
            else body.prepend(wrap);
            this._updateHint(ta, body);
        }

        _updateHint(ta, body) {
            const hintEl = body.querySelector('.vp-as-variant-hint');
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
            const defs = Arg.getTowerArgs(TOWER).filter(d => !VARIANT_EXCLUDED_KEYS.has(d.key) && d.key in this.data);
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
            const currentKeys = Object.keys(this.data).filter(k => k !== 'variants' && k !== 'activeVariantId' && k !== 'reference');
            const defs = Arg.getMissingTowerArgs(TOWER, currentKeys).filter(d => !VARIANT_EXCLUDED_KEYS.has(d.key));
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
                zone.style.minHeight = '128px';
                zone.style.display = 'flex';
                zone.style.flexDirection = 'column';
                zone.style.overflow = 'hidden';
                zone.style.background = 'rgba(108,95,166,0.06)';
                zone.style.border = '1px solid rgba(108,95,166,0.35)';

                // Create a container row for thumbnails
                const row = document.createElement('div');
                row.className = 'vp-as-refs-row';
                row.style.cssText = 'display:flex; gap:6px; align-items:stretch; padding:8px 8px 4px; justify-content:space-around; flex: 1 1 auto; flex-wrap: wrap;';

                // Render ALL reference thumbnails
                refs.forEach((ref, i) => {
                    const preview = this._refPreview(ref);
                    const label = this._escapeHtml(preview.label);
                    const title = this._escapeHtml(preview.title || preview.label);

                    const card = document.createElement('div');
                    card.className = 'vp-as-ref-card';
                    card.dataset.index = i;
                    card.style.cssText = `
                        flex:1; min-width:85px; max-width: 110px; display:flex; flex-direction:column; gap:4px;
                        align-items:center; justify-content:center; overflow:hidden;
                        position: relative; border-radius: 6px; padding: 6px; min-height: 125px;
                        background: rgba(0,0,0,0.15); border: 1px solid rgba(255,255,255,0.05);
                        transition: border-color 0.15s, background 0.15s;
                    `;

                    // Individual Delete Button (top-right close cross)
                    const delBtn = document.createElement('button');
                    delBtn.className = 'vp-as-ref-del-btn';
                    delBtn.innerHTML = '×';
                    delBtn.title = 'Remove reference';
                    delBtn.style.cssText = `
                        position: absolute; right: 2px; top: 2px; width: 14px; height: 14px;
                        border-radius: 999px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.2);
                        color: #ff8585; font-size: 10px; font-weight: bold; cursor: pointer;
                        display: flex; align-items: center; justify-content: center; line-height: 1;
                        z-index: 5; opacity: 0.6; transition: opacity 0.15s, background 0.15s;
                        pointer-events: auto; padding: 0;
                    `;
                    delBtn.addEventListener('mouseenter', () => { delBtn.style.opacity = '1'; delBtn.style.background = '#e06b9f'; delBtn.style.color = '#fff'; });
                    delBtn.addEventListener('mouseleave', () => { delBtn.style.opacity = '0.6'; delBtn.style.background = 'rgba(0,0,0,0.6)'; delBtn.style.color = '#ff8585'; });
                    delBtn.addEventListener('click', (e) => {
                        e.preventDefault(); e.stopPropagation();
                        this.data.reference.splice(i, 1);
                        this._syncDropzoneUI();
                        VP_AS.Graph.persist();
                    });
                    card.appendChild(delBtn);

                    // Shift Left Button (◀)
                    if (i > 0) {
                        const leftBtn = document.createElement('button');
                        leftBtn.className = 'vp-as-ref-shift-btn';
                        leftBtn.innerHTML = '◀';
                        leftBtn.title = 'Move left';
                        leftBtn.style.cssText = `
                            position: absolute; left: 2px; bottom: 2px; width: 14px; height: 14px;
                            border-radius: 4px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.2);
                            color: #89b4fa; font-size: 8px; font-weight: bold; cursor: pointer;
                            display: flex; align-items: center; justify-content: center; line-height: 1;
                            z-index: 5; opacity: 0.6; transition: opacity 0.15s, background 0.15s;
                            pointer-events: auto; padding: 0;
                        `;
                        leftBtn.addEventListener('mouseenter', () => { leftBtn.style.opacity = '1'; leftBtn.style.background = 'rgba(108,95,166,0.85)'; });
                        leftBtn.addEventListener('mouseleave', () => { leftBtn.style.opacity = '0.6'; leftBtn.style.background = 'rgba(0,0,0,0.6)'; });
                        leftBtn.addEventListener('click', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            const refsList = this.data.reference;
                            const temp = refsList[i];
                            refsList[i] = refsList[i - 1];
                            refsList[i - 1] = temp;
                            this._syncDropzoneUI();
                            VP_AS.Graph.persist();
                        });
                        card.appendChild(leftBtn);
                    }

                    // Shift Right Button (▶)
                    if (i < refs.length - 1) {
                        const rightBtn = document.createElement('button');
                        rightBtn.className = 'vp-as-ref-shift-btn';
                        rightBtn.innerHTML = '▶';
                        rightBtn.title = 'Move right';
                        rightBtn.style.cssText = `
                            position: absolute; right: 2px; bottom: 2px; width: 14px; height: 14px;
                            border-radius: 4px; background: rgba(0,0,0,0.6); border: 1px solid rgba(255,255,255,0.2);
                            color: #89b4fa; font-size: 8px; font-weight: bold; cursor: pointer;
                            display: flex; align-items: center; justify-content: center; line-height: 1;
                            z-index: 5; opacity: 0.6; transition: opacity 0.15s, background 0.15s;
                            pointer-events: auto; padding: 0;
                        `;
                        rightBtn.addEventListener('mouseenter', () => { rightBtn.style.opacity = '1'; rightBtn.style.background = 'rgba(108,95,166,0.85)'; });
                        rightBtn.addEventListener('mouseleave', () => { rightBtn.style.opacity = '0.6'; rightBtn.style.background = 'rgba(0,0,0,0.6)'; });
                        rightBtn.addEventListener('click', (e) => {
                            e.preventDefault(); e.stopPropagation();
                            const refsList = this.data.reference;
                            const temp = refsList[i];
                            refsList[i] = refsList[i + 1];
                            refsList[i + 1] = temp;
                            this._syncDropzoneUI();
                            VP_AS.Graph.persist();
                        });
                        card.appendChild(rightBtn);
                    }

                    // Thumbnail image or placeholder
                    if (preview.src) {
                        const img = document.createElement('img');
                        img.src = preview.src;
                        img.alt = `ref_${i}`;
                        img.title = title;
                        img.style.cssText = 'width:100%; max-height:80px; object-fit:contain; border-radius:4px; border:1px solid rgba(255,255,255,0.06); background:rgba(0,0,0,0.2); pointer-events: none; margin-top: 14px;';
                        img.onerror = () => { img.outerHTML = `<span style="font-size:10px;color:var(--text-secondary,#a6adc8);padding:4px;">✗ ref${i+1}</span>`; };
                        card.appendChild(img);
                    } else {
                        const placeholder = document.createElement('div');
                        placeholder.style.cssText = 'font-size:10px; color:var(--text-secondary,#a6adc8); text-align:center; padding: 4px; margin-top: 14px;';
                        placeholder.textContent = label;
                        card.appendChild(placeholder);
                    }

                    // Label
                    const labelEl = document.createElement('span');
                    labelEl.style.cssText = 'max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:9px; color:var(--text-secondary,#a6adc8); pointer-events: none; margin-top: 2px; margin-bottom: 14px;';
                    labelEl.title = title;
                    labelEl.textContent = label;
                    card.appendChild(labelEl);

                    row.appendChild(card);
                });

                zone.appendChild(row);

                // Create a bottom control bar
                const bottomBar = document.createElement('div');
                bottomBar.style.cssText = 'flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:4px 10px 6px; border-top:1px solid rgba(255,255,255,0.05); background: rgba(0,0,0,0.1);';
                
                const badge = document.createElement('span');
                badge.style.cssText = 'font-size:10px; font-weight:700; color:var(--accent,#6c5fa6);';
                badge.textContent = `📎 ${refs.length}`;
                bottomBar.appendChild(badge);

                const spacer = document.createElement('span');
                spacer.style.flex = '1 1 auto';
                bottomBar.appendChild(spacer);

                const clearBtn = document.createElement('button');
                clearBtn.className = 'vp-btn vp-btn-sm';
                clearBtn.id = 'vp-as-clear-refs';
                clearBtn.style.cssText = 'height:20px; padding:0 8px; font-size:10px; cursor: pointer;';
                clearBtn.textContent = '✕ Clear';
                clearBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.data.reference = [];
                    this._syncDropzoneUI();
                    VP_AS.Graph.persist();
                });
                bottomBar.appendChild(clearBtn);

                zone.appendChild(bottomBar);
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
            // Try gallery assets first (vp/asset-move-batch): store lightweight tag links.
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

            // Direct file drop into Prompt Node: first import into Gallery active tab,
            // then store only {type:'gallery', tag}. Prompt Node must never own
            // image bytes or physical paths.
            const files = Array.from(dataTransfer?.files || []).filter(f => f?.type?.startsWith('image/'));
            if (files.length) {
                if (!VP.gallery?.addImageFromBlob) {
                    VP.showToast?.('Gallery is not ready; reference was not attached', 'error');
                    return;
                }
                const tags = [];
                for (const file of files.slice(0, 8)) {
                    const tag = await VP.gallery.addImageFromBlob(file, {
                        source: 'reference',
                        suggestedName: file.name || 'reference.png',
                        setAsCurrent: false,
                        instantPersist: true,
                    });
                    if (tag) tags.push(tag);
                }
                if (tags.length) {
                    await this._addGalleryRefs(tags);
                    VP.showToast?.(`Imported ${tags.length} reference image${tags.length === 1 ? '' : 's'} to gallery`, 'success');
                } else {
                    VP.showToast?.('Reference import failed; nothing was attached', 'error');
                }
                return;
            }

            // Strict v2 contract: no legacy path/blob/base64/drop-url references.
            // Use Gallery as the single owner of assets, then attach Gallery refs.
            VP.showToast?.('Drop image files or Gallery assets only. Legacy reference paths are disabled.', 'warn');
        }

        async _addGalleryRefs(tags) {
            if (!Array.isArray(this.data.reference)) this.data.reference = [];
            let added = 0;
            for (const tag of tags) {
                if (!tag || !VP.state?.gallery?.has?.(tag)) continue;
                const ref = this._makeGalleryRef(tag);
                if (this._hasRef(ref)) continue;
                this.data.reference.push(ref);
                added++;
            }
            if (added) {
                this._syncDropzoneUI();
                await VP_AS.Graph.persist();
                VP.showToast?.(`Added ${added} gallery reference${added === 1 ? '' : 's'}`, 'success');
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

        _selectVariant(variantId) {
            if (!this.data.variants.some(v => v.id === variantId)) return;
            const wasSame = this.data.activeVariantId === variantId;
            if (wasSame) return;

            // Save current editor text before switching
            const body = this.element?.querySelector('.vp-as-pill-stack');
            const ta = body?.querySelector('.vp-as-variant-textarea');
            const activeVariant = this.getActiveVariant();
            if (ta && activeVariant) {
                activeVariant.text = ta.value;
            }

            this.data.activeVariantId = variantId;

            // Re-render editor and tab bar
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        _addVariant() {
            const baseName = 'variant';
            const names = this.data.variants.map(v => v.name);
            let n = 1, name = `${baseName}_${n}`;
            while (names.includes(name)) { n++; name = `${baseName}_${n}`; }

            const varId = utils.uid('variant');
            this.data.variants.push({ id: varId, name, text: '{name:new_asset} ' });
            this.data.activeVariantId = varId;

            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        _deleteVariant(variantId) {
            if (this.data.variants.length <= 1) {
                VP.showToast?.('Need at least one variant', 'warn');
                return;
            }
            this.data.variants = this.data.variants.filter(v => v.id !== variantId);
            if (this.data.activeVariantId === variantId) {
                this.data.activeVariantId = this.data.variants[0].id;
            }

            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) {
                this._renderTabBar(body);
                this._renderEditor(body);
            }
            VP_AS.Graph.persist();
        }

        async _renameVariantInteractive(variantId) {
            const variant = this.data.variants.find(v => v.id === variantId);
            if (!variant) return;

            const newName = await VP.showPrompt?.({
                title: 'Rename variant',
                message: 'Variant name (used for organization only):',
                value: variant.name,
                placeholder: 'smile, angry, sad...',
                confirmLabel: 'Rename',
                required: true,
            });
            if (newName == null) return;
            const trimmed = newName.trim();
            if (!trimmed || trimmed === variant.name) return;

            variant.name = trimmed;
            const body = this.element?.querySelector('.vp-as-pill-stack');
            if (body) this._renderTabBar(body);
            VP_AS.Graph.persist();
        }

        // ── process() — вызывается при Graph.produce() ──
        process(bag) {
            this._syncActiveEditorText();
            this._migrateIfNeeded();
            const activeVariant = this.getActiveVariant();
            if (!activeVariant) return;

            // Извлекаем {name:...} и чистим все {...}
            const { name: assetName, clean: cleanText } = this.extractName(activeVariant.text);

            // Сохраняем имя ассета в bag.meta
            if (assetName) {
                bag.meta.set('assetName', assetName);
            }

            // Positive prompt — из активного варианта
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
                if (VARIANT_EXCLUDED_KEYS.has(def.key)) continue;
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
            const data = this._promptJsonData();
            return {
                type: this.type,
                id: this.id,
                x: this.x,
                y: this.y,
                width: this.width,
                height: this.height,
                data,
            };
        }

        deserialize(state) {
            super.deserialize(state);
            // Сохраняем reference отдельно, т.к. super.deserialize может перезатереть
            if (state?.data?.reference && Array.isArray(state.data.reference)) {
                this.data.reference = state.data.reference.map(r => (r && typeof r === 'object') ? { ...r } : r);
            }
            if (state?.data?.tabs && Array.isArray(state.data.tabs)) {
                this.data.tabs = state.data.tabs.map(t => ({ ...t }));
                this.data.activeTabId = state.data.activeTabId || this.data.tabs[0]?.id || null;
            }
            if (state?.data?.variants && Array.isArray(state.data.variants)) {
                this.data.variants = state.data.variants.map(v => ({ ...v }));
                this.data.activeVariantId = state.data.activeVariantId || this.data.variants[0]?.id || null;
            }
            this._migrateIfNeeded();
        }
    }

    NodeRegistry.register('prompt', PromptNode, { title: 'Prompt', icon: '💬', color: '#e06b9f' });
})();
