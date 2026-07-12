// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/lora.js                                              ║
// ║  Asset Studio — LoRA Stack tower.                                ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeBase, NodeRegistry, Arg, utils } = VP_AS;
    const { pickFile, normPath } = utils;
    const TOWER = 'lora';

    class LoRAStackNode extends NodeBase {
        constructor(id, x, y) {
            super('lora', id, x, y);
            this.title = 'LoRA Stack';
            this.color = '#4f8cff';
            this.height = 160;
            this.data = { items: [] };
        }

        defineSockets() {
            this.inputs = [{ id: 'in', label: 'In', hint: 'Argument stream' }];
            this.outputs = [{ id: 'out', label: 'Out', hint: 'Argument stream with LoRAs' }];
        }

        renderBody(body) {
            body.classList.add('vp-as-pill-stack');
            
            this.pillsWrap = document.createElement('div');
            this.pillsWrap.className = 'vp-as-pill-stack';
            body.appendChild(this.pillsWrap);
            this._renderPills();

            this.listWrap = document.createElement('div');
            this.listWrap.className = 'vp-as-pill-stack';
            this.listWrap.style.marginTop = '8px';
            body.appendChild(this.listWrap);
            this._renderItems();

            const btns = document.createElement('div');
            btns.style.display = 'flex';
            btns.style.gap = '8px';
            btns.style.marginTop = '8px';
            this.btnsWrap = btns;
            
            const addBtn = document.createElement('button');
            addBtn.className = 'vp-btn vp-btn-sm';
            addBtn.style.flex = '1';
            addBtn.textContent = '＋ Add LoRA';
            addBtn.addEventListener('click', async () => {
                let path = null;
                if (window.VisualProjector?.assetStudio?.pickLibraryModel) {
                    path = await window.VisualProjector.assetStudio.pickLibraryModel('lora', {
                        title: 'Select LoRA',
                        accept: '.safetensors,.pt,.ckpt',
                    });
                }
                if (path === '__BROWSE_FILE__') {
                    path = await pickFile({
                        title: 'Select LoRA',
                        filters: [{ name: 'LoRA files', extensions: ['safetensors', 'pt', 'ckpt'] }],
                        accept: '.safetensors,.pt,.ckpt',
                    });
                }
                if (!path) return;
                this.data.items.push({ file: normPath(path), weight: 1.0 });
                this._renderItems();
                await VP_AS.Graph.persist();
            });
            btns.appendChild(addBtn);
            body.appendChild(btns);
            
            this._renderAddButton();
        }

        _renderPills() {
            this.pillsWrap.innerHTML = '';
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
                });
                pill.el.querySelector('.vp-as-pill-body').appendChild(this._makeDeleteBtn(def.key));
                this.pillsWrap.appendChild(pill.el);
            }
        }

        _makeDeleteBtn(key) {
            const btn = document.createElement('button');
            btn.className = 'vp-btn vp-btn-sm vp-as-pill-del';
            btn.textContent = '✕ Remove argument';
            btn.addEventListener('click', () => {
                delete this.data[key];
                this._renderPills();
                this._renderAddButton();
                VP_AS.Graph.persist();
            });
            return btn;
        }

        _renderAddButton() {
            const existing = this.btnsWrap.querySelector('.vp-as-add-arg');
            if (existing) existing.remove();
            const currentKeys = Object.keys(this.data).filter(k => k !== 'items');
            const defs = Arg.getMissingTowerArgs(TOWER, currentKeys);
            if (!defs.length) return;
            
            const wrap = document.createElement('div');
            wrap.className = 'vp-as-add-arg';
            wrap.style.flex = '1';
            const btn = document.createElement('button');
            btn.className = 'vp-btn vp-btn-sm';
            btn.style.width = '100%';
            btn.textContent = '＋ Add config';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                Arg.showAddMenu(btn, defs, (def) => {
                    this.data[def.key] = def.control === 'multi-file' ? [] : (def.default ?? '');
                    this._renderPills();
                    this._renderAddButton();
                    VP_AS.Graph.persist();
                });
            });
            wrap.appendChild(btn);
            this.btnsWrap.appendChild(wrap);
        }

        _renderItems() {
            this.listWrap.innerHTML = '';
            this.data.items.forEach((item, idx) => {
                const row = document.createElement('div');
                row.className = 'vp-as-lora-row';

                const picker = document.createElement('button');
                picker.type = 'button';
                picker.className = 'vp-as-lora-picker';
                picker.innerHTML = `<span class="vp-as-lora-picker-name"></span><span class="vp-as-lora-picker-caret">▾</span>`;
                const nameEl = picker.querySelector('.vp-as-lora-picker-name');
                const applyFile = (rawPath) => {
                    const clean = normPath(rawPath || '');
                    item.file = clean;
                    nameEl.textContent = clean ? clean.split('/').pop() : 'Choose LoRA...';
                    picker.title = clean || 'Choose LoRA';
                    picker.classList.toggle('is-empty', !clean);
                };
                applyFile(item.file);
                picker.addEventListener('click', async () => {
                    let path = null;
                    if (window.VisualProjector?.assetStudio?.pickLibraryModel) {
                        path = await window.VisualProjector.assetStudio.pickLibraryModel('lora', {
                            title: 'Select LoRA',
                            currentValue: item.file || '',
                            accept: '.safetensors,.pt,.ckpt',
                        });
                    }
                    if (path === '__BROWSE_FILE__') {
                        path = await pickFile({
                            title: 'Select LoRA',
                            filters: [{ name: 'LoRA files', extensions: ['safetensors', 'pt', 'ckpt'] }],
                            accept: '.safetensors,.pt,.ckpt',
                        });
                    }
                    if (!path) return;
                    applyFile(path);
                    await VP_AS.Graph.persist();
                });

                const stepper = document.createElement('div');
                stepper.className = 'vp-as-lora-stepper';
                const minus = document.createElement('button');
                minus.type = 'button';
                minus.className = 'vp-as-lora-step-btn';
                minus.textContent = '−';
                const input = document.createElement('input');
                input.type = 'number';
                input.className = 'vp-as-lora-weight';
                input.value = item.weight ?? 1.0;
                input.step = '0.05';
                input.min = '-2';
                input.max = '2';
                const plus = document.createElement('button');
                plus.type = 'button';
                plus.className = 'vp-as-lora-step-btn';
                plus.textContent = '+';
                const clampWeight = (raw) => {
                    let v = parseFloat(raw);
                    if (Number.isNaN(v)) v = 1.0;
                    v = Math.max(-2, Math.min(2, v));
                    return Number(v.toFixed(2));
                };
                const commitWeight = (raw) => {
                    const next = clampWeight(raw);
                    item.weight = next;
                    input.value = String(next);
                    VP_AS.Graph.persist();
                };
                input.addEventListener('change', () => commitWeight(input.value));
                input.addEventListener('blur', () => commitWeight(input.value));
                minus.addEventListener('click', () => commitWeight((parseFloat(input.value) || 0) - 0.05));
                plus.addEventListener('click', () => commitWeight((parseFloat(input.value) || 0) + 0.05));
                stepper.appendChild(minus);
                stepper.appendChild(input);
                stepper.appendChild(plus);

                row.appendChild(picker);
                row.appendChild(stepper);

                row.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    VP_AS.ContextMenu.show(e.clientX, e.clientY, [
                        { label: 'Remove LoRA', danger: true, icon: '✕', action: () => {
                            this.data.items.splice(idx, 1);
                            this._renderItems();
                            VP_AS.Graph.persist();
                        }}
                    ]);
                });

                this.listWrap.appendChild(row);
            });
        }

        process(bag) {
            let loraTags = [];
            let loraDir = bag.get('--lora-model-dir');
            
            for (const item of this.data.items || []) {
                if (!item.file) continue;
                const pathParts = item.file.replace(/\\/g, '/').split('/');
                const filename = pathParts.pop();
                const basename = filename.replace(/\.[^/.]+$/, "");
                
                if (!loraDir && pathParts.length > 0) {
                    loraDir = pathParts.join('/');
                    bag.set('--lora-model-dir', loraDir);
                }
                loraTags.push(`<lora:${basename}:${item.weight}>`);
            }
            
            if (loraTags.length > 0) {
                if (!bag.loraTags) bag.loraTags = [];
                bag.loraTags.push(...loraTags);
            }
            
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (!(def.key in this.data)) continue;
                const v = this.data[def.key];
                if (v === '' || v == null || v === 'default') continue;
                bag.set(def.flag, v);
            }
        }
    }

    NodeRegistry.register('lora', LoRAStackNode, { title: 'LoRA Stack', icon: '🧩', color: '#4f8cff' });
})();
