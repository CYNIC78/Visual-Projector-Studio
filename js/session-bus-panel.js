// ╔══════════════════════════════════════════════════════════════════╗
// ║  session-bus-panel.js                                            ║
// ║  Visual Projector — Session satellite: COMMAND BUS DEBUG PANEL   ║
// ║  ('Commands' tab: live registry + rolling log of VPCommandBus)   ║
// ║                                                                  ║
// ║  Owns: renderBusPanel(container) — tabs Log/Registry, refresh /  ║
// ║        clear-log toolbar, one-shot style injection.              ║
// ║                                                                  ║
// ║  Extracted from projector-session.js (v11 refactor) — the block  ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent / "beautify": it must stay diff-verifiable      ║
// ║  against backups/10-focus-mode-default.zip.                      ║
// ║                                                                  ║
// ║  Load order: BEFORE projector-session.js (satellite family of    ║
// ║  the session module — host calls init(deps) at its bridge site). ║
// ║  Reads VP.commands (director-bus.js, v06) at render time.        ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP) {
        console.error(
            '[VP Session BusPanel] window.VisualProjector not found.\n' +
            'Load visual-projector.js (and js/director-bus.js) before session-bus-panel.js.'
        );
        return;
    }

    // Called ONCE by projector-session.js at its bridge site.
    // deps = { clearContainer }
    function init(deps = {}) {
        const clearContainer = deps.clearContainer;
        if (typeof clearContainer !== 'function') {
            throw new Error('[VP Session BusPanel] init: missing deps: clearContainer');
        }

    function renderBusPanel(container) {
        clearContainer(container);
        const bus = VP.commands;
        if (!bus) {
            container.innerHTML = '<div style="padding:20px;color:var(--text-secondary,#a6adc8);">Command Bus not available</div>';
            return;
        }

        const wrap = document.createElement('div');
        wrap.className = 'vp-bus-panel';

        // Styles
        if (!document.getElementById('vp-bus-panel-style')) {
            const st = document.createElement('style');
            st.id = 'vp-bus-panel-style';
            st.textContent = `
                .vp-bus-panel { height:100%; display:flex; flex-direction:column; min-height:0; font-size:12px; }
                .vp-bus-toolbar {
                    flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:6px 8px;
                    border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.025);
                }
                .vp-bus-toolbar .spacer { flex:1; }
                .vp-bus-tabs { display:flex; gap:2px; }
                .vp-bus-tab {
                    border:1px solid rgba(255,255,255,0.10); background:transparent; color:var(--text-secondary,#a6adc8);
                    border-radius:6px; padding:3px 10px; font-size:11px; cursor:pointer; font-weight:600;
                }
                .vp-bus-tab.active { background:rgba(108,95,166,0.28); border-color:rgba(108,95,166,0.50); color:var(--text-primary,#cdd6f4); }
                .vp-bus-tab:hover { background:rgba(255,255,255,0.06); }
                .vp-bus-content { flex:1; min-height:0; overflow:auto; padding:8px; }
                .vp-bus-empty { color:var(--text-secondary,#a6adc8); text-align:center; padding:20px; font-size:12px; }

                .vp-bus-log-item {
                    display:flex; align-items:flex-start; gap:6px; padding:5px 7px;
                    border-radius:6px; margin-bottom:4px; font-family:ui-monospace, SFMono-Regular, Consolas, monospace;
                    font-size:11px; line-height:1.4;
                }
                .vp-bus-log-item.status-success { background:rgba(35,92,58,0.12); }
                .vp-bus-log-item.status-failed { background:rgba(110,40,40,0.12); }
                .vp-bus-log-item.status-invalid { background:rgba(110,40,40,0.08); }
                .vp-bus-log-item.status-unknown { background:rgba(110,40,40,0.08); }
                .vp-bus-log-item.status-error { background:rgba(110,40,40,0.15); }
                .vp-bus-log-icon { flex:0 0 auto; font-size:12px; margin-top:1px; }
                .vp-bus-log-body { flex:1; min-width:0; }
                .vp-bus-log-raw { color:var(--text-primary,#cdd6f4); font-weight:600; }
                .vp-bus-log-meta { color:var(--text-secondary,#a6adc8); margin-top:1px; }
                .vp-bus-log-error { color:#e05555; margin-top:2px; }
                .vp-bus-log-time { color:var(--text-secondary,#a6adc8); font-size:10px; flex:0 0 auto; white-space:nowrap; margin-top:2px; }

                .vp-bus-registry-item {
                    display:flex; align-items:center; gap:8px; padding:6px 8px;
                    border-radius:6px; margin-bottom:4px; background:rgba(255,255,255,0.03);
                    border:1px solid rgba(255,255,255,0.06);
                }
                .vp-bus-registry-type {
                    font-family:ui-monospace, SFMono-Regular, Consolas, monospace;
                    font-weight:700; color:var(--text-primary,#cdd6f4); font-size:12px;
                    padding:2px 7px; border-radius:4px; background:rgba(108,95,166,0.18);
                }
                .vp-bus-registry-target { color:var(--text-secondary,#a6adc8); font-size:11px; }
                .vp-bus-registry-desc { color:var(--text-primary,#cdd6f4); font-size:11px; flex:1; min-width:0; }
            `;
            document.head.appendChild(st);
        }

        // Toolbar
        wrap.innerHTML = `
            <div class="vp-bus-toolbar">
                <div class="vp-bus-tabs">
                    <button class="vp-bus-tab active" data-tab="log">Log</button>
                    <button class="vp-bus-tab" data-tab="registry">Registry</button>
                </div>
                <span class="spacer"></span>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="refresh" title="Refresh">↻</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="clear" title="Clear log">Clear</button>
            </div>
            <div class="vp-bus-content" data-role="content"></div>`;

        const content = wrap.querySelector('[data-role="content"]');
        const tabs = wrap.querySelectorAll('.vp-bus-tab');
        let activeTab = 'log';

        function formatTime(ts) {
            const d = new Date(ts);
            return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        }

        function renderLog() {
            const log = bus.getLog(100);
            if (!log.length) {
                content.innerHTML = '<div class="vp-bus-empty">No commands logged yet.<br>Commands appear here when the model uses [IMG], [FX], [TAB], etc.</div>';
                return;
            }
            // Render in reverse (newest first)
            const items = [...log].reverse().map(entry => {
                const statusIcon = entry.status === 'success' ? '✓'
                    : entry.status === 'failed' ? '✗'
                    : entry.status === 'invalid' ? '⚠'
                    : entry.status === 'unknown' ? '⚠'
                    : entry.status === 'error' ? '✗'
                    : '·';
                const errorHtml = entry.error ? `<div class="vp-bus-log-error">${entry.error}</div>` : '';
                const targetHtml = entry.target ? `<span class="vp-bus-log-meta">→ ${entry.target}</span>` : '';
                const sourceHtml = entry.source && entry.source !== 'unknown' ? `<span class="vp-bus-log-meta"> from ${entry.source}</span>` : '';
                return `<div class="vp-bus-log-item status-${entry.status || 'unknown'}">
                    <span class="vp-bus-log-icon">${statusIcon}</span>
                    <div class="vp-bus-log-body">
                        <span class="vp-bus-log-raw">${entry.raw || '?'}</span> ${targetHtml}${sourceHtml}
                        ${errorHtml}
                    </div>
                    <span class="vp-bus-log-time">${formatTime(entry.time)}</span>
                </div>`;
            }).join('');
            content.innerHTML = items;
        }

        function renderRegistry() {
            const reg = bus.getRegistry();
            if (!reg.length) {
                content.innerHTML = '<div class="vp-bus-empty">No commands registered.</div>';
                return;
            }
            const items = reg.map(entry => `
                <div class="vp-bus-registry-item">
                    <span class="vp-bus-registry-type">[${entry.type}]</span>
                    <span class="vp-bus-registry-target">${entry.target}</span>
                    <span class="vp-bus-registry-desc">${entry.description || '—'}</span>
                </div>`).join('');
            content.innerHTML = items;
        }

        function renderTab() {
            if (activeTab === 'log') renderLog();
            else renderRegistry();
        }

        tabs.forEach(tab => {
            tab.addEventListener('click', () => {
                tabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                activeTab = tab.dataset.tab;
                renderTab();
            });
        });

        wrap.querySelector('[data-act="refresh"]').addEventListener('click', renderTab);
        wrap.querySelector('[data-act="clear"]').addEventListener('click', () => {
            bus.clearLog?.();
            renderTab();
        });

        renderTab();
        container.appendChild(wrap);
    }

        return { renderBusPanel };
    }

    window.VP_SESSION_BUS_PANEL = { init };
})();
