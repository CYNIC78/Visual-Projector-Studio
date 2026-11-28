// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-shell.js                                             ║
// ║  Visual Projector — standalone Blender-lite workspace shell      ║
// ║                                                                  ║
// ║  Owns: panel registry UI, split-pane layout, workspace presets.  ║
// ║  Does NOT own: model fetch pipeline, gallery data, projector      ║
// ║  playback. This module is optional: remove it and the old         ║
// ║  floating projector/gallery mode still works.                     ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Shell] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const S = VP.state;
    const DB = window.VP_DB;
    const STORAGE_KEY = 'vp-shell-v1';

    let activeWorkspaceContextMenuCleanup = null;

    // Polyfill registry if this shell is loaded against an older core.
    if (typeof VP.registerPanel !== 'function') {
        const panels = new Map();
        VP.registerPanel = (def) => {
            if (!def || !def.id || typeof def.create !== 'function') return false;
            panels.set(def.id, { title: def.title || def.id, icon: def.icon || '□', order: def.order || 100, ...def });
            return true;
        };
        VP.getPanel = (id) => panels.get(id) || null;
        VP.getPanels = () => Array.from(panels.values()).sort((a, b) => (a.order || 100) - (b.order || 100));
    }

    const clone = (x) => JSON.parse(JSON.stringify(x));
    const uid = (prefix = 'area') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    function requestProjectorUiUpdate(reason = 'shell') {
        const fallback = () => VP.updateProjectorUI?.();
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('projector:update-ui', { reason }, { source: 'shell' })
                .catch((err) => {
                    console.warn('[VP Shell] Hub projector:update-ui failed; using legacy fallback:', err);
                    fallback();
                });
            return true;
        }
        fallback();
        return false;
    }

    function requestGalleryUiRefresh(reason = 'shell') {
        const fallback = () => VP.gallery?.refreshGalleryPanelUI?.();
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('gallery:refresh-ui', { reason }, { source: 'shell' })
                .catch((err) => {
                    console.warn('[VP Shell] Hub gallery:refresh-ui failed; using legacy fallback:', err);
                    fallback();
                });
            return true;
        }
        fallback();
        return false;
    }

    function requestGallerySettingsSync(reason = 'shell') {
        const fallback = () => VP.gallery?.syncSettingsUI?.();
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('gallery:sync-settings-ui', { reason }, { source: 'shell' })
                .catch((err) => {
                    console.warn('[VP Shell] Hub gallery:sync-settings-ui failed; using legacy fallback:', err);
                    fallback();
                });
            return true;
        }
        fallback();
        return false;
    }

    // Some panels wrap singleton DOM/runtime objects. They cannot be mounted
    // into two areas at once: moving the same DOM node would leave the first
    // area visually empty. During a render pass, the first occurrence wins and
    // duplicates show a friendly placeholder instead.
    const SINGLETON_PANELS = new Set(['stage', 'asset-studio']);
    let _renderedSingletonPanels = new Set();

    function leaf(panel) {
        return { type: 'leaf', id: uid(), panel };
    }
    function split(direction, ratio, a, b) {
        return { type: 'split', id: uid('split'), direction, ratio, a, b };
    }

    const PRESETS = {
        performance: {
            title: 'Performance', icon: '🎭',
            layout: split('column', 0.78, leaf('stage'), leaf('input')),
        },
        director: {
            title: 'Director', icon: '🎬',
            layout: split('row', 0.62,
                split('column', 0.72, leaf('stage'), leaf('log')),
                split('column', 0.58, leaf('asset-studio'), leaf('model'))
            ),
        },
        workshop: {
            title: 'Workshop', icon: '🛠',
            layout: split('row', 0.52,
                leaf('asset-studio'),
                split('column', 0.50, leaf('stage'), split('row', 0.5, leaf('log'), leaf('model')))
            ),
        },
    };

    function defaultShellState() {
        return {
            enabled: true,
            activeWorkspace: 'director',
            customWorkspaces: {},
            layouts: Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, clone(p.layout)])),
            globalSettingsCollapsed: {}, // Persist collapsed state of global settings sections
        };
    }

    async function loadShellState() {
        if (!S.shell) S.shell = defaultShellState();

        let savedShell = null;
        let savedModel = null;
        let savedGeom = null;

        if (DB?.getShellState) {
            try { savedShell = await DB.getShellState(); }
            catch (err) { console.warn('[VP Shell] Failed to load shell state from storage:', err); }
        }
        if (DB?.getModelConfig) {
            try { savedModel = await DB.getModelConfig(); }
            catch (err) { console.warn('[VP Shell] Failed to load model config from storage:', err); }
        }
        if (DB?.getWinGeom) {
            try { savedGeom = await DB.getWinGeom(); }
            catch (err) { console.warn('[VP Shell] Failed to load projector geometry from storage:', err); }
        }

        if (!savedShell) {
            try { savedShell = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
            catch (err) { console.warn('[VP Shell] Failed to load legacy shell state:', err); }
            if (savedShell && DB?.setShellState) DB.setShellState(savedShell).catch(() => {});
        }
        if (!savedModel) {
            try { savedModel = JSON.parse(localStorage.getItem('vp-model-config-v1') || 'null'); } catch {}
            if (savedModel && DB?.setModelConfig) DB.setModelConfig(savedModel).catch(() => {});
        }
        if (!savedGeom) {
            try { savedGeom = JSON.parse(localStorage.getItem('vp-state') || 'null'); } catch {}
            if (savedGeom && DB?.setWinGeom) DB.setWinGeom(savedGeom).catch(() => {});
        }

        if (savedShell) {
            S.shell = {
                ...defaultShellState(),
                ...savedShell,
                layouts: { ...defaultShellState().layouts, ...(savedShell.layouts || {}) },
                customWorkspaces: savedShell.customWorkspaces || {},
                globalSettingsCollapsed: savedShell.globalSettingsCollapsed || {},
            };
        }
        if (savedModel) S.modelConfig = { ...(S.modelConfig || {}), ...savedModel };
        if (savedGeom) S.ui.projectorFloatingGeom = savedGeom;
    }

    function getShellStateForStorage() {
        const copy = clone(S.shell || defaultShellState());
        // Asset Studio graph/workflows can be large. It has its own asset-studio.json now;
        // keeping it inside shell.json made every layout save huge.
        delete copy.assetStudio;
        return copy;
    }

    function saveShellState() {
        const payload = getShellStateForStorage();
        if (DB?.setShellState) DB.setShellState(payload).catch(err => console.warn('[VP Shell] Failed to save shell state:', err));
        else {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); }
            catch (err) { console.warn('[VP Shell] Failed to save shell state:', err); }
        }
    }

    function getWorkspaceDefs() {
        const customs = S.shell?.customWorkspaces || {};
        return {
            ...Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { title: p.title, icon: p.icon, builtin: true }])),
            ...customs,
        };
    }

    function getCurrentLayout() {
        const id = S.shell.activeWorkspace;
        if (!S.shell.layouts[id]) S.shell.layouts[id] = clone(PRESETS.director.layout);
        return S.shell.layouts[id];
    }

    function setCurrentLayout(layout) {
        S.shell.layouts[S.shell.activeWorkspace] = layout;
        saveShellState();
    }

    // ════════════════════════════════════════════════════════════════
    //  BUILT-IN PANELS
    // ════════════════════════════════════════════════════════════════

    function clearContainer(container) {
        container.innerHTML = '';
    }

    function makePlaceholder(container, title, text) {
        clearContainer(container);
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-placeholder';
        wrap.innerHTML = `<div class="vp-shell-placeholder-title"></div><div class="vp-shell-placeholder-text"></div>`;
        wrap.querySelector('.vp-shell-placeholder-title').textContent = title;
        wrap.querySelector('.vp-shell-placeholder-text').textContent = text;
        container.appendChild(wrap);
    }

    function captureFloatingProjectorGeom(el) {
        if (!el || el.classList.contains('vp-shell-docked-stage')) return;
        const rect = el.getBoundingClientRect?.();
        if (!rect || rect.width <= 0 || rect.height <= 0) return;
        S.ui.projectorFloatingGeom = {
            left: rect.left,
            top: rect.top,
            width: rect.width,
            height: rect.height,
        };
    }

    function dockElement(container, el, className) {
        if (className === 'vp-shell-docked-stage') captureFloatingProjectorGeom(el);
        clearContainer(container);
        container.appendChild(el);
        el.classList.add(className, 'vp-shell-docked');
        el.style.display = '';
        el.style.position = 'relative';
        el.style.left = 'auto';
        el.style.top = 'auto';
        el.style.right = 'auto';
        el.style.bottom = 'auto';
        el.style.width = '100%';
        el.style.height = '100%';
        el.style.maxWidth = 'none';
        el.style.maxHeight = 'none';
        el.style.zIndex = 'auto';
    }

    function renderGallerySettings(container) {
        clearContainer(container);
        const cfg = S.config || {};
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-settings-form';
        wrap.innerHTML = `
            <label><span>Auto-tag on load</span>
                <select data-k="autoTagOnLoad">
                    <option value="ask">Ask</option>
                    <option value="always">Always</option>
                    <option value="never">Never</option>
                </select>
            </label>
            <label><span>Manifest descriptions</span><input data-k="manifestDescriptions" type="checkbox"></label>
            <label><span>Directory commands</span><input data-k="allowDirectoryCommands" type="checkbox"></label>
            <label><span>Max image side, px</span><input data-k="maxLongSide" type="number" min="256" max="4096" step="64"></label>
            <label><span>JPEG quality</span><input data-k="jpegQuality" type="number" min="0.1" max="1" step="0.01"></label>
            <div class="vp-shell-settings-note">
                Gallery settings affect imports, visual manifest and how much asset-tree context the model sees. Existing imported images are not recompressed retroactively.
            </div>`;

        const persist = () => {
            if (VP.gallery?.persistConfig) VP.gallery.persistConfig();
            else VP.schedulePersist?.();
            requestGalleryUiRefresh('shell-gallery-settings');
        };
        const clampNum = (v, min, max, fallback) => {
            const n = Number(v);
            if (!Number.isFinite(n)) return fallback;
            return Math.max(min, Math.min(max, n));
        };

        wrap.querySelector('[data-k="autoTagOnLoad"]').value = cfg.autoTagOnLoad || 'ask';
        wrap.querySelector('[data-k="manifestDescriptions"]').checked = cfg.manifestDescriptions !== false;
        wrap.querySelector('[data-k="allowDirectoryCommands"]').checked = !!cfg.allowDirectoryCommands;
        wrap.querySelector('[data-k="maxLongSide"]').value = cfg.maxLongSide ?? 1024;
        wrap.querySelector('[data-k="jpegQuality"]').value = cfg.jpegQuality ?? 0.92;

        wrap.querySelectorAll('[data-k]').forEach(el => {
            el.addEventListener('change', () => {
                const k = el.dataset.k;
                if (k === 'manifestDescriptions' || k === 'allowDirectoryCommands') cfg[k] = !!el.checked;
                else if (k === 'maxLongSide') { cfg[k] = clampNum(el.value, 256, 4096, 1024); el.value = cfg[k]; }
                else if (k === 'jpegQuality') { cfg[k] = clampNum(el.value, 0.1, 1, 0.92); el.value = Number(cfg[k]).toFixed(2); }
                else cfg[k] = el.value;
                persist();
            });
        });
        container.appendChild(wrap);
    }

    function renderStageSettings(container) {
        clearContainer(container);
        const cfg = S.config || {};
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-settings-form';
        wrap.innerHTML = `
            <label><span>Transition</span>
                <select data-k="transitionType">
                    <option value="random">🎲 Random</option>
                    <option value="fade">Sequential Fade</option>
                    <option value="crossfade">Crossfade</option>
                    <option value="slide_left">Slide Left</option>
                    <option value="slide_up">Slide Up</option>
                    <option value="zoom">Zoom</option>
                    <option value="pop">Pop</option>
                    <option value="flip">3D Flip</option>
                </select>
            </label>
            <label><span>Fade duration, sec</span><input data-k="fadeDuration" type="number" min="0" max="5" step="0.1"></label>
            <label><span>Subtitle speed</span><input data-k="subtitleSpeed" type="number" min="0.5" max="2" step="0.1"></label>
            <label><span>Subtitle WPM</span><input data-k="subtitleWPM" type="number" min="60" max="400" step="10"></label>
            <label><span>Visual context depth</span><input data-k="contextDepth" type="number" min="0" max="30" step="1"></label>
            <label><span>Max visual history</span><input data-k="maxHistory" type="number" min="5" max="200" step="1"></label>
            <label><span>Effects enabled</span><input data-k="effectsEnabled" type="checkbox"></label>
            <label><span>Debug VP tags</span><input data-k="debugTags" type="checkbox"></label>
            <div class="vp-shell-settings-note">Visual context depth controls how many recent frames are sent back to the model. Cover, when set, acts as a persistent visual anchor.</div>`;

        const setValue = (k, v) => {
            if (k === 'fadeDuration') cfg[k] = Math.max(0, Math.min(5, parseFloat(v) || 0));
            else if (k === 'subtitleSpeed') cfg[k] = Math.max(0.5, Math.min(2, parseFloat(v) || 1));
            else if (k === 'subtitleWPM') cfg[k] = Math.max(60, Math.min(400, parseInt(v, 10) || 160));
            else if (k === 'contextDepth') cfg[k] = Math.max(0, Math.min(30, parseInt(v, 10) || 0));
            else if (k === 'maxHistory') {
                cfg[k] = Math.max(5, Math.min(200, parseInt(v, 10) || 20));
                if (S.history && S.history.length > cfg[k]) S.history = S.history.slice(-cfg[k]);
            }
            else if (k === 'effectsEnabled' || k === 'debugTags') cfg[k] = !!v;
            else cfg[k] = v;
            if (k === 'subtitleSpeed') {
                const slider = S.ui?.vpWindow?.querySelector('#vp-speed-slider');
                const label = S.ui?.vpWindow?.querySelector('#vp-speed-label');
                if (slider) slider.value = cfg.subtitleSpeed;
                if (label) label.textContent = `${Number(cfg.subtitleSpeed || 1).toFixed(1)}x`;
            }
            VP.updatePlayerBar?.();
            requestProjectorUiUpdate('shell')
            VP.schedulePersist?.();
        };

        wrap.querySelector('[data-k="transitionType"]').value = cfg.transitionType || 'random';
        wrap.querySelector('[data-k="fadeDuration"]').value = cfg.fadeDuration ?? 0.3;
        wrap.querySelector('[data-k="subtitleSpeed"]').value = cfg.subtitleSpeed ?? 1.0;
        wrap.querySelector('[data-k="subtitleWPM"]').value = cfg.subtitleWPM ?? 160;
        wrap.querySelector('[data-k="contextDepth"]').value = cfg.contextDepth ?? 3;
        wrap.querySelector('[data-k="maxHistory"]').value = cfg.maxHistory ?? 20;
        wrap.querySelector('[data-k="effectsEnabled"]').checked = cfg.effectsEnabled !== false;
        wrap.querySelector('[data-k="debugTags"]').checked = !!cfg.debugTags;

        wrap.querySelectorAll('[data-k]').forEach(el => {
            el.addEventListener('change', () => {
                const k = el.dataset.k;
                setValue(k, el.type === 'checkbox' ? el.checked : el.value);
            });
        });
        container.appendChild(wrap);
    }





    function formatHealthReport(report) {
        if (!report) return 'No report';
        const lines = [];
        lines.push(`Health Check — ${new Date(report.checkedAt || Date.now()).toLocaleString()}`);
        lines.push(`Backend: ${report.backend?.backend || 'unknown'}`);
        lines.push(`World: ${report.backend?.worldId || 'unknown'}`);
        lines.push(`World folder: ${report.backend?.worldRoot || 'unknown'}`);
        lines.push('');
        lines.push('Counts:');
        for (const [k, v] of Object.entries(report.counts || {})) lines.push(`  ${k}: ${v}`);
        lines.push('');
        lines.push('Checks:');
        for (const item of report.items || []) lines.push(`  [${String(item.level || '').toUpperCase()}] ${item.label}${item.detail ? ' — ' + item.detail : ''}`);
        return lines.join('\n');
    }

    async function showHealthCheckModal() {
        closeShellModals();
        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop global';
        backdrop.style.setProperty('--vp-modal-width', '780px');
        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">🩺 Health Check</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-health-toolbar">
                    <button class="vp-btn vp-btn-ghost" data-act="run">Run again</button>
                    <button class="vp-btn vp-btn-ghost" data-act="copy">Copy report</button>
                    <button class="vp-btn vp-btn-ghost" data-act="folder">Open world folder</button>
                    <span data-role="summary">Running...</span>
                </div>
                <div class="vp-health-counts"></div>
                <div class="vp-health-list"><div class="vp-health-empty">Running health check...</div></div>
            </div>`;
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);

        const close = () => closeShellModals();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        setTimeout(() => document.addEventListener('keydown', _modalEscHandler, true), 0);

        const summary = card.querySelector('[data-role="summary"]');
        const list = card.querySelector('.vp-health-list');
        const counts = card.querySelector('.vp-health-counts');
        let lastReport = null;

        const icon = (level) => level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : level === 'error' ? '❌' : 'ℹ️';
        const run = async () => {
            list.innerHTML = `<div class="vp-health-empty">Running health check...</div>`;
            counts.innerHTML = '';
            summary.textContent = 'Running...';
            if (!DB?.healthCheck) {
                summary.textContent = 'Unavailable';
                list.innerHTML = `<div class="vp-health-empty">Health Check requires Neutralino filesystem storage backend.</div>`;
                return;
            }
            try {
                lastReport = await DB.healthCheck();
                const errors = (lastReport.items || []).filter(i => i.level === 'error').length;
                const warnings = (lastReport.items || []).filter(i => i.level === 'warn').length;
                summary.textContent = errors ? `${errors} error(s), ${warnings} warning(s)` : warnings ? `${warnings} warning(s)` : 'All clear';
                summary.className = errors ? 'err' : warnings ? 'warn' : 'ok';

                counts.innerHTML = '';
                for (const [k, v] of Object.entries(lastReport.counts || {})) {
                    const chip = document.createElement('div');
                    chip.className = 'vp-health-chip';
                    chip.innerHTML = `<span>${k}</span><b>${v}</b>`;
                    counts.appendChild(chip);
                }

                list.innerHTML = '';
                for (const item of lastReport.items || []) {
                    const row = document.createElement('div');
                    row.className = `vp-health-row ${item.level || 'info'}`;
                    row.innerHTML = `<div class="vp-health-row-title">${icon(item.level)} <b></b></div><div class="vp-health-row-detail"></div>`;
                    row.querySelector('b').textContent = item.label || '';
                    row.querySelector('.vp-health-row-detail').textContent = item.detail || '';
                    list.appendChild(row);
                }
            } catch (err) {
                console.error('[VP Shell] Health check failed:', err);
                summary.textContent = 'Failed';
                summary.className = 'err';
                list.innerHTML = `<div class="vp-health-empty">Health check failed: ${err.message || err}</div>`;
            }
        };

        card.querySelector('[data-act="run"]').addEventListener('click', run);
        card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
            if (!lastReport) return;
            try { await navigator.clipboard?.writeText(formatHealthReport(lastReport)); VP.showToast?.('Health report copied', 'success'); }
            catch { VP.showToast?.('Clipboard unavailable', 'error'); }
        });
        card.querySelector('[data-act="folder"]').addEventListener('click', () => openCurrentWorldFolder());
        run();
    }

    async function renderGlobalSettings(container) {
        clearContainer(container);
        const cfg = S.config || {};
        const COLOR_VARIABLES = [
            { key: '--accent', label: 'Primary Accent' },
            { key: '--bg-primary', label: 'Main Background' },
            { key: '--bg-secondary', label: 'Sidebar Background' },
            { key: '--bg-tertiary', label: 'Panel Background' },
            { key: '--border', label: 'Borders & Lines' },
            { key: '--text-primary', label: 'Main Text' },
            { key: '--text-secondary', label: 'Secondary Text' },
            { key: '--header-accent', label: 'Header Background' },
            { key: '--msg-user-bg', label: 'User Msg Bubble' },
            { key: '--msg-bot-bg', label: 'Bot Msg Bubble' },
            { key: '--msg-system-bg', label: 'System Msg Bubble' },
            { key: '--screen-bg', label: 'Projector Screen' }
        ];
		const STYLE_PRESETS = [
			{ id: 'empty', title: 'Default / no custom CSS', css: '' },

			// ─── Тёмные классика ───
			{ id: 'violet', title: '🟣 Deep Violet', css: `:root {
		--accent:#8b6cff; --bg-primary:#0f0d18; --bg-secondary:#1b1630;
		--bg-tertiary:#282044; --border:#4a3b78;
		--header-accent: rgba(139,108,255,0.32);
		--header-accent-deep: rgba(60,40,110,0.45);
		--header-border: rgba(139,108,255,0.42);
		--msg-user-bg: rgba(139,108,255,0.18);
		--msg-bot-bg: rgba(255,255,255,0.045);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-btn-active, .vp-shell-ws-btn.active { box-shadow:0 0 14px rgba(139,108,255,.28); }
		.vp-session-msg.role-assistant { border-color:rgba(139,108,255,.35); }
		.vp-session-msg.role-user { border-left-color: rgba(139,108,255,0.55); }` },

			{ id: 'blue', title: '🔵 Cold Blue', css: `:root {
		--accent:#4f8cff; --bg-primary:#08111f; --bg-secondary:#101b2d;
		--bg-tertiary:#172943; --border:#2a4c77;
		--header-accent: rgba(79,140,255,0.30);
		--header-accent-deep: rgba(25,55,100,0.45);
		--header-border: rgba(79,140,255,0.40);
		--msg-user-bg: rgba(79,140,255,0.18);
		--msg-bot-bg: rgba(79,140,255,0.08);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-btn-active, .vp-shell-ws-btn.active { box-shadow:0 0 14px rgba(79,140,255,.25); }
		.vp-session-msg.role-user { border-left-color: rgba(79,140,255,0.55); }` },

			{ id: 'amber', title: '🟠 Warm Amber', css: `:root {
		--accent:#c88735; --bg-primary:#17100b; --bg-secondary:#251a12;
		--bg-tertiary:#332317; --border:#64472b;
		--header-accent: rgba(200,135,53,0.30);
		--header-accent-deep: rgba(90,50,15,0.50);
		--header-border: rgba(200,135,53,0.42);
		--msg-user-bg: rgba(200,135,53,0.18);
		--msg-bot-bg: rgba(255,255,255,0.045);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-subtitle-text { background:rgba(45,25,10,.78); }
		.vp-session-msg.role-user { border-left-color: rgba(200,135,53,0.55); }` },

			{ id: 'emerald', title: '🟢 Emerald Console', css: `:root {
		--accent:#45b883; --bg-primary:#07140f; --bg-secondary:#0d2118;
		--bg-tertiary:#143324; --border:#285c42;
		--header-accent: rgba(69,184,131,0.30);
		--header-accent-deep: rgba(20,70,45,0.50);
		--header-border: rgba(69,184,131,0.42);
		--msg-user-bg: rgba(69,184,131,0.18);
		--msg-bot-bg: rgba(255,255,255,0.045);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-session-msg.role-assistant { border-color:rgba(69,184,131,.32); }
		.vp-player-status.is-live { color:#7dffbd; }
		.vp-session-msg.role-user { border-left-color: rgba(69,184,131,0.55); }` },

			// ─── НОВЫЕ ───
			{ id: 'midnight', title: '🌌 Midnight OLED', css: `:root {
		--accent:#7c6cff; --bg-primary:#000000; --bg-secondary:#0a0a14;
		--bg-tertiary:#12121f; --border:#25253a;
		--text-primary:#e4e2ff; --text-secondary:#8a88b8;
		--header-accent: rgba(124,108,255,0.22);
		--header-accent-deep: rgba(30,25,60,0.55);
		--header-border: rgba(124,108,255,0.30);
		--msg-user-bg: rgba(124,108,255,0.14);
		--msg-bot-bg: rgba(255,255,255,0.025);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-shell-area { border-color:rgba(124,108,255,.22); box-shadow:0 0 0 1px rgba(0,0,0,.5) inset; }
		.vp-session-msg.role-user { border-left-color: rgba(124,108,255,0.55); }
		.vp-btn-active { box-shadow:0 0 12px rgba(124,108,255,.35); }` },

			{ id: 'rose', title: '🌸 Rose Quartz', css: `:root {
		--accent:#e06b9f; --bg-primary:#1a0e15; --bg-secondary:#261520;
		--bg-tertiary:#341d2c; --border:#5c2f48;
		--text-primary:#f5dce6; --text-secondary:#c09aab;
		--header-accent: rgba(224,107,159,0.28);
		--header-accent-deep: rgba(90,30,55,0.55);
		--header-border: rgba(224,107,159,0.42);
		--msg-user-bg: rgba(224,107,159,0.18);
		--msg-bot-bg: rgba(255,255,255,0.045);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-session-msg.role-user { border-left-color: rgba(224,107,159,0.55); }
		.vp-session-msg.role-assistant { border-color:rgba(224,107,159,.28); }
		.vp-btn-active { box-shadow:0 0 14px rgba(224,107,159,.30); }
		.vp-subtitle-text { background:rgba(50,20,35,.82); }` },

			{ id: 'cyber', title: '⚡ Cyberpunk Neon', css: `:root {
		--accent:#00e5ff; --bg-primary:#05020f; --bg-secondary:#0c0620;
		--bg-tertiary:#140a30; --border:#2a1a5c;
		--text-primary:#d8f4ff; --text-secondary:#7fb8d4;
		--header-accent: rgba(0,229,255,0.28);
		--header-accent-deep: rgba(40,10,80,0.55);
		--header-border: rgba(0,229,255,0.50);
		--msg-user-bg: rgba(255,43,214,0.14);
		--msg-bot-bg: rgba(0,229,255,0.08);
		--msg-system-bg: rgba(137,180,250,0.055);
		}
		.vp-shell-area { border-color:rgba(0,229,255,.28); box-shadow:0 0 18px rgba(0,229,255,.08) inset; }
		.vp-btn, .vp-shell-ws-btn { border-color:rgba(0,229,255,.35); }
		.vp-btn-active, .vp-shell-ws-btn.active {
			background:linear-gradient(135deg,#00e5ff,#ff2bd6);
			box-shadow:0 0 16px rgba(255,43,214,.35);
			color:#05020f; font-weight:700;
		}
		.vp-session-msg.role-user { border-color:rgba(255,43,214,.45); border-left-color: rgba(255,43,214,0.7); }
		.vp-session-msg.role-assistant { border-color:rgba(0,229,255,.35); }` },

			{ id: 'paper', title: '📜 Paper / Light', css: `:root {
			--accent:#7a7062; --bg-primary:#f4f1ea; --bg-secondary:#ebe6db;
			--bg-tertiary:#ddd6c6; --border:#b8ad92;
			--text-primary:#2a2620; --text-secondary:#6b6354;
			--header-accent: rgba(107,99,84,0.15);
			--header-accent-deep: rgba(180,170,140,0.30);
			--header-border: rgba(107,99,84,0.35);
			--header-glare-opacity: 0;
			--msg-user-bg: #e8e2d0;
			--msg-bot-bg: #f4f1ea;
			--msg-system-bg: rgba(107,99,84,0.06);
			--screen-bg: #e8e4d8;
			}
			body { color:#2a2620; }
			.vp-shell-area { background:#ebe6db; border-color:#b8ad92; box-shadow:0 1px 3px rgba(0,0,0,.08); }
			.vp-shell-area-header {
				background:linear-gradient(180deg, rgba(255,255,255,0.7), rgba(255,255,255,0.3)),
						   linear-gradient(180deg, var(--header-accent), var(--header-accent-deep));
				border-bottom-color:var(--header-border); color:#2a2620;
			}
			.vp-shell-area-btn { color:#2a2620; border-color:rgba(107,99,84,0.28); background:rgba(0,0,0,0.04); }
			.vp-shell-area-btn:hover { background:rgba(0,0,0,0.10); }
			.vp-shell-area-menu { background:#f4f1ea; border-color:#b8ad92; color:#2a2620; box-shadow:0 10px 28px rgba(42,38,32,0.18); }
			.vp-shell-area-menu-item { color:#2a2620; }
			.vp-shell-area-menu-item:hover:not(:disabled) { background:rgba(107,99,84,0.14); }
			.vp-shell-area-menu-sep { background:rgba(107,99,84,0.20); }
			.vp-shell-header-slot .vp-hdr-sep { background:rgba(107,99,84,0.22); }
			.vp-shell-header-slot .vp-hdr-meta { color:#6b6354; }
			.vp-shell-header-slot .vp-session-input-tool-chip { background:rgba(107,99,84,0.14); color:#2a2620; border-color:rgba(107,99,84,0.35); }
			.vp-shell-header-slot .vp-session-scene-btn { background:rgba(107,99,84,0.18); color:#2a2620; border-color:rgba(107,99,84,0.35); }
			.vp-shell-header-slot .vp-bus-tab { color:#6b6354; border-color:rgba(107,99,84,0.28); }
			.vp-shell-header-slot .vp-bus-tab.active { background:#6b6354; color:#f4f1ea; border-color:#5c5548; }
			.vp-shell-save-btn { color:#4a443a; border-color:rgba(107,99,84,0.30); }
			.vp-shell-save-btn.is-dirty { background:rgba(180,120,20,0.18) !important; border-color:rgba(160,100,10,0.55) !important; color:#6b3e00 !important; }
			#vp-shell-root *, #vp-gallery-panel *, #visual-projector * { scrollbar-color: rgba(107,99,84,0.34) transparent; }
			#vp-shell-root *::-webkit-scrollbar-thumb, #vp-gallery-panel *::-webkit-scrollbar-thumb, #visual-projector *::-webkit-scrollbar-thumb { background: rgba(107,99,84,0.30); }
			#vp-shell-root *::-webkit-scrollbar-thumb:hover, #vp-gallery-panel *::-webkit-scrollbar-thumb:hover, #visual-projector *::-webkit-scrollbar-thumb:hover { background: rgba(107,99,84,0.48); }
			.vp-btn { background:#6b6354; color:#f4f1ea; border-color:#5c5548; }
			.vp-btn:hover { filter:brightness(1.08); }
			.vp-btn-ghost { background:rgba(0,0,0,.06); color:#2a2620; border-color:#b8ad92; }
			.vp-btn-ghost:hover { background:rgba(0,0,0,.12); }
			.vp-btn-active { background:#5c5548 !important; color:#f4f1ea !important; box-shadow:0 0 0 1px rgba(107,99,84,.25); }
			.vp-session-msg { border-color:#b8ad92; color:#2a2620; }
			.vp-session-msg.scene-event { border-color:rgba(107,99,84,0.15); }
			.vp-session-msg.scene-event .vp-session-msg-head { background:rgba(107,99,84,0.08) !important; }
			.vp-session-msg-head { background:rgba(0,0,0,.06); color:#6b6354; }
			.vp-session-msg-body { color:#2a2620; }
			.vp-scene-event-card { color: #2a2620 !important; }
			.vp-scene-event-line b { color: #5c5548 !important; }
			.vp-scene-event-pill { background: rgba(107,99,84,0.12) !important; color: #4a443a !important; border-color: rgba(107,99,84,0.25) !important; }
			.vp-scene-event-summary { color: #2a2620 !important; }
			.vp-scene-event-details summary { color: #4a6fa6 !important; }
			.vp-scene-event-field b { color: #5c5548 !important; }
			.vp-scene-event-field span { color: #6b6354 !important; }
			.vp-shell-input, .vp-shell-settings-form select, .vp-shell-settings-form input, .vp-settings-css, .vp-session-input, .vp-prompt-textarea {
				background:#f4f1ea !important; color:#2a2620 !important; border-color:#b8ad92 !important;
			}
			.vp-settings-section { background: rgba(255,255,255,0.4) !important; border-color: rgba(107,99,84,0.15) !important; }
			.vp-settings-section-header { background: rgba(107,99,84,0.12) !important; color: #2a2620 !important; }
			.vp-settings-section-header:hover { background: rgba(107,99,84,0.18) !important; }
			.vp-shell-panel-select { background:#ddd6c6; color:#2a2620; border-color:#a89a7a; }
			.vp-toast { color:#fff; background:#5c5548 !important; }
			.vp-screen-empty { color:#6b6354 !important; }
			.vp-tag-label { color:#6b6354 !important; }
			.vp-player-bar { background:rgba(0,0,0,0.04) !important; border-top-color:#b8ad92 !important; }
			.vp-timeline-track { background:rgba(0,0,0,0.12) !important; }
			.vp-timeline-progress { background:#6b6354 !important; }
			.vp-timeline-marker { background:#6b6354 !important; box-shadow:0 0 6px rgba(107,99,84,0.5) !important; }
			.vp-subtitle-text { background:rgba(244,241,234,0.82) !important; backdrop-filter:blur(4px); -webkit-backdrop-filter:blur(4px); color:#2a2620 !important; text-shadow:0 1px 0 rgba(255,255,255,0.5) !important; }
			.vp-gallery-item-tag { background:rgba(244,241,234,0.92) !important; color:#2a2620 !important; text-shadow:none !important; border-top:1px solid rgba(107,99,84,0.15) !important; font-weight:600 !important; }
			.vp-cat-header { background:rgba(255,255,255,0.45) !important; border:1px solid rgba(107,99,84,0.2) !important; color:#2a2620 !important; }
			.vp-cat-header:hover { background:rgba(255,255,255,0.7) !important; }
			.vp-panel-header { background:#ddd6c6 !important; border-bottom:1px solid rgba(107,99,84,0.25) !important; color:#2a2620 !important; }
			.vp-panel-tab { color:#6b6354 !important; opacity:0.8 !important; }
			.vp-panel-tab:hover { opacity:1 !important; color:#2a2620 !important; }
			.vp-panel-tab.vp-panel-tab-active { background:#f4f1ea !important; color:#2a2620 !important; border:1px solid rgba(107,99,84,0.3) !important; border-bottom-color:transparent !important; opacity:1 !important; }
			.vp-add-btn { color:#6b6354 !important; border-color:rgba(107,99,84,0.3) !important; }
			.vp-add-btn:hover { background:rgba(107,99,84,0.12) !important; color:#2a2620 !important; }
			.vp-badge { background:rgba(107,99,84,0.15) !important; color:#2a2620 !important; }
			.vp-session-participant-chip { background:rgba(107,99,84,0.18) !important; color:#2a2620 !important; border-color:rgba(107,99,84,0.35) !important; }
			.vp-session-participant-chip:hover { background:rgba(107,99,84,0.25) !important; }
			.vp-session-participant-chip.active { background:#4a443a !important; color:#f4f1ea !important; border-color:#3d372e !important; }
			.vp-session-participant-add { border-color:rgba(107,99,84,0.35) !important; color:#6b6354 !important; }
			.vp-session-participant-add:hover { background:rgba(107,99,84,0.12) !important; color:#2a2620 !important; }
			#vp-gallery-autotag, #vp-sel-tag { background:#5c5548 !important; border-color:#4f483c !important; }
			#vp-gallery-autotag:hover, #vp-sel-tag:hover { background:#4f483c !important; }
			.vp-tab-btn { background:rgba(107,99,84,0.18) !important; color:#2a2620 !important; border:1px solid rgba(107,99,84,0.3) !important; }
			.vp-tab-btn .vp-editable-name { color:#2a2620 !important; }
			.vp-tab-btn.active { background:#6b6354 !important; color:#f4f1ea !important; border-color:#5c5548 !important; }
			.vp-tab-btn.active .vp-editable-name { color:#f4f1ea !important; }
			.vp-tab-btn.active .vp-badge { background:rgba(255,255,255,0.15) !important; color:#f4f1ea !important; }
			.vp-tab-btn:hover:not(.active) { background:rgba(107,99,84,0.28) !important; }
			.vp-search-input { background:rgba(255,255,255,0.6) !important; color:#2a2620 !important; border:1px solid rgba(107,99,84,0.3) !important; }` },

			{ id: 'hc', title: '♿ High Contrast', css: `:root {
		--accent:#ffcc00; --bg-primary:#000000; --bg-secondary:#0a0a0a;
		--bg-tertiary:#1a1a1a; --border:#ffffff;
		--text-primary:#ffffff; --text-secondary:#e0e0e0;
		--header-accent: rgba(255,204,0,0.28);
		--header-accent-deep: rgba(60,50,0,0.55);
		--header-border: rgba(255,255,255,0.60);
		--msg-user-bg: #3a2f00;
		--msg-bot-bg: #000000;
		--msg-system-bg: rgba(255,255,255,0.08);
		}
		.vp-btn, .vp-shell-ws-btn, .vp-shell-area-btn, .vp-shell-panel-select {
			border-width:2px !important; border-color:#fff !important;
		}
		.vp-btn-active, .vp-shell-ws-btn.active { background:#ffcc00 !important; color:#000 !important; font-weight:800; }
		.vp-shell-area { border-width:2px; border-color:#fff; }
		.vp-shell-area-menu { border-width:2px !important; border-color:#fff !important; background:#000 !important; }
		#vp-shell-root *::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.55); }
		.vp-session-msg { border-width:2px; border-color:#fff; }
		.vp-session-msg.role-user { border-color:#ffcc00; }
		.vp-shell-gutter::after { background:rgba(255,255,255,.3); }` },

			// ─── Режим / UX ───
			{ id: 'compact', title: '📐 Compact UI', css: `#vp-shell-root .vp-shell-topbar { height:26px; min-height:26px; flex-basis:26px; padding:1px 6px; }
		#vp-shell-root .vp-shell-area-header { height:21px; flex-basis:21px; padding:0 4px; }
		#vp-shell-root .vp-shell-panel-select { height:17px; font-size:10.5px; }
		#vp-shell-root .vp-shell-area-btn { height:17px; min-width:19px; font-size:11px; }
		#vp-shell-root .vp-shell-header-slot .vp-btn,
		#vp-shell-root .vp-shell-header-slot .vp-hdr-btn,
		#vp-shell-root .vp-shell-header-slot .vp-session-participant-chip,
		#vp-shell-root .vp-shell-header-slot .vp-session-participant-add,
		#vp-shell-root .vp-shell-header-slot .vp-session-input-tool-chip,
		#vp-shell-root .vp-shell-header-slot .vp-session-scene-btn { height:17px; min-height:17px; font-size:10px; }
		#vp-shell-root .vp-shell-area.maximized { inset: 30px 4px 4px 4px; }
		.vp-session-msg-body { line-height:1.36 !important; }
		.vp-session-log-list { gap:6px !important; padding-top:7px !important; padding-bottom:7px !important; }` },

			{ id: 'novel', title: '📖 Novel / Soft Chat', css: `:root {
			--msg-bot-bg: rgba(255,255,255,0.06);
			}
			.vp-session-msg { border-radius:14px !important; }
			.vp-session-msg-body {
				font-family: Georgia, "Palatino Linotype", "Book Antiqua", Palatino, serif !important;
				font-size:16px !important; line-height:1.68 !important;
				letter-spacing:0.01em;
			}
			.vp-session-msg-body strong { font-weight:700; }
			.vp-session-msg-body em { font-style:italic; }
			.vp-subtitle-text { 
				font-family: Georgia, "Palatino Linotype", "Book Antiqua", Palatino, serif !important; 
				font-size:19px !important;
				letter-spacing:0.015em;
			}
			.vp-subtitle-role { font-family:system-ui, sans-serif !important; font-size:11px !important; }` },

			{ id: 'slate', title: '⚫ Neutral Slate', css: `:root {
			--accent:#7a7a8c; --bg-primary:#1a1a1f; --bg-secondary:#222228;
			--bg-tertiary:#2a2a32; --border:#3a3a44;
			--text-primary:#d4d4dc; --text-secondary:#8a8a96;
			--header-accent: rgba(122,122,140,0.22);
			--header-accent-deep: rgba(40,40,48,0.55);
			--header-border: rgba(122,122,140,0.32);
			--msg-user-bg: rgba(122,122,140,0.14);
			--msg-bot-bg: rgba(255,255,255,0.035);
			--msg-system-bg: rgba(122,122,140,0.05);
			}
			.vp-session-msg { box-shadow:none !important; }
			.vp-btn-active { box-shadow:0 0 10px rgba(122,122,140,0.25); }` },
		];
        const presetOptions = STYLE_PRESETS.map(p => `<option value="${p.id}">${p.title}</option>`).join('');
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-global-settings';
		wrap.innerHTML = `
			<div class="vp-settings-section" data-section-id="storage">
				<div class="vp-settings-section-header"><span>💾 Storage / Runtime</span><span class="vp-settings-toggle">▼</span></div>
				<div class="vp-settings-section-content">
					<div class="vp-settings-kv"><span>Backend</span><b data-info="backend">checking...</b></div>
					<div class="vp-settings-kv"><span>Current world</span><b data-info="world">—</b></div>
					<div class="vp-settings-kv"><span>Data folder</span><code data-info="dataRoot">—</code></div>
					<div class="vp-settings-kv"><span>World folder</span><code data-info="worldRoot">—</code></div>
					<div class="vp-settings-actions">
						<button class="vp-btn vp-btn-ghost" data-act="open-data">📂 Open data folder</button>
						<button class="vp-btn vp-btn-ghost" data-act="open-world">🌍 Open world folder</button>
						<button class="vp-btn vp-btn-ghost" data-act="health">🩺 Health Check</button>
						<button class="vp-btn vp-btn-ghost" data-act="reload">🔄 Reload app</button>
					</div>
					<label class="vp-settings-row"><span>Persistence mode</span>
						<select data-k="storageMode">
							<option value="persistent">Persistent — save everything</option>
							<option value="semi-persistent">Semi — don't preserve live session/projector</option>
							<option value="ephemeral">Ephemeral — memory only</option>
						</select>
					</label>
					<div class="vp-settings-note">Neutralino FS backend writes visible JSON/assets into the project <code>data</code> folder.</div>
				</div>
			</div>
			<div class="vp-settings-section" data-section-id="project">
				<div class="vp-settings-section-header"><span>⚙ Project defaults</span><span class="vp-settings-toggle">▼</span></div>
				<div class="vp-settings-section-content">
					<label class="vp-settings-row"><span>Auto-tag on load</span>
						<select data-k="autoTagOnLoad"><option value="ask">Ask</option><option value="always">Always</option><option value="never">Never</option></select>
					</label>
					<label class="vp-settings-row"><span>Manifest descriptions</span><input data-k="manifestDescriptions" type="checkbox"></label>
					<label class="vp-settings-row"><span>Directory commands</span><input data-k="allowDirectoryCommands" type="checkbox"></label>
					<label class="vp-settings-row"><span>Visual context depth</span><input data-k="contextDepth" type="number" min="0" max="30" step="1"></label>
					<label class="vp-settings-row"><span>Max visual history</span><input data-k="maxHistory" type="number" min="5" max="200" step="1"></label>
				</div>
			</div>
			<div class="vp-settings-section" data-section-id="focus-gaze">
				<div class="vp-settings-section-header"><span>🎥 Focus & Gaze Settings</span><span class="vp-settings-toggle">▼</span></div>
				<div class="vp-settings-section-content">
					<label class="vp-settings-row"><span>Gaze Auto-reaction</span><input data-k="gazeAutoReaction" type="checkbox"></label>
					<label class="vp-settings-row"><span>Gaze hold duration (sec)</span><input data-k="gazeHoldDuration" type="number" min="2" max="30" step="1"></label>
					<label class="vp-settings-row"><span>Gaze reaction cooldown (sec)</span><input data-k="gazeCooldown" type="number" min="5" max="300" step="5"></label>
				</div>
			</div>
			<div class="vp-settings-section" data-section-id="persona">
				<div class="vp-settings-section-header"><span> User persona</span><span class="vp-settings-toggle">▼</span></div>
				<div class="vp-settings-section-content">
					<label class="vp-settings-row"><span>User name</span><input data-k="userName" type="text" placeholder="User"></label>
					<label class="vp-settings-row vp-settings-row-block"><span>User persona / notes</span><textarea class="vp-settings-small-textarea" data-k="userPersona" spellcheck="false" placeholder="Optional. Example: {{user}} is the director of the scene..."></textarea></label>
					<div class="vp-settings-note">Profile prompts can use <code>{{char}}</code> and <code>{{user}}</code>.</div>
				</div>
			</div>
			<div class="vp-settings-section" data-section-id="theme">
				<div class="vp-settings-section-header"><span> Theme / Custom Colors</span><span class="vp-settings-toggle">▼</span></div>
				<div class="vp-settings-section-content" style="gap:10px;">
					<label class="vp-settings-row"><span>Style Preset</span>
						<select data-role="stylePreset">${presetOptions}</select>
					</label>
					
					<div class="vp-settings-note" style="margin-top: 4px; font-weight: 600; font-size: 11px;">🎨 Tweak Colors:</div>
					
					<div class="vp-custom-colors-list">
						${COLOR_VARIABLES.map(v => `
							<div class="vp-color-row" data-color-key="${v.key}">
								<span class="vp-color-label">${v.label}</span>
								<div class="vp-color-inputs">
									<div class="vp-color-input-row">
										<input type="color" data-color-var="${v.key}" class="vp-color-picker">
										<input type="text" data-color-text="${v.key}" class="vp-color-hex" placeholder="#FFFFFF">
									</div>
									<div class="vp-color-alpha-row" data-alpha-row="${v.key}" style="display:none;">
										<span class="vp-color-alpha-label">α</span>
										<input type="range" data-color-alpha="${v.key}" class="vp-color-alpha-slider" min="0" max="1" step="0.01" value="1">
										<span class="vp-color-alpha-value" data-alpha-value="${v.key}">1.00</span>
									</div>
								</div>
							</div>
						`).join('')}
					</div>

					<div class="vp-settings-actions">
						<button class="vp-btn vp-btn-ghost" style="width: 100%; text-align: center; justify-content: center;" data-act="reset-colors">Reset to Default</button>
					</div>
					<div class="vp-settings-note">Choose a preset above, then optionally customize specific colors of the user interface. It is saved automatically!</div>
				</div>
			</div>`;

        const storageMode = wrap.querySelector('[data-k="storageMode"]');
        if (storageMode) storageMode.value = DB?.getMode?.() || 'persistent';
        wrap.querySelector('[data-k="autoTagOnLoad"]').value = cfg.autoTagOnLoad || 'ask';
        wrap.querySelector('[data-k="manifestDescriptions"]').checked = cfg.manifestDescriptions !== false;
        wrap.querySelector('[data-k="allowDirectoryCommands"]').checked = !!cfg.allowDirectoryCommands;
        wrap.querySelector('[data-k="contextDepth"]').value = cfg.contextDepth ?? 3;
        wrap.querySelector('[data-k="maxHistory"]').value = cfg.maxHistory ?? 20;
        wrap.querySelector('[data-k="userName"]').value = cfg.userName || 'User';
        wrap.querySelector('[data-k="userPersona"]').value = cfg.userPersona || '';
        const gazeAutoReactionEl = wrap.querySelector('[data-k="gazeAutoReaction"]');
        if (gazeAutoReactionEl) gazeAutoReactionEl.checked = cfg.gazeAutoReaction !== false;
        const gazeHoldDurationEl = wrap.querySelector('[data-k="gazeHoldDuration"]');
        if (gazeHoldDurationEl) gazeHoldDurationEl.value = cfg.gazeHoldDuration ?? 6;
        const gazeCooldownEl = wrap.querySelector('[data-k="gazeCooldown"]');
        if (gazeCooldownEl) gazeCooldownEl.value = cfg.gazeCooldown ?? 50;

        const persistConfig = () => {
            VP.schedulePersist?.();
            requestGallerySettingsSync('shell-settings');
            requestProjectorUiUpdate('shell')
        };

        wrap.querySelectorAll('[data-k]').forEach(el => {
            el.addEventListener('change', () => {
                const k = el.dataset.k;
                if (k === 'storageMode') {
                    DB?.setMode?.(el.value);
                    VP.showToast?.(`Storage mode: ${el.value}`, 'success');
                    return;
                }
                if (k === 'manifestDescriptions' || k === 'allowDirectoryCommands' || k === 'gazeAutoReaction') cfg[k] = !!el.checked;
                else if (k === 'contextDepth') cfg[k] = Math.max(0, Math.min(30, parseInt(el.value, 10) || 0));
                else if (k === 'gazeHoldDuration') cfg[k] = Math.max(2, Math.min(30, parseInt(el.value, 10) || 6));
                else if (k === 'gazeCooldown') cfg[k] = Math.max(5, Math.min(300, parseInt(el.value, 10) || 50));
                else if (k === 'maxHistory') cfg[k] = Math.max(5, Math.min(200, parseInt(el.value, 10) || 20));
                else cfg[k] = el.value;
                if (k === 'maxHistory' && S.history?.length > cfg.maxHistory) S.history = S.history.slice(-cfg.maxHistory);
                persistConfig();
            });
        });

        const backendEl = wrap.querySelector('[data-info="backend"]');
        const dataRootEl = wrap.querySelector('[data-info="dataRoot"]');
        const worldRootEl = wrap.querySelector('[data-info="worldRoot"]');
        const worldEl = wrap.querySelector('[data-info="world"]');
        try {
            const info = DB?.getBackendInfo?.() || { backend: 'indexeddb/browser', dataRoot: '(browser profile)' };
            if (backendEl) backendEl.textContent = `${info.backend}${info.native ? ' ✓' : ''}`;
            if (dataRootEl) dataRootEl.textContent = info.dataRoot || '—';
            if (worldRootEl) worldRootEl.textContent = info.worldRoot || '—';
            if (worldEl) {
                const w = await DB?.getActiveWorld?.().catch(() => null);
                worldEl.textContent = w ? `${w.title || w.id} (${w.id})` : (info.worldId || '—');
            }
        } catch {
            if (backendEl) backendEl.textContent = 'unknown';
        }

        wrap.querySelector('[data-act="open-data"]').addEventListener('click', async () => {
            if (DB?.openDataFolder) {
                try { await DB.openDataFolder(); return; }
                catch (err) { VP.showToast?.(`Open folder failed: ${err.message || err}`, 'error'); return; }
            }
            VP.showToast?.('Open folder is available only in Neutralino FS backend', 'info');
        });
        wrap.querySelector('[data-act="open-world"]').addEventListener('click', openCurrentWorldFolder);
        wrap.querySelector('[data-act="health"]').addEventListener('click', showHealthCheckModal);
        wrap.querySelector('[data-act="reload"]').addEventListener('click', () => location.reload());

        const presetSelect = wrap.querySelector('[data-role="stylePreset"]');
        const getPresetCss = () => STYLE_PRESETS.find(p => p.id === presetSelect?.value)?.css ?? '';
        
        const saveCss = (css) => {
            if (DB?.setCustomCss) {
                DB.setCustomCss(css).catch(err => VP.showToast?.(`CSS save failed: ${err.message || err}`, 'error'));
            } else {
                try { localStorage.setItem('vp-custom-css', css || ''); } catch {}
                let style = document.getElementById('vp-world-custom-style');
                if (!style) { style = document.createElement('style'); style.id = 'vp-world-custom-style'; document.head.appendChild(style); }
                style.textContent = css || '';
            }
        };

        // ════════════════════════════════════════════════════════════════
        //  COLOR ENGINE v2 — alpha-aware, per-preset persistence
        // ════════════════════════════════════════════════════════════════

        // Default colors match visual-projector.css :root exactly
        const DEFAULT_COLORS = {
            '--accent': '#6c5fa6',
            '--bg-primary': '#11111b',
            '--bg-secondary': '#1e1e2e',
            '--bg-tertiary': '#252540',
            '--border': '#383860',
            '--text-primary': '#cdd6f4',
            '--text-secondary': '#a6adc8',
            '--header-accent': 'rgba(108,95,166,0.28)',
            '--msg-user-bg': 'rgba(108,95,166,0.18)',
            '--msg-bot-bg': 'rgba(255,255,255,0.045)',
            '--msg-system-bg': 'rgba(137,180,250,0.055)',
            '--screen-bg': '#050509'
        };

        // Per-preset saved customizations: { presetId: { key: value, ... } }
        let customOverrides = {};
        const tryLoadOverrides = () => {
            try { customOverrides = JSON.parse(localStorage.getItem('vp-color-overrides') || '{}'); } catch { customOverrides = {}; }
        };
        const trySaveOverrides = () => {
            try { localStorage.setItem('vp-color-overrides', JSON.stringify(customOverrides)); } catch {}
        };
        tryLoadOverrides();

        // Parse colors from CSS text
        const getColorsFromCss = (cssText) => {
            const colors = { ...DEFAULT_COLORS };
            if (!cssText) return colors;
            for (const key of Object.keys(DEFAULT_COLORS)) {
                const reg = new RegExp(`${key}\\s*:\\s*([^;\\}]+)`);
                const match = cssText.match(reg);
                if (match) colors[key] = match[1].trim();
            }
            return colors;
        };

        // Extract alpha from an rgba() string, returns null if not rgba
        const extractAlpha = (val) => {
            const m = String(val || '').match(/rgba\s*\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*([\d.]+)\s*\)/i);
            return m ? parseFloat(m[1]) : null;
        };

        // Apply a new hex color value to a variable, preserving alpha if original was rgba
        const applyColorPreservingAlpha = (colors, key, newVal) => {
            const oldVal = colors[key];
            const alpha = extractAlpha(oldVal);
            if (alpha !== null && newVal.startsWith('#') && newVal.length >= 7) {
                const r = parseInt(newVal.slice(1,3), 16);
                const g = parseInt(newVal.slice(3,5), 16);
                const b = parseInt(newVal.slice(5,7), 16);
                colors[key] = `rgba(${r},${g},${b},${alpha})`;
            } else {
                colors[key] = newVal;
            }
        };

        // Convert any color format to Hex
        const toHexColor = (col) => {
            if (!col) return '#ffffff';
            let s = col.trim();
            if (s.startsWith('#')) {
                if (s.length === 4) return '#' + s[1]+s[1] + s[2]+s[2] + s[3]+s[3];
                return s.substring(0, 7);
            }
            try {
                const dummy = document.createElement('div');
                dummy.style.color = col;
                document.body.appendChild(dummy);
                const computed = window.getComputedStyle(dummy).color;
                document.body.removeChild(dummy);
                const m = computed.match(/^rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)$/i);
                if (m) {
                    const r = parseInt(m[1], 10).toString(16).padStart(2, '0');
                    const g = parseInt(m[2], 10).toString(16).padStart(2, '0');
                    const b = parseInt(m[3], 10).toString(16).padStart(2, '0');
                    return `#${r}${g}${b}`;
                }
            } catch (e) {}
            return '#ffffff';
        };

        // Apply color overrides back into CSS text
        const updateCssWithColors = (cssText, colors) => {
            let result = cssText || '';
            if (!result.includes(':root')) {
                result = `:root {\n` + 
                    Object.entries(colors).map(([k, v]) => `  ${k}: ${v};`).join('\n') +
                    `\n}\n` + result;
            } else {
                for (const [k, v] of Object.entries(colors)) {
                    const reg = new RegExp(`(${k}\\s*:\\s*)[^;\\}]+`);
                    if (result.match(reg)) {
                        result = result.replace(reg, `$1${v}`);
                    } else {
                        result = result.replace(/:root\s*\{/, `:root {\n  ${k}: ${v};`);
                    }
                }
            }
            return result;
        };

        // Build final colors: preset base + custom overrides for current preset
        const getCurrentPresetId = () => presetSelect?.value || 'empty';
        const getEffectiveColors = () => {
            const presetCss = getPresetCss();
            const base = getColorsFromCss(presetCss);
            const overrides = customOverrides[getCurrentPresetId()] || {};
            return { ...base, ...overrides };
        };

        // Build and apply CSS from effective colors
        const buildAndApplyCss = () => {
            const presetCss = getPresetCss();
            const colors = getEffectiveColors();
            // Start from preset CSS (which may have non-color rules like .vp-btn-active)
            const css = updateCssWithColors(presetCss, colors);
            saveCss(css);
            return css;
        };

        // Update input fields from effective colors
        const syncColorInputs = () => {
            const colors = getEffectiveColors();
            for (const v of COLOR_VARIABLES) {
                const picker = wrap.querySelector(`[data-color-var="${v.key}"]`);
                const txt = wrap.querySelector(`[data-color-text="${v.key}"]`);
                const alphaRow = wrap.querySelector(`[data-alpha-row="${v.key}"]`);
                const alphaSlider = wrap.querySelector(`[data-color-alpha="${v.key}"]`);
                const alphaValue = wrap.querySelector(`[data-alpha-value="${v.key}"]`);
                const val = colors[v.key] || '';
                const hexVal = toHexColor(val);
                const isRgba = val.startsWith('rgba');
                const alpha = extractAlpha(val);
                if (picker) picker.value = hexVal;
                if (txt) {
                    txt.value = isRgba ? hexVal : val;
                    txt.title = isRgba ? `RGBA: ${val}` : '';
                }
                // Show/hide alpha slider for rgba colors
                if (alphaRow) alphaRow.style.display = isRgba ? 'flex' : 'none';
                if (alphaSlider && alpha !== null) alphaSlider.value = alpha;
                if (alphaValue) alphaValue.textContent = alpha !== null ? alpha.toFixed(2) : '1.00';
            }
        };

        // Initialize
        let currentCss = '';
        const initCustomizer = async () => {
            if (DB?.getCustomCss) currentCss = await DB.getCustomCss().catch(() => '');
            else { try { currentCss = localStorage.getItem('vp-custom-css') || ''; } catch {} }
            
            try {
                const savedPresetId = localStorage.getItem('vp-custom-css-preset-id');
                if (savedPresetId && presetSelect) presetSelect.value = savedPresetId;
            } catch {}

            // Rebuild CSS from preset + overrides to ensure consistency
            currentCss = buildAndApplyCss();
            syncColorInputs();
        };
        initCustomizer();

        // Listen for color changes
        COLOR_VARIABLES.forEach(v => {
            const picker = wrap.querySelector(`[data-color-var="${v.key}"]`);
            const txt = wrap.querySelector(`[data-color-text="${v.key}"]`);
            
            const onColorChange = (newVal) => {
                const presetId = getCurrentPresetId();
                if (!customOverrides[presetId]) customOverrides[presetId] = {};
                // Get base color from preset to know alpha context
                const baseColors = getColorsFromCss(getPresetCss());
                const baseVal = baseColors[v.key];
                // Build temp colors with alpha preservation
                const tempColors = { ...baseColors, ...customOverrides[presetId] };
                applyColorPreservingAlpha(tempColors, v.key, newVal);
                customOverrides[presetId][v.key] = tempColors[v.key];
                trySaveOverrides();
                currentCss = buildAndApplyCss();
                syncColorInputs();
            };

            picker?.addEventListener('input', (e) => {
                txt.value = e.target.value;
                onColorChange(e.target.value);
            });

            txt?.addEventListener('change', (e) => {
                onColorChange(e.target.value);
            });

            // Alpha slider — changes opacity for rgba colors
            const alphaSlider = wrap.querySelector(`[data-color-alpha="${v.key}"]`);
            alphaSlider?.addEventListener('input', (e) => {
                const newAlpha = parseFloat(e.target.value);
                const alphaVal = wrap.querySelector(`[data-alpha-value="${v.key}"]`);
                if (alphaVal) alphaVal.textContent = newAlpha.toFixed(2);
                const presetId = getCurrentPresetId();
                if (!customOverrides[presetId]) customOverrides[presetId] = {};
                // Get current effective color for this key
                const effectiveColors = getEffectiveColors();
                const currentVal = effectiveColors[v.key] || '';
                const hexVal = toHexColor(currentVal);
                // Build new rgba with updated alpha
                if (hexVal.startsWith('#') && hexVal.length >= 7) {
                    const r = parseInt(hexVal.slice(1,3), 16);
                    const g = parseInt(hexVal.slice(3,5), 16);
                    const b = parseInt(hexVal.slice(5,7), 16);
                    customOverrides[presetId][v.key] = `rgba(${r},${g},${b},${newAlpha})`;
                } else {
                    customOverrides[presetId][v.key] = currentVal;
                }
                trySaveOverrides();
                currentCss = buildAndApplyCss();
                syncColorInputs();
            });
        });

		// Preset selection change
		presetSelect.addEventListener('change', () => {
			const presetId = getCurrentPresetId();
			try { localStorage.setItem('vp-custom-css-preset-id', presetId); } catch {}
			currentCss = buildAndApplyCss();
			syncColorInputs();
			VP.showToast?.(`Theme: ${presetSelect.options[presetSelect.selectedIndex]?.text || 'applied'}`, 'success');
		});

        // Reset colors — clears overrides for current preset only
        wrap.querySelector('[data-act="reset-colors"]').addEventListener('click', () => {
            const presetId = getCurrentPresetId();
            delete customOverrides[presetId];
            trySaveOverrides();
            currentCss = buildAndApplyCss();
            syncColorInputs();
            VP.showToast?.('Colors reset to preset defaults', 'info');
        });
		// Спойлеры: клик по заголовку сворачивает/разворачивает секцию, сохраняет состояние в shell
		wrap.querySelectorAll('.vp-settings-section').forEach((section, index) => {
			const header = section.querySelector('.vp-settings-section-header');
			const sectionId = section.dataset.sectionId || `section_${index}`;
			
			// Restore collapsed state from S.shell
			if (S.shell?.globalSettingsCollapsed?.[sectionId] !== false && index !== 0 && S.shell?.globalSettingsCollapsed?.[sectionId] !== false) {
				// Default behavior: first is open, others collapsed. Or explicitly saved state.
				if (S.shell?.globalSettingsCollapsed?.[sectionId] !== false) {
					section.classList.add('collapsed');
				}
			} else if (S.shell?.globalSettingsCollapsed?.[sectionId] === true) {
				section.classList.add('collapsed');
			}
			
			header.addEventListener('click', () => {
				const isCollapsed = section.classList.toggle('collapsed');
				if (S.shell) {
					if (!S.shell.globalSettingsCollapsed) S.shell.globalSettingsCollapsed = {};
					S.shell.globalSettingsCollapsed[sectionId] = isCollapsed;
					saveShellState();
				}
			});
		});

        container.appendChild(wrap);
    }

    function registerBuiltInPanels() {
        const registerIfAbsent = (def) => {
            // Shell ships lightweight fallback panels for Input/Log/Model so the
            // workspace is usable before optional modules load. Once a real module
            // registers the same id, it should win. Because shell/session boot is
            // now async (storage hydration), whichever finishes later must NOT
            // clobber an already-registered richer implementation.
            if (VP.getPanel?.(def.id)) return false;
            return VP.registerPanel(def);
        };

        VP.registerPanel({
            id: 'empty', title: 'Empty Space', icon: '⬛', order: 90,
            create(container, ctx = {}) {
                clearContainer(container);
                container.style.background = 'transparent';
                // Optional ambient backdrop: reuse a gallery asset as scenery.
                // Per-area state → each Empty Space can show its own picture.
                const local = ctx.getPanelState ? ctx.getPanelState({ bgTag: '', bgDim: 0, bgFit: 'cover' }) : { bgTag: '', bgDim: 0, bgFit: 'cover' };
                if (!local.bgTag) return;
                const asset = S.gallery?.get?.(local.bgTag);
                if (!asset) return;
                // NOTE: the panel host is positioned by shell CSS
                // (.vp-shell-panel-host { position:absolute; inset:0 }) —
                // never override its position, just fill it with a layer.
                const dim = Math.max(0, Math.min(90, Number(local.bgDim) || 0)) / 100;
                const bg = document.createElement('div');
                bg.style.cssText = `position:absolute; inset:0; pointer-events:none;
                    background-image:linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${asset.url || asset.base64}");
                    background-size:${local.bgFit === 'contain' ? 'contain' : 'cover'};
                    background-position:center; background-repeat:no-repeat;`;
                container.appendChild(bg);
            },
            settings: {
                title: 'Empty Space Settings', icon: '⬛', mode: 'auto', minWidth: 280, minHeight: 170, width: 340,
                create(body, ctx = {}) {
                    const local = ctx.getPanelState ? ctx.getPanelState({ bgTag: '', bgDim: 0, bgFit: 'cover' }) : { bgTag: '', bgDim: 0, bgFit: 'cover' };
                    const tags = Array.from(S.gallery?.keys?.() || []).filter(t => !String(t).startsWith('__')).sort();
                    const wrap = document.createElement('div');
                    wrap.className = 'vp-shell-settings-form';
                    wrap.innerHTML = `
                        <label><span>Background</span><select data-k="bgTag">
                            <option value="">None</option>
                            ${tags.map(t => `<option value="${t}"${t === local.bgTag ? ' selected' : ''}>${t}</option>`).join('')}
                            ${local.bgTag && !tags.includes(local.bgTag) ? `<option value="${local.bgTag}" selected>${local.bgTag} (missing)</option>` : ''}
                        </select></label>
                        <label><span>Fit</span><select data-k="bgFit">
                            <option value="cover"${local.bgFit !== 'contain' ? ' selected' : ''}>Cover</option>
                            <option value="contain"${local.bgFit === 'contain' ? ' selected' : ''}>Contain</option>
                        </select></label>
                        <label><span>Dim</span><input type="range" data-k="bgDim" min="0" max="90" step="5" value="${Math.max(0, Math.min(90, Number(local.bgDim) || 0))}"></label>
                        <div class="vp-shell-settings-note">Ambient scenery from the gallery. Purely decorative — the model never sees it. Saved per workspace area.</div>`;
                    const apply = () => {
                        const patch = {
                            bgTag: wrap.querySelector('[data-k="bgTag"]').value || '',
                            bgFit: wrap.querySelector('[data-k="bgFit"]').value === 'contain' ? 'contain' : 'cover',
                            bgDim: Math.max(0, Math.min(90, parseInt(wrap.querySelector('[data-k="bgDim"]').value, 10) || 0)),
                        };
                        if (ctx.setPanelState) ctx.setPanelState(patch);
                        Shell.render?.();
                    };
                    wrap.querySelectorAll('select,input').forEach(el => el.addEventListener('change', apply));
                    body.appendChild(wrap);
                },
            },
        });

        VP.registerPanel({
            id: 'stage', title: 'Stage', icon: '🎭', order: 10,
            create(container, ctx = {}) {
                const win = S.ui?.vpWindow || document.getElementById('visual-projector');
                if (!win) return makePlaceholder(container, 'Stage', 'Projector window is not ready yet.');
                dockElement(container, win, 'vp-shell-docked-stage');
                const hdr = S.ui?.header || win.querySelector('#vp-header') || document.getElementById('vp-header');
                if (hdr && ctx?.setHeaderContent) {
                    S.ui.header = hdr;
                    hdr.classList.add('vp-stage-header-docked');
                    ctx.setHeaderContent(hdr);
                }
                requestProjectorUiUpdate('shell');
            },
            settings: {
                title: 'Stage Settings', icon: '🎭', mode: 'auto', minWidth: 360, minHeight: 270, width: 430,
                create: renderStageSettings,
            },
        });

        // Gallery is floating-only — opened from projector toolbar or Asset Studio.
        // Not available as a shell panel.

        registerIfAbsent({
            id: 'log', title: 'Log', icon: '💬', order: 30,
            create(container) {
                clearContainer(container);
                const messages = VP.chats?.getActiveChatMessages?.() || S.session?.messages || S.playback?.messages || [];
                const wrap = document.createElement('div');
                wrap.className = 'vp-shell-log';
                if (!messages.length) {
                    wrap.innerHTML = `
                        <div class="vp-shell-empty-log">
                            <div style="font-size:26px; margin-bottom:8px;">💬</div>
                            <b>Session log</b>
                            <span>Пока это легкий placeholder. Следующий модуль projector-session.js даст ввод, API и красивый лог.</span>
                        </div>`;
                } else {
                    for (const m of messages.slice(-80)) {
                        const item = document.createElement('div');
                        item.className = `vp-shell-log-item role-${m.role || 'assistant'}`;
                        const role = document.createElement('div');
                        role.className = 'vp-shell-log-role';
                        role.textContent = (m.role || 'assistant').toUpperCase();
                        const text = document.createElement('div');
                        text.className = 'vp-shell-log-text';
                        text.textContent = m.text || m.raw || '';
                        item.appendChild(role); item.appendChild(text);
                        wrap.appendChild(item);
                    }
                }
                container.appendChild(wrap);
            },
        });

        registerIfAbsent({
            id: 'input', title: 'Input', icon: '⌨️', order: 40,
            create(container) {
                clearContainer(container);
                const wrap = document.createElement('div');
                wrap.className = 'vp-shell-input-panel';
                wrap.innerHTML = `
                    <textarea class="vp-shell-input" placeholder="Stage input будет подключен в projector-session.js. Пока fetch pipeline не трогаем."></textarea>
                    <div class="vp-shell-input-actions">
                        <button class="vp-btn" disabled>▶ Send</button>
                        <span>UI shell готов; session/API модуль — следующий шаг.</span>
                    </div>`;
                container.appendChild(wrap);
            },
        });

        registerIfAbsent({
            id: 'model', title: 'Model', icon: '🤖', order: 50,
            create(container) {
                if (!S.modelConfig) S.modelConfig = { endpoint: 'http://localhost:1234/v1/chat/completions', apiKey: '', model: 'local-model', temperature: 0.7, maxTokens: 2048, stream: true };
                if (!String(S.modelConfig.endpoint || '').trim()) S.modelConfig.endpoint = 'http://localhost:1234/v1/chat/completions';
                if (!String(S.modelConfig.model || '').trim()) S.modelConfig.model = 'local-model';
                clearContainer(container);
                const cfg = S.modelConfig;
                const wrap = document.createElement('div');
                wrap.className = 'vp-shell-form';
                wrap.innerHTML = `
                    <div class="vp-shell-form-title">🤖 Model connection</div>
                    <label>Endpoint <input data-k="endpoint" placeholder="http://localhost:1234/v1/chat/completions"></label>
                    <label>API key <input data-k="apiKey" type="password" placeholder="optional"></label>
                    <label>Model <input data-k="model" placeholder="local-model-name"></label>
                    <label>Temperature <input data-k="temperature" type="number" min="0" max="2" step="0.05"></label>
                    <label>Max tokens <input data-k="maxTokens" type="number" min="1" step="1"></label>
                    <label class="vp-shell-check">Stream <input data-k="stream" type="checkbox"></label>
                    <div class="vp-shell-note">Настройки сохраняются локально, но отправка будет подключена в projector-session.js.</div>`;
                wrap.querySelectorAll('[data-k]').forEach(input => {
                    const k = input.dataset.k;
                    if (input.type === 'checkbox') input.checked = !!cfg[k];
                    else input.value = cfg[k] ?? '';
                    input.addEventListener('change', () => {
                        if (input.type === 'checkbox') cfg[k] = input.checked;
                        else if (input.type === 'number') cfg[k] = Number(input.value);
                        else cfg[k] = input.value;
                        if (DB?.setModelConfig) DB.setModelConfig(cfg).catch(() => {});
                        else {
                            try { localStorage.setItem('vp-model-config-v1', JSON.stringify(cfg)); } catch {}
                        }
                    });
                });
                if (DB?.getModelConfig) {
                    DB.getModelConfig().then(saved => {
                        if (!saved) return;
                        Object.assign(cfg, saved);
                        wrap.querySelectorAll('[data-k]').forEach(input => {
                            const k = input.dataset.k;
                            if (input.type === 'checkbox') input.checked = !!cfg[k];
                            else input.value = cfg[k] ?? '';
                        });
                    }).catch(() => {});
                } else {
                    try {
                        const saved = JSON.parse(localStorage.getItem('vp-model-config-v1') || 'null');
                        if (saved) Object.assign(cfg, saved);
                        wrap.querySelectorAll('[data-k]').forEach(input => {
                            const k = input.dataset.k;
                            if (input.type === 'checkbox') input.checked = !!cfg[k];
                            else input.value = cfg[k] ?? '';
                        });
                    } catch {}
                }
                container.appendChild(wrap);
            },
        });

        VP.registerPanel({
            id: 'settings', title: 'Settings', icon: '⚙️', order: 60,
            create: renderGlobalSettings,
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  SHELL UI + LAYOUT TREE
    // ════════════════════════════════════════════════════════════════

    function injectStyles() {
        if (document.getElementById('vp-shell-style')) return;
        const style = document.createElement('style');
        style.id = 'vp-shell-style';
        style.textContent = `
            body.vp-shell-active { overflow: hidden !important; }
            #vp-shell-root {
                position: fixed; inset: 0; z-index: 9990;
                background: var(--bg-primary, #11111b);
                color: var(--text-primary, #cdd6f4);
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                display: flex; flex-direction: column;
            }
            /* Unified slim custom scrollbars across Studio chrome & panels */
            #vp-shell-root *, #vp-gallery-panel *, #visual-projector * {
                scrollbar-width: thin;
                scrollbar-color: rgba(255,255,255,0.16) transparent;
            }
            #vp-shell-root *::-webkit-scrollbar,
            #vp-gallery-panel *::-webkit-scrollbar,
            #visual-projector *::-webkit-scrollbar {
                width: 6px; height: 6px;
            }
            #vp-shell-root *::-webkit-scrollbar-track,
            #vp-gallery-panel *::-webkit-scrollbar-track,
            #visual-projector *::-webkit-scrollbar-track {
                background: transparent;
            }
            #vp-shell-root *::-webkit-scrollbar-thumb,
            #vp-gallery-panel *::-webkit-scrollbar-thumb,
            #visual-projector *::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.16);
                border-radius: 999px;
            }
            #vp-shell-root *::-webkit-scrollbar-thumb:hover,
            #vp-gallery-panel *::-webkit-scrollbar-thumb:hover,
            #visual-projector *::-webkit-scrollbar-thumb:hover {
                background: rgba(255,255,255,0.28);
            }
            #vp-shell-root *::-webkit-scrollbar-corner,
            #vp-gallery-panel *::-webkit-scrollbar-corner,
            #visual-projector *::-webkit-scrollbar-corner {
                background: transparent;
            }
            .vp-shell-topbar {
                min-height: 29px; height: 29px; flex: 0 0 29px; display: flex; align-items: center; gap: 6px;
                padding: 2px 7px; background: var(--bg-tertiary, #252540);
                border-bottom: 1px solid var(--border, #383860); user-select: none; overflow: hidden;
            }
			
			.vp-shell-window-controls {
				display: flex; gap: 4px; margin-left: 6px;
				padding-left: 6px; border-left: 1px solid rgba(255,255,255,0.08);
			}
			.vp-shell-window-controls .vp-shell-tool-btn {
				min-width: 24px; padding: 0 5px;
			}
			.vp-win-close:hover {
				background: rgba(224,85,85,0.35) !important;
			}
			
            .vp-shell-brand { font-weight: 800; font-size: 12px; margin-right: 2px; white-space: nowrap; color: var(--text-primary, #cdd6f4); }
            .vp-shell-worldbar { display:flex; align-items:center; gap:4px; flex:0 0 auto; min-width:0; padding-right:6px; border-right:1px solid rgba(255,255,255,0.08); margin-right:2px; }
            .vp-shell-world-label { font-size:11px; opacity:.9; }
            .vp-shell-world-select {
                height:21px; max-width:170px; min-width:86px; border-radius:4px;
                border:1px solid rgba(255,255,255,0.12); background:rgba(0,0,0,0.18);
                color:var(--text-primary,#cdd6f4); font-size:11px; padding:0 5px;
            }
            .vp-world-manager { display:flex; flex-direction:column; gap:10px; }
            .vp-world-manager-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
            .vp-world-manager-hint { color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.35; }
            .vp-world-manager-list { display:flex; flex-direction:column; gap:8px; max-height:58vh; overflow:auto; padding-right:2px; }
            .vp-world-manager-empty { color:var(--text-secondary,#a6adc8); text-align:center; padding:24px 8px; font-size:12px; }
            .vp-world-row { display:flex; align-items:center; gap:10px; border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.035); border-radius:10px; padding:9px 10px; }
            .vp-world-row.active { border-color: color-mix(in srgb, var(--accent, #6c5fa6) 70%, transparent); background: color-mix(in srgb, var(--accent, #6c5fa6) 14%, transparent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #6c5fa6) 18%, transparent) inset; }
            .vp-world-row-main { flex:1; min-width:0; }
            .vp-world-row-title { font-weight:800; font-size:13px; color:var(--text-primary,#cdd6f4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-world-row-sub { margin-top:2px; color:var(--text-secondary,#a6adc8); font-size:11px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-world-row-sub code { color:#b9aee8; }
            .vp-world-row-actions { display:flex; gap:5px; flex-wrap:wrap; justify-content:flex-end; }
            .vp-shell-workspaces { display: flex; gap: 4px; align-items: center; flex: 1 1 auto; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: none !important; }
            .vp-shell-workspaces::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
            .vp-shell-save-btn {
                display: inline-flex; align-items: center; gap: 5px; flex: 0 0 auto;
                height: 21px; padding: 0 8px; border-radius: 4px;
                border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.035);
                color: var(--text-secondary, #a6adc8); font-size: 11px; font-weight: 600;
                cursor: pointer; white-space: nowrap;
                transition: background 0.14s ease, border-color 0.14s ease, color 0.14s ease, box-shadow 0.14s ease;
            }
            .vp-shell-save-btn:hover:not(:disabled) { background: rgba(255,255,255,0.09); color: var(--text-primary, #cdd6f4); }
            .vp-shell-save-btn .save-dot { font-size: 10px; line-height: 1; color: #8bd49c; }
            .vp-shell-save-btn.is-dirty {
                background: rgba(255,209,102,0.13);
                border-color: rgba(255,209,102,0.45);
                color: #ffd166;
                box-shadow: 0 0 10px rgba(255,209,102,0.14);
            }
            .vp-shell-save-btn.is-dirty:hover:not(:disabled) {
                background: rgba(255,209,102,0.22);
                border-color: rgba(255,209,102,0.65);
                color: #ffe299;
            }
            .vp-shell-save-btn.is-dirty .save-dot { color: #ffd166; }
            .vp-shell-save-btn:disabled { opacity: 0.6; cursor: default; }
            .vp-shell-ws-btn, .vp-shell-tool-btn {
                border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04);
                color: var(--text-primary, #cdd6f4); border-radius: 4px; padding: 0 8px;
                font-size: 11px; height: 21px; line-height: 1; display: inline-flex; align-items: center; justify-content: center;
                cursor: pointer; white-space: nowrap; flex-shrink: 0;
            }
            .vp-shell-ws-btn:hover, .vp-shell-tool-btn:hover { background: rgba(255,255,255,0.10); }
            .vp-shell-ws-btn.active { background: var(--accent, #6c5fa6); color: #fff; }
            .vp-shell-llama-pill {
                display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto;
                height: 21px; max-width: 240px; padding: 0 8px; border-radius: 999px;
                border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.045);
                color: var(--text-primary, #cdd6f4); font-size: 11px; cursor: pointer;
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
                transition: background 0.14s ease, border-color 0.14s ease;
            }
            .vp-shell-llama-pill:hover { background: rgba(255,255,255,0.10); border-color: rgba(255,255,255,0.20); }
            .vp-shell-llama-dot {
                width: 7px; height: 7px; border-radius: 50%; flex: 0 0 auto;
                background: #6c7086; transition: background 0.2s ease, box-shadow 0.2s ease;
            }
            .vp-shell-llama-pill[data-status="ready"] .vp-shell-llama-dot { background: #a6e3a1; box-shadow: 0 0 6px rgba(166,227,161,0.55); }
            .vp-shell-llama-pill[data-status="starting"] .vp-shell-llama-dot,
            .vp-shell-llama-pill[data-status="loading"] .vp-shell-llama-dot,
            .vp-shell-llama-pill[data-status="stopping"] .vp-shell-llama-dot { background: #f9e2af; box-shadow: 0 0 6px rgba(249,226,175,0.55); }
            .vp-shell-llama-pill[data-status="error"] .vp-shell-llama-dot { background: #f38ba8; box-shadow: 0 0 6px rgba(243,139,168,0.55); }
            .vp-shell-llama-label { overflow: hidden; text-overflow: ellipsis; max-width: 128px; }
            .vp-shell-llama-ctx { font-family: ui-monospace, Consolas, monospace; font-size: 10px; opacity: 0.78; flex: 0 0 auto; }
            .vp-shell-llama-ctx.warn { color: #f9e2af; opacity: 1; font-weight: 700; }
            .vp-shell-llama-ctx.danger { color: #f38ba8; opacity: 1; font-weight: 700; }
            .vp-shell-canvas { flex: 1; min-height: 0; padding: 4px; }
            .vp-shell-node { width: 100%; height: 100%; min-width: 0; min-height: 0; }
            .vp-shell-split { display: flex; gap: 0; }
            .vp-shell-split.row { flex-direction: row; }
            .vp-shell-split.column { flex-direction: column; }
            .vp-shell-pane-wrap { min-width: 0; min-height: 0; overflow: hidden; }
            .vp-shell-gutter { flex: 0 0 5px; background: transparent; position: relative; z-index: 2; }
            .vp-shell-gutter::after { content: ''; position: absolute; inset: 1px; border-radius: 3px; background: color-mix(in srgb, var(--text-secondary, #a6adc8) 12%, transparent); }
            .vp-shell-gutter:hover::after, .vp-shell-gutter.dragging::after {
                background: color-mix(in srgb, var(--accent, #6c5fa6) 38%, transparent);
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #6c5fa6) 16%, transparent) inset;
            }
            .vp-shell-split.row > .vp-shell-gutter { cursor: col-resize; }
            .vp-shell-split.column > .vp-shell-gutter { cursor: row-resize; }
            .vp-shell-area {
                height: 100%; display: flex; flex-direction: column; min-width: 0; min-height: 0;
                background: var(--bg-secondary, #1e1e2e);
                border: 1px solid var(--border, rgba(108,95,166,0.30));
                border-radius: 6px; overflow: hidden;
                box-shadow: 0 0 0 1px rgba(0,0,0,0.16) inset;
                transition: border-color 0.14s ease, box-shadow 0.14s ease, opacity 0.14s ease;
            }
            .vp-shell-area.is-focused-area {
                border-color: color-mix(in srgb, var(--accent, #6c5fa6) 62%, var(--border, rgba(255,255,255,0.18)));
                box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent, #6c5fa6) 22%, transparent) inset;
            }
            .vp-shell-area.is-dragging-area {
                opacity: 0.58;
            }
            .vp-shell-area.is-drop-target {
                border-color: var(--accent, #6c5fa6) !important;
                box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent, #6c5fa6) 65%, transparent) inset,
                            0 0 18px color-mix(in srgb, var(--accent, #6c5fa6) 28%, transparent) !important;
            }
            .vp-shell-area-header {
                position: relative;
                flex: 0 0 24px; height: 24px; display: flex; align-items: center; gap: 4px;
                background:
                    linear-gradient(180deg,
                        rgba(255,255,255, calc(0.055 * var(--header-glare-opacity, 0.45))) 0%,
                        rgba(255,255,255, 0) 48%,
                        rgba(0,0,0, calc(0.09 * var(--header-glare-opacity, 0.45))) 100%),
                    linear-gradient(180deg, var(--header-accent), var(--header-accent-deep));
                border-bottom: 1px solid var(--header-border);
                box-shadow:
                    0 1px 0 rgba(255,255,255, calc(0.09 * var(--header-glare-opacity, 0.45))) inset,
                    0 -1px 0 rgba(0,0,0,0.20) inset;
                padding: 0 5px; user-select: none; min-width: 0;
            }
            .vp-shell-area-header[draggable="true"] { cursor: grab; }
            .vp-shell-area.maximized .vp-shell-area-header { cursor: default; }
            .vp-shell-area.is-dragging-area .vp-shell-area-header { cursor: grabbing; }
            .vp-shell-area-header::after {
                content: ''; position: absolute; left: 6px; right: 6px; top: 0; height: 1px;
                background: linear-gradient(90deg, transparent, rgba(255,255,255, calc(0.28 * var(--header-glare-opacity, 0.45))), transparent);
                pointer-events: none;
            }
            .vp-shell-panel-select {
                position: relative; z-index: 1; flex: 0 0 auto;
                min-width: 0; max-width: 148px; height: 19px; padding: 0 4px;
                background: var(--bg-tertiary, #252540); color: var(--text-primary, #cdd6f4);
                border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; font-size: 11px;
                line-height: 1; cursor: pointer;
            }
            .vp-shell-panel-select.is-compact { padding: 0 2px 0 4px; }
            .vp-shell-header-slot-wrap {
                position: relative; z-index: 1; flex: 1 1 auto; min-width: 0; height: 100%;
                display: flex; align-items: center; overflow: hidden;
            }
            .vp-shell-header-slot {
                flex: 1 1 auto; min-width: 0; height: 100%;
                display: flex; align-items: center; gap: 3px;
                overflow-x: auto; overflow-y: hidden;
                scrollbar-width: none !important; -ms-overflow-style: none !important;
            }
            .vp-shell-header-slot::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }
            .vp-shell-header-slot.has-scroll-right {
                -webkit-mask-image: linear-gradient(to right, #000 0%, #000 calc(100% - 18px), transparent 100%);
                mask-image: linear-gradient(to right, #000 0%, #000 calc(100% - 18px), transparent 100%);
            }
            .vp-shell-header-slot.has-scroll-left {
                -webkit-mask-image: linear-gradient(to right, transparent 0%, #000 18px, #000 100%);
                mask-image: linear-gradient(to right, transparent 0%, #000 18px, #000 100%);
            }
            .vp-shell-header-slot.has-scroll-left.has-scroll-right {
                -webkit-mask-image: linear-gradient(to right, transparent 0%, #000 18px, #000 calc(100% - 18px), transparent 100%);
                mask-image: linear-gradient(to right, transparent 0%, #000 18px, #000 calc(100% - 18px), transparent 100%);
            }
            .vp-shell-header-slot .vp-hdr-bar {
                display: flex; align-items: center; gap: 3px;
                flex: 1 0 auto; min-width: max-content; height: 100%;
            }
            .vp-shell-header-slot .vp-hdr-spacer { flex: 1 1 0; min-width: 4px; }
            .vp-shell-header-slot .vp-hdr-sep {
                width: 1px; height: 12px; background: rgba(255,255,255,0.14);
                flex: 0 0 auto; margin: 0 2px;
            }
            .vp-shell-header-slot .vp-hdr-ico {
                display: inline-flex; align-items: center; line-height: 1; font-size: 11px;
            }
            .vp-shell-header-slot .vp-hdr-lbl {
                display: inline; white-space: nowrap;
            }
            .vp-shell-header-slot .vp-hdr-meta {
                color: var(--text-secondary, #a6adc8); font-size: 10.5px; white-space: nowrap;
                flex: 0 0 auto; padding: 0 3px;
            }
            .vp-shell-header-slot .vp-btn,
            .vp-shell-header-slot .vp-hdr-btn {
                height: 19px; min-height: 19px; line-height: 1; padding: 0 6px;
                font-size: 11px; border-radius: 4px;
                display: inline-flex; align-items: center; justify-content: center; gap: 3px;
                white-space: nowrap; flex: 0 0 auto;
            }
            .vp-shell-header-slot.is-icon-only .vp-hdr-lbl { display: none !important; }
            .vp-shell-header-slot.is-icon-only .vp-btn,
            .vp-shell-header-slot.is-icon-only .vp-hdr-btn { padding: 0 5px; }

            /* Docked Stage header living inside the area header slot */
            .vp-shell-header-slot #vp-header.vp-stage-header-docked {
                height: 100%; flex: 1 0 auto; min-width: max-content;
                display: flex; align-items: center; gap: 3px;
                padding: 0; background: transparent !important; border: none !important;
                cursor: default !important;
            }
            .vp-shell-header-slot #vp-header.vp-stage-header-docked #vp-minimize { display: none !important; }
            .vp-shell-header-slot #vp-header.vp-stage-header-docked .vp-header-btns {
                display: flex; align-items: center; gap: 3px; margin-left: auto; flex: 0 0 auto;
            }
            .vp-shell-header-slot #vp-header.vp-stage-header-docked .vp-btn {
                height: 19px; min-height: 19px; padding: 0 5px; font-size: 10.5px;
                white-space: nowrap; flex: 0 0 auto;
            }
            .vp-shell-header-slot #vp-header.vp-stage-header-docked .vp-tag-label {
                flex: 0 1 auto; min-width: 0; max-width: 116px; padding: 0 3px;
                text-align: left; font-size: 10.5px; line-height: 1;
            }
            .vp-shell-header-slot.is-icon-only #vp-header.vp-stage-header-docked .vp-tag-label {
                max-width: 68px;
            }

            /* Compact Input controls when docked into header slot */
            .vp-shell-header-slot .vp-session-participants {
                flex: 1 0 auto; min-width: max-content; flex-wrap: nowrap;
                gap: 3px; margin: 0 !important; padding: 0;
            }
            .vp-shell-header-slot .vp-session-participant-chip,
            .vp-shell-header-slot .vp-session-participant-add,
            .vp-shell-header-slot .vp-session-input-tool-chip,
            .vp-shell-header-slot .vp-session-scene-btn {
                height: 19px; padding: 0 7px; font-size: 10.5px; line-height: 1;
                flex: 0 0 auto; white-space: nowrap;
                display: inline-flex; align-items: center; gap: 3px;
            }
            .vp-shell-header-slot .vp-session-participant-chip .remove { width: 12px; height: 12px; font-size: 9px; }
            .vp-shell-header-slot .vp-session-participant-add { padding: 0 7px; }
            .vp-shell-header-slot .vp-ctx-counter { font-size: 10.5px; padding: 1px 4px; flex: 0 0 auto; }
            .vp-shell-header-slot .vp-bus-tabs { display: inline-flex; align-items: center; gap: 2px; flex: 0 0 auto; }
            .vp-shell-header-slot .vp-bus-tab {
                height: 19px; min-height: 19px; padding: 0 7px; font-size: 10.5px; border-radius: 4px;
                display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; flex: 0 0 auto;
            }
            .vp-shell-header-slot.is-icon-only .vp-bus-tab { padding: 0 5px; }

            .vp-shell-area-right {
                position: relative; z-index: 1; flex: 0 0 auto;
                display: inline-flex; align-items: center; gap: 3px;
            }
            .vp-shell-area-btn {
                position: relative; z-index: 1; flex: 0 0 auto;
                height: 19px; min-width: 20px; padding: 0 4px; border-radius: 4px;
                border: 1px solid rgba(255,255,255,0.10); background: rgba(255,255,255,0.04);
                color: var(--text-primary, #cdd6f4); cursor: pointer; font-size: 12px;
                display: inline-flex; align-items: center; justify-content: center; line-height: 1;
            }
            .vp-shell-area-btn:hover { background: rgba(255,255,255,0.12); }
            .vp-shell-area-btn.active { background: var(--accent); border-color: var(--accent); color: #fff; }
            .vp-shell-area-restore { display: none; }
            .vp-shell-area.maximized .vp-shell-area-restore { display: inline-flex; }
            .vp-shell-area-menu-btn { font-weight: 700; letter-spacing: 0; }

            /* Floating Area Actions Dropdown Menu (position: fixed to avoid area overflow clipping) */
            .vp-shell-area-menu {
                position: fixed; z-index: 39000; min-width: 162px; padding: 4px;
                border-radius: 7px;
                background: var(--bg-secondary, #1e1e2e);
                border: 1px solid var(--border, rgba(255,255,255,0.14));
                box-shadow: 0 10px 28px rgba(0,0,0,0.48), 0 0 0 1px rgba(255,255,255,0.04) inset;
                color: var(--text-primary, #cdd6f4);
                display: flex; flex-direction: column; gap: 1px;
                font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
                user-select: none;
            }
            .vp-shell-area-menu-item {
                display: flex; align-items: center; gap: 8px; width: 100%;
                padding: 5px 8px; border: none; border-radius: 5px;
                background: transparent; color: inherit; cursor: pointer;
                font-size: 11.5px; text-align: left; white-space: nowrap;
            }
            .vp-shell-area-menu-item:hover:not(:disabled) {
                background: rgba(255,255,255,0.09);
            }
            .vp-shell-area-menu-item.danger:hover:not(:disabled) {
                background: rgba(243,139,168,0.18); color: #f38ba8;
            }
            .vp-shell-area-menu-item:disabled {
                opacity: 0.38; cursor: default;
            }
            .vp-shell-area-menu-ico {
                width: 14px; text-align: center; flex: 0 0 14px; opacity: 0.88; font-size: 12px;
            }
            .vp-shell-area-menu-sep {
                height: 1px; margin: 3px 4px; background: rgba(255,255,255,0.10);
            }

            /* Focus Mode (Maximized Area) */
            .vp-shell-area.maximized {
                position: fixed;
                inset: 33px 4px 4px 4px;
                z-index: 9995;
                height: auto !important;
                box-shadow: 0 0 0 100vmax rgba(0,0,0,0.42);
            }

            .vp-shell-area-btn.is-muted { opacity: 0.45; pointer-events: none; }
            .vp-shell-area-body { flex: 1; min-height: 0; overflow: hidden; position: relative; isolation: isolate; }
            .vp-shell-area-body > .vp-shell-panel-host { position: absolute; inset: 0; overflow: auto; z-index: 0; }
            .vp-shell-modal-backdrop {
                position: absolute; inset: 0; z-index: 50;
                display: flex; align-items: flex-start; justify-content: center;
                padding: 18px 12px 12px; background: rgba(0,0,0,0.38);
                animation: vpShellModalIn 0.12s ease;
            }
            .vp-shell-modal-backdrop.global {
                position: fixed; z-index: 40000; padding: 8vh 24px 24px;
                background: rgba(0,0,0,0.56);
            }
            .vp-shell-modal-card {
                width: min(var(--vp-modal-width, 420px), 100%);
                max-height: 100%;
                background: var(--bg-secondary, #1e1e2e);
                border: 1px solid var(--border, #383860);
                border-radius: 10px; box-shadow: 0 14px 44px rgba(0,0,0,0.55);
                color: var(--text-primary, #cdd6f4);
                position: relative;
                display: flex;
                flex-direction: column;
            }
            .vp-shell-modal-backdrop.global .vp-shell-modal-card {
                width: min(var(--vp-modal-width, 520px), 96vw);
                max-height: 88vh;
            }
            .vp-shell-modal-head {
                flex: 0 0 34px; height: 34px; display: flex; align-items: center; gap: 8px;
                padding: 0 10px; background: var(--bg-tertiary, #252540);
                border-bottom: 1px solid var(--border, #383860); user-select: none;
                cursor: grab;
            }
            .vp-shell-modal-head:active { cursor: grabbing; }
            .vp-shell-modal-title { flex: 1; font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
            .vp-shell-modal-close {
                width: 24px; height: 24px; border: 0; border-radius: 5px;
                background: rgba(255,255,255,0.06); color: var(--text-primary, #cdd6f4);
                cursor: pointer;
            }
            .vp-shell-modal-close:hover { background: rgba(255,255,255,0.14); }
            .vp-shell-modal-body { padding: 10px; flex: 1; min-height: 0; overflow: auto; }
            .vp-shell-settings-form { display: flex; flex-direction: column; gap: 9px; font-size: 12px; }
            .vp-shell-settings-form label { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .vp-shell-settings-form input[type="checkbox"] { width: auto; }
            .vp-shell-settings-form select,
            .vp-shell-settings-form input:not([type="checkbox"]) {
                width: 56%; min-width: 120px; border-radius: 5px;
                border: 1px solid rgba(255,255,255,0.12);
                background: var(--bg-tertiary, #252540); color: var(--text-primary, #cdd6f4);
                padding: 5px 7px; font-size: 12px;
            }
            .vp-shell-settings-form select option,
            .vp-shell-panel-select option {
                background: var(--bg-tertiary, #252540);
                color: var(--text-primary, #cdd6f4);
            }
            .vp-shell-settings-note { color: var(--text-secondary, #a6adc8); font-size: 11px; line-height: 1.45; }
            @keyframes vpShellModalIn { from { opacity: 0; transform: scale(0.985); } to { opacity: 1; transform: scale(1); } }
            .vp-shell-placeholder, .vp-shell-empty-log {
                height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center;
                text-align: center; gap: 7px; color: var(--text-secondary, #a6adc8); padding: 18px; font-size: 12px; line-height: 1.45;
            }
            .vp-shell-placeholder-title { color: var(--text-primary, #cdd6f4); font-weight: 700; font-size: 14px; }
            .vp-shell-placeholder-text { max-width: 420px; }
            .vp-shell-docked { box-sizing: border-box !important; transform: none !important; }
            #vp-shell-root #visual-projector.vp-shell-docked-stage,
            #vp-shell-root #vp-gallery-panel.vp-shell-docked-gallery {
                border-radius: 0 !important; border: 0 !important; box-shadow: none !important;
                resize: none !important; max-width: none !important; max-height: none !important;
                z-index: 0 !important;
            }
            #vp-shell-root #visual-projector.vp-shell-docked-stage .vp-screen {
                margin: 4px; border-radius: 5px;
            }
            #vp-shell-root #vp-gallery-panel.vp-shell-docked-gallery { font-size: 13px; }
            #vp-shell-root .vp-resize-handle { display: none !important; }
            .vp-shell-log { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
            .vp-shell-log-item { border-radius: 8px; padding: 8px 10px; background: rgba(255,255,255,0.045); border: 1px solid rgba(255,255,255,0.06); }
            .vp-shell-log-item.role-user { background: var(--msg-user-bg, rgba(108,95,166,0.18)); }
            .vp-shell-log-role { font-size: 10px; letter-spacing: 0.08em; color: var(--text-secondary, #a6adc8); margin-bottom: 4px; }
            .vp-shell-log-text { white-space: pre-wrap; line-height: 1.45; font-size: 13px; }
            .vp-shell-input-panel { height: 100%; display: flex; flex-direction: column; gap: 8px; padding: 8px; }
            .vp-shell-input {
                flex: 1; min-height: 48px; resize: none; border-radius: 7px; border: 1px solid rgba(255,255,255,0.12);
                background: rgba(0,0,0,0.20); color: var(--text-primary, #cdd6f4); padding: 8px;
                font-family: inherit; font-size: 13px; outline: none;
            }
            .vp-shell-input:focus { border-color: var(--accent, #6c5fa6); }
            .vp-shell-input-actions { display: flex; align-items: center; gap: 10px; font-size: 11px; color: var(--text-secondary, #a6adc8); }
            .vp-shell-form { padding: 10px; display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
            .vp-shell-form-title { font-weight: 700; margin-bottom: 4px; }
            .vp-shell-form label { display: flex; align-items: center; gap: 8px; justify-content: space-between; }
            .vp-shell-form input {
                width: 58%; background: rgba(0,0,0,0.22); color: var(--text-primary, #cdd6f4);
                border: 1px solid rgba(255,255,255,0.12); border-radius: 4px; padding: 4px 6px; font-size: 12px;
            }
            .vp-shell-form .vp-shell-check { justify-content: flex-start; }
            .vp-shell-form .vp-shell-check input { width: auto; }
            .vp-shell-note { color: var(--text-secondary, #a6adc8); font-size: 11px; line-height: 1.4; margin-top: 5px; }
            .vp-shell-global-settings { padding: 6px; display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--text-primary,#cdd6f4); }
			.vp-settings-section { border: 1px solid rgba(255,255,255,0.07); border-radius: 7px; background: rgba(255,255,255,0.025); margin-bottom: 0; overflow: hidden; }
			.vp-settings-section-header { display:flex; align-items:center; justify-content:space-between; padding:6px 9px; background:rgba(255,255,255,0.04); cursor:pointer; user-select:none; font-weight:700; font-size:12px; transition:background 0.15s; }
			.vp-settings-section-header:hover { background:rgba(255,255,255,0.07); }
			.vp-settings-toggle { font-size:10px; opacity:0.7; transition:transform 0.2s; }
			.vp-settings-section.collapsed .vp-settings-toggle { transform:rotate(-90deg); }
			.vp-settings-section-content { padding:7px 9px; display:flex; flex-direction:column; gap:6px; }
			.vp-settings-section.collapsed .vp-settings-section-content { display:none; }
            .vp-settings-section-title { font-weight: 800; font-size: 12px; margin-bottom: 1px; }
            .vp-settings-row, .vp-settings-kv { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .vp-settings-row input:not([type="checkbox"]), .vp-settings-row select { width: 56%; min-width: 120px; height: 24px; box-sizing: border-box; border-radius: 4px; border: 1px solid rgba(255,255,255,0.12); background: var(--bg-tertiary,#252540); color: var(--text-primary,#cdd6f4); padding: 2px 6px; font-size: 11.5px; }
            .vp-settings-kv code { max-width: 62%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #b9aee8; }
            .vp-settings-actions { display: flex; flex-wrap: wrap; gap: 5px; }
            .vp-settings-note { color: var(--text-secondary,#a6adc8); font-size: 10.5px; line-height: 1.35; }
            .vp-settings-css { width: 100%; min-height: 150px; resize: vertical; border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color: var(--text-primary,#cdd6f4); padding: 8px; font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
            .vp-settings-row-block { align-items: stretch; flex-direction: column; }
            .vp-settings-small-textarea { width: 100%; min-height: 76px; resize: vertical; border-radius: 7px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.22); color: var(--text-primary,#cdd6f4); padding: 8px; font: 12px/1.45 system-ui, sans-serif; }
            .vp-custom-colors-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
            .vp-color-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
            .vp-color-label { font-size: 11px; opacity: 0.9; }
            .vp-color-inputs { display: flex; flex-direction: column; gap: 4px; width: 56%; }
            .vp-color-input-row { display: flex; align-items: center; gap: 4px; }
            .vp-color-picker { width: 26px; height: 26px; padding: 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; cursor: pointer; background: none; flex-shrink: 0; }
            .vp-color-picker::-webkit-color-swatch-wrapper { padding: 2px; }
            .vp-color-picker::-webkit-color-swatch { border-radius: 3px; border: none; }
            .vp-color-picker::-moz-color-swatch { border-radius: 3px; border: none; }
            .vp-color-hex { flex: 1; min-width: 60px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 11px; padding: 4px 6px; text-transform: uppercase; border-radius: 5px; border: 1px solid rgba(255,255,255,0.12); background: var(--bg-tertiary,#252540); color: var(--text-primary,#cdd6f4); }
            .vp-color-hex:focus { border-color: var(--accent,#6c5fa6); outline: none; }
            .vp-color-alpha-row { display: flex; align-items: center; gap: 6px; padding: 2px 0 0 0; }
            .vp-color-alpha-label { font-size: 10px; color: var(--text-secondary,#a6adc8); font-weight: 700; flex: 0 0 auto; }
            .vp-color-alpha-slider {
                flex: 1; height: 4px; -webkit-appearance: none; appearance: none;
                background: linear-gradient(to right, transparent, var(--accent,#6c5fa6));
                border-radius: 2px; outline: none; cursor: pointer;
            }
            .vp-color-alpha-slider::-webkit-slider-thumb {
                -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%;
                background: var(--text-primary,#cdd6f4); border: 1px solid rgba(255,255,255,0.3);
                cursor: pointer; box-shadow: 0 1px 4px rgba(0,0,0,0.3);
            }
            .vp-color-alpha-slider::-moz-range-thumb {
                width: 12px; height: 12px; border-radius: 50%;
                background: var(--text-primary,#cdd6f4); border: 1px solid rgba(255,255,255,0.3);
                cursor: pointer;
            }
            .vp-color-alpha-value { font-size: 10px; color: var(--text-secondary,#a6adc8); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; min-width: 28px; text-align: right; }
            .vp-health-toolbar { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
            .vp-health-toolbar span { margin-left:auto; font-size:12px; color:var(--text-secondary,#a6adc8); }
            .vp-health-toolbar span.ok { color:#9ff0b7; } .vp-health-toolbar span.warn { color:#f2cf72; } .vp-health-toolbar span.err { color:#ff9b9b; }
            .vp-health-counts { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:10px; }
            .vp-health-chip { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.035); border-radius:999px; padding:4px 8px; display:flex; gap:6px; align-items:center; font-size:11px; }
            .vp-health-chip span { color:var(--text-secondary,#a6adc8); } .vp-health-chip b { color:var(--text-primary,#cdd6f4); }
            .vp-health-list { display:flex; flex-direction:column; gap:7px; max-height:58vh; overflow:auto; }
            .vp-health-empty { color:var(--text-secondary,#a6adc8); text-align:center; padding:22px 8px; font-size:12px; }
            .vp-health-row { border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.035); border-radius:8px; padding:7px 9px; }
            .vp-health-row.ok { border-color:rgba(76,175,125,0.25); } .vp-health-row.warn { border-color:rgba(242,207,114,0.35); } .vp-health-row.error { border-color:rgba(224,85,85,0.42); }
            .vp-health-row-title { color:var(--text-primary,#cdd6f4); font-size:12px; }
            .vp-health-row-detail { margin-top:3px; color:var(--text-secondary,#a6adc8); font:11px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; word-break:break-word; }
            #vp-shell-return {
                position: fixed; right: 14px; top: 14px; z-index: 30000;
                height: 30px; padding: 0 12px; border-radius: 999px;
                border: 1px solid rgba(255,255,255,0.18);
                background: var(--accent, #6c5fa6); color: #fff;
                box-shadow: 0 6px 18px rgba(0,0,0,0.38);
                font: 12px system-ui, sans-serif; font-weight: 700;
                cursor: pointer;
            }
            #vp-shell-return:hover { filter: brightness(1.12); }
            .vp-shell-section-label {
                font-size: 10px; font-weight: 600; text-transform: uppercase;
                letter-spacing: 0.05em; color: var(--text-secondary, #a6adc8);
                opacity: 0.7; white-space: nowrap; margin-right: 4px;
            }
            .vp-shell-ws-add {
                border-style: dashed !important; border-color: rgba(255,255,255,0.15) !important;
                background: transparent !important; color: var(--text-secondary, #a6adc8) !important;
                min-width: 24px; padding: 2px 6px !important; font-size: 14px !important;
                font-weight: 700; line-height: 1;
            }
            .vp-shell-ws-add:hover {
                border-color: var(--accent, #6c5fa6) !important;
                color: var(--accent, #6c5fa6) !important;
                background: rgba(108,95,166,0.08) !important;
            }

            /* Focus Mode: restore button stays highlighted */
            .vp-shell-area.maximized .vp-shell-area-restore {
                background: var(--accent, #6c5fa6);
                border-color: var(--accent, #6c5fa6);
                color: #fff;
            }

            /* ── Вариант A: оптимизация перетаскивания сплиттеров ── */
            /* Класс вешается на body во время drag для изоляции тяжелого контента */
            body.vp-shell-resizing {
                user-select: none !important;
                -webkit-user-select: none !important;
            }
            body.vp-shell-resizing .vp-shell-panel-host {
                contain: layout style paint;
                pointer-events: none;
                content-visibility: auto;
            }
            body.vp-shell-resizing .vp-shell-area-body {
                contain: layout style paint;
            }
            body.vp-shell-resizing .vp-shell-pane-wrap {
                contain: layout size style;
            }
            /* Тяжелые панели — дополнительная изоляция */
            body.vp-shell-resizing .vp-session-log-list,
            body.vp-shell-resizing .vp-gallery-grid,
            body.vp-shell-resizing .vp-as-canvas,
            body.vp-shell-resizing .vp-as-graph {
                contain: layout style paint;
                pointer-events: none;
                content-visibility: auto;
            }
            /* #vp-screen is the always-visible projector surface — never
               actually "offscreen" — so it must NOT get content-visibility:
               auto. That property lets the engine defer/cache its internal
               layout as if it were irrelevant, and under flexbox+aspect-ratio
               this cache can go stale when only the container's cross-axis
               size changes (no new intersection event fires because the
               element stays fully visible the whole time). The visible
               symptom: dragging a panel splitter's WIDTH left the Focus Mode
               4:3 crop stretched until the user clicked/dragged the image,
               which forced a synchronous reflow via getBoundingClientRect()
               and "woke" the stale layout back up. Keep the perf-friendly
               layout/paint containment and pointer-events freeze, but let
               this element's own box re-layout normally like any other. */
            body.vp-shell-resizing #vp-screen,
            body.vp-shell-resizing .vp-screen {
                contain: layout style paint;
                pointer-events: none;
            }
            body.vp-shell-resizing .vp-shell-gutter.dragging {
                pointer-events: auto;
            }
            /* Убираем дорогие эффекты во время resize */
            body.vp-shell-resizing .vp-shell-area {
                will-change: flex-basis;
            }
        `;
        document.head.appendChild(style);
    }

	function showWorkspaceContextMenu(e, workspaceId, def) {
		if (activeWorkspaceContextMenuCleanup) {
			activeWorkspaceContextMenuCleanup();
		}
		
		const menu = document.createElement('div');
		menu.className = 'vp-shell-context-menu';
		menu.style.cssText = `
			position: fixed;
			left: ${e.clientX}px;
			top: ${e.clientY}px;
			background: var(--bg-tertiary, #252540);
			border: 1px solid var(--border, #383860);
			border-radius: 6px;
			z-index: 10005;
			box-shadow: 0 4px 16px rgba(0,0,0,0.5);
			min-width: 160px;
			font-family: system-ui, sans-serif;
			padding: 4px 0;
			color: var(--text-primary, #cdd6f4);
		`;
		
		const addItem = (text, onClick, color = 'var(--text-primary, #cdd6f4)') => {
			const item = document.createElement('div');
			item.textContent = text;
			item.style.cssText = `padding: 8px 12px; cursor: pointer; font-size: 13px; line-height: 1.25; color: ${color}; user-select: none;`;
			item.addEventListener('mouseenter', () => { item.style.background = 'var(--accent, #6c5fa6)'; });
			item.addEventListener('mouseleave', () => { item.style.background = ''; });
			item.addEventListener('click', (ev) => {
				ev.preventDefault();
				ev.stopPropagation();
				cleanup();
				onClick?.();
			});
			menu.appendChild(item);
			return item;
		};
		
		const addSeparator = () => {
			const hr = document.createElement('hr');
			hr.style.cssText = 'border:0; border-top:1px solid var(--border, #383860); margin:4px 0;';
			menu.appendChild(hr);
		};
		
		addItem('✏️ Rename', async () => {
			const current = def.title || workspaceId;
			const next = await VP.showPrompt?.({
				title: 'Rename workspace',
				message: 'Новое название workspace:',
				value: current,
				placeholder: 'Workspace name',
				confirmLabel: 'Save',
				required: true,
			});
			if (next === null || next === undefined) return;
			const trimmed = next.trim();
			if (!trimmed || trimmed === current) return;
			def.title = trimmed;
			saveShellState();
			renderShell();
			VP.showToast?.(`Workspace renamed: ${trimmed}`, 'success');
		});
		
		addSeparator();
		
		addItem('🔄 Reset', async () => {
			const ans = await VP.showConfirm?.({
				title: 'Reset workspace?',
				message: `Reset workspace «${def.title || workspaceId}» to default layout?`,
				buttons: [
					{ id: 'cancel', label: 'Cancel', ghost: true },
					{ id: 'ok', label: 'Reset', danger: true },
				],
			});
			if (ans !== 'ok') return;
			S.shell.layouts[workspaceId] = clone(PRESETS.director.layout);
			saveShellState();
			renderShell();
			VP.showToast?.('Workspace reset', 'success');
		});
		
		addSeparator();
		
		addItem('🗑️ Delete', async () => {
			const ans = await VP.showConfirm?.({
				title: 'Delete workspace?',
				message: `Delete workspace «${def.title || workspaceId}»?`,
				buttons: [
					{ id: 'cancel', label: 'Cancel', ghost: true },
					{ id: 'ok', label: 'Delete', danger: true },
				],
			});
			if (ans !== 'ok') return;
			delete S.shell.customWorkspaces[workspaceId];
			delete S.shell.layouts[workspaceId];
			S.shell.activeWorkspace = 'director';
			if (!S.shell.layouts.director) S.shell.layouts.director = clone(PRESETS.director.layout);
			saveShellState();
			renderShell();
			VP.showToast?.(`Workspace deleted: ${def.title || workspaceId}`, 'success');
		}, 'var(--error, #e05555)');
		
		document.body.appendChild(menu);
		
		// Keep menu inside viewport
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
		
		// Close on outside click
		const close = (ev) => {
			if (!menu.contains(ev.target)) {
				cleanup();
			}
		};
		const cleanup = () => {
			menu.remove();
			document.removeEventListener('mousedown', close);
			document.removeEventListener('contextmenu', close);
			if (activeWorkspaceContextMenuCleanup === cleanup) {
				activeWorkspaceContextMenuCleanup = null;
			}
		};
		activeWorkspaceContextMenuCleanup = cleanup;
		setTimeout(() => {
			if (activeWorkspaceContextMenuCleanup === cleanup) {
				document.addEventListener('mousedown', close);
				document.addEventListener('contextmenu', close);
			}
		}, 0);
	}


	function renderWorkspaceTabs(root) {
		const host = root.querySelector('.vp-shell-workspaces');
		host.innerHTML = '';
		const defs = getWorkspaceDefs();
		for (const [id, def] of Object.entries(defs)) {
			const btn = document.createElement('button');
			btn.className = 'vp-shell-ws-btn' + (S.shell.activeWorkspace === id ? ' active' : '');
			btn.textContent = `${def.icon || '□'} ${def.title || id}`;
			btn.title = `Workspace: ${def.title || id}`;
			
			btn.addEventListener('click', () => {
				S.shell.activeWorkspace = id;
				if (!S.shell.layouts[id]) S.shell.layouts[id] = clone(PRESETS.director.layout);
				saveShellState();
				renderShell();
			});
			
			if (!def.builtin) {
				btn.addEventListener('contextmenu', (e) => {
					e.preventDefault();
					e.stopPropagation();
					showWorkspaceContextMenu(e, id, def);
				});
			}
			
			host.appendChild(btn);
		}
		
		// "+" button at the end
		const addBtn = document.createElement('button');
		addBtn.className = 'vp-shell-ws-btn vp-shell-ws-add';
		addBtn.textContent = '+';
		addBtn.title = 'Save current layout as new workspace';
		addBtn.addEventListener('click', saveWorkspaceAs);
		host.appendChild(addBtn);
	}

    function findLeaf(node, id) {
        if (!node) return null;
        if (node.type === 'leaf') return node.id === id ? node : null;
        return findLeaf(node.a, id) || findLeaf(node.b, id);
    }

    function findFirstLeaf(node) {
        if (!node) return null;
        if (node.type === 'leaf') return node;
        return findFirstLeaf(node.a) || findFirstLeaf(node.b);
    }

    function splitLeafInTree(node, leafId, direction, newPanel) {
        if (node.type === 'leaf' && node.id === leafId) {
            const old = { ...node };
            return split(direction, 0.5, old, leaf(newPanel));
        }
        if (node.type === 'split') {
            return { ...node, a: splitLeafInTree(node.a, leafId, direction, newPanel), b: splitLeafInTree(node.b, leafId, direction, newPanel) };
        }
        return node;
    }

    function closeLeafInTree(node, leafId) {
        if (!node || node.type === 'leaf') return node;
        if (node.a.type === 'leaf' && node.a.id === leafId) return node.b;
        if (node.b.type === 'leaf' && node.b.id === leafId) return node.a;
        return { ...node, a: closeLeafInTree(node.a, leafId), b: closeLeafInTree(node.b, leafId) };
    }

    function setSplitRatio(node, splitId, ratio) {
        if (!node) return node;
        if (node.type === 'split' && node.id === splitId) return { ...node, ratio };
        if (node.type === 'split') return { ...node, a: setSplitRatio(node.a, splitId, ratio), b: setSplitRatio(node.b, splitId, ratio) };
        return node;
    }

    const _slotObservers = new Set();
    let _activeAreaMenu = null;
    let _activeAreaMenuBtn = null;
    let _areaMenuCleanup = null;
    let _shellGesturesBound = false;
    let _hoveredAreaEl = null;
    let _focusedAreaEl = null;
    let _draggedAreaId = null;

    let _selectMeasureCanvas = null;
    function fitPanelSelectWidth(select, areaEl = null) {
        if (!select) return;
        const area = areaEl || select.closest?.('.vp-shell-area');
        const opt = select.options?.[select.selectedIndex];
        const text = opt?.textContent || '';
        select.title = text ? `Switch panel (${text})` : 'Switch panel';

        const areaW = area?.clientWidth || 0;
        const wasCompact = select.classList.contains('is-compact');
        const compact = areaW > 0 && (wasCompact ? areaW < 242 : areaW < 230);
        select.classList.toggle('is-compact', compact);
        if (compact) {
            select.style.width = '44px';
            return;
        }

        let textWidth = text.length * 6.8;
        try {
            if (!_selectMeasureCanvas) _selectMeasureCanvas = document.createElement('canvas');
            const ctx2d = _selectMeasureCanvas.getContext('2d');
            if (ctx2d) {
                ctx2d.font = '11px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
                textWidth = ctx2d.measureText(text).width;
            }
        } catch {}
        // Reserve room for native dropdown chevron + emoji width variance + padding
        const width = Math.max(66, Math.min(148, Math.ceil(textWidth + 36)));
        select.style.width = `${width}px`;
    }

    function updateHeaderSlotScrollFade(slot) {
        if (!slot) return;
        const maxScroll = slot.scrollWidth - slot.clientWidth;
        if (maxScroll <= 2) {
            slot.classList.remove('has-scroll-left', 'has-scroll-right');
            return;
        }
        slot.classList.toggle('has-scroll-left', slot.scrollLeft > 2);
        slot.classList.toggle('has-scroll-right', slot.scrollLeft < maxScroll - 2);
    }

    function syncHeaderSlot(slot) {
        if (!slot || !slot.isConnected) return;
        if (slot.childElementCount === 0) {
            slot.classList.remove('is-icon-only', 'has-scroll-left', 'has-scroll-right');
            slot._fullWidth = 0;
            return;
        }
        const cw = slot.clientWidth;
        if (cw <= 0) return;

        const hasLabels = !!slot.querySelector('.vp-hdr-lbl');
        if (hasLabels) {
            if (!slot.classList.contains('is-icon-only')) {
                if (slot.scrollWidth > cw + 1) {
                    slot._fullWidth = slot.scrollWidth;
                    slot.classList.add('is-icon-only');
                }
            } else if (cw >= (slot._fullWidth || 0) + 12) {
                slot.classList.remove('is-icon-only');
                if (slot.scrollWidth > cw + 1) {
                    slot._fullWidth = slot.scrollWidth;
                    slot.classList.add('is-icon-only');
                }
            }
        } else {
            slot.classList.remove('is-icon-only');
        }
        updateHeaderSlotScrollFade(slot);
    }

    function attachHeaderSlot(slot) {
        if (!slot || slot._vpSlotBound) return;
        slot._vpSlotBound = true;
        slot._fullWidth = 0;

        slot.addEventListener('wheel', (e) => {
            if (slot.scrollWidth <= slot.clientWidth + 1) return;
            const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
            if (!delta) return;
            e.preventDefault();
            slot.scrollLeft += delta * 0.85;
            updateHeaderSlotScrollFade(slot);
        }, { passive: false });

        slot.addEventListener('scroll', () => {
            updateHeaderSlotScrollFade(slot);
        }, { passive: true });

        if (typeof ResizeObserver !== 'undefined') {
            const area = slot.closest?.('.vp-shell-area');
            const select = area?.querySelector?.('.vp-shell-panel-select');
            const ro = new ResizeObserver(() => {
                if (select && area) fitPanelSelectWidth(select, area);
                syncHeaderSlot(slot);
            });
            ro.observe(slot);
            if (area) ro.observe(area);
            _slotObservers.add(ro);
        }
    }

    function clearHeaderSlotEl(slot) {
        if (!slot) return;
        const dockedStageHdr = slot.querySelector('#vp-header.vp-stage-header-docked');
        if (dockedStageHdr) restoreStageHeaderToProjector();
        slot.innerHTML = '';
        slot.scrollLeft = 0;
        slot._fullWidth = 0;
        slot.classList.remove('is-icon-only', 'has-scroll-left', 'has-scroll-right');
    }

    function setHeaderSlotContent(slot, content) {
        if (!slot) return;
        clearHeaderSlotEl(slot);
        if (!content) return;
        if (typeof content === 'string') {
            slot.innerHTML = content;
        } else if (Array.isArray(content)) {
            content.forEach(item => { if (item) slot.appendChild(item); });
        } else {
            slot.appendChild(content);
        }
        syncHeaderSlot(slot);
        requestAnimationFrame(() => syncHeaderSlot(slot));
    }

    function restoreStageHeaderToProjector() {
        const vp = S.ui?.vpWindow || document.getElementById('visual-projector');
        const hdr = S.ui?.header || document.getElementById('vp-header') || vp?.querySelector('#vp-header');
        if (!hdr) return;
        hdr.classList.remove('vp-stage-header-docked');
        if (vp && hdr.parentElement !== vp) {
            vp.prepend(hdr);
        }
    }

    function closeAreaMenu() {
        if (_areaMenuCleanup) {
            _areaMenuCleanup();
            _areaMenuCleanup = null;
        }
        if (_activeAreaMenu) {
            _activeAreaMenu.remove();
            _activeAreaMenu = null;
        }
        if (_activeAreaMenuBtn) {
            _activeAreaMenuBtn.setAttribute('aria-expanded', 'false');
            _activeAreaMenuBtn.classList.remove('active');
            _activeAreaMenuBtn = null;
        }
    }

    function notifyAreaLayoutToggle(panelId) {
        if (panelId === 'stage') requestProjectorUiUpdate('shell-focus');
        if (panelId === 'gallery') requestGalleryUiRefresh('shell-focus');
        if (panelId === 'asset-studio') {
            setTimeout(() => {
                window.VP_AS?.Graph?.viewport?.handleResize?.({ preserveCenter: true });
                window.VP_AS?.Graph?.links?._render?.();
            }, 30);
        }
    }

    function toggleAreaMaximize(area, panelId, forceState = null) {
        const next = forceState === null ? !area.classList.contains('maximized') : !!forceState;
        const changed = area.classList.contains('maximized') !== next;
        area.classList.toggle('maximized', next);
        if (!changed) return;
        const slot = area.querySelector('.vp-shell-header-slot');
        if (slot) requestAnimationFrame(() => syncHeaderSlot(slot));
        notifyAreaLayoutToggle(panelId);
    }

    function setFocusedArea(area) {
        if (_focusedAreaEl === area) return;
        if (_focusedAreaEl) _focusedAreaEl.classList.remove('is-focused-area');
        _focusedAreaEl = area && area.isConnected ? area : null;
        if (_focusedAreaEl) _focusedAreaEl.classList.add('is-focused-area');
    }

    function ensureShellGestureListeners() {
        if (_shellGesturesBound) return;
        _shellGesturesBound = true;

        document.addEventListener('pointermove', (e) => {
            const area = e.target?.closest?.('#vp-shell-root .vp-shell-area') || null;
            _hoveredAreaEl = area;
        }, { passive: true });

        const trackFocus = (e) => {
            const area = e.target?.closest?.('#vp-shell-root .vp-shell-area') || null;
            if (area) setFocusedArea(area);
        };
        document.addEventListener('pointerdown', trackFocus, true);
        document.addEventListener('focusin', trackFocus, true);

        document.addEventListener('keydown', (e) => {
            // Blender-style Ctrl+Space: maximize/restore hovered (or focused) area
            if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'Space' || e.key === ' ')) {
                if (document.querySelector('.vp-shell-modal-backdrop')) return;
                const root = document.getElementById('vp-shell-root');
                if (!root || root.style.display === 'none') return;
                const maxArea = root.querySelector('.vp-shell-area.maximized');
                if (maxArea) {
                    e.preventDefault();
                    closeAreaMenu();
                    toggleAreaMaximize(maxArea, maxArea.querySelector('.vp-shell-panel-select')?.value, false);
                    return;
                }
                const target = (_hoveredAreaEl && _hoveredAreaEl.isConnected)
                    ? _hoveredAreaEl
                    : (_focusedAreaEl && _focusedAreaEl.isConnected ? _focusedAreaEl : null);
                if (target) {
                    e.preventDefault();
                    closeAreaMenu();
                    toggleAreaMaximize(target, target.querySelector('.vp-shell-panel-select')?.value, true);
                }
                return;
            }

            if (e.key !== 'Escape') return;
            if (_activeAreaMenu) return;
            if (document.querySelector('.vp-shell-modal-backdrop')) return;
            const active = document.activeElement;
            if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
            const maxArea = document.querySelector('#vp-shell-root .vp-shell-area.maximized');
            if (!maxArea) return;
            const pid = maxArea.querySelector('.vp-shell-panel-select')?.value;
            toggleAreaMaximize(maxArea, pid, false);
        });
    }

    function swapAreasInLayout(idA, idB) {
        if (!idA || !idB || idA === idB) return;
        const layout = getCurrentLayout();
        const leafA = findLeaf(layout, idA);
        const leafB = findLeaf(layout, idB);
        if (!leafA || !leafB) return;

        const panelA = leafA.panel;
        const panelB = leafB.panel;
        const stateA = leafA.state;
        const stateB = leafB.state;

        leafA.panel = panelB;
        leafA.state = stateB;
        leafB.panel = panelA;
        leafB.state = stateA;
        saveShellState();

        // Fast surgical swap when neither panel is a singleton; otherwise safe full render
        if (!SINGLETON_PANELS.has(panelA) && !SINGLETON_PANELS.has(panelB)) {
            const areaA = document.querySelector(`#vp-shell-root .vp-shell-area[data-area-id="${idA}"]`);
            const areaB = document.querySelector(`#vp-shell-root .vp-shell-area[data-area-id="${idB}"]`);
            if (areaA && areaB) {
                replaceAreaPanelLocally(areaA, leafA, panelB);
                replaceAreaPanelLocally(areaB, leafB, panelA);
                setFocusedArea(areaB);
                return;
            }
        }
        renderShell();
    }

    function openAreaMenu(btn, area, node, isRoot, panels, coords = null) {
        if (!coords && _activeAreaMenu && _activeAreaMenuBtn === btn) {
            closeAreaMenu();
            return;
        }
        closeAreaMenu();

        const select = area.querySelector('.vp-shell-panel-select');
        const panelId = select?.value || node.panel;
        const panelDef = VP.getPanel(panelId);
        const hasSettings = !!panelDef?.settings;
        const isMaximized = area.classList.contains('maximized');

        const menu = document.createElement('div');
        menu.className = 'vp-shell-area-menu';
        menu.setAttribute('role', 'menu');

        const addItem = ({ icon, label, disabled = false, danger = false, title = '', onClick }) => {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'vp-shell-area-menu-item' + (danger ? ' danger' : '');
            item.setAttribute('role', 'menuitem');
            item.disabled = !!disabled;
            if (title) item.title = title;
            item.innerHTML = `<span class="vp-shell-area-menu-ico">${icon}</span><span>${label}</span>`;
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                if (item.disabled) return;
                closeAreaMenu();
                onClick?.();
            });
            menu.appendChild(item);
        };
        const addSep = () => {
            const sep = document.createElement('div');
            sep.className = 'vp-shell-area-menu-sep';
            menu.appendChild(sep);
        };

        addItem({
            icon: '⚙',
            label: 'Panel settings',
            disabled: !hasSettings,
            title: hasSettings ? 'Open panel settings' : 'This panel has no settings yet',
            onClick: () => showPanelSettings(area, panelId),
        });
        addItem({
            icon: isMaximized ? '❐' : '⛶',
            label: isMaximized ? 'Restore layout' : 'Maximize area',
            onClick: () => toggleAreaMaximize(area, panelId),
        });
        addSep();
        addItem({
            icon: '↔',
            label: 'Split right',
            disabled: isMaximized,
            title: isMaximized ? 'Restore layout before splitting' : 'Split area horizontally',
            onClick: () => {
                const fallback = panelId === 'stage' ? 'log' : 'stage';
                setCurrentLayout(splitLeafInTree(getCurrentLayout(), node.id, 'row', VP.getPanel(fallback) ? fallback : panels[0]?.id || panelId));
                renderShell();
            },
        });
        addItem({
            icon: '↕',
            label: 'Split down',
            disabled: isMaximized,
            title: isMaximized ? 'Restore layout before splitting' : 'Split area vertically',
            onClick: () => {
                const fallback = panelId === 'input' ? 'log' : 'input';
                setCurrentLayout(splitLeafInTree(getCurrentLayout(), node.id, 'column', VP.getPanel(fallback) ? fallback : panels[0]?.id || panelId));
                renderShell();
            },
        });
        addSep();
        addItem({
            icon: '×',
            label: 'Close area',
            disabled: isRoot || isMaximized,
            danger: true,
            title: isRoot ? 'Cannot close the last area' : (isMaximized ? 'Restore layout before closing' : 'Close this area'),
            onClick: () => {
                if (isRoot) return;
                const next = closeLeafInTree(getCurrentLayout(), node.id);
                if (next) setCurrentLayout(next);
                renderShell();
            },
        });

        document.body.appendChild(menu);
        _activeAreaMenu = menu;
        _activeAreaMenuBtn = btn;
        btn.setAttribute('aria-expanded', 'true');
        btn.classList.add('active');

        const menuRect = menu.getBoundingClientRect();
        let left, top;
        if (coords) {
            left = coords.x;
            top = coords.y;
            if (left + menuRect.width > window.innerWidth - 6) left = Math.max(6, coords.x - menuRect.width);
            if (top + menuRect.height > window.innerHeight - 6) top = Math.max(6, coords.y - menuRect.height);
        } else {
            const rect = btn.getBoundingClientRect();
            left = rect.right - menuRect.width;
            top = rect.bottom + 4;
            if (left < 6) left = 6;
            if (left + menuRect.width > window.innerWidth - 6) left = Math.max(6, window.innerWidth - menuRect.width - 6);
            if (top + menuRect.height > window.innerHeight - 6 && rect.top - menuRect.height - 4 >= 6) {
                top = rect.top - menuRect.height - 4;
            }
        }
        menu.style.left = `${Math.round(Math.max(6, left))}px`;
        menu.style.top = `${Math.round(Math.max(6, top))}px`;

        const onMouseDown = (ev) => {
            if (!menu.contains(ev.target) && ev.target !== btn && !btn.contains(ev.target)) closeAreaMenu();
        };
        const onKeyDown = (ev) => {
            if (ev.key === 'Escape') {
                ev.stopPropagation();
                closeAreaMenu();
            }
        };
        const onResize = () => closeAreaMenu();
        setTimeout(() => {
            document.addEventListener('mousedown', onMouseDown, true);
            document.addEventListener('keydown', onKeyDown, true);
            window.addEventListener('resize', onResize);
        }, 0);
        _areaMenuCleanup = () => {
            document.removeEventListener('mousedown', onMouseDown, true);
            document.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('resize', onResize);
        };
    }

    function makePanelCtx(node, panelId, areaEl = null) {
        const pid = panelId || node?.panel || 'unknown';
        const getSlot = () => areaEl?.querySelector?.('.vp-shell-header-slot') || null;
        return {
            areaId: node?.id || areaEl?.dataset?.areaId || null,
            shell: Shell,
            leaf: node || null,
            panelId: pid,
            areaEl,
            get headerSlot() { return getSlot(); },
            setHeaderContent(content) {
                const slot = getSlot();
                if (slot) setHeaderSlotContent(slot, content);
            },
            clearHeaderSlot() {
                const slot = getSlot();
                if (slot) clearHeaderSlotEl(slot);
            },
            syncHeaderSlot() {
                const slot = getSlot();
                if (slot) syncHeaderSlot(slot);
            },
            getPanelState(defaults = {}) {
                if (!node) return { ...defaults };
                if (!node.state) node.state = {};
                if (!node.state[pid]) node.state[pid] = {};
                return { ...defaults, ...node.state[pid] };
            },
            setPanelState(patch = {}, opts = {}) {
                if (!node) return;
                if (!node.state) node.state = {};
                node.state[pid] = { ...(node.state[pid] || {}), ...patch };
                if (opts.persist !== false) saveShellState();
            },
        };
    }

    function closeShellModals() {
        document.querySelectorAll('.vp-shell-modal-backdrop').forEach(el => el.remove());
        document.removeEventListener('keydown', _modalEscHandler, true);
    }

    function _modalEscHandler(e) {
        if (e.key === 'Escape') closeShellModals();
    }

    function createSettingsModal(host, panelDef, areaEl = null, global = false, panelCtx = null) {
        closeShellModals();
        const settings = panelDef.settings;
        if (!settings) return;

        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop' + (global ? ' global' : '');
        backdrop.dataset.panelId = panelDef.id;
        if (areaEl?.dataset?.areaId) backdrop.dataset.areaId = areaEl.dataset.areaId;
        const width = settings.width || (global ? 520 : 420);
        backdrop.style.setProperty('--vp-modal-width', `${width}px`);

        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title"></div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body"></div>`;
        card.querySelector('.vp-shell-modal-title').textContent = `${settings.icon || panelDef.icon || '⚙'} ${settings.title || panelDef.title + ' Settings'}`;
        const head = card.querySelector('.vp-shell-modal-head');
        const body = card.querySelector('.vp-shell-modal-body');

        backdrop.appendChild(card);
        host.appendChild(backdrop);

        const close = () => closeShellModals();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        setTimeout(() => document.addEventListener('keydown', _modalEscHandler, true), 0);

        // Make modal draggable via its header
        let isDragging = false;
        let startX, startY, startLeft, startTop;
        
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.vp-shell-modal-close')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = card.getBoundingClientRect();
            
            // To make dragging robust, we switch from flex/margin alignment
            // to absolute positioning when dragging starts, if it's not already.
            const backdropRect = backdrop.getBoundingClientRect();
            startLeft = rect.left - backdropRect.left;
            startTop = rect.top - backdropRect.top;
            
            card.style.margin = '0';
            card.style.position = 'absolute';
            card.style.left = `${startLeft}px`;
            card.style.top = `${startTop}px`;
            
            e.preventDefault(); // prevent text selection

            const onMouseMove = (ev) => {
                if (!isDragging) return;
                const dx = ev.clientX - startX;
                const dy = ev.clientY - startY;
                card.style.left = `${startLeft + dx}px`;
                card.style.top = `${startTop + dy}px`;
            };
            const onMouseUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        try {
            const ctx = { ...(panelCtx || {}), shell: Shell, areaEl, panelDef, close, global };
            if (typeof settings.create === 'function') settings.create(body, ctx);
            else body.textContent = 'Settings renderer is not available.';
        } catch (err) {
            console.error(`[VP Shell] Settings modal failed: ${panelDef.id}`, err);
            body.textContent = err.message || String(err);
        }
    }

    function getPanelContext(areaId, panelId) {
        const leafNode = areaId ? findLeaf(getCurrentLayout(), areaId) : null;
        const areaEl = areaId ? document.querySelector(`.vp-shell-area[data-area-id="${areaId}"]`) : null;
        return makePanelCtx(leafNode, panelId || leafNode?.panel, areaEl);
    }

    function showPanelSettings(areaEl, panelId) {
        const panelDef = VP.getPanel(panelId);
        if (!panelDef?.settings) return;

        // Settings button acts as a switch: if this area's settings modal is
        // already open, close it instead of rebuilding it.
        const areaId = areaEl?.dataset?.areaId || '';
        const existing = Array.from(document.querySelectorAll('.vp-shell-modal-backdrop'))
            .find(el => el.dataset.panelId === panelId && (!areaId || el.dataset.areaId === areaId));
        if (existing) { closeShellModals(); return; }

        const settings = panelDef.settings;
        const mode = settings.mode || 'auto';
        const areaBody = areaEl.querySelector('.vp-shell-area-body');
        const rect = areaBody.getBoundingClientRect();
        const minW = settings.minWidth || 360;
        const minH = settings.minHeight || 260;
        const useGlobal = mode === 'global' || (mode !== 'local' && (rect.width < minW || rect.height < minH));
        const leafNode = areaId ? findLeaf(getCurrentLayout(), areaId) : null;
        const panelCtx = makePanelCtx(leafNode, panelId, areaEl);
        createSettingsModal(useGlobal ? document.body : areaBody, panelDef, areaEl, useGlobal, panelCtx);
    }

    function renderNode(node, parentEl, isRoot = false) {
        if (node.type === 'split') {
            const wrap = document.createElement('div');
            wrap.className = `vp-shell-node vp-shell-split ${node.direction}`;
            const aWrap = document.createElement('div');
            const bWrap = document.createElement('div');
            aWrap.className = 'vp-shell-pane-wrap';
            bWrap.className = 'vp-shell-pane-wrap';
            const ratioPct = Math.max(8, Math.min(92, (node.ratio || 0.5) * 100));
            aWrap.style.flex = `0 0 calc(${ratioPct}% - 2.5px)`;
            bWrap.style.flex = `0 0 calc(${100 - ratioPct}% - 2.5px)`;
            const gutter = document.createElement('div');
            gutter.className = 'vp-shell-gutter';
            gutter.title = 'Drag to resize · Double-click to reset 50/50';
            gutter.addEventListener('dblclick', (e) => {
                e.preventDefault();
                e.stopPropagation();
                aWrap.style.flex = '0 0 calc(50% - 2.5px)';
                bWrap.style.flex = '0 0 calc(50% - 2.5px)';
                try { node.ratio = 0.5; } catch {}
                try {
                    const current = getCurrentLayout();
                    S.shell.layouts[S.shell.activeWorkspace] = setSplitRatio(current, node.id, 0.5);
                } catch {}
                saveShellState();
            });
            gutter.addEventListener('pointerdown', (e) => {
                e.preventDefault();
                gutter.classList.add('dragging');
                document.body.classList.add('vp-shell-resizing');
                const capturePointerId = e.pointerId;
                gutter.setPointerCapture?.(capturePointerId);
                const rect = wrap.getBoundingClientRect();
                let rafId = null;
                let lastEv = null;
                let pendingRatio = node.ratio || 0.5;

                // Отложенное применение через rAF — ограничиваем до 60fps, убираем thrashing
                const applyRatio = () => {
                    rafId = null;
                    if (!lastEv) return;
                    const raw = node.direction === 'row'
                        ? (lastEv.clientX - rect.left) / rect.width
                        : (lastEv.clientY - rect.top) / rect.height;
                    const next = Math.max(0.10, Math.min(0.90, raw));
                    // Дедупликация — не трогаем DOM если изменение мизерное
                    if (Math.abs(next - pendingRatio) < 0.001) return;
                    pendingRatio = next;
                    const pct = next * 100;
                    // Live-preview: только визуальное обновление flex, без записи на диск и без клонирования дерева
                    aWrap.style.flex = `0 0 calc(${pct}% - 2.5px)`;
                    bWrap.style.flex = `0 0 calc(${100 - pct}% - 2.5px)`;
                    // Прямая мутация ratio в текущем объекте для консистентности, без тяжелого setSplitRatio
                    try { node.ratio = next; } catch {}
                };

                const onMove = (ev) => {
                    lastEv = ev;
                    if (rafId !== null) return;
                    rafId = requestAnimationFrame(applyRatio);
                };

                const onUp = () => {
                    if (rafId !== null) {
                        cancelAnimationFrame(rafId);
                        rafId = null;
                        // Применяем последний pending кадр синхронно, если rAF еще не успел
                        if (lastEv) {
                            const raw = node.direction === 'row'
                                ? (lastEv.clientX - rect.left) / rect.width
                                : (lastEv.clientY - rect.top) / rect.height;
                            const finalRatio = Math.max(0.10, Math.min(0.90, raw));
                            pendingRatio = finalRatio;
                            const pct = finalRatio * 100;
                            aWrap.style.flex = `0 0 calc(${pct}% - 2.5px)`;
                            bWrap.style.flex = `0 0 calc(${100 - pct}% - 2.5px)`;
                        }
                    }
                    // Финальное сохранение: один раз на mouseup, бережно к диску
                    // Обновляем layout через setSplitRatio (клонирование дерева только один раз) и сохраняем на диск
                    try {
                        const current = getCurrentLayout();
                        const updated = setSplitRatio(current, node.id, pendingRatio);
                        S.shell.layouts[S.shell.activeWorkspace] = updated;
                    } catch {}
                    saveShellState();

                    gutter.classList.remove('dragging');
                    document.body.classList.remove('vp-shell-resizing');
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                };

                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
                document.addEventListener('pointercancel', onUp);
            });
            // Safety net: if the pointer capture is lost (Alt+Tab, etc.),
            // make sure we don't leave the body in a frozen state.
            gutter.addEventListener('lostpointercapture', () => {
                if (gutter.classList.contains('dragging')) {
                    gutter.classList.remove('dragging');
                    document.body.classList.remove('vp-shell-resizing');
                    try { gutter.releasePointerCapture?.(capturePointerId); } catch {}
                    document.removeEventListener('pointermove', onMove);
                    document.removeEventListener('pointerup', onUp);
                    document.removeEventListener('pointercancel', onUp);
                    try { saveShellState(); } catch {}
                }
            });
            renderNode(node.a, aWrap);
            renderNode(node.b, bWrap);
            wrap.appendChild(aWrap); wrap.appendChild(gutter); wrap.appendChild(bWrap);
            parentEl.appendChild(wrap);
            return;
        }

        const area = document.createElement('div');
        area.className = 'vp-shell-area';
        area.dataset.areaId = node.id;
        area.innerHTML = `
            <div class="vp-shell-area-header" draggable="true">
                <select class="vp-shell-panel-select" title="Switch panel"></select>
                <div class="vp-shell-header-slot-wrap">
                    <div class="vp-shell-header-slot"></div>
                </div>
                <div class="vp-shell-area-right">
                    <button class="vp-shell-area-btn vp-shell-area-restore" type="button" data-act="restore" title="Restore layout (Esc / Ctrl+Space)">❐</button>
                    <button class="vp-shell-area-btn vp-shell-area-menu-btn" type="button" data-act="area-menu" title="Panel actions (Right-click header)" aria-haspopup="menu" aria-expanded="false">⋮</button>
                </div>
            </div>
            <div class="vp-shell-area-body"><div class="vp-shell-panel-host"></div></div>`;

        const header = area.querySelector('.vp-shell-area-header');
        const select = area.querySelector('.vp-shell-panel-select');
        const panels = VP.getPanels();
        for (const p of panels) {
            const opt = document.createElement('option');
            opt.value = p.id;
            opt.textContent = `${p.icon || '□'} ${p.title || p.id}`;
            select.appendChild(opt);
        }
        if (!VP.getPanel(node.panel) && panels[0]) node.panel = panels[0].id;
        select.value = node.panel;

        const slot = area.querySelector('.vp-shell-header-slot');
        ensureShellGestureListeners();

        select.addEventListener('change', () => {
            closeAreaMenu();
            const current = getCurrentLayout();
            const found = findLeaf(current, node.id);
            if (found) replaceAreaPanelLocally(area, found, select.value);
        });
        area.querySelector('[data-act="restore"]').addEventListener('click', () => {
            closeAreaMenu();
            toggleAreaMaximize(area, select.value, false);
        });
        const menuBtn = area.querySelector('[data-act="area-menu"]');
        menuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAreaMenu(menuBtn, area, node, isRoot, panels);
        });

        // Right-click on panel header opens the area actions menu at cursor
        header.addEventListener('contextmenu', (e) => {
            if (e.target.closest('input, textarea')) return;
            e.preventDefault();
            e.stopPropagation();
            openAreaMenu(menuBtn, area, node, isRoot, panels, { x: e.clientX, y: e.clientY });
        });

        // Double-click on empty header space toggles Maximize / Restore
        header.addEventListener('dblclick', (e) => {
            if (e.target.closest('button, select, input, textarea, [data-remove]')) return;
            e.preventDefault();
            closeAreaMenu();
            toggleAreaMaximize(area, select.value);
        });

        // Drag-and-drop header onto another panel to swap them
        header.addEventListener('dragstart', (e) => {
            if (area.classList.contains('maximized') || e.target.closest('button, select, input, textarea, [data-remove]')) {
                e.preventDefault();
                return;
            }
            closeAreaMenu();
            _draggedAreaId = node.id;
            area.classList.add('is-dragging-area');
            try {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/vp-area-id', node.id);
            } catch {}
        });
        header.addEventListener('dragend', () => {
            _draggedAreaId = null;
            document.querySelectorAll('#vp-shell-root .vp-shell-area.is-dragging-area, #vp-shell-root .vp-shell-area.is-drop-target')
                .forEach(el => el.classList.remove('is-dragging-area', 'is-drop-target'));
        });
        area.addEventListener('dragover', (e) => {
            if (!_draggedAreaId || _draggedAreaId === node.id || area.classList.contains('maximized')) return;
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch {}
            area.classList.add('is-drop-target');
        });
        area.addEventListener('dragleave', (e) => {
            if (!area.contains(e.relatedTarget)) area.classList.remove('is-drop-target');
        });
        area.addEventListener('drop', (e) => {
            if (!_draggedAreaId || _draggedAreaId === node.id || area.classList.contains('maximized')) return;
            e.preventDefault();
            e.stopPropagation();
            const srcId = _draggedAreaId;
            _draggedAreaId = null;
            document.querySelectorAll('#vp-shell-root .vp-shell-area.is-dragging-area, #vp-shell-root .vp-shell-area.is-drop-target')
                .forEach(el => el.classList.remove('is-dragging-area', 'is-drop-target'));
            swapAreasInLayout(srcId, node.id);
        });

        parentEl.appendChild(area);
        attachHeaderSlot(slot);
        fitPanelSelectWidth(select, area);
        requestAnimationFrame(() => fitPanelSelectWidth(select, area));

        const host = area.querySelector('.vp-shell-panel-host');
        const panelDef = VP.getPanel(node.panel);
        if (panelDef) {
            if (SINGLETON_PANELS.has(panelDef.id) && _renderedSingletonPanels.has(panelDef.id)) {
                makePlaceholder(
                    host,
                    `${panelDef.icon || '□'} ${panelDef.title || panelDef.id}`,
                    'This panel is already open in another workspace area. Select another module here, or close/replace the other area first.'
                );
            } else {
                if (SINGLETON_PANELS.has(panelDef.id)) _renderedSingletonPanels.add(panelDef.id);
                try { panelDef.create(host, makePanelCtx(node, node.panel, area)); }
                catch (err) { console.error(`[VP Shell] Panel failed: ${node.panel}`, err); makePlaceholder(host, 'Panel error', err.message); }
            }
        } else {
            makePlaceholder(host, 'Unavailable panel', `Panel module is not loaded: ${node.panel}`);
        }
    }

    function replaceAreaPanelLocally(areaEl, node, newPanelId) {
        closeAreaMenu();
        const oldPanelId = node.panel;
        node.panel = newPanelId;
        saveShellState();

        // If either panel is a Singleton (like Stage/Asset Studio), safely do a full re-render
        // to handle complex constraints (floating projector, conflict placeholders).
        if (SINGLETON_PANELS.has(oldPanelId) || SINGLETON_PANELS.has(newPanelId)) {
            renderShell();
            return;
        }

        // Localized surgical DOM swap for standard panels!
        const host = areaEl.querySelector('.vp-shell-panel-host');
        if (!host) { renderShell(); return; }

        clearHeaderSlotEl(areaEl.querySelector('.vp-shell-header-slot'));
        host.innerHTML = '';
        
        // Sync UI header
        const select = areaEl.querySelector('.vp-shell-panel-select');
        if (select) {
            if (select.value !== newPanelId) select.value = newPanelId;
            fitPanelSelectWidth(select, areaEl);
        }
        const panelDef = VP.getPanel(newPanelId);

        // Mount new panel
        if (panelDef) {
            try { panelDef.create(host, makePanelCtx(node, newPanelId, areaEl)); }
            catch (err) { console.error(`[VP Shell] Panel failed: ${newPanelId}`, err); makePlaceholder(host, 'Panel error', err.message); }
        } else {
            makePlaceholder(host, 'Unavailable panel', `Panel module is not loaded: ${newPanelId}`);
        }
    }

    function renderShell() {
        const root = document.getElementById('vp-shell-root');
        if (!root) return;
        closeAreaMenu();
        restoreStageHeaderToProjector();
        _hoveredAreaEl = null;
        _focusedAreaEl = null;
        _draggedAreaId = null;
        _slotObservers.forEach(ro => { try { ro.disconnect(); } catch {} });
        _slotObservers.clear();
        renderWorkspaceTabs(root);
        renderWorldControls(root);
        const canvas = root.querySelector('.vp-shell-canvas');
        canvas.innerHTML = '';
        _renderedSingletonPanels = new Set();
        renderNode(getCurrentLayout(), canvas, true);
        // If the current workspace has no Stage area, keep the projector usable
        // as a floating window immediately (no page refresh required).
        if (!_renderedSingletonPanels.has('stage')) undockProjectorToFloating();
    }

    function resetWorkspace() {
        const id = S.shell.activeWorkspace;
        if (PRESETS[id]) S.shell.layouts[id] = clone(PRESETS[id].layout);
        else S.shell.layouts[id] = clone(PRESETS.director.layout);
        saveShellState();
        renderShell();
    }

    async function saveWorkspaceAs() {
        const name = await VP.showPrompt?.({
            title: 'Save workspace as',
            message: 'Название рабочего пространства:',
            value: 'Custom Workspace',
            placeholder: 'Workspace name',
            confirmLabel: 'Save',
            required: true,
        });
        if (name === null || name === undefined) return;
        const trimmed = name.trim();
        if (!trimmed) return;
        const id = 'custom_' + Date.now().toString(36);
        S.shell.customWorkspaces[id] = { title: trimmed, icon: '⭐', builtin: false };
        S.shell.layouts[id] = clone(getCurrentLayout());
        S.shell.activeWorkspace = id;
        saveShellState();
        renderShell();
    }

    async function renameCurrentWorkspace() {
        const id = S.shell.activeWorkspace;
        if (PRESETS[id]) {
            VP.showToast?.('Built-in workspaces cannot be renamed — save a custom copy first', 'info');
            return;
        }
        const def = S.shell.customWorkspaces?.[id];
        if (!def) {
            VP.showToast?.('This workspace cannot be renamed', 'error');
            return;
        }
        const current = def.title || id;
        const next = await VP.showPrompt?.({
            title: 'Rename workspace',
            message: 'Новое название workspace:',
            value: current,
            placeholder: 'Workspace name',
            confirmLabel: 'Save',
            required: true,
        });
        if (next === null || next === undefined) return;
        const trimmed = next.trim();
        if (!trimmed || trimmed === current) return;
        def.title = trimmed;
        saveShellState();
        renderShell();
        VP.showToast?.(`Workspace renamed: ${trimmed}`, 'success');
    }

    async function deleteCurrentWorkspace() {
        const id = S.shell.activeWorkspace;
        if (PRESETS[id]) {
            VP.showToast?.('Built-in workspaces cannot be deleted — use Reset instead', 'info');
            return;
        }
        const def = S.shell.customWorkspaces?.[id];
        if (!def) {
            VP.showToast?.('This workspace cannot be deleted', 'error');
            return;
        }
        const title = def.title || id;
        const ans = await VP.showConfirm?.({
            title: 'Delete workspace?',
            message: `Удалить workspace «${title}»?`,
            buttons: [
                { id: 'cancel', label: 'Cancel', ghost: true },
                { id: 'ok', label: 'Delete', danger: true },
            ],
        });
        if (ans !== 'ok') return;
        delete S.shell.customWorkspaces[id];
        delete S.shell.layouts[id];
        S.shell.activeWorkspace = 'director';
        if (!S.shell.layouts.director) S.shell.layouts.director = clone(PRESETS.director.layout);
        saveShellState();
        renderShell();
        VP.showToast?.(`Workspace deleted: ${title}`, 'success');
    }



    async function renderWorldControls(root = document.getElementById('vp-shell-root')) {
        if (!root) return;
        const select = root.querySelector('#vp-world-select');
        const label = root.querySelector('#vp-world-label');
        if (!select || !DB?.listWorlds) {
            if (label) label.textContent = 'Worlds unavailable';
            return;
        }
        try {
            const worlds = await DB.listWorlds();
            const active = worlds.find(w => w.active) || worlds[0] || null;
            select.innerHTML = '';
            for (const w of worlds) {
                const opt = document.createElement('option');
                opt.value = w.id;
                opt.textContent = w.title || w.id;
                select.appendChild(opt);
            }
            if (active) {
                select.value = active.id;
                if (label) label.textContent = '🌍';
                root.removeAttribute('title');
                document.title = `Visual Projector — ${active.title || active.id}`;
            }
        } catch (err) {
            console.warn('[VP Shell] Failed to render worlds:', err);
            if (label) label.textContent = '🌍!';
        }
    }

    async function createWorldInteractive() {
        if (!DB?.createWorld || !DB?.setActiveWorld) {
            VP.showToast?.('Worlds require Neutralino filesystem storage', 'error');
            return;
        }
        const title = await VP.showPrompt?.({
            title: 'New world',
            message: 'Название нового мира:',
            value: 'New World',
            placeholder: 'World title',
            confirmLabel: 'Create',
            required: true,
        });
        if (title === null || title === undefined) return;
        const trimmed = title.trim();
        if (!trimmed) return;
        try {
            const world = await DB.createWorld({ title: trimmed });
            await DB.setActiveWorld(world.id);
            VP.showToast?.(`World created: ${world.title}`, 'success');
            setTimeout(() => location.reload(), 250);
        } catch (err) {
            console.error('[VP Shell] create world failed:', err);
            VP.showToast?.(`World create failed: ${err.message || err}`, 'error');
        }
    }

    async function switchWorldInteractive(worldId) {
        if (!worldId || !DB?.setActiveWorld) return;
        try {
            const current = await DB.getActiveWorld?.();
            if (current?.id === worldId) return;
            await DB.setActiveWorld(worldId);
            VP.showToast?.('Switching world...', 'info');
            setTimeout(() => location.reload(), 250);
        } catch (err) {
            console.error('[VP Shell] switch world failed:', err);
            VP.showToast?.(`World switch failed: ${err.message || err}`, 'error');
        }
    }

    async function openCurrentWorldFolder() {
        try {
            if (DB?.openWorldFolder) await DB.openWorldFolder();
            else if (DB?.openDataFolder) await DB.openDataFolder();
            else VP.showToast?.('Open folder requires Neutralino filesystem storage', 'info');
        } catch (err) {
            VP.showToast?.(`Open world folder failed: ${err.message || err}`, 'error');
        }
    }



    function showWorldManager() {
        if (!DB?.listWorlds) {
            VP.showToast?.('World Manager requires Neutralino filesystem storage', 'error');
            return;
        }
        closeShellModals();
        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop global';
        backdrop.style.setProperty('--vp-modal-width', '720px');
        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">🌍 World Manager</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-world-manager">
                    <div class="vp-world-manager-toolbar">
                        <button class="vp-btn" data-act="new">＋ New World</button>
                        <button class="vp-btn vp-btn-ghost" data-act="import">📥 Import .vpworld</button>
                        <button class="vp-btn vp-btn-ghost" data-act="backup-current">💾 Backup Current</button>
                        <button class="vp-btn vp-btn-ghost" data-act="open-backups">📂 Backups</button>
                        <button class="vp-btn vp-btn-ghost" data-act="refresh">Refresh</button>
                        <span class="vp-world-manager-hint">World = isolated folder with its own chats, gallery, profiles, layouts and style. Backup/export creates <code>.vpworld</code>.</span>
                    </div>
                    <div class="vp-world-manager-list"></div>
                </div>
            </div>`;
        backdrop.appendChild(card);
        document.body.appendChild(backdrop);

        const close = () => closeShellModals();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        setTimeout(() => document.addEventListener('keydown', _modalEscHandler, true), 0);

        const list = card.querySelector('.vp-world-manager-list');
        const renderList = async () => {
            list.innerHTML = `<div class="vp-world-manager-empty">Loading worlds...</div>`;
            let worlds = [];
            try { worlds = await DB.listWorlds(); }
            catch (err) {
                list.innerHTML = `<div class="vp-world-manager-empty">Failed to load worlds: ${err.message || err}</div>`;
                return;
            }
            if (!worlds.length) {
                list.innerHTML = `<div class="vp-world-manager-empty">No worlds found.</div>`;
                return;
            }
            list.innerHTML = '';
            for (const w of worlds) {
                const row = document.createElement('div');
                row.className = 'vp-world-row' + (w.active ? ' active' : '');
                row.innerHTML = `
                    <div class="vp-world-row-main">
                        <div class="vp-world-row-title">${w.active ? '● ' : ''}${w.title || w.id}</div>
                        <div class="vp-world-row-sub"><code>${w.id}</code>${w.description ? ' · ' + w.description : ''}</div>
                    </div>
                    <div class="vp-world-row-actions">
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="open">${w.active ? 'Active' : 'Open'}</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="rename">Rename</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="duplicate">Duplicate</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="export">Export</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="folder">📂</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="delete">Delete</button>
                    </div>`;
                const openBtn = row.querySelector('[data-act="open"]');
                openBtn.disabled = !!w.active;
                openBtn.addEventListener('click', () => switchWorldInteractive(w.id));
                row.querySelector('[data-act="rename"]').addEventListener('click', async () => {
                    const next = await VP.showPrompt?.({
                        title: 'Rename world',
                        message: 'Новое название мира:',
                        value: w.title || w.id,
                        placeholder: 'World title',
                        confirmLabel: 'Save',
                        required: true,
                    });
                    if (next === null || next === undefined) return;
                    const trimmed = next.trim();
                    if (!trimmed) return;
                    try {
                        await DB.renameWorld?.(w.id, trimmed);
                        await renderWorldControls();
                        await renderList();
                        VP.showToast?.('World renamed', 'success');
                    } catch (err) { VP.showToast?.(`Rename failed: ${err.message || err}`, 'error'); }
                });
                row.querySelector('[data-act="duplicate"]').addEventListener('click', async () => {
                    const title = await VP.showPrompt?.({
                        title: 'Duplicate world',
                        message: 'Название копии мира:',
                        value: `${w.title || w.id} Copy`,
                        placeholder: 'World copy title',
                        confirmLabel: 'Duplicate',
                        required: true,
                    });
                    if (title === null || title === undefined) return;
                    const trimmed = title.trim();
                    if (!trimmed) return;
                    try {
                        const copy = await DB.duplicateWorld?.(w.id, trimmed);
                        await renderWorldControls();
                        await renderList();
                        VP.showToast?.(`World duplicated: ${copy.title}`, 'success');
                    } catch (err) { VP.showToast?.(`Duplicate failed: ${err.message || err}`, 'error'); }
                });
                row.querySelector('[data-act="export"]').addEventListener('click', async () => {
                    try {
                        const res = await DB.exportWorld?.(w.id);
                        if (res) VP.showToast?.(`Exported .vpworld (${Math.round((res.bytes || 0) / 1024)} KB)`, 'success');
                    } catch (err) { VP.showToast?.(`Export failed: ${err.message || err}`, 'error'); }
                });
                row.querySelector('[data-act="folder"]').addEventListener('click', async () => {
                    try { await DB.openWorldFolder?.(w.id); }
                    catch (err) { VP.showToast?.(`Open folder failed: ${err.message || err}`, 'error'); }
                });
                const delBtn = row.querySelector('[data-act="delete"]');
                if (w.id === 'default') {
                    delBtn.disabled = true;
                    delBtn.title = 'Default world is protected';
                }
                delBtn.addEventListener('click', async () => {
                    const ans = await VP.showConfirm?.({
                        title: 'Delete world?',
                        message: `Удалить мир «${w.title || w.id}»?\n\nПапка мира будет удалена. Это действие нельзя отменить.`,
                        buttons: [
                            { id: 'cancel', label: 'Cancel', ghost: true },
                            { id: 'ok', label: 'Delete', danger: true },
                        ],
                    });
                    if (ans !== 'ok') return;
                    try {
                        const wasActive = !!w.active;
                        await DB.deleteWorld?.(w.id);
                        VP.showToast?.('World deleted', 'success');
                        if (wasActive) { setTimeout(() => location.reload(), 250); return; }
                        await renderWorldControls();
                        await renderList();
                    } catch (err) { VP.showToast?.(`Delete failed: ${err.message || err}`, 'error'); }
                });
                list.appendChild(row);
            }
        };

        card.querySelector('[data-act="new"]').addEventListener('click', createWorldInteractive);
        card.querySelector('[data-act="import"]').addEventListener('click', async () => {
            try {
                const res = await DB.importWorldFromFile?.();
                if (!res) return;
                VP.showToast?.(`Imported world: ${res.world.title || res.world.id}`, 'success');
                await DB.setActiveWorld?.(res.world.id);
                setTimeout(() => location.reload(), 350);
            } catch (err) { VP.showToast?.(`Import failed: ${err.message || err}`, 'error'); }
        });
        card.querySelector('[data-act="backup-current"]').addEventListener('click', async () => {
            try {
                const res = await DB.backupWorld?.();
                if (res) VP.showToast?.(`Backup saved: ${res.path}`, 'success');
            } catch (err) { VP.showToast?.(`Backup failed: ${err.message || err}`, 'error'); }
        });
        card.querySelector('[data-act="open-backups"]').addEventListener('click', async () => {
            try { await DB.openBackupsFolder?.(); }
            catch (err) { VP.showToast?.(`Open backups failed: ${err.message || err}`, 'error'); }
        });
        card.querySelector('[data-act="refresh"]').addEventListener('click', renderList);
        renderList();
    }

    function getSavedProjectorGeom() {
        if (S.ui?.projectorFloatingGeom) return S.ui.projectorFloatingGeom;
        try {
            const g = JSON.parse(localStorage.getItem('vp-state') || 'null');
            if (g && Number.isFinite(+g.left) && Number.isFinite(+g.top)) return g;
        } catch {}
        return null;
    }

    function positionFloatingProjector(vp) {
        if (!vp) return;
        const geom = getSavedProjectorGeom();
        const vw = window.innerWidth || 1200;
        const vh = window.innerHeight || 800;
        const w = Math.max(260, Math.min(geom?.width || 360, vw - 20));
        const h = Math.max(120, Math.min(geom?.height || 430, vh - 20));
        const left = Math.max(0, Math.min(geom?.left ?? 20, vw - Math.min(w, 80)));
        const top = Math.max(0, Math.min(geom?.top ?? 20, vh - 34));
        vp.style.left = `${left}px`;
        vp.style.top = `${top}px`;
        vp.style.width = `${w}px`;
        if (S.ui?.projectorCollapsed || vp.classList.contains('vp-collapsed')) vp.style.height = 'auto';
        else vp.style.height = `${h}px`;
    }

    function applyProjectorCollapsedState(vp) {
        if (!vp) return;
        const collapsed = !!(S.ui?.projectorCollapsed || vp.classList.contains('vp-collapsed'));
        const projMode = vp.querySelector('#vp-projector-mode');
        const btn = vp.querySelector('#vp-minimize');
        if (collapsed) {
            S.ui.projectorCollapsed = true;
            vp.classList.add('vp-collapsed');
            if (projMode) projMode.style.display = 'none';
            vp.style.height = 'auto';
            vp.style.overflow = 'hidden';
            if (btn) btn.textContent = '+';
        } else {
            if (projMode) projMode.style.display = '';
            vp.classList.remove('vp-collapsed');
            if (vp.classList.contains('vp-shell-docked-stage')) {
                vp.style.height = '100%';
            }
            vp.style.overflow = '';
            if (btn) btn.textContent = '−';
        }
    }

    function undockProjectorToFloating() {
        restoreStageHeaderToProjector();
        const vp = S.ui?.vpWindow;
        if (!vp) return;
        if (vp.classList.contains('vp-shell-docked-stage')) {
            // Do not capture docked 100% panel geometry as floating geometry.
        } else {
            captureFloatingProjectorGeom(vp);
        }
        if (vp.parentElement !== document.body) document.body.appendChild(vp);
        vp.classList.remove('vp-shell-docked', 'vp-shell-docked-stage');
        vp.style.display = '';
        vp.style.position = 'fixed';
        vp.style.right = 'auto';
        vp.style.bottom = 'auto';
        vp.style.maxWidth = '';
        vp.style.maxHeight = '';
        vp.style.zIndex = '10000';
        positionFloatingProjector(vp);
        applyProjectorCollapsedState(vp);
    }

    function createShellRoot() {
        document.getElementById('vp-shell-return')?.remove();
        let root = document.getElementById('vp-shell-root');
        if (root) return root;
        root = document.createElement('div');
        root.id = 'vp-shell-root';
		root.innerHTML = `
			<div class="vp-shell-topbar">
				<div class="vp-shell-brand">👁 VP Studio</div>
				<div class="vp-shell-worldbar" title="Current world">
					<span id="vp-world-label" class="vp-shell-world-label">🌍</span>
					<select id="vp-world-select" class="vp-shell-world-select" title="Current world"></select>
					<button class="vp-shell-tool-btn" id="vp-world-new" title="Create new isolated world">＋</button>
					<button class="vp-shell-tool-btn" id="vp-world-manager" title="World Manager">⋯</button>
					<button class="vp-shell-tool-btn" id="vp-world-folder" title="Open current world folder">📂</button>
				</div>
				<div class="vp-shell-workspaces" title="Workspaces"></div>
                <button class="vp-shell-llama-pill" id="vp-llama-pill" type="button" data-status="offline" title="Local LLM — click to open Model panel">
                    <span class="vp-shell-llama-dot"></span>
                    <span class="vp-shell-llama-label" data-role="label">LLM: Off</span>
                    <span class="vp-shell-llama-ctx" data-role="ctx" style="display:none"></span>
                </button>
                <button class="vp-shell-save-btn" id="vp-save-button" type="button" title="Сохранить изменения (Ctrl+S)">
                    <span class="save-dot" data-role="save-dot">✓</span>
                    <span data-role="save-label">Saved</span>
                </button>
				<div class="vp-shell-window-controls" title="Window controls">
					<button class="vp-shell-tool-btn" id="vp-win-minimize" title="Minimize">—</button>
					<button class="vp-shell-tool-btn" id="vp-win-maximize" title="Maximize">▢</button>
					<button class="vp-shell-tool-btn vp-win-close" id="vp-win-close" title="Close">×</button>
				</div>
			</div>
			<div class="vp-shell-canvas"></div>
            <div id="vp-window-resize-grip" title="Resize window" aria-label="Resize window"
                 style="position:fixed;right:0;bottom:0;width:18px;height:18px;z-index:2147483646;cursor:nwse-resize;touch-action:none">
                <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" style="display:block;pointer-events:none">
                    <path d="M17 5L5 17M17 10L10 17M17 15L15 17" stroke="rgba(166,173,200,.62)" stroke-width="1.5"/>
                </svg>
            </div>`;
        document.body.appendChild(root);
        root.querySelector('#vp-world-select')?.addEventListener('change', (e) => switchWorldInteractive(e.target.value));
        root.querySelector('#vp-world-new')?.addEventListener('click', createWorldInteractive);
        root.querySelector('#vp-world-manager')?.addEventListener('click', showWorldManager);
        root.querySelector('#vp-world-folder')?.addEventListener('click', openCurrentWorldFolder);

        const saveButton = root.querySelector('#vp-save-button');
        const saveDot = root.querySelector('[data-role="save-dot"]');
        const saveLabel = root.querySelector('[data-role="save-label"]');
        const paintSaveState = (dirty = !!DB?.isDirty?.()) => {
            if (!saveButton) return;
            const count = dirty ? (Number(DB?.getDirtyCount?.()) || 0) : 0;
            saveButton.classList.toggle('is-dirty', !!dirty);
            if (saveDot) saveDot.textContent = dirty ? '●' : '✓';
            if (saveLabel) saveLabel.textContent = dirty ? (count > 0 ? `Save (${count})` : 'Save') : 'Saved';
            saveButton.title = dirty
                ? `Несохранённых изменений: ${count || 1}. Нажмите или Ctrl+S для сохранения`
                : 'Все изменения сохранены (Ctrl+S)';
        };
        saveButton?.addEventListener('click', async () => {
            if (!DB?.saveChanges) return;
            saveButton.disabled = true;
            if (saveDot) saveDot.textContent = '⏳';
            if (saveLabel) saveLabel.textContent = 'Saving…';
            try {
                await DB.saveChanges();
                paintSaveState(false);
                VP.showToast?.('Изменения сохранены', 'success');
            } catch (err) {
                paintSaveState(true);
                VP.showToast?.(`Ошибка сохранения: ${err.message || err}`, 'error');
            } finally { saveButton.disabled = false; }
        });
        window.addEventListener('vp-storage-dirty-changed', (event) => paintSaveState(!!event.detail?.dirty));
        paintSaveState();

        // Compact Local LLM indicator pill in topbar
        const llamaPill = root.querySelector('#vp-llama-pill');
        if (llamaPill) {
            const labelEl = llamaPill.querySelector('[data-role="label"]');
            const ctxEl = llamaPill.querySelector('[data-role="ctx"]');
            const fmtTok = (n) => window.VP_LLAMA?.formatCompactTokens?.(n) ?? String(n);
            const getActiveChatLastUsage = () => {
                const msgs = window.VisualProjector?.chats?.getActiveChatMessages?.()
                    || S.session?.messages || [];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i]?.usage) return msgs[i].usage;
                }
                return window.VP_LLAMA?.getState?.()?.lastUsage || null;
            };
            const paintLlamaPill = (snap = window.VP_LLAMA?.getState?.()) => {
                if (!snap) return;
                llamaPill.dataset.status = snap.status || 'offline';
                const activeModel = snap.loadedModelId || S.modelConfig?.model || '';
                let text = 'LLM: Off';
                if (snap.status === 'starting') text = 'LLM: старт…';
                else if (snap.status === 'stopping') text = 'LLM: стоп…';
                else if (snap.status === 'loading') text = activeModel ? `⏳ ${activeModel}` : 'LLM: загрузка…';
                else if (snap.status === 'error') text = 'LLM: ошибка';
                else if (snap.status === 'ready') text = activeModel || 'LLM: Ready';
                if (labelEl) labelEl.textContent = text;

                const maxCtx = snap.activeCtx || 0;
                const usage = getActiveChatLastUsage();
                const used = usage
                    ? ((Number(usage.prompt_tokens ?? usage.promptTokens) || 0) + (Number(usage.completion_tokens ?? usage.completionTokens) || 0) || Number(usage.used ?? usage.total_tokens) || 0)
                    : 0;

                if (ctxEl) {
                    ctxEl.classList.remove('warn', 'danger');
                    if (snap.status === 'ready' && maxCtx > 0) {
                        ctxEl.style.display = '';
                        if (used > 0) {
                            const pct = Math.round((used / maxCtx) * 100);
                            ctxEl.textContent = `${fmtTok(used)}/${fmtTok(maxCtx)}`;
                            if (pct >= 92) ctxEl.classList.add('danger');
                            else if (pct >= 80) ctxEl.classList.add('warn');
                        } else {
                            ctxEl.textContent = `${fmtTok(maxCtx)} ctx`;
                        }
                    } else {
                        ctxEl.style.display = 'none';
                        ctxEl.textContent = '';
                    }
                }

                const tipLines = [`Local LLM: ${snap.status}${snap.managed ? ' (managed)' : (snap.status === 'ready' ? ' (external)' : '')}`];
                if (activeModel) tipLines.push(`Model: ${activeModel}`);
                if (maxCtx > 0) {
                    const pctStr = used > 0 ? ` (${Math.round((used / maxCtx) * 100)}%)` : '';
                    tipLines.push(`Context: ${used ? `${used} / ` : ''}${maxCtx} tok${pctStr}`);
                }
                if (usage?.tps) tipLines.push(`Speed: ${usage.tps} tok/s`);
                if (snap.lastError) tipLines.push(`Error: ${snap.lastError}`);
                tipLines.push('Click to open Model panel');
                llamaPill.title = tipLines.join('\n');
            };
            llamaPill.addEventListener('click', () => {
                const areas = Array.from(root.querySelectorAll('.vp-shell-area'));
                let modelArea = areas.find(a => a.querySelector('.vp-shell-panel-select')?.value === 'model');
                if (!modelArea) {
                    const candidate = areas.find(a => !['stage', 'gallery', 'input'].includes(a.querySelector('.vp-shell-panel-select')?.value || ''))
                        || areas[areas.length - 1];
                    const sel = candidate?.querySelector('.vp-shell-panel-select');
                    if (sel) {
                        sel.value = 'model';
                        sel.dispatchEvent(new Event('change', { bubbles: true }));
                        modelArea = candidate;
                    }
                }
                if (modelArea) {
                    const prev = modelArea.style.boxShadow;
                    modelArea.style.boxShadow = '0 0 0 2px var(--accent, #6c5fa6)';
                    setTimeout(() => { modelArea.style.boxShadow = prev; }, 900);
                }
            });
            window.VP_LLAMA?.onChange?.(paintLlamaPill);
            window.VP_HUB?.on?.('chat:active-changed', () => paintLlamaPill());
            window.VP_HUB?.on?.('chat:messages-changed', () => paintLlamaPill());
            paintLlamaPill();
        }

        renderWorldControls(root);
		// Window controls and drag region for Neutralino borderless mode.
		if (window.Neutralino?.window) {
            const brand = root.querySelector('.vp-shell-brand');
            const maxButton = root.querySelector('#vp-win-maximize');
            const resizeGrip = root.querySelector('#vp-window-resize-grip');

            // Borderless Neutralino maximize can cover the Windows taskbar.
            // Use the browser work area instead: full workspace, taskbar preserved.
            let workAreaMaximized = false;
            let restoreGeometry = null;

            const refreshMaximizeButton = () => {
                if (maxButton) {
                    maxButton.textContent = workAreaMaximized ? '❐' : '□';
                    maxButton.title = workAreaMaximized ? 'Restore window' : 'Maximize to work area';
                }
                if (resizeGrip) resizeGrip.style.display = workAreaMaximized ? 'none' : 'block';
                return workAreaMaximized;
            };

            const maximizeToWorkArea = async () => {
                restoreGeometry = {
                    position: await Neutralino.window.getPosition(),
                    size: await Neutralino.window.getSize(),
                };
                const x = Number.isFinite(screen.availLeft) ? screen.availLeft : 0;
                const y = Number.isFinite(screen.availTop) ? screen.availTop : 0;
                // One-pixel overscan removes the borderless WebView seam that can
                // appear after restore -> maximize. Bottom stays at the work-area edge,
                // so the Windows taskbar remains fully available.
                await Neutralino.window.move(x - 1, y - 1);
                await Neutralino.window.setSize({
                    width: screen.availWidth + 2,
                    height: screen.availHeight + 1,
                });
                workAreaMaximized = true;
                refreshMaximizeButton();
            };

            const restoreWorkAreaWindow = async () => {
                if (!restoreGeometry) return;
                await Neutralino.window.setSize(restoreGeometry.size);
                await Neutralino.window.move(restoreGeometry.position.x, restoreGeometry.position.y);
                workAreaMaximized = false;
                refreshMaximizeButton();
            };

            const toggleMaximize = async () => {
                try {
                    if (workAreaMaximized) await restoreWorkAreaWindow();
                    else await maximizeToWorkArea();
                } catch (err) {
                    console.warn('[VP Shell] work-area maximize toggle failed:', err);
                }
            };

            // Native-looking bottom-right resize grip for borderless windows.
            resizeGrip?.addEventListener('pointerdown', async (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                try {
                    if (workAreaMaximized) return;
                    const startSize = await Neutralino.window.getSize();
                    const startX = event.screenX;
                    const startY = event.screenY;
                    const pointerId = event.pointerId;
                    resizeGrip.setPointerCapture?.(pointerId);
                    let framePending = false;
                    let nextWidth = startSize.width;
                    let nextHeight = startSize.height;
                    const applySize = () => {
                        framePending = false;
                        Neutralino.window.setSize({ width: nextWidth, height: nextHeight }).catch(err =>
                            console.warn('[VP Shell] resize failed:', err));
                    };
                    const move = (moveEvent) => {
                        nextWidth = Math.max(900, Math.round(startSize.width + moveEvent.screenX - startX));
                        nextHeight = Math.max(600, Math.round(startSize.height + moveEvent.screenY - startY));
                        if (!framePending) {
                            framePending = true;
                            requestAnimationFrame(applySize);
                        }
                    };
                    const finish = () => {
                        resizeGrip.removeEventListener('pointermove', move);
                        resizeGrip.removeEventListener('pointerup', finish);
                        resizeGrip.removeEventListener('pointercancel', finish);
                        try { resizeGrip.releasePointerCapture?.(pointerId); } catch {}
                    };
                    resizeGrip.addEventListener('pointermove', move);
                    resizeGrip.addEventListener('pointerup', finish);
                    resizeGrip.addEventListener('pointercancel', finish);
                } catch (err) {
                    console.warn('[VP Shell] resize start failed:', err);
                }
            });

            // The logo is a safe drag handle: no workspace/world buttons are blocked.
            if (brand && Neutralino.window.setDraggableRegion) {
                Neutralino.window.setDraggableRegion(brand).catch(err =>
                    console.warn('[VP Shell] draggable region failed:', err));
                brand.title = 'Drag window · double-click to maximize/restore';
                brand.addEventListener('dblclick', (event) => {
                    event.preventDefault();
                    toggleMaximize();
                });
            }

			root.querySelector('#vp-win-minimize')?.addEventListener('click', () => Neutralino.window.minimize());
            maxButton?.addEventListener('click', toggleMaximize);
			root.querySelector('#vp-win-close')?.addEventListener('click', async () => {
                if (DB?.confirmUnsavedChanges && !(await DB.confirmUnsavedChanges('exit'))) return;
                if (window.VP_LLAMA?.shutdown) {
                    try { await window.VP_LLAMA.shutdown(); } catch {}
                }
                await Neutralino.app.exit();
            });
            // Convert a config-started native maximize into taskbar-safe work-area maximize.
            (async () => {
                try {
                    if (await Neutralino.window.isMaximized()) {
                        await Neutralino.window.unmaximize();
                        await new Promise(resolve => setTimeout(resolve, 100));
                        await maximizeToWorkArea();
                    } else refreshMaximizeButton();
                } catch (err) {
                    console.warn('[VP Shell] initial work-area maximize failed:', err);
                    refreshMaximizeButton();
                }
            })();
		} else {
			// Hide controls if not running in Neutralino
			const controls = root.querySelector('.vp-shell-window-controls');
			if (controls) controls.style.display = 'none';
		}		
        return root;
    }

    function getShellSnapshot() {
        const defs = getWorkspaceDefs();
        return {
            activeWorkspace: S.shell?.activeWorkspace || null,
            workspaces: Object.entries(defs).map(([id, def]) => ({
                id,
                title: def.title || id,
                icon: def.icon || null,
                builtin: !!def.builtin,
            })),
            panels: VP.getPanels().map(panel => ({
                id: panel.id,
                title: panel.title || panel.id,
                icon: panel.icon || null,
                order: panel.order || 100,
                hasSettings: !!panel.settings,
            })),
            layout: clone(getCurrentLayout()),
        };
    }

    function switchWorkspaceById(workspaceId) {
        const id = String(workspaceId || '').trim();
        if (!id) throw new Error('shell:switch-workspace requires payload.id');
        const defs = getWorkspaceDefs();
        if (!defs[id]) throw new Error(`Unknown workspace: ${id}`);
        const previous = S.shell.activeWorkspace;
        S.shell.activeWorkspace = id;
        if (!S.shell.layouts[id]) S.shell.layouts[id] = clone(PRESETS.director.layout);
        saveShellState();
        renderShell();
        const snapshot = getShellSnapshot();
        window.VP_HUB?.emit?.('shell:workspace-changed', {
            previous,
            current: id,
            workspace: snapshot.workspaces.find(w => w.id === id) || null,
        }, { moduleId: 'shell' });
        return snapshot;
    }

    function setAreaPanelById(payload = {}) {
        const panelId = String(payload.panelId || payload.panel || '').trim();
        if (!panelId) throw new Error('shell:set-area-panel requires payload.panelId');
        if (!VP.getPanel(panelId)) throw new Error(`Unknown panel: ${panelId}`);

        const layout = getCurrentLayout();
        const areaId = String(payload.areaId || '').trim();
        const leafNode = areaId ? findLeaf(layout, areaId) : findFirstLeaf(layout);
        if (!leafNode) throw new Error(areaId ? `Unknown shell area: ${areaId}` : 'Current workspace has no panel area');

        const previousPanel = leafNode.panel;
        const areaEl = document.querySelector(`.vp-shell-area[data-area-id="${leafNode.id}"]`);
        
        if (areaEl) {
            replaceAreaPanelLocally(areaEl, leafNode, panelId);
        } else {
            leafNode.panel = panelId;
            saveShellState();
            renderShell();
        }
        
        const snapshot = getShellSnapshot();
        window.VP_HUB?.emit?.('shell:area-panel-changed', {
            areaId: leafNode.id,
            previousPanel,
            currentPanel: panelId,
            workspaceId: S.shell.activeWorkspace,
        }, { moduleId: 'shell' });
        return snapshot;
    }

    function registerShellHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'shell');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'shell', title: 'Workspace Shell', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Shell] Hub module registration failed:', err); }
        }
        if (!hasCommand('shell:get-state')) {
            hub.handle('shell:get-state', () => getShellSnapshot(), { moduleId: 'shell' });
        }
        if (!hasCommand('shell:switch-workspace')) {
            hub.handle('shell:switch-workspace', (payload = {}) => switchWorkspaceById(payload.id || payload.workspaceId), { moduleId: 'shell' });
        }
        if (!hasCommand('shell:set-area-panel')) {
            hub.handle('shell:set-area-panel', (payload = {}) => setAreaPanelById(payload), { moduleId: 'shell' });
        }
        if (!hasCommand('shell:render')) {
            hub.handle('shell:render', () => { renderShell(); return getShellSnapshot(); }, { moduleId: 'shell' });
        }
        if (!hasCommand('shell:close-modals')) {
            hub.handle('shell:close-modals', () => {
                closeShellModals();
                return { ok: true, state: getShellSnapshot() };
            }, { moduleId: 'shell' });
        }
    }

    async function bootShell() {
        if (VP.ready) await VP.ready;
        if (VP.chats?.ready) await VP.chats.ready;
        injectStyles();
        await loadShellState();
        registerBuiltInPanels();
        
        // Studio 2.0: Overlay mode is deprecated. Shell is always enabled.
        S.shell.enabled = true;
        
        createShellRoot();
        document.body.classList.add('vp-shell-active');
        renderShell();
        registerShellHubCommands();
        console.log('[VP Shell] ready — Blender-lite workspace shell mounted.');
    }

    const Shell = {
        render: renderShell,
        getSnapshot: getShellSnapshot,
        switchWorkspaceById,
        setAreaPanelById,
        resetWorkspace,
        saveWorkspaceAs,
        renameCurrentWorkspace,
        deleteCurrentWorkspace,
        undockProjectorToFloating,
        getCurrentLayout,
        setCurrentLayout,
        showPanelSettings,
        getPanelContext,
        closeShellModals,
        renderWorldControls,
        createWorldInteractive,
        switchWorldInteractive,
        openCurrentWorldFolder,
        showWorldManager,
    };

    window.VisualProjector.shell = Shell;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootShell().catch(err => console.error('[VP Shell] boot failed:', err)); });
    } else {
        setTimeout(() => { bootShell().catch(err => console.error('[VP Shell] boot failed:', err)); }, 0);
    }
})();
