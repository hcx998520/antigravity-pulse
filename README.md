# Antigravity TokenMeter (`v1.2.15`)

> **开源协议：MIT License** · **零外部依赖（Node.js 标准库 + 原生前端）** · **不修改 `app.asar`**  
> 为 Google Antigravity 桌面版打造的实时 Token 速率、Prompt Cache 保鲜度、无级上下文圆环、本月/历史用量总览与双周期（5h / 周）配额节奏监控插件。

---

## 核心特性

- **原生融入聊天输入框底栏的透明状态条（可选实验内嵌）**：通过 CDP Isolated World（隔离世界）与 `closed` Shadow DOM 精准嵌入输入框底栏工具条（紧贴右侧权限按钮左侧齐平；内建 `ResizeObserver` 与四级渐进响应式 `full → compact → tight(+N) → mini`，缩窄聊天框时自动精简标签或收纳进 `+N` 溢出胶囊，**始终稳稳留在底栏内绝不掉到输入框下方**），全透明无边框、极细竖向发丝分隔，原地骨架复用更新不闪烁：
  - **一格一卡、按需聚焦弹出**：悬停或点击底栏任意一格（速率 / 缓存命中 / 上下文 / 模型额度 / 今日用量 / 本月用量），仅在该格正上方弹出对应模块的精简卡片（如速率走势、缓存与 Token 构成、上下文容量条、双轨配额 Pace Tick、今日分模型分布、近 14 天每日柱状图），避免全量长弹窗遮挡视线；
  - **Gemini 标准内凹四角星（✦）**：按生成中 / 待机 / 离线自动切换克制微动效；
  - **0%–100% 无级连续跟进上下文圆环**：按真实浮点占比实时平滑推进与连续色阶渐变；
  - **极简双轨额度 `100/100`**：接入官方 `RetrieveUserQuotaSummary` 接口，左显 **5 小时额度**、右显 **周额度**（旧版自动无缝回退至 `GetUserStatus`）；
  - **本月用量直显 & 消耗总览**：底栏支持直接显示 `本月 2.62B`（可在设置中自由开关），悬停浮卡、侧边栏面板与全屏弹窗均提供 **今日 / 近 7 天 / 本月 / 累计总量** 4 栏消耗总览与 **近 16 周每日热力图**。
- **自动历史会话回填 & 旧账本无损迁移**：
  - 首次启动持有写租约时后台温和扫描近 120 天本地历史对话自动补齐本月与 16 周用量；
  - 内置零依赖通用导入工具 `scripts/import_legacy_usage.mjs`，支持将本机旧版 `usage-v1` 历史数据按 `id` 去重无损导入（自动备份原账本、水位线防双倍记账、运行中自动写入 `pending-import.json` 防旧进程刷盘覆盖）。
- **三套精选零 AI 味视觉主题一键切换**（浅/深色自适应并同步持久化）：
  - **瑞士精密（`Swiss`）**：纯白 / 纯炭黑高对比材质、27px 主速率 Hero 读数、1px 发丝线与单色热力图；
  - **液态磨砂（`Glass`）**：macOS 原生 `blur(22px) saturate(180%)` 通透毛玻璃浮层；
  - **极客终端（`Mono`）**：全等宽字体 + 5px 利落直角 + 经典翠绿磷光刻度。
- **配额节奏时间基准线（Pace Tick）**：在 5h 与周双轨 3.5px 进度条上标出当前窗口剩余时间基准竖线，对照一眼判断当前是“节奏充裕”还是“消耗偏快”。
- **Prompt Cache 保鲜与思考占比**：追踪距上次请求的缓存温热/渐冷状态、实际免重算 Token 总量、Token 构成 Stacked 比例微条、Thinking 思考占比与上下文预估剩余轮次；支持**一键复制脱敏遥测摘要**。
- **侧边栏面板（默认零参数安全模式）**：通过 Antigravity 官方 `sidecar_sdk` 运行，无需额外启动参数即可随时使用，视觉风格、4 栏消耗总览、16 周热力图与配额节奏与底部浮卡完全一致。
- **应用层代理绕过与原子账本**：本地 `language_server` 与 CDP 连接均使用原生回环 TCP（`agent: false` / 自定义 RFC 6455 客户端），不受代理环境变量干扰；6 项健康诊断工具（Doctor）一键排查内嵌状态。

---

## 快速安装

### Windows

1. 在 **Releases** 下载 `Antigravity-TokenMeter_v1.2.15.zip` 并**完整解压**。
2. **先右键系统托盘中的 Antigravity 图标点击「退出」**（确保完全关闭，避免旧实例覆盖配置或吞掉启动参数）。
3. 双击运行 **`一键安装插件(Windows双击运行).bat`**：
   - 自动部署插件与 `MIT LICENSE`；
   - 自动在 `config.json` 中**同时启用插件与 `sidecars["antigravity-token-meter/meter"]`**（保留原有配置并生成带时间戳备份）；
   - **不会擅自改写您原有的桌面/开始菜单/任务栏快捷方式**；
   - 引导您选择“仅侧边栏面板”或“同时启用实验性底部内嵌状态条”。
4. 启动 Antigravity：
   - **纯侧边栏模式**：正常打开 Antigravity 即可；
   - **实验性底部内嵌模式**：双击本包自带的 **`启动Antigravity(带Token监控).bat`**（或在您自己的启动脚本末尾加上 `--remote-debugging-port=0`）。

### macOS / Linux

```bash
# 默认安装（仅启用侧边栏面板）
bash scripts/install_mac_linux.sh

# 安装并启用实验性底部内嵌状态条（会生成独立启动器，不修改原 .desktop）
bash scripts/install_mac_linux.sh --enable-inline
```

---

## 常见问题排查（为什么装完没看到底部状态条？）

直接双击 **`一键诊断内嵌状态(Windows).bat`**（支持 `-Json` 输出），它会逐项报告问题所在：

1. **旧版安装未启用 `sidecars` 注册项**：Antigravity 区分插件与 sidecar，须在 `config.json` 中同时启用 `plugins["antigravity-token-meter"]` 与 `sidecars["antigravity-token-meter/meter"]`。请彻底退出客户端后重跑本版安装器。
2. **系统托盘残留进程**：点击窗口右上角 `X` 默认不会退出 Antigravity。若托盘仍有旧进程，再次打开启动器时 Electron 单实例锁会忽略新的 `--remote-debugging-port=0` 参数。请务必从系统托盘完全退出后再用专用启动器启动。
3. **实际启动入口未带调试参数**：如使用自定义代理脚本或汉化恢复脚本，请确保实际执行的 `Antigravity.exe` 命令行带有 `--remote-debugging-port=0`。

---

## 安全与隐私边界说明

- **实验性内嵌模式的安全边界**：`--remote-debugging-port=0` 仅监听本机回环随机端口，但不具备独立访问认证；任何同机本地进程若具备访问权限理论上均可连接该端口。因此本工具**不会批量修改您的既有系统快捷方式**，仅通过您显式双击独立启动器启用，且可在 `settings.json` 中随时关闭 `inline: false`。
- **数据分类边界**：
  1. **内存读取**：调用本机 `language_server` 接口获取请求元数据、模型配置与配额摘要后，立即投影为脱敏数值与模型标签，不长期保留原始完整响应；
  2. **本地持久化**：账本仅存储按日期与模型聚合的 Token 计数、流式耗时与经过单向 SHA-256 哈希处理的去重键，不保存对话正文、Prompt、邮箱或凭据；
  3. **向页面输出**：通过 CDP Isolated World 隔离世界仅向本地主文档投递脱敏统计 JSON，不在宿主默认全局世界暴露桥接 API；一键复制摘要同样严格零账号/零会话 ID。

---

## 迁移旧版历史用量记录（可选）

如果您曾在本机使用过旧版用量监控插件并留有本地历史数据，可一键将其无损导入 TokenMeter（不会修改旧数据目录，写入前自动备份当前账本且支持幂等防重）：

```bash
# 仅预览统计结果（不写入）
node scripts/import_legacy_usage.mjs --dry-run

# 执行无损导入（若 Antigravity 正在运行，会自动写入 pending-import.json 于重启时吸纳）
node scripts/import_legacy_usage.mjs
```

---

## 开发者测试与只读预览

```bash
# 运行全部 17 项单元测试
node --test antigravity-token-meter/sidecars/meter/tests/*.test.mjs

# 显式启动本地只读预览（自动生成一次性随机 Token）
node antigravity-token-meter/sidecars/meter/main.mjs --preview
```

## 开源许可

本项目采用 [MIT License](./LICENSE) 开源。
