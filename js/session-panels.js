// ╔══════════════════════════════════════════════════════════════════╗
// ║  session-panels.js                                               ║
// ║  Visual Projector — Session satellite: UI RENDERERS              ║
// ║  (input · log · settings · model panels + styles + inspector)    ║
// ║                                                                  ║
// ║  Owns: injectStyles (the whole session CSS, one-shot),           ║
// ║        clearContainer, renderInputPanel (chips · tools toggle ·  ║
// ║        pending pills · send/regen/stop), renderLogPanel          ║
// ║        (bubbles · avatars · scene events · inline edit),         ║
// ║        renderInputSettings / renderLogSettings /                 ║
// ║        renderModelPanel, the context inspector                   ║
// ║        (showContextInspector + token estimators).                ║
// ║                                                                  ║
// ║  Extracted from projector-session.js (v13 refactor) — the block  ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent: must stay diff-verifiable against              ║
// ║  backups/12-extract-session-manifests.zip.                       ║
// ║                                                                  ║
// ║  Boundary notes:                                                 ║
// ║  · 28 helper deps + DEFAULT_SESSION arrive via init(deps);       ║
// ║  · v16 HOTFIX: regenerateLast + clearSession joined the deps     ║
// ║    (v13 launch bug — both stayed free identifiers inside the     ║
// ║    verbatim zone, so regen/clear buttons crashed render with     ║
// ║    ReferenceError. Caught at the first home run; the smoke now   ║
// ║    renders both panels for real, incl. message rows).            ║
// ║  · `let activeInlineMessageEditCleanup` MOVED HERE WITH the      ║
// ║    panels — all 8 of its usages were inside this zone (none      ║
// ║    elsewhere in the host), so no get/set seam was needed;        ║
// ║  · chats/profiles/games are reached only via chatApi()?.         ║
// ║    (the hub-shaped path) and VP.* facade getters at runtime.     ║
// ║                                                                  ║
// ║  Load order: BEFORE projector-session.js (satellite family of    ║
// ║  the session module — host calls init(deps) at its bridge).      ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP Session Panels] window.VisualProjector not found.\n' +
            'Load visual-projector.js before session-panels.js.'
        );
        return;
    }
    const S = VP.state;           // shared engine state (by reference)
    const DB = window.VP_DB;      // storage facade (same as the host's alias)

    // Called ONCE by projector-session.js at its bridge site.
    function init(deps = {}) {
        const buildProfileSystemMessage = deps.buildProfileSystemMessage;
        const buildRequestMessages = deps.buildRequestMessages;
        const chatApi = deps.chatApi;
        const clearSession = deps.clearSession;
        const deleteMessage = deps.deleteMessage;
        const ensureState = deps.ensureState;
        const escapeHtml = deps.escapeHtml;
        const getActiveDraft = deps.getActiveDraft;
        const getActiveMessages = deps.getActiveMessages;
        const getMessageSpeakerLabel = deps.getMessageSpeakerLabel;
        const isNearBottom = deps.isNearBottom;
        const isSceneEventMessage = deps.isSceneEventMessage;
        const msgText = deps.msgText;
        const parseSceneEvent = deps.parseSceneEvent;
        const persistModel = deps.persistModel;
        const persistSession = deps.persistSession;
        const regenerateLast = deps.regenerateLast;
        const removePendingManifestAt = deps.removePendingManifestAt;
        const renderMessageAvatar = deps.renderMessageAvatar;
        const renderRegisteredPanels = deps.renderRegisteredPanels;
        const sceneEventIcon = deps.sceneEventIcon;
        const send = deps.send;
        const setActiveDraft = deps.setActiveDraft;
        const setMessageBodyContent = deps.setMessageBodyContent;
        const showManifestsModal = deps.showManifestsModal;
        const stop = deps.stop;
        const stripVpCommands = deps.stripVpCommands;
        const updateMessage = deps.updateMessage;
        const DEFAULT_SESSION = deps.DEFAULT_SESSION;
        const missing = [
            ['buildProfileSystemMessage', buildProfileSystemMessage],
            ['buildRequestMessages', buildRequestMessages],
            ['chatApi', chatApi],
            ['clearSession', clearSession],
            ['deleteMessage', deleteMessage],
            ['ensureState', ensureState],
            ['escapeHtml', escapeHtml],
            ['getActiveDraft', getActiveDraft],
            ['getActiveMessages', getActiveMessages],
            ['getMessageSpeakerLabel', getMessageSpeakerLabel],
            ['isNearBottom', isNearBottom],
            ['isSceneEventMessage', isSceneEventMessage],
            ['msgText', msgText],
            ['parseSceneEvent', parseSceneEvent],
            ['persistModel', persistModel],
            ['persistSession', persistSession],
            ['regenerateLast', regenerateLast],
            ['removePendingManifestAt', removePendingManifestAt],
            ['renderMessageAvatar', renderMessageAvatar],
            ['renderRegisteredPanels', renderRegisteredPanels],
            ['sceneEventIcon', sceneEventIcon],
            ['send', send],
            ['setActiveDraft', setActiveDraft],
            ['setMessageBodyContent', setMessageBodyContent],
            ['showManifestsModal', showManifestsModal],
            ['stop', stop],
            ['stripVpCommands', stripVpCommands],
            ['updateMessage', updateMessage],        ].filter(([, v]) => typeof v !== 'function').map(([k]) => k);
        if (!DEFAULT_SESSION || typeof DEFAULT_SESSION !== 'object') missing.push('DEFAULT_SESSION');
        if (missing.length) {
            throw new Error('[VP Session Panels] init: missing deps: ' + missing.join(', '));
        }

        // Module state moved WITH the panels (v13): the inline message-edit
        // cleanup handle. All 8 usages live inside the zone below; the host
        // references it nowhere else.
        let activeInlineMessageEditCleanup = null;

    function injectStyles() {
        if (document.getElementById('vp-session-style')) return;
        const style = document.createElement('style');
        style.id = 'vp-session-style';
        style.textContent = `
            .vp-session-log { height:100%; display:flex; flex-direction:column; min-height:0; }
            .vp-session-log-toolbar {
                flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:6px 8px;
                border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.025);
            }
            .vp-session-log-toolbar .spacer { flex:1; }
            /* Optional gallery-asset backdrop behind the message list. */
            .vp-session-log.has-backdrop { position:relative; }
            .vp-session-log.has-backdrop::before {
                content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
                background-image:var(--vp-log-backdrop); background-size:cover; background-position:center;
            }
            .vp-session-log.has-backdrop::after {
                content:''; position:absolute; inset:0; z-index:0; pointer-events:none;
                background:rgba(0,0,0,var(--vp-log-backdrop-dim, 0.4));
            }
            .vp-session-log.has-backdrop .vp-session-log-toolbar,
            .vp-session-log.has-backdrop .vp-session-log-list { position:relative; z-index:1; }
            /* Frosted-glass bubbles: blur whatever is behind the bubble
               (backdrop image included) so text stays readable. */
            .vp-session-log.bubble-blur .vp-session-msg {
                backdrop-filter:blur(7px); -webkit-backdrop-filter:blur(7px);
            }
            .vp-session-log-list {
                flex:1; min-height:0; overflow:auto;
                padding-top:10px; padding-bottom:10px;
                padding-left:calc(10px + var(--vp-log-margin-left, 0px));
                padding-right:calc(10px + var(--vp-log-margin-right, 0px));
                display:flex; flex-direction:column; gap:10px;
                transition: padding-left .14s ease, padding-right .14s ease;
            }
            .vp-session-log.compact .vp-session-log-list {
                padding-top:7px; padding-bottom:7px;
                padding-left:calc(7px + var(--vp-log-margin-left, 0px));
                padding-right:calc(7px + var(--vp-log-margin-right, 0px));
                gap:7px;
            }
            .vp-session-log.compact .vp-session-msg-head { padding:4px 7px; }
            .vp-session-log.compact .vp-session-msg-body { padding:7px 8px; line-height:1.42; }
            .vp-session-log.align-chat .vp-session-msg,
            .vp-session-log.align-inverted .vp-session-msg { width: fit-content; max-width: min(86%, 760px); }
            .vp-session-log.align-chat .vp-session-msg.role-user { align-self:flex-end; }
            .vp-session-log.align-chat .vp-session-msg.role-assistant { align-self:flex-start; }
            .vp-session-log.align-chat .vp-session-msg.role-system,
            .vp-session-log.align-chat .vp-session-msg.scene-event { align-self:center; }
            .vp-session-log.align-inverted .vp-session-msg.role-user { align-self:flex-start; }
            .vp-session-log.align-inverted .vp-session-msg.role-assistant { align-self:flex-end; }
            .vp-session-log.align-inverted .vp-session-msg.role-system,
            .vp-session-log.align-inverted .vp-session-msg.scene-event { align-self:center; }
            .vp-session-empty { margin:auto; text-align:center; color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.5; max-width:360px; }
			.vp-session-msg {
				flex: 0 0 auto;
				border:1px solid rgba(255,255,255,0.07); border-radius:10px; overflow:hidden;
				background:rgba(255,255,255,0.045); box-shadow:0 2px 8px rgba(0,0,0,0.12);
				animation: vpMsgIn .28s cubic-bezier(.2,.8,.2,1) both;
			}
			@keyframes vpMsgIn {
				from { opacity:0; transform:translateY(6px); }
				to   { opacity:1; transform:none; }
			}
			.vp-session-msg.role-user      { background:var(--msg-user-bg, var(--header-accent)); border-left:3px solid var(--accent); }
			.vp-session-msg.role-assistant { background:var(--msg-bot-bg, rgba(255,255,255,0.045)); border-left:3px solid rgba(255,230,180,0.45); }
			.vp-session-msg.role-system    { background:var(--msg-system-bg, rgba(137,180,250,0.08)); border-left:3px solid rgba(137,180,250,0.55); }
			.vp-session-msg.status-streaming { border-color:rgba(108,95,166,0.65); }
			.vp-session-msg.status-streaming .vp-session-msg-head .role::after {
				content:' ✎'; opacity:.6; animation: vpBlink 1s infinite;
			}
			@keyframes vpBlink { 50% { opacity:.2; } }
			.vp-session-msg.status-error { border-color:rgba(224,85,85,0.6); border-left-color:#e05555; }
            
            /* Studio 2.0 Polish: Thinking Animation */
            .vp-session-msg-head .status { 
                color: #f5c542; 
                font-weight: 700;
                text-shadow: 0 0 8px rgba(245, 197, 66, 0.3);
                animation: vpStatusPulse 2s infinite ease-in-out;
            }
            @keyframes vpStatusPulse {
                0%, 100% { opacity: 0.7; transform: scale(0.98); }
                50% { opacity: 1; transform: scale(1); }
            }
            .vp-session-msg.role-user { background:var(--msg-user-bg, var(--header-accent)); }
            .vp-session-msg.role-assistant { background:var(--msg-bot-bg, rgba(255,255,255,0.045)); }
            .vp-session-msg.scene-event { border-color:rgba(137,180,250,.22); background:var(--msg-system-bg, rgba(137,180,250,.055)); }
            .vp-session-msg.scene-event .vp-session-msg-head { background:rgba(137,180,250,.08); }
            .vp-session-msg.scene-event .vp-session-msg-body { padding:5px 8px; white-space:normal; line-height:1.22; font-size:12px; }
            .vp-scene-event-card { color:var(--text-primary,#cdd6f4); font-size:12px; line-height:1.22; }
            .vp-scene-event-line { display:flex; align-items:center; gap:6px; min-width:0; white-space:nowrap; overflow:hidden; }
            .vp-scene-event-icon { flex:0 0 auto; font-size:14px; opacity:.95; }
            .vp-scene-event-line b { flex:0 0 auto; color:#bac2de; font-size:11px; font-weight:900; }
            .vp-scene-event-pill { flex:0 0 auto; border:1px solid rgba(255,255,255,.10); border-radius:999px; padding:0 5px; color:#f9e2af; background:rgba(249,226,175,.07); font-size:10px; font-weight:700; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .vp-scene-event-summary { min-width:0; overflow:hidden; text-overflow:ellipsis; color:var(--text-primary,#cdd6f4); opacity:.92; }
            .vp-scene-event-details { margin-top:1px; color:var(--text-secondary,#a6adc8); }
            .vp-scene-event-details summary { cursor:pointer; user-select:none; font-size:10px; color:#89b4fa; width:max-content; line-height:1; }
            .vp-scene-event-fields { margin-top:5px; display:grid; grid-template-columns:max-content minmax(0,1fr); gap:3px 9px; font-size:11px; line-height:1.25; }
            .vp-scene-event-card.mode-expanded .vp-scene-event-fields { margin-top:7px; }
            .vp-scene-event-card.mode-minimal .vp-scene-event-line { height:18px; }
            .vp-scene-event-field { display:contents; }
            .vp-scene-event-field b { color:#bac2de; font-weight:800; }
            .vp-scene-event-field span { color:#a6adc8; overflow-wrap:anywhere; }
            .vp-scene-event-notes { margin-top:6px; border-top:1px solid rgba(255,255,255,.07); padding-top:5px; font-size:11px; color:#a6adc8; line-height:1.3; }
            .vp-session-msg.status-error { border-color:rgba(224,85,85,0.6); }
            .vp-session-msg.status-streaming { border-color:rgba(108,95,166,0.65); }
            .vp-session-msg-head {
                display:flex; align-items:center; gap:8px; padding:6px 8px; background:rgba(0,0,0,0.16);
                color:var(--text-secondary,#a6adc8); font-size:10px; letter-spacing:.08em; text-transform:uppercase;
            }
            .vp-session-msg-avatar {
                width:var(--vp-avatar-size, 22px); height:var(--vp-avatar-size, 22px); flex:0 0 var(--vp-avatar-size, 22px);
                border-radius:999px; overflow:hidden;
                display:inline-flex; align-items:center; justify-content:center;
                background:var(--vp-msg-avatar-color, var(--accent,#6c5fa6)); color:#fff;
                border:1px solid rgba(255,255,255,0.2);
                box-shadow:0 1px 5px rgba(0,0,0,0.28);
                font-size:calc(var(--vp-avatar-size, 22px) * 0.45); font-weight:900; line-height:1;
            }
            .vp-session-msg-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
            /* Float mode: avatar sits inside the message body, text wraps
               to its right and continues below it (classic forum look). */
            .vp-msg-avatar-float {
                float:left; margin:2px 10px 4px 0;
                border-radius:9px;
                shape-outside:margin-box;
            }
            .vp-session-msg-body::after { content:''; display:block; clear:both; }
            .vp-session-msg-avatar.role-user { background:rgba(108,95,166,0.55); border-color:rgba(180,170,255,0.45); }
            .vp-session-msg-head .role { font-weight:700; color:var(--text-primary,#cdd6f4); }
            .vp-session-msg-head .status { color:#f5c542; }
            .vp-session-msg-head .spacer { flex:1; }
            .vp-session-msg-btn {
                border:0; background:transparent; color:var(--text-secondary,#a6adc8); cursor:pointer;
                font-size:11px; padding:2px 5px; border-radius:4px;
            }
            .vp-session-msg-btn:hover { background:rgba(255,255,255,0.10); color:var(--text-primary,#cdd6f4); }
            .vp-manifest-pill { color:#89b4fa !important; font-weight:700; opacity:1 !important; }
            .vp-manifest-pill:hover { background:rgba(137,180,250,0.15) !important; }
            .vp-manifest-row { border:1px solid var(--border,#383860); border-radius:7px; padding:7px 9px; margin-bottom:8px; }
            .vp-manifest-row.expired { opacity:0.55; }
            .vp-manifest-row-head { display:flex; align-items:center; gap:8px; font-size:11px; margin-bottom:5px; }
            .vp-manifest-row-head .src { font-weight:700; color:#89b4fa; text-transform:uppercase; letter-spacing:0.04em; }
            .vp-manifest-row-head .ttl { color:var(--text-secondary,#a6adc8); }
            .vp-manifest-text { margin:0; white-space:pre-wrap; font:12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; color:var(--text-primary,#cdd6f4); }
            .vp-session-msg-body {
                padding:9px 10px; white-space:pre-wrap;
                font-size:var(--vp-log-font-size, 13px);
                font-family:var(--vp-log-font-family, system-ui, sans-serif);
                line-height:1.48; color:var(--text-primary,#cdd6f4);
            }
            .vp-session-msg-body strong { color:var(--msg-strong-color, var(--text-primary, #cdd6f4)); font-weight:700; }
            .vp-session-msg-body em { color:var(--msg-em-color, var(--text-secondary, #a6adc8)); font-style:italic; }
            .vp-session-msg-body code {
                font-family:ui-monospace, SFMono-Regular, Consolas, monospace;
                font-size:0.92em; padding:1px 4px; border-radius:4px;
                background:rgba(0,0,0,0.30); color:var(--msg-code-color, var(--text-primary, #cdd6f4));
            }
            .vp-session-msg-body blockquote {
                margin:4px 0; padding:3px 0 3px 10px;
                border-left:3px solid rgba(108,95,166,0.65);
                color:#e0def4; background:rgba(108,95,166,0.09);
            }
            .vp-session-msg-body.is-editing {
                display:block; width:100%; min-height:44px;
                border:0; outline:none; margin:0; box-shadow:none; border-radius:0;
                background:transparent; color:var(--text-primary,#cdd6f4);
                font-size:var(--vp-log-font-size, 13px);
                font-family:var(--vp-log-font-family, system-ui, sans-serif);
                line-height:1.48;
                cursor:text; caret-color:var(--accent,#6c5fa6);
                user-select:text;
            }
            .vp-session-msg-body.is-editing:focus { background:rgba(255,255,255,0.025); }
            .vp-session-input-panel { height:100%; display:flex; flex-direction:column; gap:8px; padding:8px; }
            .vp-session-participants {
                flex:0 0 auto; display:flex; align-items:center; gap:6px; flex-wrap:wrap;
                margin-left:var(--vp-input-margin-left, 0px);
                margin-right:var(--vp-input-margin-right, 0px);
                transition: margin-left .14s ease, margin-right .14s ease;
            }
            .vp-session-participants .spacer { flex:1; }
            .vp-session-scene-btn {
                border:1px solid rgba(108,95,166,0.40); background:rgba(108,95,166,0.14);
                color:var(--text-primary,#cdd6f4); border-radius:999px; height:24px;
                padding:0 10px; font-size:11px; cursor:pointer; font-weight:600;
                white-space:nowrap; flex:0 0 auto;
                transition: background .12s ease, border-color .12s ease;
            }
            .vp-session-scene-btn:hover { background:rgba(108,95,166,0.30); border-color:rgba(108,95,166,0.60); }
            .vp-session-scene-btn:disabled { opacity:0.5; cursor:default; }
            .vp-session-participant-chip {
                border:1px solid rgba(255,255,255,0.10); background:rgba(255,255,255,0.04); color:var(--text-primary,#cdd6f4);
                border-radius:999px; height:24px; padding:0 9px; font-size:11px; cursor:pointer; display:inline-flex; align-items:center; gap:6px;
            }
            .vp-session-participant-chip.active { background:rgba(108,95,166,0.34); border-color:rgba(108,95,166,0.72); color:#fff; }
            .vp-session-participant-chip:hover { background:rgba(255,255,255,0.10); }
            .vp-session-participant-chip .remove {
                display:inline-flex; align-items:center; justify-content:center; width:14px; height:14px; border-radius:999px;
                font-size:10px; line-height:1; background:rgba(0,0,0,0.20);
            }
            .vp-session-participant-add {
                border:1px dashed rgba(255,255,255,0.22); background:transparent; color:var(--text-secondary,#a6adc8);
                border-radius:999px; height:24px; padding:0 10px; font-size:11px; cursor:pointer;
            }
            .vp-session-participant-add:hover { color:var(--text-primary,#cdd6f4); background:rgba(255,255,255,0.06); }
            
            /* Tool Toggle Chip in Input Area */
            .vp-session-input-tool-chip {
                border:1px solid rgba(255,255,255,0.10); background:rgba(0,0,0,0.2);
                color:var(--text-secondary,#a6adc8); border-radius:999px; height:24px;
                padding:0 8px; font-size:11px; cursor:pointer; display:inline-flex; 
                align-items:center; gap:4px; transition: all 0.2s ease;
            }
            .vp-session-input-tool-chip.active { 
                border-color: var(--accent); background: color-mix(in srgb, var(--accent) 15%, transparent);
                color: var(--accent); box-shadow: 0 0 10px rgba(108,95,166,0.15);
            }
            .vp-session-input-tool-chip:hover { border-color: rgba(255,255,255,0.2); }
            .vp-session-input-tool-chip small { opacity: 0.8; font-weight: 700; font-family: ui-monospace, monospace; }

            .vp-session-participant-picker {
                position:absolute; z-index:25; min-width:230px; max-width:min(320px, calc(100vw - 32px));
                background:var(--bg-secondary,#1e1e2e); border:1px solid rgba(255,255,255,0.10); border-radius:10px;
                box-shadow:0 12px 36px rgba(0,0,0,0.38); padding:8px; display:flex; flex-direction:column; gap:6px;
            }
            .vp-session-participant-picker-note { font-size:11px; color:var(--text-secondary,#a6adc8); line-height:1.4; }
            .vp-session-participant-picker-list { display:flex; flex-direction:column; gap:6px; overflow:auto; }
            .vp-session-participant-option {
                border:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.04); color:var(--text-primary,#cdd6f4);
                border-radius:8px; padding:8px 9px; text-align:left; cursor:pointer;
            }
            .vp-session-participant-option:hover { background:rgba(255,255,255,0.08); border-color:rgba(255,255,255,0.14); }
            .vp-session-participant-option .name { display:block; font-size:12px; font-weight:700; }
            .vp-session-participant-option .meta { display:block; margin-top:2px; font-size:10px; color:var(--text-secondary,#a6adc8); }
            .vp-session-participant-picker-actions { display:flex; gap:6px; justify-content:flex-end; padding-top:2px; }
            .vp-session-input-row {
                flex:1; min-height:0; display:flex; gap:8px;
                margin-left:var(--vp-input-margin-left, 0px);
                margin-right:var(--vp-input-margin-right, 0px);
                transition: margin-left .14s ease, margin-right .14s ease;
            }
            .vp-session-input {
                flex:1; min-width:0; min-height:54px; height:100%; resize:none; border-radius:8px; padding:9px 10px;
                border:1px solid rgba(255,255,255,0.12); outline:none;
                background:rgba(0,0,0,0.22); color:var(--text-primary,#cdd6f4);
                font:var(--vp-input-font-size, 13px)/1.45 system-ui, sans-serif;
            }
            .vp-session-input:focus { border-color:var(--accent,#6c5fa6); box-shadow:0 0 0 1px rgba(108,95,166,0.35); }
            .vp-session-input-actions {
                flex:0 0 94px; display:flex; flex-direction:column; align-items:stretch; gap:6px;
            }
            .vp-session-input-actions .vp-btn { width:100%; min-height:28px; padding:0 7px; }
            .vp-session-input-actions .spacer { flex:1; }
            .vp-session-scenario-bar {
                display: flex; align-items: center; gap: 8px;
                padding: 4px 8px; font-size: 11px; color: var(--text-secondary, #a6adc8);
                min-height: 0; overflow: hidden; transition: min-height 0.2s ease, padding 0.2s ease;
            }
            .vp-session-scenario-bar.has-scenario { min-height: 26px; }
            .vp-session-scenario-indicator {
                cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
                padding: 2px 8px; border-radius: 999px;
                background: rgba(108,95,166,0.18); border: 1px solid rgba(108,95,166,0.32);
                color: var(--text-primary, #cdd6f4); font-size: 11px; font-weight: 600;
                transition: background 0.15s ease;
                max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
            }
            .vp-session-scenario-indicator:hover { background: rgba(108,95,166,0.32); }
            .vp-session-model { padding:10px; display:flex; flex-direction:column; gap:8px; font-size:12px; }
            .vp-session-model-title { font-weight:700; margin-bottom:4px; display:flex; align-items:center; gap:6px; }
            .vp-session-model label { display:flex; align-items:center; justify-content:space-between; gap:10px; }
            .vp-session-model input {
                width:62%; border-radius:5px; border:1px solid rgba(255,255,255,0.12);
                background:rgba(0,0,0,0.22); color:var(--text-primary,#cdd6f4); padding:5px 7px; font-size:12px;
            }
            .vp-session-model .check { justify-content:flex-start; }
            .vp-session-model .check input { width:auto; }
            .vp-session-model-note { color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.45; padding-top:4px; }
            /* v26 Tools Manager */
            .vp-session-tools-manager { margin-top:6px; }
            .vp-session-tools-head b { color:var(--text-primary,#cdd6f4); }
            .vp-session-tools-list { max-height:170px; overflow-y:auto; display:flex; flex-direction:column; gap:3px; margin-top:4px; padding-right:2px; }
            .vp-session-tool-row { display:flex; align-items:center; gap:8px; font-size:12px; padding:4px 7px; border-radius:7px; background:rgba(137,180,250,0.07); cursor:pointer; }
            .vp-session-tool-row:hover { background:rgba(137,180,250,0.13); }
            .vp-session-tool-row.off { opacity:0.55; }
            .vp-session-tool-row input { margin:0; flex:0 0 auto; }
            .vp-session-tool-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .vp-session-tool-tok { font-family:monospace; font-size:11px; opacity:0.7; flex:0 0 auto; }
            .vp-session-model-actions { display:flex; flex-wrap:wrap; gap:6px; padding-top:2px; }
            .vp-session-model-status { border:1px solid rgba(255,255,255,0.08); border-radius:7px; padding:7px 8px; background:rgba(255,255,255,0.035); color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.35; word-break:break-word; }
            .vp-session-model-status.ok { color:#b8f5c8; border-color:rgba(76,175,125,0.34); background:rgba(76,175,125,0.10); }
            .vp-session-model-status.err { color:#ffb0b0; border-color:rgba(224,85,85,0.40); background:rgba(224,85,85,0.10); }
            .vp-context-inspector-card .vp-shell-modal-body { display:flex; flex-direction:column; gap:8px; }
            .vp-context-toolbar { display:flex; align-items:center; gap:8px; justify-content:space-between; color:var(--text-secondary,#a6adc8); font-size:11px; }
            .vp-context-body { display:flex; flex-direction:column; gap:9px; max-height:min(68vh, 720px); overflow:auto; padding-right:2px; }
            .vp-context-section { border:1px solid rgba(255,255,255,0.08); border-radius:9px; overflow:hidden; background:rgba(255,255,255,0.03); }
            .vp-context-section-head { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:7px 9px; background:rgba(0,0,0,0.18); border-bottom:1px solid rgba(255,255,255,0.06); }
            .vp-context-section-head b { color:var(--text-primary,#cdd6f4); font-size:12px; }
            .vp-context-section-head span { color:var(--text-secondary,#a6adc8); font-size:10px; white-space:nowrap; }
            .vp-context-section pre { margin:0; padding:9px; max-height:260px; overflow:auto; white-space:pre-wrap; word-break:break-word; color:var(--text-primary,#cdd6f4); font:11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }

            /* Simple Chat Bubbles overrides */
            .vp-session-log.simple-bubbles .vp-session-log-toolbar {
                display: none;
            }
            
            /* Studio 2.0: Tool Call / Response Spoilers (Adaptive) */
            .vp-tool-info {
                margin: 0 0 6px 0;
                border: 1px solid rgba(137, 180, 250, 0.2);
                border-radius: 8px;
                background: rgba(137, 180, 250, 0.05);
                font-family: ui-monospace, Consolas, monospace;
                font-size: 11px;
                overflow: hidden;
            }
            .vp-tool-info summary {
                padding: 5px 10px;
                cursor: pointer;
                user-select: none;
                color: var(--accent, #89b4fa);
                font-weight: 700;
                display: flex;
                align-items: center;
                gap: 8px;
                background: rgba(137, 180, 250, 0.08);
            }
            .vp-tool-info summary:hover { background: rgba(137, 180, 250, 0.15); }
            .vp-tool-info summary::before { display: none; }
            .vp-tool-info pre {
                margin: 0;
                padding: 10px;
                background: rgba(0, 0, 0, 0.12);
                color: var(--text-secondary, #a6adc8);
                white-space: pre-wrap;
                word-break: break-all;
                border-top: 1px solid rgba(137, 180, 250, 0.1);
                line-height: 1.4;
            }
            .vp-tool-info.status-success { border-color: rgba(166, 227, 161, 0.3); }
            .vp-tool-info.status-success summary { color: var(--success, #a6e3a1); }
            .vp-tool-info.status-success summary::before { content: '✅'; opacity: 1; }

            /* Immersive Tool Pills */
            .vp-message-tools-area {
                display: block;
                margin-bottom: 8px;
                width: 100%;
            }
            .vp-tool-pill {
                display: inline-block;
                margin: 0 4px 4px 0;
                padding: 2px 10px;
                background: rgba(137, 180, 250, 0.12);
                border: 1px solid rgba(137, 180, 250, 0.25);
                border-radius: 999px;
                color: #89b4fa;
                font-size: 11px;
                font-weight: 600;
                letter-spacing: 0.02em;
                box-shadow: 0 2px 6px rgba(0,0,0,0.15);
            }
            .align-chat .vp-tool-pill, .align-inverted .vp-tool-pill { margin-right: 0; margin-left: 4px; }
            .align-chat .vp-message-tools-area { text-align: right; }

            .vp-session-log.simple-bubbles .vp-session-msg {
                border-radius: 18px;
                border: none;
                position: relative;
            }
            .vp-session-log.simple-bubbles .vp-session-msg.role-user {
                border-bottom-right-radius: 4px;
            }
            .vp-session-log.simple-bubbles .vp-session-msg.role-assistant {
                border-bottom-left-radius: 4px;
            }

            /* Make the head inline, but very compact to show the name */
            .vp-session-log.simple-bubbles .vp-session-msg-head {
                display: flex;
                background: transparent;
                padding: 7px 14px 0 14px;
                align-items: flex-end;
            }
            .vp-session-log.simple-bubbles .vp-session-msg-head .role {
                display: block;
                font-size: 11px;
                font-weight: 700;
                opacity: 0.65;
                line-height: 1;
            }
            .vp-session-log.simple-bubbles .vp-session-msg-head .status { display: none; }
            .vp-session-log.simple-bubbles .vp-session-msg-head .spacer { display: block; flex: 1; }

            /* Action Buttons (Absolute at Bottom-Right) */
            .vp-session-log.simple-bubbles .vp-session-msg-btn {
                position: absolute;
                bottom: 6px;
                font-size: 0;
                width: 20px;
                height: 20px;
                border-radius: 50%;
                background: rgba(255, 255, 255, 0.15);
                display: flex;
                align-items: center;
                justify-content: center;
                color: transparent;
                padding: 0;
                opacity: 0;
                transition: opacity 0.2s, background 0.1s;
                z-index: 10;
            }
            .vp-session-log.simple-bubbles .vp-session-msg:hover .vp-session-msg-btn {
                opacity: 1;
            }
            .vp-session-log.simple-bubbles .vp-session-msg-btn:hover { background: rgba(255, 255, 255, 0.35); }
            
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="delete"] { right: 6px; }
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="edit"]   { right: 28px; }
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="copy"]   { right: 50px; }

            .vp-session-log.simple-bubbles .vp-session-msg-btn::after {
                font-size: 11px;
                line-height: 1;
                color: #fff;
            }
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="copy"]::after { content: '📋'; }
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="edit"]::after { content: '✏️'; }
            .vp-session-log.simple-bubbles .vp-session-msg-btn[data-act="delete"]::after { content: '🗑️'; }

            /* Body Adjustments */
            .vp-session-log.simple-bubbles .vp-session-msg-body {
                padding: 3px 14px 10px 14px; /* Reduced top padding since head provides some */
            }

            /* Scene Events Grouping (Spoiler) */
            .vp-session-log.simple-bubbles .vp-scene-event-group {
                align-self: center;
                width: 100%;
                max-width: min(86%, 760px);
                background: rgba(137, 180, 250, 0.04);
                border: 1px solid rgba(137, 180, 250, 0.15);
                border-radius: 12px;
                margin: 4px 0;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 7px 12px;
                cursor: pointer;
                user-select: none;
                font-size: 11px;
                color: var(--text-secondary, #a6adc8);
                outline: none;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary::-webkit-details-marker {
                display: none;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary:hover {
                background: rgba(255, 255, 255, 0.04);
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary b {
                color: #89b4fa;
                text-transform: uppercase;
                font-size: 10px;
                flex: 0 0 auto;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary .icon {
                font-size: 13px;
                opacity: 0.9;
                flex: 0 0 auto;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-summary .summary-text {
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                opacity: 0.85;
                flex: 1;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group[open] .vp-scene-event-group-summary .summary-text {
                white-space: normal;
                opacity: 1;
            }
            .vp-session-log.simple-bubbles .vp-scene-event-group-body {
                display: flex;
                flex-direction: column;
                gap: 4px;
                padding: 6px 8px;
                border-top: 1px solid rgba(137, 180, 250, 0.12);
                background: rgba(0, 0, 0, 0.1);
            }
            /* Reset align-self inside the group */
            .vp-session-log.simple-bubbles .vp-scene-event-group-body .vp-session-msg {
                align-self: stretch !important;
                margin: 0;
                overflow: visible;
                border: none;
                border-radius: 0;
                box-shadow: none;
                background: transparent;
            }

            /* Scene Events Adjustments */
            .vp-session-log.simple-bubbles .vp-session-msg.scene-event {
                border-radius: 0;
                border: none;
                overflow: visible;
                background: transparent;
                box-shadow: none;
            }
            .vp-session-log.simple-bubbles .vp-session-msg.scene-event .vp-session-msg-head {
                background: rgba(137,180,250,.08);
                padding: 6px 14px;
                border-radius: 6px;
            }
            .vp-session-log.simple-bubbles .vp-session-msg.scene-event .vp-session-msg-head .status { display: block; }
            .vp-session-log.simple-bubbles .vp-session-msg.scene-event .vp-session-msg-body {
                overflow: visible;
            }
        `;
        document.head.appendChild(style);
    }

    function clearContainer(container) { container.innerHTML = ''; }

    function renderInputPanel(container, ctx = {}) {
        ensureState();
        const local = ctx.getPanelState ? ctx.getPanelState({ marginLeft: S.session.input?.marginLeft || 0, marginRight: S.session.input?.marginRight || 0 })
                                       : { marginLeft: S.session.input?.marginLeft || 0, marginRight: S.session.input?.marginRight || 0 };
        clearContainer(container);
        const wrap = document.createElement('div');
        wrap.className = 'vp-session-input-panel';
        wrap.style.setProperty('--vp-input-font-size', `${Number(S.session.input?.fontSize) || 13}px`);
        wrap.style.setProperty('--vp-input-margin-left', `${Math.max(0, Math.min(280, Number(local.marginLeft) || 0))}px`);
        wrap.style.setProperty('--vp-input-margin-right', `${Math.max(0, Math.min(280, Number(local.marginRight) || 0))}px`);

        const participants = chatApi()?.getActiveParticipants?.() || [];
        const activeSpeaker = chatApi()?.getActiveSpeaker?.() || null;
        const speakerName = activeSpeaker ? (chatApi()?.getParticipantDisplayName?.(activeSpeaker) || null) : null;
        const chipsHtml = participants.map(p => {
            const profile = chatApi()?.getParticipantProfile?.(p) || null;
            const label = chatApi()?.getParticipantDisplayName?.(p) || profile?.name || 'Assistant';
            const active = activeSpeaker?.id === p.id ? ' active' : '';
            const removable = participants.length > 1 ? `<span class="remove" data-remove="${p.id}" title="Remove from chat">×</span>` : '';
            return `<button class="vp-session-participant-chip${active}" data-speaker="${p.id}" title="Speak as ${label}">${label}${removable}</button>`;
        }).join('');

        const toolsEnabled = S.modelConfig.toolsMode === 'native';
        const toolCount = VP.tools?.list({ enabledOnly: true }).length || 0;

        const pendingCount = Array.isArray(S.session.pendingManifests) ? S.session.pendingManifests.length : 0;
        let pendingHtml = '';
        if (pendingCount > 0) {
            const list = S.session.pendingManifests.map((m, idx) => {
                const isGaze = m.source === 'user-gaze' || String(m.text).includes('[GAZE FOCUS ATTACHMENT');
                const label = isGaze ? '📷 Gaze Snapshot' : '📎 Context Manifest';
                return `<span class="vp-manifest-pill" style="display: inline-flex; align-items: center; gap: 4px; background: rgba(137,180,250,0.15); color: #89b4fa; padding: 2px 8px; border-radius: 999px; font-size: 11px; margin-right: 6px;">
                    ${label}
                    <span class="remove-pending" data-idx="${idx}" style="cursor: pointer; opacity: 0.7; font-weight: bold; margin-left: 2px;">×</span>
                </span>`;
            }).join('');
            pendingHtml = `<div class="vp-session-pending-attachments" style="padding: 4px 8px 8px; display: flex; flex-wrap: wrap; gap: 4px;">
                ${list}
            </div>`;
        }

        wrap.innerHTML = `
            <div class="vp-session-participants">
                ${chipsHtml}
                <button class="vp-session-participant-add" data-act="add-participant">＋</button>
                <span class="spacer"></span>
                <button class="vp-session-input-tool-chip ${toolsEnabled ? 'active' : ''}" id="vp-input-toggle-tools" title="${toolsEnabled ? 'Tools are ON' : 'Tools are OFF'}">
                    <span>${toolsEnabled ? '🔧' : '🔌'}</span>
                    <small>${toolCount}</small>
                </button>
                <button class="vp-session-scene-btn" data-act="scene" title="Model starts or continues the scene">🎬 Begin</button>
            </div>
            <div class="vp-session-input-row">
                <textarea class="vp-session-input" name="messageInput" placeholder="${speakerName ? `Message (→ ${speakerName}) or type context for 🎬...` : 'Направить сцену / написать сообщение... (Ctrl+Enter to send)'}"></textarea>
                <div class="vp-session-input-actions">
                    <button class="vp-btn" data-act="primary">▶ Send</button>
                    <button class="vp-btn vp-btn-ghost" data-act="regen">↻ Regen</button>
                    <span class="spacer"></span>
                </div>
            </div>
            ${pendingHtml}
            <div class="vp-session-scenario-bar" data-role="scenario-bar"></div>
            `;

        wrap.querySelectorAll('.remove-pending').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const idx = parseInt(btn.dataset.idx, 10);
                if (removePendingManifestAt(idx)) { // v12 seam — pending queue owned by session-manifests.js
                    persistSession();
                    renderRegisteredPanels(['input']);
                }
            });
        });

        wrap.querySelectorAll('[data-speaker]').forEach(btn => {
            btn.addEventListener('click', (e) => {
                if (e.target.closest('[data-remove]')) return;
                chatApi()?.setActiveSpeakerInteractive?.(btn.dataset.speaker);
            });
        });
        wrap.querySelectorAll('[data-remove]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.stopPropagation();
                chatApi()?.removeParticipantFromCurrentChatInteractive?.(el.dataset.remove);
            });
        });
        const addBtn = wrap.querySelector('[data-act="add-participant"]');
        let closeParticipantPicker = () => {};

        const openProfilesPanel = () => {
            const areas = Array.from(document.querySelectorAll('.vp-shell-area'));
            const currentArea = wrap.closest('.vp-shell-area');
            let profileArea = areas.find(area => area.querySelector('.vp-shell-panel-select')?.value === 'profiles');
            if (!profileArea) {
                const candidate = areas.find(area => area !== currentArea && !['stage', 'gallery', 'input'].includes(area.querySelector('.vp-shell-panel-select')?.value || ''))
                    || areas.find(area => area !== currentArea)
                    || currentArea;
                const select = candidate?.querySelector('.vp-shell-panel-select');
                if (select) {
                    select.value = 'profiles';
                    select.dispatchEvent(new Event('change', { bubbles: true }));
                }
                profileArea = candidate || null;
            }
            requestAnimationFrame(() => {
                const liveProfileArea = Array.from(document.querySelectorAll('.vp-shell-area')).find(area => area.querySelector('.vp-shell-panel-select')?.value === 'profiles');
                if (liveProfileArea) {
                    liveProfileArea.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                    const box = liveProfileArea;
                    const prev = box.style.boxShadow;
                    box.style.boxShadow = '0 0 0 2px rgba(108,95,166,0.75) inset, 0 0 18px rgba(108,95,166,0.28)';
                    setTimeout(() => { box.style.boxShadow = prev; }, 900);
                } else {
                    VP.showToast?.('Profiles panel is not available in the current workspace', 'info');
                }
            });
        };

        const openParticipantPicker = () => {
            closeParticipantPicker();
            const profiles = chatApi()?.getProfilesStore?.()?.items || [];
            const currentParticipants = chatApi()?.getActiveParticipants?.() || [];
            const choices = profiles.filter(p => !currentParticipants.some(part => part.profileId === p.id));
            const areaBody = wrap.closest('.vp-shell-area-body');
            const areaRect = areaBody?.getBoundingClientRect?.() || { width: window.innerWidth, height: window.innerHeight };
            const addRect = addBtn.getBoundingClientRect();
            const belowSpace = window.innerHeight - addRect.bottom - 12;
            const aboveSpace = addRect.top - 12;
            const useGlobal = areaRect.width < 250 || areaRect.height < 100 || Math.max(belowSpace, aboveSpace) < 120;

            const picker = document.createElement('div');
            picker.className = 'vp-session-participant-picker';
            picker.innerHTML = `
                <div class="vp-session-participant-picker-list"></div>
                <div class="vp-session-participant-picker-actions">
                    <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="open-profiles">Open Profiles</button>
                    <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="create-profile">＋ Profile</button>
                </div>`;

            const host = useGlobal ? document.body : wrap;
            let backdrop = null;
            let onDocMouseDown = null;
            let onEsc = null;

            if (useGlobal) {
                // In global mode, we don't need the picker's own styling/box, 
                // we want it to blend perfectly into the modal body.
                picker.style.position = 'static';
                picker.style.boxShadow = 'none';
                picker.style.border = 'none';
                picker.style.background = 'transparent';
                picker.style.maxWidth = '100%';
                picker.style.padding = '0';

                backdrop = document.createElement('div');
                backdrop.className = 'vp-shell-modal-backdrop global';
                const card = document.createElement('div');
                card.className = 'vp-shell-modal-card';
                card.style.setProperty('--vp-modal-width', '360px');
                
                // Add draggable head for global mode picker
                const head = document.createElement('div');
                head.className = 'vp-shell-modal-head';
                head.innerHTML = `
                    <div class="vp-shell-modal-title">＋ Add Participant</div>
                    <button class="vp-shell-modal-close" title="Close">×</button>
                `;
                card.appendChild(head);
                
                const body = document.createElement('div');
                body.className = 'vp-shell-modal-body';
                body.style.padding = '12px';
                body.appendChild(picker);
                card.appendChild(body);
                backdrop.appendChild(card);
                host.appendChild(backdrop);
                
                // Draggable logic for this specific modal
                let isDragging = false, startX, startY, startLeft, startTop;
                head.addEventListener('mousedown', (e) => {
                    if (e.target.closest('.vp-shell-modal-close') || e.target.closest('button')) return;
                    isDragging = true;
                    startX = e.clientX;
                    startY = e.clientY;
                    const rect = card.getBoundingClientRect();
                    const backdropRect = backdrop.getBoundingClientRect();
                    startLeft = rect.left - backdropRect.left;
                    startTop = rect.top - backdropRect.top;
                    card.style.margin = '0';
                    card.style.position = 'absolute';
                    card.style.left = `${startLeft}px`;
                    card.style.top = `${startTop}px`;
                    e.preventDefault();

                    const onMouseMove = (ev) => {
                        if (!isDragging) return;
                        card.style.left = `${startLeft + (ev.clientX - startX)}px`;
                        card.style.top = `${startTop + (ev.clientY - startY)}px`;
                    };
                    const onMouseUp = () => {
                        isDragging = false;
                        document.removeEventListener('mousemove', onMouseMove);
                        document.removeEventListener('mouseup', onMouseUp);
                    };
                    document.addEventListener('mousemove', onMouseMove);
                    document.addEventListener('mouseup', onMouseUp);
                });
                
                head.querySelector('.vp-shell-modal-close').addEventListener('click', () => cleanupPicker());

            } else {
                host.appendChild(picker);
            }

            const cleanupPicker = () => {
                if (onDocMouseDown) document.removeEventListener('mousedown', onDocMouseDown, true);
                if (onEsc) document.removeEventListener('keydown', onEsc, true);
                picker.remove();
                backdrop?.remove();
                closeParticipantPicker = () => {};
            };

            const list = picker.querySelector('.vp-session-participant-picker-list');
            if (!choices.length) {
                list.innerHTML = `<div class="vp-session-participant-picker-note">All existing profiles are already in this chat.</div>`;
            } else {
                choices.forEach(profile => {
                    const btn = document.createElement('button');
                    btn.className = 'vp-session-participant-option';
                    btn.innerHTML = `<span class="name">${profile.name}</span><span class="meta">${profile.description || 'Add this profile as a new participant'}</span>`;
                    btn.addEventListener('click', () => {
                        chatApi()?.addParticipantToCurrentChatInteractive?.(profile.id);
                        cleanupPicker();
                    });
                    list.appendChild(btn);
                });
            }

            picker.querySelector('[data-act="create-profile"]').addEventListener('click', () => {
                cleanupPicker();
                chatApi()?.createProfileInteractive?.({
                    onSaved: (profile) => {
                        if (profile) chatApi()?.addParticipantToCurrentChatInteractive?.(profile.id);
                    },
                });
            });
            picker.querySelector('[data-act="open-profiles"]').addEventListener('click', () => {
                cleanupPicker();
                openProfilesPanel();
            });

            if (!useGlobal) {
                const wrapRect = wrap.getBoundingClientRect();
                const listMaxHeight = Math.max(96, Math.min(220, Math.max(belowSpace, aboveSpace) - 46));
                list.style.maxHeight = `${listMaxHeight}px`;
                picker.style.left = `${Math.max(0, addRect.left - wrapRect.left - 190)}px`;
                picker.style.top = `${Math.max(0, addRect.bottom - wrapRect.top + 6)}px`;
                requestAnimationFrame(() => {
                    const pickerRect = picker.getBoundingClientRect();
                    const openAbove = pickerRect.bottom > window.innerHeight - 12 && aboveSpace > belowSpace;
                    if (openAbove) {
                        picker.style.top = `${Math.max(0, addRect.top - wrapRect.top - pickerRect.height - 6)}px`;
                    }
                });
            } else {
                list.style.maxHeight = `${Math.max(200, Math.min(480, window.innerHeight - 180))}px`;
                backdrop.addEventListener('mousedown', (ev) => { if (ev.target === backdrop) cleanupPicker(); });
                onEsc = (ev) => { if (ev.key === 'Escape') cleanupPicker(); };
                setTimeout(() => document.addEventListener('keydown', onEsc, true), 0);
            }

            onDocMouseDown = (ev) => {
                if (useGlobal) return;
                if (!picker.contains(ev.target) && ev.target !== addBtn) cleanupPicker();
            };
            setTimeout(() => document.addEventListener('mousedown', onDocMouseDown, true), 0);
            closeParticipantPicker = cleanupPicker;
            return cleanupPicker;
        };
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const existing = document.querySelector('.vp-session-participant-picker') || document.querySelector('.vp-shell-modal-backdrop.global .vp-session-participant-picker');
            if (existing) closeParticipantPicker();
            else closeParticipantPicker = openParticipantPicker();
        });

        const ta = wrap.querySelector('textarea');
        ta.value = getActiveDraft() || '';
        ta.addEventListener('input', () => { setActiveDraft(ta.value); });
        ta.addEventListener('keydown', (e) => {
            const enterToSend = !!S.session.input?.enterToSend;
            if (e.key === 'Enter' && ((enterToSend && !e.shiftKey) || e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                setActiveDraft(ta.value);
                send();
            }
        });
        const primaryBtn = wrap.querySelector('[data-act="primary"]');
        primaryBtn.textContent = S.session.running ? '■ Stop' : '▶ Send';
        primaryBtn.title = S.session.running ? 'Stop generation' : 'Send message';
        primaryBtn.classList.toggle('vp-btn-danger', !!S.session.running);
        primaryBtn.addEventListener('click', () => {
            if (S.session.running) stop();
            else { setActiveDraft(ta.value); send(); }
        });
        wrap.querySelector('[data-act="regen"]').addEventListener('click', regenerateLast);
        wrap.querySelector('[data-act="regen"]').disabled = !!S.session.running;

        // ── 🎬 Begin / Continue Scene ──
        const sceneBtn = wrap.querySelector('[data-act="scene"]');
        
        // ── Tools Quick Toggle ──
        const toolsBtn = wrap.querySelector('#vp-input-toggle-tools');
        toolsBtn?.addEventListener('click', () => {
            const currentMode = S.modelConfig.toolsMode;
            const nextMode = (currentMode === 'native') ? 'off' : 'native';
            S.modelConfig.toolsMode = nextMode;
            
            persistModel();

            // Studio 2.5.2: Surgical UI Update (No flicker!)
            const isActive = nextMode === 'native';
            toolsBtn.classList.toggle('active', isActive);
            toolsBtn.title = isActive ? 'Tools are ON' : 'Tools are OFF';
            const iconSpan = toolsBtn.querySelector('span');
            if (iconSpan) iconSpan.textContent = isActive ? '🔧' : '🔌';
            
            // Studio 2.5.3: Surgical Refresh 
            // We refresh the Model panel so the dropdown stays in sync, 
            // but we IGNORE the Log panel to prevent massive flicker.
            renderRegisteredPanels(['model', 'input']);
            
            VP.showToast(`Tools: ${nextMode.toUpperCase()}`, 'info');
        });

        const hasMessages = (chatApi()?.getActiveChatMessages?.() || []).some(m => m.role === 'assistant' || m.role === 'user');
        const sceneLabel = hasMessages ? 'Cont.' : 'Begin';
        sceneBtn.textContent = speakerName ? `🎬 ${sceneLabel} (${speakerName})` : `🎬 ${sceneLabel}`;
        sceneBtn.title = hasMessages
            ? `Continue scene as ${speakerName || 'active speaker'} — model picks up from current context`
            : `Begin scene as ${speakerName || 'active speaker'} — model starts from current context`;
        sceneBtn.disabled = !!S.session.running;
        sceneBtn.addEventListener('click', () => {
            if (S.session.running) return;
            const msgs = chatApi()?.getActiveChatMessages?.() || [];
            const hasChatMessages = msgs.some(m => m.role === 'assistant' || m.role === 'user');
            const userCtx = String(ta.value || '').trim();
            const prompt = hasChatMessages
                ? 'Continue the scene naturally.'
                : 'Begin the scene naturally.';
            const fullPrompt = userCtx ? `${prompt}\n\nDirector note: ${userCtx}` : prompt;
            if (S.session.input?.clearAfterSend !== false) setActiveDraft('');
            ta.value = '';
            send(fullPrompt, { skipUserAppend: true });
        });

        // ── Scenario indicator ──
        const scenarioBar = wrap.querySelector('[data-role="scenario-bar"]');
        const activeChat = chatApi()?.getActiveChat?.();
        if (activeChat?.scenario?.enabled && activeChat.scenario?.text?.trim()) {
            scenarioBar.classList.add('has-scenario');
            const indicator = document.createElement('span');
            indicator.className = 'vp-session-scenario-indicator';
            const scenarioTitle = activeChat.scenario.title?.trim() || activeChat.scenario.text.trim().slice(0, 60);
            indicator.textContent = `🎬 ${scenarioTitle}`;
            indicator.title = `${activeChat.scenario.title?.trim() || 'Scenario'}\n\n${activeChat.scenario.text.trim()}`;
            indicator.addEventListener('click', () => {
                chatApi()?.openChatEditorInteractive?.();
            });
            scenarioBar.appendChild(indicator);
        }
        container.appendChild(wrap);
    }


    function estimateTextTokens(text) {
        const s = String(text || '');
        // Rough local-model friendly estimate. Good enough for UI diagnostics.
        return Math.ceil(s.length / 4);
    }

    function sumMessageTokens(messages = []) {
        return (messages || []).reduce((n, m) => n + estimateTextTokens(m.content ?? msgText(m) ?? ''), 0);
    }

    function makeInspectorSection(title, text, meta = '') {
        const section = document.createElement('div');
        section.className = 'vp-context-section';
        const head = document.createElement('div');
        head.className = 'vp-context-section-head';
        const t = document.createElement('b');
        t.textContent = title;
        const m = document.createElement('span');
        m.textContent = meta;
        head.appendChild(t);
        head.appendChild(m);
        const pre = document.createElement('pre');
        pre.textContent = String(text || '—');
        section.appendChild(head);
        section.appendChild(pre);
        return section;
    }

    async function showContextInspector(sourceContainer = null) {
        ensureState();
        document.querySelectorAll('.vp-context-inspector-modal').forEach(el => el.remove());

        const areaBody = sourceContainer?.closest?.('.vp-shell-area-body') || null;
        const rect = areaBody?.getBoundingClientRect?.();
        const useGlobal = !rect || rect.width < 520 || rect.height < 420;
        const host = useGlobal ? document.body : areaBody;

        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop vp-context-inspector-modal' + (useGlobal ? ' global' : '');
        backdrop.style.setProperty('--vp-modal-width', useGlobal ? '820px' : `${Math.max(520, Math.min(rect.width - 24, 820))}px`);

        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card vp-context-inspector-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">🧪 Context Inspector</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-context-toolbar">
                    <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="copy">Copy report</button>
                    <span data-role="summary"></span>
                </div>
                <div class="vp-context-body"></div>
            </div>`;
        backdrop.appendChild(card);
        host.appendChild(backdrop);

        const close = () => backdrop.remove();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);

        // Make inspector modal draggable
        const head = card.querySelector('.vp-shell-modal-head');
        let isDragging = false, startX, startY, startLeft, startTop;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.vp-shell-modal-close') || e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = card.getBoundingClientRect();
            const backdropRect = backdrop.getBoundingClientRect();
            startLeft = rect.left - backdropRect.left;
            startTop = rect.top - backdropRect.top;
            card.style.margin = '0';
            card.style.position = 'absolute';
            card.style.left = `${startLeft}px`;
            card.style.top = `${startTop}px`;
            e.preventDefault();

            const onMouseMove = (ev) => {
                if (!isDragging) return;
                card.style.left = `${startLeft + (ev.clientX - startX)}px`;
                card.style.top = `${startTop + (ev.clientY - startY)}px`;
            };
            const onMouseUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        const body = card.querySelector('.vp-context-body');
        const summary = card.querySelector('[data-role="summary"]');

        const activeChat = chatApi()?.getActiveChat?.() || null;
        const speaker = chatApi()?.getActiveSpeaker?.() || null;
        const profile = speaker ? chatApi()?.getParticipantProfile?.(speaker) : null;
        const displayName = speaker ? (chatApi()?.getParticipantDisplayName?.(speaker) || profile?.name || 'Assistant') : 'Assistant';
        const profileBlock = buildProfileSystemMessage() || '';
        const requestMessages = buildRequestMessages().filter(m => !(m.role === 'assistant' && !String(m.content || '').trim()));
        const manifest = VP.buildManifest?.() || '';
        const framePreview = VP.buildFrameContextPreview?.() || '';
        const userPersona = S.config?.userPersona || '';
        const worldInfo = DB?.getBackendInfo?.() || {};

        const reportParts = [];
        const add = (title, text) => {
            const meta = `${String(text || '').length} chars · ~${estimateTextTokens(text)} tok`;
            body.appendChild(makeInspectorSection(title, text, meta));
            reportParts.push(`## ${title}\n${text || '—'}\n`);
        };

        const overview = [
            `World: ${worldInfo.worldId || 'unknown'}`,
            `Chat: ${activeChat?.title || 'none'}`,
            `Speaker: ${displayName}`,
            `Profile: ${profile?.name || 'none'}`,
            `Messages sent: ${requestMessages.length}`,
            `Approx request text tokens: ~${sumMessageTokens(requestMessages) + estimateTextTokens(manifest) + estimateTextTokens(framePreview)}`,
        ].join('\n');

        add('Overview', overview);
        add('Active profile block', profileBlock || '(No profile block: empty/default profile and no user persona)');
        add('User persona', userPersona || '(empty)');
        add('Gallery manifest preview', manifest || '(empty — no visible assets/effects context)');
        add('Frame context preview', framePreview || '(empty)');
        add('Request messages preview', requestMessages.map((m, i) => `#${i + 1} ${m.role.toUpperCase()}\n${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n\n---\n\n') || '(empty)');

        // Tool traffic section — shows recent tool calls from VPTools trace
        if (VP.tools) {
            const trace = VP.tools.getTrace(20);
            if (trace.length) {
                const toolTrafficText = trace.map(entry => {
                    const time = new Date(entry.timestamp || Date.now()).toLocaleTimeString();
                    const args = entry.args ? ` args=${JSON.stringify(entry.args).slice(0, 120)}` : '';
                    const resultInfo = entry.status === 'success'
                        ? ` → ${entry.resultSize || 0}B result`
                        : ` → ${entry.status}: ${entry.error || '?'}`;
                    return `[${time}] ${entry.tool}(${entry.source || '?'})${args}${resultInfo}`;
                }).join('\n');
                add('Tool traffic', toolTrafficText);
            } else {
                add('Tool traffic', '(No tool calls yet this session)');
            }
        }

        const approx = sumMessageTokens(requestMessages) + estimateTextTokens(manifest) + estimateTextTokens(framePreview);
        summary.textContent = `${requestMessages.length} msg · ~${approx} text tokens, images not counted`;

        card.querySelector('[data-act="copy"]').addEventListener('click', async () => {
            const text = reportParts.join('\n---\n\n');
            try { await navigator.clipboard?.writeText(text); VP.showToast?.('Context report copied', 'success'); }
            catch { VP.showToast?.('Clipboard unavailable', 'error'); }
        });
    }

    function renderLogPanel(container, ctx = {}) {
        ensureState();
        
        const messages = getActiveMessages();

        if (activeInlineMessageEditCleanup) {
            activeInlineMessageEditCleanup();
        }
        const local = ctx.getPanelState ? ctx.getPanelState({
            marginLeft: S.session.view.marginLeft || 0,
            marginRight: S.session.view.marginRight || 0,
            bubbleAlign: S.session.view.bubbleAlign || 'full',
        }) : {
            marginLeft: S.session.view.marginLeft || 0,
            marginRight: S.session.view.marginRight || 0,
            bubbleAlign: S.session.view.bubbleAlign || 'full',
        };
        // Preserve the user's scroll intent across full log rerenders.
        // If they were reading history, keep the position; if they were near
        // the bottom, keep following the newest message.
        const oldList = container.querySelector('.vp-session-log-list');
        let prevScrollTop = oldList ? oldList.scrollTop : 0;
        let wasAtBottom = S.session.view.autoScroll !== false && (oldList ? isNearBottom(oldList, 150) : true);

        // Studio 2.0: Prevent scroll jumping to top when multiple synchronous 
        // renders happen before requestAnimationFrame has a chance to restore scroll
        if (container._pendingWasAtBottom !== undefined) {
            wasAtBottom = container._pendingWasAtBottom;
            prevScrollTop = container._pendingScrollTop;
        }

        clearContainer(container);
        
        container._pendingWasAtBottom = wasAtBottom;
        container._pendingScrollTop = prevScrollTop;

        const wrap = document.createElement('div');
        wrap.className = 'vp-session-log'
            + (S.session.view.compact ? ' compact' : '')
            + (S.session.view.simpleBubbles ? ' simple-bubbles' : '')
            + (local.bubbleAlign === 'chat' ? ' align-chat' : '')
            + (local.bubbleAlign === 'inverted' ? ' align-inverted' : '')
            + ` scene-events-${S.session.view.sceneEventMode || 'compact'}`
            + (S.session.view.bubbleBlur ? ' bubble-blur' : '');
        // Log backdrop: reuse a gallery asset as the chat background.
        // No separate uploader — the gallery is the single source of images.
        const bgAsset = S.session.view.logBackground ? S.gallery?.get?.(S.session.view.logBackground) : null;
        if (bgAsset) {
            wrap.classList.add('has-backdrop');
            wrap.style.setProperty('--vp-log-backdrop', `url("${bgAsset.url || bgAsset.base64}")`);
            wrap.style.setProperty('--vp-log-backdrop-dim', `${Math.max(0, Math.min(90, Number(S.session.view.logBackgroundDim) || 0)) / 100}`);
        }
        const fontSize = Number(S.session.view.fontSize) || 13;
        const fontMap = {
            system: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
            serif: 'Georgia, "Times New Roman", serif',
            mono: 'ui-monospace, SFMono-Regular, Consolas, monospace',
        };
        wrap.style.setProperty('--vp-log-font-size', `${fontSize}px`);
        wrap.style.setProperty('--vp-log-font-family', fontMap[S.session.view.fontFamily] || fontMap.system);
        wrap.style.setProperty('--vp-avatar-size', `${Math.max(14, Math.min(64, Number(S.session.view.avatarSize) || 22))}px`);
        wrap.style.setProperty('--vp-log-margin-left', `${Math.max(0, Math.min(280, Number(local.marginLeft) || 0))}px`);
        wrap.style.setProperty('--vp-log-margin-right', `${Math.max(0, Math.min(280, Number(local.marginRight) || 0))}px`);
        wrap.innerHTML = `
            <div class="vp-session-log-toolbar">
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="toggle-raw">${S.session.view.showRaw ? 'Clean' : 'Raw'}</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="inspect">🧪 Inspect</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="events-mode">Events: ${(S.session.view.sceneEventMode || 'compact').replace(/^./, c => c.toUpperCase())}</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="regen">↻ Regen</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="stop">■ Stop</button>
                <span style="color:var(--text-secondary,#a6adc8);font-size:11px;">${messages.length} msg · ~${estimateTextTokens(messages.map(msgText).join('\n'))} tok</span>
                <span class="spacer"></span>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="bottom">↓ Bottom</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="clear">Clear</button>
            </div>
            <div class="vp-session-log-list"></div>`;
        const list = wrap.querySelector('.vp-session-log-list');
        if (!messages.length) {
            list.innerHTML = `<div class="vp-session-empty"><div style="font-size:28px;margin-bottom:8px;">💬</div><b>Session log</b><br>Здесь появятся сообщения локальной сессии. Это красивый лог/консоль, не центр сцены.</div>`;
        } else {
            let currentEventGroupContainer = null;
            for (const m of messages) {
                const sceneEvent = isSceneEventMessage(m);
                
                let containerToAppend = list;
                if (S.session.view.simpleBubbles && sceneEvent) {
                    if (!currentEventGroupContainer) {
                        currentEventGroupContainer = document.createElement('details');
                        currentEventGroupContainer.className = 'vp-scene-event-group';
                        const parsed = parseSceneEvent(m.raw || m.text);
                        const summaryText = parsed?.summary || 'System Event';
                        const icon = parsed?.type ? sceneEventIcon(parsed.type) : '🎭';
                        currentEventGroupContainer.innerHTML = `<summary class="vp-scene-event-group-summary"><span class="icon">${icon}</span> <b>System Events</b> <span class="summary-text">${escapeHtml(summaryText)}</span></summary><div class="vp-scene-event-group-body"></div>`;
                        list.appendChild(currentEventGroupContainer);
                    } else {
                        // Update the summary with the latest event so the closed spoiler shows the final outcome
                        const parsed = parseSceneEvent(m.raw || m.text);
                        if (parsed && parsed.summary) {
                            const summaryEl = currentEventGroupContainer.querySelector('.summary-text');
                            if (summaryEl) summaryEl.textContent = parsed.summary;
                            const iconEl = currentEventGroupContainer.querySelector('.icon');
                            if (iconEl) iconEl.textContent = sceneEventIcon(parsed.type);
                        }
                    }
                    containerToAppend = currentEventGroupContainer.querySelector('.vp-scene-event-group-body');
                } else {
                    currentEventGroupContainer = null;
                }

                const item = document.createElement('div');
                item.className = `vp-session-msg role-${m.role || 'assistant'} status-${m.status || 'done'}${sceneEvent ? ' scene-event' : ''}`;
                item.dataset.msgId = m.id;
                const manifestCount = Array.isArray(m.manifests) ? m.manifests.length : 0;
                const headAvatar = (sceneEvent || S.session.view.avatarStyle === 'float') ? '' : renderMessageAvatar(m);
                item.innerHTML = `
                    <div class="vp-session-msg-head">
                        ${headAvatar}
                        <span class="role">${sceneEvent ? 'SCENE EVENT' : escapeHtml(getMessageSpeakerLabel(m))}</span>
                        <span class="status" style="${m.status && m.status !== 'done' ? '' : 'display:none'}">${m.status || ''}</span>
                        ${manifestCount ? `<button class="vp-session-msg-btn vp-manifest-pill" data-act="manifests" title="Attached context manifests">📎 ${manifestCount}</button>` : ''}
                        <span class="spacer"></span>
                        <button class="vp-session-msg-btn" data-act="copy">copy</button>
                        <button class="vp-session-msg-btn" data-act="edit">edit</button>
                        <button class="vp-session-msg-btn" data-act="delete">delete</button>
                    </div>
                    <div class="vp-session-msg-body"></div>`;
                const body = item.querySelector('.vp-session-msg-body');
                setMessageBodyContent(body, m);
                item.querySelector('[data-act="manifests"]')?.addEventListener('click', () => showManifestsModal(m.id));
                item.querySelector('[data-act="copy"]').addEventListener('click', () => navigator.clipboard?.writeText(S.session.view.showRaw ? (m.raw || '') : (m.clean || m.raw || '')));
                item.querySelector('[data-act="edit"]').addEventListener('click', () => {
                    if (body.isContentEditable || body.classList.contains('is-editing')) return;

                    if (activeInlineMessageEditCleanup) {
                        activeInlineMessageEditCleanup();
                    }

                    const original = m.raw || '';
                    const listEl = item.closest('.vp-session-log-list');
                    const scrollPos = listEl ? listEl.scrollTop : 0;

                    // Seamless inline edit: keep the same bubble/body node and
                    // make it editable instead of swapping it for a textarea.
                    // Editing is always done against RAW text so hidden VP tags
                    // are not accidentally lost while the log is in Clean mode.
                    body.textContent = original;
                    body.contentEditable = 'true';
                    body.classList.add('is-editing');
                    body.focus();

                    const range = document.createRange();
                    range.selectNodeContents(body);
                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);

                    if (listEl) listEl.scrollTop = scrollPos;

                    const cleanup = () => {
                        document.removeEventListener('mousedown', onDocMouseDown, true);
                        body.removeEventListener('keydown', onKeyDown);
                        if (activeInlineMessageEditCleanup === cleanup) {
                            activeInlineMessageEditCleanup = null;
                        }
                    };
                    const finishEditMode = () => {
                        body.contentEditable = 'false';
                        body.classList.remove('is-editing');
                    };
                    const save = () => {
                        cleanup();
                        const newText = body.innerText.replace(/\u00a0/g, ' ').trimEnd();
                        finishEditMode();
                        updateMessage(m.id, { raw: newText, clean: stripVpCommands(newText), status: 'done' });
                    };
                    const cancel = () => {
                        cleanup();
                        finishEditMode();
                        // Re-render through the common path so float avatars
                        // and markdown are restored correctly.
                        setMessageBodyContent(body, m);
                    };
                    const onKeyDown = (e) => {
                        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
                        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
                    };
                    const onDocMouseDown = (ev) => {
                        // Click anywhere outside this message card commits the edit.
                        if (!item.contains(ev.target)) save();
                    };

                    body.addEventListener('keydown', onKeyDown);
                    activeInlineMessageEditCleanup = cleanup;
                    setTimeout(() => {
                        if (activeInlineMessageEditCleanup === cleanup) {
                            document.addEventListener('mousedown', onDocMouseDown, true);
                        }
                    }, 0);
                });
                item.querySelector('[data-act="delete"]').addEventListener('click', async () => {
                    const ans = await VP.showConfirm?.({
                        title: 'Delete message?',
                        message: 'Delete this message from the log?',
                        buttons: [
                            { id: 'cancel', label: 'Cancel', ghost: true },
                            { id: 'ok', label: 'Delete', danger: true },
                        ],
                    });
                    if (ans === 'ok') deleteMessage(m.id);
                });
                containerToAppend.appendChild(item);
            }
        }
        wrap.querySelector('[data-act="toggle-raw"]').addEventListener('click', () => {
            S.session.view.showRaw = !S.session.view.showRaw;
            persistSession();
            renderRegisteredPanels();
        });
        wrap.querySelector('[data-act="inspect"]').addEventListener('click', () => showContextInspector(container));
        wrap.querySelector('[data-act="regen"]').addEventListener('click', regenerateLast);
        wrap.querySelector('[data-act="stop"]').addEventListener('click', stop);
        wrap.querySelector('[data-act="stop"]').disabled = !S.session.running;
        wrap.querySelector('[data-act="events-mode"]').addEventListener('click', () => {
            const modes = ['compact', 'minimal', 'expanded'];
            const cur = S.session.view.sceneEventMode || 'compact';
            S.session.view.sceneEventMode = modes[(modes.indexOf(cur) + 1) % modes.length] || 'compact';
            persistSession();
            renderRegisteredPanels();
        });
        wrap.querySelector('[data-act="bottom"]').addEventListener('click', () => { list.scrollTop = list.scrollHeight; });
        wrap.querySelector('[data-act="clear"]').addEventListener('click', clearSession);
        container.appendChild(wrap);
        requestAnimationFrame(() => {
            if (wasAtBottom) list.scrollTop = list.scrollHeight;
            else list.scrollTop = prevScrollTop;
            
            // Clean up the intent flag so future user scrolls are respected
            if (container._pendingWasAtBottom === wasAtBottom) {
                delete container._pendingWasAtBottom;
                delete container._pendingScrollTop;
            }
        });
    }

    function renderInputSettings(container, ctx = {}) {
        ensureState();
        if (!S.session.input) S.session.input = JSON.parse(JSON.stringify(DEFAULT_SESSION.input));
        const local = ctx.getPanelState ? ctx.getPanelState({ marginLeft: S.session.input.marginLeft || 0, marginRight: S.session.input.marginRight || 0 })
                                       : { marginLeft: S.session.input.marginLeft || 0, marginRight: S.session.input.marginRight || 0 };
        clearContainer(container);
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-settings-form';
        wrap.innerHTML = `
            <label><span>Clear after send</span><input type="checkbox" data-k="clearAfterSend"></label>
            <label><span>Enter sends message</span><input type="checkbox" data-k="enterToSend"></label>
            <label><span>Input font size</span>
                <select name="fontSize" data-k="fontSize"><option value="12">Small</option><option value="13">Normal</option><option value="14">Large</option><option value="16">XL</option></select>
            </label>
            <label><span>Left margin</span><input name="marginLeft" type="range" data-k="marginLeft" min="0" max="280" step="10"></label>
            <label><span>Right margin</span><input name="marginRight" type="range" data-k="marginRight" min="0" max="280" step="10" style="direction:rtl" title="Slider follows the right edge of the text"></label>
            <div class="vp-shell-settings-note">Default is safe chat behavior: Enter adds a new line, Ctrl+Enter sends. If Enter sends is enabled, use Shift+Enter for a new line.</div>
            <div class="vp-shell-settings-note"><b>This area:</b> input margins are saved inside the current workspace area. Other input options are global.</div>
            <div class="vp-shell-settings-note">Margins reserve free space inside the Input panel — useful for very wide layouts or floating projector overlap.</div>`;
        wrap.querySelector('[data-k="clearAfterSend"]').checked = S.session.input.clearAfterSend !== false;
        wrap.querySelector('[data-k="enterToSend"]').checked = !!S.session.input.enterToSend;
        wrap.querySelector('[data-k="fontSize"]').value = String(S.session.input.fontSize || 13);
        wrap.querySelector('[data-k="marginLeft"]').value = String(local.marginLeft || 0);
        wrap.querySelector('[data-k="marginRight"]').value = String(local.marginRight || 0);
        const readInputMarginPatch = () => ({
            marginLeft: Math.max(0, Math.min(280, parseInt(wrap.querySelector('[data-k="marginLeft"]').value, 10) || 0)),
            marginRight: Math.max(0, Math.min(280, parseInt(wrap.querySelector('[data-k="marginRight"]').value, 10) || 0)),
        });
        const applyInputMarginsLive = () => {
            const localPatch = readInputMarginPatch();
            // Live preview only: update RAM/local panel state without disk persistence.
            if (ctx.setPanelState) ctx.setPanelState(localPatch, { persist: false });
            else Object.assign(S.session.input, localPatch);
            const targets = ctx.areaEl
                ? Array.from(ctx.areaEl.querySelectorAll('.vp-session-input-panel'))
                : Array.from(document.querySelectorAll('.vp-session-input-panel'));
            targets.forEach(panel => {
                panel.style.setProperty('--vp-input-margin-left', `${localPatch.marginLeft}px`);
                panel.style.setProperty('--vp-input-margin-right', `${localPatch.marginRight}px`);
            });
        };
        const apply = () => {
            S.session.input.clearAfterSend = wrap.querySelector('[data-k="clearAfterSend"]').checked;
            S.session.input.enterToSend = wrap.querySelector('[data-k="enterToSend"]').checked;
            S.session.input.fontSize = parseInt(wrap.querySelector('[data-k="fontSize"]').value, 10) || 13;
            const localPatch = readInputMarginPatch();
            if (ctx.setPanelState) ctx.setPanelState(localPatch);
            else Object.assign(S.session.input, localPatch);
            persistSession();
            renderRegisteredPanels();
        };
        wrap.querySelectorAll('select,input').forEach(el => {
            if (el.type === 'range' && (el.dataset.k === 'marginLeft' || el.dataset.k === 'marginRight')) {
                el.addEventListener('input', applyInputMarginsLive);
                el.addEventListener('change', apply);
            } else {
                el.addEventListener('change', apply);
            }
        });
        container.appendChild(wrap);
    }

    function renderLogSettings(container, ctx = {}) {
        ensureState();
        const local = ctx.getPanelState ? ctx.getPanelState({
            marginLeft: S.session.view.marginLeft || 0,
            marginRight: S.session.view.marginRight || 0,
            bubbleAlign: S.session.view.bubbleAlign || 'full',
        }) : {
            marginLeft: S.session.view.marginLeft || 0,
            marginRight: S.session.view.marginRight || 0,
            bubbleAlign: S.session.view.bubbleAlign || 'full',
        };
        clearContainer(container);
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-settings-form';
        wrap.innerHTML = `
            <label><span>Default view</span>
                <select name="viewMode" data-k="viewMode"><option value="clean">Clean</option><option value="raw">Raw</option></select>
            </label>
            <label><span>Auto-follow bottom</span><input name="autoScroll" type="checkbox" data-k="autoScroll"></label>
            <label><span>Compact messages</span><input name="compact" type="checkbox" data-k="compact"></label>
            <label><span>Sync Chat with Subtitles</span><input name="syncChatTyping" type="checkbox" data-k="syncChatTyping"></label>
            <label><span>Simple Chat Bubbles</span><input name="simpleBubbles" type="checkbox" data-k="simpleBubbles"></label>
            <label><span>Render Markdown</span><input name="markdown" type="checkbox" data-k="markdown"></label>
            <label><span>Scene events</span>
                <select name="sceneEventMode" data-k="sceneEventMode"><option value="compact">Compact + details</option><option value="minimal">Minimal</option><option value="expanded">Expanded</option></select>
            </label>
            <label><span>Event context depth</span>
                <select name="sceneEventContextDepth" data-k="sceneEventContextDepth"><option value="0">Markers only</option><option value="2">Last 2 full</option><option value="4">Last 4 full</option><option value="8">Last 8 full</option></select>
            </label>
            <label><span>Font size</span>
                <select name="fontSize" data-k="fontSize"><option value="12">Small</option><option value="13">Normal</option><option value="14">Large</option><option value="16">XL</option></select>
            </label>
            <label><span>Font family</span>
                <select name="fontFamily" data-k="fontFamily"><option value="system">System UI</option><option value="serif">Serif / novel</option><option value="mono">Monospace</option></select>
            </label>
            <label><span>Avatar position</span>
                <select name="avatarStyle" data-k="avatarStyle"><option value="head">In bubble header</option><option value="float">Float in text (wrap)</option></select>
            </label>
            <label><span>Avatar size</span><input name="avatarSize" type="range" data-k="avatarSize" min="14" max="64" step="2"></label>
            <label><span>Log background</span><select name="logBackground" data-k="logBackground"></select></label>
            <label><span>Background dim</span><input name="logBackgroundDim" type="range" data-k="logBackgroundDim" min="0" max="90" step="5"></label>
            <label><span>Frosted bubbles (blur)</span><input name="bubbleBlur" type="checkbox" data-k="bubbleBlur"></label>
            <label><span>Bubble layout</span>
                <select name="bubbleAlign" data-k="bubbleAlign"><option value="full">Full width</option><option value="chat">User right / Bot left</option><option value="inverted">User left / Bot right</option></select>
            </label>
            <label><span>Left margin</span><input name="marginLeft" type="range" data-k="marginLeft" min="0" max="280" step="10"></label>
            <label><span>Right margin</span><input name="marginRight" type="range" data-k="marginRight" min="0" max="280" step="10" style="direction:rtl" title="Slider follows the right edge of the text"></label>
            <div class="vp-shell-settings-note"><b>This area:</b> margins and bubble layout are saved inside the current workspace area. Other log options are global.</div>
            <div class="vp-shell-settings-note">Margins reserve free space inside the Log panel — useful when the projector floats over one side. Bubble layout can mimic classic chat alignment.</div>
            <div class="vp-shell-settings-note">Markdown v0 supports bold, italic, inline code and blockquotes. Raw mode always shows plain source text for safe editing/debugging.</div>`;
        const viewMode = wrap.querySelector('[data-k="viewMode"]');
        viewMode.value = S.session.view.showRaw ? 'raw' : 'clean';
        wrap.querySelector('[data-k="autoScroll"]').checked = S.session.view.autoScroll !== false;
        wrap.querySelector('[data-k="compact"]').checked = !!S.session.view.compact;
        wrap.querySelector('[data-k="syncChatTyping"]').checked = !!S.session.view.syncChatTyping;
        wrap.querySelector('[data-k="simpleBubbles"]').checked = !!S.session.view.simpleBubbles;
        wrap.querySelector('[data-k="markdown"]').checked = !!S.session.view.markdown;
        wrap.querySelector('[data-k="sceneEventMode"]').value = S.session.view.sceneEventMode || 'compact';
        wrap.querySelector('[data-k="sceneEventContextDepth"]').value = String(S.session.view.sceneEventContextDepth ?? 4);
        wrap.querySelector('[data-k="fontSize"]').value = String(S.session.view.fontSize || 13);
        wrap.querySelector('[data-k="fontFamily"]').value = S.session.view.fontFamily || 'system';
        wrap.querySelector('[data-k="avatarStyle"]').value = S.session.view.avatarStyle || 'head';
        wrap.querySelector('[data-k="avatarSize"]').value = String(S.session.view.avatarSize || 22);
        // Log background picker: sourced from gallery assets, not a separate uploader.
        {
            const sel = wrap.querySelector('[data-k="logBackground"]');
            const current = S.session.view.logBackground || '';
            const tags = Array.from(S.gallery?.keys?.() || []).filter(t => !String(t).startsWith('__')).sort();
            sel.innerHTML = `<option value="">None</option>`
                + tags.map(t => `<option value="${escapeHtml(t)}"${t === current ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('');
            if (current && !tags.includes(current)) {
                sel.insertAdjacentHTML('beforeend', `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)} (missing)</option>`);
            }
        }
        wrap.querySelector('[data-k="logBackgroundDim"]').value = String(S.session.view.logBackgroundDim ?? 40);
        wrap.querySelector('[data-k="bubbleBlur"]').checked = !!S.session.view.bubbleBlur;
        wrap.querySelector('[data-k="bubbleAlign"]').value = local.bubbleAlign || 'full';
        wrap.querySelector('[data-k="marginLeft"]').value = String(local.marginLeft || 0);
        wrap.querySelector('[data-k="marginRight"]').value = String(local.marginRight || 0);

        const readLogLocalPatch = () => ({
            bubbleAlign: wrap.querySelector('[data-k="bubbleAlign"]').value || 'full',
            marginLeft: Math.max(0, Math.min(280, parseInt(wrap.querySelector('[data-k="marginLeft"]').value, 10) || 0)),
            marginRight: Math.max(0, Math.min(280, parseInt(wrap.querySelector('[data-k="marginRight"]').value, 10) || 0)),
        });
        const applyLogMarginsLive = () => {
            const localPatch = readLogLocalPatch();
            // Live preview only: update RAM/local panel state without disk persistence.
            if (ctx.setPanelState) ctx.setPanelState(localPatch, { persist: false });
            else Object.assign(S.session.view, localPatch);

            const targets = ctx.areaEl
                ? Array.from(ctx.areaEl.querySelectorAll('.vp-session-log'))
                : Array.from(document.querySelectorAll('.vp-session-log'));
            targets.forEach(log => {
                log.style.setProperty('--vp-log-margin-left', `${localPatch.marginLeft}px`);
                log.style.setProperty('--vp-log-margin-right', `${localPatch.marginRight}px`);
            });
        };
        const apply = () => {
            S.session.view.showRaw = viewMode.value === 'raw';
            S.session.view.autoScroll = wrap.querySelector('[data-k="autoScroll"]').checked;
            S.session.view.compact = wrap.querySelector('[data-k="compact"]').checked;
            S.session.view.syncChatTyping = wrap.querySelector('[data-k="syncChatTyping"]').checked;
            S.session.view.simpleBubbles = wrap.querySelector('[data-k="simpleBubbles"]').checked;
            S.session.view.markdown = wrap.querySelector('[data-k="markdown"]').checked;
            S.session.view.sceneEventMode = wrap.querySelector('[data-k="sceneEventMode"]').value || 'compact';
            S.session.view.sceneEventContextDepth = parseInt(wrap.querySelector('[data-k="sceneEventContextDepth"]').value, 10);
            S.session.view.fontSize = parseInt(wrap.querySelector('[data-k="fontSize"]').value, 10) || 13;
            S.session.view.fontFamily = wrap.querySelector('[data-k="fontFamily"]').value || 'system';
            S.session.view.avatarStyle = wrap.querySelector('[data-k="avatarStyle"]').value || 'head';
            S.session.view.avatarSize = Math.max(14, Math.min(64, parseInt(wrap.querySelector('[data-k="avatarSize"]').value, 10) || 22));
            S.session.view.logBackground = wrap.querySelector('[data-k="logBackground"]').value || '';
            S.session.view.logBackgroundDim = Math.max(0, Math.min(90, parseInt(wrap.querySelector('[data-k="logBackgroundDim"]').value, 10) || 0));
            S.session.view.bubbleBlur = wrap.querySelector('[data-k="bubbleBlur"]').checked;
            const localPatch = readLogLocalPatch();
            if (ctx.setPanelState) ctx.setPanelState(localPatch);
            else Object.assign(S.session.view, localPatch);
            persistSession();
            
            // Studio 2.5.4: Only refresh the Log panel. Model panel stays untouched!
            renderRegisteredPanels(['log']);
        };
        // Avatar size: live-preview via CSS variable while dragging, full apply on release.
        const applyAvatarSizeLive = () => {
            const v = Math.max(14, Math.min(64, parseInt(wrap.querySelector('[data-k="avatarSize"]').value, 10) || 22));
            document.querySelectorAll('.vp-session-log').forEach(log => log.style.setProperty('--vp-avatar-size', `${v}px`));
        };
        // Backdrop dim: live-preview while dragging.
        const applyDimLive = () => {
            const v = Math.max(0, Math.min(90, parseInt(wrap.querySelector('[data-k="logBackgroundDim"]').value, 10) || 0));
            document.querySelectorAll('.vp-session-log').forEach(log => log.style.setProperty('--vp-log-backdrop-dim', `${v / 100}`));
        };
        wrap.querySelectorAll('select,input').forEach(el => {
            if (el.type === 'range' && (el.dataset.k === 'marginLeft' || el.dataset.k === 'marginRight')) {
                el.addEventListener('input', applyLogMarginsLive);
                el.addEventListener('change', apply);
            } else if (el.dataset.k === 'avatarSize') {
                el.addEventListener('input', applyAvatarSizeLive);
                el.addEventListener('change', apply);
            } else if (el.dataset.k === 'logBackgroundDim') {
                el.addEventListener('input', applyDimLive);
                el.addEventListener('change', apply);
            } else {
                el.addEventListener('change', apply);
            }
        });
        container.appendChild(wrap);
    }

    function renderModelPanel(container) {
        ensureState();
        clearContainer(container);
        const cfg = S.modelConfig;
        const wrap = document.createElement('div');
        wrap.className = 'vp-session-model';
        wrap.innerHTML = `
            <div class="vp-session-model-title">🤖 Local OpenAI-compatible model</div>
            <label>Endpoint <input name="endpoint" data-k="endpoint" placeholder="http://127.0.0.1:1234/v1/chat/completions"></label>
            <label>Model <input name="model" data-k="model" placeholder="local-model" list="vp-model-options"></label>
            <datalist id="vp-model-options"></datalist>
            <label>API key <input name="apiKey" data-k="apiKey" type="password" placeholder="optional"></label>
            <label>Temperature <input name="temperature" data-k="temperature" type="number" min="0" max="2" step="0.05"></label>
            <label>Max tokens <input name="maxTokens" data-k="maxTokens" type="number" min="1" step="1"></label>
            <label>Tools mode
                <select name="toolsMode" data-k="toolsMode">
                    <option value="off">Off</option>
                    <option value="native">Native (tool_calls)</option>
                    <!-- v26: 'text-tags' was never implemented (loop honors only 'native'); option hidden, buildServicesCard kept in code for a possible revival -->
                </select>
            </label>
            <div class="vp-session-model-note" data-role="tools-mode-hint">Tools let the model perceive the world: roll dice, search gallery, recall scenes. Actions still use [IMG:] tags.</div>
            <div class="vp-session-tools-manager" data-role="tools-manager">
                <div class="vp-session-model-note vp-session-tools-head">🧰 Tools: <b data-role="tools-count">–</b> on · ≈<span data-role="tools-tokens">0</span> tok in every request (native)</div>
                <div class="vp-session-tools-list" data-role="tools-list"></div>
            </div>
            <label>Tool loop limit <input name="toolLoopLimit" data-k="toolLoopLimit" type="number" min="1" max="10" step="1"></label>
            <label><span>Agentic loop (scene transitions)</span><input name="agenticLoop" data-k="agenticLoop" type="checkbox" title="v24: после [TAB:…]/[CAT:…] перехода модель мгновенно получает наблюдение мира и ОДНУ continuation-генерацию (глубина 1, без каскадов). Вторая генерация = дороже по времени!"></label>
            <div class="vp-session-model-note">Agentic loop: after the model enters/leaves scenes ([TAB:]/[CAT:]), it immediately SEES the result and continues once more in the same turn. Costs one extra generation only on transitions.</div>
            <div class="vp-session-model-actions">
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="preset-lmstudio">LM Studio</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="preset-localhost">localhost</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="test">Test</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="models">Load models</button>
            </div>
            <div class="vp-session-model-status" data-role="status">Ready. LM Studio default: <code>http://127.0.0.1:1234/v1/chat/completions</code></div>
            <div class="vp-session-model-note">
                Tip: if <code>localhost</code> acts weird in WebView, use <code>127.0.0.1</code>. Model settings are saved through the current storage backend.
            </div>`;

        const status = wrap.querySelector('[data-role="status"]');
        const setStatus = (text, type = 'info') => {
            status.textContent = text;
            status.classList.remove('ok', 'err', 'info');
            status.classList.add(type);
        };
        const endpointInput = wrap.querySelector('[data-k="endpoint"]');
        const modelInput = wrap.querySelector('[data-k="model"]');
        const modelOptions = wrap.querySelector('#vp-model-options');

        function endpointToModelsUrl(endpoint) {
            let url = String(endpoint || '').trim();
            if (!url) return '';
            url = url.replace(/\/chat\/completions\/?$/i, '/models');
            url = url.replace(/\/completions\/?$/i, '/models');
            if (!/\/models\/?$/i.test(url)) {
                url = url.replace(/\/$/, '') + '/models';
            }
            return url;
        }

        function currentHeaders() {
            const headers = { 'Content-Type': 'application/json' };
            const key = String(cfg.apiKey || '').trim();
            if (key) headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
            return headers;
        }

        async function fetchModels() {
            const modelsUrl = endpointToModelsUrl(cfg.endpoint || endpointInput.value);
            if (!modelsUrl) throw new Error('Endpoint is empty');
            const response = await fetch(modelsUrl, { method: 'GET', headers: currentHeaders() });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`);
            }
            const data = await response.json();
            const list = Array.isArray(data.data) ? data.data.map(x => x.id || x.name).filter(Boolean)
                : Array.isArray(data.models) ? data.models.map(x => x.id || x.name || x).filter(Boolean)
                : [];
            return list;
        }

        wrap.querySelectorAll('[data-k]').forEach(input => {
            const k = input.dataset.k;
            if (input.type === 'checkbox') input.checked = !!cfg[k];
            else input.value = cfg[k] ?? '';
            input.addEventListener('change', () => {
                if (input.type === 'checkbox') cfg[k] = input.checked;
                else if (input.type === 'number') cfg[k] = Number(input.value);
                else cfg[k] = input.value;
                persistModel();
            });
        });

        // Tools mode status hint
        const toolsStatus = wrap.querySelector('[data-role="status"]');
        const toolsHint = wrap.querySelector('[data-role="tools-mode-hint"]');
        function updateToolsHint() {
            const mode = cfg.toolsMode || 'off';
            const toolCount = VP.tools?.list?.({ enabledOnly: true })?.length || 0;
            if (mode === 'off') {
                toolsStatus.textContent = 'Tools: off. Model cannot call perception tools.';
                if (toolsHint) toolsHint.textContent = 'Disabled. The model will not see any tool definitions.';
            } else if (mode === 'native') {
                toolsStatus.textContent = `Native tools: ${toolCount} registered. Model uses OpenAI tool_calls protocol.`;
                if (toolsHint) toolsHint.textContent = `Native OpenAI tool_calls. ${toolCount} tool(s) attached to each request. Requires a model that supports function calling.`;
            } else {
                toolsStatus.textContent = `Text-tags mode: ${toolCount} services listed in [SERVICES] block. Model invokes via text.`;
                if (toolsHint) toolsHint.textContent = `Compact [SERVICES] card injected into the prompt. ${toolCount} service(s) listed. Works with any model, but less reliable.`;
            }
            toolsStatus.classList.remove('ok', 'err', 'info');
            toolsStatus.classList.add(toolCount > 0 ? 'ok' : 'info');
        }
        const toolsSelect = wrap.querySelector('[data-k="toolsMode"]');
        if (toolsSelect) {
            toolsSelect.addEventListener('change', () => {
                cfg.toolsMode = toolsSelect.value;
                persistModel();
                updateToolsHint();
            });
            // Studio 2.5.4: Instant update
            updateToolsHint();
        }

        // ── v26 Tools Manager: per-tool toggles + honest token weight ──
        // (owner: option B — docs/tools-management-audit.md). Registry flags are
        // runtime-only; cfg.disabledTools[] persists in modelConfig.
        const toolsListHost = wrap.querySelector('[data-role="tools-list"]');
        const toolTokenEstimate = (t) => Math.ceil((JSON.stringify(t.schema || {}).length + String(t.description || '').length + String(t.name || '').length) / 4);
        function renderToolsManager() {
            if (!toolsListHost) return;
            const all = VP.tools?.list?.({ enabledOnly: false }) || [];
            const cfgDisabled = new Set(Array.isArray(cfg.disabledTools) ? cfg.disabledTools : []);
            let enabledCount = 0, totalTok = 0;
            toolsListHost.innerHTML = all.length ? all.map(t => {
                const name = String(t.name || '');
                const isOn = t.enabled !== false && !cfgDisabled.has(name);
                const tok = toolTokenEstimate(t);
                if (isOn) { enabledCount++; totalTok += tok; }
                return `<label class="vp-session-tool-row${isOn ? '' : ' off'}" title="${escapeHtml(t.description || '')}"><input type="checkbox" data-tool="${escapeHtml(name)}"${isOn ? ' checked' : ''}><span class="vp-session-tool-name">${t.icon || '🔧'} ${escapeHtml(name)}</span><span class="vp-session-tool-tok">≈${tok}</span></label>`;
            }).join('') : '<div class="vp-session-model-note">No tools registered (VP Tools offline).</div>';
            const cEl = wrap.querySelector('[data-role="tools-count"]');
            const tEl = wrap.querySelector('[data-role="tools-tokens"]');
            if (cEl) cEl.textContent = `${enabledCount}/${all.length}`;
            if (tEl) tEl.textContent = String(totalTok);
        }
        renderToolsManager();
        if (toolsListHost) toolsListHost.addEventListener('change', (ev) => {
            const name = ev?.target?.dataset?.tool;
            if (!name) return;
            const on = !!ev.target.checked;
            if (on) VP.tools?.enable?.(name); else VP.tools?.disable?.(name);
            const set = new Set(Array.isArray(cfg.disabledTools) ? cfg.disabledTools : []);
            if (on) set.delete(name); else set.add(name);
            cfg.disabledTools = Array.from(set);
            if (!cfg.disabledTools.length) delete cfg.disabledTools;
            persistModel();
            VP.showToast?.(`Tool ${name}: ${on ? 'enabled' : 'disabled'} (saved)`, 'info');
            renderToolsManager();
            updateToolsHint(); // refresh "N tools attached" line with the new enabled count
        });

        wrap.querySelector('[data-act="preset-lmstudio"]').addEventListener('click', () => {
            cfg.endpoint = 'http://127.0.0.1:1234/v1/chat/completions';
            cfg.model = cfg.model || 'local-model';
            endpointInput.value = cfg.endpoint;
            modelInput.value = cfg.model;
            persistModel();
            setStatus('LM Studio preset applied', 'ok');
        });
        wrap.querySelector('[data-act="preset-localhost"]').addEventListener('click', () => {
            cfg.endpoint = 'http://localhost:1234/v1/chat/completions';
            endpointInput.value = cfg.endpoint;
            persistModel();
            setStatus('localhost preset applied', 'ok');
        });
        wrap.querySelector('[data-act="test"]').addEventListener('click', async () => {
            try {
                setStatus('Testing /v1/models...', 'info');
                const models = await fetchModels();
                setStatus(models.length ? `OK — ${models.length} model(s) found` : 'OK — server responded, model list is empty', 'ok');
                VP.showToast?.('Model server OK', 'success');
            } catch (err) {
                console.error('[VP Session] model test failed:', err);
                setStatus(`Error: ${err.message || err}`, 'err');
                VP.showToast?.('Model server test failed', 'error');
            }
        });
        wrap.querySelector('[data-act="models"]').addEventListener('click', async () => {
            try {
                setStatus('Loading models...', 'info');
                const models = await fetchModels();
                modelOptions.innerHTML = '';
                models.forEach(id => {
                    const opt = document.createElement('option');
                    opt.value = id;
                    modelOptions.appendChild(opt);
                });
                if (models.length && (!cfg.model || cfg.model === 'local-model')) {
                    cfg.model = models[0];
                    modelInput.value = cfg.model;
                    persistModel();
                }
                setStatus(models.length ? `Loaded: ${models.join(', ')}` : 'No models returned', models.length ? 'ok' : 'info');
            } catch (err) {
                console.error('[VP Session] load models failed:', err);
                setStatus(`Error: ${err.message || err}`, 'err');
            }
        });

        container.appendChild(wrap);
    }

        return {
            injectStyles, clearContainer,
            renderInputPanel, renderInputSettings,
            renderLogPanel, renderLogSettings, renderModelPanel,
            showContextInspector, makeInspectorSection,
            estimateTextTokens, sumMessageTokens,
        };
    }

    window.VP_SESSION_PANELS = { init };
})();
