@echo off
setlocal
title 火羽直播实时字幕 - 一键安装
set "ROOM=https://live.bilibili.com/22748536"
set "DEST=%LOCALAPPDATA%\HuoyuSubExt"
set "PROF=%LOCALAPPDATA%\HuoyuSubProfile"
set "ZIP=%TEMP%\huoyu-live-sub.zip"
set "URL=https://hinome-lab.github.io/huoyu-browser-plugin/download/huoyu-live-sub-1.1.2.zip"

echo ==============================================
echo    火羽直播实时字幕  -  一键安装
echo ==============================================
echo.
echo [1/3] 正在下载插件（约 36 KB）...
if exist "%ZIP%" del /q "%ZIP%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "try{Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%ZIP%'}catch{exit 1}" >nul 2>&1
if not exist "%ZIP%" powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -UseBasicParsing -Uri '%URL%' -OutFile '%ZIP%'"
if not exist "%ZIP%" (
  echo   下载失败：请检查网络后重试，或到网页上手动下载 zip。
  pause
  exit /b 1
)
echo   下载完成。

echo.
echo [2/3] 正在安装到本机（不动你平时的浏览器）...
if exist "%DEST%" rmdir /s /q "%DEST%" >nul 2>&1
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '%ZIP%' -DestinationPath '%DEST%' -Force"
if not exist "%DEST%\manifest.json" (
  echo   解压失败，请手动下载 zip 解压后加载。
  pause
  exit /b 1
)
echo   安装完成：%DEST%

echo.
echo [3/3] 正在打开浏览器...
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
if not exist "%EDGE%" (
  echo   没找到 Edge 或 Chrome，请先安装其一，或手动打开浏览器加载扩展。
  pause
  exit /b 1
)
start "" "%EDGE%" --user-data-dir="%PROF%" --load-extension="%DEST%" --start-maximized "%ROOM%"

echo.
echo   完成！字幕会自动出现在直播画面上。
echo   - 调字号 / 行数 / 字幕延迟：点浏览器右上角的扩展图标
echo   - 下次使用：再双击一次这个启动器即可
echo.
timeout /t 6 >nul
endlocal
