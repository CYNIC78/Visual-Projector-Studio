@echo off
chcp 65001 > nul
title СТУДИЯ В RAM-ДИСКЕ (R:)

:: НАСТРОЙКА ПУТЕЙ
set "RAM_DIR=R:\VisualProjectorStudio"
set "LOCAL_DIR=%~dp0"

echo ====================================================
echo  ЗАПУСК СТУДИИ В РЕЖИМЕ МАКСИМАЛЬНОЙ СКОРОСТИ (RAM)
echo ====================================================

:: 1. ПРОВЕРКА НАЛИЧИЯ RAM-ДИСКА
if not exist R:\ (
    color 0C
    echo [ОШИБКА] RAM-диск R: не найден в системе!
    echo Сначала запустите ImDisk и создайте диск R.
    pause
    exit /b
)

:: 2. СИНХРОНИЗАЦИЯ ПРОЕКТА В RAM-ДИСК
echo [1/3] Копируем проект в оперативную память на R:...
:: robocopy перенесет всё за доли секунды, пропуская уже существующие файлы
robocopy "%LOCAL_DIR%\" "%RAM_DIR%" /E /XF *.git* /NDL /NFL /NJH /NJS

:: 3. ПЕРЕХОД В RAM-ДИСК И НАСТРОЙКА ВЕБ-КЭША
cd /d "%RAM_DIR%"
set "WEBVIEW2_USER_DATA_FOLDER=%RAM_DIR%\data\cache"

:: Выжигаем дисковый кэш Chromium, заставляя его работать в инкогнито-RAM
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu-shader-disk-cache --disable-application-cache --disable-cache --disk-cache-size=1 --media-cache-size=1 --incognito"

:: 4. ЗАПУСК И ОЖИДАНИЕ
echo [2/3] Студия запущена из RAM. Жесткий диск отдыхает...
echo       НЕ ЗАКРЫВАЙТЕ ЭТО ОКНО КОНСОЛИ ВО ВРЕМЯ РАБОТЫ!
echo ----------------------------------------------------

:: Флаг /WAIT заставляет батник сидеть в засаде и ждать закрытия или краша программы
start /wait "" "neutralino-win_x64.exe"

:: 5. СПАСЕНИЕ ДАННЫХ ПОСЛЕ ЗАКРЫТИЯ ИЛИ КРАША
echo ----------------------------------------------------
echo [3/3] Программа завершила работу (или крашнулась).
echo       Синхронизируем измененный мир и конфиги обратно на SSD...

:: Забираем только измененные данные (папку data) обратно на жесткий диск
robocopy "%RAM_DIR%\data" "%LOCAL_DIR%\data" /E /NDL /NFL /NJH /NJS

echo [УСПЕХ] Все данные в безопасности на жестком диске. Сессия завершена.
echo ====================================================
timeout /t 3
exit
