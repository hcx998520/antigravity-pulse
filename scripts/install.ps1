param(
    [switch]$NonInteractive,
    [switch]$EnableInline,
    [switch]$DisableInline,
    [switch]$DisableLegacyPulse
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter v1.2.13 安装器' } catch {}

Write-Host '================================================================' -ForegroundColor Cyan
Write-Host '  Antigravity TokenMeter v1.2.13 (MIT License)' -ForegroundColor Cyan
Write-Host '  支持侧边栏面板 + 可选实验性底部内嵌状态条（不修改 app.asar）' -ForegroundColor Cyan
Write-Host '================================================================' -ForegroundColor Cyan
Write-Host ''

$RootDir   = Split-Path -Parent $PSScriptRoot
$SrcPlugin = Join-Path $RootDir 'antigravity-token-meter'

# 1. 前置完整性检查（任何写入之前）
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
        Write-Host '请先将完整压缩包解压到常规文件夹后再运行。' -ForegroundColor Yellow
        if (-not $NonInteractive) { Read-Host '按回车键退出' }
        exit 1
    }
}

$HomeDir  = if ($env:AG_TEST_HOME) { $env:AG_TEST_HOME } else { $env:USERPROFILE }
if (-not $HomeDir) { $HomeDir = [Environment]::GetFolderPath('UserProfile') }
$LocalDir = if ($env:AG_TEST_LOCAL) { $env:AG_TEST_LOCAL } else { $env:LOCALAPPDATA }
if (-not $LocalDir) { $LocalDir = Join-Path $HomeDir 'AppData\Local' }

$DstPluginsRoot = Join-Path $HomeDir '.gemini\config\plugins'
$DstPlugin      = Join-Path $DstPluginsRoot 'antigravity-token-meter'
$ConfigDir      = Join-Path $LocalDir 'AntigravityTokenMeter'
$ConfigJsonFile = Join-Path $HomeDir '.gemini\config\config.json'
$Utf8NoBom      = New-Object System.Text.UTF8Encoding($false)

function Get-AntigravityGuiProcesses {
    if ($env:AG_TEST_HOME) { return @() }
    $list = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop | Where-Object {
        $_.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--type='
    })
    return $list
}

function Write-AtomicUtf8([string]$TargetPath, [string]$Content) {
    $parent = Split-Path -Parent $TargetPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    $tmp = Join-Path $parent ('.tm-tmp-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    try {
        [System.IO.File]::WriteAllText($tmp, $Content, $Utf8NoBom)
        if (Test-Path -LiteralPath $TargetPath) {
            [System.IO.File]::Replace($tmp, $TargetPath, [NullString]::Value, $true)
        } else {
            Move-Item -LiteralPath $tmp -Destination $TargetPath -Force
        }
    } catch {
        if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue }
        throw
    }
}

# 2. 前置检测 Antigravity 主进程是否仍在运行（写入前确认，防止覆盖运行中代码或配置竞争）
Write-Host '[1/4] 正在检查 Antigravity 运行状态...' -ForegroundColor White
$guiProcs = @()
try {
    $guiProcs = Get-AntigravityGuiProcesses
} catch {
    Write-Host '[错误] 无法检查 Antigravity 进程状态，已中止安装以保护原配置。' -ForegroundColor Red
    if (-not $NonInteractive) { Read-Host '按回车键退出' }
    exit 2
}

if ($guiProcs.Count -gt 0) {
    if ($NonInteractive) {
        Write-Host '[错误] 检测到 Antigravity 主界面正在运行。非交互模式下拒绝覆写运行中的插件与配置，请先彻底退出客户端后重试。' -ForegroundColor Red
        exit 3
    }
    Write-Host ''
    Write-Host '  [重要提示] 检测到 Antigravity 主界面仍在运行（可能驻留在系统托盘中）。' -ForegroundColor Yellow
    Write-Host '  请先从菜单或右键系统托盘点击【退出】彻底关闭 Antigravity，以免退出时覆盖刚写入的启用配置。' -ForegroundColor Yellow
    Write-Host ''
    Read-Host '确认已彻底退出 Antigravity 后，按回车键继续'
    for ($i = 0; $i -lt 16; $i++) {
        $guiProcs = Get-AntigravityGuiProcesses
        if ($guiProcs.Count -eq 0) { break }
        Start-Sleep -Milliseconds 500
    }
    if ($guiProcs.Count -gt 0) {
        Write-Host '[错误] 仍检测到 Antigravity 主界面在运行，安装已安全中止（未修改任何文件）。' -ForegroundColor Red
        Read-Host '按回车键退出'
        exit 3
    }
}
Write-Host '      已确认 Antigravity 主界面未运行。' -ForegroundColor Green

# 3. 校验并安全更新 config.json（同时启用 plugin 与 sidecar！）
Write-Host '[2/4] 正在校验并更新宿主 config.json（启用插件与 sidecar）...' -ForegroundColor White
$cfg = [ordered]@{}
if (Test-Path -LiteralPath $ConfigJsonFile) {
    $rawCfg = [System.IO.File]::ReadAllText($ConfigJsonFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
    if ([string]::IsNullOrWhiteSpace($rawCfg)) {
        Write-Host '[错误] 现有 config.json 为空，为避免覆盖原配置已中止安装。' -ForegroundColor Red
        if (-not $NonInteractive) { Read-Host '按回车键退出' }
        exit 4
    }
    try {
        $parsed = $rawCfg | ConvertFrom-Json
    } catch {
        Write-Host ('[错误] 现有 config.json 不是合法 JSON，已中止安装（未改动原文件）: ' + $_.Exception.Message) -ForegroundColor Red
        if (-not $NonInteractive) { Read-Host '按回车键退出' }
        exit 4
    }
    if ($null -eq $parsed -or $parsed -is [System.Array] -or -not ($parsed -is [PSCustomObject])) {
        Write-Host '[错误] 现有 config.json 根节点不是 JSON 对象，已中止安装。' -ForegroundColor Red
        if (-not $NonInteractive) { Read-Host '按回车键退出' }
        exit 4
    }
    foreach ($p in $parsed.PSObject.Properties) { $cfg[$p.Name] = $p.Value }
}

# 合并 plugins["antigravity-token-meter"]
$pluginsMap = [ordered]@{}
if ($cfg.Contains('plugins') -and $null -ne $cfg['plugins']) {
    if (-not ($cfg['plugins'] -is [PSCustomObject])) {
        Write-Host '[错误] config.json 中 plugins 字段类型异常，已中止安装。' -ForegroundColor Red
        exit 4
    }
    foreach ($p in $cfg['plugins'].PSObject.Properties) { $pluginsMap[$p.Name] = $p.Value }
}
$pluginEntry = [ordered]@{}
if ($pluginsMap.Contains('antigravity-token-meter') -and ($null -ne $pluginsMap['antigravity-token-meter'])) {
    if (-not ($pluginsMap['antigravity-token-meter'] -is [PSCustomObject])) {
        Write-Host '[错误] config.json 中 plugins["antigravity-token-meter"] 类型异常，已中止安装。' -ForegroundColor Red
        exit 4
    }
    foreach ($p in $pluginsMap['antigravity-token-meter'].PSObject.Properties) { $pluginEntry[$p.Name] = $p.Value }
}
$pluginEntry['enabled'] = $true
$pluginsMap['antigravity-token-meter'] = $pluginEntry

# 若存在旧版 antigravity-pulse，可选停用防重影（默认 N，需显式输入 Y 或传 -DisableLegacyPulse）
if ($pluginsMap.Contains('antigravity-pulse')) {
    $disableOld = [bool]$DisableLegacyPulse
    if (-not $disableOld -and -not $NonInteractive) {
        $ans = Read-Host '检测到旧版 antigravity-pulse 插件，是否同时停用它以避免底部状态条重复？[推荐输入 y 后回车] (y/N，直接回车默认保留)'
        if ($ans -match '^[Yy]$') { $disableOld = $true }
    }
    if ($disableOld) {
        $oldEntry = [ordered]@{}
        if ($pluginsMap['antigravity-pulse'] -is [PSCustomObject]) {
            foreach ($p in $pluginsMap['antigravity-pulse'].PSObject.Properties) { $oldEntry[$p.Name] = $p.Value }
        }
        $oldEntry['enabled'] = $false
        $pluginsMap['antigravity-pulse'] = $oldEntry
        Write-Host '      已停用旧版 antigravity-pulse。' -ForegroundColor Green
    }
}
$cfg['plugins'] = $pluginsMap

# 关键修复 (P0-01)：显式合并启用 sidecars["antigravity-token-meter/meter"]，保留既有 projectId 等字段
$sidecarsMap = [ordered]@{}
if ($cfg.Contains('sidecars') -and $null -ne $cfg['sidecars']) {
    if (-not ($cfg['sidecars'] -is [PSCustomObject])) {
        Write-Host '[错误] config.json 中 sidecars 字段类型异常，已中止安装。' -ForegroundColor Red
        exit 4
    }
    foreach ($p in $cfg['sidecars'].PSObject.Properties) { $sidecarsMap[$p.Name] = $p.Value }
}
$scEntry = [ordered]@{}
if ($sidecarsMap.Contains('antigravity-token-meter/meter') -and ($null -ne $sidecarsMap['antigravity-token-meter/meter'])) {
    if (-not ($sidecarsMap['antigravity-token-meter/meter'] -is [PSCustomObject])) {
        Write-Host '[错误] config.json 中 sidecars["antigravity-token-meter/meter"] 类型异常，已中止安装。' -ForegroundColor Red
        exit 4
    }
    foreach ($p in $sidecarsMap['antigravity-token-meter/meter'].PSObject.Properties) { $scEntry[$p.Name] = $p.Value }
}
$scEntry['enabled'] = $true
$sidecarsMap['antigravity-token-meter/meter'] = $scEntry
$cfg['sidecars'] = $sidecarsMap

# 4. 读取既有设置并决定是否开启实验性底部内嵌模式（非交互升级默认保留既有 inline 设置，除非显式传参）
$SettingsFile = Join-Path $ConfigDir 'settings.json'
$existingInline = $null
if (Test-Path -LiteralPath $SettingsFile) {
    try {
        $prevSet = ([System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
        if ($prevSet -is [PSCustomObject] -and $null -ne $prevSet.inline) {
            $existingInline = [bool]$prevSet.inline
        }
    } catch {}
}
$inlineEnabled = if ($EnableInline) {
    $true
} elseif ($DisableInline) {
    $false
} elseif ($NonInteractive -and $null -ne $existingInline) {
    $existingInline
} else {
    $false
}
if (-not $EnableInline -and -not $DisableInline -and -not $NonInteractive) {
    Write-Host ''
    Write-Host '  [模式选择] TokenMeter 支持两种界面形态：' -ForegroundColor Cyan
    Write-Host '    - 默认侧边栏面板：零额外启动参数，随时可用；' -ForegroundColor White
    Write-Host '    - 实验性底部状态条内嵌：需通过本目录的专用启动器以 --remote-debugging-port=0 启动。' -ForegroundColor White
    Write-Host '      （提示：本地回环调试端口无独立认证，仅建议在个人信任设备开启；本安装器不会修改您现有的系统快捷方式）' -ForegroundColor Gray
    $inlineAns = Read-Host '是否开启聊天框底部透明状态条内嵌模式？[需要底部条请输入 y 后回车] (y/N，直接回车仅启用侧边栏)'
    $inlineEnabled = ($inlineAns -match '^[Yy]$')
}

# 5. 安全部署插件本体（含 LICENSE）：采用原地文件覆盖 + 独立备份，避免因残留进程占用工作目录导致 Move-Item 目录嵌套
Write-Host '[3/4] 正在部署 TokenMeter 插件文件（含 MIT LICENSE）...' -ForegroundColor White
New-Item -ItemType Directory -Path $DstPluginsRoot -Force | Out-Null
$oldBackupDir = $null
try {
    if (Test-Path -LiteralPath $DstPlugin) {
        # 清理历史上因异常回滚可能残留的嵌套备份子目录
        Get-ChildItem -LiteralPath $DstPlugin -Directory -Filter '.antigravity-token-meter-prev-*' -ErrorAction SilentlyContinue | ForEach-Object {
            Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
        }
        $oldBackupDir = Join-Path $DstPluginsRoot ('.antigravity-token-meter-prev-' + $PID + '-' + [guid]::NewGuid().ToString('N').Substring(0,6))
        New-Item -ItemType Directory -Path $oldBackupDir -Force | Out-Null
        foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
            $oldItem = Join-Path $DstPlugin $item
            if (Test-Path -LiteralPath $oldItem) {
                Copy-Item -LiteralPath $oldItem -Destination $oldBackupDir -Recurse -Force
            }
        }
    } else {
        New-Item -ItemType Directory -Path $DstPlugin -Force | Out-Null
    }

    # 逐项覆盖复制到目标目录（使用 -LiteralPath 枚举，彻底兼容含 [ ] 方括号路径且无目录嵌套）
    foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
        $srcItem = Join-Path $SrcPlugin $item
        if (Test-Path -LiteralPath $srcItem -PathType Container) {
            $dstSub = Join-Path $DstPlugin $item
            New-Item -ItemType Directory -Path $dstSub -Force | Out-Null
            Get-ChildItem -LiteralPath $srcItem -Force | Copy-Item -Destination $dstSub -Recurse -Force
        } else {
            Copy-Item -LiteralPath $srcItem -Destination $DstPlugin -Force
        }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $DstPlugin 'LICENSE') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $DstPlugin 'sidecars\meter\main.mjs') -PathType Leaf)) {
        throw '插件目标目录校验失败：缺少关键文件'
    }
    Write-Host ('      已安装至: ' + $DstPlugin) -ForegroundColor Green

    # 6. 无损合并本地 settings.json（保留已有 profile 等字段），并原子提交宿主 config.json
    Write-Host '[4/4] 正在写入本地偏好并提交宿主配置...' -ForegroundColor White
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    $SettingsFile = Join-Path $ConfigDir 'settings.json'
    $settingsObj = [ordered]@{}
    if (Test-Path -LiteralPath $SettingsFile) {
        try {
            $parsedSettings = ([System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)) | ConvertFrom-Json
            if ($parsedSettings -is [PSCustomObject]) {
                foreach ($p in $parsedSettings.PSObject.Properties) { $settingsObj[$p.Name] = $p.Value }
            }
        } catch {}
    }
    $settingsObj['enabled'] = $true
    $settingsObj['inline'] = [bool]$inlineEnabled
    Write-AtomicUtf8 $SettingsFile (($settingsObj | ConvertTo-Json -Depth 20) + "`n")

    $PrefsFile = Join-Path $ConfigDir 'preferences.json'
    if (-not (Test-Path -LiteralPath $PrefsFile)) {
        Write-AtomicUtf8 $PrefsFile "{`n  `"language`": `"zh-CN`",`n  `"theme`": `"swiss`",`n  `"showSpeed`": true,`n  `"showCache`": true,`n  `"showContext`": true,`n  `"showQuota`": true,`n  `"showToday`": false,`n  `"showMonth`": true,`n  `"showCost`": false,`n  `"version`": 1`n}`n"
    }

    if (Test-Path -LiteralPath $ConfigJsonFile) {
        $cfgBakDir = Join-Path $ConfigDir 'config-backups'
        New-Item -ItemType Directory -Path $cfgBakDir -Force | Out-Null
        $randTag = [guid]::NewGuid().ToString('N').Substring(0,8)
        $cfgBak = Join-Path $cfgBakDir ('config-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + $randTag + '.json')
        Copy-Item -LiteralPath $ConfigJsonFile -Destination $cfgBak
    }
    Write-AtomicUtf8 $ConfigJsonFile (($cfg | ConvertTo-Json -Depth 100) + "`n")

    # 整体提交成功后才清理旧插件备份目录
    if ($oldBackupDir -and (Test-Path -LiteralPath $oldBackupDir)) {
        Remove-Item -LiteralPath $oldBackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
} catch {
    # 任意步骤失败按文件原位恢复，严禁对已存在目录使用 Move-Item 引发嵌套
    if ($oldBackupDir -and (Test-Path -LiteralPath $oldBackupDir)) {
        New-Item -ItemType Directory -Path $DstPlugin -Force -ErrorAction SilentlyContinue | Out-Null
        foreach ($item in @('assets', 'sidecars', 'plugin.json', 'LICENSE')) {
            $bakItem = Join-Path $oldBackupDir $item
            if (Test-Path -LiteralPath $bakItem -PathType Container) {
                $dstSub = Join-Path $DstPlugin $item
                New-Item -ItemType Directory -Path $dstSub -Force -ErrorAction SilentlyContinue | Out-Null
                Get-ChildItem -LiteralPath $bakItem -Force -ErrorAction SilentlyContinue | Copy-Item -Destination $dstSub -Recurse -Force -ErrorAction SilentlyContinue
            } elseif (Test-Path -LiteralPath $bakItem -PathType Leaf) {
                Copy-Item -LiteralPath $bakItem -Destination $DstPlugin -Force -ErrorAction SilentlyContinue
            }
        }
        Remove-Item -LiteralPath $oldBackupDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    throw
}
Write-Host '      已在 config.json 中同时启用 plugin 与 sidecar！' -ForegroundColor Green

Write-Host ''
Write-Host '================================================================' -ForegroundColor Green
Write-Host '  Antigravity TokenMeter v1.2.13 安装完成！' -ForegroundColor Green
Write-Host '================================================================' -ForegroundColor Green
Write-Host ''
if ($inlineEnabled) {
    Write-Host '  - 如需使用【底部内嵌状态条】：请双击本目录的「启动Antigravity(带Token监控).bat」打开 Antigravity；' -ForegroundColor Yellow
    Write-Host '  - 若平时使用自定义代理/汉化启动脚本，在该脚本的 Antigravity.exe 启动参数末尾加上 --remote-debugging-port=0；' -ForegroundColor Gray
    Write-Host '  - 如需核验状态，可随时双击「一键诊断内嵌状态(Windows).bat」。' -ForegroundColor Gray
} else {
    Write-Host '  - 当前已配置为【纯侧边栏面板模式】，直接正常启动 Antigravity 即可在侧边栏打开 TokenMeter。' -ForegroundColor Cyan
}
Write-Host ''
if (-not $NonInteractive) { Read-Host '按回车键关闭窗口' }
