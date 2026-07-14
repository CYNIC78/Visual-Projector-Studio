/**
 * @fileoverview Projector Module — Main export.
 * Registers with ModuleManager via ProjectorModule.
 */

export { ProjectorModule } from './ProjectorModule.js';
export { ProjectorState } from './state/ProjectorState.js';
export { VPTags } from './tags/VPTags.js';
export { ManifestBuilder } from './manifest/ManifestBuilder.js';
export { PlaybackController } from './playback/PlaybackController.js';
export { VPCommandBus } from './commands/VPCommandBus.js';
export { ProjectorPanel } from './panels/ProjectorPanel.js';
export { ProjectorSettingsPanel } from './panels/ProjectorSettingsPanel.js';

// Default export for ModuleManager registration
export default {
  id: 'projector',
  version: '4.0.0',
  dependencies: [],
  async init(ctx) {
    const { ProjectorModule } = await import('./ProjectorModule.js');
    return ProjectorModule.init(ctx);
  },
  async start(ctx) {
    const { ProjectorModule } = await import('./ProjectorModule.js');
    return ProjectorModule.start(ctx);
  },
  async stop(ctx) {
    const { ProjectorModule } = await import('./ProjectorModule.js');
    return ProjectorModule.stop(ctx);
  },
  getPanels() {
    return import('./ProjectorModule.js').then(m => m.ProjectorModule.getPanels());
  },
};