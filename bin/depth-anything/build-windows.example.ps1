# Example build script for depth-anything.cpp on Windows.
# Run in Developer PowerShell / terminal with CMake + MSVC installed.
# This script is a reference only; it does not run inside VP Studio.

$ErrorActionPreference = "Stop"

$Repo = "https://github.com/mudler/depth-anything.cpp"
$Work = Join-Path $PSScriptRoot "_src"
$Out = $PSScriptRoot

if (!(Test-Path $Work)) {
  git clone --recursive $Repo $Work
}

Push-Location $Work
cmake -B build -DDA_BUILD_CLI=ON -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j

$Candidates = @(
  "build/examples/cli/Release/da3-cli.exe",
  "build/examples/cli/da3-cli.exe"
)

foreach ($c in $Candidates) {
  if (Test-Path $c) {
    Copy-Item $c (Join-Path $Out "da3-cli.exe") -Force
    Write-Host "Copied da3-cli.exe to $Out"
    Pop-Location
    exit 0
  }
}

Pop-Location
throw "da3-cli.exe not found after build. Check CMake generator output paths."
