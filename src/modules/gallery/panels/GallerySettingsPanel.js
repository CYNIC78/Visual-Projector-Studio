/**
 * @fileoverview GallerySettingsPanel — Settings for gallery behavior.
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
  const galleryMod = modules.getInstance('gallery');
  const state = galleryMod?.getState?.();
  const assetPipeline = galleryMod?.getAssetPipeline?.();

  if (!state) { host.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Gallery not loaded</div>'; return; }

  // ─── CSS ───
  if (!document.getElementById('vp-gallery-settings-style')) {
    const style = document.createElement('style');
    style.id = 'vp-gallery-settings-style';
    style.textContent = `
      .vp-gallery-settings { padding:12px; display:flex; flex-direction:column; gap:10px; font-size:12px; }
      .vp-setting-row { display:flex; align-items:center; justify-content:space-between; gap:10px; }
      .vp-setting-row > span { flex:0 0 180px; color:var(--text-secondary,#a6adc8); font-weight:500; }
      .vp-setting-row > select, .vp-setting-row > input[type="number"] { flex:1; max-width:200px; padding:4px 8px; border-radius:4px; border:1px solid var(--border,#383860); background:var(--bg-tertiary,#252540); color:var(--text-primary,#cdd6f4); font-size:12px; }
      .vp-setting-row > input[type="range"] { flex:1; max-width:200px; }
      .vp-setting-row .vp-range-value { min-width:36px; text-align:right; color:var(--text-secondary,#a6adc8); font-size:11px; }
      .vp-checkbox-row { display:flex; align-items:center; gap:10px; }
      .vp-checkbox-row > span { flex:0 0 180px; color:var(--text-secondary,#a6adc8); }
      .vp-checkbox-row > label { display:flex; align-items:center; gap:6px; cursor:pointer; }
      .vp-divider { height:1px; background:var(--border,#383860); margin:8px 0; }
      .vp-section-title { font-weight:700; color:var(--text-primary,#cdd6f4); margin:8px 0 4px; font-size:11px; text-transform:uppercase; letter-spacing:0.05em; }
    `;
    document.head.appendChild(style);
  }

  const config = { ...state._config, ...(state._ctx?.config?.getAll?.()?.gallery || {}) };

  host.innerHTML = `
    <div class="vp-gallery-settings">
      <div class="vp-section-title">Import</div>
      <div class="vp-setting-row">
        <span>Auto-tag on load</span>
        <select id="vp-set-autotag">
          <option value="ask">Ask</option>
          <option value="always">Always</option>
          <option value="never">Never</option>
        </select>
      </div>
      <div class="vp-setting-row">
        <span>Max Long Side (px)</span>
        <input type="number" id="vp-set-maxside" min="256" max="4096" step="64">
      </div>
      <div class="vp-setting-row">
        <span>JPEG Quality</span>
        <input type="number" id="vp-set-jpeg" min="0.1" max="1" step="0.01">
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Manifest / Context</div>
      <div class="vp-checkbox-row">
        <span>Manifest descriptions</span>
        <label><input type="checkbox" id="vp-set-manifest-desc"></label>
      </div>
      <div class="vp-checkbox-row">
        <span>Directory commands</span>
        <label><input type="checkbox" id="vp-set-dir-cmds"></label>
      </div>

      <div class="vp-divider"></div>
      <div class="vp-section-title">Collage / Gallery View</div>
      <div class="vp-setting-row">
        <span>Max Height Budget</span>
        <select id="vp-set-collage-height">
          <option value="auto">Auto (from maxLongSide)</option>
          <option value="1024">1024</option>
          <option value="2048">2048</option>
          <option value="3072">3072</option>
        </select>
      </div>
    `;

  const bind = (id, key, { type = 'select', min, max, step, transform } = {}) => {
    const el = host.querySelector(`#${id}`);
    if (!el) return;
    if (config[key] !== undefined) {
      if (type === 'checkbox') el.checked = config[key];
      else el.value = config[key];
    }
    const apply = () => {
      let v;
      if (type === 'checkbox') v = el.checked;
      else if (type === 'number') v = parseFloat(el.value) || 0;
      else v = el.value;
      if (transform) v = transform(v);
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      if (step !== undefined) v = Math.round(v / step) * step;
      config[key] = v;
      state._config = config;
    };
    el.addEventListener(type === 'checkbox' ? 'change' : 'input', apply);
    el.addEventListener('change', () => {
      const storage = state._ctx?.storage;
      if (storage) storage.set('config', config, 'config');
    });
  };

  bind('vp-set-autotag', 'autoTagOnLoad');
  bind('vp-set-maxside', 'maxLongSide', { type: 'number', min: 256, max: 4096, step: 64 });
  bind('vp-set-jpeg', 'jpegQuality', { type: 'number', min: 0.1, max: 1, step: 0.01 });
  bind('vp-set-manifest-desc', 'manifestDescriptions', { type: 'checkbox' });
  bind('vp-set-dir-cmds', 'allowDirectoryCommands', { type: 'checkbox' });
  bind('vp-set-collage-height', 'collageMaxHeight', { type: 'select' });

  // Persist on change
  const storage = state._ctx?.storage;
  if (storage) {
    host.querySelectorAll('select, input').forEach(el => el.addEventListener('change', () => storage.set('config', config, 'config')));
  }
}

export { create as GallerySettingsPanel };