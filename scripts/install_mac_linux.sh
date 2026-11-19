#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${HOME:-}" || "${HOME:0:1}" != "/" ]]; then
  echo "[错误] 无效的 HOME 环境变量，已中止安装。"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_PLUGIN="$ROOT_DIR/antigravity-token-meter"

for req in plugin.json LICENSE assets/logo.svg sidecars/meter/sidecar.json sidecars/meter/main.mjs; do
  if [[ ! -f "$SRC_PLUGIN/$req" ]]; then
    echo "[错误] 安装包不完整，缺少: $SRC_PLUGIN/$req"
    exit 1
  fi
done

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 未检测到 node 命令。请先安装 Node.js >= 20。"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  echo "[错误] 需要 Node.js >= 20（当前为 $(node -v)）。"
  exit 1
fi

INLINE_MODE="preserve"
for arg in "$@"; do
  if [[ "$arg" == "--enable-inline" ]]; then
    INLINE_MODE="true"
  elif [[ "$arg" == "--disable-inline" ]]; then
    INLINE_MODE="false"
  fi
done

OS_NAME="$(uname -s)"
if [[ -z "${AG_TEST_HOME:-}" ]]; then
  if pgrep -x "Antigravity" >/dev/null 2>&1 || pgrep -f "/Antigravity\.app/Contents/MacOS/Antigravity" >/dev/null 2>&1; then
    echo "[错误] 检测到 Antigravity 主界面正在运行，请先彻底退出客户端后再安装，以免退出时覆盖 config.json。"
    exit 3
  fi
fi

if [[ "$OS_NAME" == "Darwin" ]]; then
  CFG_DIR="$HOME/Library/Application Support/AntigravityTokenMeter"
else
  CFG_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/AntigravityTokenMeter"
fi

# 1. 先预校验 config.json 与 staging 目录，避免首次安装校验失败留下半安装残留
DST_ROOT="$HOME/.gemini/config/plugins"
DST_PLUGIN="$DST_ROOT/antigravity-token-meter"
CFG_JSON="$HOME/.gemini/config/config.json"
mkdir -p "$DST_ROOT" "$CFG_DIR/config-backups" "$(dirname "$CFG_JSON")"
STAGE_DIR="$DST_ROOT/.antigravity-token-meter-stage-$$"
PREV_DIR="$DST_ROOT/.antigravity-token-meter-prev-$$"
HAD_PREV="false"
DEPLOYED="false"
rm -rf "$STAGE_DIR" "$PREV_DIR"

rollback() {
  rm -rf "$STAGE_DIR"
  rm -f "$CFG_DIR"/.tm-set-$$-*.tmp "$(dirname "$CFG_JSON")"/.tm-cfg-$$-*.tmp 2>/dev/null || true
  if [[ "$HAD_PREV" == "true" && -d "$PREV_DIR" ]]; then
    rm -rf "$DST_PLUGIN"
    mv "$PREV_DIR" "$DST_PLUGIN"
  elif [[ "$DEPLOYED" == "true" && "$HAD_PREV" == "false" ]]; then
    rm -rf "$DST_PLUGIN"
  fi
}
trap rollback ERR

# 先校验 config.json 合法性，未通过则立即中止（不改动任何插件目录）
node -e '
const fs = require("fs");
const cfgPath = process.argv[1];
function isPlainObj(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }
if (!fs.existsSync(cfgPath)) process.exit(0);
const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
if (!raw.trim()) { console.error("[错误] 现有 config.json 为空，已中止安装。"); process.exit(4); }
let cfg;
try { cfg = JSON.parse(raw); } catch (e) { console.error("[错误] config.json 不是合法 JSON:", e.message); process.exit(4); }
if (!isPlainObj(cfg)) { console.error("[错误] config.json 根节点必须为 JSON 对象。"); process.exit(4); }
if (cfg.plugins !== undefined && !isPlainObj(cfg.plugins)) { console.error("[错误] plugins 字段类型异常"); process.exit(4); }
if (cfg.sidecars !== undefined && !isPlainObj(cfg.sidecars)) { console.error("[错误] sidecars 字段类型异常"); process.exit(4); }
if (cfg.plugins?.["antigravity-token-meter"] !== undefined && !isPlainObj(cfg.plugins["antigravity-token-meter"])) {
  console.error("[错误] plugins.antigravity-token-meter 字段类型异常"); process.exit(4);
}
if (cfg.sidecars?.["antigravity-token-meter/meter"] !== undefined && !isPlainObj(cfg.sidecars["antigravity-token-meter/meter"])) {
  console.error("[错误] sidecars[\"antigravity-token-meter/meter\"] 字段类型异常"); process.exit(4);
}
' "$CFG_JSON"

mkdir -p "$STAGE_DIR"
for item in assets sidecars plugin.json LICENSE; do
  cp -R "$SRC_PLUGIN/$item" "$STAGE_DIR/"
done

if [[ -d "$DST_PLUGIN" ]]; then
  HAD_PREV="true"
  mv "$DST_PLUGIN" "$PREV_DIR"
fi
mv "$STAGE_DIR" "$DST_PLUGIN"
DEPLOYED="true"

# 2. 安全合并宿主 config.json 与本地 settings.json（保留既有 profile 与 inline 开关，排他备份）
FINAL_INLINE="$(node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const [cfgPath, bakDir, settingsPath, inlineMode] = process.argv.slice(1);

function isPlainObj(v) { return Boolean(v) && typeof v === "object" && !Array.isArray(v); }

let cfg = {};
if (fs.existsSync(cfgPath)) {
  const raw = fs.readFileSync(cfgPath, "utf8").replace(/^\uFEFF/, "");
  cfg = JSON.parse(raw);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-") + "-" + crypto.randomBytes(4).toString("hex");
  fs.writeFileSync(path.join(bakDir, `config-${stamp}.json`), raw, { flag: "wx", mode: 0o600 });
}

cfg.plugins = cfg.plugins || {};
cfg.sidecars = cfg.sidecars || {};
cfg.plugins["antigravity-token-meter"] = Object.assign({}, cfg.plugins["antigravity-token-meter"], { enabled: true });
cfg.sidecars["antigravity-token-meter/meter"] = Object.assign({}, cfg.sidecars["antigravity-token-meter/meter"], { enabled: true });

// 无损合并本地 settings.json（保留已有 profile，未显式传参时保留既有 inline 状态）
let settings = {};
if (fs.existsSync(settingsPath)) {
  try {
    const s = JSON.parse(fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, ""));
    if (isPlainObj(s)) settings = s;
  } catch {}
}
settings.enabled = true;
if (inlineMode === "true") settings.inline = true;
else if (inlineMode === "false") settings.inline = false;
else if (typeof settings.inline !== "boolean") settings.inline = false;

const tmpCfg = path.join(path.dirname(cfgPath), `.tm-cfg-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
fs.writeFileSync(tmpCfg, JSON.stringify(cfg, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
fs.renameSync(tmpCfg, cfgPath);

const tmpSet = path.join(path.dirname(settingsPath), `.tm-set-${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`);
fs.writeFileSync(tmpSet, JSON.stringify(settings, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
fs.renameSync(tmpSet, settingsPath);
process.stdout.write(settings.inline ? "true" : "false");
' "$CFG_JSON" "$CFG_DIR/config-backups" "$CFG_DIR/settings.json" "$INLINE_MODE")"

trap - ERR
rm -rf "$PREV_DIR"

if [[ ! -f "$CFG_DIR/preferences.json" ]]; then
  cat > "$CFG_DIR/preferences.json" <<'EOF'
{
  "language": "zh-CN",
  "theme": "swiss",
  "showSpeed": true,
  "showCache": true,
  "showContext": true,
  "showQuota": true,
  "showToday": false,
  "showMonth": true,
  "showCost": false,
  "version": 1
}
EOF
fi

if [[ "$FINAL_INLINE" == "true" ]]; then
  if [[ "$OS_NAME" == "Darwin" ]]; then
    LAUNCHER="$CFG_DIR/launch-antigravity-token-meter.command"
    cat > "$LAUNCHER" <<'EOF'
#!/usr/bin/env bash
if pgrep -x "Antigravity" >/dev/null 2>&1; then
  echo "[提示] 检测到 Antigravity 已在运行，请先按 Cmd+Q 彻底退出后再双击本启动器，否则 --remote-debugging-port=0 不会生效。"
  read -r -p "按回车键退出..."
  exit 5
fi
open -a "Antigravity" --args --remote-debugging-port=0
EOF
    chmod +x "$LAUNCHER"
    echo "[成功] 已生成独立的 macOS 实验内嵌启动器: $LAUNCHER"
  else
    APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
    mkdir -p "$APP_DIR"
    cat > "$APP_DIR/antigravity-token-meter.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Antigravity (TokenMeter Inline)
Comment=Launch Antigravity with local loopback debug port for TokenMeter inline bar
Exec=antigravity --remote-debugging-port=0
Terminal=false
Categories=Development;
EOF
    echo "[成功] 已创建独立的 Linux 桌面启动器: $APP_DIR/antigravity-token-meter.desktop（未修改原入口）"
  fi
fi

echo ""
echo "[完成] Antigravity TokenMeter v1.2.14 已安装至: $DST_PLUGIN"
echo "已在 config.json 中同时启用插件与 sidecar。"
