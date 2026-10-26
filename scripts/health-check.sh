#!/bin/bash
# 在线巡检：掉线超过 10 分钟就重启容器（entrypoint 带 ACCOUNT，会先试快速登录）
set -u
WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
cd "$WHALE_HOME" || exit 1
set -a; . ./config.env 2>/dev/null; set +a

STATE=state/health.json
LOG=logs/health.log
mkdir -p state logs
now=$(date +%s)

ok=$(curl -s -m 8 -X POST "http://127.0.0.1:${NAPCAT_HTTP}/get_login_info" \
  -H "Authorization: Bearer ${ONEBOT_TOKEN}" -H 'Content-Type: application/json' -d '{}' 2>/dev/null \
  | grep -c '"user_id"')

prev_last_ok=0; prev_restart=0; prev_ok=0
if [ -f "$STATE" ]; then
  prev_last_ok=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastOk',0))" 2>/dev/null || echo 0)
  prev_restart=$(python3 -c "import json;print(json.load(open('$STATE')).get('lastRestart',0))" 2>/dev/null || echo 0)
  prev_ok=$(python3 -c "import json;print(json.load(open('$STATE')).get('ok',0))" 2>/dev/null || echo 0)
fi

if [ "$ok" -ge 1 ]; then
  python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
was_down = d.get('ok', 1) == 0
d.update({'ok': 1, 'lastOk': now})
json.dump(d, open(p, 'w', encoding='utf-8'))
PY
  [ "$prev_ok" = "0" ] && [ "$prev_last_ok" != "0" ] && echo "[$(date '+%F %T')] 恢复在线" >> "$LOG"
  exit 0
fi

down_min=$(( (now - prev_last_ok) / 60 ))
[ "$prev_last_ok" = "0" ] && down_min=9999

python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
if d.get('ok', 1) == 1:
    d.update({'ok': 0, 'downSince': now})
json.dump(d, open(p, 'w', encoding='utf-8'))
PY

[ "$prev_ok" = "1" ] && echo "[$(date '+%F %T')] 掉线了（等扫码/快速登录）" >> "$LOG"

if [ "$down_min" -ge 10 ] && [ $((now - prev_restart)) -ge 1800 ]; then
  echo "[$(date '+%F %T')] 掉线 ${down_min} 分钟，重启容器试一次快速登录" >> "$LOG"
  docker restart napcat >/dev/null 2>&1
  python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
d['lastRestart'] = now
json.dump(d, open(p, 'w', encoding='utf-8'))
PY
  bash "$WHALE_HOME/qr-sync.sh"
fi
