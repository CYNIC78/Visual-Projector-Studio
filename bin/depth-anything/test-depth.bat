@echo off
setlocal EnableExtensions

rem Usage:
rem   test-depth.bat [input.jpg] [model.gguf] [output.png] [threads]
rem If input is omitted and Emily.jpg exists near this .bat, uses Emily.jpg -> Emily_depth.png.

cd /d "%~dp0"

set "ROOT=%~dp0"
set "EXE=%ROOT%da3-cli.exe"
set "INPUT=%~1"
set "MODEL=%~2"
set "OUTPUT=%~3"
set "THREADS=%~4"

if "%THREADS%"=="" set "THREADS=6"

if not exist "%EXE%" (
  echo [ERROR] da3-cli.exe not found: %EXE%
  echo Build it first with build-windows.bat or build-windows-vs2022-clean.bat
  echo ErrorCode: 1
  pause
  exit /b 1
)

if "%INPUT%"=="" (
  if exist "Emily.jpg" (
    set "INPUT=Emily.jpg"
    if "%OUTPUT%"=="" set "OUTPUT=Emily_depth.png"
  ) else (
    echo Usage: %~nx0 [input.jpg] [model.gguf] [output.png] [threads]
    echo.
    echo No input specified and Emily.jpg was not found in:
    echo %ROOT%
    echo.
    echo Example:
    echo %~nx0 "D:\path\image.jpg" "models\depth-anything-base-q8_0.gguf" "D:\path\image.depth.png" 6
    echo ErrorCode: 1
    pause
    exit /b 1
  )
)

if not exist "%INPUT%" (
  echo [ERROR] Input image not found: %INPUT%
  echo ErrorCode: 1
  pause
  exit /b 1
)

if "%MODEL%"=="" (
  if exist "models\depth-anything-base-q8_0.gguf" (
    set "MODEL=models\depth-anything-base-q8_0.gguf"
  ) else (
    for %%M in ("models\*.gguf") do (
      set "MODEL=%%~fM"
      goto :model_found
    )
  )
)
:model_found
if "%MODEL%"=="" (
  echo [ERROR] No model specified and no *.gguf found in %ROOT%models\
  echo ErrorCode: 1
  pause
  exit /b 1
)
if not exist "%MODEL%" (
  echo [ERROR] Model not found: %MODEL%
  echo ErrorCode: 1
  pause
  exit /b 1
)

if "%OUTPUT%"=="" set "OUTPUT=%~dpn1.depth.png"

%EXE% depth --model "%MODEL%" --input "%INPUT%" --png "%OUTPUT%" --threads %THREADS%

echo ErrorCode: %errorlevel%
if errorlevel 1 (
  pause
  exit /b %errorlevel%
)

echo [OK] Depth map written: %OUTPUT%
pause
exit /b 0
