#!/usr/bin/env python3
"""bili.py — B 站公开接口封装（搜索 / 热门 / 视频详情 / 热评）

用法：
  python3 bili.py search "关键词" [页数]
  python3 bili.py hot [条数]
  python3 bili.py video BV1xx411c7mD
  python3 bili.py comments BV1xx411c7mD [条数]

说明：只用公开接口，不需要登录。部分接口需要 UA + Referer，已内置。
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA, "Referer": "https://www.bilibili.com/"}
COOKIES: dict[str, str] = {}


def bootstrap_cookies() -> None:
    """先访问一次首页拿 buvid3 之类的 cookie，否则搜索接口会直接甩 412。"""
    if COOKIES:
        return
    try:
        req = urllib.request.Request("https://www.bilibili.com/", headers=HEADERS)
        with urllib.request.urlopen(req, timeout=15) as resp:
            for raw in resp.headers.get_all("Set-Cookie") or []:
                pair = raw.split(";", 1)[0]
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    COOKIES[k.strip()] = v.strip()
    except Exception:
        pass


def api(url: str) -> dict:
    bootstrap_cookies()
    headers = dict(HEADERS)
    if COOKIES:
        headers["Cookie"] = "; ".join(f"{k}={v}" for k, v in COOKIES.items())
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fmt_duration(sec: int) -> str:
    return f"{sec // 60}:{sec % 60:02d}"


def cmd_search(kw: str, page: int = 1) -> None:
    q = urllib.parse.quote(kw)
    data = api(f"https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword={q}&page={page}")
    items = (data.get("data") or {}).get("result") or []
    if not items:
        print(f"没搜到「{kw}」的结果")
        return
    print(f"「{kw}」搜索结果（第 {page} 页，共 {len(items)} 条）：")
    for i, it in enumerate(items[:10], 1):
        title = it.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        print(f"{i}. {title}")
        print(f"   UP: {it.get('author')} | 播放: {it.get('play')} | 时长: {it.get('duration')} | {it.get('bvid')}")
        print(f"   https://www.bilibili.com/video/{it.get('bvid')}")


def cmd_hot(n: int = 10) -> None:
    data = api("https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1")
    items = (data.get("data") or {}).get("list") or []
    print(f"B 站热门（前 {min(n, len(items))} 条）：")
    for i, it in enumerate(items[:n], 1):
        print(f"{i}. {it.get('title')}")
        print(f"   UP: {it.get('owner', {}).get('name')} | 播放: {it.get('stat', {}).get('view')} | {it.get('bvid')}")
        print(f"   https://www.bilibili.com/video/{it.get('bvid')}")


def cmd_video(bvid: str) -> None:
    data = api(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    d = data.get("data") or {}
    if not d:
        print(f"拿不到 {bvid} 的信息：{data.get('message')}")
        return
    stat = d.get("stat", {})
    print(f"标题: {d.get('title')}")
    print(f"UP: {d.get('owner', {}).get('name')}  ({d.get('owner', {}).get('mid')})")
    print(f"发布: {d.get('pubdate')}  时长: {fmt_duration(d.get('duration', 0))}")
    print(f"播放 {stat.get('view')} / 弹幕 {stat.get('danmaku')} / 点赞 {stat.get('like')} / 投币 {stat.get('coin')} / 收藏 {stat.get('favorite')} / 转发 {stat.get('share')}")
    print(f"分P: {len(d.get('pages') or [])} 个")
    desc = (d.get("desc") or "").strip()
    if desc:
        print(f"简介: {desc[:300]}")
    print(f"链接: https://www.bilibili.com/video/{bvid}")


def cmd_comments(bvid: str, n: int = 5) -> None:
    data = api(f"https://api.bilibili.com/x/web-interface/view?bvid={bvid}")
    aid = (data.get("data") or {}).get("aid")
    if not aid:
        print(f"拿不到 {bvid} 的 aid")
        return
    c = api(f"https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2&ps=20&pn=1")
    replies = (c.get("data") or {}).get("replies") or []
    print(f"热门评论（前 {min(n, len(replies))} 条）：")
    for i, r in enumerate(replies[:n], 1):
        content = (r.get("content") or {}).get("message", "").replace("\n", " ")
        print(f"{i}. [{r.get('like')} 赞] {content[:160]}")


def main() -> int:
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    cmd, rest = args[0], args[1:]
    try:
        if cmd == "search":
            cmd_search(rest[0], int(rest[1]) if len(rest) > 1 else 1)
        elif cmd == "hot":
            cmd_hot(int(rest[0]) if rest else 10)
        elif cmd == "video":
            cmd_video(rest[0])
        elif cmd == "comments":
            cmd_comments(rest[0], int(rest[1]) if len(rest) > 1 else 5)
        else:
            print(__doc__)
            return 2
    except Exception as exc:  # noqa: BLE001
        print(f"出错了：{exc}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
