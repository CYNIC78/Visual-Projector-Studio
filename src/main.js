/**
 * @fileoverview VP Studio — Application Entry Point (Zero-Build ESM)
 * Boots ModuleManager with core services, then registers domain modules.
 */

import { Logger } from './core/Logger.js';
import { EventBus } from './core/EventBus.js';
import { Storage } from './core/StorageAdapter.js';
import { Config } from './core/ConfigAdapter.js';
import { NativeAPI } from './core/NativeAPI.js';
import { ModuleManager } from './core/ModuleManager.js';
import { ProjectorModule } from './modules/projector/ProjectorModule.js';
import { GalleryModule } from './modules/gallery/GalleryModule.js';

// ─── Bootstrap ───
async function boot() {
  // 1. Core services (no dependencies between them)
  const logger = Logger.create('Boot');
  logger.info('🚀 VP Studio starting...');

  const eventBus = EventBus;
  const storage = Storage;
  const config = Config;
  const native = NativeAPI;

  // Initialize config with storage
  config.init(storage);
  await config.load();

  // Initialize native (Neutralino)
  await native.init();

  // 2. Module Manager with context
  const context = {
    eventBus,
    storage,
    config,
    native,
    logger,
  };

  // 3. Register domain modules BEFORE init
  ModuleManager.register(ProjectorModule);
  ModuleManager.register(GalleryModule);

  // 4. Register a dummy module to verify the pipeline works
  const DummyModule = {
    id: 'core.dummy',
    version: '1.0.0',
    async init(ctx) {
      ctx.logger.info('DummyModule initialized');
      // Test event bus
      ctx.eventBus.on('test:event', (payload) => {
        ctx.logger.info('Received test event:', payload);
      });
      ctx.eventBus.emit('test:event', { hello: 'world', ts: Date.now() });

      // Test storage
      await ctx.storage.set('testKey', { foo: 'bar', num: 42 });
      const val = ctx.storage.get('testKey');
      ctx.logger.info('Storage round-trip:', val);

      // Test config
      ctx.config.set('test.value', 123);
      const cfgVal = ctx.config.get('test.value');
      ctx.logger.info('Config value:', cfgVal);

      // Test native
      if (ctx.native.ready) {
        const size = await ctx.native.window.getSize();
        ctx.logger.info('Native window size:', size);
      }
    },
    async start(ctx) {
      ctx.logger.info('DummyModule started');
    },
    async stop(ctx) {
      ctx.logger.info('DummyModule stopped');
    },
    async dispose(ctx) {
      ctx.logger.info('DummyModule disposed');
    },
  };

  ModuleManager.register(DummyModule);

  // 5. Initialize ModuleManager (now all modules are registered)
  await ModuleManager.init(context);

  // 6. Start all modules
  await ModuleManager.start();

  // 7. Global error handlers
  window.addEventListener('error', (e) => {
    logger.error('Uncaught error:', e.message, { file: e.filename, line: e.lineno, col: e.colno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    logger.error('Unhandled rejection:', e.reason);
  });

  // 8. Graceful shutdown on Neutralino close
  if (native.ready) {
    native.os.spawnProcess = native.os.spawnProcess; // ensure loaded
    // Neutralino handles window close, but we can listen for beforeunload
    window.addEventListener('beforeunload', async () => {
      logger.info('Shutting down...');
      await ModuleManager.stop();
      await config.persist();
      logger.info('Shutdown complete');
    });
  }

  logger.info('✅ VP Studio core foundation ready');
  logger.info('Registered modules:', ModuleManager.getAllDefinitions().map(m => m.id).join(', '));

  // Expose for debugging (dev only)
  window.VP_CORE = {
    ModuleManager,
    EventBus,
    Storage: storage,
    Config: config,
    Native: native,
    Logger: logger,
  };
}

// ─── Run ───
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => boot().catch(err => console.error('Boot failed:', err)));
} else {
  boot().catch(err => console.error('Boot failed:', err));
}