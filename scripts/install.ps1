param(
    [switch]$NonInteractive,
    [switch]$EnableInline,
    [switch]$DisableInline,
    [switch]$DisableLegacyPulse,
    [switch]$KeepLegacyPulse,
    [switch]$AutoRestart,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
try {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::InputEncoding = [System.Text.Encoding]::UTF8
} catch {}
$OutputEncoding = [System.Text.Encoding]::UTF8

$RootDir = Split-Path -Parent $PSScriptRoot
$SrcPlugin = Join-Path $RootDir 'antigravity-token-meter'
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

function Read-PluginVersion([string]$PluginRoot) {
    $fallback = '1.2.16'
    $pj = Join-Path $PluginRoot 'plugin.json'
    if (-not (Test-Path -LiteralPath $pj -PathType Leaf)) { return $fallback }
    try {
        $raw = [System.IO.File]::ReadAllText($pj, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $obj = $raw | ConvertFrom-Json
        if ($obj -is [PSCustomObject] -and $obj.version -is [string] -and -not [string]::IsNullOrWhiteSpace($obj.version)) {
            return $obj.version.Trim()
        }
    } catch {}
    return $fallback
}

$Version = Read-PluginVersion $SrcPlugin
try { $Host.UI.RawUI.WindowTitle = "Antigravity TokenMeter v$Version 安装器" } catch {}

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host "  Antigravity TokenMeter v$Version (MIT License)" -ForegroundColor Cyan
Write-Host '  侧边栏面板 + 聊天框底部透明状态条（零外部依赖，不修改 app.asar）' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host ''

# 1. 前置完整性检查（任何写入之前，防范未完整解压 ZIP 直接双击）
$RequiredFiles = @(
    (Join-Path $SrcPlugin 'plugin.json'),
    (Join-Path $SrcPlugin 'LICENSE'),
    (Join-Path $SrcPlugin 'assets\logo.svg'),
    (Join-Path $SrcPlugin 'sidecars\meter\sidecar.json'),
    (Join-Path $SrcPlugin 'sidecars\meter\main.mjs')
)
foreach ($req in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath $req -PathType Leaf)) {
        Write-Host ('[错误] 安装包不完整，缺少文件: ' + $req) -ForegroundColor Red
        Write-Host '请先右键压缩包选择【全部解压缩】，完整解压到常规文件夹后再运行安装器。' -ForegroundColor Yellow
        Pause-IfDirect -IsError
        exit 1
    }
}

# 2. 解析目标用户目录（兼容真实环境与沙箱隔离测试）
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

$DstPluginsRoot = Join-Path $HomeDir '.gemini\config\plugins'
$DstPlugin = Join-Path $DstPluginsRoot 'antigravity-token-meter'
$ConfigDir = Join-Path $LocalDir 'AntigravityTokenMeter'
$ConfigBackupsDir = Join-Path $ConfigDir 'config-backups'
$ConfigJsonFile = Join-Path $HomeDir '.gemini\config\config.json'
$SettingsFile = Join-Path $ConfigDir 'settings.json'

function Ensure-Directory([string]$DirPath) {
    if (-not [string]::IsNullOrWhiteSpace($DirPath)) {
        [System.IO.Directory]::CreateDirectory($DirPath) | Out-Null
    }
}

function Write-AtomicUtf8([string]$TargetPath, [string]$Content) {
    $parent = Split-Path -Parent $TargetPath
    Ensure-Directory $parent
    $tmp = Join-Path $parent ('.tm-tmp-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    try {
        [System.IO.File]::WriteAllText($tmp, $Content, $Utf8NoBom)
        if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
            try {
                [System.IO.File]::Replace($tmp, $TargetPath, [NullString]::Value, $true)
            } catch {
                [System.IO.File]::Copy($tmp, $TargetPath, $true)
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            }
        } else {
            [System.IO.File]::Move($tmp, $TargetPath)
        }
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
}

function Copy-TreeLiteral([string]$SourceDir, [string]$DestDir) {
    Ensure-Directory $DestDir
    foreach ($file in [System.IO.Directory]::GetFiles($SourceDir)) {
        $name = [System.IO.Path]::GetFileName($file)
        [System.IO.File]::Copy($file, (Join-Path $DestDir $name), $true)
    }
    foreach ($sub in [System.IO.Directory]::GetDirectories($SourceDir)) {
        $name = [System.IO.Path]::GetFileName($sub)
        Copy-TreeLiteral $sub (Join-Path $DestDir $name)
    }
}

function Sync-SubTreeClean([string]$SourceDir, [string]$DestDir) {
    Copy-TreeLiteral $SourceDir $DestDir
    # 清理旧版本残余且当前版本已移除的陈旧文件（忽略锁占用）
    foreach ($dstFile in [System.IO.Directory]::GetFiles($DestDir)) {
        $name = [System.IO.Path]::GetFileName($dstFile)
        if (-not [System.IO.File]::Exists((Join-Path $SourceDir $name))) {
            try { [System.IO.File]::Delete($dstFile) } catch {}
        }
    }
    foreach ($dstSub in [System.IO.Directory]::GetDirectories($DestDir)) {
        $name = [System.IO.Path]::GetFileName($dstSub)
        $srcSub = Join-Path $SourceDir $name
        if (-not [System.IO.Directory]::Exists($srcSub)) {
            try { Remove-Item -LiteralPath $dstSub -Recurse -Force -ErrorAction SilentlyContinue } catch {}
        } else {
            Sync-SubTreeClean $srcSub $dstSub
        }
    }
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
    if ($PreferredPath) { $candidates += $PreferredPath }
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

    # 1. Windows 卸载注册表与 App Paths
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
    Write-Host '      正在优雅关闭运行中的 Antigravity（含托盘实例）...' -ForegroundColor Cyan
    $accessDenied = $false

    # 第 1 阶段：向带窗口的 Antigravity 主进程发送 WM_CLOSE
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

    # 第 2 阶段：Electron 默认将关闭窗口拦截至系统托盘，已获用户明确授权，安全结束 Antigravity.exe 进程组
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
            $req.Timeout = 1800
            $resp = $req.GetResponse()
            $code = [int]$resp.StatusCode
            $resp.Close()
            if ($code -eq 200) {
                return [PSCustomObject]@{ Ready = $true; Port = [int]$portStr; PortFile = $pf }
            }
        } catch {}
    }
    return [PSCustomObject]@{ Ready = $false; Port = $null; PortFile = $null }
}

function Try-RestoreLatestValidConfigBackup([string]$BackupDir) {
    if (-not (Test-Path -LiteralPath $BackupDir -PathType Container)) { return $null }
    $candidates = @(Get-ChildItem -LiteralPath $BackupDir -Filter 'config-*.json' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notlike 'config-corrupt-*' } |
        Sort-Object LastWriteTimeUtc -Descending)
    foreach ($f in $candidates) {
        try {
            $raw = [System.IO.File]::ReadAllText($f.FullName, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            if ([string]::IsNullOrWhiteSpace($raw)) { continue }
            $obj = $raw | ConvertFrom-Json
            if ($obj -is [PSCustomObject] -and -not ($obj -is [System.Array])) {
                return [PSCustomObject]@{ Object = $obj; BackupFile = $f.FullName }
            }
        } catch {}
    }
    return $null
}

# ==============================================================================
# [1/4] 检查运行中的 Antigravity（根治“装完不热启动 / 托盘实例覆盖配置”）
# ==============================================================================
Write-Host '[1/4] 正在检查 Antigravity 运行状态...' -ForegroundColor White
$procInfo = $null
try {
    $procInfo = Get-AntigravityProcessInfo
} catch {
    Write-Host '[错误] 无法检查 Antigravity 进程状态，已中止安装以保护原配置。' -ForegroundColor Red
    Pause-IfDirect -IsError
    exit 2
}

$savedExePath = $procInfo.ExecutablePath
$savedExtraArgs = @(Get-PreservedLaunchArgs $procInfo.MainCommandLine)
$shouldAutoRelaunch = $false
$isRunning = ($procInfo.GuiProcs.Count -gt 0) -or $procInfo.ElevatedUnknown

if ($isRunning) {
    if ($NonInteractive) {
        if ($AutoRestart) {
            $stopRes = Stop-AntigravityGracefully
            if ($stopRes -ne 'stopped') {
                Write-Host "[错误] 自动关闭运行中的 Antigravity 失败 ($stopRes)，请先手动彻底退出客户端后再安装。" -ForegroundColor Red
                exit 3
            }
            $shouldAutoRelaunch = $true
            Write-Host '      已安全关闭运行中的 Antigravity，安装完成后将自动重启。' -ForegroundColor Green
        } else {
            Write-Host '[错误] 检测到 Antigravity 主界面正在运行（可能驻留在系统托盘）。' -ForegroundColor Red
            Write-Host '       Antigravity 退出时会用旧内存覆盖 config.json 且无法热启动。请先彻底退出客户端，或传入 -AutoRestart 自动关闭并重启。' -ForegroundColor Yellow
            exit 3
        }
    } else {
        Write-Host ''
        Write-Host '  [重要提示] 检测到 Antigravity 正在运行（关闭窗口默认会隐藏到右下角系统托盘）。' -ForegroundColor Yellow
        Write-Host '  如果在运行中直接写入 config.json，客户端退出时会把旧配置覆盖回去，导致装完不生效！' -ForegroundColor Yellow
        Write-Host ''
        if ($procInfo.ElevatedUnknown) {
            Write-Host '  检测到当前 Antigravity 正以【管理员权限】运行，普通安装窗口无法自动关闭它。' -ForegroundColor Yellow
            Write-Host '  请先右键右下角系统托盘 Antigravity 图标点击【退出】（或右键本安装脚本以管理员身份运行）。' -ForegroundColor White
            Write-Host ''
            $ansElev = Read-Host '确认已彻底退出 Antigravity 后按回车继续（输入 q 取消）'
            if ($ansElev -match '^[Qq]$') {
                Write-Host '已取消安装（未修改任何文件）。' -ForegroundColor Gray
                Pause-IfDirect
                exit 0
            }
            for ($i = 0; $i -lt 16; $i++) {
                $procInfo = Get-AntigravityProcessInfo
                if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
                Start-Sleep -Milliseconds 500
            }
            if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
                Write-Host '[错误] 仍检测到 Antigravity 正在运行，安装已安全中止（未修改任何文件）。' -ForegroundColor Red
                Pause-IfDirect -IsError
                exit 3
            }
        } else {
            Write-Host '  请选择处理方式：' -ForegroundColor Cyan
            Write-Host '    [1] 一键自动关闭 Antigravity -> 写入配置 -> 自动重启生效（推荐，直接回车）' -ForegroundColor Green
            Write-Host '    [2] 我自己从右下角系统托盘退出后再继续安装' -ForegroundColor White
            Write-Host '    [3] 取消安装' -ForegroundColor Gray
            $choice = Read-Host '请输入选项 [1/2/3]（直接回车默认选 1）'
            if ([string]::IsNullOrWhiteSpace($choice) -or $choice.Trim() -eq '1') {
                $stopRes = Stop-AntigravityGracefully
                if ($stopRes -eq 'access_denied') {
                    Write-Host '[错误] 权限不足，无法自动关闭 Antigravity（可能以管理员身份运行）。请右键托盘退出，或右键本脚本选择【以管理员身份运行】。' -ForegroundColor Red
                    Pause-IfDirect -IsError
                    exit 3
                } elseif ($stopRes -ne 'stopped') {
                    Write-Host '[错误] 等待 Antigravity 退出超时，安装已安全中止（未修改任何文件）。请手动从托盘退出后重试。' -ForegroundColor Red
                    Pause-IfDirect -IsError
                    exit 3
                }
                $shouldAutoRelaunch = $true
                Write-Host '      已彻底关闭旧实例，安装完成后将自动为您重启 Antigravity！' -ForegroundColor Green
            } elseif ($choice.Trim() -eq '2') {
                Read-Host '请从菜单或右键右下角托盘点击【退出】，确认彻底退出后按回车继续' | Out-Null
                for ($i = 0; $i -lt 16; $i++) {
                    $procInfo = Get-AntigravityProcessInfo
                    if ($procInfo.GuiProcs.Count -eq 0 -and (-not $procInfo.ElevatedUnknown)) { break }
                    Start-Sleep -Milliseconds 500
                }
                if ($procInfo.GuiProcs.Count -gt 0 -or $procInfo.ElevatedUnknown) {
                    Write-Host '[错误] 仍检测到 Antigravity 正在运行，安装已安全中止（未修改任何文件）。' -ForegroundColor Red
                    Pause-IfDirect -IsError
                    exit 3
                }
            } else {
                Write-Host '已取消安装（未修改任何文件）。' -ForegroundColor Gray
                Pause-IfDirect
                exit 0
            }
        }
    }
} else {
    Write-Host '      已确认 Antigravity 主界面未运行。' -ForegroundColor Green
}

# ==============================================================================
# [2/4] 校验、修复并构建宿主 config.json（完全遵循 Antigravity 2.33+/2.34+ 规范）
# ==============================================================================
Write-Host '[2/4] 正在校验并合并宿主 config.json（启用插件与 sidecar）...' -ForegroundColor White
Ensure-Directory $ConfigBackupsDir
$cfg = [ordered]@{}
$cfgWasCorrupt = $false
$cfgCorruptBackup = $null

if (Test-Path -LiteralPath $ConfigJsonFile -PathType Leaf) {
    $rawCfg = ''
    $parsed = $null
    try {
        $rawCfg = [System.IO.File]::ReadAllText($ConfigJsonFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        if (-not [string]::IsNullOrWhiteSpace($rawCfg)) {
            $parsed = $rawCfg | ConvertFrom-Json
        }
    } catch {
        $parsed = $null
    }

    if ($null -eq $parsed -or ($parsed -is [System.Array]) -or (-not ($parsed -is [PSCustomObject]))) {
        $cfgWasCorrupt = $true
        $randTag = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $cfgCorruptBackup = Join-Path $ConfigBackupsDir ('config-corrupt-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randTag + '.json')
        [System.IO.File]::Copy($ConfigJsonFile, $cfgCorruptBackup, $true)
        Write-Host ('      [自愈] 检测到现有 config.json 为空或语法损坏，已完整备份原文件至: ' + $cfgCorruptBackup) -ForegroundColor Yellow

        $restored = Try-RestoreLatestValidConfigBackup $ConfigBackupsDir
        if ($null -ne $restored) {
            foreach ($p in $restored.Object.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
            Write-Host ('      [自愈] 已从最近有效历史备份自动恢复原配置: ' + $restored.BackupFile) -ForegroundColor Green
        } else {
            Write-Host '      [自愈] 未找到历史有效备份，将基于干净模板安全重建 config.json。' -ForegroundColor Yellow
        }
    } else {
        foreach ($p in $parsed.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
    }
}

# 合并 plugins["antigravity-token-meter"]（保留已有字段，异常类型自动备份重建）
$pluginsMap = [ordered]@{}
if ($cfg.Contains('plugins') -and $null -ne $cfg['plugins']) {
    if ($cfg['plugins'] -is [PSCustomObject] -and -not ($cfg['plugins'] -is [System.Array])) {
        foreach ($p in $cfg['plugins'].PSObject.Properties) { $pluginsMap[$p.Name] = $p.Value }
    } else {
        Write-Host '      [自愈] config.json 中 plugins 字段类型异常，已自动修复为对象结构。' -ForegroundColor Yellow
    }
}
$pluginEntry = [ordered]@{}
if ($pluginsMap.Contains('antigravity-token-meter') -and $null -ne $pluginsMap['antigravity-token-meter']) {
    if ($pluginsMap['antigravity-token-meter'] -is [PSCustomObject] -and -not ($pluginsMap['antigravity-token-meter'] -is [System.Array])) {
        foreach ($p in $pluginsMap['antigravity-token-meter'].PSObject.Properties) { $pluginEntry[$p.Name] = $p.Value }
    }
}
$pluginEntry['enabled'] = $true
$pluginsMap['antigravity-token-meter'] = $pluginEntry

# 合并 sidecars["antigravity-token-meter/meter"]
# 规范：enabled=true、缺失补 schemaVersion=1 与 resolvedPermissions={}；
# 保留已有 projectId 与所有其他字段，但严禁伪造随机 projectId UUID（由宿主首次启动自动生成）！
$sidecarsMap = [ordered]@{}
if ($cfg.Contains('sidecars') -and $null -ne $cfg['sidecars']) {
    if ($cfg['sidecars'] -is [PSCustomObject] -and -not ($cfg['sidecars'] -is [System.Array])) {
        foreach ($p in $cfg['sidecars'].PSObject.Properties) { $sidecarsMap[$p.Name] = $p.Value }
    } else {
        Write-Host '      [自愈] config.json 中 sidecars 字段类型异常，已自动修复为对象结构。' -ForegroundColor Yellow
    }
}
$scEntry = [ordered]@{}
if ($sidecarsMap.Contains('antigravity-token-meter/meter') -and $null -ne $sidecarsMap['antigravity-token-meter/meter']) {
    if ($sidecarsMap['antigravity-token-meter/meter'] -is [PSCustomObject] -and -not ($sidecarsMap['antigravity-token-meter/meter'] -is [System.Array])) {
        foreach ($p in $sidecarsMap['antigravity-token-meter/meter'].PSObject.Properties) { $scEntry[$p.Name] = $p.Value }
    }
}
$scEntry['enabled'] = $true
if (-not $scEntry.Contains('resolvedPermissions') -or $null -eq $scEntry['resolvedPermissions'] -or ($scEntry['resolvedPermissions'] -is [System.Array]) -or (-not ($scEntry['resolvedPermissions'] -is [PSCustomObject] -or $scEntry['resolvedPermissions'] -is [System.Collections.IDictionary]))) {
    $scEntry['resolvedPermissions'] = [ordered]@{}
}
if (-not $scEntry.Contains('schemaVersion') -or $null -eq $scEntry['schemaVersion']) {
    $scEntry['schemaVersion'] = 1
}
$sidecarsMap['antigravity-token-meter/meter'] = $scEntry

# 检测旧版 antigravity-pulse 冲突残留（plugins、sidecars 与旧目录）
$legacyPulsePluginExists = $pluginsMap.Contains('antigravity-pulse')
$legacyPulseSidecarKeys = @($sidecarsMap.Keys | Where-Object { $_ -like 'antigravity-pulse/*' -or $_ -eq 'antigravity-pulse' })
$legacyPulseDirExists = Test-Path -LiteralPath (Join-Path $DstPluginsRoot 'antigravity-pulse') -PathType Container
$legacyPulseEnabled = $false
if ($legacyPulsePluginExists -and ($pluginsMap['antigravity-pulse'] -is [PSCustomObject]) -and ($pluginsMap['antigravity-pulse'].enabled -ne $false)) {
    $legacyPulseEnabled = $true
}
foreach ($sk in $legacyPulseSidecarKeys) {
    if (($sidecarsMap[$sk] -is [PSCustomObject]) -and ($sidecarsMap[$sk].enabled -ne $false)) {
        $legacyPulseEnabled = $true
    }
}

$legacyPulseAlreadyDisabled = $legacyPulsePluginExists -and ($pluginsMap['antigravity-pulse'] -is [PSCustomObject]) -and ($pluginsMap['antigravity-pulse'].enabled -eq $false) -and (-not $legacyPulseEnabled)
$legacyPulseConflict = $legacyPulseEnabled -or ($legacyPulseDirExists -and (-not $legacyPulseAlreadyDisabled))

if ($legacyPulseConflict -or ($legacyPulsePluginExists -and $DisableLegacyPulse)) {
    $shouldDisableOld = $false
    if ($DisableLegacyPulse) {
        $shouldDisableOld = $true
    } elseif ($KeepLegacyPulse) {
        $shouldDisableOld = $false
    } elseif (-not $NonInteractive -and $legacyPulseConflict) {
        Write-Host ''
        Write-Host '  [冲突检测] 检测到旧版 antigravity-pulse 插件残留，同时开启会导致底部状态条重影或抢占挂载！' -ForegroundColor Yellow
        $ansOld = Read-Host '是否自动停用旧版 antigravity-pulse？(Y/n，直接回车默认停用)'
        if ([string]::IsNullOrWhiteSpace($ansOld) -or $ansOld -match '^[Yy]$') {
            $shouldDisableOld = $true
        }
    } elseif ($NonInteractive -and $legacyPulseConflict) {
        Write-Host '      [警告] 检测到旧版 antigravity-pulse 仍处于启用或未停用状态，可能造成底部条重影。建议传入 -DisableLegacyPulse 或运行 doctor.ps1 -Fix 一键停用。' -ForegroundColor Yellow
    }

    if ($shouldDisableOld) {
        $oldPluginEntry = [ordered]@{}
        if ($legacyPulsePluginExists -and ($pluginsMap['antigravity-pulse'] -is [PSCustomObject])) {
            foreach ($p in $pluginsMap['antigravity-pulse'].PSObject.Properties) { $oldPluginEntry[$p.Name] = $p.Value }
        }
        $oldPluginEntry['enabled'] = $false
        $pluginsMap['antigravity-pulse'] = $oldPluginEntry
        foreach ($sk in $legacyPulseSidecarKeys) {
            $oldSc = [ordered]@{}
            if ($sidecarsMap[$sk] -is [PSCustomObject]) {
                foreach ($p in $sidecarsMap[$sk].PSObject.Properties) { $oldSc[$p.Name] = $p.Value }
            }
            $oldSc['enabled'] = $false
            $sidecarsMap[$sk] = $oldSc
        }
        Write-Host '      已停用旧版 antigravity-pulse（含其 sidecar），避免底部状态条重影冲突。' -ForegroundColor Green
    }
}

$cfg['plugins'] = $pluginsMap
$cfg['sidecars'] = $sidecarsMap

# ==============================================================================
# 模式选择：默认启用完整体验（侧边栏 + 底部内嵌状态条 inline=true），保留纯侧边栏选项
# ==============================================================================
$existingInline = $null
$settingsWasCorrupt = $false
$existingSettingsObj = [ordered]@{}
if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
    try {
        $rawSet = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $prevSet = $rawSet | ConvertFrom-Json
        if ($prevSet -is [PSCustomObject] -and -not ($prevSet -is [System.Array])) {
            $inlineProp = $prevSet.PSObject.Properties['inline']
            $enabledProp = $prevSet.PSObject.Properties['enabled']
            if ($null -ne $inlineProp -and (-not ($inlineProp.Value -is [bool]))) {
                $settingsWasCorrupt = $true
            }
            if ($null -ne $enabledProp -and (-not ($enabledProp.Value -is [bool]))) {
                $settingsWasCorrupt = $true
            }
            if (-not $settingsWasCorrupt) {
                foreach ($p in $prevSet.PSObject.Properties) { $existingSettingsObj[$p.Name] = $p.Value }
                if ($null -ne $inlineProp) { $existingInline = [bool]$inlineProp.Value }
            } elseif ($prevSet.profile -is [string] -and -not [string]::IsNullOrWhiteSpace($prevSet.profile)) {
                $existingSettingsObj['profile'] = $prevSet.profile.Trim()
            }
        } else {
            $settingsWasCorrupt = $true
        }
    } catch {
        $settingsWasCorrupt = $true
    }
}
if ($settingsWasCorrupt) {
    $randSet = [guid]::NewGuid().ToString('N').Substring(0, 8)
    $setBak = Join-Path $ConfigBackupsDir ('settings-corrupt-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randSet + '.json')
    [System.IO.File]::Copy($SettingsFile, $setBak, $true)
    Write-Host ('      [自愈] 检测到本地 settings.json 损坏或字段类型非法，已备份至 ' + $setBak + ' 并将自动重置。') -ForegroundColor Yellow
}

$inlineEnabled = if ($EnableInline) {
    $true
} elseif ($DisableInline) {
    $false
} elseif ($NonInteractive) {
    if ($null -ne $existingInline) { $existingInline } else { $true }
} else {
    $true
}

if (-not $EnableInline -and -not $DisableInline -and -not $NonInteractive) {
    Write-Host ''
    Write-Host '  [界面模式选择] TokenMeter 提供两种模式：' -ForegroundColor Cyan
    Write-Host '    [1] 完整体验：侧边栏面板 + 聊天框底部透明状态条（默认推荐，直接回车）' -ForegroundColor Green
    Write-Host '        （通过专用启动器带 --remote-debugging-port=0 启动，仅监听本机回环，不修改 app.asar）' -ForegroundColor Gray
    Write-Host '    [2] 纯侧边栏面板：零额外启动参数，仅在右侧边栏查看用量与配额' -ForegroundColor White
    $modeAns = Read-Host '请选择安装模式 [1/2]（直接回车默认选 1 完整体验）'
    if ($modeAns -match '^(2|[Nn])$') {
        $inlineEnabled = $false
    } else {
        $inlineEnabled = $true
    }
}

# ==============================================================================
# [3/4] 部署插件文件（原位备份 + LiteralPath 同步 + 失败回滚）
# ==============================================================================
Write-Host '[3/4] 正在部署 TokenMeter 插件文件（含 MIT LICENSE）...' -ForegroundColor White
Ensure-Directory $DstPluginsRoot
$oldBackupDir = $null
try {
    # 先清理插件根目录与历史嵌套残留的异常中断备份目录
    Get-ChildItem -LiteralPath $DstPluginsRoot -Directory -Filter '.antigravity-token-meter-prev-*' -ErrorAction SilentlyContinue | ForEach-Object {
        Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $DstPlugin -PathType Container) {
        Get-ChildItem -LiteralPath $DstPlugin -Directory -Filter '.antigravity-token-meter-prev-*' -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        $oldBackupDir = Join-Path $DstPluginsRoot ('.antigravity-token-meter-prev-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6))
        Ensure-Directory $oldBackupDir
        foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
            $oldItem = Join-Path $DstPlugin $item
            if (Test-Path -LiteralPath $oldItem -PathType Container) {
                Copy-TreeLiteral $oldItem (Join-Path $oldBackupDir $item)
            } elseif (Test-Path -LiteralPath $oldItem -PathType Leaf) {
                [System.IO.File]::Copy($oldItem, (Join-Path $oldBackupDir $item), $true)
            }
        }
    } else {
        Ensure-Directory $DstPlugin
    }

    foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
        $srcItem = Join-Path $SrcPlugin $item
        if (Test-Path -LiteralPath $srcItem -PathType Container) {
            Sync-SubTreeClean $srcItem (Join-Path $DstPlugin $item)
        } else {
            [System.IO.File]::Copy($srcItem, (Join-Path $DstPlugin $item), $true)
        }
    }

    foreach ($verifyRel in @('plugin.json', 'LICENSE', 'assets\logo.svg', 'sidecars\meter\sidecar.json', 'sidecars\meter\main.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $DstPlugin $verifyRel) -PathType Leaf)) {
            throw ("插件目标目录校验失败，缺少关键文件: $verifyRel")
        }
    }
    Write-Host ('      已安装至: ' + $DstPlugin) -ForegroundColor Green

    # ==========================================================================
    # [4/4] 写入本地偏好并原子提交宿主 config.json
    # ==========================================================================
    Write-Host '[4/4] 正在写入本地配置并原子提交宿主 config.json...' -ForegroundColor White
    Ensure-Directory $ConfigDir
    $existingSettingsObj['enabled'] = $true
    $existingSettingsObj['inline'] = [bool]$inlineEnabled
    Write-AtomicUtf8 $SettingsFile (($existingSettingsObj | ConvertTo-Json -Depth 20) + "`n")

    $PrefsFile = Join-Path $ConfigDir 'preferences.json'
    if (-not (Test-Path -LiteralPath $PrefsFile -PathType Leaf)) {
        $initLang = 'zh-CN'
        if ($env:AG_TM_LANG -eq 'en') {
            $initLang = 'en'
        } elseif ($env:AG_TM_LANG -match '^(?i)zh') {
            $initLang = 'zh-CN'
        } else {
            $uiCultureName = ''
            try { $uiCultureName = [System.Globalization.CultureInfo]::InstalledUICulture.Name } catch {}
            if (-not $uiCultureName) { try { $uiCultureName = (Get-UICulture).Name } catch {} }
            if ($uiCultureName -and ($uiCultureName -notmatch '^(?i)zh')) {
                $initLang = 'en'
            }
        }
        $prefsJson = "{`n  `"language`": `"$initLang`",`n  `"theme`": `"swiss`",`n  `"showSpeed`": true,`n  `"showCache`": true,`n  `"showContext`": true,`n  `"showQuota`": true,`n  `"showToday`": false,`n  `"showMonth`": true,`n  `"showCost`": false,`n  `"version`": 1`n}`n"
        Write-AtomicUtf8 $PrefsFile $prefsJson
    }

    if ((Test-Path -LiteralPath $ConfigJsonFile -PathType Leaf) -and (-not $cfgWasCorrupt)) {
        $randTag = [guid]::NewGuid().ToString('N').Substring(0, 8)
        $cfgBak = Join-Path $ConfigBackupsDir ('config-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randTag + '.json')
        [System.IO.File]::Copy($ConfigJsonFile, $cfgBak, $true)
    }
    Write-AtomicUtf8 $ConfigJsonFile (($cfg | ConvertTo-Json -Depth 100) + "`n")

    if ($oldBackupDir -and (Test-Path -LiteralPath $oldBackupDir)) {
        Remove-Item -LiteralPath $oldBackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
    if ($oldBackupDir -and (Test-Path -LiteralPath $oldBackupDir)) {
        Ensure-Directory $DstPlugin
        foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
            $bakItem = Join-Path $oldBackupDir $item
            if (Test-Path -LiteralPath $bakItem -PathType Container) {
                try { Copy-TreeLiteral $bakItem (Join-Path $DstPlugin $item) } catch {}
            } elseif (Test-Path -LiteralPath $bakItem -PathType Leaf) {
                try { [System.IO.File]::Copy($bakItem, (Join-Path $DstPlugin $item), $true) } catch {}
            }
        }
        Remove-Item -LiteralPath $oldBackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-Host ('[错误] 安装过程发生异常，已自动回滚: ' + $_.Exception.Message) -ForegroundColor Red
    Pause-IfDirect -IsError
    exit 1
}

Write-Host '      已在 config.json 中完整注册 plugin 与 sidecar（含 schemaVersion / resolvedPermissions）！' -ForegroundColor Green
Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host "  Antigravity TokenMeter v$Version 安装完成！" -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host ''

# ==============================================================================
# 可选一键启动 / 自动重启 Antigravity 并核验本地调试端口就绪
# ==============================================================================
$launchRequested = $false
if (-not $IsSandbox -and -not $NoLaunch) {
    if ($shouldAutoRelaunch) {
        $launchRequested = $true
    } elseif (-not $NonInteractive) {
        $exeProbe = Find-AntigravityExe $savedExePath
        if ($exeProbe) {
            $savedExePath = $exeProbe
            $launchHint = if ($inlineEnabled) {
                '是否立即启动 Antigravity（携带 --remote-debugging-port=0 直接生效底部状态条）？(Y/n，直接回车立即启动)'
            } else {
                '是否立即启动 Antigravity 打开侧边栏 TokenMeter？(Y/n，直接回车立即启动)'
            }
            $launchAns = Read-Host $launchHint
            if ([string]::IsNullOrWhiteSpace($launchAns) -or $launchAns -match '^[Yy]$') {
                $launchRequested = $true
            }
        }
    }
}

$launchedAndReady = $false
if ($launchRequested) {
    $exeToRun = Find-AntigravityExe $savedExePath
    if (-not $exeToRun) {
        Write-Host '[提示] 未自动找到 Antigravity.exe，请手动双击「启动Antigravity(带Token监控).bat」启动客户端。' -ForegroundColor Yellow
    } else {
        $finalArgs = @($savedExtraArgs)
        if ($inlineEnabled) { $finalArgs += '--remote-debugging-port=0' }
        $workDir = Split-Path -Parent $exeToRun
        Write-Host ''
        if ($finalArgs.Count -gt 0) {
            $argLine = ($finalArgs -join ' ')
            Write-Host ("[启动] 正在启动 Antigravity: $exeToRun $argLine") -ForegroundColor Cyan
            Start-Process -FilePath $exeToRun -ArgumentList $argLine -WorkingDirectory $workDir
        } else {
            Write-Host ("[启动] 正在启动 Antigravity: $exeToRun") -ForegroundColor Cyan
            Start-Process -FilePath $exeToRun -WorkingDirectory $workDir
        }

        if ($inlineEnabled) {
            Write-Host '      正在等待本地调试端口就绪（最长 18 秒）...' -ForegroundColor Gray
            $profileCands = @()
            foreach ($envProf in @($env:AG_TM_PROFILE, $env:ANTIGRAVITY_USER_DATA_DIR, $env:ELECTRON_USER_DATA_DIR)) {
                if ($envProf -and -not [string]::IsNullOrWhiteSpace($envProf)) { $profileCands += $envProf.Trim() }
            }
            if ($existingSettingsObj.Contains('profile') -and $existingSettingsObj['profile'] -is [string] -and -not [string]::IsNullOrWhiteSpace($existingSettingsObj['profile'])) {
                $profileCands += $existingSettingsObj['profile'].Trim()
            }
            $profileCands += (Join-Path $AppDataDir 'Antigravity')
            $profileCands += (Join-Path $AppDataDir 'Antigravity - Insiders')
            $profileCands += (Join-Path $AppDataDir 'Antigravity Insiders')
            $profileCands = @($profileCands | Select-Object -Unique)

            $portProbe = $null
            for ($w = 0; $w -lt 36; $w++) {
                Start-Sleep -Milliseconds 500
                $portProbe = Test-ActiveDevToolsPort $profileCands
                if ($portProbe.Ready) { break }
            }
            if ($portProbe -and $portProbe.Ready) {
                $launchedAndReady = $true
                Write-Host ("      [成功] Antigravity 已启动且本地调试端口就绪 (port=$($portProbe.Port))！") -ForegroundColor Green
                Write-Host '      打开任意对话后，聊天框底部透明状态条与右侧边栏 TokenMeter 将自动出现。' -ForegroundColor Green
            } else {
                Write-Host '      [提示] Antigravity 正在启动中，暂未探测到调试端口。进入主界面后可双击「一键诊断内嵌状态(Windows).bat」核验。' -ForegroundColor Yellow
            }
        } else {
            $launchedAndReady = $true
            Write-Host '      [成功] Antigravity 已启动，进入主界面即可在右侧边栏打开 TokenMeter！' -ForegroundColor Green
        }
    }
}

Write-Host ''
if ($inlineEnabled) {
    Write-Host '  日常使用提示：' -ForegroundColor Cyan
    Write-Host '  - 下次打开 Antigravity 时，请双击本目录的「启动Antigravity(带Token监控).bat」以保持底部状态条生效；' -ForegroundColor Yellow
    Write-Host '  - 若平时用自定义代理/汉化脚本启动，只需在该脚本的 Antigravity.exe 命令行末尾加上 --remote-debugging-port=0；' -ForegroundColor Gray
    Write-Host '  - 遇到任何显示或连接问题，双击「一键诊断内嵌状态(Windows).bat」即可自动排查与一键修复。' -ForegroundColor Gray
} else {
    Write-Host '  - 当前已配置为【纯侧边栏面板模式】，直接正常启动 Antigravity 即可在侧边栏打开 TokenMeter。' -ForegroundColor Cyan
    Write-Host '  - 如需日后开启底部透明状态条，重新双击安装器选择 [1] 即可。' -ForegroundColor Gray
}
Write-Host ''
Pause-IfDirect
exit 0
