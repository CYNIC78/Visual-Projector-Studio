@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Builds depth-anything.cpp CLI for Windows and copies da3-cli.exe here.
rem Requirements: Git, CMake, Visual Studio C++ Build Tools / Community with MSVC.

set "ROOT=%~dp0"
set "SRC=%ROOT%_src"
set "BUILD=%SRC%\build-vp-cpu"
set "REPO=https://github.com/mudler/depth-anything.cpp"
set "EXE_OUT=%ROOT%da3-cli.exe"

where git >nul 2>nul
if errorlevel 1 (
  echo [ERROR] git.exe not found in PATH.
  echo Install Git for Windows or enable Git in Visual Studio, then retry.
  exit /b 1
)

where cmake >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cmake.exe not found in PATH.
  echo Install CMake or enable C++ CMake tools in Visual Studio Installer, then retry.
  exit /b 1
)

rem Try to initialize MSVC environment if this is not already a Developer shell.
if not defined VSCMD_ARG_TGT_ARCH (
  set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
  if exist "!VSWHERE!" (
    for /f "usebackq tokens=*" %%I in (`"!VSWHERE!" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSINSTALL=%%I"
    if defined VSINSTALL (
      if exist "!VSINSTALL!\Common7\Tools\VsDevCmd.bat" (
        echo [INFO] Activating MSVC environment: !VSINSTALL!
        call "!VSINSTALL!\Common7\Tools\VsDevCmd.bat" -arch=x64 -host_arch=x64
        if errorlevel 1 exit /b 1
      )
    )
  )
)

if not exist "%SRC%\.git" (
  echo [INFO] Cloning depth-anything.cpp...
  git clone --recursive "%REPO%" "%SRC%"
  if errorlevel 1 exit /b 1
) else (
  echo [INFO] Updating depth-anything.cpp...
  git -C "%SRC%" pull --ff-only
  if errorlevel 1 exit /b 1
  git -C "%SRC%" submodule update --init --recursive
  if errorlevel 1 exit /b 1
)

rem Prefer Ninja if available; it avoids Visual Studio generator version guessing.
where ninja >nul 2>nul
if errorlevel 1 (
  echo [INFO] Configuring with default CMake generator...
  cmake -S "%SRC%" -B "%BUILD%" -DDA_BUILD_CLI=ON -DDA_BUILD_TESTS=OFF -DDA_GGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
) else (
  echo [INFO] Configuring with Ninja...
  cmake -S "%SRC%" -B "%BUILD%" -G Ninja -DDA_BUILD_CLI=ON -DDA_BUILD_TESTS=OFF -DDA_GGML_CUDA=OFF -DCMAKE_BUILD_TYPE=Release
)
if errorlevel 1 exit /b 1

echo [INFO] Building da3-cli...
cmake --build "%BUILD%" --config Release -j
if errorlevel 1 exit /b 1

set "FOUND="
for %%P in (
  "%BUILD%\examples\cli\Release\da3-cli.exe"
  "%BUILD%\examples\cli\da3-cli.exe"
  "%BUILD%\Release\da3-cli.exe"
  "%BUILD%\da3-cli.exe"
) do (
  if exist %%~P (
    set "FOUND=%%~P"
    goto :copy_exe
  )
)

for /r "%BUILD%" %%F in (da3-cli.exe) do (
  set "FOUND=%%F"
  goto :copy_exe
)

:copy_exe
if not defined FOUND (
  echo [ERROR] da3-cli.exe not found after build.
  echo Check build output under: %BUILD%
  exit /b 1
)

copy /Y "%FOUND%" "%EXE_OUT%" >nul
if errorlevel 1 exit /b 1

echo.
echo [OK] Built and copied:
echo      %EXE_OUT%
echo.
echo Next: put GGUF model files into:
echo      %ROOT%models\
echo.
exit /b 0
