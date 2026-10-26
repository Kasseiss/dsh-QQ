#!/bin/bash
# health-check.sh — 每 10 分钟看一眼鲸鲸在不在线
#   在线 → 记一笔时间
#   掉线 3 分钟 → 重启容器（快速登录已可用，重启通常 15 秒内自动登回）
#   10 分钟内最多重启一次；连续 3 次失败则判定需要人工扫码，放慢到 30 分钟一次
set -u
cd /root/wdc/qqbot || exit 1
set -a; . ./ports.env 2>/dev/null; set +a
TOKEN=ncbotsrv2026
STATE=state/health.json
LOG=logs/health.log
mkdir -p state logs
now=$(date +%s)

ok=$(curl -s -m 6 -X POST "http://127.0.0.1:${NAPCAT_HTTP:-39000}/get_login_info" \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' 2>/dev/null \
  | grep -c '"user_id"')

getv() { python3 -c "import json;print(json.load(open('$STATE')).get('$1',0))" 2>/dev/null || echo 0; }
prev_last_ok=$(getv lastOk); prev_restart=$(getv lastRestart); prev_ok=$(getv ok); prev_fail=$(getv failStreak)

if [ "$ok" -ge 1 ]; then
  python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
d.update({'ok': 1, 'lastOk': now, 'failStreak': 0})
json.dump(d, open(p, 'w', encoding='utf-8'))
PY
  if [ "$prev_ok" = "0" ] && [ "$prev_last_ok" != "0" ]; then
    echo "[$(date '+%F %T')] 恢复在线" >> "$LOG"
  fi
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

[ "$prev_ok" = "1" ] && echo "[$(date '+%F %T')] 掉线" >> "$LOG"

cooldown=600
if [ "$prev_fail" -ge 3 ]; then
  cooldown=1800
  [ "$prev_ok" = "1" ] && echo "[$(date '+%F %T')] 连续 $prev_fail 次自动登录失败，需要人工扫码" >> "$LOG"
fi

if [ "$down_min" -ge 3 ] && [ $((now - prev_restart)) -ge "$cooldown" ]; then
  echo "[$(date '+%F %T')] 掉线 ${down_min} 分钟 → 重启容器试快速登录" >> "$LOG"
  docker restart napcat >/dev/null 2>&1
  python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
d['lastRestart'] = now
d['failStreak'] = d.get('failStreak', 0) + 1
json.dump(d, open(p, 'w', encoding='utf-8'))
PY
  sleep 25
  ok2=$(curl -s -m 6 -X POST "http://127.0.0.1:${NAPCAT_HTTP:-39000}/get_login_info" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{}' 2>/dev/null | grep -c '"user_id"')
  if [ "$ok2" -ge 1 ]; then
    echo "[$(date '+%F %T')] 快速登录成功，已恢复" >> "$LOG"
    python3 - "$STATE" "$now" <<'PY'
import json, sys
p, now = sys.argv[1], int(sys.argv[2])
d = {}
try: d = json.load(open(p, encoding='utf-8'))
except Exception: pass
d.update({'ok': 1, 'lastOk': now, 'failStreak': 0})
json.dump(d, open(p, 'w', encoding='utf-8'))
PY
  else
    bash /root/wdc/qqbot/qr-sync.sh
  fi
fi
