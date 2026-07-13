# План — Q3 2026: Из веб-говна в нормальное приложение (Blender-way)

> Философия: [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md) — RAM-first, явный Save, эфемерная генерация

## Текущее состояние (2026-07-13)

- ✅ Сплиттеры: 30% → 5% CPU — rAF + contain + запись только на mouseup (коммит b007179)
- ✅ Генерация: рабочая версия из 1baa74d (CLI), Server — заглушка
- 🚧 Save System: спроектировано, не реализовано — диск все еще дергается (60+ точек)
- 🚧 Server Mode: спроектировано, не реализовано — нужен SD Server Manager

## Приоритеты (по твоему запросу)

### 1. Save System — Blender-like (дешево, надежно, без насилия над диском)

**Порядок работ:**

1. **World Document** — `js/vp-world.js`
   - `isDirty`, `dirtyScopes: Set`, `lastSavedAt`, `saveVersion`
   - `markDirty(scope)`, `clearDirty()`

2. **Persistence Manager** — `js/vp-persistence-manager.js`
   - `mark(scope, data)` → кладет в Map, `schedule()` debounce 1.2s
   - `flush()` — пишет батч атомарно `*.tmp → rename` + `.blend1` ротация
   - `saveWorldSnapshot()` — собирает все JSON за один проход

3. **Замена всех прямых записей**
   - Найти 60+ мест `DB.setX` / `saveShellState()` → `VP_WORLD.markDirty()`
   - Оставить `putAsset` для блобов (файлы картинок), но метаданные (`assets.json`) — через `markDirty`

4. **UI Save**
   - Topbar: 💾 Save World (Ctrl+S), индикатор `*` в `document.title`
   - Диалог при выходе / смене мира: `Save changes to Default? [Save] [Don't Save] [Cancel]`
   - `Recover Auto Save?` при старте, если `autosave.json` новее

5. **AutoSave Timer**
   - `data/backups/autosave/<world>_<timestamp>.vpworld` каждые 60-120с, настраивается
   - НЕ пишет в основной файл

6. **Настройки**
   - `Save Mode: [Blender-like / Auto-save (debounced) / Ephemeral]`
   - `Auto Save: ON/OFF, Interval, Keep versions`

**Чеклист:**
- [ ] vp-world.js — isDirty + *
- [ ] vp-persistence-manager.js — debounce + atomic write
- [ ] Замена DB.setX → markDirty в 60 местах
- [ ] UI Save + Ctrl+S + диалог
- [ ] AutoSave Timer в backups/autosave/
- [ ] Recover при старте

### 2. Server Mode — Primary (эфемерная генерация)

**Порядок работ:**

1. **SD Server Manager** — `js/sd-server-manager.js`
   - `spawn('sd-server.exe --model X --port 8080')`, `isRunning`, `loadedModel`
   - `loadModel(path)`, `unload()`, `status()`, `generate({prompt, refsBase64}) -> Blob`

2. **Ephemeral Cache**
   - `S.ephemeral.generated = Map<id, Blob>` — только RAM
   - После генерации: превью + `✅ Keep / 🗑️ Discard`
   - Только Keep → `putAsset` на диск

3. **Reference без temp файлов**
   - В Server режиме отправляем base64 из галереи прямо в JSON, без `_ref_*.png`

4. **CLI Fallback**
   - Оставляем, но после загрузки Blob удаляем файл из `output/` сразу

5. **Управление ресурсами**
   - Кнопки `🧠 Model: xxx [Unload]`, явная команда, без таймеров (как ты хочешь)
   - Подготовка к `llama.cpp` + `sd.cpp` связке — Resource Manager переключает `chat mode` vs `gen mode`

**Чеклист:**
- [ ] sd-server-manager.js — lifecycle
- [ ] Ephemeral Cache + Keep/Discard UI
- [ ] Reference as base64 (no temp)
- [ ] CLI fallback с удалением output файла
- [ ] Unload Model кнопка

### 3. LLM Management — llama.cpp

**Порядок работ:**

1. `js/llama-manager.js` — аналогично SD Server
2. Resource Manager — `chat mode` (llm loaded, sd unloaded) vs `gen mode` (sd loaded, llm unloaded)
3. Интеграция с `projector-session.js` — вместо LM Studio endpoint

**Чеклист:**
- [ ] llama-manager.js
- [ ] Resource Manager
- [ ] Переключение режимов

## Завершено (история)

### Prompt Node v2 — табы, {name:}, референсы

- [x] Data structure `tabs[]`, `activeTabId`
- [x] Backward-compat deserialize
- [x] Strip {name:...} in process()
- [x] Tab UI (bar + editor + add/del)
- [x] Produce All iterates tabs
- [x] displayResult() uses {name:...}
- [x] Gallery drag-n-drop to reference zone
- [x] Draft system (_draft flag)

### Сплиттеры — оптимизация

- [x] rAF throttling (Вариант А)
- [x] Запись только на mouseup
- [x] body.vp-shell-resizing с contain
- [x] 30% → 5% CPU, зафиксировано

## Не делать (принципы)

- Никаких записей на диск на mousemove / input
- Никаких temp `_ref_*.png` в Server режиме
- Никаких скрытых таймеров выгрузки модели — только явная команда
- Никакого оверинжиниринга — если фичу можно не делать, не делаем
