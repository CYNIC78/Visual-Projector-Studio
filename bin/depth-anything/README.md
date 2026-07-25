# depth-anything.cpp integration slot

Статус: бинарники не установлены.

Репозиторий: https://github.com/mudler/depth-anything.cpp  
Releases: https://github.com/mudler/depth-anything.cpp/releases

На момент проверки в GitHub Releases нет готовых бинарных архивов. Поэтому сюда нельзя просто скачать `da3-cli.exe` как мы делаем с готовыми утилитами.

## Что сюда должно лечь после сборки

Рекомендуемая структура:

```text
bin/depth-anything/
  da3-cli.exe                 # CLI depth-anything.cpp, Windows build
  models/
    depth-anything-*.gguf     # выбранные GGUF модели
  README.md
```

Минимальный runtime для VP Studio в будущем:

```text
bin/depth-anything/da3-cli.exe
bin/depth-anything/models/<model>.gguf
```

## Как собирается upstream

По README upstream:

```sh
git clone --recursive https://github.com/mudler/depth-anything.cpp
cd depth-anything.cpp
cmake -B build -DDA_BUILD_CLI=ON
cmake --build build -j
# result: build/examples/cli/da3-cli
```

Windows-вариант обычно будет примерно такой из Developer PowerShell / terminal with MSVC:

```powershell
git clone --recursive https://github.com/mudler/depth-anything.cpp
cd depth-anything.cpp
cmake -B build -DDA_BUILD_CLI=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j
```

Ожидаемый exe после сборки может лежать примерно здесь:

```text
build/examples/cli/Release/da3-cli.exe
```

или, в зависимости от генератора CMake:

```text
build/examples/cli/da3-cli.exe
```

## Модели

Upstream использует GGUF модели. README указывает HuggingFace:

```text
https://huggingface.co/mudler/depth-anything.cpp-gguf
```

Для нашего будущего MVP лучше выбрать маленькую/быструю модель, чтобы генерировать sidecar depth maps без тяжелого пайплайна.

## Будущая интеграция VP Studio

Планируемая схема:

```text
Gallery asset
  -> depth sidecar generation via da3-cli.exe
  -> hidden file in data/worlds/<world>/assets/depth/
  -> asset metadata depthMap descriptor
  -> Projector depth/parallax renderer later
```

Важно: depth sidecar не должен становиться обычным Gallery asset.

```text
asset.jpg
assets/depth/asset.depth.png
```

При удалении asset нужно удалять его sidecar.

## Почему здесь нет exe

У upstream сейчас нет готового GitHub Release с Windows binary. Нужно либо:

1. собрать самому на Windows;
2. настроить наш собственный GitHub Actions build;
3. позже добавить проверенный бинарник вручную в `bin/depth-anything/`.
```
