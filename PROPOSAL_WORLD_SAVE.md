# Предложение: Как в Blender — жить в RAM, сохранять редко и бережно

Дата: 2026-07-13  
Контекст: сейчас каждый чих дергает диск — `setShellState`, `setConfig`, `setGalleryData`, `setCurrentTag`, `putAsset`, `setChatStore` и т.д. вызывают `writeJson`/`IDB put` **немедленно**. Это анти-паттерн для Desktop приложения в Neutralino.

Вы как Blender-пользователь правы: всё должно жить в оперативке, диск — только по Save.

---

## Что сейчас (аудит)

В коде 60+ точек прямой записи:

- `projector-shell.js`: `saveShellState()` на каждый split, смену панели, rename workspace, toggle collapsed — 15 мест.
- `projector-gallery.js`: `putAsset`, `deleteAsset`, `setGalleryData`, `setCoverTag` — на каждый rename/move/delete/tag.
- `visual-projector.js`: `setCurrentTag`, `setProjectorState` — на переключение кадра, `setWinGeom` на drag окна.
- `projector-session.js` / `projector-chats.js`: `setChatStore`, `setSessionState` — на каждую новую реплику, даже на streaming delta (сейчас уже вынесено, но всё равно часто).
- `vp-storage-native.js`: `clonePlain = JSON.parse(JSON.stringify)` + `FS.writeFile(JSON.stringify(...,2))` — синхронная сериализация десятков КБ **в главном потоке**, потом IPC по WebSocket в нативный процесс Neutralino.

Режимы `persistent / semi-persistent / ephemeral` уже есть в `vp-storage.js` и `vp-storage-native.js` (`shouldPersist(scope)`), но используются как on/off, а не как стратегия Save.

Итого: нет единого места, где решается **когда** писать. Каждый модуль сам себе хозяин.

---

## Вариант 1: BLENDER-LIKE — Явный Save (Ctrl+S), всё живет в RAM

**Идея, максимально близка к Blender.**

### Концепция:
- `S` (State) + `S.shell`, `S.gallery`, `S.galleryData`, `S.session.messages` и т.д. — это **единый документ в RAM**, как `.blend` в памяти.
- Никаких `DB.setX` в горячем пути. Вместо них `World.markDirty(scope)`.
- Диск трогается только в 3 случаях:
  1. Явный **Save (Ctrl+S)** или кнопка 💾 в топбаре.
  2. **Auto Save Timer** (как в Blender: по умолчанию 2 мин) — пишет в `data/backups/autosave/<world>.blend.json` или во временную папку, не в основной файл.
  3. **Смена мира / выход** — если `isDirty`, показываем диалог "Save changes? Save / Don't Save / Cancel", как в Blender.

### UI:
- В заголовке окна `Visual Projector — Default*` — звездочка если dirty (как в Blender `*`).
- Topbar: кнопка 💾 Save World, горячая клавиша Ctrl+S, индикатор "Saved / Unsaved changes".
- World Manager: у каждого мира `lastSavedAt`, `isDirty`.

### Технические детали:
```js
// Новый модуль js/vp-world-save.js
window.VP_WORLD = {
  isDirty: false,
  dirtyScopes: new Set(),
  lastSavedAt: null,

  markDirty(scope = 'shell') {
    this.isDirty = true;
    this.dirtyScopes.add(scope);
    document.title = document.title.includes('*') ? document.title : document.title + '*';
    // не пишем на диск!
  },

  async save({ reason='user' } = {}) {
    const snapshot = buildWorldSnapshot(); // один раз собрать всё
    // атомарная запись: пишем во временные файлы, потом rename
    await DB.saveWorldSnapshot(snapshot); // одна транзакция
    this.isDirty = false;
    this.dirtyScopes.clear();
    document.title = document.title.replace('*','');
    this.lastSavedAt = Date.now();
    VP.showToast?.(`💾 World saved (${reason})`, 'success');
  }
};

// Везде заменяем:
// БЫЛО: saveShellState() → DB.setShellState(S.shell)
// СТАЛО: S.shell.layouts[active]=newLayout; VP_WORLD.markDirty('shell');
```

### Плюсы:
- **100% как в Blender** — понятно вам, понятно пользователям.
- 0 изнасилования диска во время работы.
- Явный контроль пользователя, легко делать Backup/Version (.blend1).
- Просто реализовать атомарный сейв — один `save()` пишет все JSON за раз через `writeJsonRaw` в цикле.
- Легко добавить `Save Incremental` (Ctrl+Alt+S) как в Blender.

### Минусы:
- Риск потери данных при краше, если юзер забыл Save. Лечится Auto Save Timer в отдельную папку.
- Нужно переписать 60+ мест с `DB.setX` на `markDirty`.
- Нужно переучивать пользователей, привыкших к автосейву.

**Трудоемкость:** 2-3 дня, но фундамент.

---

## Вариант 2: DEBOUNCED WRITE-BEHIND (ленивый автосейв, но бережный)

**Сохраняем иллюзию автосейва, но делаем его умным.**

### Концепция:
- Вводим единый `PersistenceManager` с очередью и debounce.
- Каждый `markDirty(scope, data)` не пишет сразу, а кладет в очередь и планирует flush через `requestIdleCallback` или `setTimeout 1500ms`.
- Coalescing: если за 1.5 сек пришло 100 вызовов `setShellState`, запишется только **последний** снапшот.
- Батчинг: за один flush пишутся все грязные scope'ы одним проходом.

```js
class PersistenceManager {
  constructor() {
    this.dirty = new Map(); // scope -> latestData
    this.timer = null;
  }
  mark(scope, data) {
    this.dirty.set(scope, data);
    this.schedule();
  }
  schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 1200); // 1.2 сек тишины
  }
  async flush() {
    if (this.dirty.size===0) return;
    const batch = new Map(this.dirty);
    this.dirty.clear();
    // Одна запись за тик, а не 60
    for (const [scope, data] of batch) {
      await DB._rawWrite(scope, data); // внутри clonePlain + writeJson
    }
    console.log('[PM] flushed', [...batch.keys()]);
  }
}
// Ассеты — исключение: блобы пишем сразу, т.к. бинарные и тяжелые, но метаданные — через PM
```

### Настройки:
- В Global Settings → Storage → "Auto-save debounce": 0.5s / 1s / 2s / 5s / OFF
- Плюс "Save on world switch / exit" всегда.

### Плюсы:
- Минимальный UX-шейк — всё как раньше (автосейв), но в 50-100 раз реже дергает диск.
- Легко внедрить: заменить `saveShellState()` на `PM.mark('shell', S.shell)` в 1 месте.
- Защита от потери данных сохраняется.
- Хорошо работает с Neutralino FS, т.к. IPC вызывается редко.

### Минусы:
- Всё равно пишет без спроса пользователя — не совсем Blender-way.
- Нет явного Save/Cancel диалога.
- Если debounce 2 сек, а юзер сразу закрывает окно — нужен flush on `beforeunload` + `visibilitychange`.

**Трудоемкость:** 0.5-1 день, можно сделать поверх текущего.

---

## Вариант 3: ГИБРИД — RAM-First + Tiered Save (Рекомендуемый для Студии)

**Лучшее из двух миров: Blender + умный автосейв. Это мой фаворит для вашего проекта.**

### 3 уровня хранения:

```
Tier 0 — RAM (S) — мгновенно, всегда источник истины
   ↓ markDirty
Tier 1 — Ephemeral Quick Save (memory + localStorage/sessionStorage)
   — каждые 3-5 сек или на requestIdleCallback — быстро, без FS, переживает перезагрузку страницы
   ↓ debounced 30-60 sec ИЛИ явный Save
Tier 2 — Persistent World Save (Neutralino FS: data/worlds/<id>/)
   — явный Ctrl+S, таймер автосейва, смена мира, закрытие приложения
```

### Детали:

**1. World Document:**
```js
S.world = {
  id, title,
  isDirty: false,
  dirtyScopes: Set,
  lastSavedAt, lastQuickSavedAt,
  saveVersion: 0 // для .blend1 ротации
}
```

**2. Сохранение:**
- `Ctrl+S` → `World.save()` → пишет все JSON атомарно (сначала в `*.tmp`, потом `rename`).
- AutoSave Timer (настраивается в Settings, по умолчанию 60с, как в Blender можно поставить 2 мин) → пишет в `data/backups/autosave/<worldId>_<timestamp>.vpworld` или в `autosave.json` внутри мира, не трогая основной файл.
- QuickSave (Tier1) → каждые 5 сек в `localStorage` или `sessionStorage` легковесный снапшот (без блобов) — если краш, при старте предложить "Recover autosave?" как в Blender.

**3. Ассеты:**
- Блобы (картинки) — исключение: при импорте сразу пишем файл на диск (пользователь ожидает, что файл создан), но метаданные (`assets.json`, `gallery.json`) — через Tier2.
- Удаление ассета — помечаем dirty, файл удаляем только на Save (как в Blender: удаленный объект в RAM, файл еще на диске до Save).

**4. UI как в Blender:**
- Topbar: `💾 Save (Ctrl+S)` + индикатор `● Unsaved` / `✓ Saved`.
- При попытке закрыть / сменить мир — модалка: `Save changes to Default? [Save] [Don't Save] [Cancel]`.
- File → `Save`, `Save Incremental` (как `Save As + version +1`), `Save Backup (.blend1)`, `Recover Last Session`, `Recover Auto Save`.
- Settings → Auto Save: ON/OFF, Interval: 30s/1m/2m/5m, Keep: 3 versions.

**5. Атомарность и бэкапы:**
```js
async function atomicWrite(path, data) {
  const tmp = path + '.tmp';
  await FS.writeFile(tmp, JSON.stringify(data,null,2));
  await FS.remove(path + '.blend1').catch(()=>{});
  await FS.rename(path, path+'.blend1').catch(()=>{});
  await FS.rename(tmp, path);
}
```
Как в Blender: `.blend1` — предыдущая версия.

### Плюсы:
- **Блендеровский UX**, который вам родной — звездочка, Ctrl+S, бэкапы.
- Бережность к диску: Tier2 пишет редко, Tier1 — только в память/LS, Tier0 — только RAM.
- Защита от краша: QuickSave + AutoSave.
- Готов к будущему: можно легко добавить Git-like history миров, diff, revert.
- Сохраняет возможность включить "Auto-save mode" для тех, кто привык (переключатель в Settings).

### Минусы:
- Самый сложный в реализации (новый модуль World + PersistenceManager + UI).
- Нужно мигрировать все 60+ точек сохранения.
- Нужно продумать UX диалога Save/Don't Save.

**Трудоемкость:** 3-5 дней на фундамент, потом полировка.
**Но это красивое решение, которое сделает проектор взрослым desktop-приложением, а не веб-страницей.**

---

## Мой рекомендация для вас (как блендер-пользователя)

**Шаг 1 (сейчас, 0.5 дня):** оставить Вариант 2 поверх того, что уже сделали — внедрить `PersistenceManager` с debounce 1.5с. Это убьет 99% лишних записей прямо сейчас, без ломки UX.

**Шаг 2 (следующий спринт, 3 дня):** переходим к Варианту 3 Гибрид:
- Создаем `js/vp-world-manager.js` и `js/vp-persistence-manager.js`.
- Все `DB.setX` → `markDirty`.
- Добавляем Topbar Save, Ctrl+S, индикатор `*`, диалог при выходе.
- AutoSave Timer → `data/backups/autosave/`.
- Настройки: AutoSave ON/OFF, Interval.

Тогда ваш проектор будет вести себя как Blender:
- Работаешь — всё в оперативке, летает.
- Нажал Ctrl+S — мир сохранен, звездочка пропала, тихо шуршит диск один раз.
- Крашнулся — при старте "Recover Auto Save?".

Хотите, я начну с Варианта 2 (быстрый PersistenceManager), а потом намечаю Вариант 3 полноценный с UI Save?

