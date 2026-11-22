@echo off
chcp 65001 >nul 2>&1
setlocal EnableExtensions DisableDelayedExpansion
set "AG_TM_FROM_BAT=1"
set "SCRIPT_FILE=%~dp0scripts\uninstall.ps1"

set "NO_PAUSE=0"
for %%A in (%*) do (
    if /i "%%~A"=="-NonInteractive" set "NO_PAUSE=1"
)

if not exist "%SCRIPT_FILE%" goto :missing_files

set "PS_EXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%PS_EXE%" goto :run_ps
where pwsh.exe >nul 2>&1 && (
    for /f "delims=" %%I in ('where pwsh.exe 2^>nul') do (
        set "PS_EXE=%%I"
        goto :run_ps
    )
)
where powershell.exe >nul 2>&1 && (
    for /f "delims=" %%I in ('where powershell.exe 2^>nul') do (
        set "PS_EXE=%%I"
        goto :run_ps
    )
)
goto :missing_ps

:run_ps
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_FILE%" %*
set "EXIT_CODE=%ERRORLEVEL%"
if not "%EXIT_CODE%"=="0" goto :failed
exit /b 0

:missing_files
echo.
echo [错误 / ERROR] 找不到卸载脚本 scripts\uninstall.ps1！
echo 请先右键压缩包选择【全部解压缩】，完整解压到常规文件夹后再双击卸载！
echo Please extract the entire ZIP archive to a regular folder before running.
echo.
if "%NO_PAUSE%"=="0" pause
exit /b 1

:missing_ps
echo.
echo [错误 / ERROR] 未在系统中找到 PowerShell ^(powershell.exe / pwsh.exe^)。
echo 请检查 Windows PowerShell 是否正常或被安全软件拦截。
echo.
if "%NO_PAUSE%"=="0" pause
exit /b 1

:failed
if "%NO_PAUSE%"=="1" exit /b %EXIT_CODE%
echo.
echo [提示] 卸载未完成或已中止 ^(退出码: %EXIT_CODE%^)，请查看上方提示信息。
pause
exit /b %EXIT_CODE%
