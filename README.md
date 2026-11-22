# Antigravity TokenMeter (`v1.2.16`)

> **开源协议：MIT License** · **零外部依赖（Node.js 标准库 + 原生前端）** · **不修改 `app.asar`** · **兼容 Antigravity 2.33+ / 2.34+**  
> 为 Google Antigravity 桌面版打造的实时 Token 速率、Prompt Cache 保鲜度、无级上下文圆环、全维度精准费用估算、本月/历史用量总览与双周期（5h / 周）配额节奏监控插件。

---

## ⚠️ 重要必读：为什么装完没有立即热启动？怎么一键生效？

很多用户（或让 AI 帮忙安装时）遇到“装完没反应、重启还是没有底部状态条”，根因并不是插件坏了，而是 **Antigravity 2.33+ / 2.34+ 的两项宿主机制**：

1. **`config.json` 内存覆盖与冷加载机制**：Antigravity 的 `language_server` 在内存 `UserConfigStore` 中维护 `config.json` 快照。如果客户端正在运行（含最小化在系统托盘/Dock）时直接改写磁盘上的 `config.json`，不仅不会自动热拉起新 sidecar，还会在客户端退出或保存设置时被旧内存快照覆写回滚。
2. **托盘 / Dock 假退出与 Electron 单实例锁**：点击窗口右上角 `×` 默认只隐藏到系统托盘（Windows / Linux）或驻留 Dock（macOS），主进程并未真正退出。此时再打开带 `--remote-debugging-port=0` 的启动器，新参数会被 Electron 单实例锁直接吞掉，导致底部状态条无法连接调试端口。

### ✅ 一键生效正确姿势

- **Windows（最省心）**：完整解压压缩包后，直接双击 **`一键安装插件(Windows双击运行).bat`**。
  - 若检测到 Antigravity 正在运行，按提示直接回车即可**一键优雅关闭旧实例（自动保留原有代理/自定义启动参数）→ 按官方规范写入配置 → 自动带 `--remote-debugging-port=0` 重新拉起并校验 `DevToolsActivePort` 就绪**，装完直接看到底部状态条生效！
- **macOS / Linux**：在解压目录执行 `bash scripts/install_mac_linux.sh`。
  - 若检测到客户端正在运行，交互模式回车确认（或追加 `--restart`）即可**优雅退出 → 写入配置 → 自动重启并校验调试端口**；也可先手动彻底退出（macOS 按 `Cmd+Q`，Linux 右键托盘点退出）后再运行安装脚本与独立启动器。
- **开箱零配置体验**：即使直接把 `antigravity-token-meter` 目录放入 `~/.gemini/config/plugins/` 并在客户端 Customizations 开启（没有生成 `settings.json`），插件也默认智能启用完整模式（`enabled: true, inline: true`）；如需纯侧边栏模式，可随时在 `settings.json` 设置 `"inline": false` 或设置环境变量 `AG_TM_INLINE=false`。

---

## 核心特性

- **原生融入聊天输入框底栏的透明状态条（默认完整模式 / 可切纯侧边栏）**：通过 CDP Isolated World（隔离世界）与 `closed` Shadow DOM 精准嵌入输入框底栏工具条（紧贴右侧权限按钮左侧齐平；内建 `ResizeObserver` 与四级渐进响应式 `full → compact → tight(+N) → mini`，缩窄聊天框时自动精简标签或收纳进 `+N` 溢出胶囊，**始终稳稳留在底栏内绝不掉到输入框下方**），全透明无边框、极细竖向发丝分隔，原地骨架复用更新不闪烁：
  - **一格一卡、按需聚焦弹出**：悬停或点击底栏任意一格（速率 / 缓存命中 / 上下文 / 模型额度 / 今日用量 / 本月用量），仅在该格正上方弹出对应模块的精简卡片（如速率走势、缓存与 Token 构成、上下文容量条、双轨配额 Pace Tick、今日分模型分布、近 14 天每日柱状图），避免全量长弹窗遮挡视线；
  - **Gemini 标准内凹四角星（✦）**：按生成中 / 待机 / 离线自动切换克制微动效；
  - **0%–100% 无级连续跟进上下文圆环**：按真实浮点占比实时平滑推进与连续色阶渐变；
  - **极简双轨额度 `100/100`**：接入官方 `RetrieveUserQuotaSummary` 接口，左显 **5 小时额度**、右显 **周额度**（旧版自动无缝回退至 `GetUserStatus`）；
  - **本月用量直显、全维度精准费用对账 & 消耗总览**：支持按模型/阶段费率与 `>200k` 长上下文阶梯精准估算 API 费用（按日、按月、按模型与累计总费用严格闭合对账）；悬停浮卡、侧边栏面板与全屏弹窗均提供 **今日 / 近 7 天 / 本月 / 累计总量** 4 栏消耗总览与 **近 16 周每日热力图**。
- **跨平台高品质中文字体渲染**：全套主题统一配置 `PingFang SC / Hiragino Sans GB / Microsoft YaHei UI / Source Han Sans SC / Noto Sans CJK SC` 简体中文无衬线与等宽字体栈并自动同步 `lang="zh-CN" / "en"`，彻底根治日文异体字混排与点阵宋体锯齿。
- **自动历史会话回填 & 旧账本无损迁移**：
  - 首次启动持有写租约时后台温和扫描近 120 天本地历史对话自动补齐本月与 16 周用量；
  - 内置零依赖通用导入工具 `scripts/import_legacy_usage.mjs`，支持将本机旧版 `usage-v1` 历史数据按 `id` 去重无损导入（自动备份原账本、水位线防双倍记账、运行中自动写入 `pending-import.json` 防旧进程刷盘覆盖）。
- **三套精选零 AI 味视觉主题一键切换**（浅/深色自适应并同步持久化）：
  - **瑞士精密（`Swiss`）**：纯白 / 纯炭黑高对比材质、27px 主速率 Hero 读数、1px 发丝线与单色热力图；
  - **液态磨砂（`Glass`）**：macOS 原生 `blur(22px) saturate(180%)` 通透毛玻璃浮层；
  - **极客终端（`Mono`）**：全等宽字体 + 5px 利落直角 + 经典翠绿磷光刻度。
- **配额节奏时间基准线（Pace Tick）**：在 5h 与周双轨 3.5px 进度条上标出当前窗口剩余时间基准竖线，对照一眼判断当前是“节奏充裕”还是“消耗偏快”。
- **Prompt Cache 保鲜与思考占比**：追踪距上次请求的缓存温热/渐冷状态、实际免重算 Token 总量、Token 构成 Stacked 比例微条、Thinking 思考占比与上下文预估剩余轮次；支持**一键复制脱敏遥测摘要**。
- **应用层代理绕过、崩溃自诊断与 7 项一键自愈**：本地 `language_server` 与 CDP 连接均使用原生回环 TCP（`agent: false` / 自定义 RFC 6455 客户端，IPv4/IPv6 双栈回退），不受代理环境变量干扰；Sidecar 启动异常时自动将精确原因写入 `integration-status.json`，配合 7 项健康诊断与 `-Fix` / `--fix` 一键修复。

---

## 快速安装

### Windows

1. 在 **Releases** 下载 `Antigravity-TokenMeter_v1.2.16.zip` 并**完整解压到常规文件夹**（切勿在压缩包预览窗口内直接双击 `.bat`）。
2. 双击运行 **`一键安装插件(Windows双击运行).bat`**：
   - 自动检测运行中或驻留托盘的 `Antigravity.exe`：交互确认后可**一键优雅关闭旧实例（保留原代理参数）→ 安装 → 自动以调试模式重启拉起**；
   - 自动部署插件与 `MIT LICENSE`，按 Antigravity 2.33+/2.34+ 官方规范在 `config.json` 中**同步启用 `plugins["antigravity-token-meter"]` 与 `sidecars["antigravity-token-meter/meter"]`**（含 `schemaVersion`、`resolvedPermissions`，无损保留已有 `projectId` 与其他全部配置；遇到损坏 JSON 自动备份并优先从最近有效备份恢复）；
   - 自动检测旧版 `antigravity-pulse` 并支持一键停用以防底部条重影；
   - **默认启用完整体验（侧边栏 + 底部内嵌状态条）**，回车即可直通，也可选择 `[2]` 切换为纯侧边栏模式；**不会擅自改写您原有的桌面/开始菜单/任务栏快捷方式**。
3. 日常启动 Antigravity：
   - **完整模式（含底部内嵌状态条）**：双击 **`启动Antigravity(带Token监控).bat`**（若后台残留无调试端口的托盘实例，启动器会自动拦截并引导一键安全重启，启动后自动校验 `DevToolsActivePort` 就绪）；如您使用自定义代理脚本，只需在 `Antigravity.exe` 启动参数末尾追加 `--remote-debugging-port=0`；
   - **纯侧边栏模式**：正常打开 Antigravity 即可。

> **Windows 命令行常用参数（供高级用户 / 自动化脚本）**：
> ```powershell
> # 非交互安装（停用旧版 pulse，不自动重启）
> powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NonInteractive -DisableLegacyPulse
> # 非交互安装 + 自动优雅重启拉起（带调试端口）
> powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NonInteractive -DisableLegacyPulse -AutoRestart
> # 仅启用侧边栏模式
> powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -DisableInline
> # 专用启动器（检测到无调试端口实例时自动安全重启）
> powershell -ExecutionPolicy Bypass -File scripts\launch.ps1 -RestartIfRunning
> # 7 项健康诊断 / JSON 输出 / 一键自动修复
> powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1
> powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1 -NonInteractive -Json
> powershell -ExecutionPolicy Bypass -File scripts\doctor.ps1 -Fix
> # 反向事务卸载（默认保留历史账本，追加 -PurgeData 清除全部数据）
> powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1
> ```

### macOS / Linux

> Antigravity 2.33+ 内置 `agy-node` 运行时。本安装脚本优先使用 `node`，若机器未安装全局 Node.js 会自动无缝回退至 `python3`，无需为了安装插件额外折腾 Node 环境。

```bash
# 默认安装（首次开启完整模式：侧边栏 + 底部内嵌状态条；升级保留既有模式）
bash scripts/install_mac_linux.sh

# 若 Antigravity 正在运行，优雅退出、写入配置并自动重启拉起（一键生效）
bash scripts/install_mac_linux.sh --restart

# 仅启用纯侧边栏面板模式（零额外启动参数）
bash scripts/install_mac_linux.sh --sidebar-only

# 7 项健康诊断 / 机器可读 JSON / 一键自动修复
bash scripts/install_mac_linux.sh --doctor
bash scripts/install_mac_linux.sh --doctor --json
bash scripts/install_mac_linux.sh --fix
```

启用底部内嵌状态条后，脚本会自动生成防单实例锁吞参数、带 `DevToolsActivePort` 校验的独立启动器（**绝不修改系统原入口**）：
- **macOS**：`~/Library/Application Support/AntigravityTokenMeter/launch-antigravity-token-meter.command`（双击即可；支持终端附加 `--restart` 安全重启）；
- **Linux**：`~/.local/share/AntigravityTokenMeter/launch-antigravity-token-meter.sh` 与应用菜单入口 `~/.local/share/applications/antigravity-token-meter.desktop`。

---

## 🤖 交给 AI 帮你安装时的标准步骤

如果您把本仓库或压缩包交给手头的 AI 助手（Claude Code / Codex / Cursor / Antigravity 等）协助安装，请直接让 AI 按以下标准流程执行，可 **100% 一次成功、避免漏配或配置被覆盖**：

### 1. 优先直接调用官方安装与修复脚本（不要手写残缺 JSON）

- **第一步：确保 Antigravity 已彻底退出**（Windows/Linux 右键系统托盘点退出，macOS 按 `Cmd+Q`），避免退出时内存快照覆写 `config.json`。
- **第二步：执行非交互安装命令**：
  - **Windows**：
    ```powershell
    powershell -ExecutionPolicy Bypass -File scripts\install.ps1 -NonInteractive -DisableLegacyPulse
    ```
    （若用户明确授权自动重启客户端，可追加 `-AutoRestart`）
  - **macOS / Linux**：
    ```bash
    bash scripts/install_mac_linux.sh --non-interactive --disable-legacy-pulse
    ```
    （若用户明确授权自动重启客户端，可追加 `--restart`）
- **第三步：用专用启动器冷启动并跑 7 项验收**：
  - Windows：运行 `scripts\launch.ps1 -NonInteractive` 后执行 `scripts\doctor.ps1 -NonInteractive -Json` 核验 `ok: true`；异常可直接执行 `scripts\doctor.ps1 -Fix -NonInteractive`；
  - macOS / Linux：运行生成的独立启动器后执行 `bash scripts/install_mac_linux.sh --doctor --json` 核验 `ok: true`；异常可直接执行 `bash scripts/install_mac_linux.sh --fix --non-interactive`。

### 2. 若需手动编辑 `~/.gemini/config/config.json`，必须严守 4 条红线

1. **禁止热改盘**：严禁在 Antigravity 进程（含托盘/Dock 后台进程）存活时直接覆写 `config.json`；
2. **双字段完整注册**：必须同时合并写入 `plugins["antigravity-token-meter"]` 与 `sidecars["antigravity-token-meter/meter"]`（保留其他全部插件与设置）：
   ```json
   {
     "plugins": {
       "antigravity-token-meter": {
         "enabled": true
       }
     },
     "sidecars": {
       "antigravity-token-meter/meter": {
         "enabled": true,
         "schemaVersion": 1,
         "resolvedPermissions": {}
       }
     }
   }
   ```
3. **严禁伪造 `projectId`**：`sidecars["antigravity-token-meter/meter"]` 若原本已有 `projectId` 必须原样保留；**首次安装缺省时必须省略，切勿填写随机 UUID**（否则宿主 `SidecarManager` 校验项目文件不存在时会报 `unreadable project` 导致启动失败）；
4. **不要漏掉调试端口冷启动**：插件默认零配置开启底部状态条，但需要 Antigravity 主进程冷启动时携带 `--remote-debugging-port=0` 才能注入底栏（侧边栏面板无需该参数）。

---

## 常见问题排查与一键自愈（Doctor & Fix）

遇到侧边栏打不开、底部状态条不显示或启动异常时：

- **Windows**：直接双击 **`一键诊断内嵌状态(Windows).bat`**（检出可修复项时直接回车即可一键自动修复；也可运行 `scripts\doctor.ps1 -Fix`）；
- **macOS / Linux**：执行 `bash scripts/install_mac_linux.sh --doctor` 查看 7 项明细，或直接运行 `bash scripts/install_mac_linux.sh --fix` 自动修复。

7 项健康检查会精准定位以下常见故障：

1. **插件核心文件缺失或未完整解压**：自动提示并可由 `--fix` / `-Fix` 重新部署。
2. **漏启用 `sidecars` 或缺少官方字段 / `config.json` 损坏**：自动先备份原件至 `config-backups/`，优先从最近有效备份恢复或安全重建，并补齐 `plugins` 与 `sidecars` 官方注册项（绝不伪造 `projectId`）。
3. **旧版 `antigravity-pulse` 冲突重影**：自动预警并支持一键停用旧插件与旧 sidecar。
4. **本地 `settings.json` 损坏或启动器缺失**：自动备份重建 `{"enabled": true, "inline": true}` 并补建独立启动器。
5. **系统托盘 / Dock 残留进程吞掉启动参数**：明确识别未携带 `--remote-debugging-port` 的主进程，引导一键安全重启。
6. **`DevToolsActivePort` 缺失或过期**：零代理直连核验本机回环调试端口是否真实可达。
7. **Sidecar 启动异常精准透出**：若发生 `sdk_not_found`、`missing_env`、`missing_assets`、`server_listen_failed` 或 `fatal_error`，直接展示 `integration-status.json` 落盘的真实错误码与原因，彻底告别黑盒静默失败。

---

## 安全与隐私边界说明

- **实验性内嵌模式的安全边界**：`--remote-debugging-port=0` 仅监听本机回环随机端口，但不具备独立访问认证；任何同机本地进程若具备访问权限理论上均可连接该端口。因此本工具**不会批量修改您的既有系统快捷方式**，仅通过您显式运行独立启动器启用，且可在 `settings.json` 中随时设置 `"inline": false`（或 `AG_TM_INLINE=false`）切换回纯侧边栏安全模式。
- **数据分类边界**：
  1. **内存读取**：调用本机 `language_server` 接口获取请求元数据、模型配置与配额摘要后，立即投影为脱敏数值与模型标签，不长期保留原始完整响应；
  2. **本地持久化**：账本仅存储按日期与模型聚合的 Token 计数、精确估算费用、流式耗时与经过单向 SHA-256 哈希处理的去重键，不保存对话正文、Prompt、邮箱或凭据；
  3. **向页面输出**：通过 CDP Isolated World 隔离世界仅向本地主文档投递脱敏统计 JSON，不在宿主默认全局世界暴露桥接 API；一键复制摘要同样严格零账号/零会话 ID。

---

## 迁移旧版历史用量记录（可选）

如果您曾在本机使用过旧版用量监控插件并留有本地历史数据，可一键将其无损导入 TokenMeter（自动兼容 Windows / macOS / Linux 路径与最新 Thinking/费用口径，不会修改旧数据目录，写入前自动备份当前账本且支持幂等防重）：

```bash
# 仅预览统计结果（不写入）
node scripts/import_legacy_usage.mjs --dry-run

# 执行无损导入（若 Antigravity 正在运行，会自动写入 pending-import.json 于重启时原子吸纳）
node scripts/import_legacy_usage.mjs
```

---

## 开发者测试与只读预览

```bash
# 运行全部单元测试
node --test antigravity-token-meter/sidecars/meter/tests/*.test.mjs

# 显式启动本地只读预览（自动生成一次性随机 Token）
node antigravity-token-meter/sidecars/meter/main.mjs --preview
```

## 开源许可

本项目采用 [MIT License](./LICENSE) 开源。
