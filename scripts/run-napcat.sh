#!/bin/bash
# 起（或重建）NapCat 容器。端口从 $WHALE_HOME/config.env 读，不存在就自动挑空闲的。
set -euo pipefail
WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
cd "$WHALE_HOME"

if [ -f config.env ]; then
  set -a; . ./config.env; set +a
else
  echo "缺少 $WHALE_HOME/config.env（先跑 install.sh）"; exit 1
fi

docker rm -f napcat >/dev/null 2>&1 || true
docker run -d --name napcat --restart unless-stopped \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -e ACCOUNT="$BOT_QQ" \
  -p "127.0.0.1:${NAPCAT_HTTP}:3000" \
  -p "127.0.0.1:${NAPCAT_WS}:3001" \
  -p "127.0.0.1:${NAPCAT_WEBUI}:6099" \
  -v "$WHALE_HOME/napcat:/app/napcat/config" \
  mlikiowa/napcat-docker:latest >/dev/null

echo "容器已启动，等 25 秒…"
sleep 25
docker logs --tail 30 napcat 2>&1 | grep -vE '^[0-9a-f]{64}$' | tail -12
