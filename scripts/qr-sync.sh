#!/bin/bash
# 把容器里最新的登录二维码同步到对外目录（只拷贝，绝不重启容器）
set -u
WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
DIR="$WHALE_HOME/qr"
mkdir -p "$DIR"
docker cp napcat:/app/napcat/cache/qrcode.png "$DIR/qrcode.png" >/dev/null 2>&1 || true
{
  echo "updated: $(date '+%F %T')"
  docker exec napcat sh -c 'stat -c %y /app/napcat/cache/qrcode.png 2>/dev/null' 2>/dev/null || true
} > "$DIR/status.txt"
