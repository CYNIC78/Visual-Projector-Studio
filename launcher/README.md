# VP Studio Launcher

Native Windows launcher with no console window and no required .NET runtime.

## Features

- Dark startup window with a temporary robot mascot.
- Manual launch or optional quick auto-launch.
- Three WebView2 cache modes:
  1. automatic: use `R:\VP-RAM\WebView2` when the `R:\VP-RAM` marker exists, otherwise use `data\cache`;
  2. always use local `data\cache`;
  3. use a custom folder selected by the user.
- Browse, open, and clear cache controls.
- Settings are stored in a readable `launcher.ini` beside the launcher.
- Runtime lookup order:
  - the `Runtime` value in `launcher.ini`;
  - `runtime\VPStudioRuntime.exe`;
  - `VP Studio Runtime.exe`;
  - `neutralino-win_x64.exe`.

The launcher sets `WEBVIEW2_USER_DATA_FOLDER` before starting Neutralino.

## Build

1. Install **Visual Studio 2022 Build Tools** with **Desktop development with C++**.
2. Open **x64 Native Tools Command Prompt for VS 2022**.
3. Run `build-launcher.bat`.
4. The result is created as `release\VP Studio.exe`.

The result is a small native executable. Users do not need .NET, Python, or a console.

## Recommended release layout

```text
VP Studio/
├── VP Studio.exe
├── launcher.ini
├── runtime/
│   └── VPStudioRuntime.exe
├── resources.neu
└── data/
```

The robot is drawn directly by the launcher and is only a placeholder. It can later be replaced with final artwork and an application icon without changing the launch logic.
