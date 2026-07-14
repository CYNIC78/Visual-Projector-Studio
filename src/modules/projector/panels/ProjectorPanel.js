/**
 * @fileoverview ProjectorPanel — Blender-style projector UI panel.
 * Canvas + header + player bar + timeline. Pure ESM.
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
  const projectorMod = modules.getInstance('projector');
  const state = projectorMod?.getState?.();
  const commandBus = projectorMod?.getCommandBus?.();
  const playback = projectorMod?.getPlaybackController?.();
  const tags = projectorMod?.getTags?.();

  // ─── CSS (injected once) ───
  if (!document.getElementById('vp-projector-panel-style')) {
    const style = document.createElement('style');
    style.id = 'vp-projector-panel-style';
    style.textContent = `
      .vp-projector-panel { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--bg-primary,#11111b); font-family:system-ui,sans-serif; }
      .vp-projector-header { display:flex; align-items:center; gap:8px; height:32px; padding:0 10px; background:var(--bg-tertiary,#252540); border-bottom:1px solid var(--border,#383860); flex-shrink:0; }
      .vp-projector-title { font-weight:800; font-size:12px; color:var(--text-primary,#cdd6f4); }
      .vp-projector-tag { font-size:11px; color:var(--accent,#6c5fa6); font-family:ui-monospace,monospace; background:rgba(108,95,166,0.15); padding:2px 6px; border-radius:4px; max-width:200px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .vp-projector-spacer { flex:1; }
      .vp-projector-toolbar { display:flex; gap:4px; }
      .vp-projector-btn { width:24px; height:24px; border:0; background:transparent; color:var(--text-secondary,#a6adc8); cursor:pointer; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:12px; }
      .vp-projector-btn:hover { background:rgba(255,255,255,0.1); color:var(--text-primary,#cdd6f4); }
      .vp-projector-canvas-wrap { flex:1; position:relative; overflow:hidden; background:#050509; }
      .vp-projector-canvas { width:100%; height:100%; position:relative; }
      .vp-projector-canvas img { width:100%; height:100%; object-fit:contain; display:block; border-radius:var(--vp-asset-radius,8px); }
      .vp-projector-empty { position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; color:var(--text-secondary,#a6adc8); font-size:12px; gap:8px; pointer-events:none; }
      .vp-projector-player-bar { display:flex; align-items:center; gap:8px; height:36px; padding:0 10px; background:var(--bg-tertiary,#252540); border-top:1px solid var(--border,#383860); flex-shrink:0; flex-wrap:wrap; }
      .vp-player-status { font-size:11px; color:var(--text-secondary,#a6adc8); min-width:80px; text-align:center; font-family:ui-monospace,monospace; }
      .vp-player-status.is-live { color:#7dffbd; }
      .vp-player-status.is-playing { color:#f5c542; }
      .vp-player-spacer { flex:1; }
      .vp-player-controls { display:flex; gap:2px; }
      .vp-player-btn { width:24px; height:24px; border:0; background:transparent; color:var(--text-secondary,#a6adc8); cursor:pointer; border-radius:4px; display:flex; align-items:center; justify-content:center; font-size:11px; }
      .vp-player-btn:hover { background:rgba(255,255,255,0.1); color:var(--text-primary,#cdd6f4); }
      .vp-player-btn.active { background:var(--accent,#6c5fa6); color:#fff; }
      .vp-player-speed { display:flex; align-items:center; gap:4px; font-size:10px; color:var(--text-secondary,#a6adc8); }
      .vp-player-speed input { width:60px; }
      .vp-timeline { height:6px; background:rgba(0,0,0,0.3); position:relative; cursor:pointer; flex-shrink:0; }
      .vp-timeline-track { height:100%; position:relative; }
      .vp-timeline-progress { height:100%; background:var(--accent,#6c5fa6); width:0%; transition:width 0.1s linear; }
      .vp-timeline-marker { position:absolute; top:50%; transform:translate(-50%,-50%); width:10px; height:10px; border-radius:50%; background:var(--accent,#6c5fa6); border:2px solid var(--bg-primary,#11111b); box-shadow:0 0 6px rgba(108,95,166,0.5); pointer-events:none; z-index:1; transition:left 0.1s linear; }
      .vp-timeline.is-live .vp-timeline-marker { background:#7dffbd; }
      .vp-timeline.is-disabled { opacity:0.4; pointer-events:none; }
    `;
    document.head.appendChild(style);
  }

  // ─── Render ───
  host.innerHTML = `
    <div class="vp-projector-panel">
      <div class="vp-projector-header">
        <span class="vp-projector-title">🎭 Stage</span>
        <span class="vp-projector-tag" id="vp-tag-display">—</span>
        <div class="vp-projector-spacer"></div>
        <div class="vp-projector-toolbar">
          <button class="vp-projector-btn" id="vp-btn-fullscreen" title="Fullscreen">⛶</button>
          <button class="vp-projector-btn" id="vp-btn-settings" title="Settings">⚙</button>
        </div>
      </div>
      <div class="vp-projector-canvas-wrap" id="vp-canvas-wrap">
        <div class="vp-projector-canvas" id="vp-canvas">
          <div class="vp-projector-empty">
            <span>📷</span>
            <span>No frame — drop an asset or use [IMG:tag]</span>
          </div>
        </div>
      </div>
      <div class="vp-projector-player-bar">
        <div class="vp-player-status" id="vp-player-status" title="Status">— live —</div>
        <div class="vp-player-spacer"></div>
        <div class="vp-player-controls">
          <button class="vp-player-btn" id="vp-btn-first" title="First">⏮</button>
          <button class="vp-player-btn" id="vp-btn-prev" title="Previous">«</button>
          <button class="vp-player-btn" id="vp-btn-play" title="Play">▶</button>
          <button class="vp-player-btn" id="vp-btn-next" title="Next">»</button>
          <button class="vp-player-btn" id="vp-btn-last" title="Last / Live">⏭</button>
        </div>
        <div class="vp-player-spacer"></div>
        <div class="vp-player-speed">
          <input type="range" id="vp-speed-slider" min="0.5" max="2" step="0.1" value="1" title="Playback speed">
          <span id="vp-speed-label">1.0x</span>
        </div>
      </div>
      <div class="vp-timeline" id="vp-timeline" title="Click/drag to navigate">
        <div class="vp-timeline-track">
          <div class="vp-timeline-progress" id="vp-timeline-progress"></div>
          <div class="vp-timeline-marker" id="vp-timeline-marker"></div>
        </div>
      </div>
    </div>
  `;

  // ─── Elements ───
  const canvas = host.querySelector('#vp-canvas');
  const tagDisplay = host.querySelector('#vp-tag-display');
  const statusEl = host.querySelector('#vp-player-status');
  const btnFirst = host.querySelector('#vp-btn-first');
  const btnPrev = host.querySelector('#vp-btn-prev');
  const btnPlay = host.querySelector('#vp-btn-play');
  const btnNext = host.querySelector('#vp-btn-next');
  const btnLast = host.querySelector('#vp-btn-last');
  const speedSlider = host.querySelector('#vp-speed-slider');
  const speedLabel = host.querySelector('#vp-speed-label');
  const timeline = host.querySelector('#vp-timeline');
  const timelineProgress = host.querySelector('#vp-timeline-progress');
  const timelineMarker = host.querySelector('#vp-timeline-marker');

  // ─── State Sync ───
  let _animFrame = null;
  let _lastSync = 0;

  function sync() {
    if (!state) return;
    const now = performance.now();
    if (now - _lastSync < 50) return; // throttle
    _lastSync = now;

    // Current frame tag
    const current = state.getCurrent();
    tagDisplay.textContent = current?.tag || '—';
    tagDisplay.style.color = current ? 'var(--accent,#6c5fa6)' : 'var(--text-secondary,#a6adc8)';

    // Canvas
    if (current) {
      canvas.innerHTML = `<img src="${current.url || current.base64}" alt="${current.tag}" style="width:100%;height:100%;object-fit:contain;border-radius:var(--vp-asset-radius,8px);">`;
    } else {
      canvas.innerHTML = `<div class="vp-projector-empty"><span>📷</span><span>No frame — drop an asset or use [IMG:tag]</span></div>`;
    }

    // Playback status
    const pb = state.getPlayback?.() || {};
    const totalSlots = (pb.messages?.length || 0) + (state.getCoverTag() ? 1 : 0);
    if (pb.mode === 'playing') {
      statusEl.textContent = `▶ ${(pb.cursor || 0) + 1}/${totalSlots}`;
      statusEl.className = 'vp-player-status is-playing';
      btnPlay.textContent = '⏸';
    } else if (pb.mode === 'paused') {
      statusEl.textContent = `⏸ ${(pb.cursor || 0) + 1}/${totalSlots}`;
      statusEl.className = 'vp-player-status';
      btnPlay.textContent = '▶';
    } else {
      statusEl.textContent = '● LIVE';
      statusEl.className = 'vp-player-status is-live';
      btnPlay.textContent = '▶';
    }

    // Timeline
    if (totalSlots > 0) {
      const pct = pb.mode === 'live' || pb.cursor < 0 ? 1 : (totalSlots === 1 ? 0 : (pb.cursor || 0) / (totalSlots - 1));
      timelineProgress.style.width = `${Math.max(0, Math.min(1, pct)) * 100}%`;
      timelineMarker.style.left = `${Math.max(0, Math.min(1, pct)) * 100}%`;
      timeline.classList.toggle('is-live', pb.mode === 'live');
      timeline.classList.toggle('is-disabled', false);
    } else {
      timelineProgress.style.width = '0%';
      timelineMarker.style.left = '0%';
      timeline.classList.remove('is-live');
      timeline.classList.add('is-disabled');
    }

    // Speed
    const speed = state.getConfig?.().subtitleSpeed || 1;
    speedSlider.value = speed;
    speedLabel.textContent = `${speed.toFixed(1)}x`;
  }

  function animate() {
    sync();
    _animFrame = requestAnimationFrame(animate);
  }

  // ─── Event Listeners ───
  btnFirst.addEventListener('click', () => {
    const pb = state.getPlayback?.() || {};
    if ((pb.messages?.length || 0) === 0) {
      if (state.getCoverTag()) {
        const cover = state.getGalleryRef?.()?.get(state.getCoverTag());
        if (cover) { state.setCurrent(cover.tag, 'replay', true); pb.cursor = 0; }
      }
      return;
    }
    playback.goTo(0);
  });

  btnPrev.addEventListener('click', () => {
    const pb = state.getPlayback?.() || {};
    if ((pb.messages?.length || 0) === 0) {
      if (pb.cursor === 1 && state.getCoverTag()) {
        const cover = state.getGalleryRef?.()?.get(state.getCoverTag());
        if (cover) { state.setCurrent(cover.tag, 'replay', true); pb.cursor = 0; }
      }
      return;
    }
    if (pb.cursor === -1) playback.goTo((pb.messages?.length || 0) - 1);
    else if (pb.cursor > 0) playback.goTo(pb.cursor - 1);
  });

  btnPlay.addEventListener('click', () => {
    if (playback.getPlaybackMode?.() === 'playing') playback.pause();
    else playback.play();
  });

  btnNext.addEventListener('click', () => {
    const pb = state.getPlayback?.() || {};
    if ((pb.messages?.length || 0) === 0) {
      if (pb.cursor === 0 && state.getCoverTag() && state.getPreparedTag()) {
        const prep = state.getGalleryRef?.()?.get(state.getPreparedTag());
        if (prep) { state.setCurrent(prep.tag, 'replay', true); pb.cursor = 1; }
      }
      return;
    }
    if (pb.cursor === -1) return;
    const totalSlots = (pb.messages?.length || 0) + (state.getCoverTag() ? 1 : 0);
    if (pb.cursor >= totalSlots - 1) playback.goLive();
    else playback.goTo(pb.cursor + 1);
  });

  btnLast.addEventListener('click', () => playback.goLive());

  // Timeline click/drag
  let _timelineDragging = false;
  timeline.addEventListener('mousedown', (e) => {
    if ((state.getPlayback?.()?.messages?.length || 0) === 0) return;
    e.preventDefault(); _timelineDragging = true; timeline.classList.add('is-dragging');
    if (playback.getPlaybackMode?.() === 'playing') playback.pause();
    const track = timeline.querySelector('.vp-timeline-track');
    const jump = (ev) => {
      const rect = track.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const pb = state.getPlayback?.() || {};
      const total = (pb.messages?.length || 0) + (state.getCoverTag() ? 1 : 0);
      if (total === 0) return;
      playback.goTo(Math.round(pct * (total - 1)));
    };
    jump(e);
  });
  document.addEventListener('mousemove', (e) => { if (_timelineDragging) jump(e); });
  document.addEventListener('mouseup', () => { if (!_timelineDragging) return; _timelineDragging = false; timeline.classList.remove('is-dragging'); });

  // Speed slider
  speedSlider.addEventListener('input', (e) => {
    const val = Math.max(0.5, Math.min(2, parseFloat(e.target.value) || 1));
    state.getConfig?.().subtitleSpeed = val;
    speedLabel.textContent = `${val.toFixed(1)}x`;
    // persist debounced
    clearTimeout(speedSlider._debounce);
    speedSlider._debounce = setTimeout(() => {
      const storage = state._ctx?.storage;
      if (storage) storage.set('config', state.getConfig?.(), 'config');
    }, 400);
  });
  speedSlider.addEventListener('dblclick', () => {
    state.getConfig?.().subtitleSpeed = 1;
    speedSlider.value = 1;
    speedLabel.textContent = '1.0x';
  });

  // Settings button
  host.querySelector('#vp-btn-settings').addEventListener('click', () => {
    const shell = panelCtx.shell;
    shell?.showPanelSettings?.(host.closest('.vp-shell-area'), 'projector');
  });

  // Fullscreen
  host.querySelector('#vp-btn-fullscreen').addEventListener('click', () => {
    const area = host.closest('.vp-shell-area');
    if (area) area.classList.toggle('maximized');
  });

  // ─── Drag/Drop (delegate to gallery module) ───
  let _dragCounter = 0;
  const canvasWrap = host.querySelector('#vp-canvas-wrap');
  canvasWrap.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); _dragCounter++; showOverlay();
  });
  canvasWrap.addEventListener('dragover', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy';
  });
  canvasWrap.addEventListener('dragleave', (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    _dragCounter--; if (_dragCounter <= 0) { _dragCounter = 0; hideOverlay(); }
  });
  canvasWrap.addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.types.includes('Files')) return;
    e.preventDefault(); _dragCounter = 0; hideOverlay();
    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
    const galleryMod = panelCtx.modules.getInstance('gallery');
    if (!galleryMod?.addImageFromBlob) return;
    if (files.length === 1) {
      const tag = await galleryMod.addImageFromBlob(files[0], { source: 'user', setAsCurrent: true });
      if (tag) state._ctx?.eventBus.emit('toast', { message: `📥 Dropped "${tag}"`, type: 'success' });
    } else {
      for (const file of files) await galleryMod.addImageFromBlob(file, { source: 'user', setAsCurrent: false });
      state._ctx?.eventBus.emit('toast', { message: `📥 Added ${files.length} images`, type: 'success' });
    }
  });

  function showOverlay() {
    if (canvasWrap.querySelector('#vp-drop-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'vp-drop-overlay';
    overlay.style.cssText = `position:absolute; inset:0; background:rgba(108,95,166,0.85); display:flex; align-items:center; justify-content:center; color:white; font-size:16px; font-weight:600; border:3px dashed rgba(255,255,255,0.6); border-radius:10px; z-index:100; pointer-events:none;`;
    overlay.textContent = '📥 Drop image(s) here';
    canvasWrap.appendChild(overlay);
  }
  function hideOverlay() { canvasWrap.querySelector('#vp-drop-overlay')?.remove(); }

  // ─── Start Animation ───
  animate();

  // ─── Cleanup ───
  return () => {
    if (_animFrame) cancelAnimationFrame(_animFrame);
  };
}

export { create as ProjectorPanel };