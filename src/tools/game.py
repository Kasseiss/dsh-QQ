#!/usr/bin/env python3
"""game.py — 文字游戏裁判（猜数字 / 五子棋 / 成语接龙 / 掷骰子）

用法：
  python3 game.py guess start [--chat ID]
  python3 game.py guess 42 [--chat ID]
  python3 game.py gomoku start [--chat ID]
  python3 game.py gomoku 7,7 [--chat ID]
  python3 game.py idiom start [--chat ID]
  python3 game.py idiom 一心一意 [--chat ID]
  python3 game.py dice 3d6
  python3 game.py show [--chat ID]

状态存在 $WHALE_HOME/games/<游戏>-<chat>.json
"""
from __future__ import annotations

import json
import os
import random
import sys

STATE_DIR = os.environ.get("GAME_DIR", os.path.join(os.environ.get("WHALE_HOME", "/opt/whale-bot"), "games"))
IDIOMS = [
    "一心一意", "意气风发", "发扬光大", "大器晚成", "成千上万", "万无一失", "失之交臂",
    "臂力过人", "人山人海", "海阔天空", "空穴来风", "风和日丽", "丽句清词", "词不达意",
    "意想不到", "到此为止", "止于至善", "善始善终", "终身大事", "事半功倍", "倍道兼行",
    "行云流水", "水到渠成", "成人之美", "美不胜收", "收回成命", "命中注定", "定国安邦",
    "邦家之光", "光明磊落", "落花流水", "水滴石穿", "穿针引线", "线断风筝", "争先恐后",
    "后来居上", "上善若水", "水落石出", "出人头地", "地久天长", "长治久安", "安居乐业",
    "业精于勤", "勤能补拙", "拙嘴笨舌", "舌战群儒", "儒雅风流", "流连忘返", "返老还童",
    "童叟无欺", "欺上瞒下", "下不为例", "例行公事", "事半功倍", "倍加珍惜", "惜字如金",
    "金玉良言", "言而有信", "信口开河", "河清海晏", "晏然自若", "若无其事", "事在人为",
    "为所欲为", "为民除害", "害群之马", "马到成功", "功成名就", "就地取材", "材大难用",
]


def parse_args(argv: list[str]) -> tuple[list[str], str]:
    chat = "default"
    rest = []
    i = 0
    while i < len(argv):
        if argv[i] == "--chat" and i + 1 < len(argv):
            chat = argv[i + 1]
            i += 2
            continue
        rest.append(argv[i])
        i += 1
    return rest, chat


def state_path(game: str, chat: str) -> str:
    os.makedirs(STATE_DIR, exist_ok=True)
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in chat)
    return os.path.join(STATE_DIR, f"{game}-{safe}.json")


def load(game: str, chat: str) -> dict | None:
    p = state_path(game, chat)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)


def save(game: str, chat: str, data: dict) -> None:
    with open(state_path(game, chat), "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False)


# ── 猜数字 ───────────────────────────────────────────────────────────────────
def guess(args: list[str], chat: str) -> str:
    if not args:
        return "用法：game.py guess start｜game.py guess 42"
    action = args[0].lower()
    st = load("guess", chat)

    if action == "start":
        target = random.randint(1, 100)
        save("guess", chat, {"target": target, "low": 1, "high": 100, "tries": 0})
        return "猜数字开始：1-100，我挑好了一个数。直接说你猜多少（还剩 8 次机会心里有点数）。"

    if not st:
        return "还没开始，先说 `game.py guess start`"

    try:
        n = int(float(action))
    except ValueError:
        return "得说一个数字"

    st["tries"] += 1
    t = st["target"]
    if n == t:
        save("guess", chat, st)
        msg = f"中了！就是 {t}，你用了 {st['tries']} 次。要再来一局就说 start。"
        os.remove(state_path("guess", chat))
        return msg
    if st["tries"] >= 8:
        os.remove(state_path("guess", chat))
        return f"8 次用完啦，答案是 {t}。不服再来一局：start。"
    if n < t:
        st["low"] = max(st["low"], n + 1)
        hint = "小了"
    else:
        st["high"] = min(st["high"], n - 1)
        hint = "大了"
    save("guess", chat, st)
    return f"{hint}，范围缩到 {st['low']}-{st['high']}（第 {st['tries']} 次）"


# ── 五子棋 ───────────────────────────────────────────────────────────────────
SIZE = 15
EMPTY, PLAYER, BOT = ".", "X", "O"


def new_board() -> list[list[str]]:
    return [[EMPTY for _ in range(SIZE)] for _ in range(SIZE)]


def render(board: list[list[str]]) -> str:
    head = "   " + " ".join(f"{i:2d}" for i in range(1, SIZE + 1))
    rows = [head]
    for r in range(SIZE):
        row = f"{r + 1:2d} " + "  ".join(board[r])
        rows.append(row)
    return "\n".join(rows)


def lines_through(board, r, c):
    """遍历经过 (r,c) 的四个方向，返回每条线上以该点为中心的串"""
    out = []
    for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
        cells = []
        for k in range(-4, 5):
            nr, nc = r + dr * k, c + dc * k
            if 0 <= nr < SIZE and 0 <= nc < SIZE:
                cells.append(board[nr][nc])
            else:
                cells.append("#")
        out.append(cells)
    return out


def wins(board, r, c, who) -> bool:
    for line in lines_through(board, r, c):
        centre = len(line) // 2
        if line[centre] != who:
            continue
        run = 1
        i = centre - 1
        while i >= 0 and line[i] == who:
            run += 1
            i -= 1
        i = centre + 1
        while i < len(line) and line[i] == who:
            run += 1
            i += 1
        if run >= 5:
            return True
    return False


def score_point(board, r, c, who) -> int:
    if board[r][c] != EMPTY:
        return -1
    total = 0
    for line in lines_through(board, r, c):
        centre = len(line) // 2
        line = line[:centre] + [who] + line[centre + 1:]
        run = 1
        i = centre - 1
        while i >= 0 and line[i] == who:
            run += 1
            i -= 1
        i = centre + 1
        while i < len(line) and line[i] == who:
            run += 1
            i += 1
        if run >= 5:
            total += 100000
        else:
            total += {4: 10000, 3: 1000, 2: 100, 1: 10}[run]
    return total


def bot_move(board) -> tuple[int, int]:
    best, best_score = None, -1
    candidates = [(r, c) for r in range(SIZE) for c in range(SIZE) if board[r][c] != EMPTY]
    if not candidates:
        return (7, 7)
    zones = set()
    for r, c in candidates:
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                nr, nc = r + dr, c + dc
                if 0 <= nr < SIZE and 0 <= nc < SIZE and board[nr][nc] == EMPTY:
                    zones.add((nr, nc))
    for r, c in zones or {(7, 7)}:
        attack = score_point(board, r, c, BOT)
        defend = score_point(board, r, c, PLAYER)
        score = attack * 1.1 + defend
        if score > best_score:
            best, best_score = (r, c), score
    return best or (7, 7)


def gomoku(args: list[str], chat: str) -> str:
    if not args:
        return "用法：game.py gomoku start｜game.py gomoku 7,7"
    action = args[0].lower()

    if action == "start":
        board = new_board()
        board[7][7] = BOT
        save("gomoku", chat, {"board": board, "turn": PLAYER})
        return "五子棋开局，你执 X 先走，我先占天元 (8,8)。下法：`gomoku 7,7`（行,列，从 1 开始）\n" + render(board)

    st = load("gomoku", chat)
    if not st:
        return "还没开局，先说 `game.py gomoku start`"
    board = st["board"]
    try:
        r, c = [int(x) - 1 for x in action.replace("，", ",").split(",")]
    except Exception:  # noqa: BLE001
        return "坐标格式：`gomoku 7,7`"
    if not (0 <= r < SIZE and 0 <= c < SIZE):
        return "超出棋盘了"
    if board[r][c] != EMPTY:
        return "那儿有子了"

    board[r][c] = PLAYER
    if wins(board, r, c, PLAYER):
        os.remove(state_path("gomoku", chat))
        return "你赢了！五连了。\n" + render(board)

    br, bc = bot_move(board)
    board[br][bc] = BOT
    if wins(board, br, bc, BOT):
        os.remove(state_path("gomoku", chat))
        return f"我下 {br + 1},{bc + 1}，五连，我赢了。\n" + render(board)

    save("gomoku", chat, {"board": board, "turn": PLAYER})
    return f"我下 {br + 1},{bc + 1}，轮到你。\n" + render(board)


# ── 成语接龙 ─────────────────────────────────────────────────────────────────
def idiom(args: list[str], chat: str) -> str:
    if not args:
        return "用法：game.py idiom start｜game.py idiom 一心一意"
    action = args[0]
    st = load("idiom", chat)

    if action.lower() == "start":
        first = random.choice(IDIOMS)
        save("idiom", chat, {"last": first, "used": [first], "count": 0})
        return f"成语接龙开始，我先来：**{first}**\n你接一个以「{first[-1]}」开头的四字成语。"

    if not st:
        return "还没开始，先说 `game.py idiom start`"
    word = action.strip()
    if len(word) < 2:
        return "得说个成语"
    if word[0] != st["last"][-1]:
        return f"接不上：我说的是「{st['last']}」，你得用「{st['last'][-1]}」开头"
    if word in st["used"]:
        return "这个已经用过了，换一个"
    if word not in IDIOMS:
        return f"「{word}」不在我的词库里，我认不了（换个常见的）"

    used = st["used"] + [word]
    nxt = [w for w in IDIOMS if w[0] == word[-1] and w not in used]
    if not nxt:
        os.remove(state_path("idiom", chat))
        return f"「{word}」接得漂亮，我这儿词库断了，你赢。"
    pick = random.choice(nxt)
    save("idiom", chat, {"last": pick, "used": used + [pick], "count": st["count"] + 1})
    return f"我接：{pick}\n轮到你了，用「{pick[-1]}」开头。"


# ── 骰子 ─────────────────────────────────────────────────────────────────────
def dice(args: list[str]) -> str:
    spec = args[0] if args else "1d6"
    try:
        n, m = spec.lower().split("d")
        n, m = int(n or 1), int(m)
        if not (1 <= n <= 20 and 2 <= m <= 1000):
            raise ValueError
    except Exception:  # noqa: BLE001
        return "格式：`dice 3d6`"
    rolls = [random.randint(1, m) for _ in range(n)]
    return f"{spec}: {rolls} = {sum(rolls)}"


def main() -> int:
    argv, chat = parse_args(sys.argv[1:])
    if not argv:
        print(__doc__)
        return 2
    cmd = argv[0].lower()
    rest = argv[1:]
    if cmd == "dice":
        print(dice(rest))
        return 0
    table = {"guess": guess, "gomoku": gomoku, "idiom": idiom}
    if cmd == "show":
        for game in table:
            st = load(game, chat)
            if st:
                print(f"[{game}] {json.dumps(st, ensure_ascii=False)[:300]}")
        return 0
    if cmd not in table:
        print(__doc__)
        return 2
    print(table[cmd](rest, chat))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
