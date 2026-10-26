#!/usr/bin/env node
/**
 * QQ ↔ DeepSeek Harness bridge (OneBot v11 / NapCat).
 *
 * 收：正向 WebSocket 连 NapCat，收 post_type=message 事件
 * 发：HTTP POST 调 NapCat 的 OneBot v11 HTTP 服务
 * 跑：每条消息 spawn 一次 `dsh --profile headless --json`，用 --session-id 续聊
 *
 * 设计要点（对应调研报告 qq-agent-bridge-report.md 第 5 节）：
 *  - 每会话串行 + 全局并发上限 + 队列上限，满则回"忙"，不堆 Promise
 *  - 三层超时：排队超时 / dsh 超时（taskkill 整棵树）/ HTTP 超时
 *  - 去重：message_id LRU + 3 秒同内容指纹
 *  - 分片：按段落/换行/句号切，不切断 ``` 代码块
 *  - 任何失败都回人话
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// ── 配置 ─────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  onebotWs: 'ws://127.0.0.1:3001',
  onebotHttp: 'http://127.0.0.1:3000',
  token: '',                       // NapCat 的 token（HTTP 与 WS 共用；留空表示不鉴权）
  dshHome: path.join(ROOT, '..', '.dsh-qq'),
  dshBin: path.join(ROOT, 'cli', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  dshProfile: 'headless',
  workDir: path.join(ROOT, 'work'),
  allowUsers: [],                  // 允许私聊的 QQ 号；空 = 配对模式（回执告诉对方自己的号）
  allowGroups: [],                 // 允许的群号；空 = 不在任何群响应
  groupAtOnly: true,               // 群里必须 @ 机器人才响应
  maxConcurrent: 2,
  queueLimit: 20,
  queueTimeoutMs: 120000,          // 排队超过这么久就回"忙"
  runTimeoutMs: 600000,            // 单次 dsh 运行超时（10 分钟）
  progressAfterMs: 45000,          // 超过这么久还没结果，先回一句"还在弄"
  chunkSize: 900,
  chunkGapMs: 900,
  minGapPerChatMs: 1500,           // 同一会话两条消息最短间隔
  globalPerMinute: 20,             // 全局发送速率上限
  dedupeTtlMs: 5000,
  pairing: true,                   // 非白名单私聊是否回执 QQ 号（方便配对）
  friendRequestPolicy: 'accept',   // 好友请求策略：accept（全过）| whitelist（只过白名单）| ignore（不理）
  dangerFullAccess: true,          // 子进程 DSH_PERMISSION_MODE（bot 要能跑 adb 等命令）
  // ── 拟人化 ──────────────────────────────────────────────
  humanize: {
    enabled: true,
    debounceMs: 4000,      // 同一会话的连发消息先攒一会儿，合成一条再答
    minDelayMs: 1600,      // 最快也要"想"这么久
    perCharMs: 26,         // 每多一个字多发一点时间
    maxDelayMs: 16000,     // 上限，别让人等太久
    jitterMs: 900,         // 随机抖动，避免每次都一样
    typing: true,          // 显示"正在输入"
    skipToken: '[[跳过]]',  // 模型输出这个标记就不回
  },
  systemTag: 'QQ',
  stickersDir: '',                 // 表情包目录（含 index.json）
  stickerIndex: '',                // 可单独指定索引文件
  stickerMaxPerReply: 2,           // 一条回复最多发几张表情
};

async function loadConfig() {
  const file = process.env.BRIDGE_CONFIG || path.join(HERE, 'config.json');
  let raw = {};
  if (existsSync(file)) raw = JSON.parse(await readFile(file, 'utf8'));
  const cfg = { ...DEFAULTS, ...raw };
  cfg.sessionsFile = path.join(HERE, 'sessions.json');
  cfg.logFile = path.join(HERE, 'logs', 'bridge.log');
  return cfg;
}

// ── 日志 ─────────────────────────────────────────────────────────────────────
let cfg;
const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
async function log(...parts) {
  const line = `[${stamp()}] ${parts.join(' ')}`;
  console.log(line);
  try { await appendFile(cfg.logFile, line + '\n'); } catch { /* 日志失败不影响主流程 */ }
}

/** 记一下"主人上次说话的时间"，给 life / mood-talk 判断该不该主动搭话用 */
async function touchInbound() {
  try {
    const dir = path.join(HERE, '..', 'state');   // 和 life.mjs 共用同一个 state 目录
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'last-inbound.json'), JSON.stringify({ at: Date.now() }));
  } catch { /* 失败无所谓 */ }
}

// ── 会话存储 ─────────────────────────────────────────────────────────────────
let sessions = {};      // chatKey -> { sessionId, updatedAt }
let sessionsDirty = false;
async function loadSessions() {
  try { sessions = JSON.parse(await readFile(cfg.sessionsFile, 'utf8')); } catch { sessions = {}; }
}
async function persistSessions() {
  if (!sessionsDirty) return;
  sessionsDirty = false;
  const tmp = cfg.sessionsFile + '.tmp';
  await writeFile(tmp, JSON.stringify(sessions, null, 2));
  await rename(tmp, cfg.sessionsFile).catch(async () => {
    await writeFile(cfg.sessionsFile, JSON.stringify(sessions, null, 2));
  });
}

// ── 发送限速 ─────────────────────────────────────────────────────────────────
const sentTimes = [];                     // 全局滑动窗口
const lastSentPerChat = new Map();        // chatKey -> ts
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForSendSlot(chatKey) {
  for (;;) {
    const now = Date.now();
    while (sentTimes.length && now - sentTimes[0] > 60000) sentTimes.shift();
    const last = lastSentPerChat.get(chatKey) ?? 0;
    const waitChat = cfg.minGapPerChatMs - (now - last);
    const waitGlobal = sentTimes.length >= cfg.globalPerMinute
      ? 60000 - (now - sentTimes[0])
      : 0;
    if (waitChat <= 0 && waitGlobal <= 0) {
      sentTimes.push(now);
      lastSentPerChat.set(chatKey, now);
      return;
    }
    await sleep(Math.max(50, Math.min(Math.max(waitChat, waitGlobal), 5000)));
  }
}

async function api(action, params, { timeoutMs = 20000 } = {}) {
  // OneBot v11 HTTP：POST <base>/<action>，params 直接放 body 顶层（NapCat 就是这个规范）
  const url = cfg.onebotHttp.replace(/\/+$/, '') + '/' + action;
  const headers = { 'content-type': 'application/json' };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params ?? {}),
      signal: ac.signal,
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`); }
    if (json.status === 'failed' || (json.retcode !== 0 && json.retcode !== undefined)) {
      throw new Error(`${action} 失败 retcode=${json.retcode} ${json.wording || json.message || ''}`.trim());
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

function targetParams(chat) {
  return chat.type === 'group' ? { group_id: chat.id } : { user_id: chat.id };
}
const sendAction = (chat) => (chat.type === 'group' ? 'send_group_msg' : 'send_private_msg');

/** 发一条消息（自动限速；失败重试一次） */
async function sendMessage(chat, text) {
  const params = { ...targetParams(chat), message: [{ type: 'text', data: { text } }] };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await waitForSendSlot(chat.key);
    try {
      return await api(sendAction(chat), params);
    } catch (error) {
      if (attempt === 1) throw error;
      await sleep(1200);
    }
  }
}

// ── 文本分片 ─────────────────────────────────────────────────────────────────
function splitChunks(text, limit) {
  const out = [];
  let rest = text.replace(/\r\n/g, '\n').trim();
  while (rest.length > limit) {
    // 优先在段落、换行、句末切；并保证不落在 ``` 代码块中间
    let cut = -1;
    for (const sep of ['\n\n', '\n', '。', '！', '？', '. ', '; ', '；', '，', ', ', ' ']) {
      const idx = rest.lastIndexOf(sep, limit);
      if (idx > limit * 0.35) { cut = idx + sep.length; break; }
    }
    if (cut <= 0) cut = limit;
    const head = rest.slice(0, cut);
    if (((head.match(/```/g) || []).length) % 2 === 1) {
      // 断在代码块里：补一个闭合围栏，下一片再补一个开围栏
      out.push(head + '\n```');
      rest = '```\n' + rest.slice(cut);
    } else {
      out.push(head);
      rest = rest.slice(cut);
    }
    rest = rest.replace(/^\s+/, '');
  }
  if (rest) out.push(rest);
  return out;
}

async function sendLong(chat, text) {
  const chunks = splitChunks(text || '(空)', cfg.chunkSize);
  for (let i = 0; i < chunks.length; i += 1) {
    await sendMessage(chat, chunks[i]);
    if (i < chunks.length - 1) await sleep(cfg.chunkGapMs);
  }
}

// ── 表情包 ───────────────────────────────────────────────────────────────────
const STICKER_RE = /\[\[\s*(?:表情|sticker|emoji)\s*[:：]\s*([^\]\n]{1,20})\s*\]\]/gi;
let stickerIndex = null;

function extractStickers(text) {
  const tags = [];
  const stripped = text.replace(STICKER_RE, (_m, tag) => { tags.push(tag.trim()); return ''; });
  return { text: stripped.replace(/[ \t]+\n/g, '\n').trim(), tags: tags.slice(0, cfg.stickerMaxPerReply || 2) };
}

async function loadStickerIndex() {
  if (stickerIndex) return stickerIndex;
  const file = cfg.stickerIndex || (cfg.stickersDir ? path.join(cfg.stickersDir, 'index.json') : '');
  stickerIndex = {};
  if (file) {
    try { stickerIndex = JSON.parse(await readFile(file, 'utf8')); } catch { stickerIndex = {}; }
  }
  return stickerIndex;
}

async function pickSticker(tag) {
  const index = await loadStickerIndex();
  const keys = Object.keys(index);
  if (!keys.length) throw new Error('没有表情包索引');
  const norm = (s) => String(s).trim().toLowerCase();
  let key = keys.find((k) => norm(k) === norm(tag))
    || keys.find((k) => norm(k).includes(norm(tag)) || norm(tag).includes(norm(k)));
  if (!key) key = keys[Math.floor(Math.random() * keys.length)];
  const list = index[key] || [];
  if (!list.length) throw new Error(`标签「${key}」下没有图`);
  const rel = list[Math.floor(Math.random() * list.length)];
  const abs = path.isAbsolute(rel) ? rel : path.join(cfg.stickersDir, rel);
  return { tag: key, file: abs };
}

async function sendSticker(chat, tag) {
  const { tag: realTag, file } = await pickSticker(tag);
  await sendImageFile(chat, file, `[表情:${realTag}]`);
  return `${realTag} (${path.basename(file)})`;
}

/** 直接把一个本地图片文件当表情发出去 */
async function sendImageFile(chat, file, summary = '[图片]') {
  const buf = await readFile(file);
  if (buf.length > 8 * 1024 * 1024) throw new Error(`图片太大（${(buf.length / 1048576).toFixed(1)}MB）`);
  await waitForSendSlot(chat.key);
  await api(sendAction(chat), {
    ...targetParams(chat),
    message: [{
      type: 'image',
      data: { file: `base64://${buf.toString('base64')}`, summary, sub_type: 0 },
    }],
  });
}

/**
 * 从模型回复里抠出 Markdown 图片 ![名字](路径或URL)。
 * 插件的 sticker_send / meme_render 都返回这种格式，这里统一转成真图片发出去。
 */
function extractMarkdownImages(text) {
  const images = [];
  const stripped = String(text).replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt, src) => {
    if (images.length < (cfg.stickerMaxPerReply || 2)) images.push({ alt: alt || '图片', src });
    return '';
  });
  return { text: stripped.replace(/[ \t]+\n/g, '\n').trim(), images };
}

async function sendMarkdownImage(chat, { alt, src }) {
  let localPath = src;
  if (localPath.startsWith('file://')) localPath = decodeURIComponent(localPath.slice(7));
  if (/^https?:\/\//i.test(localPath)) {
    // 远程图：先下下来再发，避免 QQ 拉不到内网地址
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20000);
    try {
      const res = await fetch(localPath, { signal: ac.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 8 * 1024 * 1024) throw new Error('图太大');
      await waitForSendSlot(chat.key);
      await api(sendAction(chat), {
        ...targetParams(chat),
        message: [{
          type: 'image',
          data: { file: `base64://${buf.toString('base64')}`, summary: `[${alt}]`, sub_type: 0 },
        }],
      });
      return alt;
    } finally {
      clearTimeout(timer);
    }
  }
  await sendImageFile(chat, localPath, `[${alt}]`);
  return alt;
}

// ── dsh 调用 ─────────────────────────────────────────────────────────────────
function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (process.platform === 'win32') {
      const p = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      p.on('exit', () => resolve());
      p.on('error', () => resolve());
    } else {
      try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
      resolve();
    }
  });
}

/**
 * 跑一次 dsh headless。
 * @returns {Promise<{text: string, sessionId?: string, code: number, stderr: string, timedOut: boolean}>}
 */
async function runAgent({ chat, prompt, sessionId, cwd }) {
  const args = [cfg.dshBin, '--profile', cfg.dshProfile, '--json'];
  if (sessionId) args.push('--session-id', sessionId);
  args.push('-');

  const env = {
    ...process.env,
    DSH_HOME: cfg.dshHome,
    DSH_PERMISSION_MODE: chat.guest
      ? (cfg.guestPermissionMode || 'read-only')
      : (cfg.dangerFullAccess ? 'danger-full-access' : (process.env.DSH_PERMISSION_MODE || 'workspace-write')),
    DSH_SESSION_ID: '',
    DSH_SHELL: '',
    DSH_WEB_URL: '',
    DSH_PROFILE: '',
    DSH_PROFILE_DIR: '',
  };

  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let finalText = '';
  let newSessionId;
  let sawFinal = false;

  const timer = setTimeout(async () => {
    timedOut = true;
    await killTree(child.pid);
  }, cfg.runTimeoutMs);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (buf) => {
    stdout += buf;
    let idx;
    while ((idx = stdout.indexOf('\n')) >= 0) {
      const line = stdout.slice(0, idx).trim();
      stdout = stdout.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.type === 'session') newSessionId = evt.sessionId;
      else if (evt.type === 'final') { finalText = evt.text ?? ''; sawFinal = true; }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (buf) => { stderr += buf; if (stderr.length > 20000) stderr = stderr.slice(-20000); });

  child.stdin.end(prompt, 'utf8');

  const code = await new Promise((resolve) => {
    child.on('error', () => resolve(-1));
    child.on('close', (c) => resolve(c ?? -1));
  });
  clearTimeout(timer);

  return { text: finalText, sessionId: newSessionId, code, stderr, timedOut, sawFinal };
}

// ── 队列 ─────────────────────────────────────────────────────────────────────
const chatQueues = new Map();     // chatKey -> { chain: Promise, depth: number }
let running = 0;
const waiters = [];

async function acquireGlobal() {
  if (running < cfg.maxConcurrent) { running += 1; return; }
  await new Promise((resolve) => waiters.push(resolve));
  running += 1;
}
function releaseGlobal() {
  running = Math.max(0, running - 1);
  const next = waiters.shift();
  if (next) next();
}

function enqueue(chat, job) {
  const state = chatQueues.get(chat.key) ?? { chain: Promise.resolve(), depth: 0 };
  chatQueues.set(chat.key, state);
  if (state.depth >= cfg.queueLimit) return false;
  state.depth += 1;
  state.chain = state.chain
    .then(async () => {
      const queuedAt = Date.now();
      await acquireGlobal();
      try {
        if (Date.now() - queuedAt > cfg.queueTimeoutMs) {
          await sendMessage(chat, '前面还排着不少活，这条先不接了，等会儿再发我一遍？');
          return;
        }
        await job();
      } catch (error) {
        await log('job error:', error?.message || String(error));
        try { await sendMessage(chat, `出了点问题：${error?.message || error}`); } catch { /* ignore */ }
      } finally {
        releaseGlobal();
        state.depth = Math.max(0, state.depth - 1);
      }
    })
    .catch(() => {});
  return true;
}

// ── 事件处理 ─────────────────────────────────────────────────────────────────
const seenIds = new Set();
const seenContent = new Map();
const handledRequestFlags = new Set();   // 好友请求会被重复推送，按 flag 去重

function dedupe(event) {
  const id = String(event.message_id ?? '');
  if (id && seenIds.has(id)) return true;
  if (id) { seenIds.add(id); if (seenIds.size > 800) seenIds.delete(seenIds.values().next().value); }
  const key = `${event.group_id ?? 0}|${event.user_id}|${event.raw_message ?? ''}`;
  const now = Date.now();
  const last = seenContent.get(key);
  seenContent.set(key, now);
  for (const [k, t] of seenContent) if (now - t > 60000) seenContent.delete(k);
  return last !== undefined && now - last < cfg.dedupeTtlMs;
}

const nickOf = (event) => event.sender?.card || event.sender?.nickname || String(event.user_id);

function chatOf(event) {
  if (event.message_type === 'group') {
    return { type: 'group', id: event.group_id, key: `group:${event.group_id}`, name: event.group_id };
  }
  return { type: 'private', id: event.user_id, key: `private:${event.user_id}`, name: nickOf(event) };
}

function segmentsOf(event) {
  return Array.isArray(event.message) ? event.message : [];
}

function mentionsSelf(event, selfId) {
  return segmentsOf(event).some((s) => s.type === 'at' && String(s.data?.qq) === String(selfId));
}

const COMMANDS = new Set(['/new', '/reset', '/s', '/status', '/help', '重置', '新会话']);

async function handleText(chat, event, prompt, raw = '') {
  // 指令判定要看用户原文，不能带 [QQ私聊｜xxx] 这种前缀
  const trimmed = (raw || prompt).trim();
  if (!prompt.trim()) { await sendMessage(chat, '空消息，我这边没什么可答的。'); return; }

  // 主人专用：批准 / 拒绝好友申请（别人加机器人，必须主人点头）
  const isOwner = chat.type === 'private' && (cfg.allowUsers || []).map(String).includes(String(chat.id));
  const approveMatch = trimmed.match(/^[\/／]?\s*(同意|通过|拒绝|不加|待加|待批准|申请列表)\s*(\d{5,12})?\s*$/);
  if (isOwner && approveMatch) {
    const [, verb, uin] = approveMatch;
    if (verb === '待加' || verb === '待批准' || verb === '申请列表') {
      if (!pendingFriendRequests.size) { await sendMessage(chat, '现在没有待批的好友申请。'); return; }
      const lines = [...pendingFriendRequests.entries()].map(([uid, v]) =>
        `${uid}（${v.comment || '无验证消息'}，${Math.round((Date.now() - v.at) / 60000)} 分钟前）`);
      await sendMessage(chat, `待批的申请：\n${lines.join('\n')}\n\n同意就说「同意 号码」，拒绝说「拒绝 号码」。`);
      return;
    }
    if (!uin) { await sendMessage(chat, '要带号码，比如「同意 12345678」。'); return; }
    const pending = pendingFriendRequests.get(uin);
    const approve = verb === '同意' || verb === '通过';
    try {
      await api('set_friend_add_request', { flag: pending?.flag, approve });
      pendingFriendRequests.delete(uin);
      await log(`主人${approve ? '批准' : '拒绝'}了好友申请 ${uin}`);
      await sendMessage(chat, approve ? `好，加上了 ${uin}。` : `行，拒了 ${uin}。`);
    } catch (error) {
      await log('处理好友请求失败:', error.message);
      await sendMessage(chat, `没处理成功：${error.message}（申请可能已经过期，让对方再发一次）`);
    }
    return;
  }

  // 命令
  if (COMMANDS.has(trimmed.toLowerCase())) {
    if (trimmed === '/help') {
      await sendMessage(chat, ['直接发文字就是聊天。', '可用命令：', '/new 开一个新会话（清空上下文）', '/s 看状态', '/help 这条帮助'].join('\n'));
      return;
    }
    if (trimmed === '/s' || trimmed === '/status') {
      const s = sessions[chat.key];
      await sendMessage(chat, `会话：${s?.sessionId ?? '(未开始)'}\n排队：${chatQueues.get(chat.key)?.depth ?? 0}\n运行中：${running}/${cfg.maxConcurrent}`);
      return;
    }
    delete sessions[chat.key];
    sessionsDirty = true;
    await persistSessions();
    await sendMessage(chat, '好，开新会话。前面聊的我都忘掉了。');
    return;
  }

  const cwd = cfg.workDir;
  await mkdir(cwd, { recursive: true });

  const previous = sessions[chat.key]?.sessionId;
  const fullPrompt = `${prompt}`;

  // 进度提示：长任务先安抚一句
  let progressSent = false;
  const progressTimer = setTimeout(async () => {
    progressSent = true;
    try { await sendMessage(chat, '这个要跑一会儿，弄完我发你。'); } catch { /* ignore */ }
  }, cfg.progressAfterMs);

  const startedAt = Date.now();
  await setTyping(chat, true);

  let result;
  try {
    result = await runAgent({ chat, prompt: fullPrompt, sessionId: previous, cwd });
  } finally {
    clearTimeout(progressTimer);
  }

  // 会话失效（换了 cwd / 会话被删）时，自动重开一次
  if (!result.sawFinal && previous && /session|Session/.test(result.stderr) && !result.timedOut) {
    await log('session adoption failed, retrying fresh:', result.stderr.slice(0, 300));
    delete sessions[chat.key];
    result = await runAgent({ chat, prompt: fullPrompt, sessionId: undefined, cwd });
  }

  if (result.sessionId && result.sessionId !== previous) {
    sessions[chat.key] = { sessionId: result.sessionId, updatedAt: new Date().toISOString(), nick: chat.name };
    sessionsDirty = true;
    await persistSessions();
  }

  await setTyping(chat, false);

  if (result.timedOut) {
    await sendMessage(chat, `跑了 ${Math.round(cfg.runTimeoutMs / 1000)} 秒还没完，我先掐了。可以拆小一点再问。`);
    return;
  }
  if (result.text && result.text.trim()) {
    // 「这次不回」：模型自己判断不需要接话
    const skipRe = /\[\[\s*(?:跳过|skip|不回)\s*\]\]/gi;
    const wantsSkip = skipRe.test(result.text);
    const textWithoutSkip = result.text.replace(skipRe, '').trim();
    // 先抠 Markdown 图片（插件 sticker_send / meme_render 返回的就是这种），再抠 [[表情:标签]]
    const md = extractMarkdownImages(textWithoutSkip);
    const { text, tags } = extractStickers(md.text);
    const imageCount = tags.length + md.images.length;

    if (wantsSkip && !text.trim() && imageCount === 0) {
      await log(`模型选择不回这条（${chat.key}）`);
      return;
    }

    // 拟人延迟：按字数算一个"打字/思考"的时间，扣掉模型自己已经花掉的时间
    if (cfg.humanize?.enabled !== false) {
      const wait = humanDelay(text.length, Date.now() - startedAt);
      if (wait > 300) {
        await log(`等 ${(wait / 1000).toFixed(1)}s 再发（${text.length} 字）`);
        await sleep(wait);
      }
    }

    if (text.trim()) await sendLong(chat, text.trim());
    // 表情包 1：[[表情:开心]] / [[sticker:狗头]] → 从本地图库挑一张
    for (const tag of tags) {
      try {
        const sent = await sendSticker(chat, tag);
        await log(`发表情包 ${tag} -> ${sent}`);
      } catch (error) {
        await log(`表情包 ${tag} 发送失败:`, error.message);
      }
    }
    // 表情包 2：![名字](路径/URL) → 直接发那张图（nekowhale / dsh-meme 的返回格式）
    for (const img of md.images) {
      try {
        const sent = await sendMarkdownImage(chat, img);
        await log(`发表情包(md) ${img.src.slice(-40)} -> ${sent}`);
      } catch (error) {
        await log(`发表情包(md) 失败 ${img.src.slice(-40)}:`, error.message);
      }
    }
    return;
  }
  // 没有最终文本
  const errLine = result.stderr.split('\n').filter((l) => l.includes('dsh:')).slice(-1)[0] || result.stderr.trim().split('\n').slice(-1)[0] || '';
  if (result.code === 1) {
    await sendMessage(chat, `我这轮没跑成（exit 1）。${errLine ? '\n' + errLine.slice(0, 500) : ''}`);
  } else {
    await sendMessage(chat, '我想了半天没憋出话来（空回复）。换个说法再试试？');
  }
}

async function handleImage(chat, event, promptParts, inbox) {
  const saved = [];
  for (const seg of segmentsOf(event)) {
    if (seg.type !== 'image') continue;
    const url = seg.data?.url || (seg.data?.file?.startsWith('http') ? seg.data.file : '');
    if (!url) continue;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20000);
      const res = await fetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 12 * 1024 * 1024) { saved.push('(图片太大，跳过)'); continue; }
      const name = `img-${Date.now()}-${randomUUID().slice(0, 6)}.${(seg.data?.file || '').split('.').pop()?.slice(0, 4) || 'jpg'}`;
      const file = path.join(inbox, name);
      await writeFile(file, buf);
      saved.push(file);
    } catch (error) {
      saved.push(`(图片下载失败: ${error.message})`);
    }
  }
  if (saved.length) promptParts.push(saved.map((f) => `[发来一张图片，已存到 ${f}]`).join('\n'));
}

// ── 主循环 ───────────────────────────────────────────────────────────────────
let selfId = null;
let ws = null;
let backoff = 1000;
let reconnectTimer = null;

function connect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const url = cfg.onebotWs;
  log(`连接 NapCat WebSocket: ${url}`);

  let socket;
  try {
    // ws 包支持自定义头（OneBot v11 的 Authorization: Bearer <token>）
    socket = new WebSocket(url, cfg.token ? { headers: { authorization: `Bearer ${cfg.token}` } } : {});
  } catch (error) {
    log('WebSocket 构造失败:', error.message);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.on('open', () => {
    backoff = 1000;
    log('WebSocket 已连接');
    api('get_login_info').then((info) => {
      selfId = info?.user_id ?? selfId;
      log(`登录账号：${info?.nickname ?? '?'} (${selfId})`);
    }).catch((e) => log('get_login_info 失败:', e.message));
  });

  socket.on('message', (data) => {
    let event;
    try {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      event = JSON.parse(text);
    } catch { return; }
    void onEvent(event).catch((e) => log('onEvent 异常:', e?.message || String(e)));
  });

  socket.on('close', (code, reason) => {
    log(`WebSocket 断开 code=${code} reason=${reason ? reason.toString() : ''}`);
    scheduleReconnect();
  });

  socket.on('error', (error) => {
    log('WebSocket 错误:', error?.message || String(error));
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;            // 已经在排队重连，别叠加
  const delay = Math.min(backoff, 30000);
  backoff = Math.min(backoff * 2, 30000);
  log(`${Math.round(delay / 1000)} 秒后重连…`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// 待主人批准的好友申请：uid -> { flag, comment, at }
const pendingFriendRequests = new Map();

async function notifyOwner(text) {
  const owner = (cfg.allowUsers || [])[0];
  if (!owner) return;
  try {
    const chat = { type: 'private', id: owner, key: `private:${owner}`, name: '主人' };
    await sendMessage(chat, text);
  } catch (error) {
    await log('通知主人失败:', error.message);
  }
}

async function onEvent(event) {
  // 好友请求：默认挂起，等主人点头（policy=owner-approve）
  if (event.post_type === 'request' && event.request_type === 'friend') {
    const uid = String(event.user_id);
    const policy = cfg.friendRequestPolicy || 'owner-approve';   // owner-approve | accept | whitelist | ignore
    const allowed = cfg.allowUsers.map(String).includes(uid);
    if (policy === 'ignore') {
      await log(`好友请求 ${uid}（${event.comment || ''}）→ 忽略（policy=ignore）`);
      return;
    }
    const flag = String(event.flag || '');
    if (flag && handledRequestFlags.has(flag)) return;    // 同一个请求会被重复推送几次
    if (flag) {
      handledRequestFlags.add(flag);
      if (handledRequestFlags.size > 300) handledRequestFlags.delete(handledRequestFlags.values().next().value);
    }

    // 主人点过头才通过
    if (policy === 'owner-approve') {
      pendingFriendRequests.set(uid, { flag: event.flag, comment: event.comment || '', at: Date.now() });
      await log(`好友请求 ${uid}（${event.comment || ''}）→ 挂起，等主人批准`);
      await notifyOwner(`有人想加我：${uid}（验证消息：${event.comment || '无'}）\n要同意就回「同意 ${uid}」，不同意回「拒绝 ${uid}」。`);
      return;
    }

    const approve = policy === 'whitelist' ? allowed : true;
    try {
      await api('set_friend_add_request', { flag: event.flag, approve });
      await log(`好友请求 ${uid}（${event.comment || ''}）→ ${approve ? '已通过' : '已拒绝'}${allowed ? '（白名单）' : '（非白名单：能加好友，但不会回他消息）'}`);
    } catch (error) {
      await log('处理好友请求失败:', error.message);
    }
    return;
  }
  if (event.post_type !== 'message') return;
  if (event.self_id) selfId = event.self_id;
  if (selfId !== null && String(event.user_id) === String(selfId)) return;
  if (dedupe(event)) return;

  const chat = chatOf(event);
  const isGroup = chat.type === 'group';
  const allowed = isGroup
    ? cfg.allowGroups.map(String).includes(String(chat.id))
    : cfg.allowUsers.map(String).includes(String(chat.id));
  // 客人：能聊天，但子进程用只读沙箱，跑不了命令、改不了文件
  const isGuest = !allowed && !isGroup && (cfg.guestUsers || []).map(String).includes(String(chat.id));
  if (isGuest) chat.guest = true;

  if (!allowed && !isGuest) {
    if (!isGroup && cfg.pairing) {
      const key = `pair:${chat.id}`;
      const last = lastSentPerChat.get(key) ?? 0;
      if (Date.now() - last > 60000) {
        await sendMessage(chat, `我的主人还没把我跟你配对。你的 QQ 号是 ${chat.id}，把这一串加进 bridge/config.json 的 allowUsers 里再重启就行。`);
        lastSentPerChat.set(key, Date.now());
      }
    }
    return;
  }

  if (isGroup && cfg.groupAtOnly && !mentionsSelf(event, selfId)) return;

  const parts = [];
  const texts = segmentsOf(event).filter((s) => s.type === 'text').map((s) => s.data?.text ?? '').join('');
  const replySeg = segmentsOf(event).find((s) => s.type === 'reply');
  const inbox = path.join(cfg.workDir, 'inbox');
  await mkdir(inbox, { recursive: true });
  if (texts.trim()) parts.push(texts.trim());
  await handleImage(chat, event, parts, inbox);

  if (!parts.length) {
    await sendMessage(chat, '这条我处理不了（支持文字和图片）。');
    return;
  }

  const header = `[${isGroup ? 'QQ群聊' : 'QQ私聊'}｜${nickOf(event)}(${event.user_id})${isGroup ? `｜群${chat.id}` : ''}]`;
  const prompt = `${header}\n${parts.join('\n')}`;
  log(`收到 ${chat.key} <- ${event.user_id}: ${prompt.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);

  // 指令类（/help、同意 xxx）不走"攒一会儿"，立刻处理
  const joined = parts.join(' ').trim();
  const immediate = /^[\/／]/.test(joined) || /^(同意|通过|拒绝|不加|待加|待批准|申请列表)\s*\d{0,12}$/.test(joined);
  void touchInbound();
  bufferMessage(chat, event, parts, immediate);
}

// ── 拟人化：攒消息、思考时间、"这次不回" ─────────────────────────────────────
const pendingByChat = new Map();

/** 让 QQ 显示"正在输入…"（NapCat 的 set_input_status，失败就静默跳过） */
async function setTyping(chat, on) {
  if (!cfg.humanize?.typing) return;
  try {
    const base = chat.type === 'group' ? { group_id: chat.id } : { user_id: chat.id };
    await api('set_input_status', { ...base, event_type: on ? 1 : 0 }, { timeoutMs: 5000 });
  } catch { /* 不支持就算了，不影响回复 */ }
}

function bufferMessage(chat, event, parts, immediate = false) {
  const hz = cfg.humanize || {};
  const key = chat.key;
  let slot = pendingByChat.get(key);
  if (!slot) {
    slot = { chat, event, parts: [], timer: null };
    pendingByChat.set(key, slot);
  }
  slot.parts.push(...parts);
  slot.event = event;
  if (slot.timer) clearTimeout(slot.timer);
  const wait = immediate ? 0 : (hz.debounceMs ?? 4000);
  slot.timer = setTimeout(() => { void flushPending(key); }, wait);
}

async function flushPending(key) {
  const slot = pendingByChat.get(key);
  if (!slot) return;
  pendingByChat.delete(key);
  const { chat, event, parts } = slot;
  const isGroup = chat.type === 'group';
  const header = `[${isGroup ? 'QQ群聊' : 'QQ私聊'}｜${nickOf(event)}(${event.user_id})${isGroup ? `｜群${chat.id}` : ''}]`;
  const prompt = `${header}\n${parts.join('\n')}`;
  await log(`合并后交给模型 ${chat.key}（${parts.length} 条）: ${prompt.replace(/\n/g, ' ⏎ ').slice(0, 160)}`);
  const accepted = enqueue(chat, async () => { await handleText(chat, event, prompt, parts.join('\n')); });
  if (!accepted) await sendMessage(chat, '排队的活太多了，这条先放着，过会儿再发？');
}

/** 这次回复该等多久（已扣掉模型自己跑的时间） */
function humanDelay(textLen, elapsedMs) {
  const hz = cfg.humanize || {};
  const base = Math.min(hz.maxDelayMs ?? 16000, (hz.minDelayMs ?? 1600) + textLen * (hz.perCharMs ?? 26));
  const target = base + Math.random() * (hz.jitterMs ?? 900);
  return Math.max(0, target - elapsedMs);
}

// ── 启动 ─────────────────────────────────────────────────────────────────────
async function main() {
  cfg = await loadConfig();
  if (!cfg.dshHome || !existsSync(path.join(cfg.dshHome, '.credentials.yaml'))) {
    console.error(`找不到 DSH_HOME 的凭证文件：${cfg.dshHome}\\.credentials.yaml\n先按 README 跑一次 setup。`);
    process.exit(1);
  }
  if (!existsSync(cfg.dshBin)) {
    console.error(`找不到 dsh CLI：${cfg.dshBin}`);
    process.exit(1);
  }
  await mkdir(path.join(HERE, 'logs'), { recursive: true });
  await mkdir(cfg.workDir, { recursive: true });
  await loadSessions();
  await log(`bridge 启动：dshHome=${cfg.dshHome} workDir=${cfg.workDir}`);
  await log(`白名单：私聊 ${cfg.allowUsers.join(',') || '(空，配对模式)'}；群 ${cfg.allowGroups.join(',') || '(空)'}`);
  await connect();
  process.on('unhandledRejection', (e) => log('unhandledRejection:', e?.message || String(e)));
  process.on('SIGINT', () => { log('收到 SIGINT，退出'); process.exit(0); });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
