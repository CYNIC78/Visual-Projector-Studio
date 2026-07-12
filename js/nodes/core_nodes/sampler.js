// ╔══════════════════════════════════════════════════════════════════╗
// ║  core_nodes/sampler.js                                           ║
// ║  Asset Studio — Sampler tower.                                   ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeBase, NodeRegistry, Arg } = VP_AS;
    const TOWER = 'sampler';
    const DEFAULT_KEYS = ['steps', 'cfg', 'seed', 'sampler', 'scheduler', 'width', 'height'];

    class SamplerNode extends NodeBase {
        constructor(id, x, y) {
            super('sampler', id, x, y);
            this.title = 'Sampler';
            this.color = '#45b883';
            this.height = 260;
        }

        defineSockets() {
            this.inputs = [{ id: 'in', label: 'In', hint: 'Argument stream' }];
            this.outputs = [{ id: 'out', label: 'Out', hint: 'Image argument stream' }];
        }

        _ensureDefaults() {
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (DEFAULT_KEYS.includes(def.key) && !(def.key in this.data)) {
                    this.data[def.key] = def.default ?? '';
                }
            }
        }

        renderBody(body) {
            body.classList.add('vp-as-pill-stack');
            this._ensureDefaults();
            this._renderPills(body);
            this._renderAddButton(body);
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
                    VP_AS.Graph.persist();
                });
            });
            wrap.appendChild(btn);
            body.appendChild(wrap);
        }

        process(bag) {
            for (const def of Arg.getTowerArgs(TOWER)) {
                if (!(def.key in this.data)) continue;
                const v = this.data[def.key];
                if (v === '' || v == null) continue;
                if (def.key === 'scheduler' && v === 'default') continue;
                bag.set(def.flag, v);
            }
        }
    }

    NodeRegistry.register('sampler', SamplerNode, { title: 'Sampler', icon: '⚙️', color: '#45b883' });
})();
