// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/prompt.js                                            ║
// ║  Asset Studio — Prompt tower.                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeBase, NodeRegistry, Arg, utils } = VP_AS;
    const TOWER = 'prompt';
    const DEFAULT_KEYS = ['positive', 'negative'];

    class PromptNode extends NodeBase {
        constructor(id, x, y) {
            super('prompt', id, x, y);
            this.title = 'Prompt';
            this.color = '#e06b9f';
            this.height = 320;
            this.resizeMode = 'both';
            this.isVisual = true;
        }

        defineSockets() {
            this.inputs = [{ id: 'in', label: 'In', hint: 'Argument stream' }];
            this.outputs = [{ id: 'out', label: 'Out', hint: 'Argument stream' }];
        }

        _ensureDefaults() {
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (DEFAULT_KEYS.includes(def.key) && !(def.key in this.data)) {
                    this.data[def.key] = def.default ?? '';
                }
            }
        }

        renderBody(body) {
            body.classList.add('vp-as-pill-stack', 'vp-as-prompt-body');
            this._ensureDefaults();
            this._renderPills(body);
            this._renderAddButton(body);
            this._renderDropzone(body);
        }

        _renderDropzone(body) {
            const existing = body.querySelector('.vp-as-node-dropzone');
            if (existing) existing.remove();
            if ('reference' in this.data) return;

            const zone = document.createElement('div');
            zone.className = 'vp-as-node-dropzone';
            zone.innerHTML = `<b>Reference Images</b><span>Drop source / refs here to create the reference pill</span>`;
            const setState = (active) => zone.classList.toggle('is-active', !!active);
            zone.addEventListener('dragover', (e) => {
                e.preventDefault();
                setState(true);
            });
            zone.addEventListener('dragleave', (e) => {
                if (!zone.contains(e.relatedTarget)) setState(false);
            });
            zone.addEventListener('drop', async (e) => {
                e.preventDefault();
                setState(false);
                const refs = await utils.extractDroppedImageRefs(e.dataTransfer, 8);
                if (!refs.length) {
                    VP.showToast?.('Unsupported drop payload', 'warn');
                    return;
                }
                if (!Array.isArray(this.data.reference)) this.data.reference = [];
                let added = 0;
                for (const ref of refs) {
                    if (!this.data.reference.includes(ref)) {
                        this.data.reference.push(ref);
                        added += 1;
                    }
                }
                if (!added) {
                    VP.showToast?.('These references are already attached', 'info');
                    return;
                }
                this._renderPills(body);
                this._renderAddButton(body);
                this._renderDropzone(body);
                await VP_AS.Graph.persist();
                VP.showToast?.(`Attached ${added} reference image${added === 1 ? '' : 's'}`, 'success');
            });
            body.appendChild(zone);
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
                        this._renderDropzone(body);
                        VP_AS.Graph.persist();
                    }
                });
                body.appendChild(pill.el);
            }
        }

        _renderAddButton(body) {
            const existing = body.querySelector('.vp-as-add-arg');
            if (existing) existing.remove();
            const currentKeys = Object.keys(this.data);
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
                    this._renderDropzone(body);
                    VP_AS.Graph.persist();
                });
            });
            wrap.appendChild(btn);
            body.appendChild(wrap);
        }

        process(bag) {
            let hasPositive = false;
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (!(def.key in this.data)) continue;
                let v = this.data[def.key];
                
                if (def.flag === '-p') {
                    hasPositive = true;
                    if (bag.loraTags && bag.loraTags.length > 0) {
                        v = (v || '') + (v ? ' ' : '') + bag.loraTags.join(' ');
                    }
                }
                
                if (v === '' || v == null) continue;
                
                if (def.control === 'multi-file') {
                    const arr = Array.isArray(v) ? v : (v ? [v] : []);
                    for (const path of arr) bag.addMulti(def.flag, path);
                } else {
                    bag.set(def.flag, v);
                }
            }
            
            // If the user deleted the positive prompt pill entirely, but we have lora tags, inject them
            if (!hasPositive && bag.loraTags && bag.loraTags.length > 0) {
                bag.set('-p', bag.loraTags.join(' '));
            }
        }
    }

    NodeRegistry.register('prompt', PromptNode, { title: 'Prompt', icon: '💬', color: '#e06b9f' });
})();
