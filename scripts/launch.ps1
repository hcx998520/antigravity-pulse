param(
    [switch]$NonInteractive
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = 'Antigravity 专用启动器（TokenMeter 内嵌监控）' } catch {}

function Find-AntigravityExe {
    $candidates = @()
    if ($env:LOCALAPPDATA) {
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\Antigravity\Antigravity.exe')
        $candidates += (Join-Path $env:LOCALAPPDATA 'Programs\antigravity\Antigravity.exe')
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe')
    }
    # 从 Windows 卸载注册表读取真实安装位置（含 64 位与 32 位视图，安全去除首尾引号）
    $regRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $regRoots) {
        try {
            Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
                $_.DisplayName -match '^Antigravity\b'
            } | ForEach-Object {
                if ($_.InstallLocation) {
                    $cleanLoc = ([string]$_.InstallLocation).Trim().Trim('"')
                    if ($cleanLoc) { $candidates += (Join-Path $cleanLoc 'Antigravity.exe') }
                }
                if ($_.DisplayIcon) {
                    $iconPath = ($_.DisplayIcon -replace ',.*$', '').Trim().Trim('"')
                    if ($iconPath -match '(?i)\\Antigravity\.exe$') { $candidates += $iconPath }
                }
            }
        } catch {}
    }

    foreach ($p in ($candidates | Select-Object -Unique)) {
        if ($p -and (Test-Path -LiteralPath $p -PathType Leaf)) {
            return (Resolve-Path -LiteralPath $p).Path
        }
    }
    return $null
}

$exe = Find-AntigravityExe
if (-not $exe) {
    Write-Host '[错误] 未在标准目录或系统注册表中找到 Antigravity.exe。' -ForegroundColor Red
    Write-Host '如您将 Antigravity 安装在便携路径，请直接运行: "你的路径\Antigravity.exe" --remote-debugging-port=0' -ForegroundColor Yellow
    if (-not $NonInteractive) { Read-Host '按回车键退出' }
    exit 1
}

try {
    $guiProcs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop | Where-Object {
        $_.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--type='
    })
} catch {
    Write-Host '[错误] 无法检查当前 Antigravity 进程状态，已中止启动。' -ForegroundColor Red
    if (-not $NonInteractive) { Read-Host '按回车键退出' }
    exit 2
}

if ($guiProcs.Count -gt 0) {
    $hasDebugFlag = @($guiProcs | Where-Object { $_.CommandLine -and $_.CommandLine -match '(?:^|\s)--remote-debugging-port=\d+' }).Count -gt 0
    if ($hasDebugFlag) {
        Write-Host '[提示] 检测到 Antigravity 已携带 --remote-debugging-port 调试参数在运行中，无需重复启动。' -ForegroundColor Green
        Write-Host '如未看到底部内嵌状态条，可双击「一键诊断内嵌状态(Windows).bat」检查挂载状态。' -ForegroundColor Cyan
    } else {
        Write-Host '[提示] 检测到 Antigravity 主界面仍在运行（可能驻留在右下角系统托盘中，且未开启调试端口）。' -ForegroundColor Yellow
        Write-Host '请先右键系统托盘 Antigravity 图标点击【退出】，再双击本启动器以启用 --remote-debugging-port=0。' -ForegroundColor Yellow
    }
    if (-not $NonInteractive) { Read-Host '按回车键退出' }
    exit 5
}

$workDir = Split-Path -Parent $exe
Write-Host ('[启动] 正在启动: ' + $exe + ' --remote-debugging-port=0') -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList '--remote-debugging-port=0' -WorkingDirectory $workDir
exit 0
