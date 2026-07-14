/**
 * @fileoverview Shared type definitions (JSDoc) for VP Studio.
 * Provides IDE IntelliSense without runtime overhead.
 * All types are erased at runtime — pure documentation for tooling.
 */

// ═══════════════════════════════════════════════════════════════════
//  PRIMITIVES & UTILITIES
// ═══════════════════════════════════════════════════════════════════

/** @typedef {string} ModuleId */
/** @typedef {string} EventName */
/** @typedef {string} StorageKey */
/** @typedef {string} ConfigPath */

/** @typedef {{[key: string]: any}} JsonObject */
/** @typedef {JsonObject | JsonObject[] | string | number | boolean | null} JsonValue */

// ═══════════════════════════════════════════════════════════════════
//  EVENT BUS
// ═══════════════════════════════════════════════════════════════════

/**
 * @template T
 * @typedef {Object} EventHandler
 * @property {(payload: T) => void | Promise<void>} fn
 * @property {boolean} [once=false]
 */

/**
 * @typedef {Object} EventBus
 * @property {<T>(eventName: EventName, payload: T) => void} emit
 * @property {<T>(eventName: EventName, handler: (payload: T) => void | Promise<void>) => () => void} on
 * @property {<T>(eventName: EventName, handler: (payload: T) => void | Promise<void>) => () => void} once
 * @property {(eventName: EventName, handler: Function) => void} off
 * @property {(eventName?: EventName) => void} clear
 */

// ═══════════════════════════════════════════════════════════════════
//  STORAGE
// ═══════════════════════════════════════════════════════════════════

/** @typedef {'persistent' | 'semi-persistent' | 'ephemeral'} StorageMode */

/**
 * @typedef {Object} StorageAdapter
 * @property {(key: StorageKey) => any} get
 * @property {(key: StorageKey, value: any) => void} set
 * @property {(key: StorageKey) => void} delete
 * @property {() => void} clear
 * @property {(prefix: string) => StorageAdapter} namespace
 * @property {(key: StorageKey) => Promise<void>} persist
 * @property {(key: StorageKey) => Promise<any>} loadPersisted
 * @property {(key: StorageKey) => Promise<void>} removePersisted
 * @property {() => StorageMode} getMode
 * @property {(mode: StorageMode) => StorageMode} setMode
 */

// ═══════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ConfigAdapter
 * @property {<T>(path: ConfigPath, defaultValue?: T) => T} get
 * @property {(path: ConfigPath, value: any) => void} set
 * @property {(path: ConfigPath, handler: (value: any) => void) => () => void} watch
 * @property {(scope: string) => ConfigAdapter} scope
 * @property {() => JsonObject} getAll
 * @property {(obj: JsonObject) => void} setAll
 * @property {() => Promise<void>} persist
 * @property {() => Promise<void>} load
 */

// ═══════════════════════════════════════════════════════════════════
//  NATIVE API (Neutralino wrapper)
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} NativeWindow
 * @property {() => Promise<void>} minimize
 * @property {() => Promise<void>} maximize
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} center
 * @property {(width: number, height: number) => Promise<void>} setSize
 * @property {() => Promise<{width: number, height: number}>} getSize
 */

/**
 * @typedef {Object} NativeFilesystem
 * @property {(path: string) => Promise<{data: string}>} readFile
 * @property {(path: string, data: string) => Promise<void>} writeFile
 * @property {(path: string, data: Uint8Array) => Promise<void>} writeBinaryFile
 * @property {(path: string) => Promise<Uint8Array>} readBinaryFile
 * @property {(path: string) => Promise<{entries: Array<{name: string, path: string, type: string}>}>} readDirectory
 * @property {(path: string) => Promise<void>} createDirectory
 * @property {(path: string) => Promise<void>} remove
 * @property {(path: string) => Promise<{size: number, type: string, createdAt: number, modifiedAt: number}>} getStats
 * @property {() => Promise<string>} showOpenDialog
 * @property {() => Promise<string>} showSaveDialog
 * @property {(path: string) => Promise<void>} openPath
 */

/**
 * @typedef {Object} NativeOS
 * @property {(command: string, options?: {cwd?: string}) => Promise<{id: number}>} spawnProcess
 * @property {(id: number, action: 'exit') => Promise<void>} updateSpawnedProcess
 * @property {(command: string, options?: {cwd?: string}) => Promise<{exitCode: number, stdOut: string, stdErr: string}>} execCommand
 */

/**
 * @typedef {Object} NativeApp
 * @property {() => Promise<void>} exit
 * @property {() => Promise<{version: string, arch: string, platform: string}>} getInfo
 */

/**
 * @typedef {Object} NativeClipboard
 * @property {() => Promise<Array<{types: string[]}>>} read
 * @property {(data: string) => Promise<void>} writeText
 */

/**
 * @typedef {Object} NativeDebug
 * @property {(message: string) => Promise<void>} log
 */

/**
 * @typedef {Object} NativeAPI
 * @property {NativeWindow} window
 * @property {NativeFilesystem} filesystem
 * @property {NativeOS} os
 * @property {NativeApp} app
 * @property {NativeClipboard} clipboard
 * @property {NativeDebug} debug
 * @property {boolean} ready
 * @property {Promise<void>} init
 */

// ═══════════════════════════════════════════════════════════════════
//  MODULE SYSTEM
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} ModuleContext
 * @property {EventBus} eventBus
 * @property {StorageAdapter} storage
 * @property {ConfigAdapter} config
 * @property {NativeAPI} native
 * @property {ModuleRegistry} modules
 * @property {Logger} logger
 */

/**
 * @typedef {Object} VPModule
 * @property {ModuleId} id
 * @property {string} version
 * @property {ModuleId[]} [dependencies]
 * @property {(ctx: ModuleContext) => Promise<void>} init
 * @property {(ctx: ModuleContext) => Promise<void>} [start]
 * @property {(ctx: ModuleContext) => Promise<void>} [stop]
 * @property {(ctx: ModuleContext) => Promise<void>} [dispose]
 * @property {() => any} [getState]
 * @property {(state: any) => Promise<void>} [restoreState]
 * @property {() => PanelDefinition[]} [getPanels]
 * @property {() => SettingsPanelDefinition[]} [getSettingsPanels]
 */

/**
 * @typedef {Object} ModuleRegistry
 * @property {(id: ModuleId) => VPModule | undefined} get
 * @property {() => VPModule[]} getAll
 * @property {(id: ModuleId) => any} getInstance
 */

/**
 * @typedef {Object} PanelDefinition
 * @property {string} id
 * @property {string} title
 * @property {string} [icon]
 * @property {number} [order]
 * @property {(host: HTMLElement, ctx: PanelContext) => void} create
 * @property {boolean} [singleton]
 * @property {SettingsPanelDefinition} [settings]
 */

/**
 * @typedef {Object} SettingsPanelDefinition
 * @property {string} title
 * @property {string} [icon]
 * @property {('auto' | 'local' | 'global')} [mode]
 * @property {number} [minWidth]
 * @property {number} [minHeight]
 * @property {number} [width]
 * @property {(body: HTMLElement, ctx: PanelContext) => void} create
 */

/**
 * @typedef {Object} PanelContext
 * @property {string} areaId
 * @property {string} panelId
 * @property {ModuleRegistry} modules
 * @property {ShellAPI} shell
 * @property {() => any} getPanelState
 * @property {(patch: Object) => void} setPanelState
 * @property {HTMLElement} areaEl
 * @property {VPModule} panelDef
 * @property {() => void} close
 * @property {boolean} global
 */

// ═══════════════════════════════════════════════════════════════════
//  LOGGER
// ═══════════════════════════════════════════════════════════════════

/** @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel */

/**
 * @typedef {Object} Logger
 * @property {(msg: string, meta?: any) => void} debug
 * @property {(msg: string, meta?: any) => void} info
 * @property {(msg: string, meta?: any) => void} warn
 * @property {(msg: string, meta?: any) => void} error
 * @property {(level: LogLevel) => void} setLevel
 * @property {() => Logger} child
 */

// ═══════════════════════════════════════════════════════════════════
//  SHELL (Workspace)
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} LayoutNode
 * @property {'leaf' | 'split'} type
 * @property {string} id
 * @property {string} [panel]
 * @property {('row' | 'column')} [direction]
 * @property {number} [ratio]
 * @property {LayoutNode} [a]
 * @property {LayoutNode} [b]
 * @property {Object} [state]
 */

/**
 * @typedef {Object} WorkspaceDef
 * @property {string} id
 * @property {string} title
 * @property {string} [icon]
 * @property {boolean} [builtin]
 * @property {LayoutNode} layout
 */

/**
 * @typedef {Object} ShellAPI
 * @property {() => LayoutNode} getCurrentLayout
 * @property {(layout: LayoutNode) => void} setCurrentLayout
 * @property {() => WorkspaceDef[]} getWorkspaces
 * @property {(id: string) => void} setActiveWorkspace
 * @property {(title: string, icon?: string) => Promise<string>} saveWorkspaceAs
 * @property {() => void} resetWorkspace
 * @property {() => void} render
 * @property {(areaId: string, panelId: string) => PanelContext} getPanelContext
 * @property {(areaId: string, panelId: string) => void} showPanelSettings
 * @property {() => void} closeShellModals
 * @property {(rootPath: string) => Promise<void>} switchWorld
 * @property {() => Promise<void>} showWorldManager
 * @property {() => void} undockProjectorToFloating
 */

// ═══════════════════════════════════════════════════════════════════
//  COMMON DOMAIN TYPES (used across modules)
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} AssetRecord
 * @property {string} tag
 * @property {string} filename
 * @property {string} path
 * @property {Blob} [blob]
 * @property {string} [url]
 * @property {string} [thumbUrl]
 * @property {string} [base64]
 * @property {string} description
 * @property {boolean} hidden
 * @property {'user' | 'generated' | 'imported' | 'pasted'} source
 * @property {string} [folderContext]
 * @property {string} [tabId]
 * @property {Object} [collageMeta]
 * @property {boolean} [_draft]
 */

/**
 * @typedef {Object} CategoryDef
 * @property {string} id
 * @property {string} name
 * @property {string} desc
 * @property {'open' | 'collapsed' | 'locked'} state
 * @property {boolean} [uiCollapsed]
 */

/**
 * @typedef {Object} TabDef
 * @property {string} id
 * @property {string} categoryId
 * @property {string} name
 * @property {string} desc
 * @property {'open' | 'collapsed' | 'locked'} state
 * @property {boolean} [markedForCollage]
 */

/**
 * @typedef {Object} ChatMessage
 * @property {string} id
 * @property {'user' | 'assistant' | 'system' | 'tool'} role
 * @property {string} [speakerId]
 * @property {string} raw
 * @property {string} clean
 * @property {'done' | 'streaming' | 'error' | 'aborted'} status
 * @property {number} createdAt
 * @property {string} [frameTagAtStart]
 * @property {Object[]} [tool_calls]
 * @property {any[]} [tool_results]
 * @property {Object[]} [manifests]
 * @property {string} [internalPrompt]
 */

/**
 * @typedef {Object} ProfileDef
 * @property {string} id
 * @property {string} name
 * @property {string} [avatar]
 * @property {string} color
 * @property {string} description
 * @property {string} systemPrompt
 * @property {Object} modelDefaults
 * @property {Object} meta
 */

/**
 * @typedef {Object} ParticipantDef
 * @property {string} id
 * @property {string} profileId
 * @property {string} [alias]
 * @property {boolean} enabled
 * @property {string} promptPatch
 * @property {Object} modelOverrides
 */

/**
 * @typedef {Object} ChatDef
 * @property {string} id
 * @property {string} title
 * @property {'solo' | 'group'} kind
 * @property {ParticipantDef[]} participants
 * @property {string} activeSpeakerId
 * @property {ChatMessage[]} messages
 * @property {string} note
 * @property {Object} scenario
 * @property {Object} projector
 * @property {Object} ui
 * @property {Object} meta
 */

// ═══════════════════════════════════════════════════════════════════
//  EVENT CATALOG (source of truth for EventBus)
// ═══════════════════════════════════════════════════════════════════

/**
 * @typedef {Object} EventCatalog
 * @property {{tag: string, source: string, transition?: string}} 'projector:frame-changed'
 * @property {{mode: string, cursor: number}} 'projector:playback-state'
 * @property {{tags: string[], reason: string}} 'gallery:assets-imported'
 * @property {{tags: string[]}} 'gallery:assets-deleted'
 * @property {{oldTag: string, newTag: string}} 'gallery:tag-renamed'
 * @property {{tag: string, hidden: boolean}} 'gallery:asset-visibility-changed'
 * @property {{sections: Array<{tabId: string, tabName: string, assetTags: string[]}>, signature: string}} 'gallery:collage-generated'
 * @property {{tags: string[]}} 'gallery:selection-changed'
 * @property {{role: 'user' | 'assistant', prompt: string}} 'session:turn-started'
 * @property {{role: 'assistant', text: string, tools: Object[]}} 'session:turn-completed'
 * @property {{reason: string}} 'session:turn-aborted'
 * @property {{chatId: string}} 'chat:activated'
 * @property {{profileId: string}} 'profile:updated'
 * @property {{workspaceId: string, layout: LayoutNode}} 'shell:layout-changed'
 * @property {{key: ConfigPath, value: any, scope: string}} 'config:changed'
 * @property {{tool: string, args: Object, result: any}} 'tools:executed'
 * @property {{name: string, intensity: number}} 'fx:fired'
 * @property {{workflowId: string}} 'asset-studio:workflow-loaded'
 * @property {{tag: string, workflowId: string}} 'asset-studio:asset-generated'
 */