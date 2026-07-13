# Технический аудит: производительность сплиттеров в Visual Projector Studio

Дата: 2026-07-13
Ветка: arena/019f5bca-visual-projector-studio
Проблема: CPU 30% при перетаскивании разделителей (гаттеров)

---

## 1. Поиск кода — где живет логика сплиттеров

### Главный файл: `js/projector-shell.js` — это сердце проблемы
Это Blender-lite shell, который строит дерево layout и рендерит гаттеры.

**Ключевые структуры:**
- Строки ~46-52: функции `leaf(panel)` и `split(direction, ratio, a, b)` — строят дерево layout.
- Строки ~89-99: `defaultShellState()`, `loadShellState()`, `saveShellState()` — загрузка/сохранение всего состояния shell.
- Строки ~133-160: 
  - `saveShellState()` L133 — пишет `S.shell` в `DB.setShellState()` или localStorage.
  - `getCurrentLayout()` L145 — возвращает текущий layout по `activeWorkspace`
  - `setCurrentLayout(layout)` L155 — `S.shell.layouts[active]=layout; saveShellState()` — **вызывается на каждый пиксель движения мыши**.
- Строки ~1392-1399 (в `injectStyles`): CSS для гаттеров:
  ```css
  .vp-shell-gutter { flex: 0 0 6px; background: transparent; position: relative; z-index: 2; }
  .vp-shell-split.row > .vp-shell-gutter { cursor: col-resize; }
  .vp-shell-split.column > .vp-shell-gutter { cursor: row-resize; }
  ```
- Строки ~1988-2045: `renderNode(node, parentEl)` — рекурсивный рендер дерева. Это главный источник Reflow.
  - L1991-2010: если `node.type === 'split'` — создается `wrap` с `display:flex` (`row`/`column`), два `pane-wrap` и `gutter`.
  - L2002-2004: размеры задаются через `aWrap.style.flex = '0 0 calc(${ratioPct}% - 3px)'` — **flex-basis в процентах триггерит полный flex recalc**.
  - **L2014-2042 — критический обработчик перетаскивания:**
    ```js
    gutter.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      gutter.classList.add('dragging');
      gutter.setPointerCapture?.(e.pointerId);
      const rect = wrap.getBoundingClientRect(); // L2020 — замер геометрии один раз
      const onMove = (ev) => {
        const raw = node.direction === 'row' ? (ev.clientX - rect.left)/rect.width : ...
        const next = Math.max(0.10, Math.min(0.90, raw));
        const current = getCurrentLayout();
        setCurrentLayout(setSplitRatio(current, node.id, next)); // L2025-2027 — ТЯЖЕЛО
        const pct = next*100;
        aWrap.style.flex = `0 0 calc(${pct}% - 3px)`; // L2028 — триггер layout
        bWrap.style.flex = ...
      };
      const onUp = () => {
        gutter.classList.remove('dragging');
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        saveShellState(); // L2036 — второй сейв
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
    });
    ```
  - L2047-2130 — рендер `leaf` (панели): Stage, Asset Studio, Log (session), Model и т.д.

**Вспомогательные функции дерева:**
- L1809-1826 `findLeaf`, `splitLeafInTree`, `closeLeafInTree`
- L1831-1836 `setSplitRatio(node, splitId, ratio)` — рекурсивно клонирует узлы через `{...node, ratio}` и `{...node, a: ..., b: ...}`. На каждый `pointermove` обходит всё дерево (O(N) аллокаций).

### Второй файл: `js/projector-gallery.js` — второстепенный сплиттер
- L1813: `<div class="vp-resize-handle" id="vp-panel-resize-handle">` — ручка старого плавающего режима.
- L1867-1990 `wirePanelDragResize(panel)` — логика drag/resize для floating Gallery. Тоже использует `getBoundingClientRect()` + `mousemove` без rAF, но используется реже. Сейчас скрыт CSS `#vp-shell-root .vp-resize-handle { display:none !important }` L1540 в shell.js.

### Третий узел: `js/nodes/as-graph.js` + `as-core.js` — жертва, не виновник
- L149-192: `ResizeObserver` и `window.addEventListener('resize')` в Asset Studio Graph. При изменении размера shell панели `handleResize({preserveCenter:true})` (L2116 в shell.js при focus toggle) вызывается, пересчитывает viewport, перерисовывает связи `_render()`. Очень дорого при 100+ нодах.
- Аналогично `js/visual-projector.js` L2277 `ResizeObserver` для projector window.

### Четвертый: `js/vp-storage-native.js` — усилитель проблемы
- L81 `clonePlain(value)` = `JSON.parse(JSON.stringify(value))` — глубокий клон всего состояния.
- L173 `writeJson(path, data)` = `FS.writeFile(path, JSON.stringify(data,null,2))` — пишет на диск через Neutralino bridge (IPC по WebSocket).
- L1380-1381 `getShellState` / `setShellState` — вызывает `writeJson(paths.shell(), clonePlain(state))`. Каждый вызов сериализует весь `S.shell` (все workspaces, layouts, collapsed). При 3-4 workspaces это десятки КБ JSON на каждый пиксель движения мыши.

---

## 2. Анализ узких мест — почему 30% CPU

### Узкое место №1: Синхронная запись на диск на каждый `pointermove`

Цепочка в обработчике:
```
pointermove (до 240 Гц) 
  → getCurrentLayout() 
  → setSplitRatio() // O(N) объектов + GC pressure
  → setCurrentLayout() 
    → S.shell.layouts[active]=layout
    → saveShellState()
      → clonePlain(S.shell) → JSON.stringify всего shell (десятки КБ)
      → DB.setShellState → FS.writeFile через Neutralino IPC (самая тяжелая операция)
```
Даже если FS асинхронный, сериализация JSON происходит в главном потоке синхронно и блокирует UI. При 100 событиях в секунду — 100× JSON.stringify большого объекта. В Neutralinojs это особенно дорого, потому что FileSystem API идет через WebSocket в нативный процесс.

В коде `saveShellState()` вызывается **и внутри `onMove` (через `setCurrentLayout`) и еще раз в `onUp`**. Двойная работа.

### Узкое место №2: Неконтролируемый Reflow/Layout Thrashing

На каждый `pointermove`:
```js
aWrap.style.flex = `0 0 calc(${pct}% - 3px)`
bWrap.style.flex = `0 0 calc(${pct}% - 3px)`
```
`flex-basis` в % + `calc()` + вложенные `flex` контейнеры (`.vp-shell-split` внутри `.vp-shell-split`) заставляет браузер:

1. Пересчитать flex container (`wrap`) — измерить ширину/высоту.
2. Пересчитать всех детей рекурсивно — панели `stage`, `asset-studio`, `log`, `input`, `model`.
3. В каждой панели:
   - **Stage**: `visual-projector.js` screen с `img { object-fit }` + overlay для FX. ResizeObserver триггерит пересчет.
   - **Asset Studio**: `as-graph.js` — canvas + SVG связей нод. `handleResize` + `_render()` — перерисовка всех линков, пересчет позиций нод. При 50 нодах — тысячи DOM операций.
   - **Log / Session**: `projector-session.js` — L1294 `.vp-session-log-list { display:flex; flex-direction:column; gap:8px; overflow:auto }` — список из 80+ сообщений с markdown, аватарами, `float` аватарами, backdrop blur. Изменение ширины панели вызывает reflow каждого сообщения, перенос строк, пересчет `gap`.
   - **Gallery**: если есть — grid с `gridTemplateColumns: repeat(auto-fill, 100px)` — при изменении ширины пересчитывается количество колонок.

Итого: один `flex` вызывает каскадный layout всего приложения. Chrome DevTools покажет `Recalculate Style` + `Layout` >10ms на кадр при 120Hz = 30% CPU.

**Свойства-триггеры Reflow:**
- `flex-basis` / `flex` → Layout
- `width`/`height` в % → Layout
- `calc()` в flex-basis — дороже чем просто `%`
- `gap` в flex контейнерах → Layout
- `getBoundingClientRect()` в `pointerdown` — синхронный forced reflow, но делается один раз — ОК.
- `content-visibility` / `contain` не используется — упускается возможность изоляции.

### Узкое место №3: Отсутствие троттлинга — pointermove без rAF

`document.addEventListener('pointermove', onMove)` вызывается на каждое аппаратное событие мыши (до 1000Hz на геймерских мышах). Внутри нет `requestAnimationFrame`, нет `throttle`. Браузер пытается сделать layout чаще, чем может отрисовать (60fps).

Антипаттерн:
```js
// ПЛОХО — на каждый mousemove сразу в DOM
document.addEventListener('pointermove', () => { element.style.flex = ... })
```
Надо:
```js
// ХОРОШО — только в rAF
let raf = null;
onMove = (ev) => { lastEv = ev; if(!raf) raf = requestAnimationFrame(apply) }
```

### Узкое место №4: GC pressure из-за спред-операторов

`setSplitRatio`:
```js
if (node.type === 'split' && node.id === splitId) return { ...node, ratio };
if (node.type === 'split') return { ...node, a: setSplitRatio(...), b: setSplitRatio(...) };
```
При дереве из 5-7 сплитов каждый вызов создает 5-7 новых объектов. При 100 вызовов/сек — 500-700 объектов/сек, каждый с вложенными `a,b`. GC вынужден часто чистить, что дает микрофризы.

### Узкое место №5: Глобальные слушатели вместо контроллера

Каждый gutter создает свои `pointermove`/`pointerup` слушатели на `document`. Если 3 гаттера, при drag одного остальные неактивны, но система все равно держит замыкания на `wrap`, `aWrap`, `bWrap`, `node`. Замыкание удерживает ссылки на DOM, мешает сборщику.

---

## 3. Варианты решения

### Вариант A: Оптимизированный Live Resize (rAF + Freeze Styles) — быстрый win

**Суть:** оставить live-preview, но убрать все тяжелое из горячего пути.

**Что менять в `js/projector-shell.js`:**

1. В gutter handler добавить rAF:
```js
let rafId = null;
let lastEv = null;
let pendingRatio = null;

const onMove = (ev) => {
  lastEv = ev;
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = null;
    const raw = node.direction === 'row' ? (lastEv.clientX - rect.left)/rect.width : (lastEv.clientY - rect.top)/rect.height;
    const next = Math.max(0.10, Math.min(0.90, raw));
    if (Math.abs(next - pendingRatio) < 0.001) return;
    pendingRatio = next;
    const pct = next*100;
    aWrap.style.flexBasis = pct + '%';
    bWrap.style.flexBasis = (100-pct) + '%';
    node.ratio = next; // прямая мутация без клонирования дерева
  });
};
const onUp = () => {
  cancelAnimationFrame(rafId);
  document.removeEventListener('pointermove', onMove);
  document.removeEventListener('pointerup', onUp);
  gutter.classList.remove('dragging');
  document.body.classList.remove('vp-shell-resizing');
  saveShellStateDebounced(); // один раз, debounce 300ms
};
```

2. CSS класс заморозки на время drag (в `injectStyles`):
```css
body.vp-shell-resizing .vp-shell-panel-host {
  pointer-events: none;
  contain: layout style paint;
  content-visibility: auto;
}
body.vp-shell-resizing .vp-shell-canvas { cursor: col-resize; }
body.vp-shell-resizing .vp-as-canvas,
body.vp-shell-resizing .vp-session-log-list,
body.vp-shell-resizing .vp-gallery-grid { pointer-events:none; }
```

3. В `vp-storage-native.js` добавить debounce на `setShellState`.

4. Убрать `calc(... -3px)` → заменить на `gap:6px` в `.vp-shell-split` + `flex-basis:%`.

**Плюсы:**
- Сохраняет UX live-preview.
- Минимальные изменения (только shell.js + css) — 1-2 часа.
- Снижает CPU с 30% → ~5-8% (rAF 60fps + contain).
- Совместимо с текущей архитектурой.

**Минусы:**
- Все равно есть Reflow, пусть и реже. При 100 нодах Asset Studio может подлагивать.
- Не убирает полностью GC pressure, если оставить клонирование.

**Трудоемкость:** 0.5 дня.

---

### Вариант B: Фантомный сплиттер (Ghost / Overlay) — максимальная производительность

**Суть:** как в VS Code, Blender — во время drag показывается только линия, layout пересчитывается на `mouseup`.

**Реализация:**
```js
const overlay = document.createElement('div');
overlay.className = 'vp-shell-ghost-gutter';
overlay.style.cssText = `position:absolute; z-index:9999; background:var(--accent); opacity:0.8; pointer-events:none; will-change:transform;`;
if (direction==='row') { overlay.style.width='2px'; overlay.style.top='0'; overlay.style.bottom='0'; }
else { overlay.style.height='2px'; overlay.style.left='0'; overlay.style.right='0'; }
wrap.style.position='relative';
wrap.appendChild(overlay);

const onMove = (ev) => {
  if (raf) return;
  raf = requestAnimationFrame(()=>{
    raf=null;
    const raw = ...;
    const px = direction==='row' ? ev.clientX - rect.left : ev.clientY - rect.top;
    overlay.style.transform = direction==='row' ? `translate3d(${px}px,0,0)` : `translate3d(0,${px}px,0)`;
    pendingRatio = clamp(raw);
  });
};
const onUp = () => {
  overlay.remove();
  setCurrentLayout(setSplitRatio(current, node.id, pendingRatio));
  aWrap.style.flex = `0 0 calc(${pendingRatio*100}% - 3px)`;
  bWrap.style.flex = `0 0 calc(${100-pendingRatio*100}% - 3px)`;
  saveShellState();
}
```
`transform: translate3d` — GPU, только composite, без reflow. CPU ~0-1%.

**Плюсы:**
- Нулевая нагрузка во время drag — только compositor.
- Идеально для Neutralino на слабых ноутах.
- Полностью убирает Reflow, ResizeObserver.
- Проверенный паттерн IDE.

**Минусы:**
- Нет live-preview — пользователь не видит финальные размеры до отпускания.
- Требует UI подсказки (проценты).
- Хуже UX для точной настройки Stage/Log.

**Трудоемкость:** 0.5-1 день.

---

### Вариант C: Гибрид — Splitter Controller + Layout Isolation + Deferred Persist (оптимальный для Studio 2.0)

**Суть:** лучшее из A и B + архитектурный рефактор.

**Архитектура:**

1. **Новый класс `SplitterController`** (в `projector-shell.js` или отдельный `vp-splitter.js`):
   - Один глобальный `pointermove` listener вместо N на gutter.
   - Хранит `activeSplit: { id, direction, wrap, aWrap, bWrap, rect, startRatio }`
   - rAF loop + throttle 16ms.
   - Прямая мутация `node.ratio` без клонирования во время drag; клонирование только на `mouseup`.

2. **CSS Containment:**
   ```css
   .vp-shell-pane-wrap { contain: layout size style; }
   .vp-shell-resizing .vp-shell-panel-host {
     contain: strict;
     content-visibility: auto;
   }
   ```

3. **Пауза тяжелых подсистем:**
   ```js
   // pointerdown
   window.VP_AS?.Graph?.pauseRendering?.();
   VP.gallery?.pauseGrid?.();
   // pointerup
   window.VP_AS?.Graph?.resumeRendering?.();
   ```

4. **Batched Persist:**
   - `saveShellState` → debounce 500ms после последнего изменения + `visibilitychange`.

5. **Ghost как опция:** в Global Settings добавить toggle `Live splitter preview: ON/OFF`. OFF → Вариант B, ON → гибрид. Как в VS Code.

6. **Опционально Grid вместо Flex:**
   ```css
   .vp-shell-split.row { display:grid; grid-template-columns: var(--a) 6px var(--b); gap:0; }
   ```
   Grid быстрее пересчитывает.

**Плюсы:**
- Баланс UX vs perf: live-preview без лагов.
- Архитектурно чисто — один контроллер, легко добавить constraints, snap to 50%, dblclick reset.
- Масштабируется, готовит к grid layout.
- Для Neutralino: изоляция + пауза Graph убирает главную тяжелую панель.

**Минусы:**
- Больше кода, шире рефактор (shell.js + as-graph.js + gallery.js).
- Требует тестирования на всех воркспейсах.
- Нужен API `pauseRendering` в Asset Studio.

**Трудоемкость:** 1-2 дня.

---

### Итоговая рекомендация

- **Быстрый hotfix:** Вариант **A** — rAF + freeze + убрать save из onMove. 1 файл, 30 строк, CPU ↓ в 4-5 раз.
- **Для Studio 2.0:** Вариант **C** с toggle ghost в Settings.

**Предлагаемый план:**

Шаг 1 — сейчас A:
- Добавить rAF, убрать `setCurrentLayout`/`saveShellState` из `onMove`, мутировать `node.ratio` напрямую.
- Добавить `body.vp-shell-resizing` с `contain: layout style paint`.

Шаг 2 — следующий спринт C:
- Вынести `SplitterController`, добавить pause в Graph, настройку `Live splitter`.

---

### Приложение: файлы-жертвы Reflow (для профилирования)

- `js/projector-session.js` L1271-1450 — `.vp-session-log-list` flex column gap, markdown
- `js/projector-asset-studio.js` L2000+ — `.vp-as-node { resize:horizontal }` + canvas SVG
- `js/projector-gallery.js` — `renderGalleryGrid` grid auto-fill
- `css/visual-projector.css` L59-85 — `.vp-gallery-item`, `.vp-screen`
- `js/visual-projector.js` L2277 — ResizeObserver projector

**Как проверить:** Chrome DevTools → Performance → Record → потянуть splitter 2с → Stop. Увидите паттерн: `pointermove → setCurrentLayout → clonePlain → JSON.stringify → writeFile → Recalculate Style → Layout` 80-120 раз в секунду.

