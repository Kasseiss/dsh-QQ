#!/bin/bash
# sticker.sh — 看表情包标签 / 随机取一张
# 用法： sticker.sh list [关键词]     列出标签（可按关键词过滤）
#        sticker.sh <标签>           随机返回该标签下的一张图路径
set -u
DIR="${WHALE_HOME:-/opt/whale-bot}/stickers"
IDX=$DIR/index.json

if [ ! -f "$IDX" ]; then echo "表情包索引还没生成（$IDX 不存在）"; exit 1; fi

case "${1:-list}" in
  list|ls)
    python3 - "$IDX" "${2:-}" <<'PY'
import json, sys
idx = json.load(open(sys.argv[1], encoding='utf-8'))
kw = sys.argv[2] if len(sys.argv) > 2 else ''
tags = [t for t in idx if not kw or kw in t]
print('标签（共 %d 个）：' % len(tags))
for t in tags:
    print(f'  {t}  ({len(idx[t])} 张)')
PY
    ;;
  *)
    python3 - "$IDX" "$1" "$DIR" <<'PY'
import json, os, random, sys
idx = json.load(open(sys.argv[1], encoding='utf-8'))
tag, base = sys.argv[2], sys.argv[3]
keys = list(idx)
if not keys:
    print('索引是空的'); sys.exit(1)
norm = lambda s: s.strip().lower()
hit = ([k for k in keys if norm(k) == norm(tag)]
       or [k for k in keys if norm(tag) in norm(k) or norm(k) in norm(tag)])
key = hit[0] if hit else random.choice(keys)
files = idx[key]
if not files:
    print(f'「{key}」下没有图'); sys.exit(1)
pick = random.choice(files)
print(f'{key}\t{os.path.join(base, pick)}')
PY
    ;;
esac
