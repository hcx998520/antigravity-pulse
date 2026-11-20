param(
    [switch]$NonInteractive,
    [switch]$Json
)
$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
if (-not $Json) {
    try { $Host.UI.RawUI.WindowTitle = 'Antigravity TokenMeter 6 项健康诊断工具' } catch {}
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host '   Antigravity TokenMeter 6 项内嵌与 Sidecar 健康诊断' -ForegroundColor Cyan
    Write-Host '================================================================' -ForegroundColor Cyan
    Write-Host ''
}

$HomeDir = if ($env:AG_TEST_HOME) { $env:AG_TEST_HOME } else { $env:USERPROFILE }
$AppDataDir = if ($env:APPDATA) { $env:APPDATA } else { Join-Path $HomeDir 'AppData\Roaming' }
$LocalDir = if ($env:AG_TEST_LOCAL) { $env:AG_TEST_LOCAL } elseif ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HomeDir 'AppData\Local' }

$PluginDir = Join-Path $HomeDir '.gemini\config\plugins\antigravity-token-meter'
$ConfigFile = Join-Path $HomeDir '.gemini\config\config.json'
$SettingsFile = Join-Path $LocalDir 'AntigravityTokenMeter\settings.json'
$StatusFile = Join-Path $HomeDir '.gemini\antigravity\sidecar_data\antigravity-token-meter\meter\data\integration-status.json'

$checks = @()
$failCount = 0

function Add-Check([string]$id, [string]$status, [string]$detail, [string]$hint = '') {
    $script:checks += [PSCustomObject]@{ id = $id; status = $status; detail = $detail; hint = $hint }
    if ($status -eq 'fail') { $script:failCount++ }
    if (-not $Json) {
        $color = switch ($status) { 'pass' { 'Green' } 'warn' { 'Yellow' } default { 'Red' } }
        Write-Host ("[$($status.ToUpper())] $id - $detail") -ForegroundColor $color
        if ($hint) { Write-Host ("       修复建议: $hint") -ForegroundColor Yellow }
    }
}

# 1. 插件包完整性（含 LICENSE 与 sidecar.json）
$pkgOk = (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\main.mjs') -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $PluginDir 'sidecars\meter\sidecar.json') -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $PluginDir 'plugin.json') -PathType Leaf) -and
         (Test-Path -LiteralPath (Join-Path $PluginDir 'LICENSE') -PathType Leaf)
if ($pkgOk) {
    Add-Check '1/6 插件文件' 'pass' '插件核心文件、sidecar.json 与 MIT LICENSE 完整'
} else {
    Add-Check '1/6 插件文件' 'fail' '插件目录缺失关键文件' '请先双击「一键安装插件(Windows双击运行).bat」重新部署。'
}

# 2 & 3. 分别校验 plugin 启用与 sidecar 启用，并显式识别 config.json 语法损坏或旧插件冲突
$cfgExists = Test-Path -LiteralPath $ConfigFile -PathType Leaf
$cfgCorrupt = $false
$pluginEnabled = $false
$sidecarEnabled = $false
$legacyPulseEnabled = $false
if ($cfgExists) {
    try {
        $rawCfg = [System.IO.File]::ReadAllText($ConfigFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        if ([string]::IsNullOrWhiteSpace($rawCfg)) {
            $cfgCorrupt = $true
        } else {
            $cfg = $rawCfg | ConvertFrom-Json
            if ($null -eq $cfg -or ($cfg -is [System.Array]) -or -not ($cfg -is [PSCustomObject])) {
                $cfgCorrupt = $true
            } else {
                if ($cfg.plugins.'antigravity-token-meter'.enabled -eq $true) { $pluginEnabled = $true }
                if ($cfg.sidecars.'antigravity-token-meter/meter'.enabled -eq $true) { $sidecarEnabled = $true }
                if ($cfg.plugins.'antigravity-pulse'.enabled -eq $true) { $legacyPulseEnabled = $true }
            }
        }
    } catch {
        $cfgCorrupt = $true
    }
}

if ($cfgCorrupt) {
    Add-Check '2/6 插件注册' 'fail' '宿主 config.json 为空或存在 JSON 语法损坏，无法读取插件状态' "可前往 $(Join-Path $LocalDir 'AntigravityTokenMeter\config-backups') 查找安装器自动备份的历史配置后恢复。"
    Add-Check '3/6 Sidecar 启用' 'fail' '因 config.json 格式损坏无法确认 sidecar 启用状态' '修复 config.json 后彻底退出 Antigravity 并重新运行安装器。'
} else {
    if ($pluginEnabled -and $legacyPulseEnabled) {
        Add-Check '2/6 插件注册' 'warn' '已启用 TokenMeter，但检测到旧版 antigravity-pulse 仍同时启用（可能导致底部条重复显示）' '建议彻底退出客户端后重新运行安装器，并在提示时输入 y 停用旧版 antigravity-pulse。'
    } elseif ($pluginEnabled) {
        Add-Check '2/6 插件注册' 'pass' 'config.json 已启用 plugins.antigravity-token-meter'
    } elseif (-not $cfgExists) {
        Add-Check '2/6 插件注册' 'fail' '尚未检测到宿主 config.json 配置文件' '请彻底退出 Antigravity 后双击运行「一键安装插件(Windows双击运行).bat」。'
    } else {
        Add-Check '2/6 插件注册' 'fail' 'config.json 中 plugins.antigravity-token-meter 未启用' '请彻底退出 Antigravity（含右下角托盘）后重新运行安装器，或在客户端 Customizations 中开启 TokenMeter。'
    }

    if ($sidecarEnabled) {
        Add-Check '3/6 Sidecar 启用' 'pass' 'config.json 已启用 sidecars["antigravity-token-meter/meter"]'
    } else {
        Add-Check '3/6 Sidecar 启用' 'fail' 'config.json 未启用 sidecars["antigravity-token-meter/meter"] 后台进程' '请彻底退出 Antigravity 后运行新版安装器自动补齐 sidecars 启用项。'
    }
}

# 读取本地实验内嵌开关、启用开关与自定义 Profile 路径（显式识别 settings.json 损坏或停用）
$inlineWanted = $false
$localEnabled = $true
$settingsCorrupt = $false
$customProfile = $null
if (Test-Path -LiteralPath $SettingsFile -PathType Leaf) {
    try {
        $rawSet = [System.IO.File]::ReadAllText($SettingsFile, [System.Text.Encoding]::UTF8).TrimStart([char]0xFEFF)
        $stSet = $rawSet | ConvertFrom-Json
        if ($null -eq $stSet -or ($stSet -is [System.Array]) -or -not ($stSet -is [PSCustomObject])) {
            $settingsCorrupt = $true
        } else {
            if ($stSet.enabled -eq $false) { $localEnabled = $false }
            if ($stSet.inline -eq $true) { $inlineWanted = $true }
            if ($stSet.profile -is [string] -and -not [string]::IsNullOrWhiteSpace($stSet.profile)) { $customProfile = $stSet.profile.Trim() }
        }
    } catch {
        $settingsCorrupt = $true
    }
}

$profileCandidates = @()
if ($env:AG_TM_PROFILE -and -not [string]::IsNullOrWhiteSpace($env:AG_TM_PROFILE)) { $profileCandidates += $env:AG_TM_PROFILE.Trim() }
if ($customProfile) { $profileCandidates += $customProfile }
$profileCandidates += (Join-Path $AppDataDir 'Antigravity')
$uniqueProfiles = @($profileCandidates | Select-Object -Unique)

# 4. 运行中主进程检查（兼容普通权限查询管理员进程 CommandLine 为空的场景）
$procQueryOk = $true
$allProcs = @()
$guiProcs = @()
try {
    $allProcs = @(Get-CimInstance Win32_Process -Filter "Name='Antigravity.exe'" -ErrorAction Stop)
    $guiProcs = @($allProcs | Where-Object {
        $_.CommandLine -and $_.CommandLine -notmatch 'sidecar_sdk|(?:^|\s)--type='
    })
} catch {
    $procQueryOk = $false
    Add-Check '4/6 主进程参数' 'fail' '无法查询本机进程列表（可能系统 WMI 服务异常或权限受限）' '可尝试以管理员身份打开 PowerShell 重新运行诊断。'
}

if ($procQueryOk) {
    if ($settingsCorrupt) {
        Add-Check '4/6 主进程参数' 'fail' '本地 settings.json 配置文件损坏，内嵌模式已被安全关闭' '请彻底退出 Antigravity 后重新运行「一键安装插件(Windows双击运行).bat」重建配置。'
    } elseif (-not $localEnabled) {
        Add-Check '4/6 主进程参数' 'warn' '本地 settings.json 中 enabled=false，插件当前处于停用状态' '如需恢复监控，请重新运行安装器开启插件。'
    } elseif ($allProcs.Count -eq 0) {
        Add-Check '4/6 主进程参数' 'warn' '未检测到运行中的 Antigravity 主界面' '请双击「启动Antigravity(带Token监控).bat」启动客户端。'
    } elseif ($guiProcs.Count -eq 0 -and ($allProcs | Where-Object { [string]::IsNullOrEmpty($_.CommandLine) }).Count -gt 0) {
        Add-Check '4/6 主进程参数' 'warn' '检测到管理员权限运行的 Antigravity，当前普通终端无法读取其启动命令行' '如需核验命令行参数，请右键以管理员身份运行诊断（下方第 5、6 项仍可直接验证实际端口与挂载状态）。'
    } elseif ($guiProcs | Where-Object { $_.CommandLine -match '(?:^|\s)--remote-debugging-port=\d+' }) {
        Add-Check '4/6 主进程参数' 'pass' 'Antigravity 主进程已携带 --remote-debugging-port 启动参数'
    } elseif (-not $inlineWanted) {
        Add-Check '4/6 主进程参数' 'pass' '当前为纯侧边栏模式（未开启实验内嵌，无需调试端口）'
    } else {
        Add-Check '4/6 主进程参数' 'fail' 'Antigravity 主进程未携带 --remote-debugging-port=0（常见于托盘旧进程未彻底退出）' '请右键右下角系统托盘 Antigravity 图标点击【退出】，再使用「启动Antigravity(带Token监控).bat」（或在自定义启动脚本中追加 --remote-debugging-port=0）启动。'
    }
}

# 5. 遍历全部候选 Profile 目录校验 DevToolsActivePort 与本地零代理连通性
if ($settingsCorrupt) {
    Add-Check '5/6 本地调试端口' 'fail' '因本地 settings.json 损坏跳过内嵌端口连接' '请重新运行安装器并在询问是否开启底部内嵌状态条时输入 y。'
} elseif (-not $inlineWanted) {
    Add-Check '5/6 本地调试端口' 'pass' '纯侧边栏模式无需检测本地 CDP 调试端口'
} else {
    $portFiles = @()
    foreach ($pDir in $uniqueProfiles) {
        $cand = Join-Path $pDir 'DevToolsActivePort'
        if (Test-Path -LiteralPath $cand -PathType Leaf) { $portFiles += $cand }
    }
    if ($portFiles.Count -eq 0) {
        Add-Check '5/6 本地调试端口' 'fail' '未在配置目录检测到 DevToolsActivePort 文件' '请确认已右键系统托盘彻底退出 Antigravity，再通过带 --remote-debugging-port=0 的专用启动器重新打开。'
    } else {
        $connectedPort = $null
        $pageCount = 0
        $lastPortErr = ''
        foreach ($pf in $portFiles) {
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
                    $connectedPort = [int]$portStr
                    try {
                        $targets = @($rawJson | ConvertFrom-Json)
                        $pageCount = @($targets | Where-Object { $_.type -eq 'page' -and $_.url -match '^https?://' }).Count
                    } catch {}
                    break
                } else {
                    $lastPortErr = "端口 $portStr 返回异常状态码 HTTP $code"
                }
            } catch {
                $lastPortErr = "端口文件对应端点不可达（可能为上次退出残留的过期端口）"
            }
        }
        if ($null -ne $connectedPort) {
            Add-Check '5/6 本地调试端口' 'pass' "DevToolsActivePort 连通正常 (port=$connectedPort, pages=$pageCount)"
        } else {
            Add-Check '5/6 本地调试端口' 'fail' "检测到 DevToolsActivePort 但无法连接：$lastPortErr" '请从系统托盘彻底退出 Antigravity，再用「启动Antigravity(带Token监控).bat」重新打开以刷新调试端口。'
        }
    }
}

# 6. 活实例 sidecar 与最新挂载状态核验（提供逐项可读中文释义与明确修复动作）
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
                if ($dt.Kind -eq [DateTimeKind]::Utc) {
                    $checkedUtc = $dt
                } elseif ($dt.Kind -eq [DateTimeKind]::Local) {
                    $checkedUtc = $dt.ToUniversalTime()
                } else {
                    $checkedUtc = [DateTime]::SpecifyKind($dt, [DateTimeKind]::Utc)
                }
            } elseif (-not [string]::IsNullOrWhiteSpace([string]$st.checkedAt)) {
                $checkedDto = [DateTimeOffset]::Parse(
                    [string]$st.checkedAt,
                    [System.Globalization.CultureInfo]::InvariantCulture,
                    [System.Globalization.DateTimeStyles]::RoundtripKind
                )
                $checkedUtc = $checkedDto.UtcDateTime
            }
            if ($null -ne $checkedUtc) {
                $ageSec = [Math]::Abs(([DateTime]::UtcNow - $checkedUtc).TotalSeconds)
            }
        }
        if (-not $pidAlive -or $ageSec -gt 30) {
            Add-Check '6/6 运行实例与挂载' 'fail' '状态文件已过期或对应 sidecar 后台进程未运行' '请确认客户端正在运行，并在 Antigravity 的 Customizations -> Plugins 中确认 TokenMeter 处于开启状态。'
        } elseif ($st.state -eq 'mounted') {
            Add-Check '6/6 运行实例与挂载' 'pass' "sidecar 存活且底部状态条已挂载 (windows=$($st.windows))"
        } elseif ($st.state -eq 'waiting_composer') {
            Add-Check '6/6 运行实例与挂载' 'warn' "sidecar 已连上主窗口 (windows=$($st.windows))，当前页面无聊天输入框，切回任意对话即自动显示底部状态条"
        } elseif (-not $inlineWanted -and ($st.state -eq 'disabled' -or $st.code -eq 'inline_disabled')) {
            Add-Check '6/6 运行实例与挂载' 'pass' 'sidecar 存活（纯侧边栏面板模式运行正常）'
        } else {
            $diagCode = if ($st.code) { [string]$st.code } else { [string]$st.state }
            switch ($diagCode) {
                'inline_disabled' {
                    Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 正在运行，但检测到内嵌或插件开关处于关闭状态 (inline_disabled)' '若刚修改设置请等待数秒或重启客户端；也可重新运行安装器开启底部内嵌模式。'
                }
                'starting' {
                    if ($ageSec -lt 8) {
                        Add-Check '6/6 运行实例与挂载' 'warn' 'sidecar 刚启动，正在初始化本地 Language Server 与窗口连接 (starting)' '请等待 3~5 秒后再次运行诊断确认挂载结果。'
                    } else {
                        Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 长时间停留在初始化阶段，未能确认宿主服务端口 (starting)' '请从系统托盘完全退出并重启一次 Antigravity。'
                    }
                }
                'no_active_port' {
                    Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 未找到 DevToolsActivePort 调试端口文件 (no_active_port)' '请右键右下角系统托盘彻底退出 Antigravity，再双击「启动Antigravity(带Token监控).bat」启动。'
                }
                'stale_port' {
                    Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 读取到的 DevToolsActivePort 调试端口已过期不可达 (stale_port)' '请从系统托盘彻底退出 Antigravity，再用专用启动器重新打开以生成新端口文件。'
                }
                'no_hub_page' {
                    Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 已连通本地调试端口，但尚未发现可挂载的 Antigravity 主界面窗口 (no_hub_page)' '请确认客户端主界面已完成加载（非最小化启动画面），等待数秒后重测。'
                }
                'cdp_unreachable' {
                    Add-Check '6/6 运行实例与挂载' 'fail' 'sidecar 暂时无法连接本地调试端口 (cdp_unreachable)' '侧边栏面板仍可正常查看；如需恢复底部状态条，请从托盘彻底退出并用专用启动器重启。'
                }
                default {
                    Add-Check '6/6 运行实例与挂载' 'fail' "sidecar 存活但底部条尚未挂载 (state=$($st.state), code=$diagCode)" '请从系统托盘彻底退出 Antigravity 后，通过「启动Antigravity(带Token监控).bat」重新启动。'
                }
            }
        }
    } catch {
        Add-Check '6/6 运行实例与挂载' 'fail' 'integration-status.json 状态文件解析失败' '请重启一次 Antigravity 让 sidecar 自动重新生成状态文件。'
    }
} else {
    Add-Check '6/6 运行实例与挂载' 'fail' '尚未检测到 TokenMeter sidecar 运行状态文件' '请确认第 2、3 项已通过，然后启动（或重启）Antigravity 客户端。'
}

if ($Json) {
    [PSCustomObject]@{ ok = ($failCount -eq 0); failures = $failCount; checks = $checks } | ConvertTo-Json -Depth 6
} else {
    Write-Host ''
    if ($failCount -eq 0) {
        Write-Host '全部关键诊断项通过！' -ForegroundColor Green
    } else {
        Write-Host "发现 $failCount 项异常，请按上方「修复建议」操作后重试。" -ForegroundColor Yellow
    }
    Write-Host ''
    if (-not $NonInteractive) { Read-Host '按回车键关闭窗口' }
}

if ($failCount -gt 0) { exit 1 } else { exit 0 }
