# DESIGN PHILOSOPHY — Visual Projector Studio как игра + студия, а не сайт

Дата: 2026-07-13  
Статус: Активная философия проекта (принята)

## 1. Мы — не веб

Проект начинался как веб-приложение на Neutralino.js. Веб-культура учит: `localStorage.setItem()` на каждый чих — это нормально, потому что это не реальный диск, а память браузера.

В десктопе это превращается в:
`JSON.stringify(весь мир) → FS.writeFile() → WebSocket IPC → реальный SSD` на каждый пиксель гаттера. 30% CPU и износ диска.

**Решение:** воспринимаем проектор как **гибрид видеоигры и Blender-подобной студии создания контента**.

- Игра имеет **состояние** (save) и **чекпоинты** (autosave).
- Blender имеет **RAM-first** и явный `Ctrl+S`, `*` dirty, `Recover Auto Save`.

Диск — дорогой ресурс. Трогаем его редко, осознанно, атомарно.

## 2. Две главные задачи (2026 Q3)

### Задача 1: Перенести проектор из веб-говна в нормальную форму приложения

**Принцип: Дешево, надежно, без насилия над диском.**

**Уровни хранения:**

```
Tier 0 — RAM (S) — источник истины, мгновенно
  ↓ markDirty()
Tier 1 — QuickSave (sessionStorage / memory) — каждые 3-5 сек, без FS, переживает F5
  ↓ debounce 30-60 сек или Ctrl+S
Tier 2 — Persistent World Save (data/worlds/<id>/) — Ctrl+S, смена мира, выход
```

- **Все живет в RAM** до Save. `saveShellState()`, `setChatStore()`, `setGalleryData()` больше не пишут на диск, а делают `World.markDirty(scope)`.
- **Save World (Ctrl+S, 💾 в топбаре)** — одна атомарная транзакция: собираем снапшот всех JSON и пишем через `*.tmp → rename`, ротация `.blend1`.
- **Dirty индикатор** — `*` в заголовке `Visual Projector — Default*`, как в Blender.
- **При выходе / смене мира** — диалог `Save changes to Default? [Save] [Don't Save] [Cancel]`.
- **AutoSave Timer** — НЕ в основной файл, а в `data/backups/autosave/<world>_<timestamp>.vpworld` каждые 60-120 сек (настраивается). Отдельный `Recover Auto Save` при старте.
- **QuickSave** — каждые 5 сек в `sessionStorage` легковесный снапшот без блобов. Если краш — `Recover Quick Save?`.

**Настройки в Global Settings:**
- Save Mode: `Blender-like (explicit) / Auto-save (debounced 1.5s) / Ephemeral (RAM only)`
- Auto Save: ON/OFF, Interval: 30s/1m/2m/5m, Keep: 3 versions

Текущий воркараунд "запускаю на RAM-диске" становится официальной фичей — режим `Ephemeral`.

### Задача 2: Server режим — основной, CLI — фоллбек

**Почему CLI плох для философии Save:**

- CLI `sd-cli.exe`: на каждую генерацию грузит модель (10-20 сек), пишет файл в `./output/` на диск, даже если картинка — мусор. Для референсов приходится писать temp файлы `_ref_*.png`, потому что CLI не ест base64.
- Даже с `_draft` флагом, файл в `output/` уже дернул диск.

**Server (`sd-server.exe`) — правильный для Save-философии:**

- Поднимается **один раз**, модель в VRAM живет.
- Генерация: `POST /generate { prompt, reference_images: [base64] }` → в ответ сразу Blob в RAM, **никаких файлов**.
- Картинки живут в `S.ephemeral.generated = Map<id, Blob>` — только RAM, до `Keep` / `Save World`.
- UI: после генерации превью + `✅ Keep in Gallery / 🗑️ Discard` — как `Render Result` в Blender.
- Референсы — прямо base64 из галереи, без temp файлов.

**Управление моделями (важно из-за параллели чат/генерация):**

Диффузные модели жрут всю VRAM, LLM тоже. Нельзя держать оба.

- Server Manager (`js/sd-server-manager.js`): `spawn`, `loadModel(path)`, `unload()`, `status()`, `generate()`
- Кнопки в топбаре Asset Studio: `🧠 Model: sdxl.gguf (4.2GB) [Unload]` / `[Load]`
- **Нет таймеров автовыгрузки** — явная команда `Unload Model` / `Stop Server`, как ты и сказал. Пользователь сам решает.
- Будущая связка: `sd.cpp` (diffusion) + `llama.cpp` (LLM) — оба управляемые через один менеджер ресурсов. Когда генерим — выгружаем LLM, когда чатим — выгружаем diffusion. `llama.cpp` будет намного управляемее чем LM Studio.

**CLI остается как fallback** для 4GB VRAM машин, где держать сервер дорого. В нем тоже делаем эфемерно: после загрузки Blob удаляем файл из `output/`.

## 3. Что уже сделано (2026-07-13)

- **Сплиттеры:** было 30%+ CPU, стало 5-7% — rAF + `contain: layout style paint` + запись только на mouseup (Вариант А). Зафиксировано.
- **Логи генерации:** теперь захватываются детальнее, но была проблема с RU Windows кодировкой (CP866 → mojibake). Починена частично, но откатили к рабочей версии из `1baa74d`.
- **Документация:** зафиксирована философия (этот файл).

## 4. Что дальше (Roadmap)

### Phase: Save System (Blender-like)
- `js/vp-world.js` — `isDirty`, `dirtyScopes`, `lastSavedAt`
- `js/vp-persistence-manager.js` — `markDirty`, `schedule`, `flush`, `saveWorldSnapshot`
- Замена всех `DB.setX` → `markDirty`
- UI: Ctrl+S, 💾, `*`, диалог при выходе, `Recover`
- AutoSave Timer → `data/backups/autosave/`

### Phase: SD Server Primary
- `js/sd-server-manager.js` — lifecycle sd-server.exe
- Ephemeral Cache `S.ephemeral.generated`
- Keep/Discard UI
- Reference as base64 (no temp files)
- CLI fallback с удалением файлов после загрузки

### Phase: LLM Management (llama.cpp)
- `js/llama-manager.js` — аналогично SD Server
- Resource Manager — переключение `chat mode` vs `gen mode`, выгрузка неактивной модели
- Интеграция с `projector-session.js` — вместо LM Studio endpoint → `llama.cpp` локальный

## 5. Принципы (не нарушать, обновлено)

1. **RAM-first.** Диск — только по Save или AutoSave в отдельную папку.
2. **Пользователь не должен думать о файлах.** Но он должен контролировать Save, как в Blender/игре.
3. **Эфемерность по умолчанию.** Сгенерил — в RAM. Понравилось — Keep / Save. Нет — Discard, диск чистый.
4. **Явное управление ресурсами.** Нет скрытых таймеров выгрузки. Кнопка `Unload Model` / `Stop Server`.
5. **Совместимость.** Старые ворлд-файлы не ломаются. CLI остается.
6. **Бережливость.** Никаких `setShellState` на mousemove. Никаких `_ref_*.png` на диске в Server режиме.

---

*Этот документ — основа для всех будущих рефакторов. Любой новый код, который пишет на диск на каждый чих — нарушает философию и должен идти через `markDirty`.*
