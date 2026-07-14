/**
 * @fileoverview GalleryModule — Main gallery module registration.
 * Asset management, categories/tabs, collage generation, auto-tagging.
 */

'use strict';

import { GalleryState } from './state/GalleryState.js';
import { AssetPipeline } from './asset-pipeline/AssetPipeline.js';
import { CollageGenerator } from './collage/CollageGenerator.js';
import { AutoTagger } from './tagger/AutoTagger.js';

let _GalleryPanel = null;
let _GallerySettingsPanel = null;

async function loadPanels() {
  if (!_GalleryPanel) { const mod = await import('./panels/GalleryPanel.js'); _GalleryPanel = mod.GalleryPanel; }
  if (!_GallerySettingsPanel) { const mod = await import('./panels/GallerySettingsPanel.js'); _GallerySettingsPanel = mod.GallerySettingsPanel; }
}

/** @type {VPModule} */
export const GalleryModule = {
  id: 'gallery',
  version: '2.0.0',
  dependencies: ['projector'],

  async init(ctx) {
    const { eventBus, storage, config, native, modules, logger } = ctx;
    this._ctx = ctx;
    this._logger = logger?.child?.('GalleryModule') || { 
      info: (...args) => console.log('[GalleryModule]', ...args),
      debug: (...args) => console.debug('[GalleryModule]', ...args),
      warn: (...args) => console.warn('[GalleryModule]', ...args),
      error: (...args) => console.error('[GalleryModule]', ...args),
    };
    this._state = GalleryState;
    this._assetPipeline = AssetPipeline;
    this._collageGen = CollageGenerator;
    this._tagger = AutoTagger;

    // Initialize subsystems
    AssetPipeline.setConfig(config.gallery || {});
    AutoTagger.init({
      emit: (event, payload) => eventBus.emit(event, payload),
      getGalleryState: () => GalleryState,
      getModelConfig: () => config.session || {},
      getAssetPipeline: () => AssetPipeline,
    });

    // Expose state getters for other modules
    GalleryState._ctx = ctx;
    GalleryState._assetPipeline = AssetPipeline;
    GalleryState._collageGen = CollageGenerator;
    GalleryState._tagger = AutoTagger;

    // Wire event bus handlers
    eventBus.on('projector:set-current', ({ tag, source }) => {
      GalleryState.setCurrent?.(tag, source || 'model');
    });

    eventBus.on('gallery:asset-added', ({ asset }) => {
      GalleryState.addAsset(asset);
    });

    eventBus.on('gallery:collage-generated', ({ asset }) => {
      GalleryState.addAsset(asset);
    });

    // Load panels
    await loadPanels();

    this._logger.info('GalleryModule initialized');
  },

  async start(ctx) {
    // Ensure logger exists
    this._logger = this._logger || {
      info: (...args) => console.log('[GalleryModule]', ...args),
      debug: (...args) => console.debug('[GalleryModule]', ...args),
      warn: (...args) => console.warn('[GalleryModule]', ...args),
      error: (...args) => console.error('[GalleryModule]', ...args),
    };
    // Restore gallery state from storage
    const saved = await ctx.storage.loadPersisted('gallery-state');
    if (saved) {
      if (saved.assets) for (const [tag, asset] of Object.entries(saved.assets)) GalleryState.assets.set(tag, asset);
      if (saved.categories) GalleryState.categories = saved.categories;
      if (saved.tabs) GalleryState.tabs = saved.tabs;
      if (saved.activeTabId) GalleryState.activeTabId = saved.activeTabId;
      if (saved.tagAliases) GalleryState.tagAliases = saved.tagAliases;
    }

    // Restore config
    const cfg = await ctx.storage.loadPersisted('config');
    if (cfg?.gallery) {
      GalleryState._config = { ...GalleryState._config, ...cfg.gallery };
      AssetPipeline.setConfig(cfg.gallery);
    }

    // Ensure config has defaults
    GalleryState._config = {
      autoTagOnLoad: 'ask',
      maxLongSide: 1024,
      jpegQuality: 0.92,
      manifestDescriptions: true,
      allowDirectoryCommands: false,
      collageMaxHeight: 'auto',
      ...GalleryState._config,
    };

    // Auto-tag on load if configured
    if (GalleryState._config.autoTagOnLoad === 'always') {
      setTimeout(() => AutoTagger.tagAll(), 1000);
    }

    this._logger.info('GalleryModule started');
  },

  async stop(ctx) {
    // Persist gallery state
    const snapshot = {
      assets: Object.fromEntries(GalleryState.assets),
      categories: GalleryState.categories,
      tabs: GalleryState.tabs,
      activeTabId: GalleryState.activeTabId,
      tagAliases: GalleryState.tagAliases,
    };
    await ctx.storage.set('gallery-state', snapshot, 'gallery-state');
    await ctx.storage.persist('gallery-state');
    this._logger.info('GalleryModule stopped');
  },

  // ─── Public API ───
  getState() { return GalleryState; },
  getAssetPipeline() { return AssetPipeline; },
  getCollageGenerator() { return CollageGenerator; },
  getAutoTagger() { return AutoTagger; },

  getPanels() {
    return [
      {
        id: 'gallery',
        title: 'Gallery',
        icon: '📚',
        order: 20,
        singleton: true,
        create: (host, panelCtx) => _GalleryPanel.create(host, panelCtx),
        settings: {
          title: 'Gallery Settings',
          icon: '📚',
          mode: 'auto',
          minWidth: 340,
          minHeight: 300,
          width: 400,
          create: (body, panelCtx) => _GallerySettingsPanel.create(body, panelCtx),
        },
      },
    ];
  },
};