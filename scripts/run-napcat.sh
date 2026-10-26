#!/bin/bash
# ============================================================================
# 起（或重建）NapCat 容器。
#
# ⚠️ 挂载是这套东西最容易踩的坑，写在这里免得以后再踩：
#   这个镜像在 /app/.config/QQ 和 /app/napcat/config 上**声明了匿名卷**。
#   如果你只挂父目录（-v xxx:/app/napcat），匿名卷会把子目录整个盖住，
#   容器里看到的还是空目录 —— 结果就是"登录记录永远不落盘"，
#   每次重启都被当成新设备，只能扫码、无法用快速登录。
#   所以下面把父目录和这两个子路径**都**挂出来。
# ============================================================================
set -euo pipefail
WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
cd "$WHALE_HOME"

if [ -f config.env ]; then
  set -a; . ./config.env; set +a
else
  echo "缺少 $WHALE_HOME/config.env（先跑 install.sh）"; exit 1
fi

mkdir -p "$WHALE_HOME/napcat/config" "$WHALE_HOME/qq-config"

docker rm -f napcat >/dev/null 2>&1 || true
docker run -d --name napcat --restart unless-stopped \
  -e NAPCAT_GID=0 -e NAPCAT_UID=0 \
  -e ACCOUNT="$BOT_QQ" \
  -p "127.0.0.1:${NAPCAT_HTTP}:3000" \
  -p "127.0.0.1:${NAPCAT_WS}:3001" \
  -p "127.0.0.1:${NAPCAT_WEBUI}:6099" \
  -v "$WHALE_HOME/napcat:/app/napcat" \
  -v "$WHALE_HOME/napcat/config:/app/napcat/config" \
  -v "$WHALE_HOME/qq-config:/app/.config/QQ" \
  mlikiowa/napcat-docker:latest >/dev/null

echo "容器已启动，等 25 秒…"
sleep 25
docker logs --tail 30 napcat 2>&1 | grep -vE '^[0-9a-f]{64}$' | tail -12
echo
echo "挂载检查（应该能看到三条 bind）："
docker inspect napcat --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
