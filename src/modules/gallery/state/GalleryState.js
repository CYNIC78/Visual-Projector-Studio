/**
 * @fileoverview GalleryState — Pure state management for gallery assets, categories, tabs.
 * No DOM, no side effects. Used by GalleryModule and panels via EventBus.
 */

'use strict';

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

// ─── Internal State ───
/** @type {Map<string, AssetRecord>} */
let _assets = new Map();

/** @type {CategoryDef[]} */
let _categories = [];

/** @type {TabDef[]} */
let _tabs = [];

/** @type {string | null} */
let _activeTabId = null;

/** @type {Object<string, {to: string, expiresAt: number, reason: string}>} */
let _tagAliases = {};

/** @type {Object<string, number>} */
let _folderIndexCounter = {};

/** @type {Object} */
let _selection = { tags: new Set(), anchor: null };

/** @type {Object} */
let _tagger = { running: false, cancelled: false, total: 0, done: 0, failed: 0, current: null, lastDesc: '' };

// ─── Helpers ───
function _sanitizeTag(str) {
  return String(str == null ? '' : str)
    .toLowerCase()
    .replace(/[\s\-\.]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

function _isMeaningfulName(name) {
  const junk = [
    /^\d+$/, /^img_?\d+$/i, /^dsc_?\d+$/i, /^photo_?\d+$/i, /^pic_?\d+$/i,
    /^image_?\d+$/i, /^screenshot/i, /^[a-f0-9]{8,}$/i, /^untitled/i, /^\w{1,2}\d{4,}$/,
  ];
  return name.length >= 2 && !junk.some(p => p.test(name));
}

function _getNextFolderIndex(folder) {
  _folderIndexCounter[folder] = (_folderIndexCounter[folder] || 0) + 1;
  return _folderIndexCounter[folder];
}

function _pathToTag(webkitRelativePath, filename) {
  const nameOnly = String(filename).toLowerCase().replace(/\.[^.]+$/, '');
  const parts = String(webkitRelativePath).toLowerCase().split('/');
  const folder = parts.length >= 2 ? _sanitizeTag(parts[parts.length - 2]) : null;

  let baseTag;
  if (_isMeaningfulName(nameOnly)) {
    baseTag = _sanitizeTag(nameOnly);
  } else if (folder) {
    return `${folder}_${_getNextFolderIndex(folder)}`;
  } else {
    return `asset_${_assets.size + 1}`;
  }

  if (folder && !baseTag.startsWith(folder + '_') && baseTag !== folder) {
    return `${folder}_${baseTag}`;
  }
  return baseTag;
}

function _getUniqueImportedTag(baseTag) {
  const safe = _sanitizeTag(baseTag || `asset_${_assets.size + 1}`) || `asset_${_assets.size + 1}`;
  let final = safe, n = 1;
  while (_assets.has(final)) final = `${safe}_${n++}`.slice(0, 32);
  return final;
}

// ─── Public API ───
/** @type {GalleryStateAPI} */
export const GalleryState = {
  // ─── Assets ───
  get assets() { return _assets; },

  /**
   * @param {AssetRecord} asset
   */
  addAsset(asset) {
    _assets.set(asset.tag, asset);
  },

  /**
   * @param {string} tag
   * @returns {AssetRecord | undefined}
   */
  getAsset(tag) { return _assets.get(tag); },

  /**
   * @param {string} tag
   * @returns {boolean}
   */
  hasAsset(tag) { return _assets.has(tag); },

  /**
   * @param {string} tag
   * @returns {boolean}
   */
  deleteAsset(tag) { return _assets.delete(tag); },

  /**
   * @param {string[]} tags
   * @returns {number}
   */
  deleteAssets(tags) {
    let count = 0;
    for (const tag of tags) if (_assets.delete(tag)) count++;
    return count;
  },

  /**
   * @param {string} oldTag
   * @param {string} newTag
   * @returns {boolean}
   */
  renameAsset(oldTag, newTag) {
    newTag = _sanitizeTag(newTag);
    if (!newTag || oldTag === newTag) return false;
    if (_assets.has(newTag)) return false;
    const asset = _assets.get(oldTag);
    if (!asset) return false;
    asset.tag = newTag;
    _assets.delete(oldTag);
    _assets.set(newTag, asset);
    return true;
  },

  /**
   * @param {string[]} tags
   * @param {boolean} hidden
   * @returns {number}
   */
  setAssetsVisibility(tags, hidden) {
    let changed = 0;
    for (const tag of tags) {
      const a = _assets.get(tag);
      if (a && a.hidden !== hidden) { a.hidden = hidden; changed++; }
    }
    return changed;
  },

  /**
   * @param {string} tag
   * @returns {boolean}
   */
  applyDraft(tag) {
    const asset = _assets.get(tag);
    if (!asset || !asset._draft) return false;
    asset._draft = false;
    return true;
  },

  /**
   * @returns {number}
   */
  applyAllDrafts() {
    const drafts = Array.from(_assets.values()).filter(a => a._draft);
    for (const asset of drafts) asset._draft = false;
    return drafts.length;
  },

  /**
   * @returns {Promise<number>}
   */
  async discardAllDrafts() {
    const drafts = Array.from(_assets.values()).filter(a => a._draft);
    const tags = drafts.map(a => a.tag);
    for (const tag of tags) _assets.delete(tag);
    return tags.length;
  },

  // ─── Categories / Tabs ───
  get categories() { return _categories; },
  get tabs() { return _tabs; },
  get activeTabId() { return _activeTabId; },
  setActiveTabId(id) { _activeTabId = id; },

  /**
   * @param {string} [name]
   * @returns {string}
   */
  createCategory(name) {
    const id = 'cat_' + Date.now();
    const existing = _categories.map(c => c.name);
    const finalName = name || this._getUniqueName('New Category', existing);
    _categories.push({ id, name: finalName, desc: '', state: 'open' });
    const tabId = 'tab_' + Date.now() + Math.random().toString(36).slice(2, 5);
    _tabs.push({ id: tabId, categoryId: id, name: 'Assets', desc: '', state: 'open' });
    if (!_activeTabId || _activeTabId === 'effects') _activeTabId = tabId;
    return id;
  },

  _getUniqueName(baseName, existing) {
    if (!existing.includes(baseName)) return baseName;
    let n = 1, name = `${baseName}.${String(n).padStart(3, '0')}`;
    while (existing.includes(name)) { n++; name = `${baseName}.${String(n).padStart(3, '0')}`; }
    return name;
  },

  /**
   * @param {string} categoryId
   * @param {string} [name]
   * @returns {string}
   */
  createTab(categoryId, name) {
    const id = 'tab_' + Date.now();
    const existing = _tabs.filter(t => t.categoryId === categoryId).map(t => t.name);
    const finalName = name || this._getUniqueName('New Tab', existing);
    _tabs.push({ id, categoryId, name: finalName, desc: '', state: 'open' });
    return id;
  },

  /**
   * @param {string} categoryId
   */
  deleteCategory(categoryId) {
    const tabsToDelete = _tabs.filter(t => t.categoryId === categoryId);
    for (const t of tabsToDelete) this.deleteTab(t.id, true);
    _categories = _categories.filter(c => c.id !== categoryId);
  },

  /**
   * @param {string} tabId
   * @param {boolean} [skipRender]
   */
  deleteTab(tabId, skipRender = false) {
    _tabs = _tabs.filter(t => t.id !== tabId);
    const orphans = [];
    for (const [tag, asset] of _assets) if (asset.tabId === tabId) orphans.push(tag);
    if (orphans.length) {
      for (const tag of orphans) _assets.delete(tag);
    }
    if (_activeTabId === tabId) _activeTabId = _tabs[0]?.id || null;
  },

  /**
   * @param {'CAT' | 'TAB'} entityType
   * @param {string} id
   */
  toggleEntityState(entityType, id) {
    const target = entityType === 'CAT'
      ? _categories.find(c => c.id === id)
      : _tabs.find(t => t.id === id);
    if (!target) return;
    if (target.state === 'open') target.state = 'collapsed';
    else if (target.state === 'collapsed') target.state = 'locked';
    else target.state = 'open';
  },

  /**
   * @param {string} draggedTabId
   * @param {'CAT' | 'TAB'} targetType
   * @param {string} targetId
   */
  moveTab(draggedTabId, targetType, targetId) {
    const tabs = _tabs;
    const di = tabs.findIndex(t => t.id === draggedTabId);
    if (di === -1) return;
    const dragged = tabs[di];

    if (targetType === 'CAT') {
      if (dragged.categoryId !== targetId) {
        dragged.categoryId = targetId;
        tabs.splice(di, 1);
        tabs.push(dragged);
      }
    } else if (targetType === 'TAB') {
      if (draggedTabId === targetId) return;
      const ti = tabs.findIndex(t => t.id === targetId);
      if (ti === -1) return;
      dragged.categoryId = tabs[ti].categoryId;
      tabs.splice(di, 1);
      let ni = tabs.findIndex(t => t.id === targetId);
      if (di < ti) ni += 1;
      tabs.splice(ni, 0, dragged);
    }
  },

  /**
   * @param {'CAT' | 'TAB'} entityType
   * @param {string} action
   * @param {string} name
   */
  executeAICommand(entityType, action, name) {
    const targetName = String(name).trim().toLowerCase();
    const actionKey = String(action || '').trim().toLowerCase().replace(/ё/g, 'е').replace(/[\s\-]+/g, '_');
    const actionMap = {
      open: 'open', opened: 'open', expand: 'open', show: 'open', reveal: 'open', load: 'open',
      открыть: 'open', открой: 'open', развернуть: 'open', разверни: 'open', показать: 'open', покажи: 'open',
      collapse: 'collapsed', collapsed: 'collapsed', close: 'collapsed', fold: 'collapsed', hide: 'collapsed', unload: 'collapsed',
      свернуть: 'collapsed', сверни: 'collapsed', закрыть: 'collapsed', закрой: 'collapsed', скрыть: 'collapsed', спрячь: 'collapsed',
    };
    const normalizedAction = actionMap[actionKey] || actionKey;

    const find = entityType === 'CAT'
      ? this._fuzzyMatch(name, _categories, c => c.name)
      : this._fuzzyMatch(name, _tabs, t => t.name);

    if (find && find.state !== 'locked' && (normalizedAction === 'open' || normalizedAction === 'collapsed')) {
      if (find.state !== normalizedAction) {
        find.state = normalizedAction;
        // If AI opened a tab, trigger collage regeneration
        if (entityType === 'TAB' && normalizedAction === 'open') {
          _tabs.forEach(t => t.markedForCollage = t.id === find.id);
        }
        return { changed: true, matchedName: find.name };
      }
    }
    return { changed: false };
  },

  _fuzzyMatch(target, options, keySelector) {
    if (!target || !options.length) return null;
    const normTarget = target.trim().toLowerCase();
    if (!normTarget) return null;
    let bestMatch = options.find(opt => keySelector(opt).trim().toLowerCase() === normTarget);
    if (bestMatch) return bestMatch;
    const stripSuffixes = (str) => str.replace(/(s|es|и|ы|а|я|ов|ей|ям|ам|ами|ями|ах|ях)$/i, '');
    const targetStem = stripSuffixes(normTarget);
    bestMatch = options.find(opt => stripSuffixes(keySelector(opt).trim().toLowerCase()) === targetStem);
    if (bestMatch) return bestMatch;
    bestMatch = options.find(opt => {
      const normOpt = keySelector(opt).trim().toLowerCase();
      return normOpt.includes(normTarget) || normTarget.includes(normOpt);
    });
    if (bestMatch) return bestMatch;
    let minDist = Infinity, matched = null;
    for (const opt of options) {
      const optName = keySelector(opt).trim().toLowerCase();
      const dist = this._levenshtein(normTarget, optName);
      const maxAllowed = Math.max(2, Math.floor(optName.length * 0.35));
      if (dist <= maxAllowed && dist < minDist) { minDist = dist; matched = opt; }
    }
    return matched;
  },

  _levenshtein(a, b) {
    const matrix = [];
    for (let i = 0; i <= b.length; i++) matrix[i] = [i];
    for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
    for (let i = 1; i <= b.length; i++) {
      for (let j = 1; j <= a.length; j++) {
        if (b.charAt(i - 1) === a.charAt(j - 1)) matrix[i][j] = matrix[i - 1][j - 1];
        else matrix[i][j] = Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
      }
    }
    return matrix[b.length][a.length];
  },

  // ─── Tag Aliases ───
  get tagAliases() { return _tagAliases; },

  registerTagAlias(oldTag, newTag, reason = 'asset-rename') {
    if (!oldTag || !newTag || oldTag === newTag) return;
    _tagAliases[oldTag] = { to: newTag, reason, createdAt: Date.now() };
  },

  // ─── Folder Index Counter ───
  getNextFolderIndex(folder) { return _getNextFolderIndex(folder); },

  // ─── Selection ───
  get selection() { return _selection; },

  clearSelection() { _selection.tags.clear(); _selection.anchor = null; },

  handleAssetClick(tag, evt) {
    const sel = _selection;
    if (evt.shiftKey && sel.anchor) {
      const visible = this.getVisibleTags();
      const i1 = visible.indexOf(sel.anchor), i2 = visible.indexOf(tag);
      if (i1 !== -1 && i2 !== -1) {
        const [from, to] = i1 < i2 ? [i1, i2] : [i2, i1];
        for (let i = from; i <= to; i++) sel.tags.add(visible[i]);
      } else sel.tags.add(tag);
    } else if (evt.ctrlKey || evt.metaKey) {
      if (sel.tags.has(tag)) sel.tags.delete(tag); else sel.tags.add(tag);
      sel.anchor = tag;
    } else {
      if (sel.tags.size === 1 && sel.tags.has(tag)) { sel.tags.clear(); sel.anchor = null; }
      else { sel.tags.clear(); sel.tags.add(tag); sel.anchor = tag; }
    }
  },

  getVisibleTags() {
    // Filter by active tab (simplified)
    return Array.from(_assets.keys()).sort();
  },

  // ─── Tagger State ───
  get tagger() { return _tagger; },

  // ─── Folder Index Counter (legacy) ───
  get folderIndexCounter() { return _folderIndexCounter; },

  // ─── Import Helpers ───
  pathToTag(webkitRelativePath, filename) { return _pathToTag(webkitRelativePath, filename); },
  getUniqueImportedTag(baseTag) { return _getUniqueImportedTag(baseTag); },
  sanitizeTag: _sanitizeTag,
  isMeaningfulName: _isMeaningfulName,
};