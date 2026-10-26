#!/bin/bash
# ============================================================================
# 鲸鲸（DeepSeek Harness QQ 分身）一键安装
#
#   sudo bash scripts/install.sh --qq 你的机器人QQ号 --owner 你的QQ号
#
# 会做这些事（全部在 $WHALE_HOME 里，默认 /opt/whale-bot）：
#   1. 装 Node 24（只用独立副本，不碰系统 node）
#   2. 装 DeepSeek Harness（0.2.0-rc.2）
#   3. 建目录、生成配置、装表情包工具、写 systemd 服务
#   4. 起 NapCat 容器（OneBot v11），并给出登录二维码地址
#
# 装完还需要你做两件事：
#   · 扫码登录（浏览器打开提示的地址）
#   · 扫完在手机上把这个号退出登录（一个号只能一方在线）
# ============================================================================
set -euo pipefail

WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QQ=""
OWNER=""
GUEST=""
DSH_VERSION="0.2.0-rc.2"

SKIP_NAPCAT=0
NO_SYSTEMD=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --qq) QQ="$2"; shift 2 ;;
    --owner) OWNER="$2"; shift 2 ;;
    --guest) GUEST="$2"; shift 2 ;;
    --home) WHALE_HOME="$2"; shift 2 ;;
    --skip-napcat) SKIP_NAPCAT=1; shift ;;     # 只装前半截（调试用）
    --no-systemd) NO_SYSTEMD=1; shift ;;       # 不写 systemd 单元（调试用）
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

[[ -z "$QQ" || -z "$OWNER" ]] && { echo "用法: bash scripts/install.sh --qq <机器人QQ> --owner <你的QQ> [--guest <客人QQ>] [--home <目录>]"; exit 1; }

say() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }
ok()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }

say "安装到 $WHALE_HOME（机器人 $QQ，主人 $OWNER）"

# ── 1. Node 24 ──────────────────────────────────────────────────────────────
NODE="$WHALE_HOME/node24/bin/node"
if [ -x "$NODE" ]; then
  ok "Node 已存在：$($NODE -v)"
else
  say "装 Node 24（独立目录，不动系统 node）"
  mkdir -p "$WHALE_HOME/node24"
  curl -s -m 30 https://nodejs.org/dist/index.json -o /tmp/node-index.json
  VER=$(python3 -c "
import json
for r in json.load(open('/tmp/node-index.json')):
    if r['version'].startswith('v24.') and r.get('lts'):
        print(r['version']); break
")
  echo "  选中 $VER"
  curl -sL -m 600 -o /tmp/node.tar.xz "https://nodejs.org/dist/$VER/node-$VER-linux-x64.tar.xz"
  tar -xJf /tmp/node.tar.xz -C "$WHALE_HOME/node24" --strip-components=1
  rm -f /tmp/node.tar.xz
  ok "$($NODE -v)"
fi

# 让后面的 npm / 子进程都用这份 node（系统自带的 node 20 跑不了 dsh）
export PATH="$WHALE_HOME/node24/bin:$PATH"

# ── 2. DSH ──────────────────────────────────────────────────────────────────
say "装 DeepSeek Harness $DSH_VERSION"
mkdir -p "$WHALE_HOME/dsh"
cd "$WHALE_HOME/dsh"
[ -f package.json ] || echo '{"name":"whale-dsh","private":true,"type":"module"}' > package.json
npm i "@deepseek-ai/dsh@$DSH_VERSION" --no-audit --no-fund --registry=https://registry.npmjs.org 2>&1 | tail -3
DSH_CLI="$WHALE_HOME/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
[ -f "$DSH_CLI" ] && ok "dsh 就位" || { echo "dsh 装失败"; exit 1; }

# 桥接自己的依赖装在自己目录下（Node 不会去 ../dsh/node_modules 找）
say "装桥接依赖"
mkdir -p "$WHALE_HOME/bridge"
cd "$WHALE_HOME/bridge"
[ -f package.json ] || echo '{"name":"whale-bridge","private":true,"type":"module","dependencies":{"ws":"^8.18.0"}}' > package.json
npm i --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org 2>&1 | tail -2
[ -d "$WHALE_HOME/bridge/node_modules/ws" ] && ok "ws 就位" || { echo "ws 装失败"; exit 1; }

# ── 3. 目录与文件 ────────────────────────────────────────────────────────────
say "铺目录"
mkdir -p "$WHALE_HOME"/{bridge,tools,stickers,qr,logs,state,games,napcat/config,qq-config,home/work,home/profiles/headless}
cp "$REPO_DIR/src/bridge.mjs" "$WHALE_HOME/bridge/bridge.mjs"
cp "$REPO_DIR/src/life.mjs" "$WHALE_HOME/life.mjs"
cp "$REPO_DIR/src/tools/"* "$WHALE_HOME/tools/"
chmod +x "$WHALE_HOME/tools/"*.sh 2>/dev/null || true
cp "$REPO_DIR/scripts/qr-sync.sh" "$REPO_DIR/scripts/health-check.sh" "$WHALE_HOME/"
chmod +x "$WHALE_HOME/qr-sync.sh" "$WHALE_HOME/health-check.sh"
ok "源码就位"

# ── 4. 配置 ─────────────────────────────────────────────────────────────────
say "生成配置"
if command -v openssl >/dev/null 2>&1; then
  TOKEN="whale$(openssl rand -hex 12)"
else
  TOKEN="whale$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' | cut -c1-24)"
fi
PORTS=$(python3 - <<'PY'
import socket
def free(p):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try: s.bind(('127.0.0.1', p)); return True
    except OSError: return False
    finally: s.close()
out, p = [], 39000
while len(out) < 3 and p < 39999:
    if free(p): out.append(p)
    p += 1
print(' '.join(map(str, out)))
PY
)
read -r P_HTTP P_WS P_WEBUI <<< "$PORTS"
cat > "$WHALE_HOME/config.env" <<EOF
WHALE_HOME=$WHALE_HOME
BOT_QQ=$QQ
OWNER_QQ=$OWNER
GUEST_QQ=${GUEST:-}
ONEBOT_TOKEN=$TOKEN
NAPCAT_HTTP=$P_HTTP
NAPCAT_WS=$P_WS
NAPCAT_WEBUI=$P_WEBUI
EOF
chmod 600 "$WHALE_HOME/config.env"

python3 - "$WHALE_HOME" "$QQ" "$OWNER" "$GUEST" "$TOKEN" "$P_HTTP" "$P_WS" <<'PY'
import json, os, sys
home, qq, owner, guest, token, http, ws = sys.argv[1:8]
cfg = {
  "_comment": "鲸鲸的桥接配置；改完 systemctl restart qq-bridge",
  "onebotHttp": f"http://127.0.0.1:{http}",
  "onebotWs": f"ws://127.0.0.1:{ws}",
  "token": token,
  "dshHome": os.path.join(home, "home"),
  "dshBin": os.path.join(home, "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"),
  "dshProfile": "headless",
  "workDir": os.path.join(home, "home/work"),
  "stickersDir": os.path.join(home, "stickers"),
  "stickerMaxPerReply": 1,
  "dangerFullAccess": True,
  "allowUsers": [int(owner)],
  "guestUsers": [int(guest)] if guest else [],
  "guestPermissionMode": "read-only",
  "allowGroups": [],
  "groupAtOnly": True,
  "friendRequestPolicy": "owner-approve",
  "pairing": True,
  "maxConcurrent": 2,
  "queueLimit": 20,
  "queueTimeoutMs": 120000,
  "runTimeoutMs": 600000,
  "progressAfterMs": 45000,
  "chunkSize": 900,
  "chunkGapMs": 900,
  "minGapPerChatMs": 1500,
  "globalPerMinute": 20,
  "humanize": {"enabled": True, "debounceMs": 4000, "minDelayMs": 1600, "perCharMs": 26,
               "maxDelayMs": 16000, "jitterMs": 900, "typing": True, "skipToken": "[[跳过]]"},
  "life": {"minGapMinutes": 3, "maxGapMinutes": 65, "quietHours": [1, 8],
           "dailyCap": 10, "userActiveWindowMin": 12},
}
json.dump(cfg, open(os.path.join(home, "bridge/config.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

ob = {
  "network": {
    "httpServers": [{"name": "whaleHttp", "enable": True, "port": 3000, "host": "0.0.0.0",
                     "enableCors": False, "messagePostFormat": "array", "token": token, "debug": False}],
    "httpSseServers": [], "httpClients": [],
    "websocketServers": [{"name": "whaleWs", "enable": True, "host": "0.0.0.0", "port": 3001,
                          "messagePostFormat": "array", "reportSelfMessage": False,
                          "token": token, "heartInterval": 30000}],
    "websocketClients": [], "plugins": [],
  },
  "musicSignUrl": "", "enableLocalFile2Url": False, "parseMultMsg": False, "imageDownloadProxy": "",
  "timeout": {"baseTimeout": 10000, "uploadSpeedKBps": 256, "downloadSpeedKBps": 256, "maxTimeout": 1800000},
}
json.dump(ob, open(os.path.join(home, f"napcat/onebot11_{qq}.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

prof = {"name": "dsh-profile-headless", "private": True, "dependencies": {},
        "dsh": {"profile": {"bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"]}}}
json.dump(prof, open(os.path.join(home, "home/profiles/headless/package.json"), "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

open(os.path.join(home, "home/profiles/headless/cordis.patch.yml"), "w", encoding="utf-8").write("""# 用 DeepSeek 账号登录态（不用 API key）
- id: agent-default-model
  config:
    provider: deepseek-account
    model: deepseek-flash

# 给 headless 补一个 HTTP 服务（端口随机），让依赖 webServer 的插件能挂上
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
""")
print("配置写好")
PY

# 提示词：把占位符换成真实信息
for f in AGENTS.md self.md; do
  sed -e "s#@WHALE_HOME@#$WHALE_HOME#g" -e "s#@OWNER_QQ@#$OWNER#g" -e "s#@GUEST_QQ@#${GUEST:-无}#g" \
      "$REPO_DIR/prompts/$f" > "$WHALE_HOME/home/work/$f.tmp"
done
mv "$WHALE_HOME/home/work/AGENTS.md.tmp" "$WHALE_HOME/home/AGENTS.md"
mv "$WHALE_HOME/home/work/self.md.tmp" "$WHALE_HOME/home/work/self.md"
ok "提示词就位"

# 服务读的环境文件（没有它 systemd 会直接起不来）
if [ ! -f "$WHALE_HOME/.env" ]; then
  cat > "$WHALE_HOME/.env" <<'EOF'
# 桥接/生活调度进程的环境变量，按需填。留空也能跑。
# 例：知乎 cli 的密钥
# ZHIHU_ACCESS_SECRET=xxxxxx
EOF
  chmod 600 "$WHALE_HOME/.env"
fi
ok "环境文件就位"

# ── 5. systemd ──────────────────────────────────────────────────────────────
if [ "$NO_SYSTEMD" -eq 0 ]; then
say "写 systemd 单元"

cat > /etc/systemd/system/qq-bridge.service <<EOF
[Unit]
Description=鲸鲸 QQ ↔ DSH 桥接
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$WHALE_HOME/bridge
Environment=WHALE_HOME=$WHALE_HOME
EnvironmentFile=-$WHALE_HOME/.env
ExecStart=$NODE $WHALE_HOME/bridge/bridge.mjs
Restart=always
RestartSec=5
StandardOutput=append:$WHALE_HOME/logs/bridge-stdout.log
StandardError=append:$WHALE_HOME/logs/bridge-stderr.log

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/qq-life.service <<EOF
[Unit]
Description=鲸鲸自己的生活调度
After=network-online.target qq-bridge.service
Wants=qq-bridge.service

[Service]
Type=oneshot
WorkingDirectory=$WHALE_HOME
Environment=WHALE_HOME=$WHALE_HOME
EnvironmentFile=-$WHALE_HOME/.env
EnvironmentFile=-$WHALE_HOME/config.env
ExecStart=$NODE $WHALE_HOME/life.mjs --tick
TimeoutStartSec=900
StandardOutput=append:$WHALE_HOME/logs/life-stdout.log
StandardError=append:$WHALE_HOME/logs/life-stderr.log
EOF

cat > /etc/systemd/system/qq-life.timer <<'EOF'
[Unit]
Description=每分钟叫醒一次鲸鲸的生活调度

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=10s
Unit=qq-life.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/qq-health.service <<EOF
[Unit]
Description=鲸鲸在线巡检

[Service]
Type=oneshot
Environment=WHALE_HOME=$WHALE_HOME
ExecStart=/bin/bash $WHALE_HOME/health-check.sh
EOF

cat > /etc/systemd/system/qq-health.timer <<'EOF'
[Unit]
Description=每 10 分钟检查一次鲸鲸是否在线

[Timer]
OnBootSec=3min
OnUnitActiveSec=10min
Unit=qq-health.service

[Install]
WantedBy=timers.target
EOF

cat > /etc/systemd/system/qq-qr.service <<EOF
[Unit]
Description=登录二维码静态服务
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$WHALE_HOME/qr
ExecStart=/usr/bin/python3 -m http.server 39090 --bind 0.0.0.0 --directory $WHALE_HOME/qr
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

cat > /etc/systemd/system/qq-qr-sync.service <<EOF
[Unit]
Description=同步 NapCat 登录二维码

[Service]
Type=oneshot
Environment=WHALE_HOME=$WHALE_HOME
ExecStart=/bin/bash $WHALE_HOME/qr-sync.sh
EOF

cat > /etc/systemd/system/qq-qr-sync.timer <<'EOF'
[Unit]
Description=每 20 秒同步一次登录二维码

[Timer]
OnBootSec=10
OnUnitActiveSec=20
AccuracySec=1s
Unit=qq-qr-sync.service

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
ok "单元写好"
else
say "跳过 systemd（--no-systemd）"
fi

# ── 6. NapCat ───────────────────────────────────────────────────────────────
if [ "$SKIP_NAPCAT" -eq 0 ]; then
say "起 NapCat 容器（首次要拉镜像，可能几分钟）"
bash "$REPO_DIR/scripts/run-napcat.sh"
[ "$NO_SYSTEMD" -eq 0 ] && systemctl enable --now qq-qr.service qq-qr-sync.timer qq-health.timer qq-life.timer >/dev/null 2>&1
[ "$NO_SYSTEMD" -eq 0 ] && systemctl enable qq-bridge.service >/dev/null 2>&1
ok "服务已启用"
else
say "跳过 NapCat 容器（--skip-napcat）"
fi

cat <<EOF

============================================================
装好了。接下来三步：

1) 登录 DeepSeek（生成凭证文件）
   在别的机器上装过 dsh 的话，把 ~/.dsh/.credentials.yaml 复制到
     $WHALE_HOME/home/.credentials.yaml
   没有的话，用桌面版 DSH 登录一次再复制过去即可。

2) 扫码登录 QQ
   浏览器打开：http://<本机IP>:39090/qrcode.png   （每 20 秒自动换新码）
   扫完 ★立刻在手机上把这个号退出登录★，否则两边会互相踢。

3) 启动
   systemctl start qq-bridge
   然后给机器人发条消息试试。

日志：$WHALE_HOME/logs/
状态：$NODE $WHALE_HOME/life.mjs --status
============================================================
EOF
