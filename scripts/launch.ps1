param(
    [switch]$NonInteractive,
    [switch]$RestartIfRunning,
    [switch]$NoWaitReady,
    [string]$ExePath
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = 'Antigravity 专用启动器（TokenMeter 底部状态条监控）' } catch {}

$FromBat = ($env:AG_TM_FROM_BAT -eq '1')

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

$RealUserProfile = ''
$RealLocalAppData = ''
$RealAppData = ''
try { $RealUserProfile = [Environment]::GetFolderPath('UserProfile') } catch {}
try { $RealLocalAppData = [Environment]::GetFolderPath('LocalApplicationData') } catch {}
try { $RealAppData = [Environment]::GetFolderPath('ApplicationData') } catch {}

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

$AppDataDir = if ($env:AG_TEST_APPDATA) {
    $env:AG_TEST_APPDATA
} elseif ($env:AG_TEST_HOME) {
    if ($env:APPDATA -and $RealAppData -and (-not (Test-SamePath $env:APPDATA $RealAppData))) {
        $env:APPDATA
    } else {
        Join-Path $HomeDir 'AppData\Roaming'
    }
} elseif ($env:APPDATA) {
    $env:APPDATA
} else {
    Join-Path $HomeDir 'AppData\Roaming'
}

$PluginDir = Join-Path $HomeDir '.gemini\config\plugins\antigravity-token-meter'
$ConfigFile = Join-Path $HomeDir '.gemini\config\config.json'
$SettingsFile = Join-Path $LocalDir 'AntigravityTokenMeter\settings.json'

function Get-CandidateProfiles {
    $list = @()
    foreach ($envProf in @($env:AG_TM_PROFILE, $env:ANTIGRAVITY_USER_DATA_DIR, $env:ELECTRON_USER_DATA_DIR)) {
        if ($envProf -and -not [string]::IsNullOrWhiteSpace($envProf)) {
            $list += $envProf.Trim()
        }
    }
    if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
        try {
            $rawSet = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            $st = $rawSet | ConvertFrom-Json
            if ($st -is [PSCustomObject] -and $st.profile -is [string] -and -not [string]::IsNullOrWhiteSpace($st.profile)) {
                $list += $st.profile.Trim()
            }
        } catch {}
    }
    $list += (Join-Path $AppDataDir 'Antigravity')
    $list += (Join-Path $AppDataDir 'Antigravity - Insiders')
    $list += (Join-Path $AppDataDir 'Antigravity Insiders')
    return @($list | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)
}

function Test-ActiveDevToolsPort([string[]]$Profiles) {
    foreach ($pDir in $Profiles) {
        if ([string]::IsNullOrWhiteSpace($pDir)) { continue }
        $pf = Join-Path $pDir 'DevToolsActivePort'
        if (-not (Test-Path -LiteralPath $pf -PathType Leaf)) { continue }
        try {
            $lines = @(Get-Content -LiteralPath $pf -ErrorAction Stop)
            $portStr = if ($lines.Count -gt 0) { ([string]$lines[0]).Trim() } else { '' }
            if ($portStr -notmatch '^[1-9]\d{0,4}$' -or [int]$portStr -gt 65535) { continue }
            $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$portStr/json/list")
            $req.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
            $req.AllowAutoRedirect = $false
            $req.Timeout = 2000
            $resp = $req.GetResponse()
            $code = [int]$resp.StatusCode
            $rawJson = ''
            try {
                $sr = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
                $rawJson = $sr.ReadToEnd()
                $sr.Close()
            } catch {}
            $resp.Close()
            if ($code -eq 200) {
                $pages = 0
                try {
                    $targets = @($rawJson | ConvertFrom-Json)
                    $pages = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://' }).Count
                } catch {}
                return [PSCustomObject]@{ Ready = $true; Port = [int]$portStr; PortFile = $pf; PageCount = $pages }
            }
        } catch {}
    }
    return [PSCustomObject]@{ Ready = $false; Port = $null; PortFile = $null; PageCount = 0 }
}

function Get-AntigravityProcessInfo {
    if ($IsSandbox) {
        return [PSCustomObject]@{
            AllProcs        = @()
            GuiProcs        = @()
            SidecarProcs    = @()
            ElevatedUnknown = $false
            HasDebugPort    = $false
            ExecutablePath  = $null
            MainCommandLine = $null
        }
    }
    $all = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop)
    $gui = @()
    $sidecar = @()
    $unknownCmd = 0
    $exePath = $null
    $mainCmd = $null
    foreach ($p in $all) {
        if (-not $exePath -and $p.ExecutablePath -and (Test-Path -LiteralPath $p.ExecutablePath -PathType Leaf)) {
            $exePath = $p.ExecutablePath
        }
        if ([string]::IsNullOrEmpty($p.CommandLine)) {
            $unknownCmd++
            continue
        }
        if ($p.CommandLine -match 'sidecar_sdk|(?:^|\s)--import=') {
            $sidecar += $p
        } elseif ($p.CommandLine -notmatch '(?:^|\s)--type=|(?:^|\s)--crash') {
            $gui += $p
            if (-not $mainCmd) { $mainCmd = $p.CommandLine }
        }
    }
    $elevatedUnknown = ($gui.Count -eq 0 -and $unknownCmd -gt 0)
    $hasDebug = (@($gui | Where-Object { $_.CommandLine -match '(?:^|\s)--remote-debugging-port=\d+' }).Count -gt 0)
    return [PSCustomObject]@{
        AllProcs        = $all
        GuiProcs        = $gui
        SidecarProcs    = $sidecar
        ElevatedUnknown = $elevatedUnknown
        HasDebugPort    = $hasDebug
        ExecutablePath  = $exePath
        MainCommandLine = $mainCmd
    }
}

function Get-PreservedLaunchArgs([string]$CommandLine) {
    if ([string]::IsNullOrWhiteSpace($CommandLine)) { return @() }
    $rest = $CommandLine.Trim()
    if ($rest.StartsWith('"')) {
        $endQuote = $rest.IndexOf('"', 1)
        if ($endQuote -lt 0) { return @() }
        $rest = $rest.Substring($endQuote + 1).Trim()
    } else {
        $sp = $rest.IndexOf(' ')
        if ($sp -lt 0) { return @() }
        $rest = $rest.Substring($sp + 1).Trim()
    }
    if ([string]::IsNullOrWhiteSpace($rest)) { return @() }

    $tokens = @()
    $tokenMatches = [regex]::Matches($rest, '(?:"[^"]*"|\S)+')
    foreach ($m in $tokenMatches) { $tokens += $m.Value }

    $safePrefixes = @(
        '--proxy-server=',
        '--proxy-bypass-list=',
        '--proxy-pac-url=',
        '--user-data-dir=',
        '--lang=',
        '--force-device-scale-factor='
    )
    $safeStandalone = @(
        '--no-proxy-server',
        '--disable-gpu',
        '--disable-http2',
        '--ignore-certificate-errors'
    )
    $safePairFlags = @(
        '--proxy-server',
        '--proxy-bypass-list',
        '--proxy-pac-url',
        '--user-data-dir',
        '--lang',
        '--force-device-scale-factor'
    )

    $kept = @()
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i]
        if ($t -match '^--remote-debugging-port(?:=|$)') {
            if ($t -eq '--remote-debugging-port' -and ($i + 1) -lt $tokens.Count) { $i++ }
            continue
        }
        $matched = $false
        foreach ($pfx in $safePrefixes) {
            if ($t.StartsWith($pfx, [System.StringComparison]::OrdinalIgnoreCase)) {
                $kept += $t
                $matched = $true
                break
            }
        }
        if ($matched) { continue }
        foreach ($sf in $safeStandalone) {
            if ($t.Equals($sf, [System.StringComparison]::OrdinalIgnoreCase)) {
                $kept += $t
                $matched = $true
                break
            }
        }
        if ($matched) { continue }
        foreach ($pf in $safePairFlags) {
            if ($t.Equals($pf, [System.StringComparison]::OrdinalIgnoreCase) -and ($i + 1) -lt $tokens.Count) {
                $kept += $t
                $kept += $tokens[$i + 1]
                $i++
                break
            }
        }
    }
    return $kept
}

function Find-AntigravityExe([string]$PreferredPath = $null) {
    $candidates = @()
    if ($ExePath) { $candidates += $ExePath.Trim().Trim('"') }
    if ($PreferredPath) { $candidates += $PreferredPath.Trim().Trim('"') }
    if ($env:ANTIGRAVITY_EXE) { $candidates += $env:ANTIGRAVITY_EXE.Trim().Trim('"') }
    if ($LocalDir) {
        $candidates += (Join-Path $LocalDir 'Programs\Antigravity\Antigravity.exe')
        $candidates += (Join-Path $LocalDir 'Programs\antigravity\Antigravity.exe')
        $candidates += (Join-Path $LocalDir 'Antigravity\Antigravity.exe')
    }
    if ($env:ProgramFiles) {
        $candidates += (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe')
    }
    if (${env:ProgramFiles(x86)}) {
        $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Antigravity\Antigravity.exe')
    }

    # 1. 注册表（卸载项 + App Paths）
    $regRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKCU:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $regRoots) {
        try {
            Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object {
                $_.DisplayName -match '(?i)\bAntigravity\b'
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
    foreach ($appPathKey in @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths\Antigravity.exe',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths\Antigravity.exe'
    )) {
        try {
            if (Test-Path -LiteralPath $appPathKey) {
                $apVal = (Get-ItemProperty -LiteralPath $appPathKey -ErrorAction SilentlyContinue).'(default)'
                if ($apVal) { $candidates += ([string]$apVal).Trim().Trim('"') }
            }
        } catch {}
    }

    # 2. 桌面、开始菜单与任务栏快捷方式 (.lnk) 全覆盖解析
    if (-not $IsSandbox) {
        $lnkDirs = @()
        try { $lnkDirs += [Environment]::GetFolderPath('Desktop') } catch {}
        try { $lnkDirs += [Environment]::GetFolderPath('CommonDesktopDirectory') } catch {}
        try { $lnkDirs += [Environment]::GetFolderPath('StartMenu') } catch {}
        try { $lnkDirs += [Environment]::GetFolderPath('CommonStartMenu') } catch {}
        if ($AppDataDir) {
            $lnkDirs += (Join-Path $AppDataDir 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar')
        }
        $wsh = $null
        try { $wsh = New-Object -ComObject WScript.Shell } catch {}
        if ($null -ne $wsh) {
            foreach ($dir in ($lnkDirs | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)) {
                try {
                    Get-ChildItem -LiteralPath $dir -Filter '*Antigravity*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            $target = $wsh.CreateShortcut($_.FullName).TargetPath
                            if ($target -and $target -match '(?i)\\Antigravity\.exe$') {
                                $candidates += $target
                            }
                        } catch {}
                    }
                } catch {}
            }
        }
    }

    # 3. PATH 回退
    try {
        $cmd = Get-Command 'Antigravity.exe' -ErrorAction SilentlyContinue
        if ($cmd -and $cmd.Source) { $candidates += $cmd.Source }
    } catch {}

    foreach ($p in ($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $p -PathType Leaf) {
            return (Resolve-Path -LiteralPath $p).Path
        }
    }
    return $null
}

function Stop-AntigravityGracefully {
    if ($IsSandbox) { return 'stopped' }
    Write-Host '[重启] 正在安全关闭现有无调试端口的 Antigravity 实例（含托盘驻留进程）...' -ForegroundColor Cyan
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
        if ($info.AllProcs.Count -eq 0) {
            Start-Sleep -Milliseconds 600
            return 'stopped'
        }
    }

    $info = Get-AntigravityProcessInfo
    $targets = if ($info.GuiProcs.Count -gt 0) { $info.GuiProcs } else { $info.AllProcs }
    foreach ($p in $targets) {
        try {
            Stop-Process -Id ([int]$p.ProcessId) -Force -ErrorAction Stop
        } catch [System.ComponentModel.Win32Exception], [System.UnauthorizedAccessException] {
            $accessDenied = $true
        } catch {
            if ($_.Exception.Message -match '(?i)Access is denied|拒绝访问') { $accessDenied = $true }
        }
    }

    for ($i = 0; $i -lt 12; $i++) {
        Start-Sleep -Milliseconds 500
        $info = Get-AntigravityProcessInfo
        if ($info.AllProcs.Count -eq 0) {
            Start-Sleep -Milliseconds 800
            return 'stopped'
        }
        if ($i -eq 6) {
            foreach ($rem in $info.AllProcs) {
                try {
                    Stop-Process -Id ([int]$rem.ProcessId) -Force -ErrorAction Stop
                } catch {
                    if ($_.Exception.Message -match '(?i)Access is denied|拒绝访问') { $accessDenied = $true }
                }
            }
        }
    }

    if ($accessDenied) { return 'access_denied' }
    return 'timeout'
}

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '   Antigravity 专用启动器（TokenMeter 底部内嵌监控）' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host ''

# 轻量前置提醒（不阻断启动，但让未安装/已关闭内嵌的用户一眼明白原因）
if (-not (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\main.mjs') -PathType Leaf)) {
    Write-Host '[提醒] 尚未检测到已安装的 TokenMeter 插件文件，建议先双击「一键安装插件(Windows双击运行).bat」。' -ForegroundColor Yellow
} elseif (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
    try {
        $stCheck = ([System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        if ($stCheck -is [PSCustomObject] -and (-not ($stCheck -is [System.Array]))) {
            $inlineProp = $stCheck.PSObject.Properties['inline']
            if ($null -ne $inlineProp) {
                if (-not ($inlineProp.Value -is [bool])) {
                    Write-Host '[提醒] 当前本地 settings.json 的 inline 字段类型非法（须为布尔值），底部状态条已被安全关闭。建议运行诊断工具 -Fix 一键修复。' -ForegroundColor Yellow
                } elseif ($inlineProp.Value -eq $false) {
                    Write-Host '[提醒] 当前本地 settings.json 已设为纯侧边栏模式 (inline=false)。如需显示底部条，请运行安装器选 [1] 或诊断工具 -Fix。' -ForegroundColor Yellow
                }
            }
        } else {
            Write-Host '[提醒] 当前本地 settings.json 格式损坏，底部状态条已被安全关闭。建议运行诊断工具 -Fix 一键修复。' -ForegroundColor Yellow
        }
    } catch {
        Write-Host '[提醒] 当前本地 settings.json 格式损坏，底部状态条已被安全关闭。建议运行诊断工具 -Fix 一键修复。' -ForegroundColor Yellow
    }
}

$procInfo = $null
try {
    $procInfo = Get-AntigravityProcessInfo
} catch {
    Write-Host '[错误] 无法检查当前 Antigravity 进程状态，已中止启动。' -ForegroundColor Red
    Pause-IfDirect -IsError
    exit 2
}

$exe = Find-AntigravityExe $procInfo.ExecutablePath
if (-not $exe -and -not $NonInteractive) {
    Write-Host '[提示] 未在标准安装目录、注册表或桌面/开始菜单快捷方式中找到 Antigravity.exe。' -ForegroundColor Yellow
    $manualPath = Read-Host '可直接将 Antigravity.exe 拖入本窗口后按回车（留空则退出）'
    $manualPath = if ($manualPath) { $manualPath.Trim().Trim('"') } else { '' }
    if ($manualPath -and (Test-Path -LiteralPath $manualPath -PathType Leaf)) {
        $exe = (Resolve-Path -LiteralPath $manualPath).Path
    }
}
if (-not $exe) {
    Write-Host '[错误] 未找到 Antigravity.exe。' -ForegroundColor Red
    Write-Host '如您使用便携版，请使用命令行启动: "你的路径\Antigravity.exe" --remote-debugging-port=0' -ForegroundColor Yellow
    Write-Host '或传入参数: scripts\launch.ps1 -ExePath "你的路径\Antigravity.exe"' -ForegroundColor Gray
    Pause-IfDirect -IsError
    exit 1
}

$profileCands = Get-CandidateProfiles
$preservedArgs = @(Get-PreservedLaunchArgs $procInfo.MainCommandLine)
$isRunning = ($procInfo.GuiProcs.Count -gt 0) -or $procInfo.ElevatedUnknown

if ($isRunning) {
    $livePort = Test-ActiveDevToolsPort $profileCands
    if ($procInfo.HasDebugPort -or ($procInfo.ElevatedUnknown -and $livePort.Ready)) {
        if ($livePort.Ready) {
            Write-Host ("[正常] Antigravity 已携带 --remote-debugging-port 运行中，本地调试端口连通正常 (port=$($livePort.Port))！") -ForegroundColor Green
        } else {
            Write-Host '[提示] Antigravity 已携带 --remote-debugging-port 启动中，无需重复打开。' -ForegroundColor Green
        }
        Write-Host '       如聊天界面未显示底部状态条，可双击「一键诊断内嵌状态(Windows).bat」检查与一键修复。' -ForegroundColor Cyan
        Write-Host ''
        Pause-IfDirect
        exit 0
    }

    # 关键根治（场景 B）：拦截无调试端口的残留/托盘实例，绝不静默启动被 Electron 单实例锁吞参数！
    Write-Host '[拦截] 检测到 Antigravity 已在运行（或隐藏在右下角系统托盘），但当前实例【未开启】调试端口！' -ForegroundColor Yellow
    Write-Host '       若直接启动，Electron 单实例锁会静默忽略 --remote-debugging-port=0，导致底部状态条无法显示。' -ForegroundColor Yellow
    Write-Host ''

    if ($NonInteractive) {
        if ($RestartIfRunning) {
            $stopRes = Stop-AntigravityGracefully
            if ($stopRes -ne 'stopped') {
                Write-Host "[错误] 自动关闭旧实例失败 ($stopRes)，请先手动右键系统托盘彻底退出 Antigravity 后重试。" -ForegroundColor Red
                exit 5
            }
        } else {
            Write-Host '[错误] 非交互模式下检测到无调试端口的运行中实例，已中止启动（请先退出托盘实例，或传入 -RestartIfRunning）。' -ForegroundColor Red
            exit 5
        }
    } elseif ($procInfo.ElevatedUnknown) {
        Write-Host '  检测到当前 Antigravity 正以【管理员权限】运行，普通启动器无法自动关闭它。' -ForegroundColor Yellow
        Write-Host '  请先右键右下角系统托盘 Antigravity 图标点击【退出】（或右键本启动器选择【以管理员身份运行】）。' -ForegroundColor White
        $ansElev = Read-Host '确认已彻底退出后按回车立即重新启动（输入 q 取消）'
        if ($ansElev -match '^[Qq]$') {
            Write-Host '已取消启动。' -ForegroundColor Gray
            Pause-IfDirect
            exit 0
        }
        for ($i = 0; $i -lt 16; $i++) {
            $procInfo = Get-AntigravityProcessInfo
            if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
            Start-Sleep -Milliseconds 500
        }
        if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
            Write-Host '[错误] 仍检测到无调试端口的 Antigravity 在运行，已中止以避免参数被吞。' -ForegroundColor Red
            Pause-IfDirect -IsError
            exit 5
        }
    } else {
        Write-Host '  请选择操作：' -ForegroundColor Cyan
        Write-Host '    [1] 一键安全重启 Antigravity 并开启底部监控调试端口（推荐，直接回车）' -ForegroundColor Green
        Write-Host '    [2] 我自己从右下角系统托盘退出后再继续启动' -ForegroundColor White
        Write-Host '    [3] 取消' -ForegroundColor Gray
        $choice = Read-Host '请输入选项 [1/2/3]（直接回车默认选 1）'
        if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim() -eq '1') {
            $stopRes = Stop-AntigravityGracefully
            if ($stopRes -eq 'access_denied') {
                Write-Host '[错误] 权限不足，无法自动关闭现有 Antigravity。请右键系统托盘退出，或右键本脚本选择【以管理员身份运行】。' -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 5
            } elseif ($stopRes -ne 'stopped') {
                Write-Host '[错误] 等待旧实例退出超时，请先手动从托盘退出后重试。' -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 5
            }
            Write-Host '      旧实例已彻底关闭。' -ForegroundColor Green
        } elseif ($choice.Trim() -eq '2') {
            Read-Host '请右键右下角托盘 Antigravity 图标点击【退出】，确认彻底退出后按回车继续' | Out-Null
            for ($i = 0; $i -lt 16; $i++) {
                $procInfo = Get-AntigravityProcessInfo
                if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
                Start-Sleep -Milliseconds 500
            }
            if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
                Write-Host '[错误] 仍检测到旧实例在运行，已中止以避免 --remote-debugging-port=0 被单实例锁吞掉。' -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 5
            }
        } else {
            Write-Host '已取消启动。' -ForegroundColor Gray
            Pause-IfDirect
            exit 0
        }
    }
}

$finalArgs = @($preservedArgs) + @('--remote-debugging-port=0')
$argLine = ($finalArgs -join ' ')
$workDir = Split-Path -Parent $exe

Write-Host "[启动] 正在启动: $exe $argLine" -ForegroundColor Cyan
Start-Process -FilePath $exe -ArgumentList $argLine -WorkingDirectory $workDir

if ($NoWaitReady -or $IsSandbox) {
    exit 0
}

Write-Host '[校验] 正在等待本地 DevToolsActivePort 调试端口就绪（最长 18 秒）...' -ForegroundColor Gray
$portProbe = $null
for ($w = 0; $w -lt 36; $w++) {
    Start-Sleep -Milliseconds 500
    $portProbe = Test-ActiveDevToolsPort $profileCands
    if ($portProbe.Ready) { break }
}

if ($portProbe -and $portProbe.Ready) {
    Write-Host ''
    Write-Host ("[成功] Antigravity 已启动且本地调试端口已就绪 (port=$($portProbe.Port), pages=$($portProbe.PageCount))！") -ForegroundColor Green
    Write-Host '       进入任意对话后，聊天框底部透明状态条将自动挂载显示。' -ForegroundColor Green
    if (-not $NonInteractive) {
        Start-Sleep -Milliseconds 2200
    }
    exit 0
}

Write-Host ''
$afterInfo = $null
try { $afterInfo = Get-AntigravityProcessInfo } catch {}
if ($afterInfo -and $afterInfo.GuiProcs.Count -gt 0 -and (-not $afterInfo.HasDebugPort)) {
    Write-Host '[警告] 启动后检测到运行中的 Antigravity 仍未携带 --remote-debugging-port 参数（可能被后台残留实例接管）。' -ForegroundColor Red
    Write-Host '       请彻底退出托盘所有 Antigravity 实例后再重新双击本启动器。' -ForegroundColor Yellow
} else {
    Write-Host '[警告] 18 秒内尚未探测到可达的 DevToolsActivePort 调试端口（可能客户端仍在冷启动或使用了自定义数据目录）。' -ForegroundColor Yellow
    Write-Host '       请待主界面完全打开后，双击「一键诊断内嵌状态(Windows).bat」核验状态或一键修复。' -ForegroundColor Cyan
}
Pause-IfDirect -IsError
exit 6
