cd /d "%~dp0"

da3-cli.exe depth --model "models\depth-anything-base-q8_0.gguf" --input "Emily.jpg" --png "Emily_depth.png" --threads 8

echo ErrorCode: %errorlevel%
pause

