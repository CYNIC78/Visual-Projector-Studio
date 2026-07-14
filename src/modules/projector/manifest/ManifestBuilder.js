/**
 * @fileoverview ManifestBuilder — builds manifest and frame context for LLM.
 * Pure functions, no side effects. Uses ProjectorState for data.
 */

'use strict';

/**
 * @typedef {Object} ManifestData
 * @property {string} currentTag
 * @property {string} assetsList
 * @property {string} pendingList
 * @property {number} galleryCount
 * @property {number} readyCount
 * @property {number} pendingCount
 * @property {boolean} hasGallery
 * @property {boolean} hasReady
 * @property {boolean} hasPending
 * @property {boolean} noReady
 * @property {boolean} hasEffects
 * @property {boolean} hasTransient
 * @property {boolean} hasMood
 * @property {string} effectsList
 * @property {string} moodList
 */

/**
 * @typedef {Object} FrameData
 * @property {number} n
 * @property {number} total
 * @property {string} position
 * @property {string} tag
 * @property {string} source
 * @property {string} collageTitle
 * @property {string} collageDescription
 * @property {boolean} allowDirectoryCommands
 * @property {string} collageSignature
 * @property {string} collageSections
 * @property {number} collageAssetCount
 */

// ─── Templates ───
const DEFAULT_MANIFEST_TEMPLATE =
`[SCENE CONTROL]
{{#if hasGallery}}You are an improv actor playing out a seamless narrative using the provided assets. Match the visual style and emotional tone of the assets while progressing the scene

Use [IMG:tag] to cut to a frame.

GUIDELINES:
- The active frame is the scene's live visual — let it inspire and ground what happens next.
- Pick one or more [IMG:tag] from the frame list to illustrate actions or emotions.
- Put [IMG:tag] before the lines that match that frame.
- Don't use same tags in a row.

{{/if}}{{#if hasReady}}AVAILABLE FRAMES (tag — description):
{{assetsList}}

{{/if}}{{#if hasEffects}}VISUAL EFFECTS:
Trigger an effect that overlays the current frame: insert [FX:name] and it fires automatically. Optional intensity 1-10: [FX:name:8] (default 5). Effects fade on their own; a new one replaces the active effect. Use them sparingly, only when they fit the moment.

Available effects:
{{/if}}{{#if hasTransient}}{{effectsList}}
{{/if}}{{#if hasMood}}{{moodList}}
{{/if}}{{#if hasGallery}}
Currently showing: {{currentTag}}
{{/if}}[/SCENE CONTROL]`;

const DEFAULT_FRAME_TEMPLATE =
`[STAGE — frame {{n}} of {{total}}, {{position}}]
The scene's current visual. Let it ground and inspire what happens next.
Frame: {{tag}} ({{source}})`;

const CONTACT_SHEET_PROMPT_TEMPLATE =
`[CURRENT GALLERY VIEW]
{{#if collageTitle}}Title: {{collageTitle}}
{{/if}}{{#if collageDescription}}Director note: {{collageDescription}}
{{/if}}Visible tabs: {{collageSections}}

This image shows the current gallery view available for choosing scene frames.
It may change when tabs are opened or collapsed.
Preview cards are grouped by "TAB: <Name>". Use a preview card's [IMG:tag] label only when you want to switch the visible scene frame.
{{#if allowDirectoryCommands}}You may request another gallery view with [TAB:open:name], [TAB:collapse:name], [CAT:open:name], or [CAT:collapse:name].{{/if}}`;

// ─── Template Renderer ───
/**
 * @param {string} template
 * @param {Object} data
 * @returns {string | null}
 */
function renderTemplate(template, data) {
  try {
    let result = template;
    result = result.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, key, content) => data[key] ? content : '');
    result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] !== undefined ? String(data[key]) : match);
    return result;
  } catch (err) {
    console.warn('[ManifestBuilder] Template render failed:', err);
    return null;
  }
}

// ─── Template Variables (for UI hints) ───
const TEMPLATE_VARS = {
  manifest: {
    '{{currentTag}}': 'tag of the currently shown asset',
    '{{assetsList}}': 'list of tagged assets (with descriptions if enabled)',
    '{{pendingList}}': 'list of untagged items',
    '{{galleryCount}}': 'total number of assets',
    '{{readyCount}}': 'number of tagged assets',
    '{{pendingCount}}': 'number of untagged assets',
    '{{effectsList}}': 'list of transient effects available to the bot',
    '{{moodList}}': 'list of mood effects available to the bot',
    '{{#if hasGallery}}...{{/if}}': 'shown only if the gallery has assets',
    '{{#if hasReady}}...{{/if}}': 'shown only if there are tagged assets',
    '{{#if hasPending}}...{{/if}}': 'shown only if there are untagged assets',
    '{{#if noReady}}...{{/if}}': 'shown only if no tagged assets exist',
    '{{#if hasEffects}}...{{/if}}': 'shown only if any effect is available to the bot',
    '{{#if hasTransient}}...{{/if}}': 'shown only if a transient effect is available',
    '{{#if hasMood}}...{{/if}}': 'shown only if a mood effect is available',
  },
  frame: {
    '{{n}}': 'frame number in history (1-based)',
    '{{total}}': 'total frames in history',
    '{{position}}': '"CURRENT ACTIVE frame" or "previous frame"',
    '{{tag}}': 'tag of this frame\'s asset',
    '{{source}}': 'who set this shot',
  },
};

// ─── Helpers ───
function _stripInjectedManifest(text) {
  let out = String(text == null ? '' : text);
  out = out.replace(/\n{0,2}\[SCENE CONTROL\][\s\S]*?\[\/SCENE CONTROL\]\s*$/i, '');
  out = out.replace(/\n{0,2}\[VISUAL PROJECTOR\][\s\S]*?(?=\n\n|\n\[|$)/i, '');
  return out.trimEnd();
}

function _escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── Main Builders ───
/**
 * @param {Object} params
 * @param {Map<string, any>} params.gallery
 * @property {AssetRecord} params.current
 * @property {string} params.coverTag
 * @property {string} params.coverLabel
 * @property {string} params.preparedTag
 * @property {Object} params.config
 * @property {any} params.fxCatalog
 * @property {any} params.fxMoodCatalog
 * @returns {string}
 */
function buildManifest({ gallery, current, coverTag, coverLabel, preparedTag, config, fxCatalog, fxMoodCatalog }) {
  const fxEnabled = !!fxCatalog;
  if (gallery.size === 0 && !fxEnabled) return '';

  const currentTag = current ? current.tag : 'none';
  const allAssets = Array.from(gallery.values()).filter(a => !a.hidden && a.tag !== '__SCENERY_COLLAGE__');

  // Contact sheet handling
  const activeCollageAsset = coverTag === '__SCENERY_COLLAGE__' ? gallery.get('__SCENERY_COLLAGE__') : null;
  const activeCollageTags = new Set((activeCollageAsset?.collageMeta?.tabs || [])
    .flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []));
  const hasActiveCollageFilter = activeCollageTags.size > 0;
  const isInActiveCollage = (asset) => !hasActiveCollageFilter || asset?.tag === '__SCENERY_COLLAGE__' || activeCollageTags.has(asset?.tag);

  let treeList = '';
  let readyCount = 0;
  let pendingCount = 0;

  const hasCollapsibles = config.allowDirectoryCommands && gallery.size > 0 &&
    ((gallery.size > 0 && Array.from(gallery.values()).some(a => a.tabId))); // simplified

  if (hasCollapsibles) {
    treeList += `# DIRECTORY COMMANDS\nSome folders are collapsed below. To pull their assets into your NEXT turn, use [TAB:open:Name] or [CAT:open:Name]. To put a folder away again, use [TAB:collapse:Name] or [CAT:collapse:Name].\n`;
  }

  const processedTags = new Set();

  // This is a simplified version — full logic uses galleryData from ProjectorModule
  // For now, just list all assets
  for (const asset of allAssets) {
    if (processedTags.has(asset.tag)) continue;
    processedTags.add(asset.tag);
    if (isAssetReady(asset)) {
      treeList += config.manifestDescriptions ? `    ${asset.tag} — ${asset.description}\n` : `    ${asset.tag}\n`;
      readyCount++;
    } else {
      treeList += `    ${asset.tag}\n`;
      pendingCount++;
    }
  }

  const transientEntries = fxEnabled ? Object.entries(fxCatalog) : [];
  const moodEntries = fxEnabled ? Object.entries(fxMoodCatalog) : [];
  const fxLine = (name, info) => { const desc = (info.desc || '').trim(); return desc ? `  [FX:${name}] — ${desc}` : `  [FX:${name}]`; };
  const effectsList = transientEntries.map(([name, info]) => fxLine(name, info)).join('\n');
  const moodList = moodEntries.map(([name, info]) => fxLine(name, info)).join('\n');
  const hasTransient = transientEntries.length > 0;
  const hasMood = moodEntries.length > 0;
  const hasGallery = gallery.size > 0;

  const data = {
    currentTag,
    assetsList: treeList.trim(),
    pendingList: '(See untagged items in tree above)',
    galleryCount: gallery.size,
    readyCount, pendingCount,
    hasGallery,
    hasReady: readyCount > 0 || pendingCount > 0,
    hasPending: pendingCount > 0,
    noReady: readyCount === 0 && pendingCount === 0,
    hasEffects: fxEnabled && (hasTransient || hasMood),
    hasTransient, hasMood, effectsList, moodList,
  };

  const template = config.prompts?.manifest || DEFAULT_MANIFEST_TEMPLATE;
  let rendered = renderTemplate(template, data);
  if (rendered === null && (config.prompts?.manifest || templateOverride)) {
    rendered = renderTemplate(DEFAULT_MANIFEST_TEMPLATE, data);
  }
  return rendered;
}

/**
 * @param {Object} params
 * @param {Map<string, any>} params.gallery
 * @property {AssetRecord} params.current
 * @property {string} params.coverTag
 * @property {string} params.coverLabel
 * @param {string} params.preparedTag
 * @property {Object} params.config
 * @param {number} params.contextDepth
 * @returns {string}
 */
function buildFrameContextPreview({ gallery, current, coverTag, coverLabel, preparedTag, config, contextDepth }) {
  const chosenTemplate = config.prompts?.frameContext || DEFAULT_FRAME_TEMPLATE;
  let frames = buildVisualContextFrames({ gallery, current, coverTag, coverLabel, preparedTag, contextDepth });

  if (frames.length === 0) frames = [{ tag: current?.tag || 'sample_tag', source: 'user' }];

  return frames.map((h, index) => {
    const isLast = index === frames.length - 1;
    const data = {
      n: index + 1, total: frames.length,
      position: isLast ? 'CURRENT ACTIVE frame' : 'previous frame',
      tag: h.tag,
      source: h.source === 'model' ? 'set by you' : 'set by the director',
      ...buildCollagePromptData(h.tag, gallery, coverTag, coverLabel),
    };
    let rendered;
    if (h.tag === '__SCENERY_COLLAGE__') {
      rendered = renderTemplate(CONTACT_SHEET_PROMPT_TEMPLATE, data);
    } else {
      rendered = renderTemplate(chosenTemplate, data);
      if (rendered === null) rendered = renderTemplate(DEFAULT_FRAME_TEMPLATE, data);
    }
    return rendered;
  }).join('\n\n---\n\n');
}

/**
 * @param {Object} params
 * @returns {FrameData[]}
 */
function buildVisualContextFrames({ gallery, current, coverTag, coverLabel, preparedTag, contextDepth }) {
  const depth = contextDepth;
  let frames = [];
  const hasCover = !!coverTag;
  const coverIsCurrent = !!(hasCover && current?.tag === coverTag);

  if (hasCover) {
    const cover = gallery.get(coverTag);
    if (cover) {
      frames.push({ tag: cover.tag, blob: cover.blob, url: cover.url, thumbUrl: cover.thumbUrl, filename: cover.filename || cover.tag, source: 'cover', collageMeta: cover.collageMeta || null });
    }
  }

  if (!coverIsCurrent && depth > 0 && frames.length === 0) {
    // frames from history would come from ProjectorState
  }

  return frames;
}

/**
 * @param {string} tag
 * @param {Map<string, any>} gallery
 * @param {string} coverTag
 * @param {string} coverLabel
 * @returns {Object}
 */
function buildCollagePromptData(tag, gallery, coverTag, coverLabel) {
  const asset = gallery.get(tag);
  const meta = asset?.collageMeta || null;
  const tabs = Array.isArray(meta?.tabs) ? meta.tabs : [];
  const assetTags = tabs.flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []);
  const label = String(coverLabel || '').trim();
  const labelKey = label.toLowerCase();
  const collageTitle = label && !new Set(['cover', 'contact sheet', 'gallery view', 'current gallery view']).has(labelKey) ? label : '';
  const desc = String(asset?.description || '').trim();
  const descKey = desc.toLowerCase();
  const collageDescription = desc && descKey !== 'automatic scenery assets collage' ? desc : '';
  return {
    collageTitle,
    collageDescription,
    allowDirectoryCommands: false, // will be overridden by config
    collageSignature: meta?.signature || meta?.generatedAt || 'not-recorded',
    collageSections: tabs.length ? tabs.map(t => `${t.name || 'tab'} (${Number(t.count || 0)} cards)`).join('; ') : '(sections are visible in the image)',
    collageAssetCount: Number(meta?.assetsCount || assetTags.length || 0) || 'unknown',
  };
}

function isAssetReady(asset) {
  return !!(asset.description && asset.description.trim().length > 0);
}

/**
 * @param {string} templateOverride
 * @returns {string}
 */
function buildManifestWithTemplate(templateOverride, { gallery, current, coverTag, coverLabel, preparedTag, config, fxCatalog, fxMoodCatalog }) {
  return buildManifest({ gallery, current, coverTag, coverLabel, preparedTag, config, fxCatalog, fxMoodCatalog });
}

/**
 * @param {string} templateOverride
 * @returns {string}
 */
function buildFrameContextWithTemplate(templateOverride, { gallery, current, coverTag, coverLabel, preparedTag, config, contextDepth }) {
  return buildFrameContextPreview({ gallery, current, coverTag, coverLabel, preparedTag, config, contextDepth });
}

// ─── Public API ───
export const ManifestBuilder = {
  buildManifest,
  buildFrameContextPreview,
  buildVisualContextFrames,
  buildCollagePromptData,
  buildManifestWithTemplate,
  buildFrameContextWithTemplate,
  DEFAULT_MANIFEST_TEMPLATE,
  DEFAULT_FRAME_TEMPLATE,
  CONTACT_SHEET_PROMPT_TEMPLATE,
  TEMPLATE_VARS,
  renderTemplate,
  _stripInjectedManifest,
  _escapeRegex,
};