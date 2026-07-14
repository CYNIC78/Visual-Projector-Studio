/**
 * @fileoverview Gallery Module — Main export.
 */

export { GalleryModule } from './GalleryModule.js';
export { GalleryState } from './state/GalleryState.js';
export { AssetPipeline } from './asset-pipeline/AssetPipeline.js';
export { CollageGenerator } from './collage/CollageGenerator.js';
export { AutoTagger } from './tagger/AutoTagger.js';
export { GalleryPanel } from './panels/GalleryPanel.js';
export { GallerySettingsPanel } from './panels/GallerySettingsPanel.js';

export default {
  id: 'gallery',
  version: '2.0.0',
  dependencies: ['projector'],
  async init(ctx) {
    const { GalleryModule } = await import('./GalleryModule.js');
    return GalleryModule.init(ctx);
  },
  async start(ctx) {
    const { GalleryModule } = await import('./GalleryModule.js');
    return GalleryModule.start(ctx);
  },
  async stop(ctx) {
    const { GalleryModule } = await import('./GalleryModule.js');
    return GalleryModule.stop(ctx);
  },
  getPanels() {
    return import('./GalleryModule.js').then(m => m.GalleryModule.getPanels());
  },
};