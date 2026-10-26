# 从零安装

以 **Ubuntu 22.04 + root** 为准，其它发行版把 `apt` 换成对应的包管理器。

预计耗时：30–60 分钟（其中拉 Docker 镜像和装 npm 依赖占大半）。

---

## 0. 前置检查

```bash
# 系统
cat /etc/os-release | head -2
nproc; free -h | head -2; df -h / | tail -1

# 必需
docker --version        # 没有就：curl -fsSL https://get.docker.com | sh
git --version
curl --version | head -1
python3 -V              # 3.8+

# 网络（三处都要通）
curl -s -o /dev/null -w 'npm %{http_code}\n'      https://registry.npmjs.org
curl -s -o /dev/null -w 'nodejs %{http_code}\n'   https://nodejs.org/dist/index.json
curl -s -o /dev/null -w 'qq %{http_code}\n'       https://txz.qq.com
```

> GitHub 直连不通没关系：装脚本走 `gh-proxy.com` 镜像；Docker 镜像和 npm 走官方源。

---

## 1. 一键安装

```bash
git clone https://github.com/Kasseiss/dsh-QQ.git
cd dsh-QQ
sudo bash scripts/install.sh --qq 机器人QQ号 --owner 你的QQ号 [--guest 客人QQ号]
```

脚本会依次做：

1. 在 `/opt/whale-bot/node24` 装一份**独立 Node 24**（系统 node 20 跑不了 dsh，会 `import.meta.main` 报错）
2. 在 `/opt/whale-bot/dsh` 装 DeepSeek Harness `0.2.0-rc.2`
3. 铺目录、生成 `bridge/config.json`、`napcat/onebot11_<QQ>.json`、headless profile
4. 写 systemd 单元（桥接 / 生活调度 / 健康巡检 / 二维码服务）
5. 拉 `mlikiowa/napcat-docker` 并启动容器

---

## 2. 放 DeepSeek 凭证

`dsh` 用**账号登录态**（不用 API key）。凭证是一份 YAML：

```bash
# 在你自己的电脑上（装过桌面版 DSH 的机器）
scp ~/.dsh/.credentials.yaml root@<服务器>:/opt/whale-bot/home/.credentials.yaml
chmod 600 /opt/whale-bot/home/.credentials.yaml
```

> 没有桌面版？先在一台有图形界面的机器上装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 桌面版并登录一次，就有这个文件了。
> 想用 API key 的话，把 `home/profiles/headless/cordis.patch.yml` 里的 provider 改回 `deepseek-official`，并写入 `DEEPSEEK_API_KEY`。

自检：

```bash
cd /opt/whale-bot/home/work
echo "只回复两个字：收到" | WHALE_HOME=/opt/whale-bot \
  /opt/whale-bot/node24/bin/node /opt/whale-bot/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless - 2>&1 | tail -3
```

看到「收到」就通了。

---

## 3. 扫码登录 QQ

```bash
# 打开这个地址（每 20 秒自动换新码，永远是最新的）
http://<服务器IP>:39090/qrcode.png
```

手机 QQ 用**机器人那个号**扫。

⚠️ **扫完以后，立刻在手机上把这个号退出登录。**
同一个 QQ 号只能一方在线：手机不退，服务器会被周期性踢下线（几小时一次），表现为"她突然不理你了"。

登录成功的判断：

```bash
curl -s -X POST http://127.0.0.1:$(grep NAPCAT_HTTP /opt/whale-bot/config.env | cut -d= -f2)/get_login_info \
  -H "Authorization: Bearer $(grep ONEBOT_TOKEN /opt/whale-bot/config.env | cut -d= -f2)" \
  -H 'Content-Type: application/json' -d '{}'
# 期望：{"status":"ok","data":{"user_id":机器人QQ,"nickname":"..."}}
```

---

## 3.5 为什么扫这一次就够了（快速登录）

腾讯会周期性把协议端的会话作废（日志里是 `[KickedOffLine] 你的账号当前登录已失效`）。
如果**登录记录能落盘**，重启容器后 NapCat 会走「快速登录」，十几秒自动登回，不用再扫码：

```
[info] 正在快速登录  123456789
（约 15 秒后）登录成功
```

**但这套镜像挂载有个坑**，踩了就会永远扫不完：

> 镜像在 `/app/.config/QQ` 和 `/app/napcat/config` 上**声明了匿名卷**。
> 只挂父目录（`-v xxx:/app/napcat`）时，匿名卷会把子目录整个盖住，
> 容器里看到的还是空目录 → 登录记录永远不落盘 → 每次重启都是"新设备" → 只能扫码。

`scripts/run-napcat.sh` 里已经按下面的方式挂好了（父目录 + 两个子路径都挂）：

```bash
-v "$WHALE_HOME/napcat:/app/napcat" \
-v "$WHALE_HOME/napcat/config:/app/napcat/config" \
-v "$WHALE_HOME/qq-config:/app/.config/QQ" \
```

验证是否生效：

```bash
docker exec napcat ls /app/.config/QQ          # 应该能看到 nt_qq_xxxxxxxx 目录
docker inspect napcat --format '{{range .Mounts}}{{.Type}} {{.Source}} -> {{.Destination}}{{println}}{{end}}'
```

看到 `nt_qq_*` 就说明登录态已经在宿主机上了。之后腾讯踢你，`qq-health` 会在 3 分钟内重启容器自动登回。

---

## 4. 启动

```bash
systemctl start qq-bridge
systemctl status qq-bridge --no-pager | head -5
```

然后用你的号给机器人发一句「在吗」，正常几秒内会回。

想立刻看她"自己过日子"的样子：

```bash
/opt/whale-bot/node24/bin/node /opt/whale-bot/life.mjs --now
/opt/whale-bot/node24/bin/node /opt/whale-bot/life.mjs --status
```

---

## 5. 表情包（可选）

```bash
bash /opt/whale-bot/scripts/fetch-stickers.sh      # 从 ChineseBQB 抓一批
```

抓完会生成 `stickers/index.json`，桥接按标签挑图。想加自己的图：把图片丢进 `stickers/`，重建索引即可。

---

## 6. 日常运维

| 想干什么 | 命令 |
|---|---|
| 看桥接日志 | `tail -f /opt/whale-bot/logs/bridge-stdout.log` |
| 看她自己的经历 | `cat /opt/whale-bot/home/work/life-journal.md` |
| 看今天状态 | `/opt/whale-bot/node24/bin/node /opt/whale-bot/life.mjs --status` |
| 看在线巡检 | `cat /opt/whale-bot/logs/health.log` |
| 重启整条链路 | `docker restart napcat && systemctl restart qq-bridge` |
| 换机器人号 | 改 `config.env` 的 `BOT_QQ`，重跑 `scripts/run-napcat.sh`，再扫码 |

定时器一览：`systemctl list-timers 'qq-*'`

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| `bridge` 一直 `ECONNRESET` | 没登录。看 `docker logs --tail 50 napcat`，通常是在等扫码 |
| 登录报 `serverErrorCode 168` | 腾讯风控。用官方客户端正常登几小时，别连续扫 |
| `dsh` 启动报 `import.meta.main` | 用错 node 了，必须用 `/opt/whale-bot/node24/bin/node` |
| `MISSING_CREDENTIAL` | 凭证没放对位置，或 profile 里 provider 不是 `deepseek-account` |
| 她回得特别慢 | 正常：拟人延迟按字数算，最长 16 秒；`logs/bridge-stdout.log` 里能看到 `等 x.xs 再发` |
| 她一直不说话 | `life.mjs --status` 看 `nextDue` 和 `minutesSinceUser`；`userActiveWindowMin` 内不会主动打扰 |

---

## 卸载

```bash
systemctl disable --now qq-bridge qq-life.timer qq-health.timer qq-qr.service qq-qr-sync.timer
docker rm -f napcat
rm -rf /opt/whale-bot
rm -f /etc/systemd/system/qq-*.service /etc/systemd/system/qq-*.timer
systemctl daemon-reload
```
