/**
 * @fileoverview ProjectorSettingsPanel — settings UI for the projector.
 * Pure ESM, creates form in given container.
 */

'use strict';

/**
 * @param {HTMLElement} host
 * @param {Object} panelCtx
 * @param {Function} panelCtx.getPanelState
 * @param {Function} panelCtx.setPanelState
 * @param {Object} panelCtx.modules
 */
export async function create(host, panelCtx) {
  const { getPanelState, setPanelState, modules } = panelCtx;
  const projectorMod = modules.getInstance('projector');
  const state = projectorMod?.getState?.();

  if (!host || !state) return;

  // ─── CSS ───
  if (!document.getElementById('vp-projector-settings-style')) {
    const style = document.createElement('style');
    style.id = 'vp-projector-settings-style';
    style.textContent = `
      .vp-projector-settings { padding:12px; display:flex; flex-direction:column; gap:10px; font-size:12px; }
      .vp-setting-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .vp-setting-row > span { flex:0 0 160px; color:var(--text-secondary,#a6adc8); font-weight:500; }
      .vp-setting-row > select, .vp-setting-row > input[type="number"] {
        flex:1; max-width:200px; padding:4px 8px; border-radius:4px; border:1px solid var(--border,#383860);
        background:var(--bg-tertiary,#252540); color:var(--text-primary,#cdd6f4); font-size:12px;
      }
      .vp-setting-row > input[type="range"] { flex:1; max-width:200px; }
      .vp-setting-row .vp-range-value { min-width:36px; text-align:right; color:var(--text-secondary,#a6adc8); font-size:11px; }
      .vp-checkbox-row { display:flex; align-items:center; gap:10px; }
      .vp-checkbox-row > span { flex:0 0 160px; color:var(--text-secondary,#a6adc8); }
      .vp-checkbox-row > label { display:flex; align-items:center; gap:6px; cursor:pointer; }
      .vp-divider { height:1px; background:var(--border,#383860); margin:4px 0; }
      .vp-section-title { font-weight:700; color:var(--text-primary,#cdd6f4); margin:8px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
    `;
    document.head.appendChild(style);
  }

  // ─── Get Config ───
  const config = state.getConfig?.() || {};

  // ─── Render ───
  host.innerHTML = `
    <div class="vp-projector-settings">
      <div class="vp-section-title">Transition</div>
      <div class="vp-setting-row">
        <span>Type</span>
        <select id="vp-set-transition">
          <option value="random">🎲 Random</option>
          <option value="crossfade">Crossfade</option>
          <option value="fade">Sequential Fade</option>
          <option value="slide_left">Slide Left</option>
          <option value="slide_up">Slide Up</option>
          <option value="zoom">Zoom</option>
          <option value="pop">Pop</option>
          <option value="flip">3D Flip</option>
        </select>
      </div>
      <div class="vp-setting-row">
        <span>Fade Duration (s)</span>
        <input type="number" id="vp-set-fade" min="0" max="5" step="0.1">
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Visual Context</div>
      <div class="vp-setting-row">
        <span>Context Depth</span>
        <input type="number" id="vp-set-depth" min="0" max="30" step="1">
      </div>
      <div class="vp-setting-row">
        <span>Max History</span>
        <input type="number" id="vp-set-maxhist" min="5" max="200" step="1">
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Appearance</div>
      <div class="vp-setting-row">
        <span>Asset Corner Radius</span>
        <input type="range" id="vp-set-radius" min="0" max="32" step="1">
        <span class="vp-range-value" id="vp-radius-val"></span>
      </div>
      <div class="vp-setting-row">
        <span>Frame Label Mode</span>
        <select id="vp-set-framelabel">
          <option value="title">Asset Title</option>
          <option value="debug">Debug [IMG:tag]</option>
          <option value="hidden">Hidden</option>
        </select>
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Playback</div>
      <div class="vp-setting-row">
        <span>Subtitle Speed</span>
        <input type="range" id="vp-set-subspeed" min="0.5" max="2" step="0.1">
        <span class="vp-range-value" id="vp-subspeed-val"></span>
      </div>
      <div class="vp-setting-row">
        <span>Subtitle WPM</span>
        <input type="number" id="vp-set-wpm" min="60" max="400" step="10">
      </div>
      <div class="vp-checkbox-row">
        <span>Effects Enabled</span>
        <label><input type="checkbox" id="vp-set-fx"> Enable visual effects</label>
      </div>
      <div class="vp-checkbox-row">
        <span>Debug Tags</span>
        <label><input type="checkbox" id="vp-set-debug"> Show tag parsing debug</label>
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Image Import</div>
      <div class="vp-setting-row">
        <span>Max Long Side (px)</span>
        <input type="number" id="vp-set-maxside" min="256" max="4096" step="64">
      </div>
      <div class="vp-setting-row">
        <span>JPEG Quality</span>
        <input type="number" id="vp-set-jpeg" min="0.1" max="1" step="0.01">
      </div>
    `;

  // ─── Bind Inputs ───
  const bind = (id, key, { type = 'select', min, max, step, transform } = {}) => {
    const el = host.querySelector(`#${id}`);
    if (!el) return;
    const val = config[key];
    if (val !== undefined) {
      if (type === 'select') el.value = val;
      else if (type === 'checkbox') el.checked = val;
      else el.value = val;
    }
    const apply = () => {
      let v;
      if (type === 'checkbox') v = el.checked;
      else if (type === 'number' || type === 'range') v = parseFloat(el.value) || 0;
      else v = el.value;
      if (transform) v = transform(v);
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      if (step !== undefined && type === 'number') v = Math.round(v / step) * step;
      config[key] = v;
      state.setConfig?.(config);
      if (key === 'assetCornerRadius') applyCornerRadius(v);
    };
    el.addEventListener(type === 'checkbox' ? 'change' : 'input', apply);
    el.addEventListener('change', () => {
      const storage = state._ctx?.storage;
      if (storage) storage.set('config', config, 'config');
    });
    // Live preview for range
    if (type === 'range') {
      const valEl = host.querySelector(`#vp-radius-val, #vp-subspeed-val`);
      if (valEl) {
        el.addEventListener('input', () => { valEl.textContent = `${el.value}${key === 'subtitleSpeed' ? 'x' : 'px'}`; });
        valEl.textContent = `${el.value}${key === 'subtitleSpeed' ? 'x' : 'px'}`;
      }
    }
  };

  // Corner radius live apply
  function applyCornerRadius(px) {
    const v = Math.max(0, Math.min(32, Math.round(px)));
    document.documentElement.style.setProperty('--vp-asset-radius', `${v}px`);
    document.querySelectorAll('.vp-projector-canvas img, #vp-canvas img').forEach(img => {
      img.style.setProperty('border-radius', `${v}px`, 'important');
    });
  }

  bind('vp-set-transition', 'transitionType');
  bind('vp-set-fade', 'fadeDuration', { type: 'number', min: 0, max: 5, step: 0.1 });
  bind('vp-set-depth', 'contextDepth', { type: 'number', min: 0, max: 30 });
  bind('vp-set-maxhist', 'maxHistory', { type: 'number', min: 5, max: 200 });
  bind('vp-set-radius', 'assetCornerRadius', { type: 'range', min: 0, max: 32 });
  bind('vp-set-framelabel', 'frameLabelMode');
  bind('vp-set-subspeed', 'subtitleSpeed', { type: 'range', min: 0.5, max: 2, step: 0.1 });
  bind('vp-set-wpm', 'subtitleWPM', { type: 'number', min: 60, max: 400, step: 10 });
  bind('vp-set-fx', 'effectsEnabled', { type: 'checkbox' });
  bind('vp-set-debug', 'debugTags', { type: 'checkbox' });
  bind('vp-set-maxside', 'maxLongSide', { type: 'number', min: 256, max: 4096, step: 64 });
  bind('vp-set-jpeg', 'jpegQuality', { type: 'number', min: 0.1, max: 1, step: 0.01 });

  // Initialize range displays
  host.querySelector('#vp-radius-val').textContent = `${config.assetCornerRadius || 8}px`;
  host.querySelector('#vp-subspeed-val').textContent = `${config.subtitleSpeed || 1}x`;

  // Persist on any change
  const storage = state._ctx?.storage;
  if (storage) {
    const inputs = host.querySelectorAll('select, input');
    inputs.forEach(el => el.addEventListener('change', () => storage.set('config', config, 'config')));
  }
}

export { create as ProjectorSettingsPanel };