#!/usr/bin/env node
/**
 * social.mjs — 让她主动去找"别人"说话（不是主人）
 *
 * 跟 life.mjs 的分工：
 *   life    对自己过日子 / 找主人
 *   social  跟客人（guestUsers）维持往来
 *
 * 每 30 分钟被叫醒一次，到点了才真动：
 *   · 从 guestUsers 里挑一个"最近没聊过"的人
 *   · 从桥接日志里捞一点你们最近的对话当上下文
 *   · 让模型决定说什么（可以 [[跳过]]）
 *
 * 用法：node social.mjs --tick | --now | --status
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = process.env.WHALE_HOME || path.dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.BRIDGE_CONFIG || path.join(ROOT, 'bridge', 'config.json');
const STATE_DIR = path.join(ROOT, 'state');
const STATE = path.join(STATE_DIR, 'social.json');
const SESSIONS = path.join(ROOT, 'bridge', 'sessions.json');
const BRIDGE_LOG = path.join(ROOT, 'logs', 'bridge-stdout.log');
const JOURNAL = path.join(ROOT, 'dsh-home', 'work', 'life-journal.md');
const LOG = path.join(ROOT, 'logs', 'social.log');

const MODE = process.argv.includes('--now') ? 'now'
  : process.argv.includes('--status') ? 'status' : 'tick';

const cfg = JSON.parse(await readFile(CFG_PATH, 'utf8'));
const S = cfg.social || {};
const enabled = S.enabled !== false;
const minGap = S.minGapMinutes ?? 180;
const maxGap = S.maxGapMinutes ?? 420;
const dailyCap = S.dailyCap ?? 3;
const perUserCooldownH = S.perUserCooldownHours ?? 20;

await mkdir(STATE_DIR, { recursive: true });
const now = Date.now();
const today = new Date().toISOString().slice(0, 10);
const state = await readJson(STATE, { date: today, count: 0, due: 0, perUser: {} });
if (state.date !== today) { state.date = today; state.count = 0; }

const guests = (cfg.guestUsers || []).map(String).filter((u) => !(cfg.allowUsers || []).map(String).includes(u));

if (MODE === 'status') {
  const rows = guests.map((u) => {
    const at = state.perUser?.[u] || 0;
    const h = at ? ((now - at) / 3600000).toFixed(1) + ' 小时前' : '从未';
    const ok = !at || now - at > perUserCooldownH * 3600000;
    return `${u}: 上次 ${h}${ok ? ' ✅可聊' : ' ⏳冷却中'}`;
  });
  console.log(JSON.stringify({
    now: new Date(now).toLocaleString('zh-CN', { hour12: false }),
    enabled, guests, 今天已聊: `${state.count}/${dailyCap}`,
    nextDue: state.due ? new Date(state.due).toLocaleString('zh-CN', { hour12: false }) : '(未安排)',
    冷却: `${perUserCooldownH} 小时`, 目标: rows,
  }, null, 1));
  process.exit(0);
}

if (!enabled || !guests.length) process.exit(0);
if (MODE !== 'now' && state.due && now < state.due) process.exit(0);
if (state.count >= dailyCap) { await scheduleNext(state, now); process.exit(0); }

// 挑人：冷却到期的人里，优先最久没聊的
const ready = guests
  .filter((u) => !state.perUser?.[u] || now - state.perUser[u] > perUserCooldownH * 3600000)
  .sort((a, b) => (state.perUser?.[a] || 0) - (state.perUser?.[b] || 0));
if (!ready.length) {
  await log('[跳过] 所有人都在冷却期');
  await scheduleNext(state, now);
  process.exit(0);
}
const pick = ready[0];

const recent = await recentLines(pick, 12);
const sessionId = await readSession(pick);
const prompt = [
  '[主动找人聊天]',
  `你要主动去找 QQ ${pick} 说句话。这是你们最近的聊天片段（可能为空）：`,
  recent || '(你们还没怎么聊过)',
  '',
  '要求：',
  '- 一两句，像朋友发消息，别问「在吗」这种话',
  '- 可以接着上次的话题、分享你今天看到的事、或者简单问一句近况',
  '- 不要提你是机器人、不要解释规则、不要汇报状态',
  '- 真没什么可说的才输出 [[跳过]]',
].join('\n');

let result = await runAgent(prompt, sessionId, pick);
if (result.sessionId && result.sessionId !== sessionId) await writeSession(pick, result.sessionId);

let text = (result.text || '').replace(/\[\[\s*(?:跳过|skip|不回)\s*\]\]/gi, '').trim();
if (!text) {
  await log(`[静默] 想了想还是不找 ${pick} 了`);
  state.perUser = { ...(state.perUser || {}), [pick]: now - (perUserCooldownH - 2) * 3600000 };
  await scheduleNext(state, now);
  process.exit(0);
}

// 抠出 [[表情:标签]]，别让标记原文发出去
const STICKER_RE = /\[\[\s*(?:表情|sticker)\s*[:：]\s*([^\]]+)\]\]/gi;
const tags = [...text.matchAll(STICKER_RE)].map((m) => m[1].trim()).slice(0, 1);
text = text.replace(STICKER_RE, '').trim();

if (text) await sendPrivate(pick, text);
for (const tag of tags) {
  try { await sendSticker(pick, tag); } catch (e) { await log(`[表情失败] ${tag}: ${e.message}`); }
}
state.count += 1;
state.perUser = { ...(state.perUser || {}), [pick]: now };
state.log = [...(state.log || []).slice(-40), { at: new Date(now).toISOString(), to: pick, text: text.slice(0, 120) }];
await appendFile(JOURNAL, `\n## ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')}｜找 ${pick}\n${text}\n`);
await scheduleNext(state, now);
await log(`[发送] 给 ${pick}: ${text.slice(0, 80)}`);

// ─────────────────────────────────────────────────────────
async function recentLines(uin, n) {
  try {
    const raw = await readFile(BRIDGE_LOG, 'utf8');
    const lines = raw.split('\n').filter((l) => l.includes(uin) && l.includes('私聊'));
    return lines.slice(-n).map((l) => l.replace(/^\[[^\]]+\]\s*/, '').slice(0, 140)).join('\n');
  } catch { return ''; }
}

async function scheduleNext(state, now) {
  const gap = minGap + Math.random() * (maxGap - minGap);
  state.due = now + Math.round(gap) * 60000;
  await writeFile(STATE, JSON.stringify(state, null, 1));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function readSession(uin) {
  try {
    const all = JSON.parse(await readFile(SESSIONS, 'utf8'));
    return all[`social:${uin}`]?.sessionId;
  } catch { return undefined; }
}

async function writeSession(uin, id) {
  const all = await readJson(SESSIONS, {});
  all[`social:${uin}`] = { sessionId: id, updatedAt: new Date().toISOString(), nick: '(社交线)' };
  await writeFile(SESSIONS, JSON.stringify(all, null, 2));
}

function runAgent(promptText, sessionId, uin) {
  const argv = [cfg.dshBin, '--profile', cfg.dshProfile, '--json'];
  if (sessionId) argv.push('--session-id', sessionId);
  argv.push('-');
  const child = spawn(process.execPath, argv, {
    cwd: cfg.workDir,
    env: {
      ...process.env,
      DSH_HOME: cfg.dshHome,
      DSH_PERMISSION_MODE: cfg.guestPermissionMode || 'read-only',
      DSH_SESSION_ID: '', DSH_SHELL: '', DSH_WEB_URL: '', DSH_PROFILE: '', DSH_PROFILE_DIR: '',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '', final = '', newId, toolCalls = 0;
  const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 300000);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      let evt; try { evt = JSON.parse(line); } catch { continue; }
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
    method: 'POST', headers,
    body: JSON.stringify({ user_id: Number(userId), message: [{ type: 'text', data: { text } }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

async function sendSticker(userId, tag) {
  const indexFile = cfg.stickerIndex || (cfg.stickersDir ? path.join(cfg.stickersDir, 'index.json') : '');
  const index = JSON.parse(await readFile(indexFile, 'utf8'));
  const keys = Object.keys(index);
  const norm = (s) => String(s).trim().toLowerCase();
  let key = keys.find((k) => norm(k) === norm(tag))
    || keys.find((k) => norm(k).includes(norm(tag)) || norm(tag).includes(norm(k)));
  if (!key) key = keys[Math.floor(Math.random() * keys.length)];
  const list = index[key] || [];
  if (!list.length) throw new Error('该标签下没有图');
  const rel = list[Math.floor(Math.random() * list.length)];
  const file = path.isAbsolute(rel) ? rel : path.join(cfg.stickersDir, rel);
  const buf = await readFile(file);
  const url = cfg.onebotHttp.replace(/\/+$/, '') + '/send_private_msg';
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, {
    method: 'POST', headers,
    body: JSON.stringify({
      user_id: Number(userId),
      message: [{ type: 'image', data: { file: `base64://${buf.toString('base64')}`, summary: `[${key}]`, sub_type: 0 } }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return key;
}

async function log(line) {
  const msg = `[${new Date().toISOString()}] ${line}\n`;
  await mkdir(path.dirname(LOG), { recursive: true }).catch(() => {});
  await writeFile(LOG, msg, { flag: 'a' }).catch(() => {});
  process.stdout.write(msg);
}
