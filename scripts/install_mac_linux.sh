#!/usr/bin/env bash
set -euo pipefail

# Antigravity TokenMeter — macOS / Linux 安装、诊断与自愈脚本
# 兼容 macOS BSD 工具链 + bash 3.2 与 GNU/Linux，纯 LF 无 BOM。
# 支持 Node.js 优先、无全局 node 时自动无缝回退 python3（Antigravity 2.33+ 内置 agy-node 运行时）。

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SRC_PLUGIN="$ROOT_DIR/antigravity-token-meter"

# -------------------- 参数解析 --------------------
ACTION="install"
INLINE_MODE="preserve"
NON_INTERACTIVE="false"
LEGACY_PULSE_ACTION="ask"
REPAIR_CORRUPT_CONFIG="false"
AUTO_RESTART="false"
NO_LAUNCH="false"
JSON_OUTPUT="false"

print_help() {
  cat <<'EOF'
Antigravity TokenMeter — macOS / Linux 安装与诊断自愈工具

用法:
  bash scripts/install_mac_linux.sh [选项]

默认行为（无模式参数）:
  安装/升级插件至 ~/.gemini/config/plugins/antigravity-token-meter，
  并按 Antigravity 2.33+/2.34+ 官方规范同步注册 plugins 与 sidecars；
  首次安装默认开启完整体验（侧边栏面板 + 实验性底部内嵌状态条），升级保留既有模式。

模式与选项:
  --enable-inline           显式开启实验性底部内嵌状态条并生成独立启动器
  --disable-inline          显式切换为纯侧边栏面板模式（别称: --sidebar-only）
  --sidebar-only            同 --disable-inline
  --disable-legacy-pulse    同时在 config.json 中停用旧版 antigravity-pulse 防重影
  --keep-legacy-pulse       保留旧版 antigravity-pulse（不询问停用）
  --repair-corrupt-config   若 config.json 损坏，先备份原件并优先从最近有效备份恢复或重建
  --restart, --auto-restart 若检测到 Antigravity 正在运行，优雅退出、写入配置后自动重启拉起
  --no-launch               配合 --restart 仅优雅退出并写入配置，完成后不自动拉起客户端
  --doctor                  执行 7 项健康诊断（插件、sidecar、配置、进程参数、调试端口与挂载状态）
  --fix                     一键自动修复常见故障（补全官方 sidecars 字段、修复损坏配置与启动器）
  --json                    配合 --doctor / --fix 输出机器可读 JSON
  -y, --yes, --non-interactive
                            非交互模式（适合脚本或 AI 辅助安装，绝不卡在用户输入提示）
  -h, --help                显示本帮助信息

示例:
  bash scripts/install_mac_linux.sh
  bash scripts/install_mac_linux.sh --sidebar-only
  bash scripts/install_mac_linux.sh --non-interactive --restart
  bash scripts/install_mac_linux.sh --doctor
  bash scripts/install_mac_linux.sh --fix
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --enable-inline)
      INLINE_MODE="true"
      ;;
    --disable-inline|--sidebar-only)
      INLINE_MODE="false"
      ;;
    --disable-legacy-pulse)
      LEGACY_PULSE_ACTION="disable"
      ;;
    --keep-legacy-pulse)
      LEGACY_PULSE_ACTION="keep"
      ;;
    --repair-corrupt-config)
      REPAIR_CORRUPT_CONFIG="true"
      ;;
    --restart|--auto-restart)
      AUTO_RESTART="true"
      ;;
    --no-launch)
      NO_LAUNCH="true"
      ;;
    --doctor)
      ACTION="doctor"
      ;;
    --fix)
      ACTION="fix"
      REPAIR_CORRUPT_CONFIG="true"
      ;;
    --json)
      JSON_OUTPUT="true"
      ;;
    -y|--yes|--non-interactive)
      NON_INTERACTIVE="true"
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      printf '%s\n' "[错误] 未知参数: $1（可运行 --help 查看支持选项）" >&2
      exit 2
      ;;
  esac
  shift
done

# 仅在显式交互终端且未指定 --non-interactive / --json 时启用交互询问
IS_INTERACTIVE="false"
if [[ "$NON_INTERACTIVE" != "true" && "$JSON_OUTPUT" != "true" && -t 0 ]]; then
  IS_INTERACTIVE="true"
fi

log_info() {
  if [[ "$JSON_OUTPUT" != "true" ]]; then
    printf '%s\n' "$*"
  fi
}

log_err() {
  printf '%s\n' "$*" >&2
}

# -------------------- 目录解析（兼容 AG_TEST_HOME / ANTIGRAVITY_GEMINI_DIR 与含空格路径） --------------------
TARGET_HOME="${AG_TEST_HOME:-${HOME:-}}"
if [[ -z "$TARGET_HOME" || "${TARGET_HOME:0:1}" != "/" ]]; then
  log_err "[错误] 无效的 HOME / AG_TEST_HOME 环境变量，已中止。"
  exit 1
fi

OS_NAME="$(uname -s)"
if [[ "$OS_NAME" == "Darwin" ]]; then
  CFG_DIR="$TARGET_HOME/Library/Application Support/AntigravityTokenMeter"
  LINUX_APPS_DIR=""
else
  if [[ -n "${AG_TEST_HOME:-}" ]]; then
    DATA_BASE="${AG_TEST_XDG_DATA_HOME:-$TARGET_HOME/.local/share}"
  else
    DATA_BASE="${XDG_DATA_HOME:-$TARGET_HOME/.local/share}"
  fi
  CFG_DIR="$DATA_BASE/AntigravityTokenMeter"
  LINUX_APPS_DIR="$DATA_BASE/applications"
fi

if [[ -n "${ANTIGRAVITY_GEMINI_DIR:-}" && "${ANTIGRAVITY_GEMINI_DIR:0:1}" == "/" && -z "${AG_TEST_HOME:-}" ]]; then
  GEMINI_DIR="$ANTIGRAVITY_GEMINI_DIR"
else
  GEMINI_DIR="$TARGET_HOME/.gemini"
fi

DST_ROOT="$GEMINI_DIR/config/plugins"
DST_PLUGIN="$DST_ROOT/antigravity-token-meter"
CFG_JSON="$GEMINI_DIR/config/config.json"
SETTINGS_JSON="$CFG_DIR/settings.json"
PREFS_JSON="$CFG_DIR/preferences.json"
BAK_DIR="$CFG_DIR/config-backups"
if [[ -n "${ANTIGRAVITY_EXECUTABLE_DATA_DIR:-}" && -z "${AG_TEST_HOME:-}" ]]; then
  STATUS_JSON="$ANTIGRAVITY_EXECUTABLE_DATA_DIR/integration-status.json"
else
  STATUS_JSON="$GEMINI_DIR/antigravity/sidecar_data/antigravity-token-meter/meter/data/integration-status.json"
fi

# -------------------- JSON 运行时发现（Node.js 优先，自动回退 Python 3） --------------------
NODE_BIN=""
PYTHON_BIN=""
JSON_RUNTIME=""

probe_node() {
  if [[ -n "${AG_TEST_FORCE_NO_NODE:-}" ]]; then
    return 0
  fi
  local cand=""
  if command -v node >/dev/null 2>&1; then
    cand="$(command -v node)"
    if "$cand" -e 'process.exit(0)' >/dev/null 2>&1; then
      NODE_BIN="$cand"
      return 0
    fi
  fi
  for cand in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$TARGET_HOME/.volta/bin/node" \
    "$TARGET_HOME/.asdf/shims/node" \
    "$TARGET_HOME/.local/share/mise/shims/node" \
    "$TARGET_HOME/.fnm/current/bin/node"
  do
    if [[ -x "$cand" ]] && "$cand" -e 'process.exit(0)' >/dev/null 2>&1; then
      NODE_BIN="$cand"
      return 0
    fi
  done
  if [[ -d "$TARGET_HOME/.nvm/versions/node" ]]; then
    local best_bin=""
    local best_major=-1
    local d=""
    local maj=""
    for d in "$TARGET_HOME/.nvm/versions/node"/*; do
      if [[ -x "$d/bin/node" ]]; then
        maj="$("$d/bin/node" -p 'parseInt(process.versions.node.split(".")[0], 10) || 0' 2>/dev/null || printf '0')"
        if [[ "$maj" =~ ^[0-9]+$ ]] && [[ "$maj" -gt "$best_major" ]]; then
          best_major="$maj"
          best_bin="$d/bin/node"
        fi
      fi
    done
    if [[ -n "$best_bin" ]]; then
      NODE_BIN="$best_bin"
      return 0
    fi
  fi
}

probe_python() {
  if [[ -n "${AG_TEST_FORCE_NO_PYTHON:-}" ]]; then
    return 0
  fi
  local cand=""
  if command -v python3 >/dev/null 2>&1; then
    cand="$(command -v python3)"
    if "$cand" -c 'import json, sys; sys.exit(0)' >/dev/null 2>&1; then
      PYTHON_BIN="$cand"
      return 0
    fi
  fi
  for cand in /usr/bin/python3 /opt/homebrew/bin/python3 /usr/local/bin/python3; do
    if [[ -x "$cand" ]] && "$cand" -c 'import json, sys; sys.exit(0)' >/dev/null 2>&1; then
      PYTHON_BIN="$cand"
      return 0
    fi
  done
}

probe_node
probe_python

if [[ -n "$NODE_BIN" ]]; then
  JSON_RUNTIME="node"
elif [[ -n "$PYTHON_BIN" ]]; then
  JSON_RUNTIME="python3"
  log_info "[提示] 未在系统 PATH 中检测到全局 node，已自动切换为 python3 处理 JSON 配置。"
  log_info "       Antigravity 2.33+ 已内置 agy-node 运行时，插件加载不强依赖系统全局 Node.js。"
else
  log_err "[错误] 未检测到 node 或 python3，无法安全读写 config.json / settings.json。"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    log_err "       请先执行: brew install node（或 xcode-select --install 启用系统 python3）后重试。"
  else
    log_err "       请先通过系统包管理器安装 python3 或 nodejs（如 sudo apt install python3）后重试。"
  fi
  exit 1
fi

# -------------------- 统一双引擎（Node / Python3）JSON 辅助调用 --------------------
run_json_helper() {
  local op="$1"
  shift
  if [[ "$JSON_RUNTIME" == "node" ]]; then
    "$NODE_BIN" - "$op" "$@" <<'NODE_EOF'
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

const [op, ...args] = process.argv.slice(2);

function isPlainObj(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function readJsonText(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
}

function stampTag() {
  return new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(4).toString('hex');
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tm-tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch {}
    throw err;
  }
}

function backupRawFile(srcPath, bakDir, prefix) {
  if (!fs.existsSync(srcPath)) return null;
  fs.mkdirSync(bakDir, { recursive: true });
  const raw = fs.readFileSync(srcPath);
  const dst = path.join(bakDir, `${prefix}-${stampTag()}.json`);
  fs.writeFileSync(dst, raw, { flag: 'wx', mode: 0o600 });
  return dst;
}

function findLatestValidConfigBackup(bakDir) {
  if (!fs.existsSync(bakDir)) return null;
  let files = [];
  try {
    files = fs.readdirSync(bakDir)
      .filter((f) => /^config-\d/.test(f) && f.endsWith('.json') && !f.includes('corrupt'))
      .map((f) => {
        const full = path.join(bakDir, f);
        try {
          return { full, mtime: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    return null;
  }
  for (const item of files) {
    try {
      const parsed = JSON.parse(readJsonText(item.full));
      if (isPlainObj(parsed)) {
        return { path: item.full, data: parsed };
      }
    } catch {}
  }
  return null;
}

function parseBoolEnv(raw) {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return null;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

function probeLocalCdp(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (res) => {
      if (done) return;
      done = true;
      resolve(res);
    };
    const req = http.request(
      { hostname: '127.0.0.1', port, family: 4, path: '/json/list', method: 'GET', agent: false },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          finish({ ok: false, err: `HTTP ${res.statusCode}` });
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 512 * 1024) body += chunk;
        });
        res.on('end', () => {
          let pages = 0;
          try {
            const arr = JSON.parse(body);
            if (Array.isArray(arr)) {
              pages = arr.filter((t) => t && t.type === 'page' && /^https?:\/\//i.test(String(t.url || ''))).length;
            }
          } catch {}
          finish({ ok: true, pages });
        });
      }
    );
    req.setTimeout(2200, () => {
      req.destroy();
      finish({ ok: false, err: '连接超时' });
    });
    req.on('error', (err) => {
      finish({ ok: false, err: err && err.code ? err.code : '无法连接' });
    });
    req.end();
  });
}

(async () => {
  if (op === 'version') {
    const pluginJson = args[0];
    try {
      const parsed = JSON.parse(readJsonText(pluginJson));
      process.stdout.write(String(parsed.version || '1.2.16'));
    } catch {
      process.stdout.write('1.2.16');
    }
    return;
  }

  if (op === 'inspect') {
    const [cfgPath, settingsPath] = args;
    const legacyPulseDir = path.join(path.dirname(cfgPath), 'plugins', 'antigravity-pulse');
    const isLegacySidecarKey = (k) => k === 'antigravity-pulse' || k.startsWith('antigravity-pulse/');
    let cfgStatus = 'missing';
    let cfgError = '';
    let legacyPulse = false;
    let pulseExplicitlyDisabled = false;
    if (fs.existsSync(cfgPath)) {
      try {
        const raw = readJsonText(cfgPath);
        if (!raw.trim()) {
          cfgStatus = 'corrupt';
          cfgError = 'config.json 为空';
        } else {
          const cfg = JSON.parse(raw);
          if (!isPlainObj(cfg)) {
            cfgStatus = 'corrupt';
            cfgError = 'config.json 根节点必须为 JSON 对象';
          } else if (Object.prototype.hasOwnProperty.call(cfg, 'plugins') && !isPlainObj(cfg.plugins)) {
            cfgStatus = 'corrupt';
            cfgError = 'plugins 字段类型异常';
          } else if (Object.prototype.hasOwnProperty.call(cfg, 'sidecars') && !isPlainObj(cfg.sidecars)) {
            cfgStatus = 'corrupt';
            cfgError = 'sidecars 字段类型异常';
          } else if (cfg.plugins && Object.prototype.hasOwnProperty.call(cfg.plugins, 'antigravity-token-meter') && !isPlainObj(cfg.plugins['antigravity-token-meter'])) {
            cfgStatus = 'corrupt';
            cfgError = 'plugins["antigravity-token-meter"] 字段类型异常';
          } else if (cfg.sidecars && Object.prototype.hasOwnProperty.call(cfg.sidecars, 'antigravity-token-meter/meter') && !isPlainObj(cfg.sidecars['antigravity-token-meter/meter'])) {
            cfgStatus = 'corrupt';
            cfgError = 'sidecars["antigravity-token-meter/meter"] 字段类型异常';
          } else {
            cfgStatus = 'ok';
            const lp = cfg.plugins && cfg.plugins['antigravity-pulse'];
            if (isPlainObj(lp)) {
              if (lp.enabled === true) legacyPulse = true;
              else if (lp.enabled === false) pulseExplicitlyDisabled = true;
            }
            if (isPlainObj(cfg.sidecars)) {
              for (const [sk, sv] of Object.entries(cfg.sidecars)) {
                if (isLegacySidecarKey(sk) && isPlainObj(sv) && sv.enabled === true) {
                  legacyPulse = true;
                }
              }
            }
          }
        }
      } catch (e) {
        cfgStatus = 'corrupt';
        cfgError = e.message;
      }
    }
    if (!legacyPulse && !pulseExplicitlyDisabled && fs.existsSync(legacyPulseDir)) {
      legacyPulse = true;
    }

    let existingInline = 'unset';
    if (fs.existsSync(settingsPath)) {
      try {
        const s = JSON.parse(readJsonText(settingsPath));
        if (isPlainObj(s) && typeof s.inline === 'boolean') {
          existingInline = s.inline ? 'true' : 'false';
        }
      } catch {}
    }
    process.stdout.write(`${cfgStatus}|${legacyPulse ? 'true' : 'false'}|${existingInline}|${cfgError.replace(/[\r\n|]+/g, ' ')}`);
    return;
  }

  if (op === 'merge') {
    const [cfgPath, bakDir, settingsPath, inlineMode, disableLegacyPulse, repairCorrupt] = args;
    let cfg = {};
    let repairedCfg = false;
    if (fs.existsSync(cfgPath)) {
      const raw = readJsonText(cfgPath);
      let parsed = null;
      let errMsg = '';
      if (!raw.trim()) {
        errMsg = '现有 config.json 为空';
      } else {
        try {
          parsed = JSON.parse(raw);
          if (!isPlainObj(parsed)) {
            errMsg = 'config.json 根节点必须为 JSON 对象';
            parsed = null;
          }
        } catch (e) {
          errMsg = `config.json 不是合法 JSON: ${e.message}`;
        }
      }

      if (errMsg) {
        if (repairCorrupt === 'true') {
          const bak = backupRawFile(cfgPath, bakDir, 'config-corrupt');
          console.error(`[已修复] 原损坏 config.json 已备份至: ${bak}`);
          const restored = findLatestValidConfigBackup(bakDir);
          if (restored) {
            cfg = restored.data;
            console.error(`[已修复] 已优先从最近有效备份恢复原有配置: ${restored.path}`);
          } else {
            cfg = {};
          }
          repairedCfg = true;
        } else {
          console.error(`[错误] ${errMsg}，已中止以免覆盖原配置（可加 --repair-corrupt-config 或 --fix 自动备份并恢复/重建）。`);
          process.exit(4);
        }
      } else {
        backupRawFile(cfgPath, bakDir, 'config');
        cfg = parsed;
      }
    }

    if (cfg.plugins !== undefined && !isPlainObj(cfg.plugins)) {
      if (repairCorrupt === 'true') {
        cfg.plugins = {};
        repairedCfg = true;
      } else {
        console.error('[错误] config.json 中 plugins 字段类型异常。');
        process.exit(4);
      }
    }
    if (cfg.sidecars !== undefined && !isPlainObj(cfg.sidecars)) {
      if (repairCorrupt === 'true') {
        cfg.sidecars = {};
        repairedCfg = true;
      } else {
        console.error('[错误] config.json 中 sidecars 字段类型异常。');
        process.exit(4);
      }
    }
    cfg.plugins = cfg.plugins || {};
    cfg.sidecars = cfg.sidecars || {};

    const prevPlugin = cfg.plugins['antigravity-token-meter'];
    if (prevPlugin !== undefined && !isPlainObj(prevPlugin)) {
      if (repairCorrupt !== 'true') {
        console.error('[错误] plugins["antigravity-token-meter"] 字段类型异常。');
        process.exit(4);
      }
    }
    cfg.plugins['antigravity-token-meter'] = Object.assign({}, isPlainObj(prevPlugin) ? prevPlugin : {}, { enabled: true });

    const prevSidecar = cfg.sidecars['antigravity-token-meter/meter'];
    if (prevSidecar !== undefined && !isPlainObj(prevSidecar)) {
      if (repairCorrupt !== 'true') {
        console.error('[错误] sidecars["antigravity-token-meter/meter"] 字段类型异常。');
        process.exit(4);
      }
    }
    // 严格遵守 Antigravity 2.33+/2.34+ 官方 SidecarUserConfig 规范：
    // 1. 保留已有 projectId 等全部字段，严禁伪造随机 projectId UUID（首次缺省交由宿主自动生成回写）；
    // 2. 补齐 enabled: true、schemaVersion: 1（缺失时）与 resolvedPermissions: {}（缺失时）。
    const nextSidecar = Object.assign({}, isPlainObj(prevSidecar) ? prevSidecar : {});
    nextSidecar.enabled = true;
    if (nextSidecar.schemaVersion === undefined || nextSidecar.schemaVersion === null) {
      nextSidecar.schemaVersion = 1;
    }
    if (!isPlainObj(nextSidecar.resolvedPermissions)) {
      nextSidecar.resolvedPermissions = {};
    }
    cfg.sidecars['antigravity-token-meter/meter'] = nextSidecar;

    if (disableLegacyPulse === 'true') {
      const legacyPulseDir = path.join(path.dirname(cfgPath), 'plugins', 'antigravity-pulse');
      if (Object.prototype.hasOwnProperty.call(cfg.plugins, 'antigravity-pulse') || fs.existsSync(legacyPulseDir)) {
        const oldP = cfg.plugins['antigravity-pulse'];
        cfg.plugins['antigravity-pulse'] = Object.assign({}, isPlainObj(oldP) ? oldP : {}, { enabled: false });
      }
      for (const sk of Object.keys(cfg.sidecars)) {
        if (sk === 'antigravity-pulse' || sk.startsWith('antigravity-pulse/')) {
          const oldS = cfg.sidecars[sk];
          cfg.sidecars[sk] = Object.assign({}, isPlainObj(oldS) ? oldS : {}, { enabled: false });
        }
      }
    }

    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const s = JSON.parse(readJsonText(settingsPath));
        if (isPlainObj(s)) {
          settings = s;
        } else {
          backupRawFile(settingsPath, bakDir, 'settings-corrupt');
        }
      } catch {
        backupRawFile(settingsPath, bakDir, 'settings-corrupt');
      }
    }
    settings.enabled = true;
    if (inlineMode === 'true') {
      settings.inline = true;
    } else if (inlineMode === 'false') {
      settings.inline = false;
    } else if (typeof settings.inline !== 'boolean') {
      settings.inline = true;
    }

    atomicWriteJson(cfgPath, cfg);
    atomicWriteJson(settingsPath, settings);
    process.stdout.write(`${settings.inline ? 'true' : 'false'}|${repairedCfg ? 'true' : 'false'}`);
    return;
  }

  if (op === 'init_prefs') {
    const [prefsPath] = args;
    if (fs.existsSync(prefsPath)) return;
    const env = process.env;
    function pick(raw) {
      if (!raw || typeof raw !== 'string') return null;
      const tag = raw.split(':')[0].trim().replace(/[.@].*$/, '').replace(/_/g, '-');
      if (!tag || /^(?:c|posix)$/i.test(tag)) return null;
      return /^zh(?:-|$)/i.test(tag) ? 'zh-CN' : /^[a-z]{2,3}(?:-|$)/i.test(tag) ? 'en' : null;
    }
    let lang = null;
    for (const k of ['AG_TM_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
      lang = pick(env[k]);
      if (lang) break;
    }
    if (!lang) {
      try { lang = pick(Intl.DateTimeFormat().resolvedOptions().locale); } catch {}
    }
    atomicWriteJson(prefsPath, {
      language: lang || 'zh-CN',
      theme: 'swiss',
      showSpeed: true,
      showCache: true,
      showContext: true,
      showQuota: true,
      showToday: false,
      showMonth: true,
      showCost: false,
      version: 1,
    });
    return;
  }

  if (op === 'doctor') {
    const [targetHome, osName, cfgDir, dstPlugin, cfgJson, settingsJson, statusJson, jsonMode, procCountStr, procHasDebug] = args;
    const checks = [];
    let failCount = 0;
    const isJson = jsonMode === 'true';

    function addCheck(id, status, detail, hint = '') {
      checks.push({ id, status, detail, hint });
      if (status === 'fail') failCount++;
      if (!isJson) {
        console.log(`[${status.toUpperCase()}] ${id} - ${detail}`);
        if (hint) console.log(`       修复建议: ${hint}`);
      }
    }

    // 1/7 插件文件完整性
    const required = ['plugin.json', 'LICENSE', 'assets/logo.svg', 'sidecars/meter/sidecar.json', 'sidecars/meter/main.mjs'];
    const missingFiles = required.filter((rel) => !fs.existsSync(path.join(dstPlugin, rel)));
    if (missingFiles.length === 0) {
      addCheck('1/7 插件文件', 'pass', '插件核心文件、sidecar.json 与 MIT LICENSE 完整');
    } else {
      addCheck('1/7 插件文件', 'fail', `插件目录缺失关键文件: ${missingFiles.join(', ')}`, '请运行 bash scripts/install_mac_linux.sh --fix 重新部署插件。');
    }

    // 2/7 & 3/7 config.json 插件与 sidecar 注册检查
    const cfgExists = fs.existsSync(cfgJson);
    const legacyPulseDir = path.join(path.dirname(dstPlugin), 'antigravity-pulse');
    const isLegacySidecarKey = (k) => k === 'antigravity-pulse' || k.startsWith('antigravity-pulse/');
    let cfgCorrupt = false;
    let pluginEnabled = false;
    let sidecarEnabled = false;
    let sidecarSchemaOk = false;
    let legacyPulse = false;
    let pulseExplicitlyDisabled = false;

    if (cfgExists) {
      try {
        const raw = readJsonText(cfgJson);
        if (!raw.trim()) {
          cfgCorrupt = true;
        } else {
          const cfg = JSON.parse(raw);
          if (!isPlainObj(cfg)) {
            cfgCorrupt = true;
          } else {
            const pe = cfg.plugins && cfg.plugins['antigravity-token-meter'];
            const se = cfg.sidecars && cfg.sidecars['antigravity-token-meter/meter'];
            const lp = cfg.plugins && cfg.plugins['antigravity-pulse'];
            if (isPlainObj(pe) && pe.enabled === true) pluginEnabled = true;
            if (isPlainObj(se) && se.enabled === true) {
              sidecarEnabled = true;
              sidecarSchemaOk = se.schemaVersion !== undefined && isPlainObj(se.resolvedPermissions);
            }
            if (isPlainObj(lp)) {
              if (lp.enabled === true) legacyPulse = true;
              else if (lp.enabled === false) pulseExplicitlyDisabled = true;
            }
            if (isPlainObj(cfg.sidecars)) {
              for (const [sk, sv] of Object.entries(cfg.sidecars)) {
                if (isLegacySidecarKey(sk) && isPlainObj(sv) && sv.enabled === true) {
                  legacyPulse = true;
                }
              }
            }
          }
        }
      } catch {
        cfgCorrupt = true;
      }
    }
    if (!cfgCorrupt && !legacyPulse && !pulseExplicitlyDisabled && fs.existsSync(legacyPulseDir)) {
      legacyPulse = true;
    }

    if (cfgCorrupt) {
      addCheck('2/7 插件注册', 'fail', '宿主 config.json 为空或存在 JSON 语法损坏', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 自动备份并恢复/重建。');
      addCheck('3/7 Sidecar 启用', 'fail', '因 config.json 损坏无法确认 sidecar 注册状态', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix。');
    } else {
      if (pluginEnabled && legacyPulse) {
        addCheck('2/7 插件注册', 'warn', '已启用 TokenMeter，但旧版 antigravity-pulse 仍处于启用状态（可能导致底部状态条重影）', '建议彻底退出 Antigravity 后执行 bash scripts/install_mac_linux.sh --fix --disable-legacy-pulse。');
      } else if (pluginEnabled) {
        addCheck('2/7 插件注册', 'pass', 'config.json 已启用 plugins["antigravity-token-meter"]');
      } else if (!cfgExists) {
        addCheck('2/7 插件注册', 'fail', '尚未检测到宿主 config.json 配置文件', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh。');
      } else {
        addCheck('2/7 插件注册', 'fail', 'config.json 中 plugins["antigravity-token-meter"] 未启用', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix。');
      }

      if (sidecarEnabled && sidecarSchemaOk) {
        addCheck('3/7 Sidecar 启用', 'pass', 'config.json 已按官方规范启用 sidecars["antigravity-token-meter/meter"]（含 schemaVersion 与 resolvedPermissions）');
      } else if (sidecarEnabled) {
        addCheck('3/7 Sidecar 启用', 'warn', 'sidecars["antigravity-token-meter/meter"] 已启用，但缺少 schemaVersion 或 resolvedPermissions 字段', '建议彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 补全官方字段。');
      } else {
        addCheck('3/7 Sidecar 启用', 'fail', 'config.json 未启用 sidecars["antigravity-token-meter/meter"] 后台进程', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 自动补齐。');
      }
    }

    // 4/7 本地运行配置 settings.json 与独立启动器检查（对齐 paths.mjs 零配置契约）
    let inlineWanted = true;
    let inlineSource = 'default';
    let localEnabled = true;
    let settingsCorrupt = false;
    let customProfile = null;
    if (fs.existsSync(settingsJson)) {
      try {
        const s = JSON.parse(readJsonText(settingsJson));
        if (!isPlainObj(s)) {
          settingsCorrupt = true;
          inlineWanted = false;
          inlineSource = 'error';
        } else {
          if (s.enabled === false) localEnabled = false;
          if (typeof s.inline === 'boolean') {
            inlineWanted = s.inline;
            inlineSource = 'settings';
          } else if (s.inline !== undefined) {
            settingsCorrupt = true;
            inlineWanted = false;
            inlineSource = 'error';
          }
          if (typeof s.profile === 'string' && s.profile.trim()) customProfile = s.profile.trim();
        }
      } catch {
        settingsCorrupt = true;
        inlineWanted = false;
        inlineSource = 'error';
      }
    }
    const envInline = parseBoolEnv(process.env.AG_TM_INLINE);
    if (envInline !== null && !settingsCorrupt) {
      inlineWanted = envInline;
      inlineSource = 'env';
    }

    const launcherPath = osName === 'Darwin'
      ? path.join(cfgDir, 'launch-antigravity-token-meter.command')
      : path.join(cfgDir, 'launch-antigravity-token-meter.sh');

    if (settingsCorrupt) {
      addCheck('4/7 本地运行配置', 'fail', '本地 settings.json 格式损坏或 inline 字段类型非法，内嵌模式已被安全关闭', '请运行 bash scripts/install_mac_linux.sh --fix 自动备份并重建配置。');
    } else if (!localEnabled) {
      addCheck('4/7 本地运行配置', 'warn', '本地 settings.json 中 enabled=false，插件当前处于停用状态', '如需恢复监控，请运行 bash scripts/install_mac_linux.sh --fix。');
    } else if (inlineWanted && !fs.existsSync(launcherPath)) {
      addCheck('4/7 本地运行配置', 'warn', `已启用内嵌模式（来源: ${inlineSource}），但尚未生成独立启动器 ${launcherPath}`, '可运行 bash scripts/install_mac_linux.sh --fix 自动补建独立启动器。');
    } else if (inlineWanted) {
      addCheck('4/7 本地运行配置', 'pass', `完整模式已就绪（侧边栏 + 底部内嵌，来源: ${inlineSource}，独立启动器存在）`);
    } else {
      addCheck('4/7 本地运行配置', 'pass', `纯侧边栏面板模式已就绪（inline=false，来源: ${inlineSource}）`);
    }

    // 5/7 主进程参数
    const procCount = Number(procCountStr) || 0;
    const startHint = osName === 'Darwin'
      ? `请双击或运行 "${launcherPath}" 启动 Antigravity`
      : `请从应用菜单点击 "Antigravity (TokenMeter Inline)" 或运行 "${launcherPath}" 启动 Antigravity`;
    const restartHint = osName === 'Darwin'
      ? `请先按 Cmd+Q 彻底退出 Antigravity，再运行 "${launcherPath}"`
      : `请先从系统托盘彻底退出 Antigravity，再运行 "${launcherPath}"`;

    if (settingsCorrupt) {
      addCheck('5/7 主进程参数', 'fail', '本地 settings.json 损坏，无法确认内嵌目标模式', '请先运行 bash scripts/install_mac_linux.sh --fix 重建配置。');
    } else if (!localEnabled) {
      addCheck('5/7 主进程参数', 'warn', '插件本地已停用（enabled=false）', '如需恢复监控，请运行 bash scripts/install_mac_linux.sh --fix。');
    } else if (procCount === 0) {
      addCheck('5/7 主进程参数', 'warn', '未检测到运行中的 Antigravity 主进程', inlineWanted ? startHint : '正常打开 Antigravity 即可在侧边栏使用 TokenMeter。');
    } else if (procHasDebug === 'true') {
      addCheck('5/7 主进程参数', 'pass', 'Antigravity 主进程已携带 --remote-debugging-port 启动参数');
    } else if (!inlineWanted) {
      addCheck('5/7 主进程参数', 'pass', '当前为纯侧边栏模式（未开启实验内嵌，无需调试端口）');
    } else {
      addCheck('5/7 主进程参数', 'fail', 'Antigravity 主进程未携带 --remote-debugging-port=0（常见于关闭窗口后仍驻留 Dock/托盘，新参数被 Electron 单实例锁吞掉）', `${restartHint}（或附加 --restart 参数安全重启）。`);
    }

    // 6/7 本地调试端口（全候选 Profile 遍历，对齐 paths.mjs；冷态 procCount===0 报 warn 而非误报 fail）
    if (settingsCorrupt) {
      addCheck('6/7 本地调试端口', 'fail', '因本地 settings.json 损坏跳过内嵌端口检测', '请运行 bash scripts/install_mac_linux.sh --fix 修复配置。');
    } else if (!inlineWanted) {
      addCheck('6/7 本地调试端口', 'pass', '纯侧边栏模式无需检测本地 CDP 调试端口');
    } else {
      const profiles = [];
      const addProf = (p) => { if (p && !profiles.includes(p)) profiles.push(p); };
      for (const envKey of ['AG_TM_PROFILE', 'ANTIGRAVITY_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR']) {
        const rawVal = process.env[envKey];
        if (typeof rawVal === 'string' && rawVal.trim()) {
          for (const part of rawVal.split(':')) {
            if (part.trim()) addProf(part.trim());
          }
        }
      }
      if (customProfile) addProf(customProfile);
      if (osName === 'Darwin') {
        const sup = path.join(targetHome, 'Library', 'Application Support');
        addProf(path.join(sup, 'Antigravity'));
        addProf(path.join(sup, 'antigravity'));
        addProf(path.join(sup, 'Antigravity - Insiders'));
        addProf(path.join(sup, 'Antigravity Insiders'));
      } else {
        const xdgCfg = process.env.AG_TEST_HOME ? path.join(targetHome, '.config') : (process.env.XDG_CONFIG_HOME || path.join(targetHome, '.config'));
        addProf(path.join(xdgCfg, 'Antigravity'));
        addProf(path.join(xdgCfg, 'antigravity'));
        addProf(path.join(xdgCfg, 'Antigravity - Insiders'));
        addProf(path.join(xdgCfg, 'antigravity-insiders'));
        addProf(path.join(targetHome, '.config', 'Antigravity'));
        addProf(path.join(targetHome, '.config', 'antigravity'));
      }
      const portFiles = profiles.map((d) => path.join(d, 'DevToolsActivePort')).filter((f) => fs.existsSync(f));
      if (portFiles.length === 0) {
        if (procCount === 0) {
          addCheck('6/7 本地调试端口', 'warn', 'Antigravity 当前未运行，尚未生成 DevToolsActivePort 调试端口文件', startHint);
        } else {
          addCheck('6/7 本地调试端口', 'fail', '未在配置目录检测到 DevToolsActivePort 文件', restartHint);
        }
      } else {
        let connectedPort = null;
        let pages = 0;
        let lastErr = '';
        for (const pf of portFiles) {
          try {
            const firstLine = readJsonText(pf).split(/\r?\n/)[0].trim();
            if (!/^[1-9]\d{0,4}$/.test(firstLine) || Number(firstLine) > 65535) {
              lastErr = `端口文件首行不是合法端口号 (${pf})`;
              continue;
            }
            const portNum = Number(firstLine);
            const res = await probeLocalCdp(portNum);
            if (res.ok) {
              connectedPort = portNum;
              pages = res.pages;
              break;
            }
            lastErr = `端口 ${portNum} 不可达 (${res.err})，可能为上次退出残留的过期端口`;
          } catch (e) {
            lastErr = e.message;
          }
        }
        if (connectedPort !== null) {
          addCheck('6/7 本地调试端口', 'pass', `DevToolsActivePort 连通正常 (port=${connectedPort}, pages=${pages})`);
        } else if (procCount === 0) {
          addCheck('6/7 本地调试端口', 'warn', `Antigravity 当前未运行（目录中仅残留过期调试端口：${lastErr}）`, startHint);
        } else {
          addCheck('6/7 本地调试端口', 'fail', `检测到 DevToolsActivePort 但无法连接：${lastErr}`, restartHint);
        }
      }
    }

    // 7/7 运行实例与挂载状态（优先暴露 state==="error" 启动崩溃；其余冷态 procCount===0 报 warn 对齐 doctor.ps1）
    if (fs.existsSync(statusJson)) {
      try {
        const st = JSON.parse(readJsonText(statusJson));
        const pidNum = Number(st.pid);
        const alive = isPidAlive(pidNum);
        const checkedMs = Date.parse(st.checkedAt || '');
        const ageSec = Number.isFinite(checkedMs) ? Math.abs((Date.now() - checkedMs) / 1000) : 99999;

        if (st.state === 'error') {
          const msg = st.errorMessage ? ` - ${st.errorMessage}` : '';
          addCheck('7/7 运行实例与挂载', 'fail', `sidecar 启动失败 (code=${st.code || 'startup_failed'}${msg})`, '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix，并确认 Antigravity 版本为 2.33+。');
        } else if (!alive || ageSec > 30) {
          if (procCount === 0) {
            addCheck('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，TokenMeter sidecar 将在下次启动客户端时自动拉起', inlineWanted ? startHint : '正常打开 Antigravity 即可启用 TokenMeter。');
          } else {
            addCheck('7/7 运行实例与挂载', 'fail', '状态文件已过期或对应 sidecar 后台进程未运行', '请确认 Antigravity 正在运行，并在 Customizations -> Plugins 中确认 TokenMeter 已启用；若刚安装，请彻底退出后重启客户端。');
          }
        } else if (st.state === 'mounted') {
          addCheck('7/7 运行实例与挂载', 'pass', `sidecar 存活且底部状态条已挂载 (windows=${st.windows || 0})`);
        } else if (st.state === 'waiting_composer') {
          addCheck('7/7 运行实例与挂载', 'warn', `sidecar 已连上主窗口 (windows=${st.windows || 0})，当前页面无聊天输入框，进入任意对话即自动显示底栏`);
        } else if (!inlineWanted && (st.state === 'disabled' || st.code === 'inline_disabled')) {
          addCheck('7/7 运行实例与挂载', 'pass', 'sidecar 存活（纯侧边栏面板模式运行正常）');
        } else {
          const code = String(st.code || st.state || 'unknown');
          addCheck('7/7 运行实例与挂载', 'fail', `sidecar 存活但底部条尚未挂载 (state=${st.state}, code=${code})`, restartHint);
        }
      } catch {
        if (procCount === 0) {
          addCheck('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，历史 integration-status.json 无法解析（下次启动时将自动重建）', inlineWanted ? startHint : '正常打开 Antigravity 即可。');
        } else {
          addCheck('7/7 运行实例与挂载', 'fail', 'integration-status.json 解析失败', '请彻底重启一次 Antigravity 让 sidecar 重新生成状态文件。');
        }
      }
    } else if (procCount === 0) {
      addCheck('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，尚未生成 sidecar 运行状态文件（首次启动客户端后自动生效）', inlineWanted ? startHint : '正常打开 Antigravity 即可启用 TokenMeter。');
    } else {
      addCheck('7/7 运行实例与挂载', 'fail', '尚未检测到 TokenMeter sidecar 运行状态文件', '安装完成后必须彻底退出并重启 Antigravity 客户端，sidecar 才会首次启动。');
    }

    if (isJson) {
      console.log(JSON.stringify({ ok: failCount === 0, failures: failCount, checks }, null, 2));
    } else {
      console.log('');
      if (failCount === 0) {
        console.log('全部 7 项关键诊断通过！');
      } else {
        console.log(`发现 ${failCount} 项异常，请按上方「修复建议」处理，或运行 bash scripts/install_mac_linux.sh --fix 自动修复。`);
      }
    }
    process.exit(failCount > 0 ? 1 : 0);
  }
})().catch((err) => {
  console.error(`[错误] ${err && err.message ? err.message : String(err)}`);
  process.exit(1);
});
NODE_EOF
  else
    "$PYTHON_BIN" - "$op" "$@" <<'PY_EOF'
import datetime
import json
import locale
import os
import re
import secrets
import sys
import urllib.request

op = sys.argv[1]
args = sys.argv[2:]

def read_text(path):
    with open(path, 'r', encoding='utf-8-sig') as f:
        return f.read()

def stamp_tag():
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H-%M-%S-%fZ')
    return f"{now}-{secrets.token_hex(4)}"

def atomic_write_json(path, data):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp = os.path.join(parent, f".tm-tmp-{os.getpid()}-{secrets.token_hex(4)}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
            f.write('\n')
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

def backup_raw_file(src_path, bak_dir, prefix):
    if not os.path.exists(src_path):
        return None
    os.makedirs(bak_dir, exist_ok=True)
    with open(src_path, 'rb') as f:
        raw = f.read()
    dst = os.path.join(bak_dir, f"{prefix}-{stamp_tag()}.json")
    fd = os.open(dst, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as f:
        f.write(raw)
    return dst

def find_latest_valid_config_backup(bak_dir):
    if not os.path.isdir(bak_dir):
        return None
    items = []
    try:
        for name in os.listdir(bak_dir):
            if re.match(r'^config-\d', name) and name.endswith('.json') and 'corrupt' not in name:
                full = os.path.join(bak_dir, name)
                try:
                    items.append((os.path.getmtime(full), full))
                except OSError:
                    pass
    except OSError:
        return None
    items.sort(reverse=True)
    for _, full in items:
        try:
            parsed = json.loads(read_text(full))
            if isinstance(parsed, dict):
                return full, parsed
        except Exception:
            pass
    return None

def parse_bool_env(raw):
    if not isinstance(raw, str):
        return None
    v = raw.strip().lower()
    if v in ('1', 'true', 'yes', 'on'):
        return True
    if v in ('0', 'false', 'no', 'off'):
        return False
    return None

def is_pid_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False

def probe_local_cdp(port):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    url = f"http://127.0.0.1:{port}/json/list"
    try:
        with opener.open(url, timeout=2.2) as resp:
            if resp.status != 200:
                return False, 0, f"HTTP {resp.status}"
            body = resp.read(512 * 1024).decode('utf-8', errors='replace')
            pages = 0
            try:
                arr = json.loads(body)
                if isinstance(arr, list):
                    pages = sum(
                        1 for t in arr
                        if isinstance(t, dict)
                        and t.get('type') == 'page'
                        and re.match(r'^https?://', str(t.get('url', '')), re.I)
                    )
            except Exception:
                pass
            return True, pages, ''
    except Exception as e:
        return False, 0, str(e)

if op == 'version':
    plugin_json = args[0]
    try:
        parsed = json.loads(read_text(plugin_json))
        sys.stdout.write(str(parsed.get('version') or '1.2.16'))
    except Exception:
        sys.stdout.write('1.2.16')
    sys.exit(0)

if op == 'inspect':
    cfg_path, settings_path = args[0], args[1]
    legacy_pulse_dir = os.path.join(os.path.dirname(cfg_path), 'plugins', 'antigravity-pulse')
    def is_legacy_sidecar_key(k):
        return k == 'antigravity-pulse' or k.startswith('antigravity-pulse/')
    cfg_status = 'missing'
    cfg_error = ''
    legacy_pulse = False
    pulse_explicitly_disabled = False
    if os.path.exists(cfg_path):
        try:
            raw = read_text(cfg_path)
            if not raw.strip():
                cfg_status = 'corrupt'
                cfg_error = 'config.json 为空'
            else:
                cfg = json.loads(raw)
                if not isinstance(cfg, dict):
                    cfg_status = 'corrupt'
                    cfg_error = 'config.json 根节点必须为 JSON 对象'
                elif 'plugins' in cfg and not isinstance(cfg['plugins'], dict):
                    cfg_status = 'corrupt'
                    cfg_error = 'plugins 字段类型异常'
                elif 'sidecars' in cfg and not isinstance(cfg['sidecars'], dict):
                    cfg_status = 'corrupt'
                    cfg_error = 'sidecars 字段类型异常'
                elif isinstance(cfg.get('plugins'), dict) and 'antigravity-token-meter' in cfg['plugins'] and not isinstance(cfg['plugins']['antigravity-token-meter'], dict):
                    cfg_status = 'corrupt'
                    cfg_error = 'plugins["antigravity-token-meter"] 字段类型异常'
                elif isinstance(cfg.get('sidecars'), dict) and 'antigravity-token-meter/meter' in cfg['sidecars'] and not isinstance(cfg['sidecars']['antigravity-token-meter/meter'], dict):
                    cfg_status = 'corrupt'
                    cfg_error = 'sidecars["antigravity-token-meter/meter"] 字段类型异常'
                else:
                    cfg_status = 'ok'
                    lp = (cfg.get('plugins') or {}).get('antigravity-pulse')
                    if isinstance(lp, dict):
                        if lp.get('enabled') is True:
                            legacy_pulse = True
                        elif lp.get('enabled') is False:
                            pulse_explicitly_disabled = True
                    if isinstance(cfg.get('sidecars'), dict):
                        for sk, sv in cfg['sidecars'].items():
                            if is_legacy_sidecar_key(sk) and isinstance(sv, dict) and sv.get('enabled') is True:
                                legacy_pulse = True
        except Exception as e:
            cfg_status = 'corrupt'
            cfg_error = str(e)

    if not legacy_pulse and not pulse_explicitly_disabled and os.path.exists(legacy_pulse_dir):
        legacy_pulse = True

    existing_inline = 'unset'
    if os.path.exists(settings_path):
        try:
            s = json.loads(read_text(settings_path))
            if isinstance(s, dict) and isinstance(s.get('inline'), bool):
                existing_inline = 'true' if s['inline'] else 'false'
        except Exception:
            pass

    clean_err = re.sub(r'[\r\n|]+', ' ', cfg_error)
    sys.stdout.write(f"{cfg_status}|{'true' if legacy_pulse else 'false'}|{existing_inline}|{clean_err}")
    sys.exit(0)

if op == 'merge':
    cfg_path, bak_dir, settings_path, inline_mode, disable_legacy_pulse, repair_corrupt = args[:6]
    cfg = {}
    repaired_cfg = False
    if os.path.exists(cfg_path):
        raw = read_text(cfg_path)
        parsed = None
        err_msg = ''
        if not raw.strip():
            err_msg = '现有 config.json 为空'
        else:
            try:
                parsed = json.loads(raw)
                if not isinstance(parsed, dict):
                    err_msg = 'config.json 根节点必须为 JSON 对象'
                    parsed = None
            except Exception as e:
                err_msg = f"config.json 不是合法 JSON: {e}"
        if err_msg:
            if repair_corrupt == 'true':
                bak = backup_raw_file(cfg_path, bak_dir, 'config-corrupt')
                sys.stderr.write(f"[已修复] 原损坏 config.json 已备份至: {bak}\n")
                restored = find_latest_valid_config_backup(bak_dir)
                if restored:
                    rpath, rdata = restored
                    cfg = rdata
                    sys.stderr.write(f"[已修复] 已优先从最近有效备份恢复原有配置: {rpath}\n")
                else:
                    cfg = {}
                repaired_cfg = True
            else:
                sys.stderr.write(f"[错误] {err_msg}，已中止以免覆盖原配置（可加 --repair-corrupt-config 或 --fix 自动备份并恢复/重建）。\n")
                sys.exit(4)
        else:
            backup_raw_file(cfg_path, bak_dir, 'config')
            cfg = parsed

    if 'plugins' in cfg and not isinstance(cfg['plugins'], dict):
        if repair_corrupt == 'true':
            cfg['plugins'] = {}
            repaired_cfg = True
        else:
            sys.stderr.write('[错误] config.json 中 plugins 字段类型异常。\n')
            sys.exit(4)
    if 'sidecars' in cfg and not isinstance(cfg['sidecars'], dict):
        if repair_corrupt == 'true':
            cfg['sidecars'] = {}
            repaired_cfg = True
        else:
            sys.stderr.write('[错误] config.json 中 sidecars 字段类型异常。\n')
            sys.exit(4)

    if not isinstance(cfg.get('plugins'), dict):
        cfg['plugins'] = {}
    if not isinstance(cfg.get('sidecars'), dict):
        cfg['sidecars'] = {}

    if 'antigravity-token-meter' in cfg['plugins'] and not isinstance(cfg['plugins']['antigravity-token-meter'], dict):
        if repair_corrupt != 'true':
            sys.stderr.write('[错误] plugins["antigravity-token-meter"] 字段类型异常。\n')
            sys.exit(4)
        cfg['plugins']['antigravity-token-meter'] = {}
    prev_plugin = cfg['plugins'].get('antigravity-token-meter')
    next_plugin = dict(prev_plugin) if isinstance(prev_plugin, dict) else {}
    next_plugin['enabled'] = True
    cfg['plugins']['antigravity-token-meter'] = next_plugin

    if 'antigravity-token-meter/meter' in cfg['sidecars'] and not isinstance(cfg['sidecars']['antigravity-token-meter/meter'], dict):
        if repair_corrupt != 'true':
            sys.stderr.write('[错误] sidecars["antigravity-token-meter/meter"] 字段类型异常。\n')
            sys.exit(4)
        cfg['sidecars']['antigravity-token-meter/meter'] = {}
    prev_sc = cfg['sidecars'].get('antigravity-token-meter/meter')
    # 严格遵守 Antigravity 2.33+/2.34+ 官方 SidecarUserConfig 规范（绝不伪造 projectId）
    next_sc = dict(prev_sc) if isinstance(prev_sc, dict) else {}
    next_sc['enabled'] = True
    if next_sc.get('schemaVersion') is None:
        next_sc['schemaVersion'] = 1
    if not isinstance(next_sc.get('resolvedPermissions'), dict):
        next_sc['resolvedPermissions'] = {}
    cfg['sidecars']['antigravity-token-meter/meter'] = next_sc

    if disable_legacy_pulse == 'true':
        legacy_pulse_dir = os.path.join(os.path.dirname(cfg_path), 'plugins', 'antigravity-pulse')
        if 'antigravity-pulse' in cfg['plugins'] or os.path.exists(legacy_pulse_dir):
            old_p = cfg['plugins'].get('antigravity-pulse')
            np = dict(old_p) if isinstance(old_p, dict) else {}
            np['enabled'] = False
            cfg['plugins']['antigravity-pulse'] = np
        for sk in list(cfg['sidecars'].keys()):
            if sk == 'antigravity-pulse' or sk.startswith('antigravity-pulse/'):
                old_s = cfg['sidecars'][sk]
                ns = dict(old_s) if isinstance(old_s, dict) else {}
                ns['enabled'] = False
                cfg['sidecars'][sk] = ns

    settings = {}
    if os.path.exists(settings_path):
        try:
            s = json.loads(read_text(settings_path))
            if isinstance(s, dict):
                settings = s
            else:
                backup_raw_file(settings_path, bak_dir, 'settings-corrupt')
        except Exception:
            backup_raw_file(settings_path, bak_dir, 'settings-corrupt')

    settings['enabled'] = True
    if inline_mode == 'true':
        settings['inline'] = True
    elif inline_mode == 'false':
        settings['inline'] = False
    elif not isinstance(settings.get('inline'), bool):
        settings['inline'] = True

    atomic_write_json(cfg_path, cfg)
    atomic_write_json(settings_path, settings)
    sys.stdout.write(f"{'true' if settings['inline'] else 'false'}|{'true' if repaired_cfg else 'false'}")
    sys.exit(0)

if op == 'init_prefs':
    prefs_path = args[0]
    if os.path.exists(prefs_path):
        sys.exit(0)
    def pick(raw):
        if not raw or not isinstance(raw, str):
            return None
        tag = re.sub(r'[.@].*$', '', raw.split(':')[0].strip()).replace('_', '-')
        if not tag or re.match(r'^(?:c|posix)$', tag, re.I):
            return None
        if re.match(r'^zh(?:-|$)', tag, re.I):
            return 'zh-CN'
        if re.match(r'^[a-z]{2,3}(?:-|$)', tag, re.I):
            return 'en'
        return None
    lang = None
    for k in ('AG_TM_LANG', 'LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'):
        lang = pick(os.environ.get(k))
        if lang:
            break
    if not lang:
        try:
            lang = pick(locale.getlocale()[0])
        except Exception:
            pass
    atomic_write_json(prefs_path, {
        'language': lang or 'zh-CN',
        'theme': 'swiss',
        'showSpeed': True,
        'showCache': True,
        'showContext': True,
        'showQuota': True,
        'showToday': False,
        'showMonth': True,
        'showCost': False,
        'version': 1,
    })
    sys.exit(0)

if op == 'doctor':
    target_home, os_name, cfg_dir, dst_plugin, cfg_json, settings_json, status_json, json_mode, proc_count_str, proc_has_debug = args[:10]
    checks = []
    fail_count = 0
    is_json = json_mode == 'true'

    def add_check(cid, status, detail, hint=''):
        global fail_count
        checks.append({'id': cid, 'status': status, 'detail': detail, 'hint': hint})
        if status == 'fail':
            fail_count += 1
        if not is_json:
            print(f"[{status.upper()}] {cid} - {detail}")
            if hint:
                print(f"       修复建议: {hint}")

    required = ['plugin.json', 'LICENSE', 'assets/logo.svg', 'sidecars/meter/sidecar.json', 'sidecars/meter/main.mjs']
    missing = [rel for rel in required if not os.path.isfile(os.path.join(dst_plugin, rel))]
    if not missing:
        add_check('1/7 插件文件', 'pass', '插件核心文件、sidecar.json 与 MIT LICENSE 完整')
    else:
        add_check('1/7 插件文件', 'fail', f"插件目录缺失关键文件: {', '.join(missing)}", '请运行 bash scripts/install_mac_linux.sh --fix 重新部署插件。')

    cfg_exists = os.path.isfile(cfg_json)
    legacy_pulse_dir = os.path.join(os.path.dirname(dst_plugin), 'antigravity-pulse')
    def is_legacy_sidecar_key(k):
        return k == 'antigravity-pulse' or k.startswith('antigravity-pulse/')
    cfg_corrupt = False
    plugin_enabled = False
    sidecar_enabled = False
    sidecar_schema_ok = False
    legacy_pulse = False
    pulse_explicitly_disabled = False

    if cfg_exists:
        try:
            raw = read_text(cfg_json)
            if not raw.strip():
                cfg_corrupt = True
            else:
                cfg = json.loads(raw)
                if not isinstance(cfg, dict):
                    cfg_corrupt = True
                else:
                    pe = (cfg.get('plugins') or {}).get('antigravity-token-meter') if isinstance(cfg.get('plugins'), dict) else None
                    se = (cfg.get('sidecars') or {}).get('antigravity-token-meter/meter') if isinstance(cfg.get('sidecars'), dict) else None
                    lp = (cfg.get('plugins') or {}).get('antigravity-pulse') if isinstance(cfg.get('plugins'), dict) else None
                    if isinstance(pe, dict) and pe.get('enabled') is True:
                        plugin_enabled = True
                    if isinstance(se, dict) and se.get('enabled') is True:
                        sidecar_enabled = True
                        sidecar_schema_ok = (se.get('schemaVersion') is not None) and isinstance(se.get('resolvedPermissions'), dict)
                    if isinstance(lp, dict):
                        if lp.get('enabled') is True:
                            legacy_pulse = True
                        elif lp.get('enabled') is False:
                            pulse_explicitly_disabled = True
                    if isinstance(cfg.get('sidecars'), dict):
                        for sk, sv in cfg['sidecars'].items():
                            if is_legacy_sidecar_key(sk) and isinstance(sv, dict) and sv.get('enabled') is True:
                                legacy_pulse = True
        except Exception:
            cfg_corrupt = True
    if not cfg_corrupt and not legacy_pulse and not pulse_explicitly_disabled and os.path.exists(legacy_pulse_dir):
        legacy_pulse = True

    if cfg_corrupt:
        add_check('2/7 插件注册', 'fail', '宿主 config.json 为空或存在 JSON 语法损坏', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 自动备份并恢复/重建。')
        add_check('3/7 Sidecar 启用', 'fail', '因 config.json 损坏无法确认 sidecar 注册状态', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix。')
    else:
        if plugin_enabled and legacy_pulse:
            add_check('2/7 插件注册', 'warn', '已启用 TokenMeter，但旧版 antigravity-pulse 仍处于启用状态（可能导致底部状态条重影）', '建议彻底退出 Antigravity 后执行 bash scripts/install_mac_linux.sh --fix --disable-legacy-pulse。')
        elif plugin_enabled:
            add_check('2/7 插件注册', 'pass', 'config.json 已启用 plugins["antigravity-token-meter"]')
        elif not cfg_exists:
            add_check('2/7 插件注册', 'fail', '尚未检测到宿主 config.json 配置文件', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh。')
        else:
            add_check('2/7 插件注册', 'fail', 'config.json 中 plugins["antigravity-token-meter"] 未启用', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix。')

        if sidecar_enabled and sidecar_schema_ok:
            add_check('3/7 Sidecar 启用', 'pass', 'config.json 已按官方规范启用 sidecars["antigravity-token-meter/meter"]（含 schemaVersion 与 resolvedPermissions）')
        elif sidecar_enabled:
            add_check('3/7 Sidecar 启用', 'warn', 'sidecars["antigravity-token-meter/meter"] 已启用，但缺少 schemaVersion 或 resolvedPermissions 字段', '建议彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 补全官方字段。')
        else:
            add_check('3/7 Sidecar 启用', 'fail', 'config.json 未启用 sidecars["antigravity-token-meter/meter"] 后台进程', '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix 自动补齐。')

    inline_wanted = True
    inline_source = 'default'
    local_enabled = True
    settings_corrupt = False
    custom_profile = None
    if os.path.isfile(settings_json):
        try:
            s = json.loads(read_text(settings_json))
            if not isinstance(s, dict):
                settings_corrupt = True
                inline_wanted = False
                inline_source = 'error'
            else:
                if s.get('enabled') is False:
                    local_enabled = False
                if isinstance(s.get('inline'), bool):
                    inline_wanted = s['inline']
                    inline_source = 'settings'
                elif 'inline' in s:
                    settings_corrupt = True
                    inline_wanted = False
                    inline_source = 'error'
                if isinstance(s.get('profile'), str) and s['profile'].strip():
                    custom_profile = s['profile'].strip()
        except Exception:
            settings_corrupt = True
            inline_wanted = False
            inline_source = 'error'
    env_inline = parse_bool_env(os.environ.get('AG_TM_INLINE'))
    if env_inline is not None and not settings_corrupt:
        inline_wanted = env_inline
        inline_source = 'env'

    launcher_path = (
        os.path.join(cfg_dir, 'launch-antigravity-token-meter.command')
        if os_name == 'Darwin'
        else os.path.join(cfg_dir, 'launch-antigravity-token-meter.sh')
    )

    if settings_corrupt:
        add_check('4/7 本地运行配置', 'fail', '本地 settings.json 格式损坏或 inline 字段类型非法，内嵌模式已被安全关闭', '请运行 bash scripts/install_mac_linux.sh --fix 自动备份并重建配置。')
    elif not local_enabled:
        add_check('4/7 本地运行配置', 'warn', '本地 settings.json 中 enabled=false，插件当前处于停用状态', '如需恢复监控，请运行 bash scripts/install_mac_linux.sh --fix。')
    elif inline_wanted and not os.path.isfile(launcher_path):
        add_check('4/7 本地运行配置', 'warn', f'已启用内嵌模式（来源: {inline_source}），但尚未生成独立启动器 {launcher_path}', '可运行 bash scripts/install_mac_linux.sh --fix 自动补建独立启动器。')
    elif inline_wanted:
        add_check('4/7 本地运行配置', 'pass', f'完整模式已就绪（侧边栏 + 底部内嵌，来源: {inline_source}，独立启动器存在）')
    else:
        add_check('4/7 本地运行配置', 'pass', f'纯侧边栏面板模式已就绪（inline=false，来源: {inline_source}）')

    proc_count = int(proc_count_str) if proc_count_str.isdigit() else 0
    start_hint = (
        f'请双击或运行 "{launcher_path}" 启动 Antigravity'
        if os_name == 'Darwin'
        else f'请从应用菜单点击 "Antigravity (TokenMeter Inline)" 或运行 "{launcher_path}" 启动 Antigravity'
    )
    restart_hint = (
        f'请先按 Cmd+Q 彻底退出 Antigravity，再运行 "{launcher_path}"'
        if os_name == 'Darwin'
        else f'请先从系统托盘彻底退出 Antigravity，再运行 "{launcher_path}"'
    )

    if settings_corrupt:
        add_check('5/7 主进程参数', 'fail', '本地 settings.json 损坏，无法确认内嵌目标模式', '请先运行 bash scripts/install_mac_linux.sh --fix 重建配置。')
    elif not local_enabled:
        add_check('5/7 主进程参数', 'warn', '插件本地已停用（enabled=false）', '如需恢复监控，请运行 bash scripts/install_mac_linux.sh --fix。')
    elif proc_count == 0:
        add_check('5/7 主进程参数', 'warn', '未检测到运行中的 Antigravity 主进程', start_hint if inline_wanted else '正常打开 Antigravity 即可在侧边栏使用 TokenMeter。')
    elif proc_has_debug == 'true':
        add_check('5/7 主进程参数', 'pass', 'Antigravity 主进程已携带 --remote-debugging-port 启动参数')
    elif not inline_wanted:
        add_check('5/7 主进程参数', 'pass', '当前为纯侧边栏模式（未开启实验内嵌，无需调试端口）')
    else:
        add_check('5/7 主进程参数', 'fail', 'Antigravity 主进程未携带 --remote-debugging-port=0（常见于关闭窗口后仍驻留 Dock/托盘，新参数被 Electron 单实例锁吞掉）', f'{restart_hint}（或附加 --restart 参数安全重启）。')

    if settings_corrupt:
        add_check('6/7 本地调试端口', 'fail', '因本地 settings.json 损坏跳过内嵌端口检测', '请运行 bash scripts/install_mac_linux.sh --fix 修复配置。')
    elif not inline_wanted:
        add_check('6/7 本地调试端口', 'pass', '纯侧边栏模式无需检测本地 CDP 调试端口')
    else:
        profiles = []
        def add_prof(p):
            if p and p not in profiles:
                profiles.append(p)
        for ek in ('AG_TM_PROFILE', 'ANTIGRAVITY_USER_DATA_DIR', 'ELECTRON_USER_DATA_DIR'):
            raw_v = os.environ.get(ek, '')
            if raw_v.strip():
                for part in raw_v.split(':'):
                    if part.strip():
                        add_prof(part.strip())
        if custom_profile:
            add_prof(custom_profile)
        if os_name == 'Darwin':
            sup = os.path.join(target_home, 'Library', 'Application Support')
            add_prof(os.path.join(sup, 'Antigravity'))
            add_prof(os.path.join(sup, 'antigravity'))
            add_prof(os.path.join(sup, 'Antigravity - Insiders'))
            add_prof(os.path.join(sup, 'Antigravity Insiders'))
        else:
            xdg_cfg = os.path.join(target_home, '.config') if os.environ.get('AG_TEST_HOME') else (os.environ.get('XDG_CONFIG_HOME') or os.path.join(target_home, '.config'))
            add_prof(os.path.join(xdg_cfg, 'Antigravity'))
            add_prof(os.path.join(xdg_cfg, 'antigravity'))
            add_prof(os.path.join(xdg_cfg, 'Antigravity - Insiders'))
            add_prof(os.path.join(xdg_cfg, 'antigravity-insiders'))
            add_prof(os.path.join(target_home, '.config', 'Antigravity'))
            add_prof(os.path.join(target_home, '.config', 'antigravity'))

        port_files = [os.path.join(d, 'DevToolsActivePort') for d in profiles if os.path.isfile(os.path.join(d, 'DevToolsActivePort'))]
        if not port_files:
            if proc_count == 0:
                add_check('6/7 本地调试端口', 'warn', 'Antigravity 当前未运行，尚未生成 DevToolsActivePort 调试端口文件', start_hint)
            else:
                add_check('6/7 本地调试端口', 'fail', '未在配置目录检测到 DevToolsActivePort 文件', restart_hint)
        else:
            connected_port = None
            pages = 0
            last_err = ''
            for pf in port_files:
                try:
                    first = read_text(pf).splitlines()[0].strip()
                    if not re.match(r'^[1-9]\d{0,4}$', first) or int(first) > 65535:
                        last_err = f"端口文件首行不是合法端口号 ({pf})"
                        continue
                    port_num = int(first)
                    ok, pg, err = probe_local_cdp(port_num)
                    if ok:
                        connected_port = port_num
                        pages = pg
                        break
                    last_err = f"端口 {port_num} 不可达 ({err})，可能为上次退出残留的过期端口"
                except Exception as e:
                    last_err = str(e)
            if connected_port is not None:
                add_check('6/7 本地调试端口', 'pass', f"DevToolsActivePort 连通正常 (port={connected_port}, pages={pages})")
            elif proc_count == 0:
                add_check('6/7 本地调试端口', 'warn', f"Antigravity 当前未运行（目录中仅残留过期调试端口：{last_err}）", start_hint)
            else:
                add_check('6/7 本地调试端口', 'fail', f"检测到 DevToolsActivePort 但无法连接：{last_err}", restart_hint)

    if os.path.isfile(status_json):
        try:
            st = json.loads(read_text(status_json))
            pid_raw = st.get('pid')
            pid_num = int(pid_raw) if isinstance(pid_raw, (int, float)) else 0
            alive = is_pid_alive(pid_num)
            age_sec = 99999.0
            checked_at = st.get('checkedAt')
            if isinstance(checked_at, str) and checked_at.strip():
                iso = checked_at.strip()
                if iso.endswith('Z'):
                    iso = iso[:-1] + '+00:00'
                iso = re.sub(r'\.(\d+)', lambda m: '.' + (m.group(1)[:6].ljust(6, '0')), iso)
                try:
                    dt = datetime.datetime.fromisoformat(iso)
                    if dt.tzinfo is None:
                        dt = dt.replace(tzinfo=datetime.timezone.utc)
                    age_sec = abs((datetime.datetime.now(datetime.timezone.utc) - dt.astimezone(datetime.timezone.utc)).total_seconds())
                except Exception:
                    pass
            state = st.get('state')
            code = st.get('code') or state or 'unknown'
            if state == 'error':
                msg = f" - {st.get('errorMessage')}" if st.get('errorMessage') else ''
                add_check('7/7 运行实例与挂载', 'fail', f"sidecar 启动失败 (code={code}{msg})", '请彻底退出 Antigravity 后运行 bash scripts/install_mac_linux.sh --fix，并确认 Antigravity 版本为 2.33+。')
            elif not alive or age_sec > 30:
                if proc_count == 0:
                    add_check('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，TokenMeter sidecar 将在下次启动客户端时自动拉起', start_hint if inline_wanted else '正常打开 Antigravity 即可启用 TokenMeter。')
                else:
                    add_check('7/7 运行实例与挂载', 'fail', '状态文件已过期或对应 sidecar 后台进程未运行', '请确认 Antigravity 正在运行，并在 Customizations -> Plugins 中确认 TokenMeter 已启用；若刚安装，请彻底退出后重启客户端。')
            elif state == 'mounted':
                add_check('7/7 运行实例与挂载', 'pass', f"sidecar 存活且底部状态条已挂载 (windows={st.get('windows', 0)})")
            elif state == 'waiting_composer':
                add_check('7/7 运行实例与挂载', 'warn', f"sidecar 已连上主窗口 (windows={st.get('windows', 0)})，当前页面无聊天输入框，进入任意对话即自动显示底栏")
            elif not inline_wanted and (state == 'disabled' or code == 'inline_disabled'):
                add_check('7/7 运行实例与挂载', 'pass', 'sidecar 存活（纯侧边栏面板模式运行正常）')
            else:
                add_check('7/7 运行实例与挂载', 'fail', f"sidecar 存活但底部条尚未挂载 (state={state}, code={code})", restart_hint)
        except Exception:
            if proc_count == 0:
                add_check('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，历史 integration-status.json 无法解析（下次启动时将自动重建）', start_hint if inline_wanted else '正常打开 Antigravity 即可。')
            else:
                add_check('7/7 运行实例与挂载', 'fail', 'integration-status.json 解析失败', '请彻底重启一次 Antigravity 让 sidecar 重新生成状态文件。')
    elif proc_count == 0:
        add_check('7/7 运行实例与挂载', 'warn', 'Antigravity 当前未运行，尚未生成 sidecar 运行状态文件（首次启动客户端后自动生效）', start_hint if inline_wanted else '正常打开 Antigravity 即可启用 TokenMeter。')
    else:
        add_check('7/7 运行实例与挂载', 'fail', '尚未检测到 TokenMeter sidecar 运行状态文件', '安装完成后必须彻底退出并重启 Antigravity 客户端，sidecar 才会首次启动。')

    if is_json:
        print(json.dumps({'ok': fail_count == 0, 'failures': fail_count, 'checks': checks}, ensure_ascii=False, indent=2))
    else:
        print('')
        if fail_count == 0:
            print('全部 7 项关键诊断通过！')
        else:
            print(f"发现 {fail_count} 项异常，请按上方「修复建议」处理，或运行 bash scripts/install_mac_linux.sh --fix 自动修复。")
    sys.exit(1 if fail_count > 0 else 0)
PY_EOF
  fi
}

# -------------------- 跨平台 Antigravity GUI 主进程检测（BSD/GNU 通用） --------------------
PROC_COUNT=0
PROC_HAS_DEBUG="false"
PROC_PIDS=""

detect_antigravity_gui() {
  PROC_COUNT=0
  PROC_HAS_DEBUG="false"
  PROC_PIDS=""
  if [[ -n "${AG_TEST_HOME:-}" ]]; then
    if [[ "${AG_TEST_FAKE_PROC:-}" == "no_debug" ]]; then
      PROC_COUNT=1
      PROC_HAS_DEBUG="false"
      PROC_PIDS=""
    elif [[ "${AG_TEST_FAKE_PROC:-}" == "with_debug" ]]; then
      PROC_COUNT=1
      PROC_HAS_DEBUG="true"
      PROC_PIDS=""
    fi
    return 0
  fi

  local ps_out=""
  ps_out="$(ps -eo pid=,args= 2>/dev/null || ps -axo pid=,command= 2>/dev/null || true)"
  if [[ -z "$ps_out" ]]; then
    return 0
  fi

  local parsed=""
  parsed="$(printf '%s\n' "$ps_out" | awk -v self="$$" -v parent="$PPID" -v os="$OS_NAME" '
    {
      pid = $1 + 0
      if (pid <= 0 || pid == self || pid == parent) next
      line = $0
      sub(/^[ \t]*[0-9]+[ \t]+/, "", line)
      if (line == "") next
      low = tolower(line)
      if (index(low, "--type=") > 0) next
      if (index(low, "sidecar_sdk") > 0) next
      if (index(low, "language_server") > 0) next
      if (index(low, "antigravity-token-meter") > 0) next
      if (index(low, "crashpad") > 0) next
      if (index(low, "antigravity helper") > 0) next
      if (index(low, "install_mac_linux.sh") > 0) next
      if (index(low, "launch-antigravity-token-meter") > 0) next

      matched = 0
      if (os == "Darwin") {
        if (low ~ /^\/.*\/antigravity[^\/]*\.app\/contents\/macos\/antigravity([ \t]|$)/ &&
            low !~ /^\/(bin|sbin|usr\/(local\/)?bin|opt\/homebrew\/bin)\//) {
          matched = 1
        }
      } else {
        if (low ~ /^([^ \t]*\/)?antigravity(-insiders)?([ \t]|$)/) {
          matched = 1
        }
      }

      if (matched) {
        count++
        pids = (pids == "" ? pid : pids " " pid)
        if (line ~ /(^|[ \t])--remote-debugging-port=[0-9]+/) {
          has_debug = 1
        }
      }
    }
    END {
      printf "%d|%s|%s\n", count + 0, (has_debug ? "true" : "false"), pids
    }
  ')"

  IFS='|' read -r PROC_COUNT PROC_HAS_DEBUG PROC_PIDS <<EOF || true
$parsed
EOF
  PROC_COUNT="${PROC_COUNT:-0}"
  PROC_HAS_DEBUG="${PROC_HAS_DEBUG:-false}"
  PROC_PIDS="${PROC_PIDS:-}"
}

graceful_quit_antigravity() {
  if [[ -n "${AG_TEST_HOME:-}" ]]; then
    return 0
  fi
  if [[ "$OS_NAME" == "Darwin" ]]; then
    osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
    osascript -e 'tell application "Antigravity Insiders" to quit' >/dev/null 2>&1 || true
  fi
  if [[ -n "$PROC_PIDS" && "$OS_NAME" != "Darwin" ]]; then
    local p=""
    for p in $PROC_PIDS; do
      kill -TERM "$p" >/dev/null 2>&1 || true
    done
  fi

  local i=0
  while [[ "$i" -lt 20 ]]; do
    detect_antigravity_gui
    if [[ "$PROC_COUNT" -eq 0 ]]; then
      return 0
    fi
    if [[ "$i" -eq 8 && "$OS_NAME" == "Darwin" && -n "$PROC_PIDS" ]]; then
      local p=""
      for p in $PROC_PIDS; do
        kill -TERM "$p" >/dev/null 2>&1 || true
      done
    fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

ensure_antigravity_stopped() {
  detect_antigravity_gui
  if [[ "$PROC_COUNT" -eq 0 ]]; then
    return 0
  fi

  local should_auto_quit="false"
  if [[ "$AUTO_RESTART" == "true" ]]; then
    should_auto_quit="true"
  elif [[ "$IS_INTERACTIVE" == "true" ]]; then
    log_info ""
    log_info "[重要] 检测到 Antigravity 主界面正在运行（关闭窗口默认驻留 Dock/托盘）。"
    log_info "       若不先彻底退出，客户端内存快照会在退出时覆盖刚写入的 config.json，且无法热启动。"
    local ans=""
    read -r -p "是否由本脚本优雅关闭 Antigravity、写入配置后自动重启？[推荐回车默认 y] (Y/n): " ans || true
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss])
        should_auto_quit="true"
        AUTO_RESTART="true"
        ;;
      *)
        log_info "请先手动彻底退出 Antigravity（macOS 按 Cmd+Q，Linux 右键托盘选退出）。"
        read -r -p "确认已彻底退出后按回车继续..." _ || true
        local wait_i=0
        while [[ "$wait_i" -lt 16 ]]; do
          detect_antigravity_gui
          if [[ "$PROC_COUNT" -eq 0 ]]; then
            return 0
          fi
          sleep 0.5
          wait_i=$((wait_i + 1))
        done
        log_err "[错误] 仍检测到 Antigravity 主界面在运行，已安全中止（未修改任何文件）。"
        exit 3
        ;;
    esac
  else
    log_err "[错误] 检测到 Antigravity 主界面正在运行，运行中写入 config.json 会被宿主覆盖且无法热启动。"
    log_err "       请先彻底退出客户端（macOS 按 Cmd+Q / Linux 退出托盘）后重试，或附加 --restart 自动安全重启。"
    exit 3
  fi

  if [[ "$should_auto_quit" == "true" ]]; then
    log_info "[处理中] 正在优雅退出 Antigravity..."
    if ! graceful_quit_antigravity; then
      log_err "[错误] 等待 Antigravity 退出超时，已安全中止（未修改任何文件）。请手动按 Cmd+Q / 退出托盘后重试。"
      exit 3
    fi
    log_info "         已确认 Antigravity 彻底退出。"
  fi
}

# -------------------- 生成独立安全启动器（防 Electron 单实例锁吞参数 + DevToolsActivePort 校验） --------------------
generate_launchers() {
  mkdir -p "$CFG_DIR"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    local launcher="$CFG_DIR/launch-antigravity-token-meter.command"
    cat > "$launcher" <<'LAUNCHER_MAC_EOF'
#!/usr/bin/env bash
set -euo pipefail

# Antigravity TokenMeter — macOS 独立启动器（防单实例锁吞参数 + 自动校验 DevToolsActivePort）
AUTO_RESTART="false"
for arg in "$@"; do
  if [[ "$arg" == "--restart" || "$arg" == "--auto-restart" ]]; then
    AUTO_RESTART="true"
  fi
done

find_app_target() {
  local cand=""
  for cand in \
    "/Applications/Antigravity.app" \
    "$HOME/Applications/Antigravity.app" \
    "/Applications/Antigravity - Insiders.app" \
    "$HOME/Applications/Antigravity - Insiders.app" \
    "/Applications/Antigravity Insiders.app" \
    "$HOME/Applications/Antigravity Insiders.app"
  do
    if [[ -d "$cand" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  if command -v mdfind >/dev/null 2>&1; then
    cand="$(mdfind 'kMDItemFSName == "Antigravity.app"' 2>/dev/null | head -n 1 || true)"
    if [[ -n "$cand" && -d "$cand" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  fi
  printf '%s\n' "Antigravity"
}

detect_running_gui() {
  local ps_out=""
  ps_out="$(ps -eo pid=,args= 2>/dev/null || ps -axo pid=,command= 2>/dev/null || true)"
  printf '%s\n' "$ps_out" | awk -v self="$$" -v parent="$PPID" '
    {
      pid = $1 + 0
      if (pid <= 0 || pid == self || pid == parent) next
      line = $0
      sub(/^[ \t]*[0-9]+[ \t]+/, "", line)
      low = tolower(line)
      if (index(low, "--type=") > 0 || index(low, "sidecar_sdk") > 0 || index(low, "language_server") > 0 ||
          index(low, "antigravity helper") > 0 || index(low, "crashpad") > 0 || index(low, "antigravity-token-meter") > 0) next
      if (low ~ /^\/.*\/antigravity[^\/]*\.app\/contents\/macos\/antigravity([ \t]|$)/ &&
          low !~ /^\/(bin|sbin|usr\/(local\/)?bin|opt\/homebrew\/bin)\//) {
        count++
        pids = (pids == "" ? pid : pids " " pid)
        if (line ~ /(^|[ \t])--remote-debugging-port=[0-9]+/) has_debug = 1
      }
    }
    END { printf "%d|%s|%s\n", count + 0, (has_debug ? "true" : "false"), pids }
  '
}

read_custom_profile() {
  local sfile="$HOME/Library/Application Support/AntigravityTokenMeter/settings.json"
  [[ ! -f "$sfile" ]] && return 0
  if command -v node >/dev/null 2>&1; then
    node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,""));if(s&&typeof s.profile==="string")process.stdout.write(s.profile.trim())}catch{}' "$sfile" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try:
 s=json.load(open(sys.argv[1],encoding="utf-8-sig"))
 if isinstance(s,dict) and isinstance(s.get("profile"),str): sys.stdout.write(s["profile"].strip())
except Exception: pass' "$sfile" 2>/dev/null || true
  fi
}

check_port_http() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:${port}/json/list" >/dev/null 2>&1 && return 0
  elif command -v node >/dev/null 2>&1; then
    node -e 'const h=require("http");const r=h.request({hostname:"127.0.0.1",port:Number(process.argv[1]),family:4,path:"/json/list",agent:false},res=>{process.exit(res.statusCode===200?0:1)});r.setTimeout(2000,()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1));r.end()' "$port" >/dev/null 2>&1 && return 0
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PYCHK' >/dev/null 2>&1 && return 0
import sys, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(f"http://127.0.0.1:{sys.argv[1]}/json/list", timeout=2) as r:
    sys.exit(0 if r.status == 200 else 1)
PYCHK
  fi
  return 1
}

probe_devtools_port() {
  local custom_prof=""
  custom_prof="$(read_custom_profile || true)"
  local prof=""
  local pf=""
  local port=""
  for prof in \
    "${AG_TM_PROFILE:-}" \
    "${ANTIGRAVITY_USER_DATA_DIR:-}" \
    "${ELECTRON_USER_DATA_DIR:-}" \
    "$custom_prof" \
    "$HOME/Library/Application Support/Antigravity" \
    "$HOME/Library/Application Support/antigravity" \
    "$HOME/Library/Application Support/Antigravity - Insiders" \
    "$HOME/Library/Application Support/Antigravity Insiders"
  do
    [[ -z "$prof" ]] && continue
    pf="$prof/DevToolsActivePort"
    if [[ -f "$pf" ]]; then
      port="$(head -n 1 "$pf" 2>/dev/null | tr -d '\r\n ')"
      if [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && [[ "$port" -le 65535 ]]; then
        if check_port_http "$port"; then
          printf '%s\n' "$port"
          return 0
        fi
      fi
    fi
  done
  return 1
}

APP_TARGET="$(find_app_target)"
IFS='|' read -r PCOUNT PHASDEBUG PPIDS <<EOF || true
$(detect_running_gui)
EOF

if [[ "${PCOUNT:-0}" -gt 0 ]]; then
  if [[ "${PHASDEBUG:-false}" == "true" ]]; then
    printf '%s\n' "[正常] Antigravity 已携带 --remote-debugging-port 运行中，正在唤起窗口..."
    open -a "$APP_TARGET" >/dev/null 2>&1 || true
    if READY_PORT="$(probe_devtools_port)"; then
      printf '%s\n' "[就绪] 本地调试端口连通正常 (port=$READY_PORT)。"
    fi
    exit 0
  fi

  printf '%s\n' "[提示] 检测到 Antigravity 已在后台运行且未开启调试端口（常见于关闭窗口后仍驻留 Dock）。"
  printf '%s\n' "       直接启动会被 Electron 单实例锁吞掉 --remote-debugging-port=0 参数！"
  DO_RESTART="$AUTO_RESTART"
  if [[ "$DO_RESTART" != "true" && -t 0 ]]; then
    ans=""
    read -r -p "是否优雅退出当前 Antigravity 并以调试端口重新启动？[推荐回车默认 y] (Y/n): " ans || true
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss]) DO_RESTART="true" ;;
    esac
  fi

  if [[ "$DO_RESTART" == "true" ]]; then
    printf '%s\n' "[处理中] 正在优雅退出当前 Antigravity..."
    osascript -e 'tell application "Antigravity" to quit' >/dev/null 2>&1 || true
    osascript -e 'tell application "Antigravity Insiders" to quit' >/dev/null 2>&1 || true
    i=0
    while [[ "$i" -lt 20 ]]; do
      IFS='|' read -r PCOUNT PHASDEBUG PPIDS <<EOF || true
$(detect_running_gui)
EOF
      if [[ "${PCOUNT:-0}" -eq 0 ]]; then
        break
      fi
      if [[ "$i" -eq 8 && -n "${PPIDS:-}" ]]; then
        for p in $PPIDS; do kill -TERM "$p" >/dev/null 2>&1 || true; done
      fi
      sleep 0.5
      i=$((i + 1))
    done
    if [[ "${PCOUNT:-0}" -gt 0 ]]; then
      printf '%s\n' "[错误] Antigravity 未能在 10 秒内退出，请手动按 Cmd+Q 彻底退出后再双击本启动器。"
      [[ -t 0 ]] && read -r -p "按回车键关闭..." _ || true
      exit 5
    fi
  else
    printf '%s\n' "请先按 Cmd+Q 彻底退出 Antigravity，再双击本启动器（或在终端加 --restart 参数）。"
    [[ -t 0 ]] && read -r -p "按回车键退出..." _ || true
    exit 5
  fi
fi

printf '%s\n' "[启动] 正在启动 $APP_TARGET --remote-debugging-port=0 ..."
open -a "$APP_TARGET" --args --remote-debugging-port=0

printf '%s\n' "[校验] 正在等待本地 DevToolsActivePort 调试端口就绪（最多 15 秒）..."
READY_PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if READY_PORT="$(probe_devtools_port)"; then
    break
  fi
  sleep 0.5
done

if [[ -n "$READY_PORT" ]]; then
  printf '%s\n' "[成功] DevToolsActivePort 已就绪 (port=$READY_PORT)，TokenMeter 底部内嵌状态条将自动挂载！"
  exit 0
else
  printf '%s\n' "[提示] 已拉起 Antigravity，但 15 秒内尚未检测到可达的 DevToolsActivePort。"
  printf '%s\n' "       若底部状态条未出现，请等待客户端完全加载后运行: bash scripts/install_mac_linux.sh --doctor"
  [[ -t 0 ]] && read -r -p "按回车键关闭..." _ || true
  exit 0
fi
LAUNCHER_MAC_EOF
    chmod +x "$launcher"
    log_info "[成功] 已生成独立的 macOS 启动器: $launcher"
  else
    local launcher_sh="$CFG_DIR/launch-antigravity-token-meter.sh"
    cat > "$launcher_sh" <<'LAUNCHER_LINUX_EOF'
#!/usr/bin/env bash
set -euo pipefail

# Antigravity TokenMeter — Linux 独立启动器（防单实例锁吞参数 + 自动校验 DevToolsActivePort）
AUTO_RESTART="false"
for arg in "$@"; do
  if [[ "$arg" == "--restart" || "$arg" == "--auto-restart" ]]; then
    AUTO_RESTART="true"
  fi
done

notify_user() {
  local title="$1"
  local body="$2"
  printf '%s\n' "[$title] $body"
  if command -v notify-send >/dev/null 2>&1; then
    notify-send "$title" "$body" >/dev/null 2>&1 || true
  fi
}

find_antigravity_bin() {
  local cand=""
  if command -v antigravity >/dev/null 2>&1; then
    command -v antigravity
    return 0
  fi
  for cand in \
    /usr/bin/antigravity \
    /usr/local/bin/antigravity \
    /opt/Antigravity/antigravity \
    /opt/antigravity/antigravity \
    /usr/share/antigravity/antigravity \
    "$HOME/.local/bin/antigravity"
  do
    if [[ -x "$cand" ]]; then
      printf '%s\n' "$cand"
      return 0
    fi
  done
  local dfile=""
  for dfile in \
    /usr/share/applications/*antigravity*.desktop \
    "$HOME/.local/share/applications"/*antigravity*.desktop
  do
    [[ ! -f "$dfile" ]] && continue
    case "$dfile" in
      *antigravity-token-meter.desktop) continue ;;
    esac
    local exec_line=""
    exec_line="$(grep -m 1 '^Exec=' "$dfile" 2>/dev/null | sed 's/^Exec=//' || true)"
    if [[ -n "$exec_line" ]]; then
      exec_line="$(printf '%s' "$exec_line" | sed 's/[[:space:]]*%[a-zA-Z]//g')"
      if [[ "${exec_line:0:1}" == '"' ]]; then
        cand="$(printf '%s' "$exec_line" | sed 's/^"\([^"]*\)".*/\1/')"
      else
        cand="$(printf '%s' "$exec_line" | awk '{print $1}')"
      fi
      if [[ -x "$cand" ]]; then
        printf '%s\n' "$cand"
        return 0
      fi
    fi
  done
  return 1
}

detect_running_gui() {
  local ps_out=""
  ps_out="$(ps -eo pid=,args= 2>/dev/null || true)"
  printf '%s\n' "$ps_out" | awk -v self="$$" -v parent="$PPID" '
    {
      pid = $1 + 0
      if (pid <= 0 || pid == self || pid == parent) next
      line = $0
      sub(/^[ \t]*[0-9]+[ \t]+/, "", line)
      low = tolower(line)
      if (index(low, "--type=") > 0 || index(low, "sidecar_sdk") > 0 || index(low, "language_server") > 0 ||
          index(low, "crashpad") > 0 || index(low, "antigravity-token-meter") > 0 || index(low, "launch-antigravity-token-meter") > 0) next
      if (low ~ /^([^ \t]*\/)?antigravity(-insiders)?([ \t]|$)/) {
        count++
        pids = (pids == "" ? pid : pids " " pid)
        if (line ~ /(^|[ \t])--remote-debugging-port=[0-9]+/) has_debug = 1
      }
    }
    END { printf "%d|%s|%s\n", count + 0, (has_debug ? "true" : "false"), pids }
  '
}

read_custom_profile() {
  local sfile="${XDG_DATA_HOME:-$HOME/.local/share}/AntigravityTokenMeter/settings.json"
  [[ ! -f "$sfile" ]] && return 0
  if command -v node >/dev/null 2>&1; then
    node -e 'try{const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8").replace(/^\uFEFF/,""));if(s&&typeof s.profile==="string")process.stdout.write(s.profile.trim())}catch{}' "$sfile" 2>/dev/null || true
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import json,sys
try:
 s=json.load(open(sys.argv[1],encoding="utf-8-sig"))
 if isinstance(s,dict) and isinstance(s.get("profile"),str): sys.stdout.write(s["profile"].strip())
except Exception: pass' "$sfile" 2>/dev/null || true
  fi
}

check_port_http() {
  local port="$1"
  if command -v curl >/dev/null 2>&1; then
    curl --noproxy '*' -fsS --max-time 2 "http://127.0.0.1:${port}/json/list" >/dev/null 2>&1 && return 0
  elif command -v node >/dev/null 2>&1; then
    node -e 'const h=require("http");const r=h.request({hostname:"127.0.0.1",port:Number(process.argv[1]),family:4,path:"/json/list",agent:false},res=>{process.exit(res.statusCode===200?0:1)});r.setTimeout(2000,()=>{r.destroy();process.exit(1)});r.on("error",()=>process.exit(1));r.end()' "$port" >/dev/null 2>&1 && return 0
  elif command -v python3 >/dev/null 2>&1; then
    python3 - "$port" <<'PYCHK' >/dev/null 2>&1 && return 0
import sys, urllib.request
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open(f"http://127.0.0.1:{sys.argv[1]}/json/list", timeout=2) as r:
    sys.exit(0 if r.status == 200 else 1)
PYCHK
  fi
  return 1
}

probe_devtools_port() {
  local xdg_cfg="${XDG_CONFIG_HOME:-$HOME/.config}"
  local custom_prof=""
  custom_prof="$(read_custom_profile || true)"
  local prof=""
  local pf=""
  local port=""
  for prof in \
    "${AG_TM_PROFILE:-}" \
    "${ANTIGRAVITY_USER_DATA_DIR:-}" \
    "${ELECTRON_USER_DATA_DIR:-}" \
    "$custom_prof" \
    "$xdg_cfg/Antigravity" \
    "$xdg_cfg/antigravity" \
    "$xdg_cfg/Antigravity - Insiders" \
    "$xdg_cfg/antigravity-insiders" \
    "$HOME/.config/Antigravity" \
    "$HOME/.config/antigravity"
  do
    [[ -z "$prof" ]] && continue
    pf="$prof/DevToolsActivePort"
    if [[ -f "$pf" ]]; then
      port="$(head -n 1 "$pf" 2>/dev/null | tr -d '\r\n ')"
      if [[ "$port" =~ ^[1-9][0-9]{0,4}$ ]] && [[ "$port" -le 65535 ]]; then
        if check_port_http "$port"; then
          printf '%s\n' "$port"
          return 0
        fi
      fi
    fi
  done
  return 1
}

AG_BIN=""
if ! AG_BIN="$(find_antigravity_bin)"; then
  notify_user "Antigravity TokenMeter" "未找到 antigravity 可执行文件，请手动执行: /你的路径/antigravity --remote-debugging-port=0"
  exit 1
fi

IFS='|' read -r PCOUNT PHASDEBUG PPIDS <<EOF || true
$(detect_running_gui)
EOF

if [[ "${PCOUNT:-0}" -gt 0 ]]; then
  if [[ "${PHASDEBUG:-false}" == "true" ]]; then
    printf '%s\n' "[正常] Antigravity 已携带 --remote-debugging-port 运行中，无需重复启动。"
    if READY_PORT="$(probe_devtools_port)"; then
      printf '%s\n' "[就绪] 本地调试端口连通正常 (port=$READY_PORT)。"
    fi
    exit 0
  fi

  notify_user "Antigravity TokenMeter" "检测到 Antigravity 已在后台运行且未开启调试端口，直接启动会被单实例锁吞掉 --remote-debugging-port=0。请先彻底退出托盘实例，或在终端加 --restart 参数重启。"
  DO_RESTART="$AUTO_RESTART"
  if [[ "$DO_RESTART" != "true" && -t 0 ]]; then
    ans=""
    read -r -p "是否优雅退出当前 Antigravity 并以调试端口重新启动？[推荐回车默认 y] (Y/n): " ans || true
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss]) DO_RESTART="true" ;;
    esac
  fi

  if [[ "$DO_RESTART" == "true" ]]; then
    for p in ${PPIDS:-}; do kill -TERM "$p" >/dev/null 2>&1 || true; done
    i=0
    while [[ "$i" -lt 20 ]]; do
      IFS='|' read -r PCOUNT PHASDEBUG PPIDS <<EOF || true
$(detect_running_gui)
EOF
      if [[ "${PCOUNT:-0}" -eq 0 ]]; then
        break
      fi
      sleep 0.5
      i=$((i + 1))
    done
    if [[ "${PCOUNT:-0}" -gt 0 ]]; then
      notify_user "Antigravity TokenMeter" "等待旧进程退出超时，请先从系统托盘手动彻底退出 Antigravity 后重试。"
      exit 5
    fi
  else
    exit 5
  fi
fi

printf '%s\n' "[启动] 正在启动: $AG_BIN --remote-debugging-port=0"
nohup "$AG_BIN" --remote-debugging-port=0 >/dev/null 2>&1 &

printf '%s\n' "[校验] 正在等待本地 DevToolsActivePort 调试端口就绪（最多 15 秒）..."
READY_PORT=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  if READY_PORT="$(probe_devtools_port)"; then
    break
  fi
  sleep 0.5
done

if [[ -n "$READY_PORT" ]]; then
  printf '%s\n' "[成功] DevToolsActivePort 已就绪 (port=$READY_PORT)，TokenMeter 底部内嵌状态条将自动挂载！"
else
  printf '%s\n' "[提示] 已拉起 Antigravity，但 15 秒内尚未检测到可达的 DevToolsActivePort。"
  printf '%s\n' "       可稍后运行: bash scripts/install_mac_linux.sh --doctor 检查状态。"
fi
exit 0
LAUNCHER_LINUX_EOF
    chmod +x "$launcher_sh"

    mkdir -p "$LINUX_APPS_DIR"
    # 按 FreeDesktop Desktop Entry 规范转义 Exec 路径中的特殊字符与空格
    local escaped_exec=""
    escaped_exec="$(printf '%s' "$launcher_sh" | sed 's/\\/\\\\/g; s/"/\\"/g; s/\$/\\$/g; s/`/\\`/g')"
    cat > "$LINUX_APPS_DIR/antigravity-token-meter.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Antigravity (TokenMeter Inline)
Comment=Launch Antigravity with local loopback debug port for TokenMeter inline bar
Exec="$escaped_exec"
Icon=$DST_PLUGIN/assets/logo.svg
Terminal=false
Categories=Development;
EOF
    log_info "[成功] 已生成独立的 Linux 启动脚本: $launcher_sh"
    log_info "[成功] 已创建独立的 Linux 桌面入口: $LINUX_APPS_DIR/antigravity-token-meter.desktop（未修改原入口）"
  fi
}

# -------------------- 模式 1：纯诊断 (--doctor) --------------------
if [[ "$ACTION" == "doctor" ]]; then
  if [[ "$JSON_OUTPUT" != "true" ]]; then
    log_info "================================================================"
    log_info "   Antigravity TokenMeter 7 项内嵌与 Sidecar 健康诊断 (macOS/Linux)"
    log_info "================================================================"
    log_info ""
  fi
  detect_antigravity_gui
  run_json_helper doctor \
    "$TARGET_HOME" "$OS_NAME" "$CFG_DIR" "$DST_PLUGIN" "$CFG_JSON" "$SETTINGS_JSON" "$STATUS_JSON" "$JSON_OUTPUT" "$PROC_COUNT" "$PROC_HAS_DEBUG"
  exit $?
fi

# -------------------- 模式 2：安装 / 升级 / 自动修复 (--fix) --------------------
PLUGIN_VERSION="1.2.16"
if [[ -f "$SRC_PLUGIN/plugin.json" ]]; then
  PLUGIN_VERSION="$(run_json_helper version "$SRC_PLUGIN/plugin.json")"
elif [[ -f "$DST_PLUGIN/plugin.json" ]]; then
  PLUGIN_VERSION="$(run_json_helper version "$DST_PLUGIN/plugin.json")"
fi

NEED_DEPLOY="true"
if [[ "$ACTION" == "fix" ]]; then
  NEED_DEPLOY="false"
  for req in plugin.json LICENSE assets/logo.svg sidecars/meter/sidecar.json sidecars/meter/main.mjs; do
    if [[ ! -f "$DST_PLUGIN/$req" ]]; then
      NEED_DEPLOY="true"
      break
    fi
  done
fi

if [[ "$NEED_DEPLOY" == "true" ]]; then
  for req in plugin.json LICENSE assets/logo.svg sidecars/meter/sidecar.json sidecars/meter/main.mjs; do
    if [[ ! -f "$SRC_PLUGIN/$req" ]]; then
      log_err "[错误] 安装包不完整，缺少: $SRC_PLUGIN/$req"
      log_err "       请确认已完整解压压缩包，并在项目根目录运行本脚本。"
      exit 1
    fi
  done
fi

log_info "================================================================"
if [[ "$ACTION" == "fix" ]]; then
  log_info "  Antigravity TokenMeter v${PLUGIN_VERSION} 一键修复工具 (macOS/Linux)"
else
  log_info "  Antigravity TokenMeter v${PLUGIN_VERSION} 安装器 (macOS/Linux)"
fi
log_info "  官方 Sidecar 注册规范 + 零外部依赖（不修改 app.asar）"
log_info "================================================================"
log_info ""

# 1. 前置检查运行中进程（防 config.json 被旧内存覆盖）
log_info "[1/4] 正在检查 Antigravity 运行状态..."
ensure_antigravity_stopped
log_info "      已确认 Antigravity 主进程未运行。"

# 2. 预检 config.json 与既有设置
log_info "[2/4] 正在预检宿主 config.json 与本地偏好..."
mkdir -p "$DST_ROOT" "$BAK_DIR" "$(dirname -- "$CFG_JSON")"

INSPECT_OUT="$(run_json_helper inspect "$CFG_JSON" "$SETTINGS_JSON")"
IFS='|' read -r CFG_STATUS LEGACY_PULSE EXISTING_INLINE CFG_ERR_MSG <<EOF || true
$INSPECT_OUT
EOF

if [[ "$CFG_STATUS" == "corrupt" ]]; then
  if [[ "$REPAIR_CORRUPT_CONFIG" == "true" ]]; then
    log_info "      [警告] 检测到现有 config.json 异常（$CFG_ERR_MSG），将备份原件并优先从有效备份恢复或重建。"
  elif [[ "$IS_INTERACTIVE" == "true" ]]; then
    log_info "      [警告] 检测到现有 config.json 存在格式损坏（$CFG_ERR_MSG）。"
    ans=""
    read -r -p "是否自动备份原件至 config-backups 并恢复/重建合法 config.json？[推荐回车默认 y] (Y/n): " ans || true
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss]) REPAIR_CORRUPT_CONFIG="true" ;;
      *)
        log_err "[错误] 已取消修复，未改动任何文件。"
        exit 4
        ;;
    esac
  else
    log_err "[错误] 现有 config.json 损坏（$CFG_ERR_MSG），非交互模式下拒绝覆盖（可追加 --repair-corrupt-config 或 --fix 自动备份并恢复/重建）。"
    exit 4
  fi
fi

DISABLE_LEGACY_PULSE="false"
if [[ "$LEGACY_PULSE_ACTION" == "disable" ]]; then
  DISABLE_LEGACY_PULSE="true"
elif [[ "$LEGACY_PULSE" == "true" && "$LEGACY_PULSE_ACTION" == "ask" ]]; then
  if [[ "$IS_INTERACTIVE" == "true" ]]; then
    ans=""
    read -r -p "检测到旧版 antigravity-pulse 仍处于启用状态，是否同时停用以防底部条重影？[推荐回车默认 y] (Y/n): " ans || true
    case "$ans" in
      ""|[Yy]|[Yy][Ee][Ss]) DISABLE_LEGACY_PULSE="true" ;;
    esac
  else
    log_info "      [提示] 检测到旧版 antigravity-pulse 仍启用，可追加 --disable-legacy-pulse 停用以防底部条重影。"
  fi
fi

# 首次安装交互模式下清晰说明默认开启完整体验（允许回车直通或输入 n 切纯侧边栏）
if [[ "$INLINE_MODE" == "preserve" && "$IS_INTERACTIVE" == "true" && "$ACTION" == "install" ]]; then
  if [[ "$EXISTING_INLINE" == "unset" ]]; then
    log_info ""
    log_info "  [模式选择] TokenMeter 支持两种形态："
    log_info "    - 完整模式（默认推荐）：侧边栏面板 + 聊天框底部透明状态条（需通过专用启动器带 --remote-debugging-port=0 启动）；"
    log_info "    - 纯侧边栏模式：零额外启动参数，直接打开 Antigravity 即可在侧边栏使用。"
    ans=""
    read -r -p "是否启用完整模式（含底部内嵌状态条）？[直接回车默认开启] (Y/n): " ans || true
    case "$ans" in
      [Nn]|[Nn][Oo]) INLINE_MODE="false" ;;
      *) INLINE_MODE="true" ;;
    esac
  fi
fi

# 3. 原子部署插件本体（含失败自动回滚）
STAGE_DIR="$DST_ROOT/.antigravity-token-meter-stage-$$"
PREV_DIR="$DST_ROOT/.antigravity-token-meter-prev-$$"
HAD_PREV="false"
DEPLOYED="false"
rm -rf "$STAGE_DIR" "$PREV_DIR"

rollback() {
  rm -rf "$STAGE_DIR" 2>/dev/null || true
  rm -f "$CFG_DIR"/.tm-tmp-$$-*.tmp "$(dirname -- "$CFG_JSON")"/.tm-tmp-$$-*.tmp 2>/dev/null || true
  if [[ "$HAD_PREV" == "true" && -d "$PREV_DIR" ]]; then
    rm -rf "$DST_PLUGIN" 2>/dev/null || true
    mv "$PREV_DIR" "$DST_PLUGIN" 2>/dev/null || true
  elif [[ "$DEPLOYED" == "true" && "$HAD_PREV" == "false" ]]; then
    rm -rf "$DST_PLUGIN" 2>/dev/null || true
  fi
}
trap rollback ERR

if [[ "$NEED_DEPLOY" == "true" ]]; then
  log_info "[3/4] 正在部署 TokenMeter 插件文件（含 MIT LICENSE）..."
  mkdir -p "$STAGE_DIR"
  for item in assets sidecars plugin.json LICENSE; do
    cp -PR "$SRC_PLUGIN/$item" "$STAGE_DIR/"
  done
  if [[ -d "$DST_PLUGIN" ]]; then
    HAD_PREV="true"
    mv "$DST_PLUGIN" "$PREV_DIR"
  fi
  mv "$STAGE_DIR" "$DST_PLUGIN"
  DEPLOYED="true"
  log_info "      已部署至: $DST_PLUGIN"
else
  log_info "[3/4] 插件本体文件完整，跳过重新复制。"
fi

# 4. 原子合并宿主 config.json（完整官方 schema）与本地 settings.json / preferences.json
log_info "[4/4] 正在按官方规范写入宿主 config.json 与本地设置..."
MERGE_OUT="$(run_json_helper merge "$CFG_JSON" "$BAK_DIR" "$SETTINGS_JSON" "$INLINE_MODE" "$DISABLE_LEGACY_PULSE" "$REPAIR_CORRUPT_CONFIG")"
IFS='|' read -r FINAL_INLINE REPAIRED_CFG <<EOF || true
$MERGE_OUT
EOF

trap - ERR
rm -rf "$PREV_DIR"

run_json_helper init_prefs "$PREFS_JSON"

if [[ "$FINAL_INLINE" == "true" ]]; then
  generate_launchers
fi

# 若请求了 --restart 且未禁止拉起（且非沙箱测试模式），自动重启拉起客户端
if [[ "$AUTO_RESTART" == "true" && "$NO_LAUNCH" != "true" && -z "${AG_TEST_HOME:-}" ]]; then
  log_info ""
  log_info "[重启] 正在重新启动 Antigravity 以加载新版 TokenMeter..."
  if [[ "$FINAL_INLINE" == "true" ]]; then
    if [[ "$OS_NAME" == "Darwin" ]]; then
      bash "$CFG_DIR/launch-antigravity-token-meter.command" --restart || true
    else
      bash "$CFG_DIR/launch-antigravity-token-meter.sh" --restart || true
    fi
  else
    if [[ "$OS_NAME" == "Darwin" ]]; then
      open -a "Antigravity" >/dev/null 2>&1 || true
    elif command -v antigravity >/dev/null 2>&1; then
      nohup "$(command -v antigravity)" >/dev/null 2>&1 &
    fi
  fi
fi

# --fix + --json 直接输出最终诊断结果
if [[ "$ACTION" == "fix" && "$JSON_OUTPUT" == "true" ]]; then
  detect_antigravity_gui
  run_json_helper doctor \
    "$TARGET_HOME" "$OS_NAME" "$CFG_DIR" "$DST_PLUGIN" "$CFG_JSON" "$SETTINGS_JSON" "$STATUS_JSON" "true" "$PROC_COUNT" "$PROC_HAS_DEBUG"
  exit $?
fi

log_info ""
log_info "================================================================"
if [[ "$ACTION" == "fix" ]]; then
  log_info "  Antigravity TokenMeter v${PLUGIN_VERSION} 修复完成！"
else
  log_info "  Antigravity TokenMeter v${PLUGIN_VERSION} 安装完成！"
fi
log_info "================================================================"
log_info "  插件目录 : $DST_PLUGIN"
log_info "  宿主配置 : $CFG_JSON（已同步写入 plugins 与 sidecars 官方字段）"
if [[ "$FINAL_INLINE" == "true" ]]; then
  log_info "  运行模式 : 完整模式（侧边栏面板 + 实验性底部内嵌状态条）"
  log_info ""
  log_info "  【重要：为什么不会热启动 & 下一步操作】"
  log_info "  Antigravity 仅在彻底冷启动时重新加载外部写入的 config.json 并启用新 sidecar。"
  if [[ "$OS_NAME" == "Darwin" ]]; then
    log_info "  请双击或运行独立启动器以启用底部状态条："
    log_info "    \"$CFG_DIR/launch-antigravity-token-meter.command\""
  else
    log_info "  请从应用菜单点击 \"Antigravity (TokenMeter Inline)\" 或执行："
    log_info "    \"$CFG_DIR/launch-antigravity-token-meter.sh\""
  fi
else
  log_info "  运行模式 : 纯侧边栏面板模式（零额外启动参数）"
  log_info "  下一步   : 正常启动 Antigravity 即可在侧边栏使用 TokenMeter；如需后续开启底部条，运行 --enable-inline。"
fi
log_info ""
log_info "  随时可执行自检或一键修复："
log_info "    bash scripts/install_mac_linux.sh --doctor"
log_info "    bash scripts/install_mac_linux.sh --fix"
