param(
    [switch]$NonInteractive,
    [switch]$PurgeData,
    [switch]$StopRunning
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter 卸载工具' } catch {}

$FromBat = ($env:AG_TM_FROM_BAT -eq '1')
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Pause-IfDirect([switch]$IsError) {
    if ($NonInteractive) { return }
    if ($IsError -and $FromBat) { return }
    try {
        if ($IsError) {
            Read-Host '按回车键退出' | Out-Null
        } else {
            Read-Host '按回车键关闭窗口' | Out-Null
        }
    } catch {}
}

function Ensure-Directory([string]$DirPath) {
    if (-not [string]::IsNullOrWhiteSpace($DirPath)) {
        [System.IO.Directory]::CreateDirectory($DirPath) | Out-Null
    }
}

$RealUserProfile = ''
$RealLocalAppData = ''
try { $RealUserProfile = [Environment]::GetFolderPath('UserProfile') } catch {}
try { $RealLocalAppData = [Environment]::GetFolderPath('LocalApplicationData') } catch {}

function Test-SamePath([string]$A, [string]$B) {
    if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return $false }
    try {
        $na = [System.IO.Path]::GetFullPath($A).TrimEnd('\', '/')
        $nb = [System.IO.Path]::GetFullPath($B).TrimEnd('\', '/')
        return $na.Equals($nb, [System.StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $A.Equals($B, [System.StringComparison]::OrdinalIgnoreCase)
    }
}

$HomeDir = if ($env:AG_TEST_HOME) { $env:AG_TEST_HOME } elseif ($env:USERPROFILE) { $env:USERPROFILE } else { $RealUserProfile }
$IsSandbox = [bool]$env:AG_TEST_HOME
if (-not $IsSandbox -and $HomeDir -and $RealUserProfile -and (-not (Test-SamePath $HomeDir $RealUserProfile))) {
    $IsSandbox = $true
}

$LocalDir = if ($env:AG_TEST_LOCAL) {
    $env:AG_TEST_LOCAL
} elseif ($env:AG_TEST_HOME) {
    if ($env:LOCALAPPDATA -and $RealLocalAppData -and (-not (Test-SamePath $env:LOCALAPPDATA $RealLocalAppData))) {
        $env:LOCALAPPDATA
    } else {
        Join-Path $HomeDir 'AppData\Local'
    }
} elseif ($env:LOCALAPPDATA) {
    $env:LOCALAPPDATA
} else {
    Join-Path $HomeDir 'AppData\Local'
}

$DstPlugin = Join-Path $HomeDir '.gemini\config\plugins\antigravity-token-meter'
$ConfigFile = Join-Path $HomeDir '.gemini\config\config.json'
$ConfigDir = Join-Path $LocalDir 'AntigravityTokenMeter'
$SidecarData = Join-Path $HomeDir '.gemini\antigravity\sidecar_data\antigravity-token-meter'

function Get-AntigravityProcessInfo {
    if ($IsSandbox) {
        return [PSCustomObject]@{ AllProcs = @(); GuiProcs = @(); ElevatedUnknown = $false }
    }
    $all = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop)
    $gui = @()
    $unknownCmd = 0
    foreach ($p in $all) {
        if ([string]::IsNullOrEmpty($p.CommandLine)) {
            $unknownCmd++
            continue
        }
        if ($p.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--import=|(?:^|\s)--type=|(?:^|\s)--crash') {
            $gui += $p
        }
    }
    return [PSCustomObject]@{
        AllProcs        = $all
        GuiProcs        = $gui
        ElevatedUnknown = ($gui.Count -eq 0 -and $unknownCmd -gt 0)
    }
}

function Stop-AntigravityGracefully {
    if ($IsSandbox) { return 'stopped' }
    Write-Host '      正在安全关闭运行中的 Antigravity（含托盘实例）...' -ForegroundColor Cyan
    $accessDenied = $false
    try {
        $procs = @(Get-Process -Name 'Antigravity' -ErrorAction SilentlyContinue)
        foreach ($p in $procs) {
            if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
                try { $p.CloseMainWindow() | Out-Null } catch {}
            }
        }
    } catch {}
    for ($i = 0; $i -lt 6; $i++) {
        Start-Sleep -Milliseconds 500
        $info = Get-AntigravityProcessInfo
        if ($info.AllProcs.Count -eq 0) { Start-Sleep -Milliseconds 600; return 'stopped' }
    }
    $info = Get-AntigravityProcessInfo
    $targets = if ($info.GuiProcs.Count -gt 0) { $info.GuiProcs } else { $info.AllProcs }
    foreach ($p in $targets) {
        try {
            Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop
        } catch {
            if ($_.Exception.Message -match '(?i)Access is denied|拒绝访问') { $accessDenied = $true }
        }
    }
    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 500
        $info = Get-AntigravityProcessInfo
        if ($info.AllProcs.Count -eq 0) { Start-Sleep -Milliseconds 800; return 'stopped' }
        if ($i -eq 6) {
            foreach ($rem in $info.AllProcs) {
                try { Stop-Process -Id ([int]$rem.ProcessId) -Force -ErrorAction Stop } catch {}
            }
        }
    }
    if ($accessDenied) { return 'access_denied' }
    return 'timeout'
}

Write-Host '============================================================' -ForegroundColor Cyan
Write-Host '   Antigravity TokenMeter 安全卸载程序' -ForegroundColor Cyan
Write-Host '============================================================' -ForegroundColor Cyan
Write-Host ''

if (-not $NonInteractive) {
    $confirm = Read-Host '确认要卸载 Antigravity TokenMeter 吗？(输入 Y 确认，直接回车或其他键取消)'
    if ($confirm -notmatch '^[Yy]$') {
        Write-Host '已取消卸载（未改动任何文件）。' -ForegroundColor Yellow
        Pause-IfDirect
        exit 0
    }
}

# 1. 检查运行中进程（避免退出时把旧注册项回写到 config.json 或文件锁占用）
$procInfo = $null
try {
    $procInfo = Get-AntigravityProcessInfo
} catch {
    Write-Host '[错误] 无法检查 Antigravity 进程状态，已中止卸载。' -ForegroundColor Red
    Pause-IfDirect -IsError
    exit 2
}

$isRunning = ($procInfo.GuiProcs.Count -gt 0) -or $procInfo.ElevatedUnknown
if ($isRunning) {
    if ($NonInteractive) {
        if ($StopRunning) {
            $stopRes = Stop-AntigravityGracefully
            if ($stopRes -ne 'stopped') {
                Write-Host "[错误] 自动关闭 Antigravity 失败 ($stopRes)，请先手动彻底退出客户端后再卸载。" -ForegroundColor Red
                exit 3
            }
        } else {
            Write-Host '[错误] 检测到 Antigravity 主界面正在运行，请先彻底退出客户端（含托盘）后再卸载，或传入 -StopRunning。' -ForegroundColor Red
            exit 3
        }
    } elseif ($procInfo.ElevatedUnknown) {
        Write-Host '[提示] 检测到 Antigravity 正以管理员权限运行，请先右键右下角系统托盘点击【退出】后再继续卸载。' -ForegroundColor Yellow
        $ansElev = Read-Host '确认已彻底退出 Antigravity 后按回车继续（输入 q 取消）'
        if ($ansElev -match '^[Qq]$') {
            Write-Host '已取消卸载。' -ForegroundColor Gray
            Pause-IfDirect
            exit 0
        }
        for ($i = 0; $i -lt 16; $i++) {
            $procInfo = Get-AntigravityProcessInfo
            if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
            Write-Host '[错误] 仍检测到 Antigravity 正在运行，卸载已中止。' -ForegroundColor Red
            Pause-IfDirect -IsError
            exit 3
        }
    } else {
        Write-Host ''
        Write-Host '[提示] 检测到 Antigravity 正在运行（可能驻留在右下角系统托盘）。运行中卸载可能导致配置被回写或文件被占用。' -ForegroundColor Yellow
        Write-Host '  [1] 一键安全关闭 Antigravity 并继续卸载（推荐，直接回车）' -ForegroundColor Green
        Write-Host '  [2] 我手动从系统托盘退出后再继续卸载' -ForegroundColor White
        Write-Host '  [3] 取消卸载' -ForegroundColor Gray
        $choice = Read-Host '请输入选项 [1/2/3]（直接回车默认选 1）'
        if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim() -eq '1') {
            $stopRes = Stop-AntigravityGracefully
            if ($stopRes -ne 'stopped') {
                Write-Host "[错误] 关闭 Antigravity 失败 ($stopRes)，请手动退出托盘后再卸载。" -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 3
            }
        } elseif ($choice.Trim() -eq '2') {
            Read-Host '请右键系统托盘退出 Antigravity 后按回车继续' | Out-Null
            for ($i = 0; $i -lt 16; $i++) {
                $procInfo = Get-AntigravityProcessInfo
                if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
                Start-Sleep -Milliseconds 500
            }
            if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
                Write-Host '[错误] 仍检测到 Antigravity 正在运行，卸载已中止。' -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 3
            }
        } else {
            Write-Host '已取消卸载。' -ForegroundColor Gray
            Pause-IfDirect
            exit 0
        }
    }
}

# 2. 备份并从 config.json 原子移除本插件与 sidecar 注册项（格式损坏时温和警告，不阻断后续文件清理）
if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
    $parsed = $null
    try {
        $raw = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        if (-not [string]::IsNullOrWhiteSpace($raw)) { $parsed = $raw | ConvertFrom-Json }
    } catch {
        $parsed = $null
    }

    if ($null -eq $parsed -or ($parsed -is [System.Array]) -or (-not ($parsed -is [PSCustomObject]))) {
        Write-Host '[警告] 现有 config.json 格式损坏，已跳过 config.json 清理（未改动原文件），继续移除插件文件。' -ForegroundColor Yellow
    } else {
        $cfgBakDir = Join-Path $ConfigDir 'config-backups'
        Ensure-Directory $cfgBakDir
        $randTag = [guid]::NewGuid().ToString('N').Substring(0, 8)
        [System.IO.File]::Copy($ConfigFile, (Join-Path $cfgBakDir ('config-uninstall-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randTag + '.json')), $true)

        $cfg = [ordered]@{}
        foreach ($p in $parsed.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
        if ($cfg.Contains('plugins') -and ($cfg['plugins'] -is [PSCustomObject])) {
            $pm = [ordered]@{}
            foreach ($p in $cfg['plugins'].PSObject.Properties) {
                if ($p.Name -ne 'antigravity-token-meter') { $pm[$p.Name] = $p.Value }
            }
            $cfg['plugins'] = $pm
        }
        if ($cfg.Contains('sidecars') -and ($cfg['sidecars'] -is [PSCustomObject])) {
            $sm = [ordered]@{}
            foreach ($p in $cfg['sidecars'].PSObject.Properties) {
                if ($p.Name -ne 'antigravity-token-meter/meter') { $sm[$p.Name] = $p.Value }
            }
            $cfg['sidecars'] = $sm
        }

        $tmp = Join-Path (Split-Path -Parent $ConfigFile) ('.tm-uninst-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
        try {
            [System.IO.File]::WriteAllText($tmp, (($cfg | ConvertTo-Json -Depth 100) + "`n"), $Utf8NoBom)
            try {
                [System.IO.File]::Replace($tmp, $ConfigFile, [NullString]::Value, $true)
            } catch {
                [System.IO.File]::Copy($tmp, $ConfigFile, $true)
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            }
        } catch {
            if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
            throw
        }
        Write-Host '[已清理] 已从 config.json 移除 TokenMeter 插件与 sidecar 注册项。' -ForegroundColor Green
    }
}

# 3. 清理运行状态文件、临时租约与插件目录
foreach ($runtimeFile in @(
    (Join-Path $SidecarData 'meter\data\integration-status.json'),
    (Join-Path $SidecarData 'meter\data\owner-lease.json'),
    (Join-Path $SidecarData 'meter\data\pending-import.json')
)) {
    if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
        Remove-Item -LiteralPath $runtimeFile -Force -ErrorAction SilentlyContinue
    }
}

$pluginsRoot = Split-Path -Parent $DstPlugin
if (Test-Path -LiteralPath $pluginsRoot -PathType Container) {
    Get-ChildItem -LiteralPath $pluginsRoot -Directory -Filter '.antigravity-token-meter-prev-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
}

if (Test-Path -LiteralPath $DstPlugin) {
    Remove-Item -LiteralPath $DstPlugin -Recurse -Force
    Write-Host ('[已移除] ' + $DstPlugin) -ForegroundColor Green
} else {
    Write-Host '[提示] 插件目录不存在，无需删除。' -ForegroundColor Gray
}

# 4. 可选清除偏好与历史账本（默认保留历史记录与备份）
$shouldPurge = [bool]$PurgeData
if (-not $shouldPurge -and -not $NonInteractive -and ((Test-Path -LiteralPath $ConfigDir) -or (Test-Path -LiteralPath $SidecarData))) {
    $ans = Read-Host '是否同时清除本地偏好配置与历史 Token 账本？(y/N，直接回车默认保留历史记录)'
    if ($ans -match '^[Yy]$') { $shouldPurge = $true }
}
if ($shouldPurge) {
    if (Test-Path -LiteralPath $ConfigDir) { Remove-Item -LiteralPath $ConfigDir -Recurse -Force -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $SidecarData) { Remove-Item -LiteralPath $SidecarData -Recurse -Force -ErrorAction SilentlyContinue }
    Write-Host '[已清理] 已移除本地偏好与历史账本数据。' -ForegroundColor Green
}

Write-Host ''
Write-Host '[完成] Antigravity TokenMeter 卸载完毕！' -ForegroundColor Green
Pause-IfDirect
exit 0
