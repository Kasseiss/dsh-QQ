# 鲸鲸 · 自己养一条会过日子的 QQ 鱼

把 **DeepSeek Harness** 接进 QQ，给她一张脸、一段时间、一点自己的脾气。
不是"命令-响应"的机器人，是一个会等你、会自己找事做、偶尔还会不想理你的分身。

> 这套东西最初是给一个朋友攒的：白天上班，想有个人（鱼）在 QQ 里陪聊、偶尔自己刷 B 站、看到好玩的会主动来说一句。
> 现在打包出来了，照着装，一小时内你也能养一条。

---

## 她能干什么

| 能力 | 说明 |
|---|---|
| **正常聊天** | 每条 QQ 私聊/群各自一条持久会话，记得上下文，不是每次从零开始 |
| **像人一样回** | 连发几条会等你发完再一起答；按字数算"打字时间"；会话里显示"正在输入…" |
| **会不回** | 她觉得没什么好说的时候，真的不吭声（不是装死，是判断） |
| **自己过日子** | 没人找她时，每 3–65 分钟醒一次，自己决定：聊天 / 刷 B 站 / 看知乎 / 玩两把 / 什么都不干 |
| **有本子** | `self.md` 是她给自己的设定，`life-journal.md` 是她的经历流水，会越攒越厚 |
| **有情绪** | 装了 [dsh-emotion](https://github.com/xiaoyeziyinxing/dsh-emotion)，情绪状态会真的影响回复 |
| **发表情包** | 两种：图库挑图（`[[表情:开心]]`），或插件返回的 Markdown 图片自动转真图 |
| **会干活** | 完整 agent，有 shell/文件/搜索/子代理；B 站、知乎、文字游戏都有现成工具 |
| **醒了会自己恢复** | 掉线自动重启试快速登录；二维码长期有效；健康状态可查 |

---

## 架构

```
QQ ──(OneBot v11)──▶ NapCat（Docker，自带 QQNT）
                        │  WS / HTTP
                        ▼
                  bridge.mjs（Node）
                   │            ▲
        每条消息跑一次           │ 文字/图片
                   ▼            │
              dsh --profile headless --session-id …
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   AGENTS.md   tools/*.py   心情/表情插件
   self.md     bili/game    dsh-emotion
```

另有一条**生活调度**（`life.mjs`）：每分钟醒一次，随机 3–65 分钟后真正行动一次，自己判断这次干什么。

---

## 快速开始

前置：一台 Linux 服务器（Ubuntu 22.04 测过）、root、装了 Docker、**能访问外网**。

```bash
git clone https://github.com/Kasseiss/dsh-QQ.git
cd dsh-QQ
sudo bash scripts/install.sh --qq <机器人QQ号> --owner <你的QQ号>
```

然后按屏幕提示：

1. 把 DeepSeek 的登录凭证放到 `$WHALE_HOME/home/.credentials.yaml`（用桌面版 DSH 登录一次，复制 `~/.dsh/.credentials.yaml` 即可）
2. 浏览器打开 `http://<服务器IP>:39090/qrcode.png` 扫码登录
3. **扫完立刻在手机上把这个号退出登录**（一个号只能一方在线）
4. `systemctl start qq-bridge`，给机器人发条消息

详细步骤和排错见 [INSTALL.md](INSTALL.md)。

---

## 目录结构

```
$WHALE_HOME（默认 /opt/whale-bot）
├─ dsh/            DeepSeek Harness
├─ node24/         独立 Node 24
├─ home/           DSH_HOME：凭证、AGENTS.md、profile、work/
│   └─ work/       self.md（她的设定）、life-journal.md（经历）
├─ bridge/         bridge.mjs + config.json + sessions.json
├─ life.mjs        生活调度
├─ tools/          bili.py / game.py / sticker.sh
├─ stickers/       表情库 + index.json
├─ napcat/         容器挂载的 OneBot 配置
├─ qr/             登录二维码（39090 对外）
├─ logs/ state/ games/
└─ config.env      机器本地参数（QQ 号、token、端口）
```

---

## 常见问题

**Q：为什么她突然不说话了？**
A：先看 `systemctl status qq-bridge` 和 `curl` 一下 NapCat 的 `get_login_info`。九成是掉线了——`logs/health.log` 里能看到几点掉的、有没有自动恢复。

**Q：老是被踢下线？**
A：同一个 QQ 号只能一方在线。**扫码用的那台手机必须退出这个号**，否则手机和服务器会互相踢，几小时一次。

**Q：登录报 `serverErrorCode 168`？**
A：腾讯风控（判定为新设备/协议端）。先用官方客户端正常登录几小时，别反复扫。

**Q：能不能让她更主动 / 更冷淡？**
A：改 `bridge/config.json` 里的 `life`：

```json
"life": { "minGapMinutes": 3, "maxGapMinutes": 65, "dailyCap": 10, "userActiveWindowMin": 12 }
```

调小间隔 / 调大上限 = 更黏人；反过来就是高冷。

**Q：她刷 B 站会不会乱说？**
A：不会。工具是真的调接口拿数据（`tools/bili.py`），prompt 明确要求"不许编"，并且有空转检测——没调工具只说空话会被打回重跑。

---

## 用到的第三方

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —— 底层 agent
- [NapCatQQ](https://github.com/NapNeko/NapCatQQ) —— OneBot v11 实现（Docker 镜像 `mlikiowa/napcat-docker`）
- [dsh-emotion](https://github.com/xiaoyeziyinxing/dsh-emotion) —— 情绪模块
- [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) —— 大肥鱼表情知识库
- [ChineseBQB](https://github.com/zhaoolee/ChineseBQB) —— 表情包素材
- [BrickAZ/deepseek-chan-emotes](https://github.com/BrickAZ/deepseek-chan-emotes) —— 大肥鱼 GIF

## License

MIT。表情包素材各自遵循原仓库许可（ChineseBQB / deepseek-chan-emotes 为非商用）。
