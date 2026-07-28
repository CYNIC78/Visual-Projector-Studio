# PROJECT_MAP — Карта проекта VP Studio

> Исследовательский проект, трастед-режим, один разработчик + AI-ассистент.  
> Код написан AI по идеям разработчика. Документ фиксирует архитектуру после последнего крупного рефакторинга (модульность / модельные регистры).

---

## 1. Общая схема

```
index.html
  │
  ├── js/neutralino.js          (Native bridge, WebSocket, FS/OS/API)
  ├── js/vendor/jszip.min.js    (Архивация, единственный vendor)
  ├── js/fx-core.js             (Визуальные эффекты: transient / mood / ui)
  ├── js/vp-hub.js              (Центральный хаб событий)
  ├── js/visual-projector.js    (ЯДРО: Projector, Playback, CommandBus, Template)
  ├── js/projector-gallery.js  (Галерея — source of truth для ассетов)
  ├── js/projector-chats.js     (Чат / сессии)
  ├── js/projector-session.js   (Сессионный менеджер)
  ├── js/projector-games.js     (Игровой / ролевой слой)
  ├── js/projector-tagger.js    (Тегирование)
  ├── js/projector-shell.js     (Оболочка UI)
  ├── js/projector-asset-studio.js (Asset Studio — графовая генерация)
  ├── js/projector-depth-renderer.js (2.5D глубина для Focus Mode)
  ├── js/nodes/                 (Ноды Asset Studio: loader, lora, prompt, sampler, output, core, graph)
  ├── js/vp-storage.js          (Абстракция хранения: IDB / Native FS)
  ├── js/vp-storage-native.js  (Native FS через Neutralino)
  ├── js/vp-tools.js            (Инструменты студии)
  ├── js/vp-core-tools.js       (Ядерные инструменты)
  ├── js/vp-subtitles.js        (Субтитры / потоковый вывод)
  ├── js/vp-write-monitor.js    (Монитор записи в файловую систему)
  └── css/visual-projector.css  (Стили проектор / UI)
```

---

## 2. Домены и их владельцы в коде

| Домен | Файл(ы) | Ключевые сущности | Зависимости (глобальные) |
|---|---|---|---|
| **Native** | `neutralino.js` | `Neutralino`, `NL_TOKEN`, `NL_PORT`, `WebSocket` | — |
| **FX** | `fx-core.js` | `FX.registry`, `FX.fire()`, `FX.emojiMap`, `_moodSlot`, `trackTimer()` | `window.VisualProjector?.state` |
| **Projector (ядро)** | `visual-projector.js` | `State`, `VPTags`, `VPCommandBus`, `Playback`, `PanelRegistry`, `PromptProviderRegistry` | `window.FX`, `window.VP_HUB`, `window.VP_DB`, `window.VisualProjector?.gallery` |
| **Gallery** | `projector-gallery.js` | `TabsManager`, `galleryData`, `State.gallery` (Map), драфты (`_draft`) | `window.VisualProjector` (фасад) |
| **Chats** | `projector-chats.js` | История чата, синхронизация с проектором | `window.VisualProjector` |
| **Session** | `projector-session.js` | Управление сессиями, интеграция с LLM | `window.VisualProjector` |
| **Games** | `projector-games.js` | `VP_GAMES`, `processActivityCommands()` | `window.VisualProjector` |
| **Asset Studio** | `projector-asset-studio.js`, `js/nodes/` | `Graph`, Prompt Nodes, Lora, Sampler, Output, Loader, `sd-cli.exe` | `window.VisualProjector` |
| **Depth** | `projector-depth-renderer.js` | `VPDepthRenderer`, `updateProjectorDepthLayer()` | `window.VPDepthRenderer` |
| **Storage** | `vp-storage.js`, `vp-storage-native.js` | `VP_DB`, `getConfig()`, `setConfig()`, `getWinGeom()`, `setWinGeom()` | `window.Neutralino` |
| **Hub** | `vp-hub.js` | `VP_HUB`, `registerModule()`, `handle()`, `emit()` | — |

---

## 3. Последний крупный рефакторинг — модульность (Model Registry)

**Что было сделано:**
- Введён `PanelRegistry` (`registerPanel`, `unregisterPanel`) для панелей UI.
- Введён `PromptProviderRegistry` (`registerPromptProvider`) для провайдеров контекста подсказок.
- `VPCommandBus` стал единой точкой регистрации команд (`IMG`, `FX`, `FOCUS`, `CAT`, `TAB`, `ACTIVITY_*`).
- `buildPromptProviderContext()` — сборка контекста из зарегистрированных провайдеров.
- Галерея (`projector-gallery.js`) остаётся «владельцем» данных ассетов (`State.gallery` — `Map`), проектор читает из неё, не дублируя.

**Что оставлено без переноса на работу через хаб (по решению):**
- Прямые вызовы между `visual-projector.js` и `projector-gallery.js` через `window.VisualProjector.gallery` (без обязательного прохождения через `VP_HUB`).
- `Playback.sync()` и `Playback.commit()` управляются напрямую из `visual-projector.js`, не через `hub.handle('playback:*')` в обязательном порядке (хотя `hub` регистрирует эти команды как алиасы для внешнего доступа).
- `setCurrent()` и `clearCurrent()` вызываются напрямую из UI событий (`setupUIEvents`), не через командную шину в некоторых случаях.

**Почему:** сохранена низкая связанность для быстрого эксперимента; хаб используется как «внешний интерфейс», но внутренние потоки остаются прямыми для скорости разработки в одиночку.

---

## 4. Ключевые контракты данных

### 4.1 Projector Snapshot (`buildProjectorSnapshot`)

```json
{
  "currentTag": "...",
  "coverTag": "...",
  "preparedTag": "...",
  "history": [{ "tag", "filename", "timestamp", "source" }],
  "playbackMessages": [{ "id", "role", "text", "timestamp", "frameTagAtStart" }]
}
```

### 4.2 Gallery Data (`State.galleryData`)

```json
{
  "categories": [{ "id", "name", "desc", "state": "open|collapsed|locked" }],
  "tabs": [{ "id", "categoryId", "name", "desc", "state" }],
  "activeTabId": "...",
  "tagAliases": { "old_tag": { "to": "new_tag", "expiresAt", "reason" } }
}
```

### 4.3 Command (`VPCommandBus.normalize`)

```json
{
  "__vpCommand": true,
  "raw": "[IMG:tag:transition]",
  "originalType": "IMG",
  "type": "IMG",
  "body": "tag:transition",
  "payload": { "tag": "tag", "transition": "transition" }
}
```

### 4.4 FX Registry Entry

```javascript
{
  type: 'transient' | 'mood' | 'ui',
  description: '',
  emoji: ['💖'],
  css: '/* ключевые кадры */',
  throttleMs: 2000,
  apply?: function(intensity, ctx, name),  // для mood
  fire?: function(intensity, ctx, name),  // для transient/ui
  preset?: { color, blend, pulse }
}
```

---

## 5. Потоки данных (без хаба, прямые связи — оставлено как есть)

```
UI Event (кнопка Play / Next / Timeline click)
  ↓
Playback.play() / Playback.goTo()
  ↓
setCurrent(tag, source='replay', true)
  ↓
State.current = asset (из State.gallery — Map)
  ↓
updateProjectorUI() → рендер кадра + applyProjectorViewportUI()
  ↓
persistProjectorState() → window.VP_DB.setProjectorState()
  ↓
emitProjectorCurrentChanged() → window.VP_HUB?.emit()
```

```
Модель отвечает с [IMG:tag] или [FX:name]
  ↓
VPCommandBus.executeText() или VPTags.commands()
  ↓
VPCommandBus.execute(cmd) → handler (для IMG → setCurrent; для FX → FX.fire)
  ↓
Обновление UI (toast, проектор, эффект)
```

---

## 6. Файлы, не вошедшие в рефакторинг хаба (прямые связи)

| Связь | Откуда | Куда | Примечание |
|---|---|---|---|
| `gallery.refreshGalleryPanelUI()` | `visual-projector.js` → `window.VisualProjector?.gallery?.refreshGalleryPanelUI()` | Галерея обновляет сетку при смене кадра | Прямая, не через `VP_HUB.emit('gallery:refresh')` |
| `gallery.persistAsset()` | `visual-projector.js` (внутри `setProjectorViewport`) | Галерея сохраняет изменения viewport в RAM | Прямая, для скорости |
| `gallery.addImageFromBlob()` | `setupDragAndDrop()` (drop images) | Галерея добавляет изображение из файла | Прямая, UI-уровень |
| `session.queueManifest()` | `ensureFocusControls()` (snapshot focus) | Сессия добавляет манифест в очередь | Прямая, для немедленной реакции на действие пользователя |

---

## 7. Бинарные зависимости (вне кода, в репо)

| Файл | Назначение | Управление |
|---|---|---|
| `neutralino-win_x64.exe` | Runtime Neutralino v6.8.0 | Жёстко привязан; обновление требует ручной замены бинарника |
| `VP Studio.exe` | Скомпилированный лаунчер | Собирается через `launcher/build-launcher.bat` (VS2022) |
| `bin/sd.cpp/sd-cli.exe` + `.dll` | CLI backend генерации (стабильный) | Бинарники в репо; исходники отсутствуют |
| `bin/depth-anything/da3-cli.exe` | CLI для оценки глубины | Бинарники в репо; исходники отсутствуют |

---

## 8. Ключевые настройки (`neutralino.config.json`)

- `port`: 45710 (фиксированный)
- `documentRoot`: `/`
- `enableNativeAPI`: true (полный доступ к FS/OS/Window)
- `enableInspector`: true (включён в `window` mode — удобно для разработки, но остаётся в продакшн)
- `nativeAllowList`: `app.*`, `window.*`, `filesystem.*`, `os.*`, `debug.log`
- `defaultMode`: `window` (`borderless: true`, `frameless: true`, `resizable: true`)

---

## 9. Примечания для дальнейшей работы

- **Не трогать:** прямые связи `visual-projector.js` ↔ `gallery` и `session` — они оставлены намеренно для скорости эксперимента. При необходимости полного перехода на хаб потребуется переписать `setCurrent()`, `Playback.sync()`, `updateProjectorUI()` и `buildManifest()` через `hub.handle()`.
- **Экспериментальная зона:** `ASSET_PACK_FACTORY` — фабрика паков ассетов. Код в `projector-asset-studio.js` содержит логику `Produce All` и `Apply All`, но полная интеграция с моделью (`configure_prompt_studio`) остаётся в стадии доработки (см. `docs/CURRENT_STATE.md`).
- **Драфты (`_draft`):** система драфтов в галерее работает стабильно; `Apply` → `persistAsset()` → сохранение в `data/worlds/*/assets/`. Без `Apply` данные остаются в RAM (`State.gallery` Map).
