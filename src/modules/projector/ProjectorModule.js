/**
 * @fileoverview ProjectorModule — registers the projector engine with ModuleManager.
 * Connects ProjectorState, ManifestBuilder, PlaybackController, VPCommandBus, VPTags.
 * Provides UI panels (ProjectorPanel, ProjectorSettingsPanel).
 */

'use strict';

import { ProjectorState } from './state/ProjectorState.js';
import { VPTags } from './tags/VPTags.js';
import { ManifestBuilder } from './manifest/ManifestBuilder.js';
import { PlaybackController } from './playback/PlaybackController.js';
import { VPCommandBus } from './commands/VPCommandBus.js';

// ─── Panel Imports (lazy) ───
let _ProjectorPanel = null;
let _ProjectorSettingsPanel = null;

async function loadPanels() {
  if (!_ProjectorPanel) {
    const mod = await import('./panels/ProjectorPanel.js');
    _ProjectorPanel = mod.ProjectorPanel;
  }
  if (!_ProjectorSettingsPanel) {
    const mod = await import('./panels/ProjectorSettingsPanel.js');
    _ProjectorSettingsPanel = mod.ProjectorSettingsPanel;
  }
}

// ─── Module Definition ───
/** @type {VPModule} */
export const ProjectorModule = {
  id: 'projector',
  version: '4.0.0',
  dependencies: [], // core services provided by ModuleManager context

  async init(ctx) {
    const { eventBus, storage, config, native, modules, logger } = ctx;
    this._ctx = ctx;
    this._logger = logger.child('ProjectorModule');

    // Initialize ProjectorState with gallery reference (will be set when gallery module loads)
    this._state = ProjectorState;

    // Initialize ManifestBuilder
    this._manifest = ManifestBuilder;

    // Initialize VPTags
    this._tags = VPTags;

    // Initialize VPCommandBus
    this._commandBus = VPCommandBus;
    VPCommandBus.init({
      eventBus,
      VPTags,
      State: ProjectorState,
    });

    // Register built-in commands
    VPCommandBus.registerBuiltins({
      onImage: this._handleImage.bind(this),
      onFx: this._handleFx.bind(this),
      onDirectory: this._handleDirectory.bind(this),
      onActivity: this._handleActivity.bind(this),
    });

    // Initialize PlaybackController
    this._playback = new PlaybackController({
      emit: (event, payload) => eventBus.emit(event, payload),
      on: (event, handler) => eventBus.on(event, handler),
      getGallery: () => this._getGallery(),
      getCurrent: () => this._state.getCurrent(),
      setCurrent: (tag, source, force, transition) => this._state.setCurrent(tag, source, force, transition),
      getConfig: () => this._state.getConfig(),
      getPlaybackState: () => this._state.getPlayback(),
      setPlaybackState: (patch) => this._state._mutate?.(patch) || console.warn('[ProjectorModule] Playback state mutation not wired'),
    });

    // Wire ProjectorState to PlaybackController
    this._state._playbackController = this._playback;
    this._state._mutate = (patch) => this._playback._mutate(patch);
    this._state._gallery = () => this._getGallery();
    this._state._currentCoverTag = () => this._state.getCoverTag();
    this._state._current = () => this._state.getCurrent();
    this._state._setCurrent = (tag, source, force, transition) => this._state.setCurrent(tag, source, force, transition);
    this._state._config = () => this._state.getConfig();

    // Config watchers
    config.watch('projector.fadeDuration', (v) => this._state.getConfig().fadeDuration = v);
    config.watch('projector.transitionType', (v) => this._state.getConfig().transitionType = v);
    config.watch('projector.contextDepth', (v) => this._state.getConfig().contextDepth = v);
    config.watch('projector.maxHistory', (v) => this._state.getConfig().maxHistory = v);
    config.watch('projector.assetCornerRadius', (v) => this._state.getConfig().assetCornerRadius = v);
    config.watch('projector.frameLabelMode', (v) => this._state.getConfig().frameLabelMode = v);
    config.watch('projector.subtitleSpeed', (v) => this._state.getConfig().subtitleSpeed = v);
    config.watch('projector.subtitleWPM', (v) => this._state.getConfig().subtitleWPM = v);

    // Load panels
    await loadPanels();

    this._logger.info('ProjectorModule initialized');
  },

  async start(ctx) {
    // Restore projector state from storage
    const saved = await ctx.storage.loadPersisted('projector-state');
    if (saved) this._state.applySnapshot(saved);

    // Restore config
    const cfg = await ctx.storage.loadPersisted('config');
    if (cfg) this._state.setConfig(cfg);

    this._logger.info('ProjectorModule started');
  },

  async stop(ctx) {
    // Persist projector state
    const snapshot = this._state.getSnapshot();
    await ctx.storage.set('projector-state', snapshot, 'projector-state');
    await ctx.storage.persist('projector-state');
    this._logger.info('ProjectorModule stopped');
  },

  // ─── Internal Helpers ───
  _getGallery() {
    // Gallery module registers itself; we'll get it from modules registry
    const galleryMod = this._ctx?.modules?.getInstance('gallery');
    return galleryMod?.getGalleryRef?.() || new Map();
  },

  // ─── Command Handlers ───
  async _handleImage(cmd, meta) {
    const { tag, transition } = cmd.payload || {};
    const ok = !!tag && this._state.setCurrent(tag, meta.setCurrentSource || 'model', true, transition || null);
    if (ok && meta.showToast !== false) this._ctx.eventBus.emit('toast', { message: `▶ ${tag}`, type: 'info' });
    return { ok, tag, transition: transition || null, delayMs: ok ? 400 : 0, error: ok ? null : `Image tag not found: ${tag || '(empty)'}` };
  },

  async _handleFx(cmd, meta) {
    if (typeof this._ctx.modules.getInstance === 'function') {
      const fxMod = this._ctx.modules.getInstance('fx');
      if (fxMod?.fire) {
        fxMod.fire(cmd.payload?.name || cmd.body);
        return { ok: true, name: cmd.payload?.name || cmd.body, delayMs: 0 };
      }
    }
    return { ok: false, error: 'FX engine is not loaded' };
  },

  async _handleDirectory(cmd, meta) {
    const { entityType, action, name } = cmd.payload || {};
    const galleryMod = this._ctx.modules.getInstance('gallery');
    if (galleryMod?.TabsManager?.executeCommand) {
      galleryMod.TabsManager.executeCommand(entityType || cmd.type, action, name);
    }
    return { ok: true, entityType: entityType || cmd.type, action, name, delayMs: 0 };
  },

  async _handleActivity(cmd, meta) {
    const gamesMod = this._ctx.modules.getInstance('games');
    if (gamesMod?.processActivityCommands) {
      await gamesMod.processActivityCommands(cmd.raw, meta);
    }
    return { ok: true, delayMs: 0 };
  },

  // ─── Public API (exposed via ModuleManager.getInstance) ───
  getState() { return this._state; },
  getManifestBuilder() { return this._manifest; },
  getTags() { return this._tags; },
  getCommandBus() { return this._commandBus; },
  getPlaybackController() { return this._playback; },

  // ─── Panels ───
  getPanels() {
    return [
      {
        id: 'projector',
        title: 'Stage',
        icon: '🎭',
        order: 10,
        singleton: true,
        create: (host, panelCtx) => _ProjectorPanel.create(host, panelCtx),
        settings: {
          title: 'Stage Settings',
          icon: '🎭',
          mode: 'auto',
          minWidth: 360,
          minHeight: 270,
          width: 430,
          create: (body, panelCtx) => _ProjectorSettingsPanel.create(body, panelCtx),
        },
      },
    ];
  },
};