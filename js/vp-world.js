// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-world.js — Blender-like World Save System                    ║
// ║  RAM-first: everything lives in S (State) in memory, disk only   ║
// ║  on explicit Save (Ctrl+S) or AutoSave timer to backups.        ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const getVP = () => window.VisualProjector || null;
    const getS = () => window.VisualProjector?.state || null;
    const DB = () => window.VP_DB || window.VP_STORAGE || null;

    const World = {
        isDirty: false,
        dirtyScopes: new Set(),
        lastSavedAt: null,
        lastQuickSavedAt: null,
        saveVersion: 0,
        _titleBase: null,
        _saveInProgress: false,

        _getS() { return getS(); },
        _getVP() { return getVP(); },

        init() {
            const vp = getVP();
            const s = getS();
            if (!vp || !s) {
                // Core not ready yet — retry
                console.log('[VP World] VP.state not yet ready, retrying...');
                setTimeout(() => this.init(), 500);
                return;
            }
            this._titleBase = document.title.replace(/\*$/, '').trim() || 'Visual Projector';
            this._bindShortcuts();
            this._bindBeforeUnload();
            console.log('[VP World] RAM-first Save System ready — explicit Save required');
        },

        markDirty(scope = 'misc') {
            const wasClean = !this.isDirty;
            this.isDirty = true;
            this.dirtyScopes.add(scope);

            // * indicator like Blender — safe if _titleBase not yet set
            if (this._titleBase) {
                if (!document.title.endsWith('*')) {
                    document.title = this._titleBase + ' *';
                }
            }

            const saveBtn = document.getElementById('vp-world-save');
            if (saveBtn) {
                saveBtn.classList.add('is-dirty');
                saveBtn.title = `Save World — unsaved changes in: ${Array.from(this.dirtyScopes).join(', ')} (Ctrl+S)`;
            }

            this._scheduleQuickSave();

            if (wasClean) {
                console.log(`[VP World] Now dirty — scope: ${scope}`);
            }
        },

        clearDirty() {
            this.isDirty = false;
            this.dirtyScopes.clear();
            if (this._titleBase) document.title = this._titleBase;
            const saveBtn = document.getElementById('vp-world-save');
            if (saveBtn) {
                saveBtn.classList.remove('is-dirty');
                saveBtn.title = 'Save World (Ctrl+S) — all saved ✓';
            }
        },

        getDirtyScopes() {
            return Array.from(this.dirtyScopes);
        },

        _quickSaveTimer: null,
        _scheduleQuickSave() {
            clearTimeout(this._quickSaveTimer);
            this._quickSaveTimer = setTimeout(() => this.quickSave(), 3000);
        },

        quickSave() {
            if (!this.isDirty) return;
            const S = getS();
            if (!S) return;
            try {
                const snap = {
                    ts: Date.now(),
                    shell: S.shell ? JSON.parse(JSON.stringify(S.shell)) : null,
                    config: S.config ? JSON.parse(JSON.stringify(S.config)) : null,
                    galleryData: S.galleryData ? JSON.parse(JSON.stringify(S.galleryData)) : null,
                    dirtyScopes: Array.from(this.dirtyScopes),
                    worldId: DB()?.getBackendInfo?.()?.worldId || 'default'
                };
                sessionStorage.setItem('vp-quicksave', JSON.stringify(snap));
                this.lastQuickSavedAt = Date.now();
            } catch (e) {
                console.warn('[VP World] QuickSave failed', e);
            }
        },

        checkQuickSaveRecovery() {
            try {
                const raw = sessionStorage.getItem('vp-quicksave');
                if (!raw) return null;
                const snap = JSON.parse(raw);
                if (!snap || !snap.ts) return null;
                if (!this.lastSavedAt || snap.ts > this.lastSavedAt) {
                    return snap;
                }
                return null;
            } catch {
                return null;
            }
        },

        async save(opts = {}) {
            const VP = getVP();
            const S = getS();
            const reason = opts.reason || 'user';
            if (this._saveInProgress) {
                console.log('[VP World] Save already in progress, skipping');
                return false;
            }
            const db = DB();
            if (!db) {
                console.warn('[VP World] No DB backend for save');
                return false;
            }
            if (!S) {
                console.warn('[VP World] No S state for save');
                return false;
            }

            this._saveInProgress = true;
            const start = Date.now();
            try {
                console.log(`[VP World] Saving world (${reason}) — scopes: ${Array.from(this.dirtyScopes).join(', ')}`);

                const getOrig = (m) => {
                    const pm = window.VP_PERSIST;
                    if (pm?._getOriginalDBMethod) {
                        const orig = pm._getOriginalDBMethod(m);
                        if (orig) return orig;
                    }
                    return db[m]?.bind(db) || null;
                };

                const tasks = [];

                if (this.dirtyScopes.has('shell') || this.dirtyScopes.size === 0 || reason === 'full' || reason === 'user-click' || reason === 'ctrl+s') {
                    const fn = getOrig('setShellState');
                    if (S.shell && fn) tasks.push(fn(S.shell).catch(e => console.warn('save shell failed', e)));
                }
                if (this.dirtyScopes.has('config') || reason === 'full' || reason.includes('ctrl')) {
                    const fnCfg = getOrig('setConfig');
                    const fnModel = getOrig('setModelConfig');
                    if (S.config && fnCfg) tasks.push(fnCfg(S.config).catch(e => console.warn('save config failed', e)));
                    if (S.modelConfig && fnModel) tasks.push(fnModel(S.modelConfig).catch(e => console.warn('save modelConfig failed', e)));
                }
                if (this.dirtyScopes.has('gallery') || this.dirtyScopes.has('gallery-meta') || this.dirtyScopes.has('galleryData') || reason === 'full') {
                    const fn = getOrig('setGalleryData');
                    if (S.galleryData && fn) tasks.push(fn(S.galleryData).catch(e => console.warn('save galleryData failed', e)));
                }
                if (this.dirtyScopes.has('chats') || this.dirtyScopes.has('session') || this.dirtyScopes.has('chatStore') || reason === 'full') {
                    const fnChat = getOrig('setChatStore');
                    const fnSess = getOrig('setSessionState');
                    if (fnChat) {
                        const chatsApi = VP?.chats;
                        if (chatsApi?.getChatStoreSnapshot) {
                            const snap = chatsApi.getChatStoreSnapshot();
                            if (snap) tasks.push(fnChat(snap).catch(() => {}));
                        } else if (S.chatStore) {
                            tasks.push(fnChat(S.chatStore).catch(() => {}));
                        }
                    }
                    if (S.session && fnSess) {
                        tasks.push(fnSess(S.session).catch(() => {}));
                    }
                }
                if (this.dirtyScopes.has('projector') || reason === 'full') {
                    const fn = getOrig('setProjectorState');
                    if (VP?.getProjectorSnapshot && fn) {
                        const snap = VP.getProjectorSnapshot();
                        tasks.push(fn(snap).catch(() => {}));
                    }
                }
                if (this.dirtyScopes.has('profiles') || reason === 'full') {
                    const fn = getOrig('setProfiles');
                    const profiles = S.profiles || VP?.chats?.getProfilesSnapshot?.();
                    if (profiles && fn) tasks.push(fn(profiles).catch(() => {}));
                }
                if (this.dirtyScopes.has('customCss') || reason === 'full') {
                    const fn = getOrig('setCustomCss');
                    const css = document.getElementById('vp-world-custom-style')?.textContent || '';
                    if (fn && css) tasks.push(fn(css).catch(() => {}));
                }

                if (!tasks.length) {
                    const fnShell = getOrig('setShellState');
                    if (S.shell && fnShell) tasks.push(fnShell(S.shell).catch(() => {}));
                    const fnCfg = getOrig('setConfig');
                    if (S.config && fnCfg) tasks.push(fnCfg(S.config).catch(() => {}));
                }

                await Promise.all(tasks);

                this.lastSavedAt = Date.now();
                this.saveVersion++;
                this.clearDirty();

                try { sessionStorage.removeItem('vp-quicksave'); } catch {}

                const elapsed = Date.now() - start;
                console.log(`[VP World] Saved in ${elapsed}ms (v${this.saveVersion}, reason: ${reason})`);
                VP?.showToast?.(`💾 World saved (${reason}, ${elapsed}ms)`, 'success');

                const saveBtn = document.getElementById('vp-world-save');
                if (saveBtn) {
                    saveBtn.textContent = '💾 ✓';
                    setTimeout(() => { if (saveBtn) saveBtn.textContent = '💾'; }, 1200);
                }

                return true;
            } catch (err) {
                console.error('[VP World] Save failed', err);
                getVP()?.showToast?.(`Save failed: ${err.message || err}`, 'error');
                return false;
            } finally {
                this._saveInProgress = false;
            }
        },

        _autoSaveTimer: null,
        _autoSaveInterval: 60 * 1000,

        startAutoSave(intervalMs = 60 * 1000) {
            this._autoSaveInterval = intervalMs;
            clearInterval(this._autoSaveTimer);
            this._autoSaveTimer = setInterval(() => {
                if (!this.isDirty) return;
                this.autoSave();
            }, this._autoSaveInterval);
            console.log(`[VP World] AutoSave timer started — every ${intervalMs/1000}s to backups/autosave/`);
        },

        stopAutoSave() {
            clearInterval(this._autoSaveTimer);
            this._autoSaveTimer = null;
        },

        async autoSave() {
            if (!this.isDirty) return;
            const db = DB();
            if (!db?.backupWorld && !db?.exportWorld) {
                console.log('[VP World] AutoSave: backupWorld API not available, quicksave only');
                this.quickSave();
                return;
            }
            try {
                console.log('[VP World] AutoSave → backups/autosave/ (quicksave)');
                if (window.VP_PERSIST?.mode === 'auto') {
                    await this.save({ reason: 'autosave' });
                } else {
                    this.quickSave();
                }
                getVP()?.showToast?.('💾 AutoSave (RAM) — quicksave updated', 'info');
            } catch (e) {
                console.warn('[VP World] AutoSave failed', e);
            }
        },

        async confirmUnsavedOnExit() {
            if (!this.isDirty) return true;
            const VP = getVP();
            const ans = await VP?.showConfirm?.({
                title: 'Save changes?',
                message: `World has unsaved changes in: ${Array.from(this.dirtyScopes).join(', ')}.\n\nSave before exit?`,
                buttons: [
                    { id: 'cancel', label: 'Cancel', ghost: true },
                    { id: 'dontsave', label: "Don't Save", danger: false },
                    { id: 'save', label: '💾 Save', danger: false }
                ]
            });
            if (ans === 'cancel') return false;
            if (ans === 'save') {
                await this.save({ reason: 'exit' });
            }
            return true;
        },

        _bindShortcuts() {
            document.addEventListener('keydown', (e) => {
                if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                    e.preventDefault();
                    this.save({ reason: 'ctrl+s' });
                }
            });
        },

        _bindBeforeUnload() {
            window.addEventListener('beforeunload', (e) => {
                if (!this.isDirty) return;
                this.quickSave();
                const msg = 'You have unsaved changes — save before exit?';
                e.preventDefault();
                e.returnValue = msg;
                return msg;
            });
        },

        async offerRecoveryIfNeeded() {
            const VP = getVP();
            const S = getS();
            if (!S) return;
            const snap = this.checkQuickSaveRecovery();
            if (!snap) return;
            const age = Math.round((Date.now() - snap.ts) / 1000);
            const ans = await VP?.showConfirm?.({
                title: 'Recover QuickSave?',
                message: `Found QuickSave from ${age}s ago with unsaved changes in: ${(snap.dirtyScopes || []).join(', ')}.\n\nRestore it?\n\n(QuickSave is RAM-based, cheap, no disk abuse)`,
                buttons: [
                    { id: 'discard', label: 'Discard', ghost: true },
                    { id: 'recover', label: 'Recover', danger: false }
                ]
            });
            if (ans !== 'recover') {
                try { sessionStorage.removeItem('vp-quicksave'); } catch {}
                return;
            }
            try {
                if (snap.shell && S.shell) {
                    S.shell = { ...S.shell, ...snap.shell };
                    console.log('[VP World] Recovered shell from quicksave');
                }
                if (snap.config && S.config) {
                    S.config = { ...S.config, ...snap.config };
                }
                if (snap.galleryData && S.galleryData) {
                    S.galleryData = { ...S.galleryData, ...snap.galleryData };
                }
                this.markDirty('recovered');
                VP?.showToast?.('🔄 QuickSave recovered', 'success');
                VP?.shell?.render?.();
            } catch (e) {
                console.warn('[VP World] Recovery failed', e);
            }
        }
    };

    window.VP_WORLD = World;
    if (window.VisualProjector) {
        window.VisualProjector.world = World;
    } else {
        // Will be attached when VP boots
        const prev = window.VisualProjector;
        Object.defineProperty(window, 'VisualProjector', {
            configurable: true,
            get() { return prev || window._vp_pending || null; },
            set(v) {
                window._vp_pending = v;
                if (v) v.world = World;
                // replace own prop
                Object.defineProperty(window, 'VisualProjector', { value: v, writable: true, configurable: true });
                window.VisualProjector = v;
            }
        });
        // Fallback: if setter not triggered, interval attach
        const attachInt = setInterval(() => {
            if (window.VisualProjector && !window.VisualProjector.world) {
                window.VisualProjector.world = World;
                clearInterval(attachInt);
            }
            if (window._vp_pending?.state) clearInterval(attachInt);
        }, 300);
        setTimeout(() => clearInterval(attachInt), 10000);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => World.init());
    } else {
        setTimeout(() => World.init(), 0);
    }

})();
