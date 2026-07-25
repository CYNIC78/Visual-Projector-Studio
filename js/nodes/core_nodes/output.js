// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/output.js                                            ║
// ║  Asset Studio — Output / preview sink tower.                     ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeBase, NodeRegistry, Arg } = VP_AS;
    const TOWER = 'output';

    class OutputNode extends NodeBase {
        constructor(id, x, y) {
            super('output', id, x, y);
            this.title = 'Output';
            this.color = '#c88735';
            this.height = 340;
            this.resizeMode = 'both';
            this.isVisual = true;
            this.data = { lastImage: null };
        }

        defineSockets() {
            this.inputs = [{ id: 'in', label: 'In', hint: 'Image argument stream' }];
        }

        renderBody(body) {
            body.classList.add('vp-as-pill-stack', 'vp-as-output-body');
            this._renderPills(body);
            this._renderAddButton(body);
            
            // --- Gallery Target Tab Selector ---
            this._renderGalleryTabSelector(body);
            
            const preview = document.createElement('div');
            preview.className = 'vp-as-output-preview';
            preview.innerHTML = '<div class="vp-as-output-placeholder">No result yet<br><small>Resize this node vertically for larger compare space</small></div>';
            const openBtn = document.createElement('button');
            openBtn.className = 'vp-btn vp-btn-sm vp-as-output-open';
            openBtn.textContent = 'Open in Gallery';
            openBtn.disabled = true;
            openBtn.addEventListener('click', () => {
                console.log('[Asset Studio] Open in Gallery requested:', this.data.lastImage);
                VP.showToast?.('Gallery integration is a stub', 'info');
            });
            body.appendChild(preview);
            body.appendChild(openBtn);
        }

        _renderGalleryTabSelector(body) {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'padding:8px 8px 0; display:flex; flex-direction:column; gap:4px;';
            const label = document.createElement('label');
            label.style.cssText = 'font-size:10px; color:var(--text-secondary,#a6adc8); font-weight:700; text-transform:uppercase; letter-spacing:0.04em;';
            label.textContent = 'Gallery Target Tab';
            
            const select = document.createElement('select');
            select.className = 'vp-as-pill-select';
            select.style.cssText = 'width:100%; border-radius:4px; border:1px solid rgba(255,255,255,0.12); background:rgba(0,0,0,0.22); color:var(--text-primary); padding:3px 6px; font-size:11px;';
            
            const populate = () => {
                select.innerHTML = '<option value="">(Default active tab)</option>';
                const tabs = window.VP?.state?.galleryData?.tabs || [];
                for (const tab of tabs) {
                    const opt = document.createElement('option');
                    opt.value = tab.id;
                    opt.textContent = tab.name || tab.id;
                    select.appendChild(opt);
                }
                if (this.data.galleryTabId) {
                    select.value = this.data.galleryTabId;
                }
            };
            
            populate();
            
            select.addEventListener('change', () => {
                this.data.galleryTabId = select.value || null;
                VP_AS.Graph.persist();
            });
            
            // Listen for gallery tab changes (e.g. if the user creates a new tab outside)
            const updateHandler = () => populate();
            window.VP_HUB?.on?.('gallery:sync-settings-ui', updateHandler);
            
            wrap.appendChild(label);
            wrap.appendChild(select);
            body.appendChild(wrap);
        }

        _renderPills(body) {
            body.querySelectorAll('.vp-as-pill').forEach(el => el.remove());
            const defs = Arg.getTowerArgs(TOWER).filter(d => d.key in this.data);
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
                        this._renderPills(body);
                        this._renderAddButton(body);
                        VP_AS.Graph.persist();
                    }
                });
                body.appendChild(pill.el);
            }
        }

        _renderAddButton(body) {
            const existing = body.querySelector('.vp-as-add-arg');
            if (existing) existing.remove();
            const currentKeys = Object.keys(this.data).filter(k => k !== 'lastImage');
            const defs = Arg.getMissingTowerArgs(TOWER, currentKeys);
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
                    this._renderPills(body);
                    this._renderAddButton(body);
                    VP_AS.Graph.persist();
                });
            });
            wrap.appendChild(btn);
            body.appendChild(wrap);
        }

        setPreview(url, body) {
            const wrap = (body || this.element)?.querySelector('.vp-as-output-preview')
                || (body?.parentElement || this.element?.parentElement || document)?.querySelector(`[data-node-id="${this.id}"] .vp-as-output-preview`);
            if (!wrap) {
                console.warn('[OutputNode] setPreview: .vp-as-output-preview not found for node', this.id);
                return;
            }
            if (url) {
                wrap.innerHTML = `<img src="${url}" alt="result">`;
                this.data.lastImage = url;
            } else {
                wrap.innerHTML = `<div class="vp-as-output-placeholder">No result yet</div>`;
            }
        }

        process(bag) {
            let outPath = this.data.outputPath ? String(this.data.outputPath).trim() : '';
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            
            if (outPath) {
                const lower = outPath.toLowerCase();
                const hasExt = lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') || lower.endsWith('.webp');
                
                if (!hasExt) {
                    // It is a directory path! (e.g. "r:/Temp" or "./output")
                    // Automatically append a unique, timestamp-based filename!
                    const separator = (outPath.includes('\\') && !outPath.includes('/')) ? '\\' : '/';
                    if (!outPath.endsWith('/') && !outPath.endsWith('\\')) {
                        outPath += separator;
                    }
                    outPath += `asset-studio-${stamp}.png`;
                }
                bag.set('-o', outPath);
            } else {
                bag.set('-o', `./output/asset-studio-${stamp}.png`);
            }
            for (const def of Arg.getTowerArgs('output')) {
                if (def.key === 'outputPath') continue;
                if (!(def.key in this.data)) continue;
                const v = this.data[def.key];
                if (v === '' || v == null) continue;
                bag.set(def.flag, v);
            }
        }
    }

    NodeRegistry.register('output', OutputNode, { title: 'Output', icon: '🖼️', color: '#c88735' });
})();
