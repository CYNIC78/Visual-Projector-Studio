# ROADMAP — Visual Projector Studio

> **Новая философия (2026-07-13):** 
> Проектор — это **гибрид игры и Blender-студии**, а не сайт.
> Всё живет в RAM, диск трогаем только по Save. 
> Подробности — в [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)

---

## ✅ Завершено — Сплиттеры: 30% CPU → 5% (2026-07-13)

**Задача:** убрать лаги при перетаскивании разделителей панелей.

**Файл:** `js/projector-shell.js` L2014-2042

**Было:**
```js
onMove = () => {
  setCurrentLayout(setSplitRatio(...)) // clone + JSON.stringify + FS.writeFile на каждый пиксель
  aWrap.style.flex = `calc(${pct}% - 3px)`
}
```

**Стало (Вариант А — Optimized Live Resize):**
- rAF throttling — 60fps max, dedup <0.001
- Никаких `saveShellState` во время drag — только на `mouseup`
- `body.vp-shell-resizing` с `contain: layout style paint; pointer-events:none; content-visibility:auto` для изоляции тяжелых панелей (логи, граф, галерея, экран)

**Результат:** CPU 30%+ → 5-7%, диск не насилуется. Зафиксировано в коммите `b007179`.

---

## 🚧 Текущие задачи — Q3 2026 (приоритет)

### Phase: Save System — Blender-like (RAM-first)

**Цель:** перестать насиловать диск, как в вебе. Жить в RAM, сохранять редко и осознанно.

**Проблема сейчас:** 60+ точек пишут на диск немедленно (`setShellState`, `setGalleryData`, `setChatStore`, `putAsset` и т.д.). Даже твой воркараунд "запускаю на RAM-диске" — костыль, но идея верная.

**Уровни:**
```
Tier0 RAM (S) — источник истины
  ↓ markDirty()
Tier1 QuickSave (sessionStorage/memory) — каждые 3-5с, без FS
  ↓ debounce 30-60с или Ctrl+S
Tier2 Persistent (data/worlds/<id>/) — Ctrl+S, смена мира, выход
```

**Что делать:**
- `js/vp-world.js` — `isDirty`, `dirtyScopes`, `lastSavedAt`, `*` в заголовке
- `js/vp-persistence-manager.js` — `markDirty()`, `flush()`, `saveWorldSnapshot()` с атомарным `*.tmp → rename` + `.blend1` ротация
- Замена всех `DB.setX` → `markDirty`
- UI: Ctrl+S / 💾 Save World, диалог `Save changes to Default? [Save] [Don't Save] [Cancel]`, `Recover Auto Save` при старте
- AutoSave Timer → `data/backups/autosave/<world>_<timestamp>.vpworld` (НЕ в основной файл)
- Настройки: `Save Mode: Blender-like / Auto-save (debounced) / Ephemeral`

**Статус:** спроектировано, ждет реализации.

### Phase: SD Server — Primary, CLI — Fallback

**Цель:** картинки тоже должны быть эфемерными до Keep/Save.

**Почему CLI плох для Save-философии:**
- Грузит модель на каждую генерацию (10-20с), пишет файл в `./output/` даже если мусор, для референсов пишет temp `_ref_*.png`

**Server (`sd-server.exe`):**
- Один раз грузит модель в VRAM, живет
- `POST /generate { prompt, reference_images: [base64] }` → Blob в RAM, никаких файлов
- `S.ephemeral.generated = Map<id, Blob>` — только RAM до `Keep`
- UI: после генерации `✅ Keep in Gallery / 🗑️ Discard` как `Render Result` в Blender
- Управление: `🧠 Model: sdxl.gguf (4.2GB) [Unload]` — явная команда, без таймеров автовыгрузки (как ты и сказал)

**CLI остается fallback** для 4GB VRAM.

**Статус:** спроектировано, stub в `engineMode: server`.

### Phase: LLM Management — llama.cpp + sd.cpp связка

**Цель:** чат и генерация в параллели проблематичны — диффузные модели жрут всю память, надо выгружать LLM.

- `llama.cpp` будет намного управляемее чем LM Studio
- Связка `sd.cpp + llama.cpp` — один Resource Manager, переключение `chat mode` vs `gen mode`
- `js/llama-manager.js` + `js/sd-server-manager.js` → единый менеджер ресурсов

**Статус:** идея, ждет когда `llama.cpp` настроим.

---

## ✅ Завершено — Prompt Node v2 (История)

### Фаза 1 — Фундамент Prompt Node

- Структура `tabs = [{id, name, text}]`, `activeTabId`
- Миграция старого `positive` → табы
- `{name:tag}` — имя ассета, `{...}` вырезаются
- Reference дропзона, drag-n-drop из галереи
- Produce Active / All, именование через `getUniqueImportedTag()`

### Фаза 2 — Интеграция с галереей

- Drag-n-drop из галереи → референсы
- `displayResult()` → `addImageFromBlob()` с `_draft`

### Фаза 3 — Продвинутые табы (когда нужно)

- `{tab:poses}` — декартово произведение
- `skipProduce` флаг — exclude from Produce All

---

## ✅ Сделано — Session 2 (2026-07-13)

### Progress Bar Steps Animation
- `setTimeout` вместо `requestAnimationFrame` для мульти-снапшотов `1/5 → 2/5`
- Плавная анимация прогресса

### Live Step Preview
- Авто-инжект `--preview proj --preview-path .../_step_preview_xxx.png --preview-interval 1`
- Polling через `getStats` каждые 300мс

### Fix: Output Preview при переключении воркфлоу
- `lastAssetTag` + `tagAliases` + `asset.url` приоритет

### Panel Cosmetics
- Тулбар одной строкой, сайдбары поверх холста с `transform`

---

## ✅ Сделано — Session 1 (2026-07-12)

### Draft System
- `_draft: true` до Apply, метки ✨, Apply/Discard All

### Base64 референсы для CLI
- Конвертация data URL → temp файлы + удаление

### Консоль
- ANSI strip, `\r` схлопывание, фазы `⏳ Model`, `🎨 Step`

---

## 🐛 Баги

| Баг | Статус |
|-----|--------|
| Прогресс-бар прыгал на 100% (мульти-снапшоты в одном чанке) | Исправлено setTimeout анимацией |
| sd.cpp server mode — base64 без временных файлов | TODO в Phase SD Server |
| RU Windows кодировка CP866 → кракозябры `���⠪��` в логах | Частично пофиксено `tryFixMojibake()`, но откатили к рабочей версии без envs — нужен безопасный фикс без `LANG=C` env |
| Диск дергается на каждый чих (веб-норма, но анти-норма для десктопа) | Частично пофиксено сплиттерами (30%→5%), остался Save System |

---

## Принципы (обновлено 2026-07-13, из DESIGN_PHILOSOPHY)

1. **RAM-first.** Диск — только по Save или AutoSave в отдельную папку.
2. **Эфемерность по умолчанию.** Сгенерил — в RAM. Понравилось — Keep / Save.
3. **Явное управление ресурсами.** Кнопка `Unload Model` / `Stop Server`, без таймеров.
4. **Пользователь не думает о файлах, но контролирует Save.** Как в Blender/игре.
5. **Бережливость.** Никаких `setShellState` на mousemove. Никаких `_ref_*.png` в Server режиме.
6. **Совместимость.** Старые ворлд-файлы не ломаются. CLI остается fallback.
