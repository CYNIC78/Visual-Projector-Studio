@echo off
:: Устанавливаем путь к папке кэша WebView2 внутри директории нашего приложения.
:: %~dp0 ссылается на папку, в которой лежит этот батник.
set "WEBVIEW2_USER_DATA_FOLDER=%~dp0data\cache"

:: Запускаем исполняемый файл Neutralino
start "" "%~dp0neutralino-win_x64.exe"
