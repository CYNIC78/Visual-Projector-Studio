# ТЗ: Рефактор-спринт «Диета для толстяков»

Дата: 2026-07-08
Статус: готово к исполнению
Предыстория: `PROJECT_MAP.md` (архитектура), `TOOLS_ROADMAP.md` этап R.

---

## 0. Принципы (не менять)

1. **Новый код — в новые файлы.** В существующие — только точки подключения.
2. **Механический перенос.** Никаких новых фич параллельно с рефактором.
3. **Фасады не меняются.** `window.VisualProjector.*` — контракты сохраняются.
4. **Бекап до и после каждого переезда.** Числовой префикс (31-, 32-...).
5. **Проверка на живом билде** после каждого шага: загрузка, основные панели, реплей.

---

## 1. Шаг 1: SubtitlePlayer → `vp-subtitles.js`

### 1.1 Что делаем

Выселить блок SubtitlePlayer из `visual-projector.js` в отдельный файл
`js/vp-subtitles.js`.

### 1.2 Что переносим из `visual-projector.js`

```
SubtitlePlayer (объект, ~300 строк):
  - play(text, role)
  - pushDelta(delta, role)
  - flushStream()
  - playNext()
  - showOverlay(text)
  - chunkText(text)
  - stop()
  - внутренние таймеры и очередь
  - обработка VP-команд ([IMG:], [FX:]) внутри потока
```

### 1.3 Что остаётся в `visual-projector.js`

```
Пайплайн вызова (точки подключения):
  - handleProjectorAssistantDelta(requestId, delta)
  - finalizeProjectorAssistant(requestId, content, { fromStream })
  - isActiveProjectorRequest(requestId)
  - abortAssistant()

Связка с SubtitlePlayer через существующие вызовы:
  SubtitlePlayer.pushDelta(...)  → остаётся, но в новом файле
  SubtitlePlayer.flushStream()   → остаётся, но в новом файле
  SubtitlePlayer.stop()          → остаётся, но в новом файле
```

### 1.4 Зависимости

`vp-subtitles.js` использует:
- `VP.state` (только чтение конфигурации: WPM, режим субтитров)
- `VP.commands.executeText()` — для обработки VP-команд внутри потока
- `VP.tags.strip` — для очистки текста перед показом

Никаких новых зависимостей не вводится.

### 1.5 Подключение

`index.html`: добавить `<script src="js/vp-subtitles.js">` **после**
`visual-projector.js`, **до** `projector-session.js`.

### 1.6 Фасад

```js
window.VisualProjector.subtitles = SubtitlePlayer;
```

Старые вызовы `SubtitlePlayer.pushDelta(...)` из
`visual-projector.js` заменяются на `VP.subtitles.pushDelta(...)`.
Сам объект `SubtitlePlayer` остаётся глобальным для обратной совместимости
(можно оставить `window.SubtitlePlayer` как alias).

### 1.7 Критерий готовности

- [ ] Файл `js/vp-subtitles.js` создан, ~300-350 строк
- [ ] `visual-projector.js` уменьшился на ~300 строк
- [ ] Субтитры работают в стриминге (обычный чат)
- [ ] Субтитры работают после tool loop (если уже чинены)
- [ ] VP-команды ([IMG:], [FX:]) обрабатываются внутри субтитров
- [ ] Реплей сообщений показывает субтитры
- [ ] Бекап `31-subtitles-extract-2026-07-08.tar.gz` создан

---

## 2. Шаг 2: Tagger → `vp-tagger.js`

### 2.1 Что делаем

Выселить блок Tagger (VLM-автотеггинг + UI оверлей) из
`projector-gallery.js` в отдельный файл `js/vp-tagger.js`.

### 2.2 Что переносим из `projector-gallery.js`

```
Tagger + Tagger UI (~500-600 строк):
  - VLM-запрос на теггинг (prompt + parse)
  - Оверлей прогресса автотеггинга
  - Применение тегов к ассетам
  - Настройки теггера (вкл/выкл, модель)
  - Импорт/экспорт тегов
```

### 2.3 Что остаётся в `projector-gallery.js`

```
Фасад и точки подключения:
  - VP.gallery.tagger (ссылка на внешний модуль)
  - Вызовы tagger.tag(blob), tagger.applyToAsset(asset, tags)
  - Настройки теггера в Gallery Settings (рендерер остаётся тут)
```

### 2.4 Зависимости

`vp-tagger.js` использует:
- `VP.state.gallery` (чтение/запись тегов ассетов)
- `VP.state.modelConfig` (endpoint для VLM)
- `VP.showToast`, `VP.showConfirm` (UI-уведомления)
- `VP.tags` (парсинг/валидация тегов, если используется)

Никаких новых зависимостей.

### 2.5 Подключение

`index.html`: добавить `<script src="js/vp-tagger.js">` **после**
`projector-gallery.js`, **до** `vp-tools.js`.

### 2.6 Фасад

```js
window.VisualProjector.gallery.tagger = Tagger;
```

Старые вызовы `VP.gallery.tagger.tag(...)` работают через фасад
автоматически.

### 2.7 Критерий готовности

- [ ] Файл `js/vp-tagger.js` создан, ~500-600 строк
- [ ] `projector-gallery.js` уменьшился на ~500-600 строк
- [ ] Автотеггинг работает (VLM-запрос → теги → применение)
- [ ] Оверлей прогресса отображается
- [ ] Настройки теггера в Gallery Settings работают
- [ ] Бекап `32-tagger-extract-2026-07-08.tar.gz` создан

---

## 3. Итоговая таблица размеров (прогноз)

| Файл | Сейчас | После шага 1 | После шага 2 |
|------|--------|-------------|-------------|
| `visual-projector.js` | 3289 / 164 KB | ~2990 / ~150 KB | ~2990 / ~150 KB |
| `projector-gallery.js` | ~4183 / 210 KB | ~4183 / 210 KB | ~3600 / ~180 KB |
| `projector-session.js` | 3055 / 147 KB | 3055 / 147 KB | 3055 / 147 KB |
| `vp-subtitles.js` | — | ~320 / ~16 KB | ~320 / ~16 KB |
| `vp-tagger.js` | — | — | ~550 / ~28 KB |

**Самый толстый файл после рефактора:** ~180 KB (gallery).
**Цель достигнута:** ни один файл < 190 KB.

---

## 4. Порядок выполнения

```
Шаг 1: SubtitlePlayer → vp-subtitles.js
  → бекап 31-
  → проверка на живом билде
  → фиксация

Шаг 2: Tagger → vp-tagger.js
  → бекап 32-
  → проверка на живом билде
  → фиксация

Итого: +2 файла, ~870 строк выселено, бекапы 31-32.
```

---

## 5. Анти-скоуп (сознательно НЕ делаем сейчас)

- Вынос confirm/prompt диалогов из ядра → `vp-dialogs.js` (отложить)
- Вынос export/import JSON из gallery (отложить)
- Рефактор самого SubtitlePlayer (только вынос, не переписываем)
- Рефактор самого Tagger (только вынос, не переписываем)
- Оптимизация, рефакторинг, новые фичи — всё ПОСЛЕ стабилизации

---

## 6. Риски и митигация

| Риск | Митигация |
|------|-----------|
| Потеря внутренних связей при переносе | Механический перенос IIFE-блока, поиск всех вызовов через grep |
| Нарушение load order | Проверка в index.html, console.log при загрузке каждого модуля |
| Сабтитры перестанут работать после выноса | Тест на живом билде: обычный чат → субтитры; tool loop → субтитры |
| Теггер потеряет доступ к gallery state | Фасад `VP.gallery.tagger`, проверка что state.gallery загружен |
