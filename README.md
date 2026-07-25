# Visual Projector Studio / VP Studio

**VP Studio** — локальная мультимедийная студия для двухстороннего мультимодального взаимодействия пользователя с локальными большими языковыми и визуальными моделями.

Проект не является обычным веб-приложением и не является обычной игрой. Это рабочая среда, где:
- пользователь общается с LLM;
- LLM видит текстовый/визуальный контекст;
- LLM может управлять проектором через команды;
- LLM может пользоваться tools для поиска, памяти, галереи и подготовки генерации ассетов;
- пользователь и модель вместе создают визуальный словарь сцены/персонажа;
- сгенерированные ассеты попадают в умную галерею и затем используются в ролеплее.

**Коротко:** VP Studio — AI multimedia runtime studio для иммерсивного чата, визуального сторителлинга и генерации ассетов.

## Запуск

### Через лаунчер (рекомендуется)

1. Запустите `VP Studio.exe`
2. Выберите папку для кеша WebView2 (по умолчанию `R:\VP_Cache` для RAM-диска, или любую другую папку)
3. Нажмите **Launch VP Studio**

Лаунчер позволяет:
- Выбрать расположение кеша WebView2 (RAM-диск, SSD, HDD)
- Очистить кеш
- Открыть папку кеша
- Включить быстрый запуск (Quick launch next time)

### Прямой запуск (для разработки)


```
neutralino-win_x64.exe
```


## Модель хранения данных

**Ничего не пишется на диск автоматически.** Все изменения живут в памяти до явного сохранения.

- Кнопка **💾 Save** в топбаре сохраняет все изменения
- Индикатор показывает статус: "Сохранено" / "Не сохранено"
- Горячая клавиша: `Ctrl+S`

Это даёт:
- Полный контроль над persistence
- Безопасное тестирование без риска испортить данные
- Возможность отменить изменения простым закрытием без сохранения

## Структура проекта

```
VP Studio/
├── bin/              # Бинарники sd.cpp
├── css/              # Стили
├── data/             # Данные миров (после сохранения)
│   └── worlds/
│       └── default/
│           ├── world.json
│           ├── gallery.json
│           ├── asset-studio.json
│           ├── shell.json
│           ├── chats.json
│           ├── profiles.json
│           └── assets/
│               ├── assets.json
│               └── files/
├── docs/             # Документация
├── Games/            # Интеграции с играми
├── js/               # Исходный код
│   ├── nodes/        # Ноды Asset Studio
│   │   └── core_nodes/
│   └── workers/      # Web Workers
├── launcher/         # Исходники лаунчера
├── output/           # Временные файлы генерации
├── release/          # Релизные сборки
├── index.html
├── launcher.ini      # Конфиг лаунчера
├── LICENSE           # GPLv3
├── neutralino-win_x64.exe
── neutralino.config.json
├── README.md
└── VP Studio.exe     # Лаунчер
```

## Основная идея

VP Studio строится вокруг нескольких каналов взаимодействия:

### 1. Public scene commands

Модель может писать команды прямо в ответ:

| Команда | Что делает |
| --- | --- |
| `[IMG:tag]` | Показать ассет в проекторе |
| `[IMG:tag:transition]` | Показать ассет с переходом |
| `[FX:name]` | Запустить визуальный эффект |
| `[TAB:open:name]` | Открыть tab галереи |
| `[TAB:collapse:name]` | Свернуть tab галереи |
| `[CAT:open:name]` | Открыть category |
| `[CAT:collapse:name]` | Свернуть category |
| `[ACTIVITY_REQUEST]`, `[ACTIVITY_START]` | Команды activity/game layer |

Эти команды публичны, видимы, replay-able и являются частью сцены.

### 2. Tools

Tools — приватный structured-call слой модели. Они нужны для:
- поиска ассетов;
- чтения состояния сцены;
- бросков кубиков;
- доступа к профилям;
- подготовки Prompt Node в Asset Studio.

Ключевой studio tool: `configure_prompt_studio` — позволяет модели подготовить Prompt Node для batch generation.

### 3. Smart Gallery

Галерея — источник истины для визуальных ассетов. Ассет вызывается по тегу: `emily_smile`, `emily_angry`, `room_night`.

Галерейный тег используется:
- проектором;
- моделью;
- Prompt Node reference links;
- visual context collage.

### 4. Asset Studio

Asset Studio — графовая студия генерации ассетов через `sd.cpp` CLI.

Текущий стабильный backend: **sd.cpp CLI**  
`sd-server` считается экспериментальным и не блокирует развитие проекта.

## Asset Pack Factory

Одно из ключевых текущих направлений — Asset Pack Factory.

Пример сценария:
1. Пользователь загружает reference персонажа в галерею, например `emily`.
2. Пользователь обсуждает с LLM, какие ассеты нужны для ролеплея.
3. Модель планирует pack: эмоции, позы, состояния.
4. Пользователь утверждает план.
5. Модель вызывает `configure_prompt_studio`.
6. Tool создаёт Prompt Node tabs и reference links.
7. Пользователь открывает Asset Studio и жмёт `Produce All`.
8. Сгенерированные drafts попадают в нужный tab галереи.
9. Пользователь применяет drafts через `Apply All`.
10. Модель использует новые ассеты через `[IMG:tag]`.

**Правило v1:**
- 1 Prompt Node tab = 1 generated asset
- 1 configure_prompt_studio call = 1 thematic pack = 1 Gallery destination tab

Пример:
```
12 Prompt Node tabs
→ 12 generated emotion assets
→ Gallery / Characters / Emily Emotions
```

## Draft system

Generated ассеты из Asset Studio сначала попадают в галерею как drafts:
- `_draft: true`
- До Apply они живут в RAM runtime и не считаются persistent world assets.

После `Apply` / `Apply All` ассеты сохраняются в:
- `data/worlds/<world>/assets/files/`
- `data/worlds/<world>/assets/assets.json`

Это позволяет спокойно генерировать пачки, выбирать удачные результаты и выкидывать мусор.

## Документация

Основные документы:
- `docs/PROJECT_MAP.md`
- `docs/CURRENT_STATE.md`
- `docs/ASSET_PACK_FACTORY_AUDIT.md`
- `docs/ASSET_PACK_FACTORY_IMPLEMENTATION.md`
- `docs/PROMPT_NODE_POLISH.md`

## Принципы разработки

- Не ломать рабочую магию ради архитектурной красоты.
- Маленькие точечные патчи вместо большого rewrite.
- Явная persistence — ничего не сохраняется без команды пользователя.
- Галерея — source of truth для ассетов.
- Prompt Node хранит ссылки на gallery tags, не base64.
- Модель и пользователь должны иметь симметричные возможности там, где это полезно.
- CLI backend считается стабильным; server backend — экспериментальным.
- Новые фичи рождаются из реального использования и тестирования.

## Лицензия

**GPLv3** — Бери, изменяй, зарабатывай, но расшаривай свой продукт, как я свой! Иначе, иди лесом!

См. `LICENSE`.
```