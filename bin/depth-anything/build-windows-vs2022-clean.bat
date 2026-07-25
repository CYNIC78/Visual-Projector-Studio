@echo off
setlocal EnableExtensions

rem Known-good clean Visual Studio 2022 generator build for depth-anything.cpp.
rem This is the fallback/compat script for machines where the generic CMake build
rem cannot find the right VS/CMake environment.

set "ROOT=%~dp0"
set "SRC=%ROOT%_src"
set "REPO=https://github.com/mudler/depth-anything.cpp"
set "CMAKE_BIN=C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"

if not exist "%CMAKE_BIN%" (
  set "CMAKE_BIN=C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
)
if not exist "%CMAKE_BIN%" (
  set "CMAKE_BIN=C:\Program Files\Microsoft Visual Studio\18\Community\Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe"
)
if not exist "%CMAKE_BIN%" (
  echo [ERROR] CMake not found at known Visual Studio paths.
  echo Edit CMAKE_BIN in this .bat to your cmake.exe path.
  pause
  exit /b 1
)

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git.exe not found in PATH.
  pause
  exit /b 1
)

if not exist "%SRC%\.git" (
  echo [INFO] Cloning depth-anything.cpp into %SRC%
  git clone --recursive "%REPO%" "%SRC%"
  if errorlevel 1 goto error
) else (
  echo [INFO] Using existing source: %SRC%
)

cd /d "%SRC%"

if exist build_clean rmdir /s /q build_clean
mkdir build_clean
cd build_clean

"%CMAKE_BIN%" .. -G "Visual Studio 17 2022" -A x64 -DCMAKE_BUILD_TYPE=Release -DDA_BUILD_CLI=ON -DDA_BUILD_TESTS=OFF -DDA_GGML_CUDA=OFF
if errorlevel 1 goto error

"%CMAKE_BIN%" --build . --config Release --parallel
if errorlevel 1 goto error

set "FOUND="
for %%P in (
  "bin\Release\da3-cli.exe"
  "examples\cli\Release\da3-cli.exe"
  "Release\da3-cli.exe"
  "da3-cli.exe"
) do (
  if exist %%~P (
    set "FOUND=%%~fP"
    goto copy_exe
  )
)
for /r %%F in (da3-cli.exe) do (
  set "FOUND=%%F"
  goto copy_exe
)

:copy_exe
if not defined FOUND (
  echo [ERROR] Build completed but da3-cli.exe was not found.
  echo Check: %SRC%\build_clean
  pause
  exit /b 1
)

copy /Y "%FOUND%" "%ROOT%da3-cli.exe" >nul
if errorlevel 1 goto error

echo =======================================
echo SUCCESS! Copied EXE to:
echo %ROOT%da3-cli.exe
echo =======================================
pause
exit /b 0

:error
echo =======================================
echo ERROR OCCURRED DURING BUILD!
echo =======================================
pause
exit /b 1
