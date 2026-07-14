/**
 * @fileoverview GalleryPanel — Asset grid, sidebar, toolbar. Blender-style panel.
 */

'use strict';

/**
 * @param {HTMLElement} host
 * @param {Object} panelCtx
 * @param {Function} panelCtx.getPanelState
 * @param {Function} panelCtx.setPanelState
 * @param {Object} panelCtx.modules
 * @param {ShellAPI} panelCtx.shell
 */
export async function create(host, panelCtx) {
  const { getPanelState, setPanelState, modules } = panelCtx;
  const galleryMod = modules.getInstance('gallery');
  const state = galleryMod?.getState?.();
  const assetPipeline = galleryMod?.getAssetPipeline?.();
  const collageGen = galleryMod?.getCollageGenerator?.();
  const tagger = galleryMod?.getAutoTagger?.();

  if (!state) { host.innerHTML = '<div style="padding:20px;color:var(--text-secondary)">Gallery module not loaded</div>'; return; }

  // ─── CSS ───
  if (!document.getElementById('vp-gallery-panel-style')) {
    const style = document.createElement('style');
    style.id = 'vp-gallery-panel-style';
    style.textContent = `
      .vp-gallery-panel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg-secondary,#1e1e2e); font-family:system-ui,sans-serif; }
      .vp-gallery-header { display:flex; align-items:center; gap:8px; height:36px; padding:0 10px; background:var(--bg-tertiary,#252540); border-bottom:1px solid var(--border,#383860); flex-shrink:0; }
      .vp-gallery-title { font-weight:700; font-size:12px; color:var(--text-primary,#cdd6f4); }
      .vp-gallery-tabs { display:flex; gap:4px; flex:1; overflow-x:auto; }
      .vp-gallery-tab { padding:4px 10px; border-radius:4px; cursor:pointer; font-size:11px; background:transparent; color:var(--text-secondary,#a6adc8); border:0; white-space:nowrap; }
      .vp-gallery-tab:hover { background:rgba(255,255,255,0.08); color:var(--text-primary); }
      .vp-gallery-tab.active { background:var(--accent,#6c5fa6); color:#fff; }
      .vp-gallery-toolbar { display:flex; gap:6px; padding:6px 10px; background:var(--bg-tertiary); border-bottom:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; }
      .vp-gallery-btn { padding:4px 10px; border:0; background:transparent; color:var(--text-secondary); cursor:pointer; border-radius:4px; font-size:11px; display:flex; align-items:center; gap:4px; }
      .vp-gallery-btn:hover { background:rgba(255,255,255,0.1); color:var(--text-primary); }
      .vp-gallery-btn.primary { background:var(--accent); color:#fff; }
      .vp-gallery-search { flex:1; max-width:200px; padding:4px 8px; border-radius:4px; border:1px solid var(--border); background:var(--bg-primary); color:var(--text-primary); font-size:11px; }
      .vp-gallery-size { width:80px; }
      .vp-gallery-grid { flex:1; overflow:auto; display:grid; grid-template-columns:repeat(auto-fill, 100px); grid-auto-rows:100px; gap:6px; padding:8px; align-content:start; }
      .vp-gallery-item { position:relative; display:flex; flex-direction:column; border-radius:6px; overflow:hidden; background:var(--bg-tertiary); border:1px solid var(--border); cursor:grab; transition:border-color .15s, box-shadow .15s; }
      .vp-gallery-item:hover { border-color:var(--accent); box-shadow:0 4px 12px rgba(108,95,166,0.2); }
      .vp-gallery-item.dragging { opacity:0.5; cursor:grabbing; }
      .vp-gallery-item.selected { border-color:var(--accent); box-shadow:0 0 0 2px var(--accent); }
      .vp-gallery-item img { width:100%; height:100%; object-fit:cover; display:block; }
      .vp-gallery-item-tag { position:absolute; bottom:0; left:0; right:0; padding:4px 6px; font-size:10px; line-height:1.2; color:#fff; background:linear-gradient(180deg,transparent,rgba(0,0,0,0.85)); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .vp-gallery-item-actions { position:absolute; top:4px; right:4px; display:flex; gap:2px; opacity:0; transition:opacity .15s; }
      .vp-gallery-item:hover .vp-gallery-item-actions { opacity:1; }
      .vp-gallery-item-btn { width:20px; height:20px; border:0; background:rgba(0,0,0,0.6); color:#fff; border-radius:3px; cursor:pointer; display:flex; align-items:center; justify-content:center; font-size:10px; }
      .vp-gallery-item-btn:hover { background:rgba(0,0,0,0.9); }
      .vp-gallery-dropzone { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(108,95,166,0.2); border:2px dashed var(--accent); color:var(--accent); font-weight:600; font-size:12px; pointer-events:none; z-index:10; }
      .vp-gallery-sidebar { width:200px; max-height:300px; overflow:auto; background:var(--bg-tertiary); border-bottom:1px solid var(--border); flex-shrink:0; padding:8px; }
      .vp-gallery-cat { margin-bottom:8px; }
      .vp-gallery-cat-header { display:flex; align-items:center; gap:6px; padding:4px 8px; background:rgba(0,0,0,0.2); border-radius:4px; cursor:pointer; font-weight:600; font-size:12px; user-select:none; }
      .vp-gallery-cat-toggle { font-size:10px; width:14px; text-align:center; }
      .vp-gallery-cat-state { font-size:11px; cursor:pointer; }
      .vp-gallery-cat-name { flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .vp-gallery-cat-add { font-size:10px; padding:0 4px; color:var(--text-secondary); }
      .vp-gallery-cat-tabs { display:flex; flex-wrap:wrap; gap:4px; padding-left:16px; margin-top:2px; }
      .vp-gallery-tab-btn { padding:2px 8px; background:rgba(255,255,255,0.05); border-radius:12px; font-size:11px; cursor:pointer; display:flex; align-items:center; gap:4px; border:1px solid transparent; }
      .vp-gallery-tab-btn:hover { background:rgba(255,255,255,0.1); }
      .vp-gallery-tab-btn.active { background:var(--accent); color:#fff; border-color:var(--accent); }
      .vp-gallery-tab-btn .vp-tab-state { font-size:10px; }
      .vp-gallery-empty { grid-column:1/-1; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-secondary); font-size:12px; padding:20px; text-align:center; gap:8px; }
      .vp-gallery-status { padding:8px 10px; font-size:11px; color:var(--text-secondary); background:var(--bg-tertiary); border-top:1px solid var(--border); display:flex; justify-content:space-between; flex-shrink:0; }
      .vp-gallery-footer { display:flex; align-items:center; justify-content:space-between; padding:6px 10px; background:var(--bg-tertiary); border-top:1px solid var(--border); flex-shrink:0; flex-wrap:wrap; gap:6px; }
      .vp-gallery-footer .vp-btn { height:26px; padding:0 8px; font-size:11px; }
      .vp-gallery-count { font-size:11px; color:var(--text-secondary); }
      .vp-gallery-fx-controls { display:none; align-items:center; gap:6px; font-size:11px; color:var(--text-secondary); }
      .vp-gallery-fx-controls .vp-btn { height:22px; padding:0 8px; font-size:11px; }
    `;
    document.head.appendChild(style);
  }

  // ─── Render ───
  host.innerHTML = `
    <div class="vp-gallery-panel">
      <div class="vp-gallery-header">
        <span class="vp-gallery-title">📚 Gallery</span>
        <div class="vp-gallery-tabs" id="vp-gallery-tabs"></div>
        <div class="vp-gallery-toolbar">
          <button class="vp-gallery-btn" id="vp-btn-load-folder" title="Load folder">📂</button>
          <button class="vp-gallery-btn" id="vp-btn-load-file" title="Load file">📎</button>
          <button class="vp-gallery-btn" id="vp-btn-paste" title="Paste from clipboard">📋</button>
          <button class="vp-gallery-btn" id="vp-btn-autotag" title="Auto-tag with AI">✨</button>
          <button class="vp-gallery-btn primary" id="vp-btn-collage" title="Generate Gallery View">🖼️</button>
          <input type="text" class="vp-gallery-search" id="vp-search" placeholder="🔍 Search tags...">
          <input type="range" class="vp-gallery-size" id="vp-grid-size" min="60" max="180" step="10" value="100" title="Thumbnail size">
        </div>
      </div>
      <div style="display:flex; flex:1; min-height:0;">
        <div class="vp-gallery-sidebar" id="vp-sidebar"></div>
        <div style="flex:1; display:flex; flex-direction:column; min-height:0;">
          <div class="vp-gallery-grid" id="vp-grid"></div>
          <div class="vp-gallery-status" id="vp-status"></div>
          <div class="vp-gallery-footer">
            <div class="vp-gallery-footer-normal" id="vp-footer-normal">
              <div style="display:flex; gap:6px;"></div>
              <span class="vp-gallery-count" id="vp-count">0 assets</span>
            </div>
            <div class="vp-gallery-footer-selection" id="vp-footer-sel" style="display:none;">
              <div style="display:flex; gap:6px;"></div>
              <span class="vp-gallery-count" id="vp-sel-count">0 selected</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;

  // ─── Elements ───
  const tabsEl = host.querySelector('#vp-gallery-tabs');
  const sidebarEl = host.querySelector('#vp-sidebar');
  const gridEl = host.querySelector('#vp-grid');
  const searchEl = host.querySelector('#vp-search');
  const sizeEl = host.querySelector('#vp-grid-size');
  const statusEl = host.querySelector('#vp-status');
  const countEl = host.querySelector('#vp-count');
  const footerNormal = host.querySelector('#vp-footer-normal');
  const footerSel = host.querySelector('#vp-footer-sel');
  const selCountEl = host.querySelector('#vp-sel-count');

  // ─── Footer Buttons ───
  const footerBtns = {
    normal: [
      { id: 'vp-btn-load-folder', icon: '📂', title: 'Load folder' },
      { id: 'vp-btn-load-file', icon: '📎', title: 'Load file' },
      { id: 'vp-btn-paste', icon: '📋', title: 'Paste' },
      { id: 'vp-btn-autotag', icon: '✨', title: 'Auto-tag' },
      { id: 'vp-btn-collage', icon: '🖼️', title: 'Gallery View', primary: true },
      { id: 'vp-btn-export', icon: '💾', title: 'Export' },
      { id: 'vp-btn-import', icon: '📥', title: 'Import' },
    ],
    selection: [
      { id: 'vp-sel-clear', icon: '✕', title: 'Clear selection' },
      { id: 'vp-sel-delete', icon: '🗑', title: 'Delete selected', danger: true },
      { id: 'vp-sel-tag', icon: '✨', title: 'Auto-tag selection' },
      { id: 'vp-sel-export', icon: '💾', title: 'Export selection' },
    ],
  };

  function renderFooterButtons() {
    const isSel = state.selection.tags.size > 0;
    footerNormal.style.display = isSel ? 'none' : 'flex';
    footerSel.style.display = isSel ? 'flex' : 'none';

    const container = isSel ? footerSel.querySelector('div') : footerNormal.querySelector('div');
    const btns = isSel ? footerBtns.selection : footerBtns.normal;
    container.innerHTML = '';
    for (const b of btns) {
      const btn = document.createElement('button');
      btn.className = `vp-btn vp-gallery-btn${b.primary ? ' primary' : ''}${b.danger ? ' vp-btn-danger' : ''}`;
      btn.id = b.id;
      btn.title = b.title;
      btn.innerHTML = b.icon;
      container.appendChild(btn);
    }
    // Re-bind
    bindFooterButtons();
  }

  function bindFooterButtons() {
    host.querySelector('#vp-btn-load-folder')?.addEventListener('click', loadFolder);
    host.querySelector('#vp-btn-load-file')?.addEventListener('click', loadFile);
    host.querySelector('#vp-btn-paste')?.addEventListener('click', pasteFromClipboard);
    host.querySelector('#vp-btn-autotag')?.addEventListener('click', () => tagger?.tagAll?.());
    host.querySelector('#vp-btn-collage')?.addEventListener('click', generateCollage);
    host.querySelector('#vp-btn-export')?.addEventListener('click', exportAll);
    host.querySelector('#vp-btn-import')?.addEventListener('click', importJson);
    host.querySelector('#vp-sel-clear')?.addEventListener('click', clearSelection);
    host.querySelector('#vp-sel-delete')?.addEventListener('click', deleteSelection);
    host.querySelector('#vp-sel-tag')?.addEventListener('click', () => {
      const tags = Array.from(state.selection.tags);
      if (tags.length) tagger?.tagAll?.(tags);
    });
    host.querySelector('#vp-sel-export')?.addEventListener('click', () => exportSelection(state.selection.tags));
  }

  // ─── Sidebar Render ───
  function renderSidebar() {
    let html = '';
    for (const cat of state.categories) {
      const catTabs = state.tabs.filter(t => t.categoryId === cat.id);
      const catAssetsCount = Array.from(state.assets.values()).filter(a => catTabs.some(t => t.id === a.tabId)).length;
      const stateIcons = { open: '🟢', collapsed: '🟡', locked: '🔴' };
      const catCollapsed = !!cat.uiCollapsed;
      html += `<div class="vp-gallery-cat" data-cat-id="${cat.id}">
        <div class="vp-gallery-cat-header">
          <span class="vp-gallery-cat-toggle">${catCollapsed ? '▶' : '▼'}</span>
          <span class="vp-gallery-cat-state state-${cat.state}">${stateIcons[cat.state]}</span>
          <span class="vp-gallery-cat-name">${cat.name}</span>
          <span class="vp-badge">${catAssetsCount}</span>
          <span class="vp-gallery-cat-add" data-cat="${cat.id}">+ tab</span>
        </div>`;
      if (!catCollapsed && catTabs.length) {
        html += '<div class="vp-gallery-cat-tabs">';
        for (const tab of catTabs) {
          const isActive = state.activeTabId === tab.id;
          const tabIcons = { open: '🟢', collapsed: '🟡', locked: '🔴' };
          let inherited = '', titleNote = '';
          if (cat.state === 'locked') { inherited = ' inherited-locked'; titleNote = ' [Category Locked]'; }
          else if (cat.state === 'collapsed') { inherited = ' inherited-collapsed'; titleNote = ' [Category Collapsed]'; }
          const tabAssetsCount = Array.from(state.assets.values()).filter(a => a.tabId === tab.id).length;
          const collageIcon = tab.markedForCollage ? '<span style="font-size:9px;color:#f0b450;margin-left:3px;">🖼️</span>' : '';
          html += `<button class="vp-gallery-tab-btn${isActive ? ' active' : ''}${inherited}" data-tab="${tab.id}" title="${tab.desc || 'Tab'}${titleNote}">
            <span class="vp-tab-state">${tabIcons[tab.state]}</span>
            ${tab.name}${collageIcon}
            <span class="vp-badge">${tabAssetsCount}</span>
          </button>`;
        }
        html += '</div>';
      }
      html += '</div>';
    }
    if (!state.categories.length) {
      html = '<div style="padding:16px 10px;text-align:center;color:var(--text-secondary);font-size:11px;line-height:1.5;">📂<br>Drop folder or press + to create category</div>';
    }
    sidebarEl.innerHTML = html;
    bindSidebar();
  }

  function bindSidebar() {
    sidebarEl.querySelectorAll('.vp-gallery-cat-toggle').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const cat = state.categories.find(c => c.id === btn.closest('.vp-gallery-cat').dataset.catId); if (cat) { cat.uiCollapsed = !cat.uiCollapsed; renderSidebar(); } });
    });
    sidebarEl.querySelectorAll('.vp-gallery-cat-state').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const cat = state.categories.find(c => c.id === btn.closest('.vp-gallery-cat').dataset.catId); if (cat) { if (cat.state === 'open') cat.state = 'collapsed'; else if (cat.state === 'collapsed') cat.state = 'locked'; else cat.state = 'open'; renderSidebar(); } });
    });
    sidebarEl.querySelectorAll('.vp-gallery-cat-add').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); createTab(btn.dataset.cat); });
    });
    sidebarEl.querySelectorAll('.vp-gallery-tab-btn').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); const tabId = btn.dataset.tab; if (tabId === 'effects') state.activeTabId = 'effects'; else { state.activeTabId = tabId; } renderSidebar(); renderGrid(); });
    });
    sidebarEl.querySelectorAll('.vp-gallery-cat-header').forEach(h => {
      h.addEventListener('dblclick', e => {
        e.stopPropagation(); const catId = h.closest('.vp-gallery-cat').dataset.catId; const cat = state.categories.find(c => c.id === catId);
        const name = prompt('Rename category:', cat?.name || '');
        if (name && name.trim()) { cat.name = name.trim(); renderSidebar(); }
      });
    });
  }

  // ─── Tabs Render ───
  function renderTabs() {
    tabsEl.innerHTML = '';
    // Effects tab
    const fxActive = state.activeTabId === 'effects';
    tabsEl.innerHTML += `<button class="vp-gallery-tab${fxActive ? ' active' : ''}" data-tab="effects">✨ Effects</button>`;
    for (const cat of state.categories) {
      const catTabs = state.tabs.filter(t => t.categoryId === cat.id);
      for (const tab of catTabs) {
        const active = state.activeTabId === tab.id;
        tabsEl.innerHTML += `<button class="vp-gallery-tab${active ? ' active' : ''}" data-tab="${tab.id}">${tab.name}</button>`;
      }
    }
    tabsEl.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => { state.activeTabId = btn.dataset.tab; renderTabs(); renderGrid(); renderSidebar(); });
    });
  }

  // ─── Grid Render ───
  function renderGrid() {
    const size = parseInt(sizeEl.value) || 100;
    gridEl.style.gridTemplateColumns = `repeat(auto-fill, ${size}px)`;
    gridEl.style.gridAutoRows = `${size}px`;

    const filter = searchEl.value.toLowerCase().trim();
    const activeTabId = state.activeTabId;
    let assets = Array.from(state.assets.values()).filter(a => {
      if (activeTabId === 'effects') return false;
      if (a.tabId !== activeTabId) return false;
      return !filter || a.tag.includes(filter);
    }).sort((a, b) => a.tag.localeCompare(b.tag));

    gridEl.innerHTML = '';
    if (!state.tabs.length && activeTabId !== 'effects') {
      gridEl.innerHTML = '<div class="vp-gallery-empty" style="grid-column:1/-1">📂 Gallery empty — drop folder or press +</div>';
      updateCount(0); return;
    }
    if (assets.length === 0) {
      gridEl.innerHTML = '<div class="vp-gallery-empty" style="grid-column:1/-1">No assets in this tab</div>';
      updateCount(0); return;
    }

    updateCount(assets.length);

    for (const asset of assets) {
      const item = document.createElement('div');
      item.className = 'vp-gallery-item' + (state.selection.tags.has(asset.tag) ? ' selected' : '');
      item.draggable = true;
      item.dataset.tag = asset.tag;

      const img = document.createElement('img');
      img.src = asset.thumbUrl || asset.url;
      img.alt = asset.tag;
      img.draggable = false;

      const tagEl = document.createElement('div');
      tagEl.className = 'vp-gallery-item-tag';
      tagEl.textContent = asset.tag;
      tagEl.title = asset.description || asset.tag;

      const actions = document.createElement('div');
      actions.className = 'vp-gallery-item-actions';
      actions.innerHTML = `<button class="vp-gallery-item-btn" data-act="delete" title="Delete">🗑</button>`;
      actions.querySelector('[data-act="delete"]').addEventListener('click', e => { e.stopPropagation(); deleteAsset(asset.tag); });

      // Drag to insert [IMG:tag]
      item.addEventListener('dragstart', e => {
        e.dataTransfer.clearData();
        let tags = [asset.tag];
        if (state.selection.tags.has(asset.tag)) tags = Array.from(state.selection.tags);
        e.dataTransfer.setData('text/plain', tags.map(t => `[IMG:${t}]`).join(' ') + ' ');
        e.dataTransfer.setData('vp/asset-move-batch', JSON.stringify(tags));
        e.dataTransfer.effectAllowed = 'copyMove';
      });

      // Drag to move to another tab
      item.addEventListener('dragover', e => {
        if (e.dataTransfer.types.includes('vp/asset-move-batch')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; item.classList.add('vp-gallery-dropzone'); }
      });
      item.addEventListener('dragleave', () => item.classList.remove('vp-gallery-dropzone'));
      item.addEventListener('drop', async e => {
        if (!e.dataTransfer.types.includes('vp/asset-move-batch')) return;
        e.preventDefault(); item.classList.remove('vp-gallery-dropzone');
        const tags = JSON.parse(e.dataTransfer.getData('vp/asset-move-batch') || '[]');
        await moveAssetsToTab(tags, activeTabId);
      });

      item.addEventListener('click', e => handleAssetClick(asset.tag, e));
      item.addEventListener('dblclick', () => loadAsset(asset.tag));

      item.appendChild(img);
      item.appendChild(tagEl);
      item.appendChild(actions);
      gridEl.appendChild(item);
    }
    updateSelectionUI();
  }

  function updateCount(n) {
    countEl.textContent = `${n} asset${n===1?'':'s'}`;
  }

  function updateSelectionUI() {
    const n = state.selection.tags.size;
    selCountEl.textContent = `${n} selected`;
    renderFooterButtons();
  }

  // ─── Actions ───
  async function loadFolder() {
    const input = document.createElement('input');
    input.type = 'file'; input.webkitdirectory = true;
    input.onchange = async e => {
      const files = Array.from(e.target.files).filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      state._ctx.eventBus.emit('toast', { message: `Loading ${files.length} files…`, type: 'info' });
      let loaded = 0;
      const batch = [];
      for (const file of files) {
        try {
          const { blob, url } = await assetPipeline.fileToBlobData(file);
          const thumbUrl = await assetPipeline.generateThumbUrl(blob);
          const parts = file.webkitRelativePath.split('/');
          let tabId = null;
          if (parts.length > 1) {
            const root = parts[0], parent = parts[parts.length - 2];
            let catId = state.categories.find(c => c.name === root)?.id;
            if (!catId) { catId = 'cat_' + Date.now(); state.categories.push({ id: catId, name: root, desc: '', state: 'open' }); }
            let tab = state.tabs.find(t => t.categoryId === catId && t.name === parent);
            if (!tab) { tab = { id: 'tab_' + Date.now() + Math.random().toString(36).slice(2,5), categoryId: catId, name: parent, desc: '', state: 'open' }; state.tabs.push(tab); }
            tabId = tab.id;
          } else {
            tabId = state.tabs[0]?.id || 'tab_' + Date.now();
          }
          const tag = state.sanitizeTag(file.name.toLowerCase().replace(/\.[^.]+$/, ''));
          const finalTag = state.getUniqueImportedTag(tag, state.assets);
          const asset = { tag: finalTag, filename: file.name, path: file.webkitRelativePath, blob, url, thumbUrl, description: '', source: 'user', folderContext: parts.length >= 2 ? state.sanitizeTag(parts[parts.length - 2]) : null, tabId, hidden: false };
          state.assets.set(finalTag, asset);
          batch.push(asset);
          loaded++;
        } catch (err) { console.error('[Gallery] Load error:', file.name, err); }
      }
      if (batch.length) {
        state._ctx.eventBus.emit('toast', { message: `Loaded ${loaded} assets`, type: 'success' });
        renderTabs(); renderSidebar(); renderGrid();
      }
    };
    input.click();
  }

  async function loadFile() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const { blob, url } = await assetPipeline.fileToBlobData(file);
        const thumbUrl = await assetPipeline.generateThumbUrl(blob);
        const tag = state.sanitizeTag(file.name.toLowerCase().replace(/\.[^.]+$/, ''));
        const finalTag = state.getUniqueImportedTag(tag, state.assets);
        const asset = { tag: finalTag, filename: file.name, path: file.name, blob, url, thumbUrl, description: '', source: 'user', tabId: state.tabs[0]?.id, hidden: false };
        state.assets.set(finalTag, asset);
        state._ctx.eventBus.emit('toast', { message: `Loaded ${finalTag}`, type: 'success' });
        renderGrid();
      } catch (err) { state._ctx.eventBus.emit('toast', { message: 'Load failed', type: 'error' }); }
    };
    input.click();
  }

  async function pasteFromClipboard() {
    if (!navigator.clipboard?.read) { state._ctx.eventBus.emit('toast', { message: 'Clipboard API not supported', type: 'error' }); return; }
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(t => t.startsWith('image/'));
        if (imageType) {
          const blob = await item.getType(imageType);
          const result = await assetPipeline.addImageFromBlob(blob, { source: 'pasted', setAsCurrent: true });
          if (result) state._ctx.eventBus.emit('toast', { message: `Pasted as ${result.tag}`, type: 'success' });
        }
      }
    } catch (err) { state._ctx.eventBus.emit('toast', { message: 'Paste failed', type: 'error' }); }
  }

  async function generateCollage() {
    await collageGen?.generate?.(state);
    renderGrid(); renderSidebar();
  }

  function loadAsset(tag) {
    state._ctx.eventBus.emit('projector:set-current', { tag, source: 'user' });
    state._ctx.eventBus.emit('toast', { message: `▶ ${tag}`, type: 'success' });
  }

  async function deleteAsset(tag) {
    const ans = confirm(`Delete asset "${tag}"?`);
    if (!ans) return;
    state.deleteAsset(tag);
    state.selection.tags.delete(tag);
    if (state.selection.anchor === tag) state.selection.anchor = null;
    renderGrid(); renderSidebar();
  }

  function handleAssetClick(tag, evt) {
    const sel = state.selection;
    if (evt.shiftKey && sel.anchor) {
      const visible = Array.from(state.assets.keys()).filter(t => state.assets.get(t).tabId === state.activeTabId).sort();
      const i1 = visible.indexOf(sel.anchor), i2 = visible.indexOf(tag);
      if (i1 !== -1 && i2 !== -1) { const [from, to] = i1 < i2 ? [i1, i2] : [i2, i1]; for (let i = from; i <= to; i++) sel.tags.add(visible[i]); }
      else sel.tags.add(tag);
    } else if (evt.ctrlKey || evt.metaKey) {
      if (sel.tags.has(tag)) sel.tags.delete(tag); else sel.tags.add(tag);
      sel.anchor = tag;
    } else {
      if (sel.tags.size === 1 && sel.tags.has(tag)) { sel.tags.clear(); sel.anchor = null; }
      else { sel.tags.clear(); sel.tags.add(tag); sel.anchor = tag; }
    }
    renderGrid();
  }

  function clearSelection() { state.selection.tags.clear(); state.selection.anchor = null; renderGrid(); }

  async function deleteSelection() {
    const tags = Array.from(state.selection.tags);
    if (!tags.length) return;
    if (!confirm(`Delete ${tags.length} assets?`)) return;
    state.deleteAssets(tags);
    state.selection.tags.clear(); state.selection.anchor = null;
    renderGrid(); renderSidebar();
    state._ctx.eventBus.emit('toast', { message: `Deleted ${tags.length}`, type: 'success' });
  }

  function exportAll() { exportSelection(Array.from(state.assets.keys())); }
  function exportSelection(tags) {
    const assets = tags.map(t => state.assets.get(t)).filter(Boolean);
    if (!assets.length) return;
    assetPipeline.exportAssetsToJson(assets).then(blob => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `vp-gallery-${Date.now()}.json`; a.click();
      URL.revokeObjectURL(url);
    });
  }

  function importJson() {
    const input = document.createElement('input'); input.type = 'file'; input.accept = '.json';
    input.onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.assets)) return;
        for (const asset of data.assets) {
          const blob = await assetPipeline.importAssetPayloadToBlob(asset);
          const url = URL.createObjectURL(blob);
          const thumbUrl = await assetPipeline.generateThumbUrl(blob);
          const finalTag = state.getUniqueImportedTag(asset.tag, state.assets);
          const rec = { ...asset, tag: finalTag, blob, url, thumbUrl, base64: undefined, hidden: false };
          state.assets.set(finalTag, rec);
        }
        renderTabs(); renderSidebar(); renderGrid();
        state._ctx.eventBus.emit('toast', { message: `Imported ${data.assets.length} assets`, type: 'success' });
      } catch (err) { state._ctx.eventBus.emit('toast', { message: 'Import failed', type: 'error' }); }
    };
    input.click();
  }

  // ─── Event Listeners ───
  searchEl.addEventListener('input', renderGrid);
  sizeEl.addEventListener('input', () => { gridEl.style.gridTemplateColumns = `repeat(auto-fill, ${sizeEl.value}px)`; gridEl.style.gridAutoRows = `${sizeEl.value}px`; });

  // ─── Init ───
  renderTabs(); renderSidebar(); renderGrid(); renderFooterButtons();
}

export { create as GalleryPanel };