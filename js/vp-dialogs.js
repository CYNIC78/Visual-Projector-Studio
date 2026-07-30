// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-dialogs.js                                                   ║
// ║  Visual Projector — Engine satellite: MODAL DIALOGS              ║
// ║  (showConfirm · showPrompt · showPromptPreview)                  ║
// ║                                                                  ║
// ║  Owns: the three shared modal primitives the whole studio uses   ║
// ║        for yes/no questions, text input (single/multi-line,      ║
// ║        required/trim/maxLength) and read-only prompt previews.   ║
// ║                                                                  ║
// ║  Fully self-contained: pure document.createElement building,     ║
// ║  no engine state, no deps.                                       ║
// ║                                                                  ║
// ║  Extracted from visual-projector.js (v08 refactor) — the block   ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent / "beautify": it must stay diff-verifiable      ║
// ║  against backups/07-extract-vp-templates.zip.                    ║
// ║                                                                  ║
// ║  Load order: after visual-projector.js (grouped with the other   ║
// ║  engine satellites). Consumed system-wide via the facade —       ║
// ║  VP.showConfirm / VP.showPrompt / VP.showPromptPreview keep      ║
// ║  working thanks to the engine-side delegates, which fall back    ║
// ║  to safe cancels if this file is missing.                        ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';


    function showConfirm({ title, message, buttons }) {
        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 10003; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
            const modal = document.createElement('div');
            modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 10px; padding: 20px 24px; max-width: 380px; box-shadow: 0 12px 48px rgba(0,0,0,0.7);`;
            const titleEl = document.createElement('div');
            titleEl.style.cssText = `color: var(--text-primary, #cdd6f4); font-size: 15px; font-weight: 600; margin-bottom: 8px;`;
            titleEl.textContent = title;
            const msgEl = document.createElement('div');
            msgEl.style.cssText = `color: var(--text-secondary, #8888aa); font-size: 13px; line-height: 1.5; margin-bottom: 16px;`;
            msgEl.textContent = message;
            const btnsEl = document.createElement('div');
            btnsEl.style.cssText = `display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap;`;
            let done = false;
            let onKey = null;
            const finish = (id) => {
                if (done) return;
                done = true;
                if (onKey) document.removeEventListener('keydown', onKey);
                backdrop.style.animation = 'vpFadeOut 0.15s ease forwards';
                setTimeout(() => { backdrop.remove(); resolve(id); }, 150);
            };
            buttons.forEach(btn => {
                const b = document.createElement('button');
                b.textContent = btn.label;
                b.className = `vp-btn ${btn.ghost ? 'vp-btn-ghost' : ''} ${btn.danger ? 'vp-btn-danger' : ''}`;
                b.style.cssText = `padding: 6px 12px; height: 28px; font-size: 12px;`;
                b.addEventListener('click', () => finish(btn.id));
                btnsEl.appendChild(b);
            });
            modal.appendChild(titleEl); modal.appendChild(msgEl); modal.appendChild(btnsEl);
            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish('cancel'); });
            onKey = e => { if (e.key === 'Escape') finish('cancel'); };
            document.addEventListener('keydown', onKey);
        });
    }

    function showPrompt(options = {}) {
        const {
            title = 'Input',
            message = '',
            value = '',
            placeholder = '',
            confirmLabel = 'OK',
            cancelLabel = 'Cancel',
            multiline = false,
            required = false,
            trim = true,
            maxLength = 0,
        } = options || {};

        return new Promise(resolve => {
            const backdrop = document.createElement('div');
            backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.56); z-index: 10004; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
            const modal = document.createElement('div');
            modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 12px; padding: 18px 20px; max-width: 520px; width: min(92vw, 520px); box-shadow: 0 12px 48px rgba(0,0,0,0.72); display:flex; flex-direction:column; gap:10px;`;

            const titleEl = document.createElement('div');
            titleEl.style.cssText = `color: var(--text-primary, #cdd6f4); font-size: 15px; font-weight: 700;`;
            titleEl.textContent = title;
            modal.appendChild(titleEl);

            if (message) {
                const msgEl = document.createElement('div');
                msgEl.style.cssText = `color: var(--text-secondary, #a6adc8); font-size: 12px; line-height: 1.45; white-space: pre-wrap;`;
                msgEl.textContent = message;
                modal.appendChild(msgEl);
            }

            const input = document.createElement(multiline ? 'textarea' : 'input');
            if (!multiline) input.type = 'text';
            input.value = String(value ?? '');
            input.placeholder = placeholder || '';
            if (maxLength > 0) input.maxLength = maxLength;
            input.style.cssText = `width:100%; ${multiline ? 'min-height:110px; resize:vertical;' : 'height:32px;'} background: var(--bg-tertiary, #252540); color: var(--text-primary, #cdd6f4); border:1px solid rgba(255,255,255,.14); border-radius:7px; padding:7px 9px; font: 12px ${multiline ? 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' : 'system-ui, sans-serif'}; outline:none; box-sizing:border-box;`;
            input.addEventListener('focus', () => { input.style.borderColor = 'var(--accent,#6c5fa6)'; });
            input.addEventListener('blur', () => { input.style.borderColor = 'rgba(255,255,255,.14)'; });
            modal.appendChild(input);

            const hintEl = document.createElement('div');
            hintEl.style.cssText = `min-height:14px; color: var(--error,#e05555); font-size: 11px;`;
            modal.appendChild(hintEl);

            const btnsEl = document.createElement('div');
            btnsEl.style.cssText = `display:flex; justify-content:flex-end; gap:8px; margin-top:2px;`;
            const cancelBtn = document.createElement('button');
            cancelBtn.className = 'vp-btn vp-btn-ghost';
            cancelBtn.textContent = cancelLabel;
            const okBtn = document.createElement('button');
            okBtn.className = 'vp-btn';
            okBtn.textContent = confirmLabel;
            btnsEl.appendChild(cancelBtn);
            btnsEl.appendChild(okBtn);
            modal.appendChild(btnsEl);

            let done = false;
            let onKey = null;
            const finish = (result) => {
                if (done) return;
                done = true;
                if (onKey) document.removeEventListener('keydown', onKey);
                backdrop.style.animation = 'vpFadeOut 0.15s ease forwards';
                setTimeout(() => { backdrop.remove(); resolve(result); }, 150);
            };
            const submit = () => {
                const raw = String(input.value ?? '');
                const result = trim ? raw.trim() : raw;
                if (required && !result) {
                    hintEl.textContent = 'Value is required.';
                    input.focus();
                    return;
                }
                finish(result);
            };

            cancelBtn.addEventListener('click', () => finish(null));
            okBtn.addEventListener('click', submit);
            backdrop.addEventListener('mousedown', e => { if (e.target === backdrop) finish(null); });
            onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); finish(null); return; }
                if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); }
            };
            document.addEventListener('keydown', onKey);

            backdrop.appendChild(modal);
            document.body.appendChild(backdrop);
            setTimeout(() => { input.focus(); if (!multiline) input.select(); }, 0);
        });
    }

    function showPromptPreview(title, content) {
        const backdrop = document.createElement('div');
        backdrop.style.cssText = `position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 10003; display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif; animation: vpFadeIn 0.2s ease;`;
        const modal = document.createElement('div');
        modal.style.cssText = `background: var(--bg-secondary, #1e1e2e); border: 1px solid var(--border, #383860); border-radius: 10px; padding: 16px 20px; max-width: 600px; max-height: 70vh; width: 90%; display: flex; flex-direction: column; gap: 10px; box-shadow: 0 12px 48px rgba(0,0,0,0.7);`;
        modal.innerHTML = `
            <div style="color: var(--text-primary, #cdd6f4); font-size: 13px; font-weight: 600;">${title}</div>
            <pre style="background: var(--bg-tertiary, #252540); border: 1px solid var(--border, #383860); border-radius: 4px; padding: 10px; font-family: 'Consolas','Monaco',monospace; font-size: 11px; line-height: 1.4; color: var(--text-primary, #cdd6f4); overflow: auto; max-height: 50vh; margin: 0; white-space: pre-wrap; word-wrap: break-word;"></pre>
            <div style="display: flex; justify-content: flex-end;"><button class="vp-btn" id="vp-preview-close">Close</button></div>`;
        modal.querySelector('pre').textContent = content;
        backdrop.appendChild(modal);
        document.body.appendChild(backdrop);
        const close = () => { backdrop.style.animation = 'vpFadeOut 0.15s ease forwards'; setTimeout(() => backdrop.remove(), 150); };
        modal.querySelector('#vp-preview-close').addEventListener('click', close);
        backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
        document.addEventListener('keydown', function onKey(e) { if (e.key === 'Escape') { document.removeEventListener('keydown', onKey); close(); } });
    }

    // ── Public registration (engine delegates + any module may consume) ─────
    window.VP_DIALOGS = { showConfirm, showPrompt, showPromptPreview };
})();
