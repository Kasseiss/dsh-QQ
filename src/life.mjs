#!/usr/bin/env node
/**
 * life.mjs — 鲸鲸的"生活"总调度
 *
 * 每 1 分钟被 systemd 叫醒一次，但只在"该动了"的时候才真动：
 *   上次动完后，随机安排下一次（3–65 分钟后）。
 * 到了时间，把当前处境丢给模型，让它自己判断这次要干什么：
 *   静默 / 找他聊天 / 刷 B 站并分享 / 看知乎并分享 / 玩一把游戏 / 发个表情
 * 干了什么、发了什么都记下来。
 *
 * 用法：
 *   node24 life.mjs --tick     systemd 每分钟调（自己判断该不该动）
 *   node24 life.mjs --now      立刻动一次（忽略随机间隔）
 *   node24 life.mjs --status   看当前状态
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = process.env.WHALE_HOME
  || path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.BRIDGE_CONFIG || path.join(ROOT, 'bridge', 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const STATE = path.join(STATE_DIR, 'life.json');
const LAST_INBOUND = path.join(STATE_DIR, 'last-inbound.json');
const SESSIONS = path.join(ROOT, 'bridge', 'sessions.json');
const EMOTION = path.join(ROOT, 'dsh-home', 'storages', 'emotion.json');
const JOURNAL = path.join(ROOT, 'dsh-home', 'work', 'life-journal.md');
const LOG = path.join(ROOT, 'logs', 'life.log');

const args = process.argv.slice(2);
const MODE = args.includes('--now') ? 'now' : args.includes('--status') ? 'status' : 'tick';

const cfg = JSON.parse(await readFile(CFG_PATH, 'utf8'));
const target = (cfg.allowUsers || [])[0];
if (!target) { console.error('config 没有 allowUsers'); process.exit(1); }
await mkdir(STATE_DIR, { recursive: true });

const L = cfg.life || {};
const quiet = L.quietHours || [1, 8];         // 深夜绝对静音
const dailyCap = L.dailyCap ?? 10;            // 每天最多主动发几次
const userActiveWindow = L.userActiveWindowMin ?? 12;  // 主人刚说过话的窗口内不打扰

// 活跃时段：只在主人习惯聊天的几个时间段里勤快，其余时间几乎不打扰
const slots = (L.slots || ['12:00-13:00', '18:00-19:30', '21:00-23:00'])
  .map((s) => String(s).split('-').map((t) => t.trim()))
  .filter((p) => p.length === 2)
  .map(([a, b]) => ({ start: hhmm(a), end: hhmm(b) }));

const now = Date.now();
const d0 = new Date(now);
const hour = d0.getHours();
const minutesNow = hour * 60 + d0.getMinutes();
const today = d0.toISOString().slice(0, 10);

function hhmm(text) {
  const [h, m] = String(text).split(':').map((x) => Number(x));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

function inSlot() {
  return slots.find((s) => (s.start <= s.end
    ? minutesNow >= s.start && minutesNow < s.end
    : minutesNow >= s.start || minutesNow < s.end));
}

const slot = inSlot();
const gapMin = slot ? (L.slotMinGapMinutes ?? 6) : (L.idleMinGapMinutes ?? 50);
const gapMax = slot ? (L.slotMaxGapMinutes ?? 20) : (L.idleMaxGapMinutes ?? 110);

const state = await readJson(STATE, { date: today, sentToday: 0, lastSentAt: 0, lastInboundAt: 0, nextDue: 0, log: [] });
if (state.date !== today) { state.date = today; state.sentToday = 0; }

// 主人说"在忙"：在这之前一次都不打扰
const busy = await readJson(path.join(STATE_DIR, 'busy.json'), { until: 0, note: '' });
const busyLeft = busy.until && busy.until > now ? Math.round((busy.until - now) / 60000) : 0;

const inbound = await readInboundAt();
const minSinceUser = inbound ? (now - inbound) / 60000 : 1e9;

if (MODE === 'status') {
  console.log(JSON.stringify({
    now: d0.toLocaleString('zh-CN', { hour12: false }),
    nextDue: state.nextDue ? new Date(state.nextDue).toLocaleString('zh-CN', { hour12: false }) : '(未安排)',
    inMinutes: state.nextDue ? Math.round((state.nextDue - now) / 60000) : null,
    activeSlot: slot ? `${String(Math.floor(slot.start / 60)).padStart(2, '0')}:${String(slot.start % 60).padStart(2, '0')}-${String(Math.floor(slot.end / 60)).padStart(2, '0')}:${String(slot.end % 60).padStart(2, '0')}` : '(不在活跃时段)',
    gapRange: `${gapMin}-${gapMax} 分钟`,
    busyLeftMinutes: busyLeft || 0,
    sentToday: state.sentToday, dailyCap,
    minutesSinceUser: Math.round(minSinceUser),
    lastEntries: (state.log || []).slice(-5),
  }, null, 1));
  process.exit(0);
}

// 没到点就别动
if (MODE !== 'now' && state.nextDue && now < state.nextDue) process.exit(0);

// 硬性过滤：在忙 / 静音 / 主人刚在聊 / 今天说太多
const skipReasons = [];
if (busyLeft > 0) skipReasons.push(`主人说过在忙，还剩 ${busyLeft} 分钟${busy.note ? `（${busy.note}）` : ''}`);
if (hour >= quiet[0] && hour < quiet[1]) skipReasons.push('静音时段');
if (minSinceUser < userActiveWindow) skipReasons.push(`主人 ${Math.round(minSinceUser)} 分钟前才说过话`);
if (state.sentToday >= dailyCap) skipReasons.push(`今天已说 ${state.sentToday} 次，到顶`);

if (skipReasons.length) {
  await log(`[跳过] ${skipReasons.join('；')}${slot ? '' : '｜不在活跃时段'}`);
  await scheduleNext(state, now, L);
  process.exit(0);
}

// 到点了：让模型自己判断干什么
const emotion = await readEmotion();
const d = new Date(now);
const when = d.toLocaleString('zh-CN', { hour12: false });
const silence = minSinceUser > 24 * 60 ? '一天多' : Math.round(minSinceUser / 60) + ' 小时';
const selfDoc = (await readText(path.join(cfg.workDir, 'self.md'))).slice(0, 1500);
const recentJournal = (await readText(JOURNAL)).slice(-1200);

let prompt = [
  '[这是你自己的时间]',
  `现在是 ${when}。主人 ${silence} 没跟你说话了。你此刻的心情是「${emotion.label}」（效价 ${emotion.valence.toFixed(2)}）。`,
  '',
  selfDoc ? `这是你给自己写的（work/self.md）：\n${selfDoc}` : '',
  recentJournal ? `你最近做过/想过的事（work/life-journal.md 片段）：\n${recentJournal}` : '',
  '',
  '没有人给你派任务。这段时间是你的，你自己决定怎么过：',
  '- 可以接着上次的线索往下走（比如继续关注某件事、继续琢磨一个问题）',
  '- 可以开个新坑（刷 B 站、看知乎、玩两把、搜一个你突然好奇的东西）',
  '- 可以只是待着，什么都不干',
  '- 但如果你刚看了什么、想到什么，**倾向说出来**——别把有意思的东西憋着',
  '',
  '你有完整的工具：bash / read / write / web_search / web_fetch / subagent，',
  `以及 ${path.join(ROOT, 'src', 'tools')} 下的 bili.py、game.py、sticker.sh。`,
  '',
  '规则：',
  '1. 想做事就真的去做（调工具），别假装看了什么。',
  '2. 真没什么可说的才输出 [[跳过]]；不要为了省事沉默。',
  '3. 决定说 → 一两句，像发消息，不要报告体；说话时可以带一个表情包标记（[[表情:标签]]）。',
  '4. 你可以更新 work/self.md（你的自我设定）和 work/life-journal.md（经历），那是你自己的本子。',
  '5. 最后一行可以写 [[下次:数字]]（3-65）自己定下次想被叫醒的时间，不写就随机。',
].filter(Boolean).join('\n');

// 连着沉默太多次，这次必须说点什么
const silenceStreak = state.silenceStreak || 0;
if (silenceStreak >= 1) {
  prompt += `\n\n（你上一次选择了沉默。这次别再沉默——说点你今天看到的、想到的，或者问问主人在干嘛。）`;
}

const sessionId = await readSession();
let result = await runAgent(prompt, sessionId);
if (result.sessionId && result.sessionId !== sessionId) await writeSession(result.sessionId);

let text = (result.text || '').replace(/\[\[\s*(?:跳过|skip|不回)\s*\]\]/gi, '').trim();

// 它给自己安排的下次唤醒时间
let selfChosenGap = 0;
const gapMatch = text.match(/\[\[\s*下次\s*[:：]\s*(\d{1,2})\s*\]\]/);
if (gapMatch) {
  selfChosenGap = Math.max(3, Math.min(65, Number(gapMatch[1])));
  text = text.replace(gapMatch[0], '').trim();
}

// 懒了（没调工具又说不出话）就再推一次
if (!text && (result.toolCalls || 0) === 0 && MODE === 'now') {
  await log('[重试] 没动也没说，逼它跑一趟');
  result = await runAgent('你刚才既没做事也没说话。现在必须真的跑一次工具（bili.py 或 zhihu-cli 或 game.py），然后挑一条说给主人听。', result.sessionId || sessionId);
  if (result.sessionId) await writeSession(result.sessionId);
  text = (result.text || '').replace(/\[\[\s*(?:跳过|skip|不回)\s*\]\]/gi, '').trim();
}

if (!text) {
  state.silenceStreak = (state.silenceStreak || 0) + 1;
  await log(`[静默] 这次它选择不说话（工具调用 ${result.toolCalls || 0} 次，连续 ${state.silenceStreak} 次）${selfChosenGap ? `，自己定了下次 ${selfChosenGap} 分钟后` : ''}`);
  await scheduleNext(state, now, L, selfChosenGap);
  process.exit(0);
}

await sendPrivate(target, text);
state.sentToday += 1;
state.silenceStreak = 0;
state.lastSentAt = now;
state.log = [...(state.log || []).slice(-60), { at: new Date(now).toISOString(), text: text.slice(0, 160), tools: result.toolCalls || 0 }];
await mkdir(path.dirname(JOURNAL), { recursive: true });
await appendFile(JOURNAL, `\n## ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}\n${text}\n`);
await scheduleNext(state, now, L, selfChosenGap);
await log(`[发送] ${text.slice(0, 100)}${selfChosenGap ? `（下次 ${selfChosenGap} 分钟后）` : ''}`);

// ─────────────────────────────────────────────────────────
async function scheduleNext(state, now, L, chosen = 0) {
  let gap;
  if (chosen > 0) {
    gap = chosen;                        // 她自己定的
  } else if (busyLeft > 0) {
    gap = busyLeft + 2;                  // 主人在忙，等他解除后的两分钟
  } else if (slot) {
    gap = (L.slotMinGapMinutes ?? 6) + Math.random() * ((L.slotMaxGapMinutes ?? 20) - (L.slotMinGapMinutes ?? 6));
  } else {
    gap = (L.idleMinGapMinutes ?? 50) + Math.random() * ((L.idleMaxGapMinutes ?? 110) - (L.idleMinGapMinutes ?? 50));
  }
  state.nextDue = now + Math.round(Math.max(1, gap)) * 60000;
  await writeFile(STATE, JSON.stringify(state, null, 1));
}

async function readText(file) {
  try { return await readFile(file, 'utf8'); } catch { return ''; }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

/** 主人上次说话的时间：优先新路径，兼容桥接早期写在 bridge/state 下的旧文件 */
async function readInboundAt() {
  const candidates = [LAST_INBOUND, path.join(ROOT, 'bridge', 'state', 'last-inbound.json')];
  let newest = 0;
  for (const p of candidates) {
    const at = (await readJson(p, { at: 0 })).at || 0;
    if (at > newest) newest = at;
  }
  return newest;
}

async function readEmotion() {
  try {
    const d = JSON.parse(await readFile(EMOTION, 'utf8'));
    const cur = d.tables?.state?.current || {};
    return { label: cur.label || '平静', valence: Number(cur.valence ?? 0) };
  } catch { return { label: '平静', valence: 0 }; }
}

async function readSession() {
  try {
    const all = JSON.parse(await readFile(SESSIONS, 'utf8'));
    return all[`private:${target}`]?.sessionId;
  } catch { return undefined; }
}

async function writeSession(id) {
  let all = {};
  try { all = JSON.parse(await readFile(SESSIONS, 'utf8')); } catch { /* 空 */ }
  all[`private:${target}`] = { sessionId: id, updatedAt: new Date().toISOString(), nick: '主人' };
  await writeFile(SESSIONS, JSON.stringify(all, null, 2));
}

function runAgent(promptText, sessionId) {
  const argv = [cfg.dshBin, '--profile', cfg.dshProfile, '--json'];
  if (sessionId) argv.push('--session-id', sessionId);
  argv.push('-');

  const child = spawn(process.execPath, argv, {
    cwd: cfg.workDir,
    env: {
      ...process.env,
      DSH_HOME: cfg.dshHome,
      DSH_PERMISSION_MODE: cfg.dangerFullAccess ? 'danger-full-access' : 'workspace-write',
      DSH_SESSION_ID: '', DSH_SHELL: '', DSH_WEB_URL: '', DSH_PROFILE: '', DSH_PROFILE_DIR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  let final = '';
  let newId;
  let toolCalls = 0;
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 600000);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'session') newId = evt.sessionId;
      if (evt.type === 'tool_call') toolCalls += 1;
      if (evt.type === 'final') final = evt.text || '';
    }
  });
  child.stderr.on('data', () => {});
  child.stdin.end(promptText, 'utf8');
  return new Promise((resolve) => {
    child.on('close', () => { clearTimeout(timer); resolve({ text: final, sessionId: newId, toolCalls }); });
  });
}

async function sendPrivate(userId, text) {
  const url = cfg.onebotHttp.replace(/\/+$/, '') + '/send_private_msg';
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ user_id: userId, message: [{ type: 'text', data: { text } }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  await mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await writeFile(LOG, msg, { flag: 'a' }).catch(() => {});
  process.stdout.write(msg);
}
