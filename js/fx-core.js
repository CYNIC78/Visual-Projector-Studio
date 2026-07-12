(function () {
    'use strict';

    // ──────────────── DYNAMIC STATE ACCESS ────────────────
    // State НЕ захватывается при загрузке — fx-core.js грузится ДО
    // visual-projector.js, и window.VisualProjector ещё не существует.
    // Используем функцию-аксессор, которая всегда возвращает актуальный State.
    function _st() { return window.VisualProjector?.state || { config: {}, ui: {} }; }

    const FX = {
        get enabled() { return _st().config.effectsEnabled !== false; },

        lastFired: {},

        // ──────────────── MOOD SLOT (v3.8 #4 overhaul) ────────────────
        // Единый слот для активной mood: только одна mood живёт одновременно.
        // Новая mood чисто заменяет старую через _disposeMoodSlot().
        // Таймеры скоуплены к слоту — никакой глобальной корзины.
        //
        // Структура слота:
        //   { overlay: HTMLElement|null, timerId: number, name: string,
        //     intensity: number, extraTimers: number[] }
        _moodSlot: null,

        /** Текущий оверлей активной mood (backward compat) */
        get activeMood()     { return this._moodSlot?.overlay || null; },
        /** Имя активной mood (backward compat) */
        get activeMoodName() { return this._moodSlot?.name || null; },

        // Реестр с базовыми эффектами
        registry: {}, 

        // ──────────────── ПОЛЬЗОВАТЕЛЬСКИЕ НАСТРОЙКИ ЭФФЕКТОВ ────────────────
        // Оверлей поверх реестра: ничего не удаляем из registry физически,
        // а лишь помечаем эффекты как скрытые/удалённые. Полностью обратимо.
        _hidden: null,            // Set<name> — скрыты от бота (юзер всё ещё может перетащить)
        _deleted: null,           // Set<name> — удалены (нет в гриде, не видны боту, не запускаются)
        _effectSource: {},        // name -> 'builtin' | '<имя пака>'
        _loadingPackName: null,   // временный контекст при загрузке пака

        _loadPrefs() {
            if (this._hidden && this._deleted) return;
            try { this._hidden = new Set(JSON.parse(localStorage.getItem('vp-fx-hidden') || '[]')); }
            catch (e) { this._hidden = new Set(); }
            try { this._deleted = new Set(JSON.parse(localStorage.getItem('vp-fx-deleted') || '[]')); }
            catch (e) { this._deleted = new Set(); }
        },

        _savePrefs() {
            try {
                localStorage.setItem('vp-fx-hidden', JSON.stringify([...this._hidden]));
                localStorage.setItem('vp-fx-deleted', JSON.stringify([...this._deleted]));
            } catch (e) { console.warn('[VP FX] ⚠️ Не удалось сохранить настройки эффектов:', e); }
        },

        isHidden(name)  { this._loadPrefs(); return this._hidden.has(name); },
        isDeleted(name) { this._loadPrefs(); return this._deleted.has(name); },

        getEffectSource(name) { return this._effectSource[name] || 'builtin'; },

        /** Скрыть/показать эффект для бота (не трогает грид и ручной запуск). */
        setHidden(name, val) {
            this._loadPrefs();
            if (val) this._hidden.add(name); else this._hidden.delete(name);
            this._savePrefs();
            return val;
        },
        toggleHidden(name) { return this.setHidden(name, !this.isHidden(name)); },

        /** Мягко удалить эффект (обратимо через restoreEffect). */
        deleteEffect(name) {
            this._loadPrefs();
            this._deleted.add(name);
            this._hidden.delete(name);   // удалённому флаг "скрыт" уже не нужен
            this._savePrefs();
        },

        /** Восстановить ранее удалённый эффект. */
        restoreEffect(name) {
            this._loadPrefs();
            this._deleted.delete(name);
            this._savePrefs();
        },

        /** Список имён удалённых эффектов, которые ещё присутствуют в реестре. */
        listDeleted() {
            this._loadPrefs();
            return Object.keys(this.registry).filter(n => this._deleted.has(n));
        },

        /**
         * Полностью удалить импортированный пак: убирает его эффекты из
         * реестра и стирает код пака из localStorage (необратимо до повторного импорта).
         * Возвращает массив имён удалённых эффектов.
         */
        removePack(packName) {
            this._loadPrefs();
            const removed = [];
            for (const [name, src] of Object.entries(this._effectSource)) {
                if (src === packName) {
                    delete this.registry[name];
                    delete this._effectSource[name];
                    this._hidden.delete(name);
                    this._deleted.delete(name);
                    removed.push(name);
                }
            }
            this._savePrefs();
            try {
                const packs = JSON.parse(localStorage.getItem('vp-fx-packs') || '{}');
                if (packs[packName]) { delete packs[packName]; localStorage.setItem('vp-fx-packs', JSON.stringify(packs)); }
            } catch (e) { console.warn('[VP FX] ⚠️ Не удалось обновить хранилище паков:', e); }
            console.log(`[VP FX] 🗑️ Удалён пак "${packName}" (${removed.length} эффект(ов))`);
            return removed;
        },

        // ──────────────── ПУБЛИЧНЫЙ API ────────────────
        
        register(effectsObj, sourceName) {
            if (!effectsObj || typeof effectsObj !== 'object') return;

            // Источник: явный аргумент → контекст загрузки пака → 'builtin'
            const source = sourceName || this._loadingPackName || 'builtin';

            for (const [name, effect] of Object.entries(effectsObj)) {
                this.registry[name] = effect;
                this._effectSource[name] = source;

                // Повторная регистрация эффекта (re-import пака) автоматически
                // восстанавливает его из корзины/скрытых — юзер обновляет пак,
                // а не страдает с ручным restore каждого эффекта.
                if (this._deleted) this._deleted.delete(name);
                if (this._hidden) this._hidden.delete(name);

                if (effect.css) {
                    const style = document.createElement('style');
                    style.textContent = `/* Custom FX: ${name} */\n${effect.css}`;
                    document.head.appendChild(style);
                }
            }
            this._savePrefs();
            console.log(`[VP FX] 📦 Registered effects (${source}):`, Object.keys(effectsObj));
        },

        list() { return Object.keys(this.registry); },

        /** Эффект доступен боту: существует, не удалён и не скрыт. */
        isAvailableToBot(name) {
            return !!this.registry[name] && !this.isDeleted(name) && !this.isHidden(name);
        },

        get emojiMap() {
            const map = {};
            for (const [name, effect] of Object.entries(this.registry)) {
                if (!this.isAvailableToBot(name)) continue;
                const emojis = Array.isArray(effect.emoji) ? effect.emoji : [];
                for (const emoji of emojis) { if (emoji) map[emoji] = name; }
            }
            return map;
        },

        get catalog() {
            const catalog = {};
            for (const [name, effect] of Object.entries(this.registry)) {
                if (!['transient', 'ui'].includes(effect.type)) continue;
                if (!this.isAvailableToBot(name)) continue;
                catalog[name] = {
                    emojis: Array.isArray(effect.emoji) ? effect.emoji.join('') : '',
                    desc: effect.description || '',
                    type: effect.type || 'transient'
                };
            }
            return catalog;
        },

        get uiCatalog() {
            const catalog = {};
            for (const [name, effect] of Object.entries(this.registry)) {
                if (effect.type !== 'ui') continue;
                if (!this.isAvailableToBot(name)) continue;
                catalog[name] = { desc: effect.description || '' };
            }
            return catalog;
        },

        get moodCatalog() {
            const catalog = {};
            for (const [name, effect] of Object.entries(this.registry)) {
                if (effect.type !== 'mood') continue;
                if (!this.isAvailableToBot(name)) continue;
                catalog[name] = { desc: effect.description || '' };
            }
            return catalog;
        },

        get moodPresets() {
            const presets = {};
            for (const [name, effect] of Object.entries(this.registry)) {
                if (effect.type === 'mood' && effect.preset && !this.isDeleted(name)) presets[name] = effect.preset;
            }
            return presets;
        },

        parseRequest(rawName, explicitIntensity) {
            let name = String(rawName ?? '').trim();
            let intensity = explicitIntensity;

            if ((intensity === undefined || intensity === null || intensity === '') && name.includes(':')) {
                const parts = name.split(':');
                name = parts[0];
                intensity = parts[1];
            }

            intensity = parseInt(intensity, 10);
            if (isNaN(intensity) || intensity < 1) intensity = 5;
            if (intensity > 10) intensity = 10;

            return { name, intensity };
        },

        fire(rawName, explicitIntensity) {
            if (!this.enabled) return;

            const { name, intensity } = this.parseRequest(rawName, explicitIntensity);
            if (!name) return;

            const effect = this.registry[name];
            if (!effect) {
                console.warn(`[VP FX] ⚠️ Effect not found: ${name}`);
                return;
            }

            // Удалённые эффекты не запускаются ни при каких условиях.
            // (Скрытые — запускаются: юзер мог осознанно вставить [FX:name] вручную.)
            if (this.isDeleted(name)) {
                console.log(`[VP FX] ⏭️ Effect "${name}" is deleted — skipped.`);
                return;
            }

            // Любой эффект (особенно из стороннего пака) исполняем в защищённой
            // обёртке: исключение в чужом коде НЕ должно ронять чат-стрим или UI.
            try {
                if (effect.type === 'mood') {
                    // ── MOOD: single-active-mood модель ──
                    // Предыдущая mood всегда утилизируется перед запуском новой.
                    //
                    // Apply-mood flow:
                    //   1. _disposeMoodSlot() — убить предыдущую mood
                    //   2. _applyContext = { extraTimers: [] } — временный буфер для
                    //      trackTimer(), чтобы apply() мог регистрировать таймеры
                    //      ДО того как setMood() создаст настоящий слот.
                    //   3. apply() вызывается → внутри может вызвать ctx.setMood()
                    //      (которая создаст _moodSlot) и/или ctx.trackTimer()
                    //   4. После apply() — мерджим _applyContext.extraTimers в слот.
                    //
                    // ВАЖНО: НЕ создаём placeholder-слот перед apply() — иначе
                    // setMood() увидит совпадение name+intensity и шорт-церситит
                    // на _refreshMoodSlot() вместо создания реального оверлея!
                    if (typeof effect.apply === 'function') {
                        this._disposeMoodSlot();
                        this._applyContext = { extraTimers: [] };
                        try {
                            effect.apply(intensity, this, name);
                        } finally {
                            const pending = this._applyContext.extraTimers;
                            this._applyContext = null;
                            if (this._moodSlot && pending.length > 0) {
                                this._moodSlot.extraTimers.push(...pending);
                            } else if (!this._moodSlot && pending.length > 0) {
                                // apply() не создал слот (например "nothing" mood)
                                // — чистим осиротевшие таймеры
                                for (const id of pending) {
                                    clearInterval(id);
                                    clearTimeout(id);
                                }
                            }
                        }
                    } else if (effect.preset) {
                        this.setMood(name, intensity);
                    }
                    return;
                }

                // ── NON-MOOD EFFECTS (transient / ui / future lightweight types) ──
                const now = Date.now();
                const throttleMs = typeof effect.throttleMs === 'number' ? effect.throttleMs : 2000;
                // Throttle глушит только ПОВТОР ТОГО ЖЕ эффекта С ТОЙ ЖЕ силой в окне.
                // Если intensity изменилась — это семантически другой запрос (например
                // ui_hp с новым значением HP, или shake:2 → shake:9), и его нельзя терять.
                const last = this.lastFired[name];
                if (
                    throttleMs > 0 &&
                    last &&
                    last.intensity === intensity &&
                    now - last.t < throttleMs
                ) return;
                this.lastFired[name] = { t: now, intensity };

                if (typeof effect.fire === 'function') {
                    console.log(`[VP FX] 🎬 Firing: ${name} (type ${effect.type || 'transient'}, intensity ${intensity})`);
                    effect.fire(intensity, this, name);
                }
            } catch (err) {
                console.error(`[VP FX] ❌ Effect "${name}" threw and was contained (stream/UI protected):`, err);
            }
        },

        // ──────────────── УТИЛИТЫ ДЛЯ ТАЙМЕРОВ (СКОУПЛЕНЫ К MOOD SLOT) ────────────────
        // trackTimer / clearTrackedTimers больше НЕ используют глобальный массив.
        // Таймеры регистрируются в _moodSlot.extraTimers и чистятся только
        // при утилизации этого конкретного слота — никакой кросс-mood гонки.

        /** Зарегистрировать таймер.
         *  Во время apply() — пишет в _applyContext (временный буфер).
         *  В остальное время — пишет в _moodSlot.extraTimers. */
        trackTimer(id) {
            if (this._applyContext) {
                this._applyContext.extraTimers.push(id);
            } else if (this._moodSlot) {
                this._moodSlot.extraTimers.push(id);
            }
            return id;
        },

        /** Очистить extra-таймеры текущего mood-слота (не чужие!). */
        clearTrackedTimers() {
            if (!this._moodSlot) return;
            for (const id of this._moodSlot.extraTimers) {
                clearInterval(id);
                clearTimeout(id);
            }
            this._moodSlot.extraTimers = [];
        },

        // ──────────────── MOOD-СИСТЕМА (v3.8 #4 overhaul) ────────────────
        //
        // Принцип: одна mood — один слот. Новая mood чисто заменяет старую.
        // Таймеры скоуплены к слоту. Никакого глобального _activeTimers[].
        //
        // _disposeMoodSlot()  — единственная точка утилизации (kill timers + animate out)
        // _refreshMoodSlot()  — перезапуск lifecycle без пересоздания overlay
        // setMood()           — публичный API: создать/заменить mood
        // clearMood()         — публичный API: убрать mood
        //
        // Контракт для кастомных apply()-mood:
        //   1. _disposeMoodSlot() вызывается ДО apply()
        //   2. Пустой _moodSlot создаётся для трекинга таймеров
        //   3. apply() может вызвать FX.setMoodOverlay(el) для регистрации
        //      главного оверлея — тогда _disposeMoodSlot() анимирует его выход

        /** Зарегистрировать главный оверлей для apply()-mood (опционально). */
        setMoodOverlay(overlay) {
            if (this._moodSlot && overlay) {
                this._moodSlot.overlay = overlay;
            }
        },

        setMood(name, intensity = 5) {
            const effect = this.registry[name];
            const preset = effect?.preset;
            if (!effect || effect.type !== 'mood' || !preset) return;

            const screen = _st().ui?.screen;
            if (!screen) return;

            // Та же mood с той же intensity → обновить lifecycle (перезапустить таймер)
            if (this._moodSlot && this._moodSlot.name === name && this._moodSlot.intensity == intensity) {
                this._refreshMoodSlot();
                return;
            }

            // Утилизировать предыдущую mood (гарантия: только одна живёт)
            this._disposeMoodSlot();

            const lifespanSeconds = 30 + intensity * 6;

            const overlay = document.createElement('div');
            overlay.className = `vp-fx-mood vp-fx-mood-active vp-fx-pulse-${preset.pulse}`;
            overlay.dataset.intensity = intensity;
            overlay.dataset.name = name;
            overlay.style.setProperty('--mood-lifespan', `${lifespanSeconds}s`);

            const strengthMul = 0.3 + (intensity / 10) * 0.7;
            overlay.style.background = `radial-gradient(ellipse at center, transparent 30%, ${preset.color} 100%)`;
            overlay.style.mixBlendMode = preset.blend;
            overlay.style.opacity = strengthMul;

            screen.appendChild(overlay);

            const timerId = setTimeout(() => {
                // Слот всё ещё принадлежит этому overlay? → утилизируем
                if (this._moodSlot?.overlay === overlay) {
                    this._disposeMoodSlot();
                }
            }, lifespanSeconds * 1000 + 100);

            this._moodSlot = {
                overlay,
                timerId,
                name,
                intensity,
                extraTimers: [],
            };
        },

        /** Перезапуск lifecycle текущего mood-слота (та же mood, новый таймер). */
        _refreshMoodSlot() {
            const slot = this._moodSlot;
            if (!slot) return;

            // Убить старый lifecycle-таймер
            clearTimeout(slot.timerId);

            // Перезапустить CSS-анимацию
            if (slot.overlay) {
                slot.overlay.classList.remove('vp-fx-mood-active');
                void slot.overlay.offsetWidth; // force reflow
                slot.overlay.classList.add('vp-fx-mood-active');
            }

            // Пересчитать lifespan из CSS-переменной
            const lifespanStr = slot.overlay?.style.getPropertyValue('--mood-lifespan') || '60s';
            const lifespanSeconds = parseFloat(lifespanStr);

            slot.timerId = setTimeout(() => {
                if (this._moodSlot === slot) {
                    this._disposeMoodSlot();
                }
            }, lifespanSeconds * 1000 + 100);
        },

        /** Единая точка утилизации mood-слота. Убивает таймеры, анимирует выход. */
        _disposeMoodSlot() {
            if (!this._moodSlot) return;
            const slot = this._moodSlot;

            // 1. Kill lifecycle-таймер
            clearTimeout(slot.timerId);

            // 2. Kill все extra-таймеры, скоупленные к этому слоту
            for (const id of slot.extraTimers) {
                clearInterval(id);
                clearTimeout(id);
            }

            // 3. Анимировать выход оверлея
            if (slot.overlay?.parentNode) {
                slot.overlay.classList.remove('vp-fx-mood-active');
                slot.overlay.classList.add('vp-fx-mood-forceout');
                const ref = slot.overlay;
                setTimeout(() => ref.remove(), 800);
            }

            // 4. Fade out extra-элементы (.vp-fx-mood-extra)
            const screen = _st().ui?.screen;
            if (screen) {
                const extras = screen.querySelectorAll('.vp-fx-mood-extra');
                extras.forEach(el => {
                    el.style.transition = 'opacity 0.5s ease';
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), 500);
                });
            }

            // 5. Очистить слот
            this._moodSlot = null;
        },

        clearMood() {
            this._disposeMoodSlot();
        },

        clearTransients() {
            const screen = _st().ui?.screen;
            if (!screen) return;
            const particles = screen.querySelectorAll('.vp-fx-float-up, .vp-fx-pop');
            particles.forEach(el => el.remove());

            screen.classList.remove('vp-fx-shake', 'vp-fx-punch', 'vp-fx-heartbeat', 'vp-fx-glitch', 'vp-fx-flash');
            
            this.lastFired = {};
        },

        clearUI() {
            const screen = _st().ui?.screen;
            if (!screen) return;
            const uiNodes = screen.querySelectorAll('.vp-fx-ui');
            uiNodes.forEach(el => el.remove());
        },

        clearMoodExtras() {
            if (!this._moodSlot) return;

            // Очистить extra-таймеры текущего слота
            for (const id of this._moodSlot.extraTimers) {
                clearInterval(id);
                clearTimeout(id);
            }
            this._moodSlot.extraTimers = [];

            // Удалить extra-элементы
            const screen = _st().ui?.screen;
            if (!screen) return;
            
            const extras = screen.querySelectorAll('.vp-fx-mood-extra');
            extras.forEach(el => {
                el.style.transition = 'opacity 0.5s ease';
                el.style.opacity = '0';
                setTimeout(() => el.remove(), 500);
            });
        },

        /** @deprecated Используйте clearMood(). Оставлено для совместимости. */
        removeMoodElement(el) {
            this._disposeMoodSlot();
        },

        // ──────────────── БАЗОВЫЕ УТИЛИТЫ ────────────────
        utils: {
            getScreen() {
                return _st().ui?.screen || null;
            },

            ensureUIRoot(id, opts = {}) {
                const screen = _st().ui?.screen;
                if (!screen || !id) return null;
                let el = screen.querySelector(`#${id}`);
                if (!el) {
                    el = document.createElement(opts.tagName || 'div');
                    el.id = id;
                    el.classList.add('vp-fx-ui');
                    if (opts.className) {
                        String(opts.className).split(/\s+/).filter(Boolean).forEach(cls => el.classList.add(cls));
                    }
                    screen.appendChild(el);
                }
                return el;
            },

            removeUIRoot(id, fadeMs = 0) {
                const screen = _st().ui?.screen;
                if (!screen || !id) return;
                const el = screen.querySelector(`#${id}`);
                if (!el) return;
                if (fadeMs > 0) {
                    el.style.transition = `opacity ${fadeMs}ms ease`;
                    el.style.opacity = '0';
                    setTimeout(() => el.remove(), fadeMs);
                } else {
                    el.remove();
                }
            },

            spawnParticles(emojis, count, animationClass, options = {}) {
                const screen = _st().ui?.screen;
                if (!screen) return;
                const { glow = false } = options;

                for (let i = 0; i < count; i++) {
                    const el = document.createElement('div');
                    el.textContent = emojis[Math.floor(Math.random() * emojis.length)];
                    el.style.cssText = `position:absolute; left:${Math.random()*90+5}%; top:${Math.random()*80+10}%; pointer-events:none; z-index:11; animation-delay:${Math.random()*0.5}s;`;
                    el.className = animationClass;

                    if (glow) {
                        const hue = Math.floor(Math.random() * 360);
                        const particleColor = `hsl(${hue}, 90%, 55%)`;
                        el.style.fontSize = Math.random() * 30 + 12 + 'px';
                        el.style.color = particleColor;
                        el.style.filter = `drop-shadow(0 0 ${Math.round(parseFloat(el.style.fontSize)*0.4)}px ${particleColor}) brightness(1.5)`;
                        el.style.mixBlendMode = 'plus-lighter';
                    } else {
                        el.style.fontSize = Math.random() * 20 + 16 + 'px';
                    }
                    screen.appendChild(el);
                    setTimeout(() => el.remove(), 2500);
                }
            }
        }
    };

    // ──────────────── БАЗОВЫЕ TRANSIENT-ЭФФЕКТЫ ────────────────
    // ПРИМЕЧАНИЕ про поле `emoji`: эти эмодзи НЕ выводятся боту в манифест
    // (это провоцировало бы мелкие модели на спам эмодзи). Они работают только
    // как фоновый маппинг: если бот САМ органично поставит такую эмоцию в тексте —
    // соответствующий эффект сработает. Список служит и подсказкой-комментарием
    // о том, какие эмоции этот эффект ловит.
    FX.registry = {
        hearts: {
            type: 'transient',
            description: 'romance, affection',
            emoji: ['💕', '💖', '🥰', '❤️'],
            css: `
                @keyframes vpFxFloatUp {
                    0%   { opacity: 0; transform: translateY(0) scale(0.5) rotate(0deg); }
                    20%  { opacity: 1; transform: translateY(-10px) scale(1.2) rotate(-10deg); }
                    80%  { opacity: 1; transform: translateY(-40px) scale(1) rotate(10deg); }
                    100% { opacity: 0; transform: translateY(-60px) scale(0.8) rotate(0deg); }
                }
                .vp-fx-float-up { animation: vpFxFloatUp 2s ease-out forwards; }
            `,
            fire(intensity, ctx) {
                const count = 6 + Math.round(intensity * 1.2);
                ctx.utils.spawnParticles(['💕', '💖', '💗'], count, 'vp-fx-float-up');
            },
        },

        sparkles: {
            type: 'transient',
            description: '',
            emoji: ['✨', '⭐', '🌟'],
            css: `
                @keyframes vpFxPop {
                    0%   { opacity: 0; transform: scale(0.1) rotate(0deg); }
                    40%  { opacity: 1; transform: scale(1.4) rotate(45deg); }
                    100% { opacity: 0; transform: scale(0.5) rotate(90deg); }
                }
                .vp-fx-pop { animation: vpFxPop 1.5s ease-out forwards; }
            `,
            fire(intensity, ctx) {
                const count = 8 + Math.round(intensity * 1.5);
                ctx.utils.spawnParticles(['✶', '✴', '✷', '★', '⊹'], count, 'vp-fx-pop', { glow: true });
            },
        },

        shake: {
            type: 'transient',
            description: '',
            emoji: ['💥', '⚡', '😱', '💢'],
            css: `
                @keyframes vpFxShake {
                    0%, 100% { transform: translate(0, 0) rotate(0); }
                    20% { transform: translate(calc(var(--vp-shake-strength, 4px) * -1), 2px) rotate(-1deg); }
                    40% { transform: translate(var(--vp-shake-strength, 4px), -2px) rotate(1deg); }
                    60% { transform: translate(calc(var(--vp-shake-strength, 4px) * -1), -2px) rotate(-1deg); }
                    80% { transform: translate(var(--vp-shake-strength, 4px), 2px) rotate(1deg); }
                }
                .vp-fx-shake { animation: vpFxShake 0.4s ease-in-out; }
            `,
            fire(intensity) {
                const screen = _st().ui?.screen;
                if (!screen) return;
                screen.style.setProperty('--vp-shake-strength', `${intensity}px`);
                screen.classList.remove('vp-fx-shake');
                void screen.offsetWidth;
                screen.classList.add('vp-fx-shake');
                setTimeout(() => screen.classList.remove('vp-fx-shake'), 500);
            },
        },

        punch: {
            type: 'transient',
            description: 'sudden realization',
            emoji: [],
            css: `
                @keyframes vpFxPunch {
                    0%   { transform: scale(1); }
                    15%  { transform: scale(var(--vp-punch-scale, 1.15)); }
                    100% { transform: scale(1); }
                }
                .vp-fx-punch { animation: vpFxPunch 0.4s cubic-bezier(0.34, 1.56, 0.64, 1); }
            `,
            fire(intensity) {
                const screen = _st().ui?.screen;
                if (!screen) return;
                const scale = 1 + (intensity / 10) * 0.20;
                screen.style.setProperty('--vp-punch-scale', scale);
                screen.classList.remove('vp-fx-punch');
                void screen.offsetWidth;
                screen.classList.add('vp-fx-punch');
                setTimeout(() => screen.classList.remove('vp-fx-punch'), 400);
            },
        },

        heartbeat: {
            type: 'transient',
            description: 'anxiety, anticipation',
            emoji: [],
            css: `
                @keyframes vpFxHeartbeat {
                    0%   { transform: scale(1); }
                    15%  { transform: scale(var(--vp-beat-scale, 1.08)); }
                    35%  { transform: scale(1); }
                    55%  { transform: scale(calc(1 + (var(--vp-beat-scale, 1.08) - 1) * 0.4)); }
                    100% { transform: scale(1); }
                }
                .vp-fx-heartbeat { animation: vpFxHeartbeat 1s cubic-bezier(0.34, 1.56, 0.64, 1); }
            `,
            fire(intensity) {
                const screen = _st().ui?.screen;
                if (!screen) return;
                const scale = 1 + (intensity / 10) * 0.08;
                screen.style.setProperty('--vp-beat-scale', scale);
                screen.classList.remove('vp-fx-heartbeat');
                void screen.offsetWidth;
                screen.classList.add('vp-fx-heartbeat');
                setTimeout(() => screen.classList.remove('vp-fx-heartbeat'), 1000);
            },
        },

        glitch: {
            type: 'transient',
            description: '',
            emoji: ['🤖', '👾'],
            css: `
                @keyframes vpFxGlitch {
                    0% { transform: translate(0) skew(0); filter: drop-shadow(0 0 0 transparent); }
                    10% { transform: translate(-5px, 2px) skew(-5deg); filter: drop-shadow(-4px 0 0 red) drop-shadow(4px 0 0 cyan); opacity: 0.8; }
                    20% { transform: translate(5px, -2px) skew(5deg); opacity: 1; }
                    30% { transform: translate(-2px, 0) skew(0); filter: drop-shadow(0 0 0 transparent); }
                    40% { transform: translate(3px, 1px) skew(-2deg); filter: drop-shadow(-2px 0 0 red) drop-shadow(2px 0 0 cyan); }
                    50% { transform: translate(0) skew(0); }
                    100% { transform: translate(0) skew(0); filter: drop-shadow(0 0 0 transparent); }
                }
                .vp-fx-glitch { animation: vpFxGlitch 0.4s ease-in-out forwards; }
            `,
            fire(intensity) {
                const screen = _st().ui?.screen;
                if (!screen) return;

                screen.classList.remove('vp-fx-glitch');
                void screen.offsetWidth;
                screen.classList.add('vp-fx-glitch');
                
                const slice = document.createElement('div');
                slice.style.cssText = `position:absolute; top:${Math.random()*80}%; left:0; right:0; height:${Math.random()*15 + 5}%; background:rgba(255,255,255,0.1); transform:translateX(-10px); z-index:12; mix-blend-mode:difference;`;
                screen.appendChild(slice);
                
                setTimeout(() => {
                    screen.classList.remove('vp-fx-glitch');
                    slice.remove();
                }, 400);
            }
        },

        thunder: {
            type: 'transient',
            description: '',
            emoji: ['⚡', '🌩️'],
            css: `
                @keyframes vpFxFlash {
                    0%   { filter: brightness(0.2) contrast(1.2) grayscale(0.5); }
                    10%  { filter: brightness(5) contrast(2) grayscale(1); }
                    20%  { filter: brightness(0.2) contrast(1.2) grayscale(0.5); }
                    30%  { filter: brightness(3) contrast(1.5); }
                    50%  { filter: brightness(0.4) contrast(1.1); }
                    100% { filter: brightness(1) contrast(1); }
                }
                .vp-fx-flash { animation: vpFxFlash 0.8s ease-out forwards; }
            `,
            fire(intensity, ctx) {
                const screen = _st().ui?.screen;
                if (!screen) return;

                screen.classList.remove('vp-fx-flash');
                void screen.offsetWidth;
                screen.classList.add('vp-fx-flash');
                setTimeout(() => screen.classList.remove('vp-fx-flash'), 800);
                
                setTimeout(() => {
                    window.FX.fire('shake', intensity * 1.5);
                }, 80);
            }
        }
    };

    // Инжектим базовый каркас + CSS всех встроенных эффектов
    (function initBaseStyles() {
        let css = `
            .vp-fx-mood { position: absolute; inset: 0; pointer-events: none; z-index: 10; opacity: 0; }
            .vp-fx-ui { position: absolute; pointer-events: none; z-index: 100; }
            @keyframes vpFxMoodLifecycle { 0% {opacity:0;} 3% {opacity:1;} 70% {opacity:1;} 100% {opacity:0;} }
            @keyframes vpFxMoodForceOut { from {opacity:1;} to {opacity:0;} }
            .vp-fx-mood-forceout { animation: vpFxMoodForceOut 0.8s ease forwards !important; }
            
            @keyframes vpFxPulseSlow { 0%, 100% {filter:brightness(1) saturate(1);} 50% {filter:brightness(1.15) saturate(1.2);} }
            @keyframes vpFxPulseSharp { 0%, 100% {filter:brightness(0.95) saturate(1);} 30% {filter:brightness(1.25) saturate(1.4);} 45% {filter:brightness(0.9) saturate(0.9);} 70% {filter:brightness(1.1) saturate(1.2);} }
            
            .vp-fx-mood-active.vp-fx-pulse-slow { animation: vpFxMoodLifecycle var(--mood-lifespan, 60s) ease forwards, vpFxPulseSlow 4s ease-in-out infinite; }
            .vp-fx-mood-active.vp-fx-pulse-sharp { animation: vpFxMoodLifecycle var(--mood-lifespan, 60s) ease forwards, vpFxPulseSharp 2.2s ease-in-out infinite; }
        `;

        // Собираем CSS из встроенных эффектов
        for (const [name, effect] of Object.entries(FX.registry)) {
            if (effect.css) {
                css += `\n/* ── Built-in FX: ${name} ── */\n${effect.css}\n`;
            }
        }

        const style = document.createElement('style');
        style.textContent = css;
        document.head.appendChild(style);
    })();

    // Помечаем все встроенные эффекты источником 'builtin'
    for (const name of Object.keys(FX.registry)) {
        FX._effectSource[name] = 'builtin';
    }
    // Загружаем сохранённые пользовательские настройки (скрытые/удалённые)
    FX._loadPrefs();

    window.FX = FX;
})();
