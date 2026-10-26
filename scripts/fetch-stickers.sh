#!/bin/bash
# 从 ChineseBQB 抓一批表情包（按分类，每类 N 张），建 index.json
# 想要别的图库，改 cats.txt 里的分类/标签就行；也可以把自己收集的图丢进目录再跑 build-index
set -u
WHALE_HOME="${WHALE_HOME:-/opt/whale-bot}"
ROOT="$WHALE_HOME/stickers"
PROXY=https://gh-proxy.com
RAW="$PROXY/https://raw.githubusercontent.com/zhaoolee/ChineseBQB/master"
API=https://api.github.com/repos/zhaoolee/ChineseBQB/contents
PER_CAT=${PER_CAT:-24}

mkdir -p "$ROOT"; cd "$ROOT" || exit 1

cat > cats.txt <<'EOF'
001Funny_滑稽大佬😏BQB|滑稽,嘲讽
002CuteGirl_可爱的女孩纸👧BQB|可爱,开心
004SmirkBoy_假笑男孩👦BQB|假笑,无语
006Hamster_仓鼠🐹BQB|仓鼠,萌
008HappyDuck_开心鸭🐥BQB|开心,好耶
009KumamotoBear_熊本熊🐻BQB|熊本熊,搞怪
010Cat_是喵星人啦🐱BQB|猫,喵
011Dog_狗🐶BQB|狗头,嘲讽
023Emoji_表情符号BQB|emoji,情绪
024Programmer_程序员BQB|程序员,加班
031Penguin_沙雕企鹅🐧BQB|沙雕,离谱
033Eat_吃🍔BQB|吃,干饭
035TomAndJerry_猫和老鼠BQB|坏笑,搞事
036Pikachu_皮卡丘BQB|皮卡丘,惊讶
020TATANBQB|哭,难过
EOF

python3 - "$API" "$RAW" "$PER_CAT" <<'PY'
import json, os, sys, urllib.request, urllib.parse
api, raw, per_cat = sys.argv[1], sys.argv[2], int(sys.argv[3])
index, total = {}, 0

def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'whale-bot'})
    with urllib.request.urlopen(req, timeout=40) as r:
        data = r.read()
    return data if binary else json.loads(data.decode())

with open('cats.txt', encoding='utf-8') as fh:
    cats = [l.strip().split('|') for l in fh if l.strip() and '|' in l]

for name, tags in cats:
    try:
        items = get(f"{api}/{urllib.parse.quote(name)}")
    except Exception as exc:
        print(f"skip {name}: {exc}"); continue
    files = [i for i in items if i.get('type') == 'file'
             and i['name'].lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))][:per_cat]
    safe = name.split('_')[0]
    os.makedirs(safe, exist_ok=True)
    got = []
    for item in files:
        dest = os.path.join(safe, item['name'])
        if os.path.exists(dest) and os.path.getsize(dest) > 1000:
            got.append(dest); continue
        try:
            blob = get(f"{raw}/{urllib.parse.quote(name)}/{urllib.parse.quote(item['name'])}", binary=True)
            if len(blob) < 800: continue
            open(dest, 'wb').write(blob); got.append(dest)
        except Exception:
            continue
    for tag in tags.split(','):
        index.setdefault(tag.strip(), []).extend(got)
    total += len(got)
    print(f"{name}: {len(got)} 张")

allf = sorted(os.path.join(d, f) for d, _, fs in os.walk('.') for f in fs
              if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif')))
allf = [os.path.relpath(p, '.') for p in allf]
for extra in ('大肥鱼', '随机'):
    index[extra] = allf

json.dump(index, open('index.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f"TOTAL {total} 张 / 标签 {len(index)} 个")
PY

du -sh "$ROOT"
