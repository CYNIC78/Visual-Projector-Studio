/**
 * @fileoverview AssetPipeline — File processing, thumbnails, import/export.
 * Pure functions, no side effects. Used by GalleryModule.
 */

'use strict';

/**
 * @typedef {Object} BlobData
 * @property {Blob} blob
 * @property {string} url
 */

/**
 * @typedef {Object} AssetRecord
 * @property {string} tag
 * @property {string} filename
 * @property {string} path
 * @property {Blob} blob
 * @property {string} url
 * @property {string} thumbUrl
 * @property {string} description
 * @property {'user' | 'generated' | 'imported' | 'pasted'} source
 * @property {string} [folderContext]
 * @property {string} [tabId]
 * @property {Object} [collageMeta]
 * @property {boolean} hidden
 * @property {boolean} [_draft]
 */

const AssetPipeline = {
  // ─── Config ───
  _config: {
    maxLongSide: 1024,
    jpegQuality: 0.92,
  },

  setConfig(cfg) {
    this._config = { ...this._config, ...cfg };
  },

  // ─── File → Blob Data ───
  /**
   * @param {File} file
   * @returns {Promise<BlobData>}
   */
  fileToBlobData(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { naturalWidth: w, naturalHeight: h } = img;
        const maxSide = this._config.maxLongSide;
        if (Math.max(w, h) > maxSide) {
          if (w >= h) { h = Math.round(h * maxSide / w); w = maxSide; }
          else { w = Math.round(w * maxSide / h); h = maxSide; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('Canvas toBlob failed'));
          resolve({ blob, url: URL.createObjectURL(blob) });
        }, 'image/jpeg', this._config.jpegQuality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(`Failed to load: ${file.name}`)); };
      img.src = url;
    });
  },

  // ─── Thumbnail Generation ───
  /**
   * @param {Blob} blob
   * @returns {Promise<string | null>}
   */
  generateThumbUrl(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const SIZE = 128;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const min = Math.min(img.width, img.height);
        const sx = (img.width - min) / 2;
        const sy = (img.height - min) / 2;
        ctx.drawImage(img, sx, sy, min, min, 0, 0, SIZE, SIZE);
        canvas.toBlob((tb) => resolve(tb ? URL.createObjectURL(tb) : null), 'image/jpeg', 0.7);
      };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  },

  /**
   * @param {AssetRecord} asset
   * @returns {Promise<string>}
   */
  async ensureThumb(asset) {
    if (asset.thumbUrl) return asset.thumbUrl;
    if (!asset.blob) return asset.url || null;
    const t = await this.generateThumbUrl(asset.blob);
    asset.thumbUrl = t;
    return t;
  },

  // ─── Import Legacy Payload ───
  /**
   * @param {AssetRecord} asset
   * @returns {Promise<Blob>}
   */
  async importAssetPayloadToBlob(asset) {
    const src = asset?.base64 || asset?.url || null;
    if (!src) throw new Error('Asset has neither base64 nor url');
    const res = await fetch(src);
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
    return await res.blob();
  },

  // ─── Filename/Tag Helpers ───
  _sanitizeTag(str) {
    return String(str == null ? '' : str)
      .toLowerCase()
      .replace(/[\s\-\.]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
  },

  _isMeaningfulName(name) {
    const junk = [
      /^\d+$/, /^img_?\d+$/i, /^dsc_?\d+$/i, /^photo_?\d+$/i, /^pic_?\d+$/i,
      /^image_?\d+$/i, /^screenshot/i, /^[a-f0-9]{8,}$/i, /^untitled/i, /^\w{1,2}\d{4,}$/,
    ];
    return name.length >= 2 && !junk.some(p => p.test(name));
  },

  _folderIndexCounter: {},
  _getNextFolderIndex(folder) {
    this._folderIndexCounter[folder] = (this._folderIndexCounter[folder] || 0) + 1;
    return this._folderIndexCounter[folder];
  },

  /**
   * @param {string} webkitRelativePath
   * @param {string} filename
   * @returns {string}
   */
  pathToTag(webkitRelativePath, filename) {
    const nameOnly = String(filename).toLowerCase().replace(/\.[^.]+$/, '');
    const parts = String(webkitRelativePath).toLowerCase().split('/');
    const folder = parts.length >= 2 ? this._sanitizeTag(parts[parts.length - 2]) : null;
    let baseTag;
    if (this._isMeaningfulName(nameOnly)) baseTag = this._sanitizeTag(nameOnly);
    else if (folder) return `${folder}_${(this._folderIndexCounter[folder] = (this._folderIndexCounter[folder] || 0) + 1)}`;
    else return `asset_${Date.now()}`;
    if (folder && !baseTag.startsWith(folder + '_') && baseTag !== folder) return `${folder}_${baseTag}`;
    return baseTag;
  },

  /**
   * @param {string} baseTag
   * @param {Map<string, any>} existingAssets
   * @returns {string}
   */
  getUniqueImportedTag(baseTag, existingAssets) {
    const safe = this._sanitizeTag(baseTag || `asset_${Date.now()}`) || `asset_${Date.now()}`;
    let final = safe, n = 1;
    while (existingAssets.has(final)) final = `${safe}_${n++}`.slice(0, 32);
    return final;
  },

  // ─── Asset Creation from Blob/File ───
  /**
   * @param {Blob} blob
   * @param {Object} opts
   * @param {'pasted' | 'generated' | 'imported' | 'user'} [opts.source='pasted']
   * @param {string} [opts.suggestedName]
   * @param {boolean} [opts.setAsCurrent=true]
   * @param {boolean} [opts.instantPersist=true]
   * @returns {Promise<{asset: AssetRecord, tag: string} | null>}
   */
  async addImageFromBlob(blob, opts = {}) {
    const { source = 'pasted', suggestedName = null, setAsCurrent = true, instantPersist = true } = opts;
    if (!blob || !blob.type?.startsWith('image/')) return null;
    try {
      const file = blob instanceof File ? blob : new File([blob], suggestedName || 'pasted.png', { type: blob.type });
      const { blob: outBlob, url } = await this.fileToBlobData(file);
      const thumbUrl = await this.generateThumbUrl(outBlob);
      let tag;
      if (suggestedName) {
        const nameOnly = suggestedName.toLowerCase().replace(/\.[^.]+$/, '');
        tag = this._isMeaningfulName(nameOnly) ? this._sanitizeTag(nameOnly) : null;
      }
      if (!tag) {
        const now = new Date();
        const stamp = `${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}${String(now.getSeconds()).padStart(2,'0')}`;
        tag = `${source}_${stamp}`;
      }
      let finalTag = tag, counter = 1;
      // Note: collision check requires access to gallery assets map
      // This will be handled by the caller (GalleryModule)

      const asset = {
        tag: finalTag,
        filename: file.name || `${finalTag}.png`,
        path: file.name || `${finalTag}.png`,
        blob: outBlob, url, thumbUrl, description: '', source,
        folderContext: null, tabId: null, hidden: false, _draft: !instantPersist,
      };
      return { asset, tag: finalTag };
    } catch (err) {
      console.error('[AssetPipeline] Failed to add image:', err);
      return null;
    }
  },

  // ─── Export / Import ───
  /**
   * @param {AssetRecord} asset
   * @returns {Promise<string>}
   */
  async assetToBase64(asset) {
    if (asset.base64) return asset.base64;
    if (asset.blob) return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(asset.blob);
    });
    if (asset.url) {
      const res = await fetch(asset.url);
      const blob = await res.blob();
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    }
    return '';
  },

  /**
   * @param {AssetRecord[]} assets
   * @param {Object} meta
   * @returns {Promise<Blob>}
   */
  async exportAssetsToJson(assets, meta = {}) {
    const data = {
      version: 2,
      exported: Date.now(),
      ...meta,
      assets: await Promise.all(assets.map(async a => ({
        tag: a.tag, filename: a.filename, path: a.path,
        base64: await this.assetToBase64(a),
        description: a.description || '',
        hidden: false, source: a.source || 'user',
        folderContext: a.folderContext || null, tabId: a.tabId || null,
        collageMeta: a.collageMeta || null,
      }))),
    };
    return new Blob([JSON.stringify(data)], { type: 'application/json' });
  },
};

export { AssetPipeline };