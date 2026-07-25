@echo off
setlocal
cd /d "%~dp0"

where cl.exe >nul 2>nul
if errorlevel 1 (
  echo [VP Studio] cl.exe not found.
  echo Open "x64 Native Tools Command Prompt for VS 2022" and run this file again.
  echo Install Visual Studio Build Tools with "Desktop development with C++" if needed.
  pause
  exit /b 1
)

if not exist "..\release" mkdir "..\release"
rc.exe /nologo VPStudioLauncher.rc
if errorlevel 1 goto :fail
cl.exe /nologo /std:c++17 /O2 /DUNICODE /D_UNICODE VPStudioLauncher.cpp VPStudioLauncher.res /link /SUBSYSTEM:WINDOWS /MACHINE:X64 /OUT:"..\release\VP Studio.exe" user32.lib gdi32.lib shell32.lib
if errorlevel 1 goto :fail

echo.
echo Built: ..\release\VP Studio.exe
echo Put the Neutralino runtime beside it as neutralino-win_x64.exe,
echo or at runtime\VPStudioRuntime.exe
pause
exit /b 0

:fail
echo Build failed.
pause
exit /b 1

