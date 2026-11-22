param(
    [switch]$NonInteractive,
    [switch]$Json,
    [switch]$Fix
)

$ErrorActionPreference = 'Continue'
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
    if ($NonInteractive -or $Json) { return }
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

$PluginsRoot = Join-Path $HomeDir '.gemini\config\plugins'
$PluginDir = Join-Path $PluginsRoot 'antigravity-token-meter'
$ConfigFile = Join-Path $HomeDir '.gemini\config\config.json'
$ConfigDir = Join-Path $LocalDir 'AntigravityTokenMeter'
$ConfigBackupsDir = Join-Path $ConfigDir 'config-backups'
$SettingsFile = Join-Path $ConfigDir 'settings.json'
$PrefsFile = Join-Path $ConfigDir 'preferences.json'
$StatusFile = Join-Path $HomeDir '.gemini\antigravity\sidecar_data\antigravity-token-meter\meter\data\integration-status.json'

function Ensure-Directory([string]$DirPath) {
    if (-not [string]::IsNullOrWhiteSpace($DirPath)) {
        [System.IO.Directory]::CreateDirectory($DirPath) | Out-Null
    }
}

function Write-AtomicUtf8([string]$TargetPath, [string]$Content) {
    $parent = Split-Path -Parent $TargetPath
    Ensure-Directory $parent
    $tmp = Join-Path $parent ('.tm-fix-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
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

function Test-SourcePackageIntact {
    foreach ($rel in @('plugin.json', 'LICENSE', 'assets\logo.svg', 'sidecars\meter\sidecar.json', 'sidecars\meter\main.mjs')) {
        if (-not (Test-Path -LiteralPath (Join-Path $SrcPlugin $rel) -PathType Leaf)) {
            return $false
        }
    }
    return $true
}

function Get-AntigravityProcessInfo {
    if ($IsSandbox) {
        return [PSCustomObject]@{
            QueryOk         = $true
            AllProcs        = @()
            GuiProcs        = @()
            SidecarProcs    = @()
            ElevatedUnknown = $false
            HasDebugPort    = $false
            ExecutablePath  = $null
            MainCommandLine = $null
        }
    }
    try {
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
            QueryOk         = $true
            AllProcs        = $all
            GuiProcs        = $gui
            SidecarProcs    = $sidecar
            ElevatedUnknown = $elevatedUnknown
            HasDebugPort    = $hasDebug
            ExecutablePath  = $exePath
            MainCommandLine = $mainCmd
        }
    } catch {
        return [PSCustomObject]@{
            QueryOk         = $false
            AllProcs        = @()
            GuiProcs        = @()
            SidecarProcs    = @()
            ElevatedUnknown = $false
            HasDebugPort    = $false
            ExecutablePath  = $null
            MainCommandLine = $null
        }
    }
}

function Test-ActiveDevToolsPort([string[]]$Profiles) {
    $foundAnyFile = $false
    $lastPortErr = ''
    foreach ($pDir in $Profiles) {
        if ([string]::IsNullOrWhiteSpace($pDir)) { continue }
        $pf = Join-Path $pDir 'DevToolsActivePort'
        if (-not (Test-Path -LiteralPath $pf -PathType Leaf)) { continue }
        $foundAnyFile = $true
        try {
            $lines = @(Get-Content -LiteralPath $pf -ErrorAction Stop)
            $portStr = if ($lines.Count -gt 0) { ([string]$lines[0]).Trim() } else { '' }
            if ($portStr -notmatch '^[1-9]\d{0,4}$' -or [int]$portStr -gt 65535) {
                $lastPortErr = "端口文件首行不是合法端口号 ($pf)"
                continue
            }
            $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$portStr/json/list")
            $req.Proxy = [System.Net.GlobalProxySelection]::GetEmptyWebProxy()
            $req.AllowAutoRedirect = $false
            $req.Timeout = 2500
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
                $pageCount = 0
                try {
                    $targets = @($rawJson | ConvertFrom-Json)
                    $pageCount = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://' }).Count
                } catch {}
                return [PSCustomObject]@{
                    Ready     = $true
                    FoundFile = $true
                    Port      = [int]$portStr
                    PageCount = $pageCount
                    LastError = ''
                }
            } else {
                $lastPortErr = "端口 $portStr 返回异常状态码 HTTP $code"
            }
        } catch {
            $lastPortErr = '端口文件对应端点不可达（可能为上次退出残留的过期端口）'
        }
    }
    return [PSCustomObject]@{
        Ready     = $false
        FoundFile = $foundAnyFile
        Port      = $null
        PageCount = 0
        LastError = $lastPortErr
    }
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

    $safePrefixes = @('--proxy-server=', '--proxy-bypass-list=', '--proxy-pac-url=', '--user-data-dir=', '--lang=', '--force-device-scale-factor=')
    $safeStandalone = @('--no-proxy-server', '--disable-gpu', '--disable-http2', '--ignore-certificate-errors')
    $safePairFlags = @('--proxy-server', '--proxy-bypass-list', '--proxy-pac-url', '--user-data-dir', '--lang', '--force-device-scale-factor')

    $kept = @()
    for ($i = 0; $i -lt $tokens.Count; $i++) {
        $t = $tokens[$i]
        if ($t -match '^--remote-debugging-port(?:=|$)') {
            if ($t -eq '--remote-debugging-port' -and ($i + 1) -lt $tokens.Count) { $i++ }
            continue
        }
        $matched = $false
        foreach ($pfx in $safePrefixes) {
            if ($t.StartsWith($pfx, [System.StringComparison]::OrdinalIgnoreCase)) { $kept += $t; $matched = $true; break }
        }
        if ($matched) { continue }
        foreach ($sf in $safeStandalone) {
            if ($t.Equals($sf, [System.StringComparison]::OrdinalIgnoreCase)) { $kept += $t; $matched = $true; break }
        }
        if ($matched) { continue }
        foreach ($pf in $safePairFlags) {
            if ($t.Equals($pf, [System.StringComparison]::OrdinalIgnoreCase) -and ($i + 1) -lt $tokens.Count) {
                $kept += $t; $kept += $tokens[$i + 1]; $i++; break
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
    }
    if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles 'Antigravity\Antigravity.exe') }
    $regRoots = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
        'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    )
    foreach ($root in $regRoots) {
        try {
            Get-ItemProperty $root -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '(?i)\bAntigravity\b' } | ForEach-Object {
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
    if (-not $IsSandbox) {
        $lnkDirs = @()
        try { $lnkDirs += [Environment]::GetFolderPath('Desktop') } catch {}
        try { $lnkDirs += [Environment]::GetFolderPath('StartMenu') } catch {}
        try { $lnkDirs += [Environment]::GetFolderPath('CommonStartMenu') } catch {}
        $wsh = $null
        try { $wsh = New-Object -ComObject WScript.Shell } catch {}
        if ($null -ne $wsh) {
            foreach ($dir in ($lnkDirs | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Container) } | Select-Object -Unique)) {
                try {
                    Get-ChildItem -LiteralPath $dir -Filter '*Antigravity*.lnk' -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
                        try {
                            $target = $wsh.CreateShortcut($_.FullName).TargetPath
                            if ($target -and $target -match '(?i)\\Antigravity\.exe$') { $candidates += $target }
                        } catch {}
                    }
                } catch {}
            }
        }
    }
    foreach ($p in ($candidates | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Select-Object -Unique)) {
        if (Test-Path -LiteralPath $p -PathType Leaf) { return (Resolve-Path -LiteralPath $p).Path }
    }
    return $null
}

function Stop-AntigravityGracefully {
    if ($IsSandbox) { return 'stopped' }
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

function Invoke-DoctorInspection([switch]$Silent) {
    $checks = @()
    $failCount = 0
    $warnCount = 0
    $fixTargets = @()
    $srcIntact = Test-SourcePackageIntact

    function Add-Result([string]$id, [string]$status, [string]$detail, [string]$hint = '', [bool]$fixable = $false) {
        $script:__tmpChecks += [PSCustomObject]@{
            id      = $id
            status  = $status
            detail  = $detail
            hint    = $hint
            fixable = $fixable
        }
        if ($status -eq 'fail') { $script:__tmpFail++ }
        elseif ($status -eq 'warn') { $script:__tmpWarn++ }
        if (-not $Silent -and -not $Json) {
            $color = switch ($status) { 'pass' { 'Green' } 'warn' { 'Yellow' } default { 'Red' } }
            $fixTag = if ($fixable) { ' [可自动修复]' } else { '' }
            Write-Host ("[$($status.ToUpper())] $id - $detail$fixTag") -ForegroundColor $color
            if ($hint) { Write-Host ("       修复建议: $hint") -ForegroundColor Yellow }
        }
    }

    $script:__tmpChecks = @()
    $script:__tmpFail = 0
    $script:__tmpWarn = 0

    # 1/7 插件核心文件完整性
    $pkgOk = (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\main.mjs') -PathType Leaf) -and
             (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\sidecar.json') -PathType Leaf) -and
             (Test-Path -LiteralPath (Join-Path $PluginDir 'assets\logo.svg') -PathType Leaf) -and
             (Test-Path -LiteralPath (Join-Path $PluginDir 'plugin.json') -PathType Leaf) -and
             (Test-Path -LiteralPath (Join-Path $PluginDir 'LICENSE') -PathType Leaf)
    if ($pkgOk) {
        Add-Result '1/7 插件文件' 'pass' '插件核心文件、sidecar.json 与 MIT LICENSE 完整'
    } else {
        if ($srcIntact) { $fixTargets += 'plugin_files' }
        Add-Result '1/7 插件文件' 'fail' '插件目录缺失关键文件' '请运行「一键安装插件(Windows双击运行).bat」或使用诊断工具 -Fix 自动重新部署。' $srcIntact
    }

    # 2/7 & 3/7 校验 config.json（插件注册、Sidecar 完整结构、旧版 antigravity-pulse 冲突）
    $cfgExists = Test-Path -LiteralPath $ConfigFile -PathType Leaf
    $cfgCorrupt = $false
    $pluginEnabled = $false
    $sidecarEnabled = $false
    $sidecarSchemaComplete = $false
    $sidecarHasProjectId = $false
    $legacyPulseConflict = $false

    if ($cfgExists) {
        try {
            $rawCfg = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            if ([string]::IsNullOrWhiteSpace($rawCfg)) {
                $cfgCorrupt = $true
            } else {
                $cfg = $rawCfg | ConvertFrom-Json
                if ($null -eq $cfg -or ($cfg -is [System.Array]) -or (-not ($cfg -is [PSCustomObject]))) {
                    $cfgCorrupt = $true
                } else {
                    if ($cfg.plugins -is [PSCustomObject]) {
                        $pmProp = $cfg.plugins.PSObject.Properties['antigravity-token-meter']
                        if ($null -ne $pmProp -and ($pmProp.Value -is [PSCustomObject]) -and ($pmProp.Value.enabled -eq $true)) {
                            $pluginEnabled = $true
                        }
                        $pulseProp = $cfg.plugins.PSObject.Properties['antigravity-pulse']
                        if ($null -ne $pulseProp -and ($pulseProp.Value -is [PSCustomObject]) -and ($pulseProp.Value.enabled -ne $false)) {
                            $legacyPulseConflict = $true
                        }
                    }
                    if ($cfg.sidecars -is [PSCustomObject]) {
                        $scProp = $cfg.sidecars.PSObject.Properties['antigravity-token-meter/meter']
                        if ($null -ne $scProp -and ($scProp.Value -is [PSCustomObject])) {
                            $scObj = $scProp.Value
                            if ($scObj.enabled -eq $true) { $sidecarEnabled = $true }
                            $hasSv = ($null -ne $scObj.PSObject.Properties['schemaVersion']) -and ($null -ne $scObj.schemaVersion)
                            $rpProp = $scObj.PSObject.Properties['resolvedPermissions']
                            $hasRp = ($null -ne $rpProp) -and ($rpProp.Value -is [PSCustomObject]) -and (-not ($rpProp.Value -is [System.Array]))
                            if ($hasSv -and $hasRp) { $sidecarSchemaComplete = $true }
                            $pidProp = $scObj.PSObject.Properties['projectId']
                            if ($null -ne $pidProp -and $pidProp.Value -is [string] -and -not [string]::IsNullOrWhiteSpace($pidProp.Value)) {
                                $sidecarHasProjectId = $true
                            }
                        }
                        foreach ($p in $cfg.sidecars.PSObject.Properties) {
                            if (($p.Name -like 'antigravity-pulse/*' -or $p.Name -eq 'antigravity-pulse') -and ($p.Value -is [PSCustomObject]) -and ($p.Value.enabled -ne $false)) {
                                $legacyPulseConflict = $true
                            }
                        }
                    }
                }
            }
        } catch {
            $cfgCorrupt = $true
        }
    }

    if (-not $cfgCorrupt -and (Test-Path -LiteralPath (Join-Path $PluginsRoot 'antigravity-pulse') -PathType Container)) {
        $pulseExplicitlyDisabled = $false
        if ($cfgExists -and $cfg -is [PSCustomObject] -and $cfg.plugins -is [PSCustomObject]) {
            $pp = $cfg.plugins.PSObject.Properties['antigravity-pulse']
            if ($null -ne $pp -and ($pp.Value -is [PSCustomObject]) -and ($pp.Value.enabled -eq $false)) {
                $pulseExplicitlyDisabled = $true
            }
        }
        if (-not $pulseExplicitlyDisabled) { $legacyPulseConflict = $true }
    }

    if ($cfgCorrupt) {
        $fixTargets += 'config_json'
        Add-Result '2/7 插件注册' 'fail' '宿主 config.json 为空或存在 JSON 语法损坏，无法读取插件状态' '使用诊断工具 -Fix 可自动备份损坏文件，优先从历史备份恢复或安全重建合法配置。' $true
        Add-Result '3/7 Sidecar 启用' 'fail' '因 config.json 格式损坏无法确认 sidecar 启用状态' '运行 -Fix 修复 config.json 后彻底重启 Antigravity。' $true
    } else {
        if ($pluginEnabled -and $legacyPulseConflict) {
            $fixTargets += 'legacy_pulse'
            Add-Result '2/7 插件注册' 'warn' '已启用 TokenMeter，但检测到旧版 antigravity-pulse 仍未停用（可能导致底部条重影抢占）' '运行 -Fix 或重跑安装器可自动停用旧版 antigravity-pulse。' $true
        } elseif ($pluginEnabled) {
            Add-Result '2/7 插件注册' 'pass' 'config.json 已启用 plugins["antigravity-token-meter"]'
        } elseif (-not $cfgExists) {
            $fixTargets += 'config_json'
            Add-Result '2/7 插件注册' 'fail' '尚未检测到宿主 config.json 配置文件' '运行 -Fix 或双击安装器即可自动生成并注册。' $true
        } else {
            $fixTargets += 'config_json'
            Add-Result '2/7 插件注册' 'fail' 'config.json 中 plugins["antigravity-token-meter"] 未启用' '请彻底退出 Antigravity（含托盘）后运行 -Fix 或重跑安装器。' $true
        }

        if ($sidecarEnabled -and $sidecarSchemaComplete) {
            $pidNote = if ($sidecarHasProjectId) { '已绑定 projectId' } else { '首次启动将由宿主自动分配 projectId' }
            Add-Result '3/7 Sidecar 启用' 'pass' "config.json 已完整注册 sidecars[`"antigravity-token-meter/meter`"]（$pidNote）"
        } elseif ($sidecarEnabled) {
            $fixTargets += 'config_json'
            Add-Result '3/7 Sidecar 启用' 'warn' 'config.json 已启用 sidecar，但缺少 schemaVersion 或 resolvedPermissions 字段' '运行 -Fix 可按 Antigravity 2.33+/2.34+ 官方规范无损补齐（不破坏已有 projectId）。' $true
        } else {
            $fixTargets += 'config_json'
            Add-Result '3/7 Sidecar 启用' 'fail' 'config.json 未启用 sidecars["antigravity-token-meter/meter"] 后台进程' '请彻底退出 Antigravity 后运行 -Fix 或新版安装器自动补齐。' $true
        }
    }

    # 4/7 本地 settings.json 校验（零配置缺失默认视同开启底部内嵌 inline=true）
    $settingsExists = Test-Path -LiteralPath $SettingsFile -PathType Leaf
    $settingsCorrupt = $false
    $localEnabled = $true
    $inlineWanted = $true
    $customProfile = $null

    if ($settingsExists) {
        try {
            $rawSet = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
            $stSet = $rawSet | ConvertFrom-Json
            if ($null -eq $stSet -or ($stSet -is [System.Array]) -or (-not ($stSet -is [PSCustomObject]))) {
                $settingsCorrupt = $true
            } else {
                $enabledProp = $stSet.PSObject.Properties['enabled']
                $inlineProp = $stSet.PSObject.Properties['inline']
                if ($null -ne $enabledProp) {
                    if (-not ($enabledProp.Value -is [bool])) {
                        $settingsCorrupt = $true
                    } elseif ($enabledProp.Value -eq $false) {
                        $localEnabled = $false
                    }
                }
                if ($null -ne $inlineProp) {
                    if (-not ($inlineProp.Value -is [bool])) {
                        $settingsCorrupt = $true
                    } else {
                        $inlineWanted = [bool]$inlineProp.Value
                    }
                } else {
                    $inlineWanted = $true
                }
                if ($stSet.profile -is [string] -and -not [string]::IsNullOrWhiteSpace($stSet.profile)) {
                    $customProfile = $stSet.profile.Trim()
                }
            }
        } catch {
            $settingsCorrupt = $true
        }
    }

    if ($settingsCorrupt) {
        $inlineWanted = $false
        $fixTargets += 'settings_json'
        Add-Result '4/7 本地配置文件' 'fail' '本地 settings.json 格式损坏或字段类型非法（enabled/inline 须为布尔值），底部内嵌模式已被安全降级关闭' '运行 -Fix 可自动备份原文件并重置为合法的 settings.json。' $true
    } elseif (-not $localEnabled) {
        $fixTargets += 'settings_json'
        Add-Result '4/7 本地配置文件' 'warn' '本地 settings.json 中 enabled=false，TokenMeter 当前被手动停用' '运行 -Fix 或重跑安装器即可恢复 enabled=true。' $true
    } elseif (-not $settingsExists) {
        Add-Result '4/7 本地配置文件' 'pass' '未创建 settings.json（按零配置默认启用：侧边栏 + 底部内嵌模式）'
    } elseif ($inlineWanted) {
        Add-Result '4/7 本地配置文件' 'pass' 'settings.json 正常（已启用侧边栏 + 聊天框底部透明状态条模式）'
    } else {
        Add-Result '4/7 本地配置文件' 'pass' 'settings.json 正常（当前为纯侧边栏面板模式，已显式关闭底部内嵌）'
    }

    $profileCandidates = @()
    foreach ($envProf in @($env:AG_TM_PROFILE, $env:ANTIGRAVITY_USER_DATA_DIR, $env:ELECTRON_USER_DATA_DIR)) {
        if ($envProf -and -not [string]::IsNullOrWhiteSpace($envProf)) { $profileCandidates += $envProf.Trim() }
    }
    if ($customProfile) { $profileCandidates += $customProfile }
    $profileCandidates += (Join-Path $AppDataDir 'Antigravity')
    $profileCandidates += (Join-Path $AppDataDir 'Antigravity - Insiders')
    $profileCandidates += (Join-Path $AppDataDir 'Antigravity Insiders')
    $uniqueProfiles = @($profileCandidates | Select-Object -Unique)

    $procInfo = Get-AntigravityProcessInfo
    $portProbe = if (-not $settingsCorrupt -and $inlineWanted) { Test-ActiveDevToolsPort $uniqueProfiles } else { [PSCustomObject]@{ Ready = $false; FoundFile = $false; Port = $null; PageCount = 0; LastError = '' } }
    $hasRunningNoDebug = $false

    # 5/7 运行中主进程与 --remote-debugging-port 参数检查
    if ($IsSandbox) {
        Add-Result '5/7 主进程参数' 'warn' '沙箱隔离环境未运行 Antigravity 主进程（已完成全部静态安装与配置校验）'
    } elseif (-not $procInfo.QueryOk) {
        Add-Result '5/7 主进程参数' 'fail' '无法查询本机进程列表（可能系统 WMI 服务异常或权限受限）' '可尝试右键以管理员身份运行本诊断工具。'
    } elseif ($procInfo.AllProcs.Count -eq 0) {
        Add-Result '5/7 主进程参数' 'warn' '未检测到运行中的 Antigravity 主界面' '请双击「启动Antigravity(带Token监控).bat」启动客户端。'
    } elseif ($procInfo.ElevatedUnknown) {
        if ($portProbe.Ready) {
            Add-Result '5/7 主进程参数' 'pass' "检测到管理员权限运行的 Antigravity，且已确认本地调试端口连通 (port=$($portProbe.Port))"
        } elseif (-not $inlineWanted) {
            Add-Result '5/7 主进程参数' 'pass' '检测到管理员权限运行的 Antigravity（当前为纯侧边栏模式，无需调试端口）'
        } else {
            Add-Result '5/7 主进程参数' 'warn' '检测到管理员权限运行的 Antigravity，当前普通终端无法读取其启动命令行' '如需核验或重启，请右键以管理员身份运行本诊断工具或专用启动器。'
        }
    } elseif ($procInfo.HasDebugPort) {
        Add-Result '5/7 主进程参数' 'pass' 'Antigravity 主进程已携带 --remote-debugging-port 启动参数'
    } elseif (-not $inlineWanted) {
        Add-Result '5/7 主进程参数' 'pass' '当前为纯侧边栏模式（未开启底部内嵌，无需调试端口）'
    } else {
        $hasRunningNoDebug = $true
        Add-Result '5/7 主进程参数' 'fail' 'Antigravity 主进程未携带 --remote-debugging-port=0（常见于托盘旧进程未彻底退出）' '请使用「启动Antigravity(带Token监控).bat」一键安全重启，或在自定义启动脚本末尾加上 --remote-debugging-port=0。' $true
    }

    # 6/7 本地 CDP 调试端口校验（零代理直连）
    if ($settingsCorrupt) {
        Add-Result '6/7 本地调试端口' 'fail' '因 settings.json 损坏跳过内嵌端口检测' '请运行 -Fix 修复本地配置文件后重试。' $true
    } elseif (-not $inlineWanted) {
        Add-Result '6/7 本地调试端口' 'pass' '纯侧边栏模式无需检测本地 CDP 调试端口'
    } elseif ($portProbe.Ready) {
        Add-Result '6/7 本地调试端口' 'pass' "DevToolsActivePort 连通正常 (port=$($portProbe.Port), pages=$($portProbe.PageCount))"
    } elseif ($procInfo.AllProcs.Count -eq 0) {
        Add-Result '6/7 本地调试端口' 'warn' 'Antigravity 尚未启动，启动后将自动建立本地调试端口' '请双击「启动Antigravity(带Token监控).bat」启动客户端。'
    } elseif (-not $portProbe.FoundFile) {
        Add-Result '6/7 本地调试端口' 'fail' '未在配置目录检测到 DevToolsActivePort 文件' '请右键系统托盘彻底退出 Antigravity，再通过「启动Antigravity(带Token监控).bat」启动。'
    } else {
        Add-Result '6/7 本地调试端口' 'fail' "检测到 DevToolsActivePort 但无法连接：$($portProbe.LastError)" '请彻底退出 Antigravity 后用「启动Antigravity(带Token监控).bat」重新打开以刷新端口。'
    }

    # 7/7 活实例 sidecar 与最新挂载/启动异常核验
    if (Test-Path -LiteralPath $StatusFile -PathType Leaf) {
        try {
            $st = ([System.IO.File]::ReadAllText($StatusFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
            $pidAlive = $false
            if ($st.pid) {
                $pidAlive = $null -ne (Get-Process -Id ([int]$st.pid) -ErrorAction SilentlyContinue)
            }
            $ageSec = 99999
            if ($null -ne $st.checkedAt) {
                $checkedUtc = $null
                if ($st.checkedAt -is [DateTimeOffset]) {
                    $checkedUtc = ([DateTimeOffset]$st.checkedAt).UtcDateTime
                } elseif ($st.checkedAt -is [DateTime]) {
                    $dt = [DateTime]$st.checkedAt
                    if ($dt.Kind -eq [DateTimeKind]::Utc) { $checkedUtc = $dt }
                    elseif ($dt.Kind -eq [DateTimeKind]::Local) { $checkedUtc = $dt.ToUniversalTime() }
                    else { $checkedUtc = [DateTime]::SpecifyKind($dt, [DateTimeKind]::Utc) }
                } elseif (-not [string]::IsNullOrWhiteSpace([string]$st.checkedAt)) {
                    $checkedDto = [DateTimeOffset]::Parse([string]$st.checkedAt, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::RoundtripKind)
                    $checkedUtc = $checkedDto.UtcDateTime
                }
                if ($null -ne $checkedUtc) {
                    $ageSec = [Math]::Abs(([DateTime]::UtcNow - $checkedUtc).TotalSeconds)
                }
            }

            # 优先识别 main.mjs 写入的致命启动异常（即使 sidecar 进程已退出，也绝不掩盖真实报错！）
            if ($st.state -eq 'error') {
                $errCode = if ($st.code) { [string]$st.code } else { 'startup_failed' }
                $errMsg = if ($st.errorMessage) { " ($($st.errorMessage))" } else { '' }
                switch ($errCode) {
                    'sdk_not_found' {
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar 启动失败：未找到 Antigravity 官方 sidecar_sdk (sdk_not_found)$errMsg" '请确认已升级至 Antigravity 2.33+ 官方桌面版，并重启一次客户端让内置运行时完成初始化。'
                    }
                    'missing_env' {
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar 启动失败：缺少宿主注入的运行环境变量 (missing_env)$errMsg" '请通过 Antigravity 客户端加载本插件，勿直接手动执行 main.mjs（独立预览请加 --preview）。'
                    }
                    'missing_assets' {
                        if ($srcIntact) { $fixTargets += 'plugin_files' }
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar 启动失败：缺少前端面板静态资源 (missing_assets)$errMsg" '请运行 -Fix 或重新双击「一键安装插件(Windows双击运行).bat」完整重新部署插件文件。' $srcIntact
                    }
                    'server_listen_failed' {
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar Web UI 监听失败 (server_listen_failed)$errMsg" '请检查安全软件/防火墙是否拦截了本地回环端口，然后彻底重启 Antigravity。'
                    }
                    default {
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar 启动异常退出 (code=$errCode)$errMsg" '请尝试重新运行安装器更新插件并彻底重启 Antigravity。'
                    }
                }
            } elseif ($procInfo.AllProcs.Count -eq 0) {
                Add-Result '7/7 运行实例与挂载' 'warn' 'Antigravity 尚未运行（启动客户端后 sidecar 将自动拉起并刷新状态）' '请使用「启动Antigravity(带Token监控).bat」打开客户端。'
            } elseif (-not $pidAlive -or $ageSec -gt 30) {
                Add-Result '7/7 运行实例与挂载' 'fail' '状态文件已过期或对应 sidecar 后台进程未运行' '请确认第 2、3 项已通过，彻底退出托盘并重启 Antigravity（或在客户端 Customizations -> Plugins 中重新切换开关）。'
            } elseif ($st.state -eq 'mounted') {
                Add-Result '7/7 运行实例与挂载' 'pass' "sidecar 存活且底部状态条已挂载 (windows=$($st.windows))"
            } elseif ($st.state -eq 'waiting_composer') {
                Add-Result '7/7 运行实例与挂载' 'warn' "sidecar 已连上主窗口 (windows=$($st.windows))，当前页面无聊天输入框，切回任意对话即自动显示底部状态条"
            } elseif (-not $inlineWanted -and ($st.state -eq 'disabled' -or $st.code -eq 'inline_disabled')) {
                Add-Result '7/7 运行实例与挂载' 'pass' 'sidecar 存活（纯侧边栏面板模式运行正常）'
            } else {
                $diagCode = if ($st.code) { [string]$st.code } else { [string]$st.state }
                switch ($diagCode) {
                    'inline_disabled' {
                        Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 正在运行，但检测到内嵌或插件开关处于关闭状态 (inline_disabled)' '若刚修改设置请等待数秒，或运行 -Fix 启用底部内嵌模式。'
                    }
                    'starting' {
                        if ($ageSec -lt 8) {
                            Add-Result '7/7 运行实例与挂载' 'warn' 'sidecar 刚启动，正在初始化本地 Language Server 与窗口连接 (starting)' '请等待 3~5 秒后再次运行诊断确认挂载结果。'
                        } else {
                            Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 长时间停留在初始化阶段，未能确认宿主服务端口 (starting)' '请从系统托盘完全退出并重启一次 Antigravity。'
                        }
                    }
                    'no_active_port' {
                        Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 未找到 DevToolsActivePort 调试端口文件 (no_active_port)' '请彻底退出托盘中的 Antigravity，再双击「启动Antigravity(带Token监控).bat」启动。'
                    }
                    'stale_port' {
                        Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 读取到的 DevToolsActivePort 调试端口已过期不可达 (stale_port)' '请彻底退出 Antigravity，再用专用启动器重新打开以生成新端口文件。'
                    }
                    'no_hub_page' {
                        Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 已连通本地调试端口，但尚未发现可挂载的 Antigravity 主界面窗口 (no_hub_page)' '请确认客户端主界面已完成加载（非最小化启动画面），等待数秒后重测。'
                    }
                    'cdp_unreachable' {
                        Add-Result '7/7 运行实例与挂载' 'fail' 'sidecar 暂时无法连接本地调试端口 (cdp_unreachable)' '侧边栏面板仍可正常查看；如需恢复底部状态条，请从托盘彻底退出并用专用启动器重启。'
                    }
                    default {
                        Add-Result '7/7 运行实例与挂载' 'fail' "sidecar 存活但底部条尚未挂载 (state=$($st.state), code=$diagCode)" '请从系统托盘彻底退出 Antigravity 后，通过「启动Antigravity(带Token监控).bat」重新启动。'
                    }
                }
            }
        } catch {
            Add-Result '7/7 运行实例与挂载' 'fail' 'integration-status.json 状态文件解析失败' '请重启一次 Antigravity 让 sidecar 自动重新生成状态文件。'
        }
    } else {
        if ($procInfo.AllProcs.Count -eq 0) {
            Add-Result '7/7 运行实例与挂载' 'warn' '尚未检测到 sidecar 运行状态（Antigravity 当前未启动）' '请先确认前 4 项全部通过，再通过「启动Antigravity(带Token监控).bat」启动客户端。'
        } else {
            Add-Result '7/7 运行实例与挂载' 'fail' 'Antigravity 正在运行，但尚未检测到 TokenMeter sidecar 运行状态文件' '通常是因为 config.json 在客户端运行中被覆盖或未启用 sidecar。请彻底退出托盘后运行 -Fix 并重启客户端。'
        }
    }

    return [PSCustomObject]@{
        Checks            = @($script:__tmpChecks)
        FailCount         = $script:__tmpFail
        WarnCount         = $script:__tmpWarn
        FixTargets        = @($fixTargets | Select-Object -Unique)
        ProcInfo          = $procInfo
        InlineWanted      = $inlineWanted
        HasRunningNoDebug = $hasRunningNoDebug
        SettingsExists    = $settingsExists
        UniqueProfiles    = $uniqueProfiles
    }
}

function Invoke-AutoRepair([PSCustomObject]$Report, [switch]$ExplicitFix) {
    $applied = @()
    $skipped = @()
    $targets = @($Report.FixTargets)
    if ($ExplicitFix -and (-not $Report.SettingsExists) -and ($targets -notcontains 'settings_json')) {
        $targets += 'settings_json'
    }

    $needsHostConfigOrFiles = ($targets -contains 'plugin_files') -or ($targets -contains 'config_json') -or ($targets -contains 'legacy_pulse')
    $isRunning = (-not $IsSandbox) -and ($Report.ProcInfo.GuiProcs.Count -gt 0 -or $Report.ProcInfo.ElevatedUnknown)
    $needRestartAfter = $false
    $savedExe = $Report.ProcInfo.ExecutablePath
    $savedExtraArgs = @(Get-PreservedLaunchArgs $Report.ProcInfo.MainCommandLine)
    $canModifyHost = $true

    if ($isRunning -and ($needsHostConfigOrFiles -or ($Report.HasRunningNoDebug -and -not $NonInteractive -and -not $Json))) {
        if ($NonInteractive -or $Json) {
            if ($needsHostConfigOrFiles) {
                $canModifyHost = $false
                $skipped += '检测到 Antigravity 正在运行，非交互模式跳过修改插件文件与 config.json（避免退出时被旧内存覆盖），请先彻底退出托盘实例后再执行 -Fix'
            }
        } elseif ($Report.ProcInfo.ElevatedUnknown) {
            $canModifyHost = $false
            $skipped += 'Antigravity 正以管理员权限运行，请手动右键系统托盘退出（或以管理员身份运行本诊断工具）后再修复 config.json'
        } else {
            Write-Host ''
            Write-Host '[修复前确认] Antigravity 当前正在运行，修改 config.json 或开启调试端口需要先安全关闭旧实例。' -ForegroundColor Yellow
            $stopAns = Read-Host '是否允许一键关闭 Antigravity -> 完成修复 -> 自动重启生效？(Y/n，直接回车继续)'
            if ([string]::IsNullOrWhiteSpace($stopAns) -or $stopAns -match '^[Yy]$') {
                $stopRes = Stop-AntigravityGracefully
                if ($stopRes -eq 'stopped') {
                    $needRestartAfter = $true
                    $applied += '已安全关闭运行中的 Antigravity 旧实例'
                } else {
                    $canModifyHost = $false
                    $skipped += "自动关闭 Antigravity 失败 ($stopRes)，已跳过修改 config.json"
                }
            } else {
                $canModifyHost = $false
                $skipped += '用户取消关闭运行中的 Antigravity，已跳过修改 config.json'
            }
        }
    }

    Ensure-Directory $ConfigBackupsDir

    # 1. 修复缺失插件文件
    if ($canModifyHost -and ($targets -contains 'plugin_files') -and (Test-SourcePackageIntact)) {
        try {
            Ensure-Directory $PluginDir
            foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
                $srcItem = Join-Path $SrcPlugin $item
                if (Test-Path -LiteralPath $srcItem -PathType Container) {
                    Copy-TreeLiteral $srcItem (Join-Path $PluginDir $item)
                } else {
                    [System.IO.File]::Copy($srcItem, (Join-Path $PluginDir $item), $true)
                }
            }
            $applied += '已重新部署完整 TokenMeter 插件文件（含 sidecar.json 与 MIT LICENSE）'
        } catch {
            $skipped += ("重新部署插件文件失败: " + $_.Exception.Message)
        }
    }

    # 2. 修复 config.json（插件注册 + sidecar 完整官方结构 + 损坏自愈 + 停用旧版 pulse）
    if ($canModifyHost -and (($targets -contains 'config_json') -or ($targets -contains 'legacy_pulse'))) {
        try {
            $cfg = [ordered]@{}
            $wasCorrupt = $false
            if (Test-Path -LiteralPath $ConfigFile -PathType Leaf) {
                $parsed = $null
                try {
                    $raw = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
                    if (-not [string]::IsNullOrWhiteSpace($raw)) { $parsed = $raw | ConvertFrom-Json }
                } catch { $parsed = $null }

                if ($null -eq $parsed -or ($parsed -is [System.Array]) -or (-not ($parsed -is [PSCustomObject]))) {
                    $wasCorrupt = $true
                    $tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
                    $corruptBak = Join-Path $ConfigBackupsDir ('config-corrupt-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $tag + '.json')
                    [System.IO.File]::Copy($ConfigFile, $corruptBak, $true)
                    $restored = Try-RestoreLatestValidConfigBackup $ConfigBackupsDir
                    if ($null -ne $restored) {
                        foreach ($p in $restored.Object.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
                        $applied += ("已备份损坏的 config.json 并从历史备份恢复原配置")
                    } else {
                        $applied += ("已将损坏的 config.json 备份至 $corruptBak 并重建合法配置")
                    }
                } else {
                    $tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
                    $normBak = Join-Path $ConfigBackupsDir ('config-fix-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $tag + '.json')
                    [System.IO.File]::Copy($ConfigFile, $normBak, $true)
                    foreach ($p in $parsed.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
                }
            }

            $pluginsMap = [ordered]@{}
            if ($cfg.Contains('plugins') -and ($cfg['plugins'] -is [PSCustomObject]) -and (-not ($cfg['plugins'] -is [System.Array]))) {
                foreach ($p in $cfg['plugins'].PSObject.Properties) { $pluginsMap[$p.Name] = $p.Value }
            }
            $pluginEntry = [ordered]@{}
            if ($pluginsMap.Contains('antigravity-token-meter') -and ($pluginsMap['antigravity-token-meter'] -is [PSCustomObject]) -and (-not ($pluginsMap['antigravity-token-meter'] -is [System.Array]))) {
                foreach ($p in $pluginsMap['antigravity-token-meter'].PSObject.Properties) { $pluginEntry[$p.Name] = $p.Value }
            }
            $pluginEntry['enabled'] = $true
            $pluginsMap['antigravity-token-meter'] = $pluginEntry

            $sidecarsMap = [ordered]@{}
            if ($cfg.Contains('sidecars') -and ($cfg['sidecars'] -is [PSCustomObject]) -and (-not ($cfg['sidecars'] -is [System.Array]))) {
                foreach ($p in $cfg['sidecars'].PSObject.Properties) { $sidecarsMap[$p.Name] = $p.Value }
            }
            $scEntry = [ordered]@{}
            if ($sidecarsMap.Contains('antigravity-token-meter/meter') -and ($sidecarsMap['antigravity-token-meter/meter'] -is [PSCustomObject]) -and (-not ($sidecarsMap['antigravity-token-meter/meter'] -is [System.Array]))) {
                foreach ($p in $sidecarsMap['antigravity-token-meter/meter'].PSObject.Properties) { $scEntry[$p.Name] = $p.Value }
            }
            $scEntry['enabled'] = $true
            if (-not $scEntry.Contains('resolvedPermissions') -or $null -eq $scEntry['resolvedPermissions'] -or ($scEntry['resolvedPermissions'] -is [System.Array]) -or (-not ($scEntry['resolvedPermissions'] -is [PSCustomObject] -or $scEntry['resolvedPermissions'] -is [System.Collections.IDictionary]))) {
                $scEntry['resolvedPermissions'] = [ordered]@{}
            }
            if (-not $scEntry.Contains('schemaVersion') -or $null -eq $scEntry['schemaVersion']) {
                $scEntry['schemaVersion'] = 1
            }
            $sidecarsMap['antigravity-token-meter/meter'] = $scEntry

            # 自动停用冲突的旧版 antigravity-pulse
            $disabledPulse = $false
            if ($pluginsMap.Contains('antigravity-pulse') -or (Test-Path -LiteralPath (Join-Path $PluginsRoot 'antigravity-pulse') -PathType Container)) {
                $oldEntry = [ordered]@{}
                if ($pluginsMap.Contains('antigravity-pulse') -and ($pluginsMap['antigravity-pulse'] -is [PSCustomObject])) {
                    foreach ($p in $pluginsMap['antigravity-pulse'].PSObject.Properties) { $oldEntry[$p.Name] = $p.Value }
                }
                if ($oldEntry['enabled'] -ne $false) {
                    $oldEntry['enabled'] = $false
                    $pluginsMap['antigravity-pulse'] = $oldEntry
                    $disabledPulse = $true
                }
            }
            $pulseScKeys = @($sidecarsMap.Keys | Where-Object { $_ -like 'antigravity-pulse/*' -or $_ -eq 'antigravity-pulse' })
            foreach ($sk in $pulseScKeys) {
                $oldSc = [ordered]@{}
                if ($sidecarsMap[$sk] -is [PSCustomObject]) {
                    foreach ($p in $sidecarsMap[$sk].PSObject.Properties) { $oldSc[$p.Name] = $p.Value }
                }
                if ($oldSc['enabled'] -ne $false) {
                    $oldSc['enabled'] = $false
                    $sidecarsMap[$sk] = $oldSc
                    $disabledPulse = $true
                }
            }

            $cfg['plugins'] = $pluginsMap
            $cfg['sidecars'] = $sidecarsMap
            Write-AtomicUtf8 $ConfigFile (($cfg | ConvertTo-Json -Depth 100) + "`n")
            $applied += '已在 config.json 中补齐 plugins["antigravity-token-meter"] 与 sidecars["antigravity-token-meter/meter"] 完整注册项'
            if ($disabledPulse) {
                $applied += '已停用冲突的旧版 antigravity-pulse 插件'
            }
        } catch {
            $skipped += ("修复 config.json 失败: " + $_.Exception.Message)
        }
    }

    # 3. 修复或补齐本地 settings.json（严格校验 enabled/inline 布尔类型，非法类型备份并重置）
    if ($targets -contains 'settings_json') {
        try {
            $setObj = [ordered]@{}
            $needBackupSet = $false
            if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
                $parsedSet = $null
                try {
                    $rawSet = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
                    $parsedSet = $rawSet | ConvertFrom-Json
                } catch { $parsedSet = $null }

                if ($parsedSet -is [PSCustomObject] -and (-not ($parsedSet -is [System.Array]))) {
                    $ep = $parsedSet.PSObject.Properties['enabled']
                    $ip = $parsedSet.PSObject.Properties['inline']
                    $hasInvalidField = ($null -ne $ep -and (-not ($ep.Value -is [bool]))) -or ($null -ne $ip -and (-not ($ip.Value -is [bool])))
                    if ($hasInvalidField) {
                        $needBackupSet = $true
                        if ($parsedSet.profile -is [string] -and -not [string]::IsNullOrWhiteSpace($parsedSet.profile)) {
                            $setObj['profile'] = $parsedSet.profile.Trim()
                        }
                        if ($null -ne $ip -and ($ip.Value -is [bool])) {
                            $setObj['inline'] = [bool]$ip.Value
                        }
                    } else {
                        foreach ($p in $parsedSet.PSObject.Properties) { $setObj[$p.Name] = $p.Value }
                    }
                } else {
                    $needBackupSet = $true
                }

                if ($needBackupSet) {
                    $tag = [guid]::NewGuid().ToString('N').Substring(0, 8)
                    $setBak = Join-Path $ConfigBackupsDir ('settings-corrupt-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $tag + '.json')
                    [System.IO.File]::Copy($SettingsFile, $setBak, $true)
                }
            }
            $setObj['enabled'] = $true
            if (-not $setObj.Contains('inline') -or (-not ($setObj['inline'] -is [bool]))) {
                $setObj['inline'] = $true
            }
            Write-AtomicUtf8 $SettingsFile (($setObj | ConvertTo-Json -Depth 20) + "`n")
            $applied += '已修复/补齐本地 settings.json（enabled=true，布尔类型校验通过）'
        } catch {
            $skipped += ("修复 settings.json 失败: " + $_.Exception.Message)
        }
    }

    # 4. 如刚刚自动关闭了旧实例，按需携带调试参数重新拉起 Antigravity 并等待就绪
    if ($needRestartAfter -and (-not $IsSandbox)) {
        $exeToRun = Find-AntigravityExe $savedExe
        if ($exeToRun) {
            $finalArgs = @($savedExtraArgs)
            if ($Report.InlineWanted -or ($targets -contains 'settings_json')) {
                $finalArgs += '--remote-debugging-port=0'
            }
            $workDir = Split-Path -Parent $exeToRun
            if ($finalArgs.Count -gt 0) {
                Start-Process -FilePath $exeToRun -ArgumentList ($finalArgs -join ' ') -WorkingDirectory $workDir
            } else {
                Start-Process -FilePath $exeToRun -WorkingDirectory $workDir
            }
            if (-not $Json) {
                Write-Host '      正在重启 Antigravity 并等待调试端口就绪（最长 15 秒）...' -ForegroundColor Cyan
            }
            for ($w = 0; $w -lt 30; $w++) {
                Start-Sleep -Milliseconds 500
                $p = Test-ActiveDevToolsPort $Report.UniqueProfiles
                if ($p.Ready) { break }
            }
            $applied += '已自动重启 Antigravity（携带 --remote-debugging-port=0）'
        } else {
            $skipped += '已关闭旧实例但未能自动定位 Antigravity.exe，请手动双击「启动Antigravity(带Token监控).bat」'
        }
    }

    return [PSCustomObject]@{ Applied = @($applied); Skipped = @($skipped) }
}

if (-not $Json) {
    try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter 7 项健康诊断与一键修复工具' } catch {}
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host '   Antigravity TokenMeter 7 项深度健康诊断与一键修复' -ForegroundColor Cyan
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host ''
}

$fixesApplied = @()
$fixesSkipped = @()

if ($Fix) {
    $preReport = Invoke-DoctorInspection -Silent
    $repairRes = Invoke-AutoRepair -Report $preReport -ExplicitFix
    $fixesApplied = @($repairRes.Applied)
    $fixesSkipped = @($repairRes.Skipped)
    if (-not $Json) {
        if ($fixesApplied.Count -gt 0) {
            Write-Host '[一键修复完成]' -ForegroundColor Green
            foreach ($msg in $fixesApplied) { Write-Host ("  + $msg") -ForegroundColor Green }
            Write-Host ''
        }
        if ($fixesSkipped.Count -gt 0) {
            Write-Host '[跳过项说明]' -ForegroundColor Yellow
            foreach ($msg in $fixesSkipped) { Write-Host ("  ! $msg") -ForegroundColor Yellow }
            Write-Host ''
        }
        Write-Host '[修复后复检结果]' -ForegroundColor Cyan
    }
    $report = Invoke-DoctorInspection
} else {
    $report = Invoke-DoctorInspection
    $hasAutoFixable = ($report.FixTargets.Count -gt 0) -or $report.HasRunningNoDebug
    if ($hasAutoFixable -and (-not $NonInteractive) -and (-not $Json)) {
        Write-Host ''
        $fixPrompt = Read-Host '检测到可自动修复的问题，是否立即执行一键修复？(Y/n，直接回车立即修复)'
        if ([string]::IsNullOrWhiteSpace($fixPrompt) -or $fixPrompt -match '^[Yy]$') {
            Write-Host ''
            $repairRes = Invoke-AutoRepair -Report $report
            $fixesApplied = @($repairRes.Applied)
            $fixesSkipped = @($repairRes.Skipped)
            if ($fixesApplied.Count -gt 0) {
                Write-Host '[一键修复完成]' -ForegroundColor Green
                foreach ($msg in $fixesApplied) { Write-Host ("  + $msg") -ForegroundColor Green }
            }
            if ($fixesSkipped.Count -gt 0) {
                Write-Host '[跳过项说明]' -ForegroundColor Yellow
                foreach ($msg in $fixesSkipped) { Write-Host ("  ! $msg") -ForegroundColor Yellow }
            }
            Write-Host ''
            Write-Host '[修复后复检结果]' -ForegroundColor Cyan
            $report = Invoke-DoctorInspection
        }
    }
}

$fixableCount = @($report.Checks | Where-Object { $_.fixable -eq $true }).Count

if ($Json) {
    $payload = [PSCustomObject]@{
        ok           = ($report.FailCount -eq 0)
        failures     = $report.FailCount
        warnings     = $report.WarnCount
        fixable      = $fixableCount
        fixesApplied = @($fixesApplied)
        fixesSkipped = @($fixesSkipped)
        checks       = @($report.Checks)
    }
    $payload | ConvertTo-Json -Depth 6
} else {
    Write-Host ''
    Write-Host '----------------------------------------------------------------' -ForegroundColor DarkGray
    if ($report.FailCount -eq 0 -and $report.WarnCount -eq 0) {
        Write-Host '结论：全部 7 项诊断全部通过，TokenMeter 运行状态完全正常！' -ForegroundColor Green
    } elseif ($report.FailCount -eq 0) {
        Write-Host ("结论：核心配置正常（发现 $($report.WarnCount) 项温和提示，请查看上方黄色说明）。") -ForegroundColor Green
    } else {
        Write-Host ("结论：发现 $($report.FailCount) 项异常，请按上方「修复建议」处理，或运行 scripts\doctor.ps1 -Fix 一键修复。") -ForegroundColor Yellow
    }
    Write-Host ''
    if ($report.FailCount -gt 0) {
        Pause-IfDirect -IsError
    } else {
        Pause-IfDirect
    }
}

if ($report.FailCount -gt 0) { exit 1 } else { exit 0 }
