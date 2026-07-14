# VP Studio — Architecture Proposal for Desktop-First Rewrite

---

## Executive Summary

**Current State**: A working "Frankenstein" built with web-thinking — everything in global scope, tight coupling via `window.VisualProjector`, synchronous XHR loads, localStorage fallbacks, and implicit load order dependencies in `index.html`.

**Target State**: A true desktop application architecture:
- **Ephemeral-first**: Everything lives in RAM; disk writes only on explicit user action or graceful shutdown
- **Module isolation**: Crash in one module ≠ crash in others; modules can be hot-reloaded
- **Explicit contracts**: Typed interfaces between modules, no global namespace pollution
- **Desktop UX**: Blender-style workspace with persistent layouts, instant startup, no "web page" feel

---

## Complexity Assessment

| Area | Current Complexity | Rewrite Effort | Risk |
|------|-------------------|----------------|------|
| **Core Engine** (visual-projector.js) | High (2600 lines, God object) | 3-4 days | Medium |
| **Gallery** (projector-gallery.js) | Very High (3900 lines) | 4-5 days | High |
| **Session/Chat** (projector-session.js + projector-chats.js) | High (3100 + 2000 lines) | 3-4 days | Medium |
| **Asset Studio** (projector-asset-studio.js + nodes/) | High (2200 + 5 node files) | 3-4 days | Medium |
| **Shell/Workspace** (projector-shell.js) | Medium (2600 lines) | 2-3 days | Low |
| **Storage** (vp-storage.js + vp-storage-native.js) | Low (360 lines) | 1 day | Low |
| **Tools/FX/Subtitles** | Medium (scattered) | 2 days | Low |
| **Integration/Testing** | — | 3-4 days | — |

**Total Estimated**: **19-25 working days** for a clean rewrite with proper architecture.
**Incremental Path**: Can be done in 3-4 phases over 4-6 weeks, keeping the app runnable at each milestone.

---

## Proposed Architecture

### 1. High-Level Layer Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        NEUTRALINO HOST                          │
│  (window, filesystem, os, clipboard, tray, native menus)       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      APPLICATION CORE                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ ModuleManager│  │  EventBus   │  │  Lifecycle  │              │
│  │  (DI + Reg)  │  │  (typed)    │  │  (boot/shut)│              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│   DOMAIN      │    │   DOMAIN      │    │   DOMAIN      │
│   MODULES     │    │   MODULES     │    │   MODULES     │
│  (isolated)   │    │  (isolated)   │    │  (isolated)   │
├───────────────┤    ├───────────────┤    ├───────────────┤
│ • Projector   │    │ • Gallery     │    │ • Session     │
│   (canvas,    │    │   (assets,    │    │   (chat,      │
│    playback,  │    │    tags,      │    │    models,    │
│    VPTags)    │    │    collage)   │    │    tools)     │
├───────────────┤    ├───────────────┤    ├───────────────┤
│ • AssetStudio │    │ • Shell       │    │ • Profiles    │
│   (nodes,     │    │   (layout,    │    │ • Games       │
│    graph,     │    │    workspaces)│    │ • Subtitles   │
│    CLI)       │    │               │    │               │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      INFRASTRUCTURE                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Storage    │  │  Config     │  │  Native     │              │
│  │  (IndexedDB │  │  (schemas,  │  │  Bridge     │              │
│  │   + RAM)    │  │   migration)│  │  (Neutralino)           │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 2. Module Contract (Every Module Implements)

```typescript
interface VPModule {
  // Identity
  readonly id: string;           // 'projector', 'gallery', 'session', etc.
  readonly version: string;      // semver
  readonly dependencies: string[]; // other module IDs (optional, soft)
  
  // Lifecycle (called by ModuleManager in topological order)
  async init(ctx: ModuleContext): Promise<void>;      // setup, register panels, subscribe to events
  async start(ctx: ModuleContext): Promise<void>;     // begin active work (timers, workers)
  async stop(ctx: ModuleContext): Promise<void>;      // graceful shutdown, cleanup
  async dispose(ctx: ModuleContext): Promise<void>;   // hard cleanup (hot-reload, uninstall)
  
  // Optional: State persistence (ephemeral-first)
  getState?(): ModuleState;        // called before shutdown/save
  restoreState?(state: ModuleState): Promise<void>;  // called on boot
  
  // Optional: UI Panels (for Shell)
  getPanels?(): PanelDefinition[]; // Blender-style panels this module provides
  getSettingsPanels?(): SettingsPanelDefinition[];
}

interface ModuleContext {
  eventBus: EventBus;
  storage: StorageAdapter;      // scoped to this module (namespaced)
  config: ConfigAdapter;        // typed config access
  native: NativeAPI;            // Neutralino wrapper
  modules: ModuleRegistry;      // read-only access to other modules' public APIs
  logger: Logger;               // prefixed with module ID
}
```

### 3. Event Bus — Typed, Decoupled Communication

```typescript
// No more: window.VisualProjector.gallery.renderGalleryGrid()
// Instead:
eventBus.emit('gallery:assets-changed', { reason: 'import', tags: ['foo', 'bar'] });
eventBus.emit('projector:set-current', { tag: 'forest', source: 'model', transition: 'crossfade' });
eventBus.emit('session:message-sent', { role: 'user', text: 'Hello', meta: {} });

// Modules subscribe with typed handlers:
eventBus.on('gallery:asset-deleted', (payload) => {
  // TypeScript knows payload.tags: string[]
});
```

**Event Catalog (source of truth)**:
| Event | Payload | Producers | Consumers |
|-------|---------|-----------|-----------|
| `projector:frame-changed` | `{tag, source, transition}` | Projector | Gallery, Session, Games |
| `gallery:assets-imported` | `{tags[], source}` | Gallery | Projector, AssetStudio |
| `gallery:tag-renamed` | `{oldTag, newTag}` | Gallery | Projector, Session |
| `session:turn-started` | `{role, prompt}` | Session | Projector (playback), Games |
| `session:turn-completed` | `{role, text, tools[]}` | Session | Projector (playback), Gallery (visual inventory) |
| `asset-studio:asset-generated` | `{tag, workflowId}` | AssetStudio | Gallery, Projector |
| `shell:layout-changed` | `{workspaceId, layout}` | Shell | All (persist) |
| `config:changed` | `{key, value, scope}` | Any | All (reactive) |

### 4. Storage — Ephemeral-First, Explicit Persistence

```typescript
// Two-tier storage:
// 1. RAM (Map) — instant, survives hot-reload, lost on close
// 2. IndexedDB — explicit writes only

interface StorageAdapter {
  // Ephemeral (RAM) — default for all module state
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  delete(key: string): void;
  clear(): void;
  
  // Persistent (IndexedDB) — opt-in, explicit
  persist(key: string): Promise<void>;        // flush RAM → IDB
  loadPersisted(key: string): Promise<any>;   // IDB → RAM (on boot)
  removePersisted(key: string): Promise<void>;
  
  // Scoped to module: storage.namespace('gallery').set('assets', map)
  namespace(prefix: string): StorageAdapter;
}

// Policy: 
// - ALL runtime state = ephemeral (RAM)
// - persist() called ONLY on: user "Save", graceful shutdown, explicit checkpoints
// - NO automatic periodic saves, NO localStorage fallbacks
// - IndexedDB schema versioned with migration
```

### 5. Config — Typed, Reactive, Scoped

```typescript
// Single source of truth with Zod schemas
const ConfigSchema = z.object({
  projector: z.object({
    fadeDuration: z.number().min(0).max(5).default(0.3),
    transitionType: z.enum(['random', 'crossfade', ...]).default('random'),
    contextDepth: z.number().min(0).max(30).default(3),
    maxHistory: z.number().min(5).max(200).default(20),
  }),
  gallery: z.object({
    maxLongSide: z.number().min(256).max(4096).default(1024),
    jpegQuality: z.number().min(0.1).max(1).default(0.92),
    autoTagOnLoad: z.enum(['ask', 'always', 'never']).default('ask'),
  }),
  session: z.object({
    temperature: z.number().min(0).max(2).default(0.7),
    maxTokens: z.number().min(1).default(2048),
    toolsMode: z.enum(['off', 'native', 'text-tags']).default('off'),
  }),
  // ... per-module schemas
});

// Reactive: config.watch('projector.fadeDuration', (v) => { ... })
// Scoped: moduleConfig = config.scope('gallery') // only gallery.* keys
```

### 6. Panel System — Blender-Style, Module-Owned

```typescript
// Module registers its panels at init:
context.modules.registerPanels([
  {
    id: 'projector-stage',
    title: 'Stage', icon: '🎭',
    create: (host, ctx) => ProjectorPanel.mount(host, ctx),
    settings: { create: ProjectorSettingsPanel.mount }, // optional
    singleton: true, // only one instance across all workspaces
  },
  {
    id: 'gallery-grid',
    title: 'Gallery', icon: '📚',
    create: GalleryGridPanel.mount,
    settings: { create: GallerySettingsPanel.mount },
  },
  // ... input, log, model, asset-studio, profiles, chats, games, bus, empty-space
]);

// Shell manages layout tree (split/leaf), persistence, drag-resize
// Panels receive PanelContext with scoped storage/state
```

### 7. Module Boundaries — What Goes Where

| Module | Owns | Public API (via EventBus) | Does NOT Own |
|--------|------|---------------------------|--------------|
| **projector** | Canvas, transitions, playback, VPTags parser, frame history | `setCurrent(tag)`, `clearCurrent()`, `buildManifest()`, `getContextMessages()` | Gallery data, model calls, chat history |
| **gallery** | Asset CRUD, tags, tabs/categories, collage generation, auto-tagging | `addAsset(blob)`, `deleteAssets(tags)`, `renameTag()`, `generateCollage()` | Projector canvas, model config, session log |
| **session** | Model connection, streaming, tool loop, chat messages, manifests | `send(prompt)`, `stop()`, `regenerate()`, `attachManifest()` | Gallery assets, projector canvas, shell layout |
| **chats/profiles** | Chat list, participants, profiles, scenarios | `getActiveChat()`, `setActiveChat()`, `createProfile()` | Model calls, projector state (syncs via events) |
| **asset-studio** | Node graph, sd.cpp CLI, workflow library, model picker | `generate(workflow)`, `importCLI()`, `pickModel()` | Chat history, gallery tags (read-only via events) |
| **shell** | Workspace layouts, split panes, panel registry, window chrome | `saveLayout()`, `loadWorkspace()`, `registerPanel()` | Domain logic (delegates to panels) |
| **games** | Minigames, activity commands, dice, state machines | `processActivityCommands(text)` | Everything else (pure text in/out) |
| **subtitles** | Overlay rendering, speed, TTS sync | `play(text, role)`, `push(delta)`, `stop()` | Model, gallery, chat |
| **tools** | Tool registry, OpenAI schemas, execution, trace | `register(tool)`, `execute(name, args)`, `buildOpenAITools()` | Model calls (called by session) |
| **fx-core** | Effect registry, canvas shaders, emoji triggers | `fire(name, intensity)`, `registerEffect()` | When effects trigger (called by projector/session) |

---

## Implementation Sequence (Phased)

### Phase 0: Foundation (Week 1) — **Do First, Enables Everything Else**

```
1. Create new architecture skeleton:
   /src/
     core/
       ModuleManager.ts      # DI container, lifecycle, topological sort
       EventBus.ts           # Typed emit/on/off, event catalog
       StorageAdapter.ts     # RAM + IndexedDB, namespaced
       ConfigAdapter.ts      # Zod schemas, reactive, scoped
       NativeAPI.ts          # Neutralino wrapper (window, fs, os, clipboard)
       Logger.ts             # Prefixed, levels, pretty dev console
       types.ts              # All shared interfaces
       
2. Build system: Vite + TypeScript (or esbuild)
   - ES modules, no more script-tag load order
   - HMR for panel/module development
   - Production: single bundle + workers

3. Migration harness:
   - Run old index.html in parallel (iframe or separate window)
   - Port vp-storage.js → StorageAdapter (mostly done)
   - Port VPCommandBus → EventBus + VPCommandBus wrapper
```

**Deliverable**: Empty app shell that boots, shows ModuleManager logging, EventBus working, Storage round-tripping.

---

### Phase 1: Projector Core (Week 1-2)

```
1. Extract pure projector logic from visual-projector.js:
   - State (current, history, playback, cover/prepared)
   - VPTags parser (pure, testable)
   - VPCommandBus → EventBus commands + legacy wrapper
   - Transitions, geometry helpers
   - Manifest/frame context builders
   - Playback controller (Playback class)

2. Projector Panel (Blender-style):
   - Canvas + header + player bar + timeline
   - Drag/resize (if undocked)
   - Keyboard shortcuts

3. Events emitted:
   - projector:frame-changed
   - projector:playback-state
   - projector:manifest-ready
```

**Tests**: Unit tests for VPTags, VPCommandBus, manifest builder, playback logic.

---

### Phase 2: Gallery (Week 2-3)

```
1. Asset pipeline:
   - fileToBlobData, generateThumbUrl, ensureThumb
   - pathToTag, getUniqueImportedTag
   - addImageFromBlob, pasteFromClipboard, loadGalleryFolder

2. TabsManager (sidebar tree):
   - Categories/tabs CRUD, drag-move, state carousel (open/collapsed/locked)
   - executeCommand (AI directory commands)
   - Persistence via StorageAdapter

3. Gallery Grid Panel:
   - Virtualized grid (IntersectionObserver)
   - Selection (shift/ctrl), drag-to-insert [IMG:tag]
   - Context menu: rename, describe, retag, delete, apply/discard drafts

4. Collage/Contact Sheet:
   - Worker-based (OffscreenCanvas) + main-thread fallback
   - Signature-based caching, auto-refresh on changes

5. Import/Export (JSON + base64 blobs)

6. Events:
   - gallery:asset-added, gallery:asset-deleted, gallery:tag-renamed
   - gallery:collage-generated, gallery:selection-changed
```

---

### Phase 3: Session + Chat + Profiles (Week 3-4)

```
1. Session Core:
   - Model config, streaming fetch, tool loop (native + text-tags fallback)
   - Playback integration (VP.playback.open/push/commit/abort)
   - Manifest system (attach/queue/TTL)

2. Chat/Profiles Store:
   - Chats: messages, draft, projector snapshot, participants, scenario
   - Profiles: systemPrompt, modelDefaults, avatar, color, kind
   - Participants: profileId + alias + promptPatch + modelOverrides

3. Panels:
   - Input: textarea + participant chips + 🎬 Begin + tool toggle
   - Log: messages with avatars, tool spoilers, inline edit, scene event grouping
   - Model: endpoint, model list, tools mode, presets
   - Profiles: grid/list, avatar editor, color presets
   - Chats: list, duplicate, rename, delete, scenario editor

4. Prompt Providers:
   - Chat scenario → manifest
   - Active profile → system prompt

5. Events:
   - session:turn-started, session:turn-completed, session:aborted
   - chat:activated, profile:updated
```

---

### Phase 4: Asset Studio (Week 4-5)

```
1. Node System (already modular in /nodes):
   - Graph: viewport, links, serialization, clipboard
   - NodeRegistry: loader, lora, prompt (tabs!), sampler, output
   - Arg definitions (type-safe controls)

2. CLI Execution:
   - spawnProcess with live log parsing (ANSI strip, progress N/M, speed)
   - Step preview polling (--preview-path)
   - Reference image handling (base64 → temp files)
   - Output loading → gallery import

3. Workflow Library:
   - Save/load/rename/delete/export/import
   - Presets: T2I, DiT

4. Model Libraries:
   - Configurable roots, recursive scan, picker modal
   - Neutralino filesystem integration

5. Panel:
   - Sidebar: node palette, presets, workflows, file ops
   - Canvas: graph editor, zoom/pan, minimap
   - Inspector: node settings, preview, CLI log
   - Settings: executable, output dir, engine mode, libraries

6. Events:
   - asset-studio:asset-generated, asset-studio:workflow-loaded
```

---

### Phase 5: Shell + Integration (Week 5-6)

```
1. Workspace Shell:
   - Layout tree (split/leaf), gutters, drag-resize
   - Workspace presets (Performance, Director, Workshop) + custom
   - World Manager (Neutralino FS): create/switch/duplicate/export/backup
   - Window chrome (min/max/close via Neutralino)

2. Panel Registry:
   - All modules register panels at boot
   - Shell renders layout, manages singleton panels (stage, asset-studio)

3. Global Settings:
   - Storage mode (persistent/semi-persistent/ephemeral)
   - Theme presets + custom CSS variables (with alpha support)
   - User persona, project defaults
   - Health check, data folder access

4. Integration:
   - EventBus wiring between all modules
   - Graceful shutdown: stop() → persist critical state → Neutralino.app.exit()
   - Boot splash → ModuleManager.init/start in order
```

---

## Migration Strategy: Strangler Fig Pattern

**Don't rewrite all at once.** Keep `index.html` loading old scripts, run new architecture in parallel:

```html
<!-- index.html during transition -->
<script src="js/visual-projector.js"></script>     <!-- OLD -->
<script src="js/projector-gallery.js"></script>    <!-- OLD -->
<script type="module" src="/src/main.ts"></script> <!-- NEW (Vite dev server) -->
```

1. **New core boots first** (ModuleManager, EventBus, Storage)
2. **Old modules register as "legacy adapters"** on EventBus:
   ```js
   // In old visual-projector.js at end:
   if (window.VP_NEW?.eventBus) {
     window.VP_NEW.eventBus.on('projector:set-current', (e) => setCurrent(e.tag));
     // ... wrap old API
   }
   ```
3. **Migrate one module at a time**:
   - New `GalleryModule` replaces `projector-gallery.js`
   - Old gallery panel hidden, new panel registered in Shell
   - Verify, then delete old file
4. **Final cutover**: Remove old scripts from index.html, build production bundle

---

## Key Technical Decisions

| Decision | Rationale |
|----------|-----------|
| **TypeScript + Zod** | Catch config/state bugs at compile time; schemas = documentation |
| **Vite + ES Modules** | Fast HMR, no load-order hell, tree-shaking, workers as modules |
| **EventBus over direct calls** | Modules stay isolated; testable; enables hot-reload |
| **RAM-first storage** | Desktop app feel; no disk thrash; user controls saves |
| **Module-scoped storage** | No key collisions; clear ownership; easy cleanup |
| **Panel = module-owned UI** | Shell stays dumb; modules can be developed in isolation |
| **Workers for heavy ops** | Collage generation, CLI log parsing off main thread |
| **Neutralino only for native** | No Node.js, no Electron; filesystem/window/os via Neutralino API |

---

## File Structure (Target)

```
/home/user/Visual-Projector-Studio/
├── package.json
├── tsconfig.json
├── vite.config.ts
├── neutralino.config.json
├── index.html                 # Minimal: <div id="app"></div> + module entry
├── src/
│   ├── main.ts                # Boot: ModuleManager → register all → start
│   ├── core/
│   │   ├── ModuleManager.ts
│   │   ├── EventBus.ts
│   │   ├── StorageAdapter.ts
│   │   ├── ConfigAdapter.ts
│   │   ├── NativeAPI.ts
│   │   ├── Logger.ts
│   │   └── types.ts
│   ├── modules/
│   │   ├── projector/
│   │   │   ├── ProjectorModule.ts
│   │   │   ├── state/ProjectorState.ts
│   │   │   ├── tags/VPTags.ts
│   │   │   ├── commands/VPCommandBus.ts
│   │   │   ├── playback/PlaybackController.ts
│   │   │   ├── manifest/ManifestBuilder.ts
│   │   │   ├── panels/
│   │   │   │   ├── ProjectorPanel.ts
│   │   │   │   └── ProjectorSettingsPanel.ts
│   │   │   └── index.ts
│   │   ├── gallery/
│   │   ├── session/
│   │   ├── chats/
│   │   ├── asset-studio/
│   │   ├── shell/
│   │   ├── games/
│   │   ├── subtitles/
│   │   ├── tools/
│   │   └── fx/
│   ├── shared/
│   │   ├── ui/                # Reusable: Button, Modal, Toast, ContextMenu, ColorPicker
│   │   ├── geometry/          # Scale, viewport↔CSS transforms
│   │   └── utils/
│   └── workers/
│       ├── contact-sheet.worker.ts
│       └── cli-log-parser.worker.ts
├── css/
│   ├── variables.css          # CSS custom properties (theme system)
│   ├── base.css               # Reset, typography, scrollbars
│   └── components/            # Panel, Button, Input, Modal, etc.
└── data/                      # Neutralino resources (models, binaries)
```

---

## First Steps (What to Do Today)

1. **Initialize the new toolchain**:
   ```bash
   cd /home/user/Visual-Projector-Studio
   npm init -y
   npm install -D typescript vite @types/node zod
   npm install neutralino
   ```

2. **Create `src/core/` with ModuleManager, EventBus, StorageAdapter** — these are the foundation everything else builds on.

3. **Write a minimal `main.ts`** that boots the ModuleManager, registers a dummy module, and logs "Architecture alive".

4. **Run `vite dev` alongside Neutralino** — both serve the same `index.html`, new code in ES modules, old code in script tags.

5. **Port `vp-storage.js` → `StorageAdapter`** first (lowest risk, highest leverage).

---

## Risk Mitigation

| Risk | Mitigation |
|------|------------|
| **Neutralino API changes** | Wrap all native calls in `NativeAPI` adapter; single point of update |
| **IndexedDB quota/errors** | RAM fallback always works; persist() returns Promise, UI handles failure |
| **Module circular deps** | ModuleManager detects cycles at registration; EventBus breaks runtime cycles |
| **Hot-reload breaks state** | Modules implement `dispose()` + `restoreState()`; singleton panels tracked |
| **Performance regression** | Benchmark projector frame switches, gallery render, CLI spawn before/after |
| **CSS conflicts** | All styles in CSS Modules or scoped under `#vp-shell-root`; no global leaks |

---

## Success Criteria

- [ ] Cold boot → interactive in < 800ms (no network, no heavy parsing)
- [ ] Gallery with 500 assets: smooth 60fps scroll, instant search
- [ ] Projector frame switch: < 50ms (transition excluded)
- [ ] Session streaming: first token < 200ms local model
- [ ] Asset Studio CLI: live log parsing, step preview updates
- [ ] Workspace layout persists across restarts
- [ ] Zero disk writes during normal operation (only on Save/Close)
- [ ] Module crash (e.g., Asset Studio) → toast notification, other modules unaffected
- [ ] Hot-reload a panel module without losing chat/gallery state

---

This architecture gives you a **true desktop application** — not a web page in a window. The investment pays off in maintainability, testability, and the ability to evolve each domain independently. Let's start with Phase 0.