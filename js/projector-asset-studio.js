// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-asset-studio.js                                       ║
// ║  Visual Projector — AI Asset Studio host                         ║
// ║  v2.1: split into nodes/ modules; this file is the panel manager ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP) return;

    const S = VP.state;
    const DB = window.VP_DB;
    const VP_AS = window.VP_AS;
    if (!VP_AS) {
        console.error('[Asset Studio] Node modules not loaded (VP_AS missing)');
        return;
    }

    const { Graph, NodeRegistry, Arg, utils } = VP_AS;

    // ════════════════════════════════════════════════════════════════
    //  ASSET STUDIO PANEL
    // ════════════════════════════════════════════════════════════════
    const AssetStudio = {
        running: false,
        progress: 0,
        config: {
            executablePath: './bin/sd.cpp/sd-cli.exe',
            outputDir: './output',
            engineMode: 'cli',
        },
        _activeCanvas: null,
        _activeContainer: null,
        _boundKeyHandler: null,

        updateStudioStatus(container, extra = '') {
            const host = container || this._activeContainer;
            const statusEl = host?.querySelector('#vp-as-status');
            if (!statusEl) return;
            const nodes = Graph?.nodes?.size || 0;
            const headline = extra || (this.running ? '⏳ Rendering' : 'Ready');
            statusEl.textContent = `${headline} · ${nodes} node${nodes === 1 ? '' : 's'} · ${(this.config.engineMode || 'cli').toUpperCase()}`;
        },

        syncPanelToggles(container) {
            const host = container || this._activeContainer;
            if (!host) return;
            const sidebar = host.querySelector('.vp-as-sidebar');
            const inspector = host.querySelector('.vp-as-inspector');
            const sidebarBtn = host.querySelector('#vp-as-toggle-sidebar');
            const inspectorBtn = host.querySelector('#vp-as-toggle-inspector');
            const hideInspectorBtn = host.querySelector('#vp-as-hide-inspector');
            if (sidebarBtn && sidebar) sidebarBtn.textContent = sidebar.classList.contains('collapsed') ? '☰ Nodes' : '✕ Nodes';
            if (inspectorBtn && inspector) inspectorBtn.textContent = inspector.classList.contains('collapsed') ? 'Log ☰' : 'Log ✕';
            if (hideInspectorBtn) hideInspectorBtn.style.display = inspector?.classList.contains('collapsed') ? 'none' : '';
        },

        ensureStudioState() {
            if (!S.assetStudio || typeof S.assetStudio !== 'object') S.assetStudio = {};
            if (!S.assetStudio.config) S.assetStudio.config = { ...this.config };
            if (!('graph' in S.assetStudio)) S.assetStudio.graph = null;
            if (!Array.isArray(S.assetStudio.workflows)) S.assetStudio.workflows = [];
            if (!('selectedWorkflowId' in S.assetStudio)) S.assetStudio.selectedWorkflowId = null;
            return S.assetStudio;
        },

        cloneData(value) {
            return JSON.parse(JSON.stringify(value));
        },

        refreshGraphUI(container = this._activeContainer) {
            if (!Graph?.nodes?.size) return;
            const snapshot = this.cloneData(Graph.serialize());
            const selectedId = Graph.selectedNodeId || null;
            Graph.deserialize(snapshot);
            if (selectedId) Graph.selectNode(selectedId);
            container?.querySelector('#vp-as-empty-hint')?.classList.add('hidden');
            this.renderWorkflowLibrary(container);
            this.updateStudioStatus(container);
        },

        getWorkflows() {
            return this.ensureStudioState().workflows;
        },

        getWorkflow(id) {
            return this.getWorkflows().find(w => w.id === id) || null;
        },

        getSelectedWorkflow() {
            const state = this.ensureStudioState();
            return state.selectedWorkflowId ? this.getWorkflow(state.selectedWorkflowId) : null;
        },

        setSelectedWorkflow(id) {
            this.ensureStudioState().selectedWorkflowId = id || null;
        },

        formatWorkflowStamp(ts) {
            if (!ts) return 'unsaved';
            try {
                return new Date(ts).toLocaleString();
            } catch {
                return 'unsaved';
            }
        },

        sanitizeWorkflowFilename(name = 'workflow') {
            return String(name || 'workflow')
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9а-яё._-]+/gi, '-')
                .replace(/^-+|-+$/g, '') || 'workflow';
        },

        async askText({ title = 'Input', message = '', value = '', placeholder = '', confirmLabel = 'OK', required = false } = {}) {
            if (typeof VP.showPrompt === 'function') {
                return VP.showPrompt({ title, message, value, placeholder, confirmLabel, required });
            }
            const res = window.prompt(message || title, value || '');
            return res == null ? null : String(res);
        },

        async askConfirm({ title = 'Confirm', message = '', confirmLabel = 'OK', danger = false } = {}) {
            if (typeof VP.showConfirm === 'function') {
                const res = await VP.showConfirm({
                    title,
                    message,
                    buttons: [
                        { id: 'cancel', label: 'Cancel', ghost: true },
                        { id: 'ok', label: confirmLabel, danger: !!danger },
                    ],
                });
                return res === 'ok';
            }
            return window.confirm(message || title);
        },

        renderWorkflowLibrary(container = this._activeContainer) {
            const host = container || this._activeContainer;
            const list = host?.querySelector('#vp-as-workflow-list');
            const selectedEl = host?.querySelector('#vp-as-selected-workflow');
            if (!list || !selectedEl) return;

            const workflows = this.getWorkflows();
            const selectedId = this.ensureStudioState().selectedWorkflowId || null;
            const selected = selectedId ? this.getWorkflow(selectedId) : null;
            selectedEl.textContent = selected ? `Selected: ${selected.title}` : 'Selected: none';

            list.innerHTML = '';
            if (!workflows.length) {
                const empty = document.createElement('div');
                empty.className = 'vp-as-workflow-empty';
                empty.textContent = 'No saved workflows yet';
                list.appendChild(empty);
                return;
            }

            for (const wf of workflows) {
                const row = document.createElement('div');
                row.className = 'vp-as-workflow-row' + (wf.id === selectedId ? ' active' : '');
                row.innerHTML = `
                    <button class="vp-as-workflow-main" type="button">
                        <span class="vp-as-workflow-title"></span>
                        <span class="vp-as-workflow-meta"></span>
                    </button>
                    <div class="vp-as-workflow-actions">
                        <button class="vp-btn vp-btn-sm" type="button" data-act="rename" title="Rename">✎</button>
                        <button class="vp-btn vp-btn-sm" type="button" data-act="delete" title="Delete">✕</button>
                    </div>`;
                row.querySelector('.vp-as-workflow-title').textContent = wf.title || 'Workflow';
                row.querySelector('.vp-as-workflow-meta').textContent = this.formatWorkflowStamp(wf.updatedAt || wf.createdAt);
                row.querySelector('.vp-as-workflow-main').addEventListener('click', () => this.loadWorkflowFromLibrary(wf.id));
                row.querySelector('[data-act="rename"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.renameWorkflowInteractive(wf.id);
                });
                row.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    await this.deleteWorkflowInteractive(wf.id);
                });
                list.appendChild(row);
            }
        },

        async saveWorkflowAsNewInteractive() {
            const selected = this.getSelectedWorkflow();
            const fallback = selected ? `${selected.title} Copy` : `Workflow ${this.getWorkflows().length + 1}`;
            const name = await this.askText({
                title: 'Save workflow as new',
                message: 'Workflow name:',
                value: fallback,
                placeholder: 'Workflow name',
                confirmLabel: 'Save',
                required: true,
            });
            if (name == null) return null;
            const trimmed = name.trim();
            if (!trimmed) return null;

            const state = this.ensureStudioState();
            const workflow = {
                id: utils?.uid ? utils.uid('wf') : `wf_${Date.now().toString(36)}`,
                title: trimmed,
                graph: this.cloneData(Graph.serialize()),
                createdAt: Date.now(),
                updatedAt: Date.now(),
            };
            state.workflows.push(workflow);
            state.selectedWorkflowId = workflow.id;
            this.saveStudioState();
            this.renderWorkflowLibrary();
            this.updateStudioStatus(this._activeContainer, `Saved: ${trimmed}`);
            VP.showToast?.(`Workflow saved: ${trimmed}`, 'success');
            return workflow;
        },

        async saveCurrentWorkflowInteractive() {
            const selected = this.getSelectedWorkflow();
            if (!selected) return this.saveWorkflowAsNewInteractive();
            selected.graph = this.cloneData(Graph.serialize());
            selected.updatedAt = Date.now();
            this.saveStudioState();
            this.renderWorkflowLibrary();
            this.updateStudioStatus(this._activeContainer, `Updated: ${selected.title}`);
            VP.showToast?.(`Workflow updated: ${selected.title}`, 'success');
            return selected;
        },

        loadWorkflowFromLibrary(id) {
            const workflow = this.getWorkflow(id);
            if (!workflow?.graph) return;
            Graph.deserialize(this.cloneData(workflow.graph));
            this.setSelectedWorkflow(workflow.id);
            this.saveStudioState();
            this.renderWorkflowLibrary();
            this.updateStudioStatus(this._activeContainer, `Loaded: ${workflow.title}`);
            VP.showToast?.(`Workflow loaded: ${workflow.title}`, 'success');
        },

        async renameWorkflowInteractive(id) {
            const workflow = this.getWorkflow(id);
            if (!workflow) return;
            const name = await this.askText({
                title: 'Rename workflow',
                message: 'New workflow name:',
                value: workflow.title || '',
                placeholder: 'Workflow name',
                confirmLabel: 'Rename',
                required: true,
            });
            if (name == null) return;
            const trimmed = name.trim();
            if (!trimmed || trimmed === workflow.title) return;
            workflow.title = trimmed;
            workflow.updatedAt = Date.now();
            this.saveStudioState();
            this.renderWorkflowLibrary();
            VP.showToast?.(`Workflow renamed: ${trimmed}`, 'success');
        },

        async deleteWorkflowInteractive(id) {
            const workflow = this.getWorkflow(id);
            if (!workflow) return;
            const ok = await this.askConfirm({
                title: 'Delete workflow?',
                message: `Delete workflow “${workflow.title}”?`,
                confirmLabel: 'Delete',
                danger: true,
            });
            if (!ok) return;
            const state = this.ensureStudioState();
            state.workflows = state.workflows.filter(w => w.id !== id);
            if (state.selectedWorkflowId === id) state.selectedWorkflowId = null;
            this.saveStudioState();
            this.renderWorkflowLibrary();
            this.updateStudioStatus(this._activeContainer, 'Workflow deleted');
            VP.showToast?.(`Workflow deleted: ${workflow.title}`, 'success');
        },

        async exportWorkflowToFile() {
            const state = Graph.serialize();
            const json = JSON.stringify(state, null, 2);
            const selected = this.getSelectedWorkflow();
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
            const baseName = this.sanitizeWorkflowFilename(selected?.title || `workflow-${stamp}`);
            const defaultName = `${baseName}.json`;

            try {
                if (window.Neutralino?.os?.showSaveDialog) {
                    const path = await Neutralino.os.showSaveDialog('Export Workflow JSON', {
                        defaultPath: defaultName,
                        filters: [{ name: 'JSON Workflow', extensions: ['json'] }]
                    });
                    if (path) {
                        await Neutralino.filesystem.writeFile(path, json);
                        VP.showToast?.('Workflow exported', 'success');
                    }
                } else {
                    const blob = new Blob([json], { type: 'application/json' });
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(blob);
                    a.download = defaultName;
                    a.click();
                    VP.showToast?.('Workflow downloaded', 'success');
                }
            } catch (err) {
                console.error('Export workflow failed:', err);
                VP.showToast?.('Failed to export workflow', 'error');
            }
        },

        async importWorkflowFromFile(container) {
            try {
                let jsonStr = null;
                if (window.Neutralino?.os?.showOpenDialog) {
                    const path = await Neutralino.os.showOpenDialog('Import Workflow JSON', {
                        filters: [{ name: 'JSON Workflow', extensions: ['json'] }]
                    });
                    const selected = Array.isArray(path) ? path[0] : (path?.selectedEntry || path);
                    if (!selected) return;
                    jsonStr = await Neutralino.filesystem.readFile(selected);
                } else {
                    jsonStr = await new Promise(resolve => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.json';
                        input.onchange = (e) => {
                            const file = e.target.files[0];
                            if (!file) return resolve(null);
                            const reader = new FileReader();
                            reader.onload = () => resolve(reader.result);
                            reader.readAsText(file);
                        };
                        input.click();
                    });
                }

                if (!jsonStr) return;
                const state = JSON.parse(jsonStr);
                Graph.deserialize(state);
                this.setSelectedWorkflow(null);
                this.saveStudioState();
                container?.querySelector('#vp-as-empty-hint')?.classList.add('hidden');
                this.renderWorkflowLibrary(container);
                this.updateStudioStatus(container, 'Workflow imported');
                VP.showToast?.('Workflow imported', 'success');
            } catch (err) {
                console.error('Import workflow failed:', err);
                VP.showToast?.('Failed to import workflow', 'error');
            }
        },

        getLibraryDefs() {
            return {
                core: { title: 'Core / Diffusion', extensions: ['gguf', 'safetensors', 'ckpt', 'pt', 'bin'] },
                text: { title: 'Text Encoders', extensions: ['gguf', 'safetensors', 'bin', 'pt'] },
                vae: { title: 'VAE', extensions: ['safetensors', 'ckpt', 'pt', 'bin'] },
                lora: { title: 'LoRA', extensions: ['safetensors', 'ckpt', 'pt'] },
            };
        },

        ensureModelLibraryConfig() {
            const defs = this.getLibraryDefs();
            if (!this.config.modelLibraries || typeof this.config.modelLibraries !== 'object') this.config.modelLibraries = {};
            for (const [kind] of Object.entries(defs)) {
                const current = this.config.modelLibraries[kind] || {};
                let paths = current.paths;
                if (typeof paths === 'string') paths = paths.split(/\r?\n/);
                if (!Array.isArray(paths)) paths = [];
                this.config.modelLibraries[kind] = {
                    paths: paths.map(x => utils.normPath(String(x || '').trim())).filter(Boolean),
                    recursive: current.recursive !== false,
                };
            }
            return this.config.modelLibraries;
        },

        getLibraryConfig(kind) {
            return this.ensureModelLibraryConfig()[kind];
        },

        serializeLibraryPaths(kind) {
            return (this.getLibraryConfig(kind)?.paths || []).join('\n');
        },

        updateLibraryPaths(kind, rawText) {
            const cfg = this.getLibraryConfig(kind);
            cfg.paths = String(rawText || '').split(/\r?\n/).map(x => utils.normPath(x.trim())).filter(Boolean);
            this.saveStudioState();
        },

        getLibraryStats(kind) {
            const idx = this._libraryCache?.[kind];
            return idx ? `${idx.totalFiles} file${idx.totalFiles === 1 ? '' : 's'}` : 'not scanned';
        },

        async readDirectorySafe(dir) {
            if (!window.Neutralino?.filesystem?.readDirectory) return [];
            const list = await Neutralino.filesystem.readDirectory(dir);
            const out = [];
            for (const raw of Array.isArray(list) ? list : []) {
                const name = raw.entry || raw.name || '';
                const full = utils.normPath(raw.path || (name ? `${dir}/${name}` : ''));
                let type = String(raw.type || '').toLowerCase();
                let isDir = type.includes('dir');
                let isFile = type.includes('file');
                if (!isDir && !isFile && full && window.Neutralino?.filesystem?.getStats) {
                    const stats = await Neutralino.filesystem.getStats(full).catch(() => null);
                    if (stats) {
                        const sType = String(stats.type || '').toLowerCase();
                        isDir = sType.includes('dir');
                        isFile = sType.includes('file') || (!isDir && typeof stats.size !== 'undefined');
                    }
                }
                out.push({ name: name || full.split('/').pop(), path: full, isDir, isFile });
            }
            return out;
        },

        isSupportedLibraryFile(filePath, kind) {
            const defs = this.getLibraryDefs();
            const allowed = defs[kind]?.extensions || [];
            const ext = String(filePath || '').toLowerCase().split('.').pop();
            return !!ext && allowed.includes(ext);
        },

        async _scanLibraryRoot(kind, rootPath, recursive) {
            const rootLabel = rootPath.split('/').filter(Boolean).pop() || rootPath;
            const directories = new Set();
            const files = [];
            const visit = async (dirPath, relDir = '') => {
                const entries = await this.readDirectorySafe(dirPath).catch(() => []);
                for (const entry of entries) {
                    if (entry.isDir) {
                        const nextRel = relDir ? `${relDir}/${entry.name}` : entry.name;
                        directories.add(nextRel);
                        if (recursive) await visit(entry.path, nextRel);
                    } else if (entry.isFile && this.isSupportedLibraryFile(entry.path, kind)) {
                        files.push({
                            id: utils.uid('mdl'),
                            path: entry.path,
                            name: entry.name,
                            relDir,
                            rootPath,
                            rootLabel,
                        });
                    }
                }
            };
            await visit(rootPath, '');
            files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
            return { rootPath, rootLabel, directories: Array.from(directories).sort(), files };
        },

        async rescanModelLibraries(kind = null, force = true) {
            if (!window.Neutralino?.filesystem?.readDirectory) {
                VP.showToast?.('Model library scan requires Neutralino filesystem', 'error');
                return null;
            }
            this.ensureModelLibraryConfig();
            if (!this._libraryCache) this._libraryCache = {};
            const defs = this.getLibraryDefs();
            const kinds = kind ? [kind] : Object.keys(defs);
            for (const k of kinds) {
                const cfg = this.getLibraryConfig(k);
                const roots = [];
                for (const rootPath of cfg.paths || []) {
                    const normalized = utils.normPath(rootPath);
                    if (!normalized) continue;
                    const exists = await Neutralino.filesystem.getStats(normalized).then(() => true).catch(() => false);
                    if (!exists) continue;
                    roots.push(await this._scanLibraryRoot(k, normalized, cfg.recursive !== false));
                }
                const totalFiles = roots.reduce((sum, root) => sum + root.files.length, 0);
                this._libraryCache[k] = { kind: k, scannedAt: Date.now(), roots, totalFiles };
            }
            return kind ? this._libraryCache[kind] : this._libraryCache;
        },

        async ensureLibraryIndex(kind) {
            if (!this._libraryCache?.[kind]) {
                await this.rescanModelLibraries(kind, true);
            }
            return this._libraryCache?.[kind] || { kind, roots: [], totalFiles: 0 };
        },

        async pickLibraryModel(kind, opts = {}) {
            const index = await this.ensureLibraryIndex(kind);
            return this.openLibraryPicker(kind, index, opts);
        },

        openLibraryPicker(kind, initialIndex, opts = {}) {
            const defs = this.getLibraryDefs();
            let index = initialIndex || { roots: [], totalFiles: 0 };
            const currentValue = utils.normPath(opts.currentValue || '');
            if (!this._libraryLastLocation) this._libraryLastLocation = {};
            return new Promise((resolve) => {
                const existing = document.getElementById('vp-as-library-picker');
                existing?.remove();
                const overlay = document.createElement('div');
                overlay.id = 'vp-as-library-picker';
                overlay.className = 'vp-as-library-picker-backdrop';
                overlay.innerHTML = `
                    <div class="vp-as-library-picker-card">
                        <div class="vp-as-library-picker-head">
                            <div>
                                <div class="vp-as-library-picker-title">${opts.title || defs[kind]?.title || 'Model Library'}</div>
                                <div class="vp-as-library-picker-subtitle">${defs[kind]?.title || kind} · ${index.totalFiles || 0} indexed file(s)</div>
                            </div>
                            <button class="vp-btn vp-btn-sm" data-act="close">×</button>
                        </div>
                        <div class="vp-as-library-picker-toolbar">
                            <div class="vp-as-library-roots"></div>
                            <input class="vp-as-library-search" type="text" placeholder="Filter files in current folder...">
                        </div>
                        <div class="vp-as-library-picker-breadcrumbs"></div>
                        <div class="vp-as-library-picker-body">
                            <div class="vp-as-library-pane folders">
                                <div class="vp-as-library-pane-title">Folders</div>
                                <div class="vp-as-library-pane-list vp-as-library-folder-list"></div>
                            </div>
                            <div class="vp-as-library-pane files">
                                <div class="vp-as-library-pane-title">Files</div>
                                <div class="vp-as-library-pane-list vp-as-library-file-list"></div>
                            </div>
                        </div>
                        <div class="vp-as-library-picker-actions">
                            <button class="vp-btn vp-btn-sm" data-act="rescan">↻ Rescan</button>
                            <button class="vp-btn vp-btn-sm" data-act="browse-file">Browse file</button>
                            <button class="vp-btn vp-btn-sm" data-act="manual">Manual path</button>
                            <button class="vp-btn vp-btn-sm" data-act="cancel">Cancel</button>
                        </div>
                    </div>`;
                document.body.appendChild(overlay);

                const rootsEl = overlay.querySelector('.vp-as-library-roots');
                const searchEl = overlay.querySelector('.vp-as-library-search');
                const crumbsEl = overlay.querySelector('.vp-as-library-picker-breadcrumbs');
                const folderListEl = overlay.querySelector('.vp-as-library-folder-list');
                const fileListEl = overlay.querySelector('.vp-as-library-file-list');
                let rootIndex = 0;
                let currentDir = '';
                let query = '';
                let settled = false;

                const finish = (value = null) => {
                    if (settled) return;
                    settled = true;
                    overlay.remove();
                    resolve(value);
                };

                let matchedCurrent = false;
                if (currentValue) {
                    index.roots?.forEach((root, idx) => {
                        const match = root.files.find(f => f.path === currentValue);
                        if (match) {
                            matchedCurrent = true;
                            rootIndex = idx;
                            currentDir = match.relDir || '';
                        }
                    });
                }
                if (!matchedCurrent && this._libraryLastLocation?.[kind]) {
                    const last = this._libraryLastLocation[kind];
                    const idx = (index.roots || []).findIndex(root => root.rootPath === last.rootPath);
                    if (idx >= 0) {
                        rootIndex = idx;
                        currentDir = last.dir || '';
                    }
                }

                overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) finish(null); });
                overlay.querySelector('[data-act="close"]').addEventListener('click', () => finish(null));
                overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
                overlay.querySelector('[data-act="browse-file"]').addEventListener('click', () => finish('__BROWSE_FILE__'));
                overlay.querySelector('[data-act="manual"]').addEventListener('click', async () => {
                    overlay.remove();
                    const manual = await this.askText({
                        title: 'Manual model path',
                        message: 'Paste absolute model path:',
                        value: currentValue || '',
                        placeholder: 'D:/AI/models/model.gguf',
                        confirmLabel: 'Use',
                        required: true,
                    });
                    const trimmed = manual == null ? null : utils.normPath(manual.trim());
                    finish(trimmed || null);
                });
                overlay.querySelector('[data-act="rescan"]').addEventListener('click', async () => {
                    overlay.classList.add('is-busy');
                    await this.rescanModelLibraries(kind, true);
                    index = await this.ensureLibraryIndex(kind);
                    rootIndex = 0;
                    currentDir = '';
                    query = '';
                    searchEl.value = '';
                    overlay.querySelector('.vp-as-library-picker-subtitle').textContent = `${defs[kind]?.title || kind} · ${index.totalFiles || 0} indexed file(s)`;
                    overlay.classList.remove('is-busy');
                    render();
                });
                searchEl.addEventListener('input', () => {
                    query = searchEl.value.trim().toLowerCase();
                    renderFiles();
                });

                function getRoot() {
                    return index.roots?.[rootIndex] || null;
                }
                function getImmediateDirs(root, dir) {
                    const set = new Set();
                    const prefix = dir ? `${dir}/` : '';
                    for (const rel of root?.directories || []) {
                        if (dir && !rel.startsWith(prefix)) continue;
                        const remainder = dir ? rel.slice(prefix.length) : rel;
                        if (!remainder) continue;
                        const head = remainder.split('/')[0];
                        if (head) set.add(head);
                    }
                    return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
                }
                function rememberCurrentLocation(path = currentValue) {
                    const root = getRoot();
                    if (!root) return;
                    const match = root.files.find(f => f.path === path);
                    const dir = match?.relDir ?? currentDir ?? '';
                    thisRef._libraryLastLocation[kind] = { rootPath: root.rootPath, dir, path };
                }
                const thisRef = this;
                function renderRoots() {
                    rootsEl.innerHTML = '';
                    if (!index.roots?.length) {
                        rootsEl.innerHTML = '<div class="vp-as-library-empty-inline">No indexed roots</div>';
                        return;
                    }
                    index.roots.forEach((root, idx) => {
                        const btn = document.createElement('button');
                        btn.className = 'vp-as-library-root-chip' + (idx == rootIndex ? ' active' : '');
                        btn.textContent = root.rootLabel || root.rootPath;
                        btn.title = root.rootPath;
                        btn.addEventListener('click', () => { rootIndex = idx; currentDir = ''; render(); });
                        rootsEl.appendChild(btn);
                    });
                }
                function renderFolders() {
                    const root = getRoot();
                    folderListEl.innerHTML = '';
                    crumbsEl.textContent = root ? `${root.rootLabel}${currentDir ? ' / ' + currentDir : ''}` : 'No root selected';
                    if (!root) {
                        folderListEl.innerHTML = '<div class="vp-as-library-empty-inline">Configure library paths in Studio settings</div>';
                        return;
                    }
                    if (currentDir) {
                        const up = document.createElement('button');
                        up.className = 'vp-as-library-item';
                        up.textContent = '↖ ..';
                        up.addEventListener('click', () => {
                            currentDir = currentDir.includes('/') ? currentDir.split('/').slice(0, -1).join('/') : '';
                            render();
                        });
                        folderListEl.appendChild(up);
                    }
                    const dirs = getImmediateDirs(root, currentDir);
                    if (!dirs.length) {
                        const empty = document.createElement('div');
                        empty.className = 'vp-as-library-empty-inline';
                        empty.textContent = 'No folders here';
                        folderListEl.appendChild(empty);
                        return;
                    }
                    for (const dir of dirs) {
                        const btn = document.createElement('button');
                        btn.className = 'vp-as-library-item';
                        btn.textContent = `📁 ${dir}`;
                        btn.addEventListener('click', () => {
                            currentDir = currentDir ? `${currentDir}/${dir}` : dir;
                            render();
                        });
                        folderListEl.appendChild(btn);
                    }
                }
                function renderFiles() {
                    const root = getRoot();
                    fileListEl.innerHTML = '';
                    if (!root) {
                        fileListEl.innerHTML = '<div class="vp-as-library-empty-inline">No files</div>';
                        return;
                    }
                    let files = root.files.filter(f => (f.relDir || '') === currentDir);
                    if (query) files = files.filter(f => f.name.toLowerCase().includes(query));
                    if (!files.length) {
                        const empty = document.createElement('div');
                        empty.className = 'vp-as-library-empty-inline';
                        empty.textContent = query ? 'No files match filter' : 'No files in this folder';
                        fileListEl.appendChild(empty);
                        return;
                    }
                    files.forEach(file => {
                        const btn = document.createElement('button');
                        btn.className = 'vp-as-library-item file' + (file.path === currentValue ? ' active' : '');
                        btn.textContent = file.name;
                        btn.title = file.path;
                        btn.addEventListener('click', () => {
                            rememberCurrentLocation(file.path);
                            finish(file.path);
                        });
                        fileListEl.appendChild(btn);
                    });
                }
                function render() {
                    renderRoots();
                    renderFolders();
                    renderFiles();
                }
                render();
            });
        },

        async init() {
            // Anchor studio state inside the persisted shell state so F5 keeps it.
            this.ensureStudioState();
            const saved = S.shell?.assetStudio;
            if (saved && typeof saved === 'object') {
                S.assetStudio = {
                    ...this.ensureStudioState(),
                    ...this.cloneData(saved),
                    config: { ...this.config, ...(saved.config || {}) },
                    workflows: Array.isArray(saved.workflows) ? saved.workflows : (S.assetStudio.workflows || []),
                    selectedWorkflowId: saved.selectedWorkflowId || null,
                };
            }
            this.ensureStudioState();
            this.config = { ...this.config, ...(S.assetStudio.config || {}) };

            this.registerPanel();
            console.log('[VP Asset Studio] Ready.');
        },

        syncStudioState() {
            if (!S.shell) S.shell = {};
            S.shell.assetStudio = S.assetStudio;
        },

        saveStudioState() {
            this.ensureStudioState();
            S.assetStudio.graph = Graph.serialize();
            S.assetStudio.config = { ...this.config };
            this.syncStudioState();
            const payload = JSON.stringify(S.assetStudio);
            try { localStorage.setItem('vp-asset-studio-state', payload); }
            catch (err) { console.warn('[Asset Studio] localStorage mirror failed:', err); }
            if (DB?.setShellState) {
                DB.setShellState(S.shell)
                    .then(() => console.log('[Asset Studio] State saved to shell'))
                    .catch(err => console.warn('[Asset Studio] Failed to save shell state:', err));
            } else {
                console.log('[Asset Studio] State saved to localStorage mirror');
            }
        },

        parseCLI(cmd) {
            const tokens = [];
            let current = '';
            let inQuotes = false;
            let quoteChar = null;
            for (const ch of cmd) {
                if (ch === '"' || ch === "'") {
                    if (!inQuotes) { inQuotes = true; quoteChar = ch; }
                    else if (quoteChar === ch) { inQuotes = false; quoteChar = null; }
                    else current += ch;
                } else if (/\s/.test(ch) && !inQuotes) {
                    if (current) { tokens.push(current); current = ''; }
                } else {
                    current += ch;
                }
            }
            if (current) tokens.push(current);

            const executable = tokens.shift() || '';
            const flags = [];
            let i = 0;
            while (i < tokens.length) {
                const tok = tokens[i];
                if (tok.startsWith('-')) {
                    const next = tokens[i + 1];
                    if (next && !next.startsWith('-')) {
                        flags.push({ flag: tok, value: next });
                        i += 2;
                    } else {
                        flags.push({ flag: tok, value: true });
                        i += 1;
                    }
                } else {
                    i += 1;
                }
            }
            return { executable, flags };
        },

        importCLI(cmd) {
            const log = document.querySelector('#vp-as-cli-log');
            const { Arg } = VP_AS;
            const parsed = this.parseCLI(cmd);
            console.log('[Asset Studio] Import CLI:', parsed);
            if (log) log.innerHTML += `<div><b>📥 import:</b> ${cmd.slice(0, 200)}</div>`;

            const groups = {};
            const unknown = [];
            for (const item of parsed.flags) {
                const def = Arg.getDef(item.flag);
                if (!def) { unknown.push(item.flag); continue; }
                if (!groups[def.tower]) groups[def.tower] = {};
                if (def.tower === 'lora' || item.flag === '--lora' || item.flag === '-lora') {
                    // LoRA is handled by the dedicated LoRA Stack node
                    if (!groups.lora) groups.lora = {};
                    if (!groups.lora.items) groups.lora.items = [];
                    const [file, weight] = String(item.value).split(':');
                    groups.lora.items.push({ file, weight: parseFloat(weight) || 1.0 });
                    continue;
                }
                const parser = def.control === 'number' ? (v => {
                    const n = parseFloat(v);
                    return Number.isNaN(n) ? (def.default ?? 0) : n;
                }) : v => v;
                groups[def.tower][def.key] = parser(item.value);
            }

            if (unknown.length && log) {
                log.innerHTML += `<div style="color:#e5c07b"><b>warn:</b> unknown flags: ${unknown.join(', ')}</div>`;
            }

            if (!Object.keys(groups).length) {
                VP.showToast?.('No recognized CLI flags found', 'warn');
                return;
            }

            Graph.clear();
            const order = ['loader', 'lora', 'prompt', 'sampler', 'output'];
            const created = {};
            let x = 40;
            for (const type of order) {
                if (!groups[type]) continue;
                created[type] = Graph.addNode(type, x, 40, groups[type]);
                x += 260;
            }

            const present = order.filter(t => created[t]);
            for (let i = 0; i < present.length - 1; i++) {
                Graph.links.add({
                    fromNode: created[present[i]].id,
                    fromSocket: 'out',
                    toNode: created[present[i + 1]].id,
                    toSocket: 'in',
                });
            }

            Graph.viewport.frameNodes(Array.from(Graph.nodes.values()));
            if (log) log.scrollTop = log.scrollHeight;
            VP.showToast?.('CLI imported into towers', 'success');
        },

        registerPanel() {
            VP.registerPanel({
                id: 'asset-studio',
                title: 'Asset Studio',
                icon: '🎨',
                order: 70,
                create: (container) => this.renderPanel(container),
                settings: {
                    title: 'Studio Config',
                    icon: '⚙️',
                    create: (body) => this.renderSettings(body),
                },
            });
        },

        renderPanel(container) {
            container.innerHTML = `
                <div class="vp-as-layout">
                    <div class="vp-as-sidebar">
                        <div class="vp-as-section-title">📦 Nodes</div>
                        <div class="vp-as-node-palette"></div>
                        <div class="vp-as-section-title" style="margin-top:12px">⚡ Presets</div>
                        <div class="vp-as-side-actions">
                            <button class="vp-btn vp-btn-sm vp-as-preset" data-preset="t2i">Load T2I Preset</button>
                            <button class="vp-btn vp-btn-sm vp-as-preset" data-preset="dit">Load DiT Preset</button>
                            <button class="vp-btn vp-btn-sm vp-as-preset" data-preset="clear">Clear Canvas</button>
                        </div>
                        <div class="vp-as-section-title" style="margin-top:12px">💾 Workflows</div>
                        <div class="vp-as-side-actions">
                            <button class="vp-btn vp-btn-sm" id="vp-as-save-current">Save Current</button>
                            <button class="vp-btn vp-btn-sm" id="vp-as-save-as-new">Save As New</button>
                        </div>
                        <div class="vp-as-workflow-selected" id="vp-as-selected-workflow">Selected: none</div>
                        <div class="vp-as-workflow-list" id="vp-as-workflow-list"></div>
                        <div class="vp-as-section-title" style="margin-top:12px">📁 File</div>
                        <div class="vp-as-side-actions">
                            <button class="vp-btn vp-btn-sm" id="vp-as-export-workflow">Export JSON</button>
                            <button class="vp-btn vp-btn-sm" id="vp-as-import-workflow">Import JSON</button>
                        </div>
                    </div>
                    <div class="vp-as-canvas-wrap">
                        <div class="vp-as-canvas" id="vp-as-canvas">
                            <svg class="vp-as-links" id="vp-as-links"></svg>
                            <div class="vp-as-empty-hint" id="vp-as-empty-hint">
                                <h3>Canvas Ready</h3>
                                <p>Перетащите ноды из левой панели или используйте пресет</p>
                                <div class="vp-as-canvas-hints">
                                    <span>🖱 wheel = zoom</span>
                                    <span>🖱 middle drag / Space+drag = pan</span>
                                    <span>⌨ F = frame all</span>
                                </div>
                            </div>
                        </div>
                        <div class="vp-as-canvas-overlay vp-as-canvas-overlay-left">
                            <button class="vp-btn vp-btn-sm" id="vp-as-toggle-sidebar" title="Toggle Sidebar">✕ Nodes</button>
                        </div>
                        <div class="vp-as-canvas-overlay vp-as-canvas-overlay-tools">
                            <button class="vp-btn vp-btn-sm" id="vp-as-zoom-out" title="Zoom out">−</button>
                            <span id="vp-as-zoom-label">100%</span>
                            <button class="vp-btn vp-btn-sm" id="vp-as-zoom-in" title="Zoom in">+</button>
                            <button class="vp-btn vp-btn-sm" id="vp-as-frame-all" title="Frame all">⊡</button>
                            <div class="vp-as-mode-sep"></div>
                            <button class="vp-btn vp-btn-sm" id="vp-as-toggle-inspector" title="Toggle Inspector">Log ☰</button>
                            <button class="vp-btn vp-btn-sm" id="vp-as-import-cli" title="Import CLI command">CLI+</button>
                            <select id="vp-as-engine-mode" class="vp-as-engine-mode" title="Generation engine mode">
                                <option value="cli">CLI</option>
                                <option value="server">Server — stub</option>
                            </select>
                        </div>
                        <div class="vp-as-canvas-controls">
                            <div class="vp-as-primary-actions">
                                <button class="vp-btn vp-btn-primary" id="vp-as-produce">🎨 Produce Active</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-as-produce-all" title="Generate all tabs sequentially">▶▶ Produce All</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-as-stop" style="display:none; color:#ff6b6b; border-color:rgba(255,60,60,0.3);">⏹ Stop</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-as-copy-cli">📋 Copy CLI</button>
                                <button class="vp-btn vp-btn-ghost" id="vp-as-gallery-btn" title="Open floating gallery">📚 Gallery</button>
                            </div>
                            <div class="vp-as-progress-bar"><div class="fill" id="vp-as-progress-fill" style="width:0%"></div></div>
                            <div class="vp-as-status" id="vp-as-status">Ready · 0 nodes · CLI</div>
                        </div>
                    </div>
                    <div class="vp-as-inspector collapsed">
                        <div class="vp-as-inspector-head">
                            <div>
                                <div class="vp-as-section-title" style="margin-bottom:2px">👁 Inspector</div>
                                <div class="vp-as-inspector-sub">Preview + CLI stream</div>
                            </div>
                            <button class="vp-btn vp-btn-sm" id="vp-as-hide-inspector" title="Hide Inspector">×</button>
                        </div>
                        <div class="vp-as-preview-box" id="vp-as-preview-box">
                            <div class="vp-as-preview-placeholder">No result yet</div>
                        </div>
                        <div class="vp-as-cli-log" id="vp-as-cli-log"></div>
                    </div>
                </div>
            `;
            this.injectStyles();

            const canvas = container.querySelector('#vp-as-canvas');
            const svg = container.querySelector('#vp-as-links');
            Graph.init(canvas, svg);

            this.wirePalette(container);
            this.wireCanvas(container);
            this.wireControls(container);

            // Restore studio state (by now shell state has loaded)
            let studioState = S.shell?.assetStudio;
            if (!studioState) {
                try { studioState = JSON.parse(localStorage.getItem('vp-asset-studio-state') || 'null'); }
                catch (err) { console.warn('[Asset Studio] Failed to parse localStorage state:', err); }
            }
            if (!studioState) studioState = S.assetStudio;
            console.log('[Asset Studio] Restoring state:', studioState);
            if (studioState && typeof studioState === 'object') {
                this.ensureStudioState();
                if (studioState.config) this.config = { ...this.config, ...(studioState.config || {}) };
                if (Array.isArray(studioState.workflows)) S.assetStudio.workflows = this.cloneData(studioState.workflows);
                if ('selectedWorkflowId' in studioState) S.assetStudio.selectedWorkflowId = studioState.selectedWorkflowId || null;
            }
            if (studioState?.graph) {
                try { Graph.deserialize(studioState.graph); }
                catch (err) { console.warn('[Asset Studio] Failed to restore graph:', err); }
            }

            // persist studio state (graph + config) into shell state
            Graph.onPersist = () => {
                this.saveStudioState();
                const hint = container.querySelector('#vp-as-empty-hint');
                if (hint) {
                    if (Graph.nodes.size > 0) hint.classList.add('hidden');
                    else hint.classList.remove('hidden');
                }
                this.updateStudioStatus(container);
            };

            // Set initial hint state
            const hint = container.querySelector('#vp-as-empty-hint');
            if (hint) {
                if (Graph.nodes.size > 0) hint.classList.add('hidden');
                else hint.classList.remove('hidden');
            }
            this.syncPanelToggles(container);
            this.renderWorkflowLibrary(container);
            this.updateStudioStatus(container);
            requestAnimationFrame(() => this.refreshGraphUI(container));
        },

        wirePalette(container) {
            const palette = container.querySelector('.vp-as-node-palette');
            for (const def of NodeRegistry.list()) {
                const item = document.createElement('div');
                item.className = 'vp-as-node-item';
                item.draggable = true;
                item.dataset.type = def.type;
                item.innerHTML = `<span class="vp-as-node-icon" style="background:${def.color}">${def.icon}</span><span>${def.title}</span>`;
                palette.appendChild(item);

                item.addEventListener('dragstart', (e) => {
                    e.dataTransfer.setData('nodeType', def.type);
                });
                item.addEventListener('click', () => {
                    Graph.addNode(def.type);
                });
            }

            const canvas = container.querySelector('#vp-as-canvas');
            canvas.addEventListener('dragover', (e) => e.preventDefault());
            canvas.addEventListener('drop', (e) => {
                e.preventDefault();
                const type = e.dataTransfer.getData('nodeType');
                if (!type) return;
                const rect = canvas.getBoundingClientRect();
                const worldPos = Graph.viewport.screenToWorld(e.clientX - rect.left - 20, e.clientY - rect.top - 20);
                Graph.addNode(type, worldPos.x, worldPos.y);
            });
        },

        wireCanvas(container) {
            const canvas = container.querySelector('#vp-as-canvas');
            this._activeCanvas = canvas;
            this._activeContainer = container;

            canvas.addEventListener('click', (e) => {
                if (e.target === canvas || e.target.classList.contains('vp-as-links') || e.target.classList.contains('vp-as-empty-hint')) {
                    Graph.selectNode(null);
                }
            });

            if (!this._boundKeyHandler) {
                this._boundKeyHandler = (e) => {
                    const activeCanvas = this._activeCanvas;
                    if (!activeCanvas || !document.body.contains(activeCanvas)) return;
                    if (e.target.closest('input, textarea, select')) return;

                    if (e.key === 'Delete') {
                        if (Graph.selectedNodeId) Graph.removeNode(Graph.selectedNodeId);
                    } else if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey)) {
                        if (Graph.selectedNodeId) {
                            const node = Graph.getNode(Graph.selectedNodeId);
                            if (node) Graph.clipboard = node.serialize();
                        }
                    } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
                        if (Graph.clipboard) {
                            const data = JSON.parse(JSON.stringify(Graph.clipboard));
                            const newNode = Graph.addNode(data.type, data.x + 30, data.y + 30, data.data);
                            newNode.width = data.width || 240;
                            Graph.selectNode(newNode.id);
                        }
                    }
                };
                document.addEventListener('keydown', this._boundKeyHandler);
            }
        },

        wireControls(container) {
            const produceBtn = container.querySelector('#vp-as-produce');
            const stopBtn = container.querySelector('#vp-as-stop');
            const copyBtn = container.querySelector('#vp-as-copy-cli');
            const log = container.querySelector('#vp-as-cli-log');
            const preview = container.querySelector('#vp-as-preview-box');
            const progress = container.querySelector('#vp-as-progress-fill');
            const zoomLabel = container.querySelector('#vp-as-zoom-label');
            const engineMode = container.querySelector('#vp-as-engine-mode');
            const toggleSidebarBtn = container.querySelector('#vp-as-toggle-sidebar');
            const toggleInspectorBtn = container.querySelector('#vp-as-toggle-inspector');
            const hideInspectorBtn = container.querySelector('#vp-as-hide-inspector');
            const sidebar = container.querySelector('.vp-as-sidebar');
            const inspector = container.querySelector('.vp-as-inspector');

            const updateZoomLabel = () => {
                if (zoomLabel) zoomLabel.textContent = `${Math.round(Graph.viewport.scale * 100)}%`;
            };
            Graph.viewport.onChange = () => {
                Graph.links._render();
                updateZoomLabel();
            };
            updateZoomLabel();
            this.syncPanelToggles(container);
            this.updateStudioStatus(container);

            container.querySelector('#vp-as-zoom-in').addEventListener('click', () => {
                const rect = Graph.canvas.getBoundingClientRect();
                Graph.viewport.zoom(-1, rect.width / 2, rect.height / 2);
            });
            container.querySelector('#vp-as-zoom-out').addEventListener('click', () => {
                const rect = Graph.canvas.getBoundingClientRect();
                Graph.viewport.zoom(1, rect.width / 2, rect.height / 2);
            });
            container.querySelector('#vp-as-frame-all').addEventListener('click', () => {
                Graph.viewport.frameNodes(Array.from(Graph.nodes.values()));
            });

            const importBtn = container.querySelector('#vp-as-import-cli');
            if (importBtn) {
                importBtn.addEventListener('click', () => {
                    const raw = prompt('Paste a stable-diffusion.cpp CLI command:');
                    if (!raw || !raw.trim()) return;
                    this.importCLI(raw.trim());
                    this.updateStudioStatus(container, 'CLI imported');
                });
            }

            if (engineMode) {
                engineMode.value = this.config.engineMode || 'cli';
                engineMode.addEventListener('change', () => {
                    this.config.engineMode = engineMode.value;
                    this.saveStudioState();
                    this.updateStudioStatus(container);
                });
            }

            stopBtn.addEventListener('click', async () => {
                if (!this.running || !this._activeProcessId) return;
                if (window.Neutralino?.os?.updateSpawnedProcess) {
                    try {
                        await Neutralino.os.updateSpawnedProcess(this._activeProcessId, 'exit');
                        VP.showToast?.('Kill signal sent', 'info');
                    } catch (e) {
                        console.warn('Failed to kill process:', e);
                        VP.showToast?.('Failed to stop process', 'error');
                    }
                }
            });

            produceBtn.addEventListener('click', async () => {
                if (this.running) return;
                const bag = Graph.produce();
                if (!bag) return;

                const mode = this.config.engineMode || 'cli';
                if (mode === 'server') {
                    VP.showToast?.('Server mode is a stub — switch to CLI to render', 'info');
                    log.innerHTML += `<div><b>[SERVER STUB]</b> Would enqueue request to sd-server.exe</div>`;
                    log.scrollTop = log.scrollHeight;
                    this.updateStudioStatus(container, 'Server stub');
                    return;
                }

                const assetName = bag.meta.get('assetName') || null;
                await this.runCLI(bag, log, preview, progress, stopBtn, container, assetName);
            });

            const produceAllBtn = container.querySelector('#vp-as-produce-all');
            if (produceAllBtn) {
                produceAllBtn.addEventListener('click', async () => {
                    if (this.running) return;
                    // Find the prompt node and iterate its tabs
                    const promptNode = Array.from(Graph.nodes.values()).find(n => n.type === 'prompt');
                    if (!promptNode || !Array.isArray(promptNode.data.tabs) || promptNode.data.tabs.length === 0) {
                        VP.showToast?.('No prompt tabs found', 'warn');
                        return;
                    }
                    const tabs = promptNode.data.tabs;
                    let success = 0, fail = 0;
                    const mode = this.config.engineMode || 'cli';
                    if (mode === 'server') {
                        VP.showToast?.('Server mode is a stub', 'info');
                        return;
                    }
                    for (let i = 0; i < tabs.length; i++) {
                        if (this.running) break;
                        promptNode.data.activeTabId = tabs[i].id;
                        const bag = Graph.produce();
                        if (!bag) { fail++; continue; }
                        const assetName = bag.meta.get('assetName') || null;
                        log.innerHTML += `<div><b>▶ [${i+1}/${tabs.length}]</b> ${tabs[i].name}${assetName ? ' → ' + assetName : ''}</div>`;
                        log.scrollTop = log.scrollHeight;
                        this.updateStudioStatus(container, `Generating ${i+1}/${tabs.length}: ${tabs[i].name}`);
                        try {
                            await this.runCLI(bag, log, preview, progress, stopBtn, container, assetName);
                            success++;
                        } catch (err) {
                            fail++;
                            log.innerHTML += `<div style="color:var(--error)"><b>✗</b> ${tabs[i].name}: ${err.message || err}</div>`;
                        }
                    }
                    VP.showToast?.(`Done: ${success} generated, ${fail} failed`, fail > 0 ? 'info' : 'success');
                    this.updateStudioStatus(container, success > 0 ? `Generated ${success} assets` : '');
                });
            }

            const toggleChrome = (target) => {
                target.classList.toggle('collapsed');
                this.syncPanelToggles(container);
                setTimeout(() => {
                    Graph.viewport?.handleResize?.({ preserveCenter: true });
                    Graph.links._render();
                }, 310);
            };
            toggleSidebarBtn?.addEventListener('click', () => toggleChrome(sidebar));
            toggleInspectorBtn?.addEventListener('click', () => toggleChrome(inspector));
            hideInspectorBtn?.addEventListener('click', () => toggleChrome(inspector));

            copyBtn.addEventListener('click', () => {
                const bag = Graph.produce();
                if (!bag) return;
                const cmd = bag.toCommandString(this.config.executablePath);
                navigator.clipboard?.writeText(cmd)
                    .then(() => VP.showToast?.('CLI copied', 'success'))
                    .catch(() => VP.showToast?.('Clipboard unavailable', 'error'));
            });

            const galleryBtn = container.querySelector('#vp-as-gallery-btn');
            if (galleryBtn) {
                galleryBtn.addEventListener('click', () => {
                    if (VP.gallery?.toggleMode) {
                        VP.gallery.toggleMode();
                    } else {
                        VP.showToast?.('Gallery not loaded', 'warn');
                    }
                });
            }

            container.querySelectorAll('.vp-as-preset').forEach(btn => {
                btn.addEventListener('click', () => {
                    const preset = btn.dataset.preset;
                    if (preset === 'clear') {
                        Graph.clear();
                        log.innerHTML = '';
                        preview.innerHTML = '<div class="vp-as-preview-placeholder">No result yet</div>';
                        this.updateStudioStatus(container, 'Canvas cleared');
                        return;
                    }
                    Graph.clear();
                    if (preset === 't2i') {
                        const loader = Graph.addNode('loader', 40, 40);
                        const lora = Graph.addNode('lora', 300, 40);
                        const prompt = Graph.addNode('prompt', 560, 40);
                        const sampler = Graph.addNode('sampler', 820, 40);
                        const output = Graph.addNode('output', 1080, 40);
                        Graph.links.add({ fromNode: loader.id, fromSocket: 'out', toNode: lora.id, toSocket: 'in' });
                        Graph.links.add({ fromNode: lora.id, fromSocket: 'out', toNode: prompt.id, toSocket: 'in' });
                        Graph.links.add({ fromNode: prompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' });
                        Graph.links.add({ fromNode: sampler.id, fromSocket: 'out', toNode: output.id, toSocket: 'in' });
                    } else if (preset === 'dit') {
                        const loader = Graph.addNode('loader', 40, 40);
                        const prompt = Graph.addNode('prompt', 300, 40);
                        const sampler = Graph.addNode('sampler', 560, 40);
                        const output = Graph.addNode('output', 820, 40);
                        Graph.links.add({ fromNode: loader.id, fromSocket: 'out', toNode: prompt.id, toSocket: 'in' });
                        Graph.links.add({ fromNode: prompt.id, fromSocket: 'out', toNode: sampler.id, toSocket: 'in' });
                        Graph.links.add({ fromNode: sampler.id, fromSocket: 'out', toNode: output.id, toSocket: 'in' });
                    }
                    this.updateStudioStatus(container, `Preset: ${preset.toUpperCase()}`);
                });
            });
            container.querySelector('#vp-as-save-current').addEventListener('click', async () => {
                await this.saveCurrentWorkflowInteractive();
            });

            container.querySelector('#vp-as-save-as-new').addEventListener('click', async () => {
                await this.saveWorkflowAsNewInteractive();
            });

            container.querySelector('#vp-as-export-workflow').addEventListener('click', async () => {
                await this.exportWorkflowToFile();
            });

            container.querySelector('#vp-as-import-workflow').addEventListener('click', async () => {
                await this.importWorkflowFromFile(container);
            });
        },

        async ensureOutputDir() {
            const dir = VP_AS.utils.normPath(this.config.outputDir || './output');
            if (!window.Neutralino?.filesystem) return dir;
            try {
                const stats = await Neutralino.filesystem.getStats(dir).catch(() => null);
                if (!stats) {
                    await Neutralino.filesystem.createDirectory(dir);
                    console.log('[Asset Studio] Created output dir:', dir);
                }
            } catch (err) {
                console.warn('[Asset Studio] Could not ensure output dir:', err);
            }
            return dir;
        },

        toWinPath(p) {
            if (typeof p !== 'string') return p;
            // LoRA values look like "file:weight" — convert only the file part.
            const lastColon = p.lastIndexOf(':');
            if (lastColon > 1) {
                const file = p.slice(0, lastColon).replace(/\//g, '\\');
                const weight = p.slice(lastColon + 1);
                return `${file}:${weight}`;
            }
            return p.replace(/\//g, '\\');
        },

        async runCLI(bag, log, preview, progress, stopBtn, container, assetName) {
            const isWin = (window.NL_OS || '').toLowerCase().includes('windows');
            const fileKeys = new Set(['-m', '--diffusion-model', '--llm', '--clip2', '--vae', '--lora', '-o']);
            if (isWin) {
                for (const [key, val] of bag.map) {
                    if (!fileKeys.has(key)) continue;
                    if (Array.isArray(val)) {
                        bag.map.set(key, val.map(v => this.toWinPath(v)));
                    } else {
                        bag.map.set(key, this.toWinPath(val));
                    }
                }
            }
            let executable = this.config.executablePath;
            if (isWin) executable = this.toWinPath(executable);
            const cmd = bag.toCommandString(executable);
            log.innerHTML += `<div><b>$</b> ${cmd}</div>`;
            log.scrollTop = log.scrollHeight;
            console.log('[Asset Studio] CLI:', cmd);

            if (preview) preview.innerHTML = `<div class="vp-as-preview-placeholder">Running sd.cpp CLI...<br><small>${cmd}</small></div>`;
            progress.style.width = '10%';
            this.running = true;
            this.updateStudioStatus(container, '⏳ Rendering');

            try {
                await this.ensureOutputDir();
                let outputPath = bag.get('-o');
                if (outputPath) outputPath = VP_AS.utils.normPath(outputPath);

                if (window.Neutralino?.os?.spawnProcess) {
                    const cwd = window.NL_CWD || '.';
                    let fullOutput = '';
                    let errorOutput = '';
                    let logBuffer = '';
                    
                    const updateLog = (chunk) => {
                        logBuffer += chunk;
                        const lines = logBuffer.split(/[\r\n]+/);
                        logBuffer = lines.pop() || '';
                        
                        let allLines = [...lines];
                        if (logBuffer) allLines.push(logBuffer);

                        for (let line of allLines) {
                            line = line.trim();
                            if (!line) continue;
                            const esc = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            const lower = esc.toLowerCase();
                            
                            const stepMatch = lower.match(/step[\s:]+(\d+)\/(\d+)/i) || lower.match(/step:\s*\d+%\s*\((\d+)\/(\d+)\)/i);
                            const timeMatch = lower.match(/([\d.]+)s\/it/i) || lower.match(/([\d.]+)it\/s/i);
                            
                            if (stepMatch) {
                                const current = parseInt(stepMatch[1]);
                                const total = parseInt(stepMatch[2]);
                                if (total > 0) {
                                    const percent = Math.min(100, Math.round((current / total) * 100));
                                    progress.style.width = `${percent}%`;
                                    let statusHtml = `Running: step ${current}/${total}`;
                                    if (timeMatch) statusHtml += ` (${timeMatch[0]})`;
                                    if (preview) preview.innerHTML = `<div class="vp-as-preview-placeholder">${statusHtml}</div>`;
                                }
                            }
                        }

                        for (let line of lines) {
                            line = line.trim();
                            if (!line) continue;
                            const esc = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            const lower = esc.toLowerCase();

                            if (lower.includes('error') || lower.includes('fatal')) {
                                log.innerHTML += `<div style="color:var(--error)"><b>err:</b> ${esc}</div>`;
                            } else if (lower.includes('warn')) {
                                log.innerHTML += `<div style="color:#e5c07b"><b>warn:</b> ${esc}</div>`;
                            } else if (lower.match(/step[\s:]+(\d+)\/(\d+)/i) || lower.match(/step:\s*\d+%\s*\((\d+)\/(\d+)\)/i) || lower.match(/([\d.]+)it\/s/i)) {
                                log.innerHTML += `<div style="opacity:0.6">${esc}</div>`;
                            } else {
                                log.innerHTML += `<div><b>info:</b> ${esc}</div>`;
                            }
                        }
                        
                        if (lines.length > 0) {
                            log.scrollTop = log.scrollHeight;
                        }
                    };

                    const processInfo = await Neutralino.os.spawnProcess(cmd, { cwd });
                    this._activeProcessId = processInfo.id;
                    if (stopBtn) stopBtn.style.display = 'inline-block';
                    
                    await new Promise((resolve, reject) => {
                        const onSpawnedProcess = (e) => {
                            if (e.detail.id == processInfo.id) {
                                if (e.detail.action === 'stdOut') {
                                    fullOutput += e.detail.data;
                                    updateLog(e.detail.data);
                                } else if (e.detail.action === 'stdErr') {
                                    errorOutput += e.detail.data;
                                    updateLog(e.detail.data);
                                } else if (e.detail.action === 'exit') {
                                    Neutralino.events.off('spawnedProcess', onSpawnedProcess);
                                    if (logBuffer) {
                                        updateLog('\n'); // flush
                                    }
                                    this._activeProcessId = null;
                                    if (stopBtn) stopBtn.style.display = 'none';
                                    const exitCode = e.detail.data;
                                    if (exitCode === 0 || exitCode == null) resolve();
                                    else reject(new Error(`sd.cpp exited with code ${exitCode}`));
                                }
                            }
                        };
                        Neutralino.events.on('spawnedProcess', onSpawnedProcess);
                    });

                    progress.style.width = '100%';

                    const imageData = await this.loadOutputImage(outputPath);
                    if (imageData) {
                        this.displayResult(imageData, outputPath, preview, assetName);
                        log.innerHTML += `<div><b>✓</b> Output: ${outputPath}</div>`;
                        VP.showToast?.('Asset generated', 'success');
                    } else if (preview) {
                        preview.innerHTML = `<div class="vp-as-preview-placeholder">Done, but output image not found.<br>${outputPath}</div>`;
                        VP.showToast?.('Render finished; image not loaded', 'info');
                    }
                } else if (window.Neutralino?.os?.execCommand) {
                    // Fallback to execCommand if spawnProcess is not used/available in older versions
                    const cwd = window.NL_CWD || '.';
                    const result = await Neutralino.os.execCommand(cmd, { cwd });
                    console.log('[Asset Studio] exec result:', result);

                    const exitCode = result?.exitCode ?? 0;
                    const stdout = result?.stdOut || result?.stdout || '';
                    const stderr = result?.stdErr || result?.stderr || '';
                    if (stdout) log.innerHTML += `<div><b>out:</b> ${stdout.slice(0, 800)}</div>`;
                    if (stderr) {
                        const lines = stderr.split('\n').filter(l => l.trim());
                        for (const line of lines.slice(0, 40)) {
                            const esc = line.replace(/</g, '&lt;').replace(/>/g, '&gt;');
                            const lower = esc.toLowerCase();
                            if (lower.includes('error') || lower.includes('fatal')) {
                                log.innerHTML += `<div style="color:var(--error)"><b>err:</b> ${esc.slice(0, 800)}</div>`;
                            } else if (lower.includes('warn')) {
                                log.innerHTML += `<div style="color:#e5c07b"><b>warn:</b> ${esc.slice(0, 800)}</div>`;
                            } else {
                                log.innerHTML += `<div><b>info:</b> ${esc.slice(0, 800)}</div>`;
                            }
                        }
                    }
                    log.scrollTop = log.scrollHeight;

                    if (exitCode !== 0) {
                        throw new Error(`sd.cpp exited with code ${exitCode}. Check the log for details.`);
                    }
                    progress.style.width = '100%';

                    const imageData = await this.loadOutputImage(outputPath);
                    if (imageData) {
                        this.displayResult(imageData, outputPath, preview, assetName);
                        log.innerHTML += `<div><b>✓</b> Output: ${outputPath}</div>`;
                        VP.showToast?.('Asset generated', 'success');
                    } else if (preview) {
                        preview.innerHTML = `<div class="vp-as-preview-placeholder">Done, but output image not found.<br>${outputPath}</div>`;
                        VP.showToast?.('Render finished; image not loaded', 'info');
                    }
                } else {
                    await new Promise(r => setTimeout(r, 800));
                    progress.style.width = '80%';
                    if (preview) preview.innerHTML = `<div class="vp-as-preview-placeholder">Browser mode: CLI mocked<br>${cmd}</div>`;
                    VP.showToast?.('CLI mocked (Neutralino not available)', 'info');
                }
            } catch (err) {
                console.error('[Asset Studio] exec failed:', err);
                if (preview) preview.innerHTML = `<div class="vp-as-preview-placeholder" style="color:var(--error)">Error: ${err.message || err}</div>`;
                VP.showToast?.(`Render failed: ${err.message || err}`, 'error');
            } finally {
                this.running = false;
                this._activeProcessId = null;
                if (stopBtn) stopBtn.style.display = 'none';
                this.updateStudioStatus(container);
                setTimeout(() => { progress.style.width = '0%'; }, 600);
            }
        },

        async loadOutputImage(outputPath) {
            if (!outputPath) return null;
            const root = window.NL_CWD || window.NL_PATH || '.';
            const candidates = [
                outputPath,
                outputPath.replace(/^\.\//, root + '/'),
                outputPath.replace(/^\.\.\//, root + '/../'),
            ];

            if (window.Neutralino?.filesystem) {
                for (const p of candidates) {
                    try {
                        const exists = await Neutralino.filesystem.getStats(p).then(() => true).catch(() => false);
                        if (!exists) continue;
                        const bin = await Neutralino.filesystem.readBinaryFile(p);
                        const blob = new Blob([bin], { type: this.mimeForPath(p) });
                        const url = URL.createObjectURL(blob);
                        return { blob, url, path: p };
                    } catch (e) { /* try next */ }
                }
            }
            return null;
        },

        mimeForPath(p) {
            const ext = String(p).toLowerCase().split('.').pop();
            const map = { png: 'image/png', webp: 'image/webp', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
            return map[ext] || 'image/png';
        },

        displayResult(imageData, outputPath, preview, assetName) {
            if (preview) {
                preview.innerHTML = '';
                const img = document.createElement('img');
                img.src = imageData.url;
                img.title = outputPath;
                img.style.maxWidth = '100%';
                img.style.maxHeight = '220px';
                img.style.objectFit = 'contain';
                preview.appendChild(img);
            }

            const outputNode = Array.from(Graph.nodes.values()).find(n => n.type === 'output');
            if (outputNode) outputNode.setPreview(imageData.url);

            if (VP.gallery?.addImageFromBlob) {
                let tagName = assetName || outputPath.split('/').pop().replace(/\.[^.]+$/, '');
                VP.gallery.addImageFromBlob(imageData.blob, {
                    source: 'generated',
                    suggestedName: `${tagName}.png`,
                    setAsCurrent: false,
                }).then(tag => {
                    if (tag) VP.showToast?.(`Added to gallery: ${tag}`, 'success');
                }).catch(() => {});
            }
        },

        renderSettings(container) {
            this.ensureModelLibraryConfig();
            const defs = this.getLibraryDefs();
            const rows = Object.entries(defs).map(([kind, def]) => {
                const cfg = this.getLibraryConfig(kind);
                return `
                    <div class="vp-as-lib-row" data-kind="${kind}">
                        <div class="vp-as-lib-head">
                            <b>${def.title}</b>
                            <span>${this.getLibraryStats(kind)}</span>
                        </div>
                        <textarea class="vp-as-lib-paths" data-lib-paths="${kind}" spellcheck="false" placeholder="One absolute path per line">${this.serializeLibraryPaths(kind)}</textarea>
                        <label class="vp-as-lib-toggle"><input type="checkbox" data-lib-recursive="${kind}" ${cfg.recursive !== false ? 'checked' : ''}> Scan subfolders recursively</label>
                    </div>`;
            }).join('');
            container.innerHTML = `
                <div class="vp-shell-settings-form">
                    <label><span>Executable Path</span><input type="text" data-k="executablePath" value="${this.config.executablePath}"></label>
                    <label><span>Output Directory</span><input type="text" data-k="outputDir" value="${this.config.outputDir}"></label>
                    <label><span>Engine Mode</span>
                        <select data-k="engineMode">
                            <option value="cli" ${this.config.engineMode === 'cli' ? 'selected' : ''}>CLI (sd-cli.exe)</option>
                            <option value="server" ${this.config.engineMode === 'server' ? 'selected' : ''}>Server (sd-server.exe)</option>
                        </select>
                    </label>
                </div>
                <div class="vp-shell-settings-note">CLI = запуск на каждый рендер. Server = заглушка, модель держится в памяти.</div>
                <div class="vp-as-lib-section">
                    <div class="vp-as-lib-title">Model Libraries</div>
                    <div class="vp-as-lib-note">Configure absolute paths for model libraries. One folder path per line. Studio will scan these folders and show a picker instead of raw file browsing.</div>
                    ${rows}
                    <div class="vp-as-lib-actions">
                        <button class="vp-btn vp-btn-sm" data-act="rescan-all-libs">↻ Rescan Libraries</button>
                    </div>
                </div>
            `;
            container.querySelectorAll('input[data-k], select[data-k]').forEach(input => {
                input.addEventListener('change', () => {
                    this.config[input.dataset.k] = input.value;
                    this.saveStudioState();
                });
            });
            container.querySelectorAll('[data-lib-paths]').forEach(area => {
                area.addEventListener('change', () => this.updateLibraryPaths(area.dataset.libPaths, area.value));
                area.addEventListener('blur', () => this.updateLibraryPaths(area.dataset.libPaths, area.value));
            });
            container.querySelectorAll('[data-lib-recursive]').forEach(input => {
                input.addEventListener('change', () => {
                    this.getLibraryConfig(input.dataset.libRecursive).recursive = !!input.checked;
                    this.saveStudioState();
                });
            });
            container.querySelector('[data-act="rescan-all-libs"]')?.addEventListener('click', async () => {
                const btn = container.querySelector('[data-act="rescan-all-libs"]');
                if (btn) btn.disabled = true;
                await this.rescanModelLibraries();
                if (btn) btn.disabled = false;
                this.renderSettings(container);
                VP.showToast?.('Model libraries rescanned', 'success');
            });
        },

        injectStyles() {
            if (document.getElementById('vp-as-styles')) return;
            const style = document.createElement('style');
            style.id = 'vp-as-styles';
            style.textContent = `
                .vp-as-layout { position:relative; overflow:hidden; display:flex; height:100%; min-height:0; min-width:0; background:var(--bg-primary); }
                .vp-as-sidebar { width:182px; border-right:1px solid var(--border); padding:10px; display:flex; flex-direction:column; gap:8px; flex-shrink:0; overflow:auto; background:linear-gradient(180deg, rgba(255,255,255,0.025), rgba(0,0,0,0.06)); transition: width 0.3s ease, padding 0.3s ease; }
                .vp-as-sidebar.collapsed { width: 0; padding-left: 0; padding-right: 0; border-right: none; overflow: hidden; }
                .vp-as-section-title { font-size:11px; font-weight:800; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em; margin-bottom:4px; }
                .vp-as-node-palette { display:flex; flex-direction:column; gap:6px; }
                .vp-as-side-actions { display:flex; flex-direction:column; gap:6px; }
                .vp-as-sidebar .vp-btn { width:100%; justify-content:center; }
                .vp-as-lib-section { margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.08); display:flex; flex-direction:column; gap:8px; }
                .vp-as-lib-title { font-size:12px; font-weight:800; color:var(--text-primary); }
                .vp-as-lib-note { font-size:10px; line-height:1.35; color:var(--text-secondary); }
                .vp-as-lib-row { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); border-radius:8px; padding:8px; display:flex; flex-direction:column; gap:6px; }
                .vp-as-lib-head { display:flex; align-items:center; justify-content:space-between; gap:8px; font-size:11px; }
                .vp-as-lib-head span { color:var(--text-secondary); font-size:10px; }
                .vp-as-lib-paths { width:100%; min-height:56px; resize:vertical; box-sizing:border-box; border-radius:7px; border:1px solid rgba(255,255,255,0.12); background:rgba(0,0,0,0.24); color:var(--text-primary); padding:7px 8px; font:11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
                .vp-as-lib-toggle { display:flex; align-items:center; gap:8px; color:var(--text-secondary); font-size:10px; }
                .vp-as-lib-actions { display:flex; gap:8px; }
                .vp-as-lib-actions .vp-btn { width:auto; }
                .vp-as-workflow-selected { padding:7px 8px; border:1px solid rgba(255,255,255,0.08); border-radius:7px; background:rgba(255,255,255,0.035); color:var(--text-secondary); font-size:11px; line-height:1.35; }
                .vp-as-workflow-list { display:flex; flex-direction:column; gap:6px; min-height:70px; max-height:220px; overflow:auto; padding-right:2px; }
                .vp-as-workflow-empty { padding:14px 10px; border:1px dashed rgba(255,255,255,0.10); border-radius:8px; color:var(--text-secondary); font-size:11px; text-align:center; }
                .vp-as-workflow-row { display:flex; align-items:stretch; gap:6px; padding:6px; border:1px solid rgba(255,255,255,0.08); border-radius:8px; background:rgba(255,255,255,0.03); }
                .vp-as-workflow-row.active { border-color:rgba(108,95,166,0.45); background:rgba(108,95,166,0.12); box-shadow:0 0 0 1px rgba(108,95,166,0.18) inset; }
                .vp-as-workflow-main { flex:1; min-width:0; display:flex; flex-direction:column; align-items:flex-start; gap:3px; padding:0; border:0; background:none; color:inherit; cursor:pointer; text-align:left; }
                .vp-as-workflow-title { width:100%; color:var(--text-primary); font-size:12px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-workflow-meta { width:100%; color:var(--text-secondary); font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-workflow-actions { display:flex; flex-direction:column; gap:4px; flex:0 0 28px; }
                .vp-as-workflow-actions .vp-btn { min-width:0; height:24px; padding:0; font-size:12px; }
                .vp-as-node-item { display:flex; align-items:center; gap:8px; padding:6px 8px; background:var(--bg-tertiary); border:1px solid var(--border); border-radius:6px; cursor:pointer; font-size:12px; transition:border-color .15s, background .15s; }
                .vp-as-node-item:hover { border-color:var(--accent); background:rgba(255,255,255,0.04); }
                .vp-as-node-icon { width:18px; height:18px; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:11px; }
                .vp-as-canvas-wrap { flex:1; display:flex; flex-direction:column; min-width:0; min-height:0; position:relative; }
                .vp-as-canvas { flex:1; background-image:radial-gradient(rgba(255,255,255,0.055) 1px, transparent 1px); background-size:20px 20px; position:relative; overflow:hidden; min-height:0; }
                .vp-as-empty-hint { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; opacity:0.35; pointer-events:none; z-index:5; }
                .vp-as-empty-hint.hidden { display:none; }
                .vp-as-canvas-hints { display:flex; flex-direction:column; gap:4px; font-size:10px; color:var(--text-secondary); margin-top:8px; }
                .vp-as-world { position:absolute; left:0; top:0; transform-origin:0 0; }
                .vp-as-links { position:absolute; inset:0; pointer-events:none; z-index:1; width:100%; height:100%; }
                .vp-as-links path { pointer-events:auto; }
                .vp-as-canvas-overlay { position:absolute; top:6px; right:6px; z-index:10; display:flex; align-items:center; gap:3px; row-gap:3px; max-width:calc(100% - 12px); background:rgba(0,0,0,0.35); border:1px solid rgba(255,255,255,0.1); border-radius:6px; padding:2px 4px; backdrop-filter:blur(4px); }
                .vp-as-canvas-overlay-left { left:8px; right:auto; top:48px; z-index:12; }
                .vp-as-canvas-overlay-tools { flex-wrap:wrap; justify-content:flex-end; }
                .vp-as-canvas-overlay .vp-btn { min-width:22px; height:24px; padding:1px 5px; font-size:11px; line-height:1; }
                #vp-as-zoom-label { font-size:10px; min-width:28px; text-align:center; color:var(--text-primary); }
                .vp-as-mode-sep { width:1px; height:14px; background:rgba(255,255,255,0.15); margin:0 1px; }
                .vp-as-engine-mode { min-width:70px; max-width:92px; height:24px; background:var(--bg-tertiary); color:var(--text-primary); border:1px solid rgba(255,255,255,0.12); border-radius:4px; padding:1px 5px; font-size:10px; }
                .vp-as-canvas-controls { min-height:44px; border-top:1px solid var(--border); background:var(--bg-secondary); display:flex; align-items:center; flex-wrap:wrap; padding:8px 12px; gap:10px; flex-shrink:0; }
                .vp-as-primary-actions { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
                .vp-as-progress-bar { flex:1 1 180px; height:6px; background:rgba(0,0,0,0.3); border-radius:3px; overflow:hidden; }
                .vp-as-progress-bar .fill { height:100%; background:var(--accent); transition:width .25s ease; }
                .vp-as-status { flex:0 0 auto; padding:4px 8px; border-radius:999px; border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.04); color:var(--text-secondary); font-size:11px; white-space:nowrap; }
                .vp-as-inspector { position:absolute; top:44px; bottom:60px; right:8px; width:min(340px, calc(100% - 16px)); border:1px solid rgba(255,255,255,0.12); border-radius:10px; padding:8px; display:flex; flex-direction:column; flex-shrink:0; min-height:0; overflow:auto; transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.3s ease; background:rgba(30,30,36,0.95); backdrop-filter:blur(8px); box-shadow:0 12px 32px rgba(0,0,0,0.5); z-index:200; }
                .vp-as-inspector.collapsed { transform: translateX(120%); opacity:0; pointer-events:none; }
                .vp-as-inspector-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:8px; }
                .vp-as-inspector-sub { font-size:10px; line-height:1.35; color:var(--text-secondary); opacity:0.85; }
                .vp-as-preview-box { flex:0 0 auto; min-height:140px; max-height:220px; margin-bottom:8px; border-radius:8px; border:1px solid rgba(255,255,255,0.08); background:rgba(0,0,0,0.28); display:flex; align-items:center; justify-content:center; overflow:hidden; }
                .vp-as-preview-box img { width:100%; height:100%; object-fit:contain; display:block; background:#050509; }
                .vp-as-preview-placeholder { padding:14px; text-align:center; color:var(--text-secondary); font-size:11px; line-height:1.4; }
                .vp-as-cli-log { flex:1; min-height:120px; border-radius:6px; background:rgba(0,0,0,0.3); border:1px solid rgba(255,255,255,0.06); padding:6px; font:11px/1.4 ui-monospace,Consolas,monospace; overflow:auto; color:var(--text-secondary); }
                .vp-as-cli-log div { margin-bottom:4px; word-break:break-word; }
                @media (max-width: 980px) {
                    .vp-as-sidebar { width:154px; }
                    .vp-as-inspector { width:min(300px, calc(100% - 16px)); }
                }
                @media (max-width: 760px) {
                    .vp-as-canvas-overlay-tools { left:6px; right:6px; justify-content:flex-start; }
                    .vp-as-canvas-overlay-left { top:54px; }
                    .vp-as-inspector { left:8px; right:8px; top:auto; bottom:60px; width:auto; max-height:42%; }
                    .vp-as-preview-box { min-height:96px; }
                    .vp-as-status { width:100%; text-align:center; }
                }

                .vp-as-library-picker-backdrop { position:fixed; inset:0; z-index:50040; display:flex; align-items:center; justify-content:center; padding:24px; background:rgba(0,0,0,0.58); }
                .vp-as-library-picker-card { width:min(960px, 96vw); max-height:88vh; display:flex; flex-direction:column; border-radius:12px; border:1px solid rgba(255,255,255,0.12); background:rgba(28,28,36,0.96); box-shadow:0 18px 50px rgba(0,0,0,0.58); overflow:hidden; }
                .vp-as-library-picker-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; padding:12px 14px; border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); }
                .vp-as-library-picker-title { font-weight:800; font-size:14px; color:var(--text-primary); }
                .vp-as-library-picker-subtitle { margin-top:2px; color:var(--text-secondary); font-size:11px; }
                .vp-as-library-picker-toolbar { display:flex; align-items:center; gap:10px; flex-wrap:wrap; padding:10px 14px 8px; border-bottom:1px solid rgba(255,255,255,0.06); }
                .vp-as-library-roots { display:flex; gap:6px; flex-wrap:wrap; flex:1 1 auto; }
                .vp-as-library-root-chip { border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.04); color:var(--text-primary); border-radius:999px; padding:5px 10px; font-size:11px; cursor:pointer; }
                .vp-as-library-root-chip.active { background:rgba(108,95,166,0.22); border-color:rgba(108,95,166,0.42); }
                .vp-as-library-search { flex:0 1 240px; min-width:180px; border-radius:7px; border:1px solid rgba(255,255,255,0.12); background:rgba(0,0,0,0.22); color:var(--text-primary); padding:6px 8px; font-size:11px; }
                .vp-as-library-picker-breadcrumbs { padding:8px 14px; color:var(--text-secondary); font-size:11px; border-bottom:1px solid rgba(255,255,255,0.06); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-library-picker-body { display:grid; grid-template-columns:minmax(220px, 0.95fr) minmax(320px, 1.35fr); gap:0; min-height:260px; height:min(50vh, 560px); max-height:50vh; overflow:hidden; }
                .vp-as-library-pane { min-height:0; overflow:hidden; display:flex; flex-direction:column; }
                .vp-as-library-pane.folders { border-right:1px solid rgba(255,255,255,0.08); }
                .vp-as-library-pane-title { padding:8px 12px; color:var(--text-secondary); font-size:10px; text-transform:uppercase; letter-spacing:0.06em; border-bottom:1px solid rgba(255,255,255,0.06); }
                .vp-as-library-pane-list { flex:1 1 auto; min-height:0; overflow-x:hidden; overflow-y:scroll; padding:8px; display:flex; flex-direction:column; gap:6px; scrollbar-width:thin; scrollbar-color:rgba(255,255,255,0.24) rgba(255,255,255,0.04); }
                .vp-as-library-pane-list::-webkit-scrollbar { width:10px; }
                .vp-as-library-pane-list::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.20); border-radius:999px; border:2px solid transparent; background-clip:padding-box; }
                .vp-as-library-pane-list::-webkit-scrollbar-thumb:hover { background:rgba(255,255,255,0.30); background-clip:padding-box; }
                .vp-as-library-pane-list::-webkit-scrollbar-track { background:rgba(255,255,255,0.04); border-radius:999px; }
                .vp-as-library-item { width:100%; min-height:30px; box-sizing:border-box; display:flex; align-items:center; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.03); color:var(--text-primary); border-radius:8px; padding:6px 9px; text-align:left; line-height:1.25; cursor:pointer; font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-library-item:hover { background:rgba(255,255,255,0.08); }
                .vp-as-library-item.file.active { border-color:rgba(108,95,166,0.42); background:rgba(108,95,166,0.14); }
                .vp-as-library-empty-inline { color:var(--text-secondary); font-size:11px; padding:8px 4px; }
                .vp-as-library-picker-actions { display:flex; align-items:center; justify-content:flex-end; gap:8px; padding:10px 14px 14px; border-top:1px solid rgba(255,255,255,0.08); }
                .vp-as-library-picker-backdrop.is-busy .vp-as-library-picker-card { opacity:0.7; pointer-events:none; }
                @media (max-width: 860px) {
                    .vp-as-library-picker-body { grid-template-columns:1fr; height:min(60vh, 640px); max-height:60vh; }
                    .vp-as-library-pane.folders { border-right:0; border-bottom:1px solid rgba(255,255,255,0.08); }
                }

                /* Node */
                .vp-as-node { position:absolute; min-width:200px; min-height:120px; background:var(--bg-secondary); border:1px solid var(--border); border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.35); z-index:2; display:flex; flex-direction:column; overflow:hidden; resize:horizontal; transition: box-shadow 0.15s, border-color 0.15s; user-select:none; -webkit-user-drag:none; }
                .vp-as-node * { -webkit-user-drag:none; }
                .vp-as-node input, .vp-as-node textarea, .vp-as-node select { user-select:text; -webkit-user-drag:auto; }
                .vp-as-node.selected { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent), 0 8px 24px rgba(0,0,0,0.5); z-index:100; }
                .vp-as-node-header { padding:8px 10px; font-weight:800; font-size:12px; background:linear-gradient(90deg, var(--node-color) 0%, transparent 100%); cursor:grab; user-select:none; text-shadow:0 1px 2px rgba(0,0,0,0.5); letter-spacing:0.02em; border-bottom:1px solid rgba(255,255,255,0.04); }
                .vp-as-node-header:active { cursor:grabbing; }
                .vp-as-node-sockets { display:flex; flex-direction:column; gap:4px; padding:6px 0; font-size:11px; }
                .vp-as-socket { display:flex; align-items:center; gap:6px; padding:6px 12px; cursor:crosshair; margin:0 -4px; border-radius:4px; transition:background .15s; }
                .vp-as-socket:hover { background:rgba(255,255,255,0.06); }
                .vp-as-socket.output { flex-direction:row-reverse; }
                .vp-as-socket-dot { width:12px; height:12px; border-radius:50%; background:var(--node-color); border:2px solid rgba(255,255,255,0.8); box-shadow:0 0 4px var(--node-color); transition:transform .15s cubic-bezier(0.4, 0, 0.2, 1); flex-shrink:0; pointer-events:none; }
                .vp-as-socket:hover .vp-as-socket-dot { transform:scale(1.3); background:#fff; }
                .vp-as-socket-snapped .vp-as-socket-dot { transform:scale(1.6); background:#fff; box-shadow:0 0 10px #fff; }
                .vp-as-socket-label { color:var(--text-secondary); font-weight:600; pointer-events:none; }
                .vp-as-node-body { padding:10px; border-top:1px solid rgba(255,255,255,0.04); border-bottom:1px solid rgba(255,255,255,0.04); background:rgba(0,0,0,0.15); }
                .vp-as-node-visual { box-shadow:0 8px 22px rgba(0,0,0,0.42); }
                .vp-as-node-visual .vp-as-node-header { letter-spacing:0.03em; }
                .vp-as-node-visual .vp-as-node-body { flex:1 1 auto; min-height:0; overflow:auto; }

                /* Context Menu */
                .vp-as-context-menu { position:fixed; z-index:50002; background:rgba(30,30,36,0.95); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,0.12); border-radius:6px; padding:4px; display:flex; flex-direction:column; gap:2px; min-width:140px; box-shadow:0 12px 32px rgba(0,0,0,0.5); font-size:11px; }
                .vp-as-context-menu-item { padding:6px 8px; border-radius:4px; cursor:pointer; color:var(--text-primary); display:flex; align-items:center; gap:8px; }
                .vp-as-context-menu-item:hover { background:rgba(255,255,255,0.12); }
                .vp-as-context-menu-item.danger { color:#ff6b6b; }
                .vp-as-context-menu-item.danger:hover { background:rgba(255,60,60,0.15); }

                /* Pill stack (Tower-style argument list) */
                .vp-as-pill-stack { display:flex; flex-direction:column; gap:8px; }
                .vp-as-node[data-node-type="loader"] .vp-as-pill-stack,
                .vp-as-node[data-node-type="sampler"] .vp-as-pill-stack {
                    gap: 6px;
                }
                .vp-as-pill {
                    background:rgba(0,0,0,0.25);
                    border:1px solid rgba(255,255,255,0.1);
                    border-left:4px solid var(--pill-color);
                    border-radius:8px;
                    overflow:hidden;
                    font-size:11px;
                    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
                    transition: background 0.2s ease, border-color 0.2s ease;
                }
                .vp-as-pill:hover {
                    background:rgba(0,0,0,0.35);
                    border-color:rgba(255,255,255,0.18);
                }
                .vp-as-pill-summary {
                    display:flex;
                    align-items:center;
                    gap:6px;
                    padding:7px 8px;
                    cursor:pointer;
                    user-select:none;
                    list-style:none;
                }
                .vp-as-pill-summary::-webkit-details-marker { display:none; }
                .vp-as-pill-dot { display:none !important; }
                .vp-as-pill-key { font-weight:700; color:var(--text-primary); flex:1 1 auto; min-width:0; letter-spacing:0.02em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-pill-value { margin-left:auto; color:var(--text-secondary); text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:110px; }
                .vp-as-pill-wing { color:color-mix(in srgb, var(--pill-color) 72%, #eef0ff); font-size:12px; line-height:1; opacity:0.82; flex-shrink:0; text-shadow:0 0 8px color-mix(in srgb, var(--pill-color) 24%, transparent); }
                .vp-as-pill-wing.left { display:none !important; }
                .vp-as-pill-wing.right { margin-left:4px; transition:transform .16s ease, opacity .16s ease; opacity:0.72; }
                .vp-as-pill[open] > .vp-as-pill-summary .vp-as-pill-wing.right { transform:rotate(90deg); opacity:1; }
                .vp-as-pill-body { padding:10px; border-top:1px solid rgba(255,255,255,0.08); background:rgba(0,0,0,0.15); }
                .vp-as-pill[data-arg-key="positive"],
                .vp-as-pill[data-arg-key="negative"] {
                    overflow: visible;
                }
                .vp-as-pill[data-arg-key="positive"] .vp-as-pill-body,
                .vp-as-pill[data-arg-key="negative"] .vp-as-pill-body {
                    padding-bottom: 14px;
                }
                .vp-as-pill-body .vp-btn { margin-top:8px; }
                .vp-as-pill-inline { padding:0 6px; min-height:28px; display:flex; align-items:center; }
                .vp-as-pill-inline .vp-as-pill-wing { display:none !important; }
                .vp-as-pill-inline-row { width:100%; display:flex; align-items:center; gap:6px; min-width:0; }
                .vp-as-pill-inline-spacer { display:none; }
                .vp-as-pill-inline-control { margin-left:auto; width:fit-content; max-width:100%; display:flex; align-items:center; justify-content:flex-end; gap:4px; min-width:0; flex:0 0 auto; }
                .vp-as-pill-inline-control > * { min-width:0; }
                .vp-as-pill-inline .vp-as-pill-key { display:block; min-width:0; flex:1 1 auto; width:auto; max-width:none; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-size:10.5px; }
                .vp-as-pill-inline .vp-as-pill-path { margin-bottom:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; min-width:0; flex:1 1 auto; color:var(--text-secondary); font-size:10px; }
                .vp-as-pill-inline .vp-as-pill-inline-control[data-ctrl-type="number"] { width:70px; flex-basis:70px; }
                .vp-as-pill-inline .vp-as-pill-inline-control[data-ctrl-type="file"] { width:clamp(104px, 64%, 360px); min-width:104px; max-width:68%; flex-basis:clamp(104px, 64%, 360px); }
                .vp-as-pill-inline .vp-as-pill-inline-control[data-ctrl-type="select"] { width:74px; flex-basis:74px; }
                .vp-as-pill-inline .vp-as-pill-inline-control[data-ctrl-type="checkbox"] { width:22px; flex-basis:22px; }
                .vp-as-pill-inline .vp-as-pill-inline-control[data-ctrl-type="text"] { width:96px; flex-basis:96px; }
                .vp-as-pill-inline .vp-as-pill-select,
                .vp-as-pill-inline .vp-as-pill-text { width:100%; min-width:0; max-width:none; flex:1 1 auto; }
                .vp-as-pill-inline .vp-as-pill-select { height:21px; font-size:10px; padding:1px 14px 1px 6px; }
                .vp-as-pill-inline .vp-as-pill-text { height:21px; font-size:10px; padding:1px 7px; }
                .vp-as-pill-inline .vp-as-pill-checkbox-wrap { margin-left:0; white-space:nowrap; justify-content:center; width:auto; font-size:10px; gap:0 !important; }
                .vp-as-pill-inline .vp-as-pill-checkbox-wrap input { margin:0; }
                .vp-as-file-picker { width:100%; min-width:0; height:22px; display:flex; align-items:center; justify-content:space-between; gap:6px; border:1px solid rgba(255,255,255,0.15); border-radius:7px; background:rgba(255,255,255,0.05); color:var(--text-primary); padding:1px 6px; font-size:10px; cursor:pointer; }
                .vp-as-file-picker:hover { background:rgba(255,255,255,0.10); border-color:rgba(255,255,255,0.22); }
                .vp-as-file-picker.is-empty { color:var(--text-secondary); }
                .vp-as-file-picker-name { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left; }
                .vp-as-file-picker-caret { flex:0 0 auto; color:var(--text-secondary); font-size:10px; }
                .vp-as-pill-inline .vp-btn { margin-top:0; height:21px; padding:1px 6px; flex:0 0 auto; }
                .vp-as-pill-inline .vp-as-pill-inline-control .vp-btn { min-width:48px; }
                .vp-as-number-stepper { width:70px; display:inline-flex; align-items:center; justify-content:space-between; gap:0; padding:1px; border-radius:8px; border:1px solid rgba(255,255,255,0.14); background:rgba(0,0,0,0.18); box-shadow:0 1px 2px rgba(0,0,0,0.22) inset; }
                .vp-as-step-btn { width:17px; height:17px; padding:0; border-radius:6px; border:0; background:rgba(255,255,255,0.04); color:color-mix(in srgb, var(--pill-color) 82%, #f4f4ff); font-size:11px; font-weight:700; line-height:1; cursor:pointer; flex:0 0 auto; }
                .vp-as-step-btn:hover { background:rgba(255,255,255,0.12); }
                .vp-as-pill-inline .vp-as-number-stepper { justify-content:space-between; }
                .vp-as-pill-inline .vp-as-pill-number { width:22px; flex:0 0 auto; border:0; background:transparent; box-shadow:none; padding:0; text-align:center; font-size:10.5px; }
                .vp-as-pill-number { appearance:textfield; -moz-appearance:textfield; text-align:right; }
                .vp-as-pill-number::-webkit-outer-spin-button,
                .vp-as-pill-number::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
                .vp-as-pill-path { font-size:10px; color:var(--text-secondary); word-break:break-word; margin-bottom:8px; }
                .vp-as-pill-row { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px; }
                .vp-as-pill-row span { color:var(--text-secondary); }
                .vp-as-pill-textarea, .vp-as-pill-number, .vp-as-pill-select, .vp-as-pill-text {
                    width:100%; box-sizing:border-box;
                    border-radius:6px; border:1px solid rgba(255,255,255,0.15);
                    background:rgba(0,0,0,0.3); color:var(--text-primary);
                    padding:6px 8px; font-size:11px;
                    transition: border-color 0.15s, background 0.15s;
                }
                .vp-as-pill-textarea:focus, .vp-as-pill-number:focus, .vp-as-pill-select:focus, .vp-as-pill-text:focus {
                    border-color:var(--accent); background:rgba(0,0,0,0.4); outline:none;
                }
                .vp-as-pill-textarea { resize:vertical; min-height:60px; display:block; font-family:inherit; overflow:auto; }
                .vp-as-pill-number { width:auto; text-align:right; }
                .vp-as-pill-del { margin-top:8px; width:100%; background:rgba(255,60,60,0.1); border-color:rgba(255,60,60,0.2); color:#ff8a8a; }
                .vp-as-pill-del:hover { background:rgba(255,60,60,0.2); color:#fff; }
                .vp-as-multi-file-list { display:grid; grid-template-columns:1fr; gap:8px; min-height:72px; padding:6px; border:1px dashed rgba(255,255,255,0.10); border-radius:8px; background:rgba(255,255,255,0.025); }
                .vp-as-multi-file-list.is-drop-target { border-color:var(--accent); background:rgba(108,95,166,0.10); box-shadow:0 0 0 1px rgba(108,95,166,0.22) inset; }
                .vp-as-multi-img-wrap { position:relative; width:100%; border-radius:6px; overflow:hidden; background:rgba(0,0,0,0.34); border:1px solid rgba(255,255,255,0.06); display:flex; align-items:center; justify-content:center; min-height:108px; }
                .vp-as-multi-img { width:100%; height:auto; max-height:220px; object-fit:contain; display:block; background:#09090f; }
                .vp-as-multi-img-meta { position:absolute; left:0; right:0; bottom:0; padding:16px 6px 4px 6px; background:linear-gradient(transparent, rgba(0,0,0,0.8)); pointer-events:none; }
                .vp-as-multi-img-meta span { font-size:10px; color:#ddd; white-space:nowrap; max-width:100%; overflow:hidden; text-overflow:ellipsis; display:block; text-shadow:0 1px 2px #000; }
                .vp-as-multi-footer { display:flex; align-items:center; gap:8px; margin-top:6px; }
                .vp-as-drop-hint { margin-top:0; color:var(--text-secondary); font-size:10px; line-height:1.2; text-align:left; opacity:0.9; flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
                .vp-as-node-dropzone { display:flex; flex-direction:column; gap:3px; align-items:center; justify-content:center; min-height:62px; margin-top:4px; padding:10px 12px; border:1px dashed rgba(255,255,255,0.12); border-radius:8px; background:rgba(255,255,255,0.03); color:var(--text-secondary); font-size:11px; text-align:center; transition:border-color .15s, background .15s, color .15s; }
                .vp-as-node-dropzone b { color:var(--text-primary); font-size:11px; }
                .vp-as-node-dropzone.is-active { border-color:var(--accent); background:rgba(108,95,166,0.10); color:var(--text-primary); }
                .vp-as-prompt-body { gap:10px; }
                .vp-as-output-body { gap:10px; }

                /* Add-argument menu */
                .vp-as-add-arg { position:relative; margin-top:8px; }
                .vp-as-arg-menu { position:absolute; top:calc(100% + 4px); left:0; min-width:200px; z-index:20; background:rgba(30,30,36,0.95); backdrop-filter:blur(8px); border:1px solid rgba(255,255,255,0.12); border-radius:8px; padding:6px; display:flex; flex-direction:column; gap:2px; max-height:260px; overflow:auto; box-shadow:0 12px 32px rgba(0,0,0,0.5); }
                .vp-as-arg-menu::-webkit-scrollbar { width:6px; }
                .vp-as-arg-menu::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.2); border-radius:3px; }
                .vp-as-arg-menu-item { display:flex; align-items:center; gap:8px; padding:6px 8px; border-radius:5px; background:none; border:0; color:var(--text-primary); font-size:11px; cursor:pointer; text-align:left; transition:background 0.15s ease; }
                .vp-as-arg-menu-item:hover { background:rgba(255,255,255,0.12); }
                .vp-as-arg-menu-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; box-shadow:0 0 4px rgba(0,0,0,0.3); }
                .vp-as-arg-menu-item code { margin-left:auto; color:var(--text-secondary); font-size:10px; opacity:0.7; }

                /* LoRA rows */
                .vp-as-lora-row { display:flex; align-items:center; gap:6px; background:rgba(0,0,0,0.22); border:1px solid rgba(255,255,255,0.08); border-radius:7px; padding:5px; font-size:10px; margin-bottom:4px; }
                .vp-as-lora-picker { flex:1 1 auto; min-width:0; height:28px; display:flex; align-items:center; justify-content:space-between; gap:6px; border:1px solid rgba(255,255,255,0.12); border-radius:7px; background:rgba(255,255,255,0.05); color:var(--text-primary); padding:1px 8px; cursor:pointer; }
                .vp-as-lora-picker:hover { background:rgba(255,255,255,0.10); border-color:rgba(255,255,255,0.20); }
                .vp-as-lora-picker.is-empty { color:var(--text-secondary); }
                .vp-as-lora-picker-name { flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; text-align:left; font-size:10px; }
                .vp-as-lora-picker-caret { flex:0 0 auto; color:var(--text-secondary); font-size:10px; }
                .vp-as-lora-stepper { width:78px; display:inline-flex; align-items:center; justify-content:space-between; gap:0; padding:1px; border-radius:8px; border:1px solid rgba(255,255,255,0.14); background:rgba(0,0,0,0.18); box-shadow:0 1px 2px rgba(0,0,0,0.22) inset; }
                .vp-as-lora-step-btn { width:18px; height:18px; padding:0; border-radius:6px; border:0; background:rgba(255,255,255,0.04); color:#b9c7ff; font-size:11px; font-weight:700; line-height:1; cursor:pointer; flex:0 0 auto; }
                .vp-as-lora-step-btn:hover { background:rgba(255,255,255,0.12); }
                .vp-as-lora-weight { width:26px; flex:0 0 auto; border:0; background:transparent; box-shadow:none; padding:0; text-align:center; font-size:10.5px; color:var(--text-primary); appearance:textfield; -moz-appearance:textfield; }
                .vp-as-lora-weight::-webkit-outer-spin-button,
                .vp-as-lora-weight::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
                .vp-as-lora-del { min-width:22px; padding:0; }

                /* Output */
                .vp-as-output-preview { flex:1 1 auto; min-height:160px; border-radius:8px; background:#000; display:flex; align-items:center; justify-content:center; overflow:hidden; margin-bottom:4px; border:1px solid rgba(255,255,255,0.08); }
                .vp-as-output-preview img { width:100%; height:100%; object-fit:contain; display:block; }
                .vp-as-output-placeholder { color:var(--text-secondary); text-align:center; font-size:11px; line-height:1.45; padding:14px; }
                .vp-as-output-placeholder small { display:block; margin-top:6px; opacity:0.8; }

                /* Links */
                .vp-as-link { fill:none; stroke:var(--accent); stroke-width:2.5; opacity:0.8; cursor:pointer; transition:stroke-width .1s, opacity .1s; }
                .vp-as-link:hover { stroke-width:4; opacity:1; }
                .vp-as-link-draft { stroke:rgba(255,255,255,0.35); stroke-dasharray:5,4; }
            `;
            document.head.appendChild(style);
        }
    };

    window.VisualProjector.assetStudio = AssetStudio;
    AssetStudio.init();
})();
