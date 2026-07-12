// ╔══════════════════════════════════════════════════════════════════╗
// ║  as-graph.js                                                     ║
// ║  Asset Studio — LinkSystem and Graph orchestration.              ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    const VP_AS = window.VP_AS;
    if (!VP || !VP_AS) return;

    const { NodeRegistry, Viewport, utils, ARG } = VP_AS;
    const { uid } = utils;

    // ════════════════════════════════════════════════════════════════
    //  LINK SYSTEM
    // ════════════════════════════════════════════════════════════════
    class LinkSystem {
        constructor(canvas, svg, viewport, graph) {
            this.canvas = canvas;
            this.svg = svg;
            this.viewport = viewport;
            this.graph = graph;
            this.links = [];
            this.drafting = null;
            this.onChange = null;
        }

        add(link) {
            this.links = this.links.filter(l => !(l.toNode === link.toNode && l.toSocket === link.toSocket));
            this.links.push({ ...link, id: link.id || uid('link') });
            this._render();
            if (this.onChange) this.onChange();
        }

        removeById(id) {
            this.links = this.links.filter(l => l.id !== id);
            this._render();
            if (this.onChange) this.onChange();
        }

        removeAllForNode(nodeId) {
            this.links = this.links.filter(l => l.fromNode !== nodeId && l.toNode !== nodeId);
            this._render();
            if (this.onChange) this.onChange();
        }

        startDraft(fromNode, fromSocket, x, y) {
            this.drafting = { fromNode, fromSocket, x, y };
            this._render();
        }

        updateDraft(x, y) {
            if (!this.drafting) return;
            this.drafting.x = x;
            this.drafting.y = y;
            this._render();
        }

        finishDraft(toNode, toSocket) {
            if (!this.drafting) return false;
            const link = {
                fromNode: this.drafting.fromNode,
                fromSocket: this.drafting.fromSocket,
                toNode,
                toSocket,
            };
            this.drafting = null;
            if (link.fromNode === link.toNode) return false;
            this.add(link);
            return true;
        }

        cancelDraft() {
            this.drafting = null;
            this._render();
        }

        _render() {
            this.svg.innerHTML = '';
            const canvasRect = this.canvas.getBoundingClientRect();
            this.svg.setAttribute('width', canvasRect.width);
            this.svg.setAttribute('height', canvasRect.height);

            for (const link of this.links) {
                const fromPos = this.graph.getNode(link.fromNode)?.getSocketRect(link.fromSocket, 'output');
                const toPos = this.graph.getNode(link.toNode)?.getSocketRect(link.toSocket, 'input');
                if (!fromPos || !toPos) continue;
                this._drawPath(fromPos.x, fromPos.y, toPos.x, toPos.y, link.id);
            }

            if (this.drafting) {
                const fromPos = this.graph.getNode(this.drafting.fromNode)?.getSocketRect(this.drafting.fromSocket, 'output');
                if (fromPos) {
                    this._drawPath(fromPos.x, fromPos.y, this.drafting.x, this.drafting.y, null, true);
                }
            }
        }

        _drawPath(x1, y1, x2, y2, id, draft = false) {
            const dx = Math.abs(x2 - x1) * 0.5;
            const d = `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            path.setAttribute('class', draft ? 'vp-as-link vp-as-link-draft' : 'vp-as-link');
            if (id) {
                path.dataset.linkId = id;
                path.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.removeById(id);
                });
                path.addEventListener('click', () => this.removeById(id));
            }
            this.svg.appendChild(path);
        }

        serialize() {
            return this.links.map(l => ({
                fromNode: l.fromNode,
                fromSocket: l.fromSocket,
                toNode: l.toNode,
                toSocket: l.toSocket,
            }));
        }

        deserialize(list) {
            this.links = (list || []).map(l => ({ ...l, id: uid('link') }));
            this._render();
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  GRAPH
    // ════════════════════════════════════════════════════════════════
    const Graph = {
        nodes: new Map(),
        links: null,
        canvas: null,
        world: null,
        svg: null,
        viewport: null,
        nextPos: { x: 40, y: 40 },
        selectedNodeId: null,
        clipboard: null,
        _loadingState: false,

        init(canvas, svg) {
            if (this._resizeObserver) {
                try { this._resizeObserver.disconnect(); } catch {}
                this._resizeObserver = null;
            }
            if (this._resizeHandler) {
                window.removeEventListener('resize', this._resizeHandler);
                this._resizeHandler = null;
            }
            if (this._resizePersistTimer) {
                clearTimeout(this._resizePersistTimer);
                this._resizePersistTimer = null;
            }

            this.canvas = canvas;
            this.svg = svg;
            this.world = document.createElement('div');
            this.world.className = 'vp-as-world';
            this.world.style.cssText = 'position:absolute; left:0; top:0; width:0; height:0; transform-origin:0 0; z-index:2;';
            this.canvas.appendChild(this.world);

            this.viewport = new Viewport(canvas, this.world);
            this.viewport.onChange = () => this.links._render();
            this.viewport.onFrameAll = () => this.viewport.frameNodes(Array.from(this.nodes.values()));

            this.links = new LinkSystem(canvas, svg, this.viewport, this);
            this.links.onChange = () => this.persist();

            this._resizeHandler = () => {
                const changed = this.viewport?.handleResize?.({
                    preserveCenter: this.nodes.size > 0 || Math.abs(this.viewport?.x || 0) > 0.001 || Math.abs(this.viewport?.y || 0) > 0.001 || Math.abs((this.viewport?.scale || 1) - 1) > 0.001,
                });
                this.links?._render?.();
                if (changed) {
                    clearTimeout(this._resizePersistTimer);
                    this._resizePersistTimer = setTimeout(() => this.persist(), 160);
                }
            };

            window.addEventListener('resize', this._resizeHandler);
            if (window.ResizeObserver) {
                this._resizeObserver = new ResizeObserver(() => this._resizeHandler());
                this._resizeObserver.observe(this.canvas);
            }
            requestAnimationFrame(() => this._resizeHandler());
        },

        getNode(id) { return this.nodes.get(id); },

        addNode(type, x, y, initData) {
            const node = NodeRegistry.create(type, null, x ?? this.nextPos.x, y ?? this.nextPos.y);
            if (initData) Object.assign(node.data, initData);
            this.nextPos.x += 40;
            this.nextPos.y += 40;
            if (this.nextPos.x > 300) { this.nextPos.x = 40; this.nextPos.y += 80; }

            node.onMove = () => this.links._render();
            node.onMoved = () => this.persist();

            const ctx = {
                viewport: this.viewport,
                onSocketMouseDown: (e, n, sock, kind) => this.onSocketMouseDown(e, n, sock, kind),
            };
            const el = node.render(this.world, ctx);
            el.addEventListener('mousedown', () => this.selectNode(node.id));
            this.nodes.set(node.id, node);
            this.persist();
            return node;
        },

        removeNode(id) {
            const node = this.nodes.get(id);
            if (!node) return;
            node.dispose();
            this.nodes.delete(id);
            this.links.removeAllForNode(id);
            if (this.selectedNodeId === id) this.selectNode(null);
            this.persist();
        },

        selectNode(id) {
            if (this.selectedNodeId) {
                const old = this.nodes.get(this.selectedNodeId);
                if (old && old.element) old.element.classList.remove('selected');
            }
            this.selectedNodeId = id;
            if (id) {
                const node = this.nodes.get(id);
                if (node && node.element) {
                    node.element.classList.add('selected');
                    node.element.style.zIndex = '100';
                    // send others back to 2
                    for (const [nid, n] of this.nodes) {
                        if (nid !== id && n.element) n.element.style.zIndex = '2';
                    }
                }
            }
        },

        clear() {
            for (const node of this.nodes.values()) node.dispose();
            this.nodes.clear();
            this.links.links = [];
            this.selectedNodeId = null;
            this.links._render();
            this.nextPos = { x: 40, y: 40 };
            if (!this._loadingState) this.persist();
        },

        onSocketMouseDown(e, node, socket, kind) {
            e.stopPropagation();
            const rect = this.canvas.getBoundingClientRect();
            
            let fromNodeId = node.id;
            let fromSocketId = socket.id;
            
            if (kind === 'input') {
                const existing = this.links.links.find(l => l.toNode === node.id && l.toSocket === socket.id);
                if (existing) {
                    fromNodeId = existing.fromNode;
                    fromSocketId = existing.fromSocket;
                    this.links.removeById(existing.id);
                } else {
                    return; // Currently only dragging out of outputs or existing input links is supported
                }
            }

            const fromNode = this.nodes.get(fromNodeId);
            const fromPos = fromNode.getSocketRect(fromSocketId, 'output') || { x: e.clientX - rect.left, y: e.clientY - rect.top };
            
            this.links.startDraft(fromNodeId, fromSocketId, fromPos.x, fromPos.y);

            // Pre-calculate snap targets
            const inputSockets = [];
            for (const n of this.nodes.values()) {
                if (n.id === fromNodeId) continue;
                for (const inp of n.inputs) {
                    const pos = n.getSocketRect(inp.id, 'input');
                    if (pos) {
                        const el = n.element.querySelector(`[data-socket-id="${inp.id}"][data-socket-kind="input"]`);
                        if (el) inputSockets.push({ nodeId: n.id, socketId: inp.id, pos, el });
                    }
                }
            }

            let snappedTo = null;

            const onMove = (ev) => {
                let mx = ev.clientX - rect.left;
                let my = ev.clientY - rect.top;
                
                snappedTo = null;
                let minDist = 40; // Magnet radius
                
                for (const sock of inputSockets) {
                    sock.el.classList.remove('vp-as-socket-snapped');
                    const dx = sock.pos.x - mx;
                    const dy = sock.pos.y - my;
                    const dist = Math.sqrt(dx*dx + dy*dy);
                    if (dist < minDist) {
                        minDist = dist;
                        snappedTo = sock;
                    }
                }
                
                if (snappedTo) {
                    snappedTo.el.classList.add('vp-as-socket-snapped');
                    mx = snappedTo.pos.x;
                    my = snappedTo.pos.y;
                }
                
                this.links.updateDraft(mx, my);
            };

            const onUp = (ev) => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                
                for (const sock of inputSockets) {
                    sock.el.classList.remove('vp-as-socket-snapped');
                }

                if (snappedTo) {
                    if (!this.links.finishDraft(snappedTo.nodeId, snappedTo.socketId)) this.links.cancelDraft();
                } else {
                    const target = ev.target.closest('.vp-as-socket.input');
                    if (target) {
                        const toNode = target.dataset.nodeId;
                        const toSocket = target.dataset.socketId;
                        if (!this.links.finishDraft(toNode, toSocket)) this.links.cancelDraft();
                    } else {
                        this.links.cancelDraft();
                    }
                }
            };
            
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        },

        produce() {
            const outputNodes = Array.from(this.nodes.values()).filter(n => n.type === 'output');
            if (!outputNodes.length) {
                VP.showToast?.('Add an Output node first', 'warn');
                return null;
            }

            const bag = new ARG.ArgumentBag();
            const visited = new Set();

            const visit = (node) => {
                if (visited.has(node.id)) return;
                visited.add(node.id);

                for (const input of node.inputs || []) {
                    const incoming = this.links.links.find(l => l.toNode === node.id && l.toSocket === input.id);
                    if (incoming) {
                        const dep = this.nodes.get(incoming.fromNode);
                        if (dep) visit(dep);
                    }
                }

                node.process(bag);
            };

            for (const out of outputNodes) visit(out);
            return bag;
        },

        serialize() {
            return {
                nodes: Array.from(this.nodes.values()).map(n => n.serialize()),
                links: this.links.serialize(),
                nextPos: { ...this.nextPos },
                viewport: this.viewport.serialize(),
            };
        },

        deserialize(state) {
            this._loadingState = true;
            this.clear();
            if (!state) { this._loadingState = false; return; }
            this.nextPos = state.nextPos || { x: 40, y: 40 };
            if (state.viewport) this.viewport.deserialize(state.viewport);

            for (const nstate of state.nodes || []) {
                const node = NodeRegistry.create(nstate.type, nstate.id, nstate.x, nstate.y);
                node.deserialize(nstate);
                node.onMove = () => this.links._render();
                node.onMoved = () => this.persist();
                const ctx = {
                    viewport: this.viewport,
                    onSocketMouseDown: (e, n, sock, kind) => this.onSocketMouseDown(e, n, sock, kind),
                };
                const el = node.render(this.world, ctx);
                el.addEventListener('mousedown', () => this.selectNode(node.id));
                this.nodes.set(node.id, node);
            }

            this.links.deserialize(state.links);
            this._loadingState = false;
            this.persist();
        },

        persist() {
            if (this.onPersist) this.onPersist();
            else VP.schedulePersist?.();
        },
    };

    window.VP_AS.Graph = Graph;
})();
