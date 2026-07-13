# VP Studio — Visual Projector Studio

**Гибрид видеоигры и Blender-подобной студии создания контента для локальных AI-моделей.**  
Десктопное приложение на Neutralino.js — никаких Node.js, никаких Electron-жирняков. Просто `index.html`, пачка скриптов и стилей.

> **Философия (2026-07-13):** Мы — не сайт. Мы — игра + студия. Всё живет в RAM, диск трогаем только по Save (как в Blender). Диск — дорогой ресурс. Подробности — [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md)

## Что это вообще

Десктопное приложение, которое подключается к любой OpenAI-совместимой локальной модели (LM Studio, Ollama, llama.cpp) и даёт ей возможность показывать тебе картинки, переключать сцены, накладывать эффекты и играть в мини-игры.

Ты общаешься с моделью, а она через теги типа `[IMG:forest]`, `[FX:lightning]`, `[TAB:open:characters]` управляет тем, что ты видишь на экране. Как текстовый квест, только с картинками.

Плюс студия генерации ассетов: собираешь граф из нод `Loader → LoRA → Prompt → Sampler → Output`, жмёшь Produce — и `sd.cpp` / `sd-server` генерит картинку. Картинки живут в RAM до Keep/Save, как Render Result в Blender.

## Быстрый старт

1. Скачай релизную сборку под свою платформу (Windows/Linux/Mac).
2. Запусти `neutralino-win_x64.exe` (или `neutralino-linux_x64`, `neutralino-mac_x64`).
3. Открой вкладку «Model» и впиши эндпоинт своей модели (например `http://127.0.0.1:1234/v1/chat/completions` для LM Studio или `llama.cpp`).
4. В Asset Studio укажи путь к `sd-cli.exe` / `sd-server.exe` и к моделям.
5. Кидай картинки в галерею (кнопки 📂 и 📎 или перетащи в окно) — они тоже живут в RAM до Save.
6. Жми 🎬 Begin. Не забудь **Ctrl+S** — Save World, как в Blender (появится `*` если есть несохраненные изменения).

## Как оно устроено (с новой философией Save)

### Ядро

- **visual-projector.js** — ядро: состояние в RAM (S), парсер тегов, плеер, UI проектора. Ничего не пишет на диск напрямую, только `World.markDirty()`.
- **vp-world.js** *(в плане)* — документ мира: `isDirty`, `dirtyScopes`, `*` в заголовке, `Save World`.
- **vp-persistence-manager.js** *(в плане)* — единый менеджер: debounce 1.2с, атомарный `*.tmp → rename`, AutoSave в `data/backups/autosave/` (не в основной файл).
- **vp-storage.js / vp-storage-native.js** — было: писало на каждый чих. Стало: только по `saveWorldSnapshot()` или QuickSave в память.

### Студия генерации

- **projector-asset-studio.js** — Asset Studio. Графовый редактор, Produce All, черновики (`_draft`).
- **sd-server-manager.js** *(в плане)* — управление `sd-server.exe`: один раз грузит модель в VRAM, генерация по HTTP `POST /generate` → Blob в RAM, без файлов на диске до Keep. Кнопка `Unload Model` — явная, без таймеров.
- **llama-manager.js** *(в плане)* — аналогично для `llama.cpp`. Resource Manager переключает `chat mode` (LLM загружен, SD выгружен) vs `gen mode` (SD загружен, LLM выгружен), т.к. диффузные модели жрут всю память.

### Остальное

- **projector-gallery.js** — галерея: ассеты, теги, табы. Черновики живут в RAM до Apply.
- **projector-session.js** — чат с моделью, стриминг, лог. Теперь тоже RAM-first.
- **projector-chats.js** — множество чатов и профилей.
- **projector-shell.js** — Blender-lite рабочее пространство. **Оптимизировано:** rAF + `contain: layout style paint` + запись только на `mouseup` (было 30% CPU → стало 5%).
- **fx-core.js** — эффекты, **vp-subtitles.js** — субтитры, **vp-tools.js** — тулы.

Всё загружается в `index.html` в правильном порядке.

## Команды модели

| Команда | Что делает |
|---------|-----------|
| `[IMG:tag]` | Показывает картинку с тегом |
| `[FX:name:8]` | Эффект с интенсивностью 1-10 |
| `[TAB:open:name]` | Открыть таб в галерее |
| `[ACTIVITY_START]` | Мини-игры |

## Две главные задачи Q3 2026

### 1. Save System — Blender-like
- RAM-first, `*` dirty, Ctrl+S → атомарный Save, AutoSave в `backups/autosave/`, диалог при выходе `Save changes?`
- Режим `Ephemeral (RAM-only)` — твой воркараунд на RAM-диске теперь официальная фича

### 2. Server Mode — Primary
- `sd-server.exe` основной, CLI фоллбек
- Эфемерный кэш генераций: сгенерил → RAM → Keep/Discard → только Keep на диск
- Референсы как base64, без `_ref_*.png` temp файлов
- Управление: явная команда `Unload Model` / `Stop Server`, без таймеров

Подробно — [DESIGN_PHILOSOPHY.md](DESIGN_PHILOSOPHY.md), [ROADMAP.md](ROADMAP.md), [PLAN.md](PLAN.md)

## Лицензия

GPLv3. [LICENSE](LICENSE)
