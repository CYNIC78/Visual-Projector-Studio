// ╔══════════════════════════════════════════════════════════════════╗
// ║  session-manifests.js                                            ║
// ║  Visual Projector — Session satellite: CONTEXT MANIFESTS         ║
// ║  (hidden notes pinned to messages, TTL-aware)                    ║
// ║                                                                  ║
// ║  Owns: the manifests domain — attachManifest, queueManifest,     ║
// ║        getManifests, removeManifest, showManifestsModal, plus    ║
// ║        the pending-queue seams (drainPendingManifests /          ║
// ║        removePendingManifestAt) that send() and the input panel  ║
// ║        drive through.                                            ║
// ║                                                                  ║
// ║  Design (unchanged):                                             ║
// ║  - attachManifest: pin to an existing message;                   ║
// ║  - queueManifest:  pin to the NEXT user message that gets sent;  ║
// ║  - TTL gives manifests a natural lifetime in model context.      ║
// ║  The queue array itself stays on shared S.session.pendingManifests║
// ║  (read-only reads elsewhere in the host remain untouched).       ║
// ║                                                                  ║
// ║  Extracted from projector-session.js (v12 refactor) — the six    ║
// ║  functions below are BYTE-VERBATIM, incl. original 4-space       ║
// ║  indent. Do not reindent: must stay diff-verifiable against      ║
// ║  backups/11-extract-session-bus-panel.zip. The two seam          ║
// ║  functions at the bottom are NEW (v12) — they replace the two    ║
// ║  direct splice sites the host used to have.                      ║
// ║                                                                  ║
// ║  Load order: BEFORE projector-session.js (satellite family of    ║
// ║  the session module — host calls init(deps) at its bridge).      ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP Session Manifests] window.VisualProjector not found.\n' +
            'Load visual-projector.js before session-manifests.js.'
        );
        return;
    }
    const S = VP.state;       // shared engine state (by reference)

    // Called ONCE by projector-session.js at its bridge site.
    // deps = { getActiveMessages, updateMessage, emitSessionEvent,
    //          persistSession, ensureState, uid, escapeHtml, renderRegisteredPanels }
    function init(deps = {}) {
        const getActiveMessages = deps.getActiveMessages;
        const updateMessage = deps.updateMessage;
        const emitSessionEvent = deps.emitSessionEvent;
        const persistSession = deps.persistSession;
        const ensureState = deps.ensureState;
        const uid = deps.uid;
        const escapeHtml = deps.escapeHtml;
        const renderRegisteredPanels = deps.renderRegisteredPanels;
        const missing = [
            ['getActiveMessages', getActiveMessages], ['updateMessage', updateMessage],
            ['emitSessionEvent', emitSessionEvent], ['persistSession', persistSession],
            ['ensureState', ensureState], ['uid', uid],
            ['escapeHtml', escapeHtml], ['renderRegisteredPanels', renderRegisteredPanels],
        ].filter(([, v]) => typeof v !== 'function').map(([k]) => k);
        if (missing.length) {
            throw new Error('[VP Session Manifests] init: missing deps: ' + missing.join(', '));
        }


    function normalizeManifestInput(text, opts = {}) {
        const t = String(text || '').trim();
        if (!t) return null;
        return {
            id: uid(),
            source: String(opts.source || 'user'),
            text: t,
            ttl: Number.isFinite(+opts.ttl) && +opts.ttl > 0 ? Math.floor(+opts.ttl) : null,
            createdAt: Date.now(),
        };
    }

    /** Attach a manifest to a message. target: message id | 'last' | 'last-user'. */
    function attachManifest(target, text, opts = {}) {
        const mnf = normalizeManifestInput(text, opts);
        if (!mnf) return null;
        const msgs = getActiveMessages();
        let msg = null;
        if (target === 'last') msg = msgs[msgs.length - 1] || null;
        else if (target === 'last-user') msg = [...msgs].reverse().find(m => m.role === 'user') || null;
        else msg = msgs.find(m => m.id === target) || null;
        if (!msg) {
            console.warn('[VP Session] attachManifest: target message not found:', target);
            return null;
        }
        updateMessage(msg.id, { manifests: [...(msg.manifests || []), mnf] });
        emitSessionEvent('session:manifests-changed', {
            reason: 'attach-manifest',
            messageId: msg.id,
            manifestId: mnf.id,
            source: mnf.source || opts.source || 'user',
            pendingCount: Array.isArray(S.session.pendingManifests) ? S.session.pendingManifests.length : 0,
        });
        return mnf;
    }

    /** Queue a manifest: it will be attached to the next appended user message. */
    function queueManifest(text, opts = {}) {
        const mnf = normalizeManifestInput(text, opts);
        if (!mnf) return null;
        ensureState();
        if (!Array.isArray(S.session.pendingManifests)) S.session.pendingManifests = [];
        S.session.pendingManifests.push(mnf);
        persistSession();
        emitSessionEvent('session:manifests-changed', {
            reason: 'queue-manifest',
            manifestId: mnf.id,
            source: mnf.source || opts.source || 'user',
            pendingCount: S.session.pendingManifests.length,
        });
        return mnf;
    }

    function getManifests(messageId) {
        const msg = getActiveMessages().find(m => m.id === messageId);
        return msg?.manifests ? [...msg.manifests] : [];
    }

    function removeManifest(messageId, manifestId) {
        const msg = getActiveMessages().find(m => m.id === messageId);
        if (!msg || !Array.isArray(msg.manifests)) return false;
        const next = msg.manifests.filter(x => x.id !== manifestId);
        if (next.length === msg.manifests.length) return false;
        updateMessage(messageId, { manifests: next });
        emitSessionEvent('session:manifests-changed', {
            reason: 'remove-manifest',
            messageId,
            manifestId,
            pendingCount: Array.isArray(S.session.pendingManifests) ? S.session.pendingManifests.length : 0,
        });
        return true;
    }

    /** Simple inspector modal for manifests pinned to a message. */
    function showManifestsModal(messageId) {
        const msgs = getActiveMessages();
        const idx = msgs.findIndex(m => m.id === messageId);
        const msg = msgs[idx];
        if (!msg) return;
        const fromEnd = msgs.length - 1 - idx;
        const list = (msg.manifests || []).map(mnf => {
            const expired = mnf.ttl != null && fromEnd >= mnf.ttl;
            const ttlLabel = mnf.ttl == null ? 'permanent' : (expired ? `ttl ${mnf.ttl} — expired` : `ttl ${mnf.ttl} (${mnf.ttl - fromEnd} left)`);
            return `<div class="vp-manifest-row${expired ? ' expired' : ''}" data-mnf-id="${mnf.id}">
                <div class="vp-manifest-row-head">
                    <span class="src">${escapeHtml(mnf.source || 'user')}</span>
                    <span class="ttl">${ttlLabel}</span>
                    <span style="flex:1"></span>
                    <button class="vp-session-msg-btn" data-mnf-del="${mnf.id}">delete</button>
                </div>
                <pre class="vp-manifest-text">${escapeHtml(mnf.text)}</pre>
            </div>`;
        }).join('') || '<div style="color:var(--text-secondary,#a6adc8); font-size:12px;">No manifests attached.</div>';

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed; inset:0; z-index:60000; background:rgba(0,0,0,.5); display:flex; align-items:center; justify-content:center;';
        const modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-secondary,#1e1e2e); border:1px solid var(--border,#383860); border-radius:10px; padding:14px 16px; width:min(92vw,560px); max-height:70vh; overflow:auto; box-shadow:0 12px 48px rgba(0,0,0,.6); display:flex; flex-direction:column; gap:10px;';
        modal.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px;">
                <b style="color:var(--text-primary,#cdd6f4); font-size:13px;">📎 Context manifests</b>
                <span style="flex:1"></span>
                <button class="vp-btn vp-btn-ghost" data-close>✕</button>
            </div>
            <div class="vp-manifest-list">${list}</div>
            <div style="color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.45;">
                Manifests are hidden system inserts pinned to this message. The model sees them next to it in context; replay/subtitles do not.
            </div>`;
        backdrop.appendChild(modal);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.remove(); });
        modal.querySelector('[data-close]').addEventListener('click', () => backdrop.remove());
        modal.querySelectorAll('[data-mnf-del]').forEach(btn => {
            btn.addEventListener('click', () => {
                removeManifest(messageId, btn.dataset.mnfDel);
                backdrop.remove();
                renderRegisteredPanels();
            });
        });
        document.body.appendChild(backdrop);
    }

    // ════════════════════════════════════════════════════════════════
    //  PENDING-QUEUE SEAMS (new in v12)
    //  The queue lives on shared S.session.pendingManifests; these two
    //  replace the host's direct splice sites (send() drain + input
    //  panel pill removal). Identical semantics, bounds-hardened.
    // ════════════════════════════════════════════════════════════════
    function drainPendingManifests() {
        if (!Array.isArray(S.session.pendingManifests)) return [];
        return S.session.pendingManifests.splice(0);
    }

    function removePendingManifestAt(idx) {
        if (!Array.isArray(S.session.pendingManifests)) return false;
        if (!Number.isInteger(idx) || idx < 0 || idx >= S.session.pendingManifests.length) return false;
        S.session.pendingManifests.splice(idx, 1);
        return true;
    }

    // v24: deterministic FSM-observation for the agentic micro-loop (dir-only,
    // depth 1). After the model's scene-transition commands are executed, the
    // continuation round gets THIS compact system note: where we are now,
    // what is visible (with real tags), and the closed-transitions menu. Pure
    // over shared S — fully testable in the smoke harness.
    function buildSceneTransitionObservation(notes = []) {
        const gd = S.galleryData || {};
        const tabs = Array.isArray(gd.tabs) ? gd.tabs : [];
        const cats = Array.isArray(gd.categories) ? gd.categories : [];
        const allAssets = S.gallery ? Array.from(S.gallery.values()) : [];
        const catNameOf = (tab) => (cats.find(c => c.id === tab?.categoryId)?.name) || null;

        const lines = ['[SCENE UPDATE] Room navigation executed.'];
        for (const n of notes) {
            if (!n || typeof n !== 'object') continue;
            const verb = n.action === 'close' ? 'close' : 'open';
            const targetName = String(n.name || '');
            if (n.entity === 'TAB') {
                const tab = tabs.find(t => (t.name || '').toLowerCase() === targetName.toLowerCase());
                if (verb === 'open' && tab) {
                    const pack = catNameOf(tab);
                    const tags = allAssets.filter(a => a.tabId === tab.id).map(a => a.tag);
                    const shown = tags.slice(0, 12).join(', ') + (tags.length > 12 ? ', …' : '');
                    lines.push(`- You enter "${tab.name}"${pack ? ` (pack "${pack}")` : ''}: ${tags.length} frame(s) now visible${shown ? ': ' + shown : ''}.`);
                    // v27: the law of the entered state repeats at the entry moment (300-cap)
                    const rules = String(tab.rules || '').trim();
                    if (rules) lines.push(`  Rules of "${tab.name}" (law of this scene): ${rules.length > 300 ? rules.slice(0, 299) + '…' : rules}`);
                } else if (verb === 'close' && tab) {
                    lines.push(`- You left "${tab.name}" (stepped back into the hall).`);
                } else if (!tab) {
                    lines.push(`- [TAB:${verb}:${targetName}] matched nothing.`);
                }
            } else if (n.entity === 'CAT') {
                const cat = cats.find(c => (c.name || '').toLowerCase() === targetName.toLowerCase());
                lines.push(cat
                    ? `- Pack "${cat.name}" ${verb === 'open' ? 'revealed' : 'packed away'}.`
                    : `- [CAT:${verb}:${targetName}] matched nothing.`);
            }
        }

        const openNow = tabs.filter(t => t.state === 'open').map(t => t.name);
        const menu = tabs.filter(t => t.state === 'collapsed').map(t => t.name);
        lines.push(`Open scenes now: ${openNow.length ? openNow.join(', ') : '(hall — none)'}`);
        lines.push(`Closed scenes (menu of transitions): ${menu.length ? menu.join(', ') : '(none)'}`);
        lines.push('The world is already updated. Continue in THIS SAME turn: describe what you see now and react. Do NOT use [TAB:…]/[CAT:…] commands again in this continuation.');
        return lines.join('\n');
    }

        return {
            attachManifest, queueManifest, getManifests, removeManifest,
            showManifestsModal,
            drainPendingManifests, removePendingManifestAt,
            buildSceneTransitionObservation,
        };
    }

    window.VP_SESSION_MANIFESTS = { init };
})();
