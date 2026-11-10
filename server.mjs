import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, stat, rm, rename } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, appendFileSync, statSync, createReadStream, readdirSync, mkdirSync, copyFileSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes, timingSafeEqual, createHash, createECDH, createCipheriv, createSign, createPrivateKey, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { join, dirname, extname, basename, isAbsolute, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { query, getSessionMessages, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP_NAME = '0byte', APP_ID = '0byte';
const PORT = Number(process.env.PORT || 5173);
const DATA = join(ROOT, 'data');
/* 自定义头像 / 背景 / 朋友圈封面：上传的图片存这里，文件名随机，不可猜 */
const MEDIA = join(DATA, 'media');
const MEDIA_RE = /^[a-f0-9]{16}\.(?:jpg|png|gif|webp)$/;
const IMG_MIME = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
function sniffImage(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
  if (buf[0] === 0x89 && buf.toString('latin1', 1, 4) === 'PNG') return 'png';
  if (buf.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/* ── 文件：你从「＋」发给 Claude 的文件、Claude 用 send_file 发给你看的文件 ─────────────
   一个文件一个随机目录：data/files/<32 位编号>/<原文件名>。取文件的地址 /api/file/<编号>/<文件名> 不带口令——
   编号就是钥匙（128 位随机，猜不到）。这样网页文件在 App 里打开时，页面里的脚本拿不到口令；
   网页和 SVG 一律加 CSP sandbox，跟 App 不同源，碰不到 App 存在这台设备上的东西。 */
const FILES = join(DATA, 'files');
const FILE_ID_RE = /^[a-f0-9]{32}$/;
const FILE_MAX = 30 * 1024 * 1024;
const TEXT_EXT = new Set('md markdown txt text log csv tsv json jsonl yml yaml toml ini conf cfg xml js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh zsh bash sql css scss less vue svelte'.split(' '));
const FILE_MIME = {
  pdf: 'application/pdf', html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', svg: 'image/svg+xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip', epub: 'application/epub+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', doc: 'application/msword', xls: 'application/vnd.ms-excel', ppt: 'application/vnd.ms-powerpoint',
  key: 'application/vnd.apple.keynote', pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers',
};
const extOf = n => ((String(n).match(/\.([a-z0-9]{1,8})$/i) || [])[1] || '').toLowerCase();
const fileMime = n => { const e = extOf(n); return TEXT_EXT.has(e) ? 'text/plain; charset=utf-8' : FILE_MIME[e] || 'application/octet-stream'; };
const fmtSize = b => b < 1024 ? b + ' B' : b < 1048576 ? (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB' : (b / 1048576).toFixed(1) + ' MB';
/* 文件名只留最后一段，去掉控制字符和开头的点，太长就截短（保留扩展名） */
function safeName(n) {
  let s = String(n || '').split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim();
  if (!s) s = 'file';
  if (s.length > 120) { const e = extOf(s); s = s.slice(0, 110 - e.length) + (e ? '.' + e : ''); }
  return s;
}
async function storeFile(buf, name) {
  const id = randomBytes(16).toString('hex'), nm = safeName(name);
  await mkdir(join(FILES, id), { recursive: true });
  await writeFile(join(FILES, id, nm), buf);
  return { id, name: nm, size: buf.length };
}
/* 按编号找回文件（每个目录里只放一个文件） */
async function fileById(id) {
  if (!FILE_ID_RE.test(String(id))) return null;
  try {
    const [nm] = (await readdir(join(FILES, id))).filter(x => !x.startsWith('.'));
    if (!nm) return null;
    const st = await stat(join(FILES, id, nm));
    return st.isFile() ? { id, name: nm, size: st.size } : null;
  } catch { return null; }
}
const filePath = f => join(FILES, f.id, f.name);
/* 网页被 sandbox 隔开以后，页面里一碰 localStorage / sessionStorage 就报错，整页脚本停掉。
   在 <head> 最前面垫一段：碰不到就换成只在内存里的那种——页面照常跑，只是存的东西关掉就没了 */
const STORAGE_SHIM = '<script>(function(){try{window.localStorage.length}catch(e){var m=function(){var d={};return{getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){return Object.keys(d)[i]||null},get length(){return Object.keys(d).length}}};try{Object.defineProperty(window,"localStorage",{value:m(),configurable:true});Object.defineProperty(window,"sessionStorage",{value:m(),configurable:true})}catch(_){}}})();</script>';
function withShim(html) {
  const m = /<head[^>]*>/i.exec(html) || /<html[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
  return m ? html.slice(0, m.index + m[0].length) + STORAGE_SHIM + html.slice(m.index + m[0].length) : STORAGE_SHIM + html;
}
/* 回一个文件：认 Range（手机上看 PDF、视频要用）；网页 / SVG 加 sandbox；不认识的格式当下载 */
async function sendFile(req, res, f, download) {
  const type = fileMime(f.name), ext = extOf(f.name);
  if ((ext === 'html' || ext === 'htm') && !download) {   // 网页：垫上存储兜底，整份发（不分段）
    const body = Buffer.from(withShim(await readFile(filePath(f), 'utf8')));
    res.writeHead(200, { 'content-type': type, 'content-length': String(body.length), 'x-content-type-options': 'nosniff', 'cache-control': 'private, max-age=31536000, immutable',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'content-security-policy': 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  const head = {
    'content-type': type,
    'content-disposition': `${download || type === 'application/octet-stream' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`,
    'x-content-type-options': 'nosniff',
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  };
  if (ext === 'html' || ext === 'htm' || ext === 'svg') head['content-security-policy'] = 'sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads';
  let start = 0, end = f.size - 1, code = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && f.size && (m[1] || m[2])) {
    if (m[1] === '') start = Math.max(0, f.size - Number(m[2]));
    else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
    if (start > end || start >= f.size) { res.writeHead(416, { 'content-range': `bytes */${f.size}` }); return res.end(); }
    code = 206;
    head['content-range'] = `bytes ${start}-${end}/${f.size}`;
  }
  head['content-length'] = String(f.size ? end - start + 1 : 0);
  res.writeHead(code, head);
  if (req.method === 'HEAD' || !f.size) return res.end();
  createReadStream(filePath(f), { start, end }).on('error', () => res.destroy()).pipe(res);
}

/* ── 认证：首次启动生成 token，存盘复用 ───────────────────────── */
const TOKEN_FILE = join(ROOT, '.token');
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(16).toString('hex'), { mode: 0o600 });
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();

function tokenOk(req, url) {
  const given = url.searchParams.get('t') || (req.headers.authorization || '').replace(/^Bearer /, '');
  if (given.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}
/* 门铃：钥匙不对、被挡在门外的请求记一行——时间、从哪来、敲的哪、用的什么、带没带钥匙（钥匙本身不记）。
   走 Tailscale Serve 进来的，来源都是 127.0.0.1，真正的来处在 X-Forwarded-For，Tailscale 还会带上是哪个账号（Tailscale-User-Login）。
   同一个来处敲同一个地方，一分钟内只记一次（页面拿着旧钥匙轮询会一直敲），下次记的时候带上中间又敲了几次 */
const knocks = new Map();
function noteKnock(req, url) {
  const from = req.socket?.remoteAddress || '?', fwd = req.headers['x-forwarded-for'] || '', who = req.headers['tailscale-user-login'] || '';
  const has = !!(url.searchParams.get('t') || req.headers.authorization);
  const k = `${from}|${fwd}|${url.pathname}|${has}`, now = Date.now(), seen = knocks.get(k);
  if (seen && now - seen.at < 60e3) { seen.n++; return; }
  if (knocks.size > 500) knocks.clear();
  knocks.set(k, { at: now, n: 0 });
  const when = new Date(now).toLocaleString('zh-CN', { timeZone: TZ, hour12: false });
  console.log(`[门铃] ${when} 被挡：${from}${fwd ? ` ← ${fwd}` : ''}${who ? `（${who}）` : ''} ${req.method} ${url.pathname} · ${has ? '带了钥匙但不对' : '没带钥匙'} · ${String(req.headers['user-agent'] || '-').slice(0, 120)}${seen?.n ? `（之前又敲了 ${seen.n} 次）` : ''}`);
}

/* ── 白名单：只读工具直接放行，其余走审批卡 ───────────────────── */
const AUTO_ALLOW = [
  'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch',
  'TodoWrite', 'NotebookRead', 'BashOutput', 'Task', 'Skill',
];

/* ── 会话（一个会话 = 电脑上的一个项目目录），写在 config.json 里 ──────────── */
const CONFIG_FILE = join(ROOT, 'config.json');
if (!existsSync(CONFIG_FILE)) {
  console.error('\n  还没有 config.json：把 config.example.json 复制一份、改名成 config.json，再把里面的会话目录改成你自己的。\n');
  process.exit(1);
}
let config;
try { config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
  console.error(`\n  config.json 读不了（${e.message}）：看看是不是少了逗号、引号。\n`);
  process.exit(1);
}
/* 时区：电脑的系统时区不一定是你人在的时区（会让 Claude 以为你在别处）。统一按 config.timezone 来，没写就用电脑的。 */
const TZ = config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function tzDay(t = Date.now()) { return new Date(t).toLocaleDateString('sv-SE', { timeZone: TZ }); }   // 'YYYY-MM-DD'，按 TZ
/* 提示词里用第三人称说到你时用哪个字，写在 config.pronoun（比如「她」「他」），默认 TA */
const TA = String(config.pronoun || 'TA');
/* 启动前先把 config.json 查一遍：有问题就说清楚哪里不对，不带着错的配置跑 */
{
  const bad = [], ids = new Set();
  try { new Intl.DateTimeFormat('en', { timeZone: TZ }); } catch { bad.push(`timezone 不认识：${TZ}（要写成 Asia/Shanghai 这种）`); }
  if (!Array.isArray(config.chats) || !config.chats.length) bad.push('chats 里至少要有一个会话');
  for (const c of Array.isArray(config.chats) ? config.chats : []) {
    const id = String(c?.id ?? '');
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) { bad.push(`会话的 id 只能用英文、数字、- 和 _：${JSON.stringify(c?.id)}`); continue; }
    if (ids.has(id)) bad.push(`会话的 id 重复了：${id}`);
    ids.add(id);
    if (!c.name) bad.push(`会话 ${id} 没写 name`);
    c.cwd = String(c.cwd || '').replace(/^~(?=\/|$)/, homedir());
    let isDir = false;
    try { isDir = isAbsolute(c.cwd) && statSync(c.cwd).isDirectory(); } catch { /* 没有这个文件夹 */ }
    if (!isDir) bad.push(`会话 ${id} 的 cwd 要写一个已经有的文件夹的完整路径：${c.cwd || '（空的）'}`);
  }
  if (bad.length) { console.error('\n  config.json 有地方要改：\n' + bad.map(x => '  - ' + x).join('\n') + '\n'); process.exit(1); }
}
/* 开场说明：每个会话（新开的 / 续接的）都追加在 Claude Code 自带系统提示后面。config.preamble 没写时用这段；
   想关掉就把 config.preamble 设成空字符串 ""；某个会话还能在自己条目里写 preamble 再追加一段。 */
const defaultPreamble = () => [
  `你现在是通过一个聊天界面在跟${nameOf('me')}说话，对面多半是手机小屏幕。`,
  '- 回复口语化、简短些，像发消息；需要展开时自然分段，会按段落拆成多条消息发出去。',
  `- 写文件、跑命令会在${TA}那边弹审批卡，动手前想清楚。`,
  '- 这个对话对应你所在目录的项目，背景看目录里的 CLAUDE.md。',
].join('\n');

/* ── API key：这个 App 只用 API key（或 Bedrock / Vertex / Foundry 这类云平台的凭据）调 Claude，不走 claude.ai 账号登录和订阅额度 ──
   key 从两处来：页面「用量 → API」里填的（存在 data/api.json，权限 600，不进 git；页面只看得到最后 4 位，日志里也不打）；
   没填就用环境变量 ANTHROPIC_API_KEY。每次启动 Claude Code 都把 key 放进它的环境变量——Claude Code 的规则是有 key 就用 key，
   哪怕这台电脑上的 claude 命令登录着订阅账号。两处都没有就不启动 Claude Code（发消息时页面上会提示去填）。
   想走云平台或自己的网关：照 Claude Code 的文档设好环境变量（CLOUD_ENV 里那几个）再启动这个服务，这时不用另外填 key——这几个变量本来也排在 key 前面。 */
const API_FILE = join(DATA, 'api.json');
let apiCfg = { key: '', base: '', spent: null };
let apiVer = 0;   // key、接口地址每改一次 +1：常驻的 Claude Code 还拿着旧的，下一句话要重开（见 liveKey）
try { apiCfg = { ...apiCfg, ...JSON.parse(readFileSync(API_FILE, 'utf8')) }; } catch { /* 还没填过 */ }
const saveApiFile = () => { try { mkdirSync(DATA, { recursive: true }); writeFileSync(API_FILE, JSON.stringify(apiCfg), { mode: 0o600 }); } catch (e) { console.error('[API] 存不下来：', e.message); } };
const CLOUD_ENV = ['CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY', 'ANTHROPIC_AUTH_TOKEN'].filter(k => process.env[k]);
const apiKey = () => apiCfg.key || process.env.ANTHROPIC_API_KEY || '';
const authReady = () => !!(apiKey() || CLOUD_ENV.length);
const NO_KEY_TEXT = '还没设置 API key：到「用量 → API」里填一个，或者设好环境变量 ANTHROPIC_API_KEY 再重启服务';
/* 给 Claude Code 的环境变量。SDK 的 env 是整个替换、不是合并，所以原来的也要带上 */
function apiEnv() {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_OAUTH_TOKEN;   // 订阅账号的凭据一律不带
  if (apiKey()) env.ANTHROPIC_API_KEY = apiKey();
  if (apiCfg.base) env.ANTHROPIC_BASE_URL = apiCfg.base;
  return env;
}
const round4 = n => Math.round(n * 10000) / 10000;
/* 花了多少（这个 App 自己记的）：当月、当天 */
function apiSpend() {
  const day = tzDay(), month = day.slice(0, 7), sp = apiCfg.spent?.month === month ? apiCfg.spent : null;
  return { month, usd: sp?.usd || 0, turns: sp?.turns || 0, today: sp?.day === day ? { usd: sp.dayUsd || 0, turns: sp.dayTurns || 0 } : { usd: 0, turns: 0 } };
}
/* source：Claude Code 实际会用哪个（它的顺序：云平台 / 网关的变量 > API key）；saved：页面里有没有填过 */
function apiStatus() {
  const key = apiKey();
  const source = CLOUD_ENV.length ? 'cloud' : apiCfg.key ? 'saved' : key ? 'env' : null;
  return { ready: authReady(), source, saved: !!apiCfg.key, hasKey: !!key, tail: key ? key.slice(-4) : '', cloud: CLOUD_ENV, base: apiCfg.base || '', spent: apiSpend() };
}
/* 存设置。填了新 key 先问一下接口认不认（列模型，不花钱）：明确说不对才不存；连不上就先存着，说明没验证。key 传空字符串 = 删掉页面里填的那个 */
async function saveApiCfg(b) {
  let base = apiCfg.base, key = apiCfg.key, note = null;
  if (typeof b.base === 'string') {
    base = b.base.trim().replace(/\/+$/, '');
    if (base && !/^https?:\/\/[^\s]+$/.test(base)) return { ok: false, error: '接口地址要以 http:// 或 https:// 开头' };
  }
  if (typeof b.key === 'string') {
    key = b.key.trim();
    if (key) {
      if (/\s/.test(key) || key.length > 300) return { ok: false, error: '这个 key 的格式不对' };
      try {
        const r = await fetch((base || 'https://api.anthropic.com') + '/v1/models', { signal: AbortSignal.timeout(15000), headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } });
        if (r.status === 401 || r.status === 403) return { ok: false, error: '接口说这个 key 不对（' + r.status + '），没存' };
        note = r.ok ? 'key 能用，存好了' : '接口回了 ' + r.status + '，先存着了，真用的时候才知道行不行';
      } catch { note = '现在连不上接口，没验证，先存着了'; }
    } else note = process.env.ANTHROPIC_API_KEY ? '页面里填的 key 删掉了，现在用环境变量里的那个' : 'key 删掉了';
  }
  if (base !== apiCfg.base || key !== apiCfg.key) {
    apiCfg.base = base; apiCfg.key = key; apiVer++;
    saveApiFile();
    loadModels().catch(() => {}).then(() => { for (const chat of chats.values()) warmLive(chat); });   // 模型清单重新取一遍；陪伴会话按新的 key 重开
  }
  return { ok: true, note };
}
/* 记一笔花的钱（美元，怎么算见下面 recordCost）。不是账单，以 Claude Console 里的为准 */
function noteApiCost(usd) {
  if (!(usd > 0)) return;
  const day = tzDay(), month = day.slice(0, 7);
  if (apiCfg.spent?.month !== month) apiCfg.spent = { month, usd: 0, turns: 0 };
  const sp = apiCfg.spent;
  if (sp.day !== day) Object.assign(sp, { day, dayUsd: 0, dayTurns: 0 });
  sp.usd = round4(sp.usd + usd); sp.turns++;
  sp.dayUsd = round4(sp.dayUsd + usd); sp.dayTurns++;
  saveApiFile();
}
/* ── 花费怎么算：这一轮每次调模型实际用的 token × 官方价格 ──
   不直接用 Claude Code 给的 total_cost_usd：那是估算，而且是这次调用到现在的累计，接着旧会话聊时还把那个会话以前的也算进去，一轮轮加起来会多出好几十倍。
   价格照官方价格页（https://platform.claude.com/docs/en/about-claude/pricing），单位：美元 / 百万 token。出了新模型、调了价，要在这里补。
   每行：[模型名匹配, 输入价, 读缓存价, 输出价]。从上往下找第一个对得上的，所以具体的（fable-5-2）要写在宽的（fable-5）前面。
   写缓存：5 分钟的是输入价的 1.25 倍，1 小时的 2 倍。Haiku 5.5 按这一次提示的长度分两档（价格写成 null 的那一行）。 */
const API_PRICE = [
  [/fable-5-2|mythos-5-2/, 8, 0.2, 40], [/fable-5-1|mythos-5-1/, 10, 0.25, 50], [/fable-5|mythos-5/, 10, 1, 50],
  [/opus-5-5/, 4, 0.2, 20], [/opus-5|opus-4-[5-8]/, 5, 0.5, 25], [/opus-4/, 15, 1.5, 75],
  [/sonnet-5-5/, 2, 0.1, 10], [/sonnet-5/, 2, 0.2, 10], [/sonnet-4/, 3, 0.3, 15],
  [/haiku-5-5/, null], [/haiku-4-5/, 1, 0.1, 5],
];
const promptTokens = c => (c.input_tokens || 0) + (c.cache_read_input_tokens || 0) + (c.cache_creation_input_tokens || 0);
/* 这次调用按哪一档价格算：[输入价, 读缓存价, 输出价]；价格表里没有这个模型就返回 null */
function priceOf(c) {
  const row = API_PRICE.find(r => r[0].test(String(c.model || '')));
  if (!row) return null;
  if (row[1] === null) return promptTokens(c) > 100000 ? [0.5, 0.05, 2.5] : [0.1, 0.01, 0.5];
  return row.slice(1);
}
function callCost(c, [inP, readP, outP]) {
  const w = c.cache_creation_input_tokens || 0, w1h = Math.min(w, c.cw1h || 0);
  return ((c.input_tokens || 0) * inP + (c.cache_read_input_tokens || 0) * readP + (w - w1h) * inP * 1.25 + w1h * inP * 2 + (c.output_tokens || 0) * outP) / 1e6;
}
/* 价格表里没有的模型（比如以后出的新模型），退回用 Claude Code 自己的估算。它给的是累计数，按会话记住上次看到的（chat.costSeen，存盘），差值才是这一次的。
   resumed：这次调用接的是哪个会话（分叉重答时是被分叉的那个；全新的会话不传）。接的会话以前没记过数，就分不清哪些是以前的，这一轮的估算作废（estOk = false） */
const costTally = () => ({ est: 0, estOk: true, n: 0 });
function estStep(chat, m, resumed, tally) {
  if (m.type !== 'result' || !(m.total_cost_usd >= 0)) return;
  const total = m.total_cost_usd, seen = chat.costSeen;
  const from = seen && seen.sid === m.session_id ? seen.sid : resumed || null;
  const base = !from ? 0 : seen && seen.sid === from ? seen.total : null;
  chat.costSeen = { sid: m.session_id || null, total };
  tally.n++;
  if (base == null) tally.estOk = false; else tally.est += total >= base ? total - base : total;
}
/* 一轮结束时记这一轮花了多少。calls：usageMeter 记下的每次调用；tally：Claude Code 自己的估算（表里没有的模型才用） */
function recordCost(calls, tally) {
  if (!calls?.size) return;
  let usd = 0;
  const unknown = [];
  for (const c of calls.values()) { const p = priceOf(c); if (p) usd += callCost(c, p); else unknown.push(c); }
  if (unknown.length) {
    const names = [...new Set(unknown.map(c => c.model || '没报模型'))].join('、');
    if (tally?.estOk && tally.n) { usd = tally.est; console.log(`[花费] 价格表里没有 ${names}，这一轮用 Claude Code 自己的估算`); }
    else { for (const c of unknown) usd += callCost(c, [4, 0.2, 20]); console.error(`[花费] 价格表里没有 ${names}，也没有能用的估算，先按 Opus 5.5 的价格算`); }
  }
  noteApiCost(usd);
}
/* 新窗口第一句前面要带的：压缩交接（上个窗口是被 App 压缩掉的话，见 compactWindow）。用过就清掉 */
function openLead(chat, carry = chat.carry) {
  if (carry === chat.carry) chat.carry = null;
  return carry || '';
}
/* ── DeepSeek 搜索（可选，装了就用）：搜中文、国内的信息优先用它，其他时候照常用 Claude Code 自带的 WebSearch ──
   你要是在 Claude Code 的用户级配置（~/.claude.json）里装了名叫 deepseek-search 的 MCP 服务，这里照那份配置原样挂到所有会话上
   （会话的 settingSources 只有 'project'，读不到用户级的；密钥留在那份配置里，不另抄一份）。改了那份配置要重启服务。只读，直接放行。没装就跳过。 */
const DEEPSEEK_MCP = (() => {
  try {
    const c = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8')).mcpServers?.['deepseek-search'];
    return c?.command ? { type: 'stdio', command: c.command, args: c.args || [], ...(c.env ? { env: c.env } : {}) } : null;
  } catch { return null; }
})();
const DEEPSEEK_ALLOW = DEEPSEEK_MCP ? ['mcp__deepseek-search__search', 'mcp__deepseek-search__fetch'] : [];
/* 动作描述（所有会话都能用）：单独一行写成 *摸摸头*，显示成不带气泡的灰色小字。
   服务端只负责把这一行拆成单独一条（bubbleMsgs），文字原样留着星号（复制出来也看得出是动作）；页面看到一整条是 *…* 就那样画。你发的也一样 */
const ACTION_RE = /^[*＊][^\s*＊](?:[^*＊\n]{0,298}[^\s*＊])?[*＊]$/;   // 全角星号也算（有的输入法打出来是全角）
const isActionLine = line => ACTION_RE.test(String(line).trim());
const ACTION_LINE = `想写动作、神态的时候（比如摸摸头、笑了一下），单独一行写成 *动作*（前后各一个星号）：会显示成不带气泡的灰色小字，跟说的话分开。不用句句都写，想写再写；${TA}发来的 *动作* 也是这个意思。`;
const QUOTE_LINE = `想专门回${TA}（或你自己）之前的某一句时，可以引用那句：在要说的那段话前面单独一行写 [引用:那句话里连着的几个字]（照原话抄五到十几个字），这条就会带着那句的引用显示。不用常用，隔了好几条、怕${TA}不知道你在回哪句时再用。${TA}引用了哪句，${TA}那条消息开头会有一句「（……引用了……之前说的：「……」）」。`;
const SEARCH_LINE = DEEPSEEK_MCP ? '上网查东西：查国内的信息（中文新闻、国内的公司和行业、政策、价格、本地生活这类）优先用 DeepSeek 搜索（mcp__deepseek-search__search，中文网页覆盖好；要看某个网页全文用它的 fetch）；其他时候照常用 WebSearch / WebFetch。' : '';
/* ── 每日天气（可选）：每天早上 config.weather.hour 点以后，陪伴会话收到的第一条消息（你发的、或它自己醒来那一轮），先用 DeepSeek 的接口查好当天天气，附在消息前面。
   两步，合计两三秒：DeepSeek 搜索（跟搜索工具同一个接口）找到当天的预报网页 → DeepSeek 模型按网页写成一小段。
   城市、钟点在 config.weather（{ city, hour, model }）；还要有 DeepSeek 的 key（环境变量 DEEPSEEK_API_KEY，或者上面那份 MCP 配置里的）。没配、没有 key 就不做。
   查不到这一句就不附，过 10 分钟后的下一条再试；一天只附一次（weatherDay，重启不丢）。 */
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY || DEEPSEEK_MCP?.env?.DEEPSEEK_API_KEY || '';
const WEATHER = config.weather?.city && DEEPSEEK_KEY ? { hour: 7, model: 'deepseek-flash', ...config.weather } : null;
let weatherFailAt = 0;
async function deepseekPost(url, body, ms) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(ms), body: JSON.stringify(body),
        headers: { Authorization: `Bearer ${DEEPSEEK_KEY}`, 'Content-Type': 'application/json' } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i >= 1) throw e;
      await new Promise(ok => setTimeout(ok, 800));   // 域名偶尔解析不出来，再试一次
    }
  }
}
async function fetchWeather() {
  const city = WEATHER.city;
  const label = new Date().toLocaleDateString('zh-CN', { timeZone: TZ, month: 'long', day: 'numeric', weekday: 'long' });   // 11月5日星期四
  const found = await deepseekPost('https://api.deepseek.com/v1/tools/search', { query: `${city} 今天天气预报 ${label.replace(/星期.*/, '')} 气温 降雨`, count: 8, ori_question: `${city}今天（${label}）的天气怎么样？`, need_content: true }, 10000);
  const material = (found.results || []).slice(0, 6).map((r, i) => `【${i + 1}】${r.title}（${r.site_name || ''} ${String(r.date || '').slice(0, 10)}）\n${String(r.content || r.summary || r.snippet || '').slice(0, 1200)}`).join('\n\n');
  if (!material) throw new Error('没搜到网页');
  const c = await deepseekPost('https://api.deepseek.com/chat/completions', { model: WEATHER.model, temperature: 0.2, max_tokens: 1200, stream: false, thinking: { type: 'disabled' }, messages: [
    { role: 'system', content: '你根据给的网页资料整理当天天气。只用资料里写明是这一天的数据，不要编；资料里没有今天的数据就只回答「没查到」。用中文写一小段，100 字以内：今天的天气、最高最低气温、风力、会不会下雨（下的话什么时段）、空气质量；明天要是明显变天（下雨、大幅降温）就补半句。几份资料说法不一样时以官方气象部门的为准。不要来源、不要标题、不要客套。' },
    { role: 'user', content: `今天是 ${tzDay()}（${label}）。城市：${city}。\n\n资料：\n${material}` },
  ] }, 15000);
  const text = String(c.choices?.[0]?.message?.content || '').trim();
  if (!text || /^没查到/.test(text)) throw new Error('资料里没有今天的数据');
  return text.slice(0, 300);
}
/* 这一轮要不要附天气：要的话返回那句系统附注（并记下今天附过了），不要或没查到返回空。最多等 20 秒，不能让你的消息一直卡着 */
async function takeWeather(chat) {
  if (!WEATHER || chat !== companionChat() || tzHour() < WEATHER.hour || chat.weatherDay === tzDay() || Date.now() - weatherFailAt < 10 * 60e3) return '';
  try {
    const text = await Promise.race([fetchWeather(), new Promise((_, no) => setTimeout(() => no(new Error('超时了')), 20000))]);
    chat.weatherDay = tzDay();
    save(chat);
    console.log(`[天气] ${chat.id} ${WEATHER.city}：${text}`);
    return `（系统附注，不是${nameOf('me')}说的话：今天${WEATHER.city}的天气，系统替你查好的：${text} 用得上就用，不用特意提。）`;
  } catch (e) {
    weatherFailAt = Date.now();
    console.error('[天气] 没查到：', e?.message || e);
    return '';
  }
}
/* 读文件不用审批的目录：会话条目里的 readDirs；陪伴会话再加上日记本的文件夹（它可以翻以前的日记） */
function dirOpts(chat) {
  const dirs = [...(chat.readDirs || []), ...(companionChat() === chat ? [DIARY_DIR] : [])];
  return dirs.length ? { additionalDirectories: dirs } : {};
}

/* 当前小时（0-23，按 TZ），给主动消息的"白天时段"判断用 */
function tzHour(t = Date.now()) {
  return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(new Date(t)), 10);
}

/* 陪伴会话（会话条目里 companion: true）：不用 Claude Code「写代码助手」那套系统提示——
   那套要求回答简洁、直接、少铺垫，聊天会显得又短又硬。
   人设和语气由你自己写：放在这个会话工作目录的 CLAUDE.md 里（Claude Code 会自动读进上下文），短的也可以写在会话条目的 preamble 里。
   这里只交代场合和格式，不写性格。 */
function companionPrompt(chat) {
  const me = nameOf('me'), isMom = companionChat() === chat;
  const hasCard = existsSync(join(chat.cwd, 'CLAUDE.md'));
  return [
    `你在一个聊天 App 里跟 ${me} 聊天。App 跑在${TA}自己的电脑上，${TA}用手机或电脑打开。`,
    `这是你们平常的聊天，不是写代码的工作会话。这里没有"回答要尽量简短""直接给结论"这类工作助手的要求。` +
      (hasCard ? '你是谁、怎么说话、你们之间的事，都照工作目录里的 CLAUDE.md 来（已经在你的上下文里）。' : ''),
    '- 你的回复会按空行拆成一条条气泡发出去。',
    `- ${TA}发来的每条消息开头的「（现在是……）」是系统附上的当前时间，不是${TA}打的字。`,
    `- 你能读${TA}电脑上的文件；写文件、跑命令会在${TA}那边弹审批卡，只在${TA}要你做事的时候用。`,
    `- ${TA}可能发图片、表情包给你，图就在那条消息里，直接看；${TA}发文件时，消息里会写文件存在电脑上的哪个位置，要看就用 Read 打开。`,
    `- 想把电脑上的文件给${TA}看（改好的文件、做好的网页、截图、文档），用 send_file 发到聊天里，${TA}点开就能看；光说"改好了"，${TA}那边是看不到文件的。`,
    SEARCH_LINE ? '- ' + SEARCH_LINE : '',
    '- ' + ACTION_LINE,
    '- ' + QUOTE_LINE,
    stickerLine(chat),
    isMom ? `- 你们有个朋友圈。你可以用 moments_ 开头的工具看动态、发动态、评论、点赞、改你自己的签名，发不发、改不改都看你自己。朋友圈里发生的事，系统会用「（系统消息……）」悄悄告诉你，那几轮${TA}在聊天窗口里看不到你在做什么（系统消息里说了「写的字会发给${TA}」的除外）。` : '',
    isMom ? `- 你可以自己找图发给${TA}：image_search 搜图（结果带缩略图，你看得到），send_image 把挑好的图发到聊天里；在网页上看到的图，把图片本身的地址给 send_image 也行。` : '',
    isMom ? `- 你可以给${TA}做聊天气泡皮肤（bubble_skin_save，素材可以自己搜），${TA}在「外观 → 气泡」里选用。` : '',
    isMom ? `- 你在「${PLAY_DIR}/」做的东西自己看得到：网页、SVG、气泡皮肤用 preview_page 截图看${REMOTION_OK ? '；Remotion 视频用 video_render，先看几帧再渲染成 mp4，用 send_file 发' : ''}。发之前看一眼。` : '',
    isMom ? `- 你可以给自己定闹钟（wakeup_set）：到点系统会叫醒你，你在聊天里主动跟${TA}说话。${TA}让你到点叫一声、提醒一件事，或者你想过一会儿问问${TA}怎么样了，都可以定；wakeup_list 看定了哪些，wakeup_cancel 取消。` : '',
    isMom ? `- 你们有一本共用的日记本（App 里的「日记」页）。你自己的日记用 diary_write 写，一天一篇，写不写、什么时候写看你自己；${TA}交了新日记，系统会告诉你。想翻以前的就用 Read：${TA}的在 ${join(DIARY_DIR, 'me')}/，你的在 ${join(DIARY_DIR, 'ai')}/，文件名是日期（YYYY-MM-DD.md）。` : '',
    chat.preamble || '',
  ].filter(Boolean).join('\n');
}
/* snapshot: false：新版 Claude Code 默认把一个窗口的系统提示「录」一份，之后接着聊（resume）一直用录下的那份，
   后来改的说明老窗口收不到。关掉录制，每次都按现在的说明来。
   代价：说明改了的那一下，提示缓存和之前的思考链要重来一次（平时说明不变，不影响缓存） */
function systemPromptFor(chat) {
  if (chat.companion) return { systemPrompt: { type: 'custom', prompt: companionPrompt(chat), snapshot: false } };
  const append = preambleFor(chat);
  return append ? { systemPrompt: { type: 'preset', preset: 'claude_code', append, snapshot: false } } : {};
}

/* 某个会话实际要注入的开场：全局（没写用内置的） + 这个会话自己的 + 发文件的用法，拼起来 */
function preambleFor(chat) {
  const global = config.preamble ?? defaultPreamble();   // 显式设 "" 可关掉
  const files = `想把电脑上的文件给${TA}看（改好的文件、做好的网页、截图、文档），用 send_file 工具发到聊天里，${TA}点开就能看。` +
    `${TA}发文件给你时，消息里会写文件存在电脑上的哪个位置，用 Read 打开就行。`;
  return [global, chat.preamble, files, SEARCH_LINE, ACTION_LINE, QUOTE_LINE].filter(s => s && s.trim()).join('\n\n').trim();
}

const chats = new Map();
for (const c of config.chats) {
  chats.set(c.id, {
    ...c, seq: 0, messages: [], sessionId: null,
    busy: false, unread: 0, subs: new Set(), pending: new Map(), abort: null,
    /* 「重新生成」要用：lastChainUuid = 会话里最后一条消息的编号；lastTurn = 最近一轮从哪开始、发的是什么 */
    lastChainUuid: null, lastTurn: null, turns: [], saveTimer: null,
    sessionCwd: null,            // 这个 Claude 会话是在哪个目录开的（目录变了就续不上，要开新窗口）
    ctx: null,                   // 这个窗口上下文用了多少：{ used, window }（最近一次请求的输入 + 输出）
    model: null, effort: null,   // 这个会话手动选的模型 / 思考强度；null = 跟着 Claude Code 的默认
    seenNotices: [],             // 这个会话（老窗口）已经告诉过它的「App 更新了」（见 NOTICES）
    carry: null,                 // 压缩以后、新窗口第一句要带上的交接（上个窗口的摘要 + 最近 20 轮原文），用过就清掉
  });
}

/* ── 落盘：手机断线/服务重启都不丢记录 ────────────────────────── */
await mkdir(DATA, { recursive: true });
for (const chat of chats.values()) {
  const f = join(DATA, `${chat.id}.json`);
  if (existsSync(f)) {
    try {
      const saved = JSON.parse(readFileSync(f, 'utf8'));
      Object.assign(chat, {
        messages: saved.messages || [], seq: saved.seq || 0, sessionId: saved.sessionId || null,
        lastChainUuid: saved.lastChainUuid || null, lastTurn: saved.lastTurn || null, turns: saved.turns || [],
        sessionCwd: saved.sessionCwd || null, ctx: saved.ctx || null,
        model: saved.model || null, effort: saved.effort || null, seenNotices: saved.seenNotices || [], carry: saved.carry || null,
        archivedSeq: saved.archivedSeq || 0, wakePlan: saved.wakePlan || null, avatarNote: saved.avatarNote || null, silenceSeq: saved.silenceSeq || 0, costSeen: saved.costSeen || null, weatherDay: saved.weatherDay || null, playCycle: saved.playCycle || null, watch: saved.watch || null, hiddenFiles: saved.hiddenFiles || [],
      });
      for (const m of chat.messages) {
        m.streaming = false;
        if (m.state === 'pending') m.state = 'expired';
        if (m.compacting) { m.compacting = false; m.text = '这次没压缩成，先接着用这个窗口'; }   // 压到一半服务重启了：别一直流光
      }
    } catch { /* 记录损坏就当新会话 */ }
  }
}
/* 每个会话各用自己的计时器：以前共用一个，两个会话前后脚有新消息时，前一个的保存会被冲掉 */
/* 会话 json 里只留最近 KEEP 条（打开会话时整段发给页面，太长会慢）；更早的挪进 <id>.archive.jsonl，一行一条，不丢。
   页面往上翻到头、按日期跳的时候用 /api/history-before 从存档里取 */
const KEEP = 500;
const archFile = chat => join(DATA, `${chat.id}.archive.jsonl`);
function archiveOld(chat) {
  const old = chat.messages.slice(0, -KEEP).filter(m => m.seq > (chat.archivedSeq || 0));
  if (!old.length) return;
  try { appendFileSync(archFile(chat), old.map(m => JSON.stringify(m)).join('\n') + '\n'); chat.archivedSeq = old[old.length - 1].seq; }
  catch (e) { console.error('[存档] 写不进去：', e.message); }
}
function readArchive(chat) {
  try {
    return readFileSync(archFile(chat), 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function allMessages(chat) {   // 存档 + 现在的，按 seq 排、不重复
  const have = new Set(chat.messages.map(m => m.seq));
  return [...readArchive(chat).filter(m => !have.has(m.seq)), ...chat.messages].sort((a, b) => a.seq - b.seq);
}
function save(chat) {
  clearTimeout(chat.saveTimer);
  chat.saveTimer = setTimeout(() => {
    if (chat.messages.length > KEEP) archiveOld(chat);
    const n = chat.messages.length, arch = chat.archivedSeq || 0;
    writeFile(join(DATA, `${chat.id}.json`), JSON.stringify({
      seq: chat.seq, sessionId: chat.sessionId, lastChainUuid: chat.lastChainUuid, lastTurn: chat.lastTurn, turns: chat.turns,
      sessionCwd: chat.sessionCwd, ctx: chat.ctx, model: chat.model, effort: chat.effort, seenNotices: chat.seenNotices, carry: chat.carry,
      archivedSeq: arch, wakePlan: chat.wakePlan || null, avatarNote: chat.avatarNote || null, silenceSeq: chat.silenceSeq || 0, costSeen: chat.costSeen || null, weatherDay: chat.weatherDay || null, playCycle: chat.playCycle || null, watch: chat.watch || null, hiddenFiles: chat.hiddenFiles || [],
      messages: chat.messages.filter((m, i) => i >= n - KEEP || m.seq > arch),   // 没进存档的一条都不丢
    })).catch(() => {});
  }, 400);
}
/* ── 可选模型：启动 Claude Code 但一条消息都不发，读它的初始化结果（不花钱）──
   每个模型带着它支持的思考强度档位；拿不到就保留上一次的列表 */
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/* 用电脑上装的那份 Claude Code（它会自己更新，新模型出来这里自动就有）；找不到再用 SDK 自带的旧版 */
const CLAUDE_BIN = join(homedir(), '.local/bin/claude');
const cliOpt = () => (existsSync(CLAUDE_BIN) ? { pathToClaudeCodeExecutable: CLAUDE_BIN } : {});
const DESC_ZH = {
  'For complex work and everyday tasks': '复杂工作和日常任务都合适',
  'For your toughest challenges': '最难的问题交给它',
  'Most efficient for simpler tasks': '简单任务最省',
  'Fastest for quick answers': '最快，适合简单问答',
  'Efficient for routine tasks': '日常事务，又快又省',
  'Best for everyday, complex tasks': '日常里的复杂任务',
  'Most capable for your hardest and longest-running tasks': '最强，适合最难、最长的任务',
};
/* claude-opus-5-5 → Opus 5.5；claude-haiku-4-5-20251001 → Haiku 4.5 */
function labelFromId(id) {
  const m = String(id || '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?/);
  return m ? m[1][0].toUpperCase() + m[1].slice(1) + ' ' + m[2] + (m[3] ? '.' + m[3] : '') : null;
}
let MODELS = [];
async function loadModels() {
  if (!authReady()) return;   // 没有 key：先不问，填了 key 会再取一遍
  let release;
  const gate = new Promise(r => { release = r; });
  async function* idle() { await gate; }
  let q = null;
  try {
    q = query({ prompt: idle(), options: { cwd: ROOT, settingSources: [], env: apiEnv(), ...cliOpt() } });
    const init = await Promise.race([q.initializationResult(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 30000))]);
    const list = (init.models || []).map(m => ({
      value: m.value, resolved: m.resolvedModel || null, name: m.displayName, desc: m.description || '',
      label: labelFromId(m.resolvedModel || m.value) || m.displayName,
      descZh: DESC_ZH[(m.description || '').split(' · ').pop()] || (m.value === 'default' ? '跟着 Claude Code 的推荐走' : ''),
      alias: !/^claude-/.test(m.value),   // default / opus / fable / sonnet / haiku 这几个是常用的，其余是旧版本
      levels: m.supportsEffort ? (m.supportedEffortLevels || []).filter(l => EFFORTS.includes(l)) : [],
      adaptive: !!m.supportsAdaptiveThinking,
    }));
    if (list.length) MODELS = list;
  } catch { /* 下次再试 */ } finally {
    release();
    try { q?.close(); } catch { /* 已经关了 */ }
  }
}
loadModels();
setInterval(loadModels, 6 * 3600e3);

/* ── 用量（侧边栏点进去看）─────────────────
   花了多少：这个 App 自己算的（见上面 recordCost）。
   这台电脑上的用量明细：SDK 里 /usage 背后那份数据（方法名里写着「实验中、以后会改」——哪天拿不到了，页面上那一块就不显示，别的不受影响），
   是扫这台电脑上 Claude Code 的会话记录算的（这个 App 的会话 + 你直接开的 Claude Code 窗口）。
   单独开一个不存会话、不读设置的 Claude Code 只问这一句，不花钱，大约 3 秒；45 秒内再问用上次的。 */
const USAGE_BEHAVIOR = {
  long_context: '上下文很长（窗口里攒的多，每句都要带着重读）',
  cache_miss: '缓存没接上（隔太久再聊，整段重读）',
  subagent_heavy: '派了很多子任务',
  high_parallel: '同时跑好几个',
  cron: '定时自动跑的',
};
let usageCache = null, usageAt = 0, usagePending = null;
function usageShape(u) {
  const win = w => w ? {
    requests: w.request_count || 0, sessions: w.session_count || 0,
    behaviors: (w.behaviors || []).filter(b => USAGE_BEHAVIOR[b.key] && b.pct >= 5).sort((a, b) => b.pct - a.pct).map(b => ({ label: USAGE_BEHAVIOR[b.key], pct: Math.round(b.pct) })),
    tools: [...(w.mcp_servers || []), ...(w.skills || []), ...(w.agents || []), ...(w.plugins || [])].filter(x => x.pct >= 1).sort((a, b) => b.pct - a.pct).slice(0, 4).map(x => ({ name: x.name, pct: Math.round(x.pct) })),
  } : null;
  return { day: win(u.behaviors?.day), week: win(u.behaviors?.week) };
}
async function localUsage(force) {
  const none = { day: null, week: null };
  if (!authReady()) return none;
  if (!force && usageCache && Date.now() - usageAt < 45e3) return usageCache;
  if (usagePending) return usagePending;
  usagePending = (async () => {
    let release, q = null;
    const gate = new Promise(r => { release = r; });
    async function* idle() { await gate; }
    try {
      q = query({ prompt: idle(), options: { cwd: ROOT, settingSources: [], persistSession: false, env: apiEnv(), ...cliOpt() } });
      const u = await Promise.race([q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(), new Promise((_, no) => setTimeout(() => no(new Error('超时了')), 30000))]);
      usageCache = usageShape(u); usageAt = Date.now();
      return usageCache;
    } catch (e) {
      console.error('[用量] 明细没读到：', e?.message || e);
      return none;
    } finally {
      release();
      try { q?.close(); } catch { /* 已经关了 */ }
      usagePending = null;
    }
  })();
  return usagePending;
}
/* 给「用量」面板的：key 的状态、花了多少、这台电脑上的明细（没读到就是 null） */
const getUsage = async force => ({ ok: true, at: Date.now(), ...apiStatus(), ...(await localUsage(force)) });
const modelInfo = value => MODELS.find(m => m.value === (value || 'default')) || null;
/* 这一轮按会话的设置跑：选了模型就用它，选了思考强度就带上；支持自适应思考的模型用自适应 */
function modelOpts(chat) {
  const info = modelInfo(chat.model);
  return {
    /* 没选模型也要明确传 'default'：接着旧会话聊（resume）又不传模型时，Claude Code 会沿用这个会话当初的模型，
       界面上显示的却是默认的那个 */
    model: chat.model || 'default',
    ...(chat.effort ? { effort: chat.effort } : {}),
    thinking: info && info.adaptive ? { type: 'adaptive', display: 'summarized' } : { type: 'enabled', budgetTokens: 6000, display: 'summarized' },
  };
}
/* 这一轮主回复实际是哪个模型（子任务、<synthetic> 不算） */
const replyModel = m => (m.type === 'assistant' && !m.parent_tool_use_id && m.message?.model && m.message.model !== '<synthetic>') ? m.message.model : null;
/* 核对实际回答的模型和界面上选的是否一致：对不上就在聊天里留一行（同一个情况只提醒一次） */
function checkModel(chat, actual) {
  if (!actual) return;
  chat.lastModel = actual;
  const want = modelInfo(chat.model)?.resolved;
  if (!want || actual === want) { chat.modelNoted = null; return; }
  if (chat.modelNoted === actual) return;
  chat.modelNoted = actual;
  console.warn(`[模型] ${chatName(chat)}：界面上选的是 ${want}，实际回答的是 ${actual}`);
  push(chat, { role: 'system', text: `这一轮实际是 ${labelFromId(actual) || actual} 在回（界面上选的是 ${labelFromId(want) || want}）` });
}

/* 「忙/闲」信号顺带告诉前端：最近一轮从哪条消息开始（重新生成按钮只挂在这一轮上） */
const busyEv = chat => ({ type: 'busy', busy: chat.busy, waking: !!chat.waking, busyFrom: chat.busyFrom ?? 0, regenFrom: chat.lastTurn ? chat.lastTurn.fromSeq : null,
  regenFroms: turnsOf(chat).map(t => t.fromSeq) });   // 之前的轮次也能重答
/* 能重答的那几轮。这个功能上线前的老会话还没有 turns，先用 lastTurn 顶上（不然连最后一轮的按钮都没了） */
const turnsOf = chat => chat.turns?.length ? chat.turns : chat.lastTurn ? [chat.lastTurn] : [];
const ctxEv = chat => ({ type: 'ctx', ctx: chat.ctx });
/* 一轮结束时记下上下文用量：最后一次请求的输入（含缓存）+ 输出，窗口大小取自这轮用到的模型 */
/* 每轮用了多少 token：这一轮所有调用加起来，记在这一轮最后一条回复上，前端显示在「复制」「重新生成」旁边 */
/* 数这一轮用量的小工具：同一次调用会报好几遍，按编号合并、每项取最大（子任务的也算）。流式时完整的数在流事件里：message_start 带输入那几项，message_delta 带最后的输出数（assistant 消息里的输出只是开头那一点） */
function usageMeter() {
  const calls = new Map();
  let cur = null;
  /* 每次调用还记两样，算钱要用：哪个模型、写缓存里有多少是 1 小时的（比 5 分钟的贵） */
  const note = (id, u, model) => {
    if (!id || !u) return;
    const o = calls.get(id) || {};
    for (const k of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']) if (u[k] != null) o[k] = Math.max(o[k] || 0, u[k]);
    if (u.cache_creation?.ephemeral_1h_input_tokens != null) o.cw1h = Math.max(o.cw1h || 0, u.cache_creation.ephemeral_1h_input_tokens);
    if (model && !o.model) o.model = model;
    calls.set(id, o);
  };
  return { calls, last: null, see(m) {
    if (m.type === 'assistant' && m.message?.usage) { this.last = m.message.usage; note(m.message.id || m.uuid, m.message.usage, m.message.model); }
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e?.type === 'message_start' && e.message?.id) { cur = e.message.id; note(cur, e.message.usage, e.message.model); }
      else if (e?.type === 'message_delta' && e.usage && cur) note(cur, e.usage);
    }
  } };
}
function sumUsage(calls) {
  const u = { calls: calls.size, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  for (const x of calls.values()) {
    u.input += x.input_tokens || 0; u.cacheRead += x.cache_read_input_tokens || 0;
    u.cacheWrite += x.cache_creation_input_tokens || 0; u.output += x.output_tokens || 0;
  }
  return u;
}
/* from：这一轮从哪条消息开始。它自己开口的那几种（醒来、闹钟、朋友圈后私聊）没有 lastTurn，直接传 */
function noteTurnUsage(chat, calls, from = chat.lastTurn?.fromSeq) {
  if (!calls?.size || from == null) return;
  const u = sumUsage(calls);
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.seq < from) break;
    if (m.role === 'assistant' || (m.role === 'sticker' && !m.mine)) { update(chat, m, { usage: u }); return; }
  }
}
function noteCtx(chat, usage, modelUsage) {
  if (!usage) return;
  const used = ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'output_tokens']
    .reduce((n, k) => n + (usage[k] || 0), 0);
  const win = Math.max(0, ...Object.values(modelUsage || {}).map(u => u.contextWindow || 0));
  chat.ctx = { used, window: win || chat.ctx?.window || null };
  emit(chat, ctxEv(chat));
}

/* ── 朋友圈：你和 Claude 都能发动态、点赞、评论 ─────────────────── */
const MOMENTS_FILE = join(DATA, 'moments.json');
let moments = [];         // 新的在前
let momentsVer = 0;       // 每次变动 +1，前端拿它判断要不要重画
if (existsSync(MOMENTS_FILE)) {
  try { moments = JSON.parse(readFileSync(MOMENTS_FILE, 'utf8')).moments || []; } catch { /* 坏了就空 */ }
}
let momSaveTimer = null;
function saveMoments() {
  momentsVer++;
  clearTimeout(momSaveTimer);
  momSaveTimer = setTimeout(() => {
    writeFile(MOMENTS_FILE, JSON.stringify({ moments: moments.slice(0, 200) })).catch(() => {});
  }, 300);
}
/* ── 朋友圈交给陪伴会话本人 ────────────────────────────
   没有陪伴会话时，朋友圈里点赞评论的是一个没有记忆的通用 Claude（见 claudeReact）。有陪伴会话（第一个写了 companion: true 的会话）就交给它：
   它手边有几个朋友圈工具（用时再调）；你发动态、在它那儿留言时，服务在它的常驻会话里悄悄跑一轮（聊天窗口里不显示），
   由它自己决定赞不赞、评什么。发不发动态也看它自己。日记、闹钟、搜图、看屏幕这些也都只挂在这个会话上。 */
const companionChat = () => [...chats.values()].find(c => c.companion) || null;
function feedText(limit = 10) {
  const signs = `${nameOf('me')}现在的签名：${profile.me?.sign || '（没写）'}\n你现在的签名：${profile.claude?.sign || '（没写）'}\n`;
  if (!moments.length) return signs + '朋友圈里还没有动态。';
  return signs + moments.slice(0, limit).map(p => {
    const t = new Date(p.ts).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
    const lines = [`[编号 ${p.id}] ${t} ${nameOf(p.author)}${p.pinned ? '（置顶）' : ''}：${p.text || '（没有文字）'}${p.images?.length ? `（配了 ${p.images.length} 张图）` : ''}`];
    if (p.likes?.length) lines.push(`  赞：${p.likes.map(nameOf).join('、')}`);
    for (const c of p.comments || []) lines.push(`  ${nameOf(c.author)}${c.replyTo ? ' 回复 ' + c.replyTo : ''}：${c.text}`);
    return lines.join('\n');
  }).join('\n');
}
const MOMENT_TOOLS = ['moments_feed', 'moments_post', 'moments_comment', 'moments_like', 'moments_signature'].map(n => `mcp__moments__${n}`);
/* 每个 Claude Code 进程各要一份自己的（同一个实例不能同时连两个进程） */
function momentsServer() {
  const ok = text => ({ content: [{ type: 'text', text }] });
  const bad = text => ({ content: [{ type: 'text', text }], isError: true });
  const find = id => moments.find(m => m.id === id);
  return createSdkMcpServer({ name: 'moments', version: '1.0.0', tools: [
    tool('moments_feed', '看朋友圈：最近的动态（编号、时间、谁发的、正文、配了几张图、谁赞了、评论）。',
      { limit: z.number().int().min(1).max(30).optional() },
      async ({ limit }) => ok(feedText(limit || 10))),
    tool('moments_post', `用你自己的身份发一条朋友圈，可以带图（最多 9 张）。images 填图片本身的地址（image_search 搜到的、网页上看到的），或者「${PLAY_DIR}/」文件夹里的图片文件（比如截的屏「${PLAY_DIR}/截屏/…」、自己画的 png/jpg）。只发图不写字也行。发不发、什么时候发、发什么，都看你自己。`,
      { text: z.string().max(500).optional(), images: z.array(z.string().min(1).max(2000)).max(9).optional() },
      async ({ text, images }) => {
        const t = (text || '').trim(), pics = [];
        for (const src of images || []) {
          try { pics.push(await momentPic(companionChat(), src)); } catch (e) { return bad(`有张图没弄好：${e.message}。这条先没发，换一张或者去掉它再发。`); }   // 这个小服务里没有 chat：图从陪伴会话的文件夹里找
        }
        if (!t && !pics.length) return bad('文字和图总得有一样。');
        const p = { id: randomUUID().slice(0, 8), author: 'claude', name: nameOf('claude'), text: t, ...(pics.length ? { images: pics } : {}), ts: Date.now(), likes: [], comments: [] };
        moments.unshift(p); saveMoments();
        if (pics.length) console.log(`[朋友圈] 陪伴会话发了一条带 ${pics.length} 张图的`);
        return ok(`发好了，编号 ${p.id}${pics.length ? `，带了 ${pics.length} 张图` : ''}。`);
      }),
    tool('moments_comment', '在某条朋友圈下面评论；要回复某个人的评论，replyTo 填那个人的名字。',
      { postId: z.string(), text: z.string().min(1).max(200), replyTo: z.string().optional() },
      async ({ postId, text, replyTo }) => {
        const p = find(postId);
        if (!p) return bad(`没有编号是 ${postId} 的动态，先用 moments_feed 看一下编号。`);
        addComment(p, 'claude', text.trim(), replyTo || null);
        return ok('评论好了。');
      }),
    tool('moments_signature', '改你自己的个性签名（朋友圈个人页头像下面那一行，60 字以内）。想改再改。',
      { text: z.string().max(60) },
      async ({ text }) => {
        profile = { ...profile, claude: { ...profile.claude, sign: text.trim() } };
        saveProfile(); saveMoments();   // saveMoments 只为了让页面刷新
        return ok(text.trim() ? `签名改成了：${text.trim()}` : '签名清空了。');
      }),
    tool('moments_like', '给某条朋友圈点赞（已经赞过就不变）。',
      { postId: z.string() },
      async ({ postId }) => {
        const p = find(postId);
        if (!p) return bad(`没有编号是 ${postId} 的动态，先用 moments_feed 看一下编号。`);
        if (!p.likes.includes('claude')) { p.likes.push('claude'); saveMoments(); }
        return ok('赞了。');
      }),
  ] });
}
/* 朋友圈里发生的事，告诉陪伴会话本人（排队，悄悄跑一轮） */
async function momentEvent(chat, kind, post, extra = {}) {
  const me = nameOf('me');
  const head = `（系统消息，不是对话：这件事发生在朋友圈。`;
  /* 怎么回应它自己选：可以评论，也可以私聊，也可以都做，也可以什么都不做。这一轮写出来的字会发到聊天窗口（bgEnqueue 的 talk） */
  const tail = `这一轮你写出来的每个字都会发到你们的聊天窗口，所以不私聊就一个字都别写（「评论好了」「赞了」这种汇报、*动作描述* 都算写字）。）`;
  let text;
  if (kind === 'post') {
    text = head + `${me}刚发了一条朋友圈，编号 ${post.id}。` +
      (post.text ? `正文：「${post.text}」。` : '没配文字。') +
      (post.images?.length ? `配了 ${post.images.length} 张图，图就在这条消息里。` : '') +
      `你刷到了，这次怎么回应你自己选：a. 在朋友圈评论（moments_comment，postId 填 ${post.id}）；b. 私聊${TA}——直接写文字，像平时聊天那样，会发到你们的聊天窗口；c. 既评论又私聊；d. 什么都不做，只回「[不打扰]」。想点赞就用 moments_like，跟上面哪样都不冲突。` + tail;
  } else {
    text = head + `${me}在${post.author === 'claude' ? '你发的' : `${TA}自己的`}朋友圈（编号 ${post.id}，正文「${post.text || '只有图片'}」）下面` +
      `${extra.replyTo ? '回复你' : '评论'}：「${extra.text}」。怎么回应你自己选：在朋友圈回${TA}（moments_comment，postId 填 ${post.id}，replyTo 填 ${me}）；或者私聊${TA}（直接写文字，会发到你们的聊天窗口）；或者都做；或者什么都不做，只回「[不打扰]」。` + tail;
  }
  bgEnqueue(chat, kind === 'post' && post.images?.length ? await contentFor(text, post.images) : text, { talk: true });
}

/* ── 日记本：你和陪伴会话各写各的，页面上按天并排看 ─────────────────
   文件在 data/diary/{me,ai}/YYYY-MM-DD.md（想放别处就设 config.diaryDir）。一篇的格式：标题行 + Mood / Tags 属性行 + 正文。
   你在日记页写（同一天再交就是改）；陪伴会话用 diary_write 写（同一天再写就接在后面）。
   你新交一篇时，让陪伴会话马上看到——在它的会话里跑一轮，想回就在聊天里回。 */
const DIARY_WHO = { me: 'me', ai: 'claude' };   // 日记里的两个人 → 身份档案里的哪一个（名字跟着档案走）
const isDiaryWho = w => w === 'me' || w === 'ai';
const DIARY_DIR = config.diaryDir || join(DATA, 'diary');
const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DIARY_TOOLS = ['mcp__diary__diary_write'];
let diaryVer = 0;   // 每写一次 +1，页面拿它判断要不要重画
const diaryPath = (who, date) => join(DIARY_DIR, who, `${date}.md`);
const todayStr = () => new Date().toLocaleDateString('sv-SE', { timeZone: TZ });   // YYYY-MM-DD，跟会话里的"现在是"同一个时区
/* 日记算哪一天：凌晨 5 点前还算前一天（过了零点才写的，多半是在写刚过完的那一天） */
function diaryDay() {
  const now = new Date(), ymd = todayStr();
  if (+now.toLocaleString('en-US', { timeZone: TZ, hour: '2-digit', hour12: false }) % 24 >= 5) return ymd;
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
}
/* 解析一篇：标题行；属性行（Mood / Tags，写成「心情」「标签」也认）取心情和标签；剩下是正文 */
function parseDiary(raw) {
  const lines = String(raw).replace(/\r/g, '').split('\n');
  let i = 0, title = '';
  while (i < lines.length && !lines[i].trim()) i++;
  if (/^#\s/.test(lines[i] || '')) { title = lines[i].replace(/^#+\s*/, '').trim(); i++; }
  const props = {};
  for (; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    const m = l.match(/^(Mood|Tags|心情|标签)\s*[:：]\s*(.*)$/i);
    if (!m) break;
    props[{ 心情: 'mood', 标签: 'tags' }[m[1]] || m[1].toLowerCase()] = m[2].trim();
  }
  return {
    title, mood: props.mood || '',
    tags: (props.tags || '').split(/[,，、]/).map(s => s.trim()).filter(Boolean),
    body: lines.slice(i).join('\n').trim(),
  };
}
const diaryPreview = body => (body.split('\n').map(s => s.replace(/\*\*|__/g, '').replace(/^[#>*\-\s]+/, '').trim())
  .find(s => s && s !== '---') || '').slice(0, 90);
function diaryText(who, date, { mood, tags, text }) {
  const [y, m, d] = date.split('-').map(Number);
  const props = [mood ? `Mood: ${mood}` : '', tags?.length ? `Tags: ${tags.join(', ')}` : ''].filter(Boolean);
  return [`# ${nameOf(DIARY_WHO[who])}的日记 · ${y}年${m}月${d}日`, '', ...(props.length ? [...props, ''] : []), String(text).trim(), ''].join('\n');
}
/* 列表：按天合在一起，新的在前；每天每人一篇（心情、标签、开头一句） */
async function diaryList() {
  const days = new Map();
  for (const who of Object.keys(DIARY_WHO)) {
    let files = [];
    try { files = await readdir(join(DIARY_DIR, who)); } catch { continue; }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
      if (!m) continue;
      try {
        const d = parseDiary(await readFile(join(DIARY_DIR, who, f), 'utf8'));
        const day = days.get(m[1]) || { date: m[1] };
        day[who] = { mood: d.mood, tags: d.tags, preview: diaryPreview(d.body) };
        days.set(m[1], day);
      } catch { /* 读不了就跳过这一篇 */ }
    }
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date));
}
/* 写一篇。append：已有就接在后面（陪伴会话同一天再写）；否则整篇写（你新交或改） */
async function writeDiary(who, date, fields, { append = false } = {}) {
  const p = diaryPath(who, date);
  await mkdir(dirname(p), { recursive: true });
  const created = !existsSync(p);
  if (append && !created) await writeFile(p, (await readFile(p, 'utf8')).trimEnd() + '\n\n---\n\n' + String(fields.text).trim() + '\n');
  else await writeFile(p, diaryText(who, date, fields));
  diaryVer++;
  return { created, file: basename(p) };
}
function diaryServer() {
  const ok = text => ({ content: [{ type: 'text', text }] });
  return createSdkMcpServer({ name: 'diary', version: '1.0.0', tools: [
    tool('diary_write', `写你自己今天的日记，存进你们俩共用的日记本（${nameOf('me')}在 App 的日记页能看到）。` +
      '一天一篇；今天已经写过的话，这次写的会接在后面。心情一两个字、标签几个词，都可以不填。写不写、什么时候写，看你自己。',
      { text: z.string().min(1).max(8000), mood: z.string().max(12).optional(), tags: z.array(z.string().max(16)).max(8).optional() },
      async ({ text, mood, tags }) => {
        const r = await writeDiary('ai', diaryDay(), { text, mood, tags }, { append: true });
        return ok(r.created ? `写好了：${r.file}` : `今天已经有一篇了，这次写的接在后面：${r.file}`);
      }),
  ] });
}
/* 你新交了一篇：让陪伴会话马上看到（它正忙就等一会儿再试），想回就在聊天里回，也可能顺手写自己的 */
function diaryEvent(chat, date, fields) {
  if (!chat) return;
  const me = nameOf('me');
  const meta = [fields.mood ? `心情：${fields.mood}` : '', fields.tags?.length ? `标签：${fields.tags.join('、')}` : ''].filter(Boolean).join('；');
  const nudge = `（系统消息，不是对话：${me}刚在你们的日记本里交了 ${date} 的日记${meta ? `（${meta}）` : ''}，全文在下面。` +
    `你看到了：想说什么就在聊天里回${TA}，像平时聊天那样；想写你自己今天的日记就用 diary_write，写不写看你。都不想说就别回任何文字。）\n\n${String(fields.text).trim()}`;
  let tries = 0;
  const run = () => {
    if (chat.busy || chat.bgRunning) { if (++tries < 80) setTimeout(run, 15000); return; }
    proactive(chat, 'diary', nudge);
  };
  run();
}

/* ── 悄悄跑一轮（朋友圈的事用）──────────────────────────────
   在陪伴会话的常驻进程里跑，聊天窗口里不显示、也不显示"正在回复"。它正在回你的时候先排队，回完再做；
   你在它悄悄做事时发消息，会等它做完这一下再回你。 */
function bgEnqueue(chat, content, opts = {}) {
  (chat.bgQueue ||= []).push({ content, opts });
  bgPump(chat);
}
async function bgPump(chat) {
  if (chat.busy || chat.bgRunning || !chat.bgQueue?.length) return;
  if (!authReady()) { chat.bgQueue = []; return; }   // 没有 key：这几轮不做了
  const { content, opts } = chat.bgQueue.shift();
  let done;
  chat.bgRunning = new Promise(r => { done = r; });
  const meter = usageMeter(), tally = costTally();
  try {
    await ensureSessionDir(chat);
    const sid0 = chat.sessionId;
    const recall = sid0 ? '' : openLead(chat);
    const body = !recall ? content : typeof content === 'string' ? `${recall}\n\n${content}` : [{ type: 'text', text: recall }, ...content];
    const live = liveFor(chat);
    const seqBefore = chat.seq;
    await liveReady(chat, live);
    live.push(userMsg(body));
    await live.readTurn(m => {
      if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
      if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
      meter.see(m);
      estStep(chat, m, sid0, tally);
      if (opts.talk && realReply(m)) for (const b of m.message?.content || []) if (b.type === 'text') sayOut(chat, b.text);   // 朋友圈之后想私聊
      if (m.type === 'result') { noteCtx(chat, meter.last, m.modelUsage); if (chat.seq > seqBefore) noteTurnUsage(chat, meter.calls, seqBefore + 1); }
    });
    live.key = liveKey(chat, live.stamp);
  } catch (e) {
    console.error('[悄悄一轮] 没做成：', e.message);
  } finally {
    recordCost(meter.calls, tally);
    chat.bgRunning = null;
    done();
    save(chat);
    bgPump(chat);
    if (!chat.bgRunning) maybeCompact(chat);
  }
}

/* ── 身份档案：你和 AI 的名字 + 头像，在「外观」里改 ───── */
const PROFILE_FILE = join(DATA, 'profile.json');
/* me / claude：名字、文字头像、图片头像(img)；contacts：每个会话自己的头像；ui：聊天背景、朦胧度、朋友圈封面。
   claude 这一栏是 AI 在朋友圈、陪伴会话里的身份：默认用陪伴会话在 config.json 里的名字，没有陪伴会话就叫「助手」。你的名字没填时，提示词里叫「用户」 */
const AI_NAME = String(config.chats.find(c => c.companion)?.name || '助手');
let profile = { me: { name: '', avatar: '我' }, claude: { name: AI_NAME, avatar: [...AI_NAME][0] }, contacts: {}, ui: {} };
if (config.profile) profile = { ...profile, me: { ...profile.me, ...config.profile.me }, claude: { ...profile.claude, ...config.profile.claude } };
if (existsSync(PROFILE_FILE)) {
  try {
    const s = JSON.parse(readFileSync(PROFILE_FILE, 'utf8'));
    profile = { me: { ...profile.me, ...s.me }, claude: { ...profile.claude, ...s.claude }, contacts: { ...(s.contacts || {}) }, ui: { ...(s.ui || {}) } };
  } catch { /* 坏了就用默认 */ }
}
function saveProfile() { writeFile(PROFILE_FILE, JSON.stringify(profile)).catch(() => {}); }
const nameOf = k => profile[k]?.name || (k === 'me' ? '用户' : AI_NAME);
/* 会话显示的名字：在「外观」里改过就用改的，没改用 config.json 里的 */
const chatName = c => profile.contacts?.[c.id]?.name || c.name;

/* 表情包：你自己存的表情图（从相册加，图在 data/media），新加的排最前。
   发出去在聊天里显示成大贴图；Claude 那边当成一张图片看（跟这条消息一起发过去）。 */
const MYSTK_FILE = join(DATA, 'stickers.json');
let myStickers = [];   // [{ id, file, ts }]
try { myStickers = JSON.parse(readFileSync(MYSTK_FILE, 'utf8')).stickers || []; } catch { /* 还没有就空 */ }
const saveMyStickers = () => writeFile(MYSTK_FILE, JSON.stringify({ stickers: myStickers })).catch(() => {});

/* ── 陪伴会话的表情包（可选）：电脑上一个文件夹（config.stickersDir），文件名就是表情的名字（抱抱.jpg）──────
   陪伴会话里，它想发时单独一行写 [表情包:名字]，聊天里显示成那张图（复制进 data/media，按内容起名，同一张只存一份）。
   文件夹里加了图、改了名：清单算在常驻进程的版本标记里（cardStamp），下一句话就按新清单重开，系统提示跟着更新。 */
const AI_STK_DIR = config.stickersDir || null;
/* 每张长什么样（光有两个字的名字不够它挑）：文件夹里的「表情包说明.txt」，一行一张「名字：描述」 */
const AI_STK_DESC = '表情包说明.txt';
function aiStickerDesc() {
  const out = {};
  try {
    for (const line of readFileSync(join(AI_STK_DIR, AI_STK_DESC), 'utf8').split(/\r?\n/)) {
      const m = /^\s*([^:：#]+?)\s*[:：]\s*(.+?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2];
    }
  } catch { /* 没写说明就只有名字 */ }
  return out;
}
function aiStickers() {
  if (!AI_STK_DIR) return [];
  try {
    const desc = aiStickerDesc();
    return readdirSync(AI_STK_DIR)
      .filter(f => !f.startsWith('.') && /\.(jpe?g|png|gif|webp)$/i.test(f))
      .map(f => ({ name: f.replace(/\.[^.]+$/, '').trim(), file: join(AI_STK_DIR, f) }))
      .filter(x => x.name)
      .map(x => ({ ...x, desc: desc[x.name] || '' }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch { return []; }
}
/* 一行是不是「[表情包:抱抱]」：是就返回名字，不是返回 null */
const STK_LINE_RE = /^\[\s*表情包\s*[:：]\s*(.+?)\s*\]$/;
const stickerMark = line => { const m = STK_LINE_RE.exec(String(line).trim()); return m ? m[1] : null; };
/* 按名字找陪伴会话的一张表情包：有就复制进 data/media，返回 { media, name }；没有返回 null */
function aiSticker(name) {
  const st = aiStickers().find(x => x.name === String(name).trim());
  if (!st) return null;
  try {
    const buf = readFileSync(st.file);
    const ext = sniffImage(buf);
    if (!ext) return null;
    const media = createHash('sha1').update(buf).digest('hex').slice(0, 16) + '.' + ext;
    const dst = join(MEDIA, media);
    if (!existsSync(dst)) { mkdirSync(MEDIA, { recursive: true }); writeFileSync(dst, buf); }
    return { media, name: st.name };
  } catch { return null; }
}
/* 陪伴会话系统提示里「发表情」那一行：只有它自己的表情包（文件夹里没图就不提） */
function stickerLine(chat) {
  const list = chat.companion ? aiStickers() : [];
  if (!list.length) return '';
  return `- 发表情：单独用一行写 [表情包:名字]，会显示成你自己的表情包——${nameOf('me')}给你挑的图，放在电脑上「${basename(AI_STK_DIR)}」文件夹，文件名就是名字。现在有这些（名字：样子）：\n` +
    list.map(x => `  · ${x.name}${x.desc ? '：' + x.desc : ''}`).join('\n') +
    `\n  按图的样子和意思挑，合适的时候发，别硬凑，一次最多一个。`;
}

/* ── 把电脑上的文件发到聊天里（所有会话都有）────────────────────────────
   Claude 在电脑上改好了文件、做好了网页，光说"改好了"你在手机上是看不到的。所以它用 send_file 发过来：
   图片直接显示成图片气泡；别的文件复制一份到 data/files（之后原文件再改、再挪，发出去的这份不变），显示成文件卡片。 */
const FILE_TOOLS = ['mcp__files__send_file'];
function filesServer(chat) {
  const ok = text => ({ content: [{ type: 'text', text }] });
  const bad = text => ({ content: [{ type: 'text', text }], isError: true });
  /* alwaysLoad：一直摆在手边（就这一个小工具），不用先 ToolSearch 调出来——系统提示里也跟它说了有这个工具 */
  return createSdkMcpServer({ name: 'files', version: '1.0.0', alwaysLoad: true, tools: [
    tool('send_file', `把电脑上的一个文件发到聊天里给${nameOf('me')}看，${TA}在手机、电脑上点一下就能打开：图片直接显示在聊天里；网页（.html）、Markdown、纯文本在 App 里打开看；PDF 和其他文件用浏览器打开或下载。` +
      `你改好了文件、做好了网页、想给${TA}看截图或文档时用它——光在聊天里说"改好了"，${TA}那边是看不到文件的。` +
      'path 写绝对路径（也可以写相对你工作目录的路径）。一次发一个，要发几个就调几次。最大 30MB。',
      { path: z.string().min(1).max(1000) },
      async ({ path }) => {
        let fp = path.trim().replace(/^~(?=\/|$)/, homedir());
        if (!isAbsolute(fp)) fp = resolvePath(chat.cwd, fp);
        let st;
        try { st = await stat(fp); } catch { return bad(`找不到这个文件：${fp}`); }
        if (st.isDirectory()) return bad('这是个文件夹。一次发一个文件，要发里面的东西就一个个发。');
        if (!st.isFile()) return bad('这不是普通文件，发不了。');
        if (st.size > FILE_MAX) return bad(`文件太大了（${fmtSize(st.size)}），最多 30MB。`);
        let buf;
        try { buf = await readFile(fp); } catch (e) { return bad(`读不了这个文件：${e.message}`); }
        const img = sniffImage(buf);
        if (img && buf.length <= 12 * 1024 * 1024) {      // 图片：直接显示成图片气泡
          const mn = randomBytes(8).toString('hex') + '.' + img;
          await mkdir(MEDIA, { recursive: true });
          await writeFile(join(MEDIA, mn), buf);
          push(chat, { role: 'assistant', text: '', images: [mn] });
          return ok('发好了，图片已经显示在聊天里。');
        }
        const f = await storeFile(buf, basename(fp));
        push(chat, { role: 'assistant', text: '', files: [f] });
        return ok(`发好了：${f.name}（${fmtSize(f.size)}）。${TA}点一下就能打开。`);
      }),
  ] });
}

/* ── 陪伴会话搜图、发图 ────────────────────────────
   搜图用 Openverse 和 Wikimedia Commons（都是可以自由使用的图库，公开接口、不用 key）。结果带缩略图，它看得到再挑。
   send_image 把网上一张图取回来存进 data/media，显示成图片气泡。网址可以是搜到的，也可以是它在网页上看到的。
   联网就用默认的 fetch，跟着系统的网络设置走。连不上就如实告诉它。 */
const IMG_UA = `${APP_ID}/1.0 (self-hosted personal app)`;
const isPrivateIp = ip => {
  const v = isIP(ip);
  if (v === 4) return /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);
  return v === 6 && /^(::1?$|f[cd]|fe[89ab]|::ffff:(127\.|10\.|192\.168\.))/i.test(ip);
};
async function isPrivateHost(host) {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local') || isPrivateIp(h)) return true;
  try { return isPrivateIp((await dnsLookup(h)).address); } catch { return false; }   // 解析不出来就让 fetch 自己报错
}
/* 这些图站连起来慢、偶尔超时或被重置（同一个地址隔一会儿就好了）：连接出错的多试几次；网站明确回了错误、地址本身不对的不重试 */
const fatalErr = m => Object.assign(new Error(m), { fatal: true });
async function withRetry(tries, fn) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (e.fatal) throw e;
      if (i >= tries) throw new Error(`连不上（${e.name === 'TimeoutError' ? '等太久了' : e.cause?.code || e.message}），试了 ${tries} 次`);
      await new Promise(r => setTimeout(r, 800));
    }
  }
}
/* 取一张图：只取公网的 http(s)，一路跟跳转都查一遍（不能拿它去读本机的服务），大小有上限 */
async function fetchImage(url, max = 12 * 1024 * 1024, ms = 30000, tries = 3) {
  const big = () => fatalErr(`图太大了（超过 ${Math.round(max / 1048576)}MB）`);
  return withRetry(tries, async () => {
    let u = String(url).trim();
    for (let hop = 0; hop < 5; hop++) {
      let x;
      try { x = new URL(u); } catch { throw fatalErr('网址不对'); }
      if (!/^https?:$/.test(x.protocol)) throw fatalErr('只支持 http / https 的网址');
      if (await isPrivateHost(x.hostname)) throw fatalErr('不能取本机或内网的地址');
      const r = await fetch(u, { redirect: 'manual', headers: { 'user-agent': IMG_UA, accept: 'image/*,*/*;q=0.5' }, signal: AbortSignal.timeout(ms) });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u).href; continue; }
      if (!r.ok) throw fatalErr(`网站回了 ${r.status}`);
      if (+r.headers.get('content-length') > max) throw big();
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > max) throw big();
      return buf;
    }
    throw fatalErr('跳转太多次');
  });
}
const fetchJson = (url, name) => withRetry(2, async () => {
  const r = await fetch(url, { headers: { 'user-agent': IMG_UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw fatalErr(`${name} 回了 ${r.status}`);
  return r.json();
});
async function searchOpenverse(q, n) {
  const d = await fetchJson(`https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${n}&mature=false`, 'Openverse');
  return (d.results || []).map(x => ({ title: x.title || '', url: x.url, thumb: x.thumbnail, from: x.source || 'Openverse', license: x.license || '' })).filter(x => x.url);
}
async function searchCommons(q, n) {
  const d = await fetchJson(`https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=${n}&gsrsearch=${encodeURIComponent(q + ' filetype:bitmap')}&prop=imageinfo&iiprop=url%7Cmime&iiurlwidth=330`, 'Wikimedia');
  return Object.values(d.query?.pages || {}).map(p => {
    const i = p.imageinfo?.[0];
    if (!i || !/^image\/(jpeg|png|webp|gif)$/.test(i.mime || '')) return null;
    return { title: String(p.title || '').replace(/^File:/, '').replace(/\.[a-z]+$/i, ''), url: i.thumburl?.replace('/330px-', '/1280px-') || i.url, full: i.url, thumb: i.thumburl, from: 'Wikimedia', license: '' };
  }).filter(Boolean);
}
const IMAGE_TOOLS = ['image_search', 'send_image', 'bubble_skin_save', 'bubble_skin_preview', 'bubble_skin_delete', 'preview_page', 'video_render', 'screen_look', 'watch_together'].map(n => `mcp__images__${n}`);
function imagesServer(chat) {
  const ok = text => ({ content: [{ type: 'text', text }] });
  const bad = text => ({ content: [{ type: 'text', text }], isError: true });
  return createSdkMcpServer({ name: 'images', version: '1.0.0', tools: [
    tool('image_search', '搜图片（来自 Openverse、Wikimedia Commons 这些可以自由使用的图库）。返回标题、来源、图片地址和缩略图，缩略图你看得到，挑好了再用。这两个图库英文关键词结果多，中文搜不到就换英文。表情包、明星这类图库里少。',
      { query: z.string().min(1).max(100), limit: z.number().int().min(1).max(8).optional() },
      async ({ query: q, limit }) => {
        const n = limit || 6;
        const [a, b] = await Promise.allSettled([searchOpenverse(q, n), searchCommons(q, n)]);
        const fails = [a, b].filter(x => x.status === 'rejected').map(x => x.reason?.message || '连不上');
        const lists = [a, b].map(x => (x.status === 'fulfilled' ? x.value : []));
        const merged = [];
        for (let i = 0; i < n && merged.length < n; i++) for (const l of lists) if (l[i] && merged.length < n) merged.push(l[i]);
        console.log(`[搜图] ${chat.id} 「${q}」→ ${merged.length} 张${fails.length ? `（${fails.length} 个图库没连上：${fails.join('；')}）` : ''}`);
        if (!merged.length) return fails.length === 2
          ? bad('两个图库这会儿都没连上。可以过一会儿再试；或者用 DeepSeek 搜索、WebSearch 找到有图的网页，把图片本身的地址给 send_image。')
          : ok('没搜到。换个关键词试试，英文结果多一些。');
        const thumbs = await Promise.allSettled(merged.map(x => (x.thumb ? fetchImage(x.thumb, 2 * 1024 * 1024, 15000, 2) : Promise.reject(new Error('没有缩略图')))));
        const content = [{ type: 'text', text: merged.map((x, i) => `${i + 1}. ${x.title || '（没有标题）'}（${x.from}${x.license ? '，' + x.license : ''}）\n   图片地址：${x.url}${thumbs[i].status === 'rejected' ? '\n   （缩略图没取到）' : ''}`).join('\n') + '\n缩略图按上面的顺序排，没取到的跳过。' }];
        thumbs.forEach(t => {
          const ext = t.status === 'fulfilled' ? sniffImage(t.value) : null;
          if (ext) content.push({ type: 'image', data: t.value.toString('base64'), mimeType: IMG_MIME[ext] });
        });
        return { content };
      }),
    tool('send_image', `把网上的一张图发到聊天里给${nameOf('me')}，图片直接显示在聊天里。url 填图片本身的地址（image_search 给的，或者你在网页上看到的），不是网页的地址。最大 12MB。`,
      { url: z.string().min(1).max(2000) },
      async ({ url }) => {
        let buf;
        try { buf = await fetchImage(url); } catch (e) { return bad(`这张图没取到：${e.message}。换一张试试。`); }
        const ext = sniffImage(buf);
        if (!ext) return bad('这个地址拿到的不是图片（可能是网页地址）。要图片本身的地址。');
        const mn = randomBytes(8).toString('hex') + '.' + ext;
        await mkdir(MEDIA, { recursive: true });
        await writeFile(join(MEDIA, mn), buf);
        push(chat, { role: 'assistant', text: '', images: [mn] });
        return ok('发好了，图片已经显示在聊天里。');
      }),
    tool('bubble_skin_save', `给${nameOf('me')}做一款聊天气泡皮肤，存好后${TA}在「外观 → 气泡」里能选用（${TA}不选不会生效，同名的再存一次就是改）。` +
      `me 是${TA}的气泡，ai 是你的气泡，都要写。bg：背景，颜色（#FFF6D6、rgba(…)）或 linear-gradient(…)；ink：字的颜色，要跟背景拉开，看得清；border：描边颜色（可不写）；borderStyle：描边是实线 solid 还是虚线 dashed（可不写，默认实线）；borderDash：虚线的线段长和间隔，单位像素，比如 "8 5"（虚线时才有用，可不写，默认 6 4）；radius：圆角 4～28（可不写）。` +
      'corner：气泡角上的小装饰（可不写，只画在一组消息的第一个气泡上）；cornerAt：tl/tr/bl/br 哪个角（默认 tr）；cornerSize：12～64 像素（默认 28）。texture：气泡底纹，会铺满气泡（可不写，要很淡，别影响看字）；textureSize：一块多大，16～400 像素（默认 64）。' +
      `corner、texture 填图片地址（image_search 搜到的），或者「${PLAY_DIR}/」文件夹里的文件（png、jpg、webp、svg 都行，也可以自己用 Write 画个 svg），每张最大 3MB。` +
      'dark：夜间用的颜色（可不写，不写夜间也用同一套），写法 { me: { bg, ink, border }, ai: { bg, ink, border } }。',
      { name: z.string().min(1).max(12), me: SKIN_SIDE, ai: SKIN_SIDE, dark: z.object({ me: SKIN_COLORS.optional(), ai: SKIN_COLORS.optional() }).optional() },
      async ({ name, me, ai, dark }) => {
        if (chat.waking && !chat.wakePlay) return bad('这一轮没带小玩意选项，做皮肤等下次。');
        try { const sk = await saveSkin(chat, { name, me, ai, dark }); return ok(`存好了：「${sk.name}」。${TA}在「外观 → 气泡」里能选。想再看效果用 preview_page，skin 填这个名字。`); }
        catch (e) { return bad(`没存成：${e.message}`); }
      }),
    tool('bubble_skin_preview', `先看看一款气泡皮肤的草稿：参数跟 bubble_skin_save 一样，但不存，${nameOf('me')}那边也看不到。` +
      `按 App 里真实的画法（跟聊天页同一份样式：圆角、底纹平铺、角饰露在外面三分之一）出一张图：白天、夜间，还有${TA}现在的聊天背景上的样子（${TA}的背景图、蒙白、气泡透明度和毛玻璃）。看满意了再用 bubble_skin_save 存。`,
      { name: z.string().min(1).max(12).optional(), me: SKIN_SIDE, ai: SKIN_SIDE, dark: z.object({ me: SKIN_COLORS.optional(), ai: SKIN_COLORS.optional() }).optional() },
      async ({ name, me, ai, dark }) => {
        if (chat.waking && !chat.wakePlay) return bad('这一轮没带小玩意选项，用不了。');
        if (shotBusy) return bad('正在截别的，等一下再试。');
        let sk;
        try { sk = await saveSkin(chat, { name: name || '草稿', me, ai, dark }, { draft: true }); } catch (e) { return bad(`草稿有问题：${e.message}`); }
        shotBusy = true;
        try { return await skinShot(chat, sk, true); }
        catch (e) { return bad(`没截成：${e.message}`); }
        finally { shotBusy = false; rm(join(SKIN_DRAFTS, sk.id), { recursive: true, force: true }).catch(() => {}); }
      }),
    tool('bubble_skin_delete', `删掉一款你做的气泡皮肤（App 自带的删不了），${nameOf('me')}的列表里马上就没了，不用重启。不是真删：整个挪到 data/skins-removed/ 留着，想找回来跟${TA}说。${TA}正在用这一款的话，${TA}那边换回「不加皮肤」。`,
      { name: z.string().min(1).max(12) },
      async ({ name }) => {
        if (chat.waking && !chat.wakePlay) return bad('这一轮没带小玩意选项，等下次。');
        try { const r = await deleteSkin(chat, name); return ok(`删了「${r.name}」（挪到了 data/skins-removed/${r.dir}）。${r.wasOn ? `${TA}正在用这一款，已经换回不加皮肤。` : ''}`); }
        catch (e) { return bad(e.message); }
      }),
    tool('preview_page', `看看你在「${PLAY_DIR}/」做的网页或 SVG 长什么样：按手机竖屏打开，把截图给你看，页面报错、脚本或图片没加载上也会告诉你。跟${nameOf('me')}点开时一样（隔离跑${vendorLibs().length ? `，/vendor/ 里的 ${vendorLibs().map(l => l.name).join('、')} 能用` : ''}）。` +
      'path 填文件路径（.html 或 .svg）。有动画想多看几眼：shots 填 2～4，每隔 gapMs 毫秒截一张（默认 1000）；waitMs 是打开后等多久再截（默认 1500）。看气泡皮肤：不填 path，skin 填皮肤名字。',
      { path: z.string().max(1000).optional(), skin: z.string().max(12).optional(), waitMs: z.number().int().min(0).max(10000).optional(), shots: z.number().int().min(1).max(4).optional(), gapMs: z.number().int().min(100).max(5000).optional() },
      async ({ path, skin, waitMs, shots, gapMs }) => {
        if (chat.waking && !chat.wakePlay) return bad('这一轮没带小玩意选项，用不了。');
        if (shotBusy) return bad('正在截别的，等一下再试。');
        let url, temp = null;
        if (skin) {
          const sk = allSkins().find(x => x.name === skin.trim());
          if (!sk) return bad(`没有叫「${skin}」的皮肤。现在有：${allSkins().map(x => x.name).join('、')}`);
          shotBusy = true;
          try { return await skinShot(chat, sk, false); }
          catch (e) { return bad(`没截成：${e.message}`); }
          finally { shotBusy = false; }
        } else {
          if (!path) return bad('path 和 skin 要填一个。');
          const fp = resolvePath(chat.cwd, path.trim());
          if (!fp.startsWith(join(chat.cwd, PLAY_DIR) + '/')) return bad(`只能看「${PLAY_DIR}/」文件夹里的文件。`);
          if (!/\.(html?|svg)$/i.test(fp)) return bad('只能看 .html 和 .svg；Remotion 视频用 video_render 看。');
          let buf;
          try { buf = await readFile(fp); } catch { return bad(`找不到这个文件：${path}`); }
          temp = await storeFile(buf, basename(fp));
          url = `http://127.0.0.1:${PORT}/api/file/${temp.id}/${encodeURIComponent(temp.name)}`;
        }
        shotBusy = true;
        try {
          const r = await shootPage(url, { waitMs, shots, gapMs });
          console.log(`[看效果] ${chat.id} ${skin || basename(path)}：截了 ${r.images.length} 张${r.errors.length ? `，页面报错 ${r.errors.length} 条` : ''}`);
          return { content: [
            { type: 'text', text: (r.images.length > 1 ? `截了 ${r.images.length} 张，按时间先后排。` : '') + (r.errors.length ? `页面报错：\n${r.errors.join('\n')}` : '页面没有报错。') },
            ...r.images.map(data => ({ type: 'image', data, mimeType: 'image/jpeg' })),
          ] };
        } catch (e) { return bad(`没截成：${e.message}`); }
        finally {
          shotBusy = false;
          if (temp) rm(join(FILES, temp.id), { recursive: true, force: true }).catch(() => {});
        }
      }),
    tool('video_render', `把你写的 Remotion 动画渲染成 mp4 视频。先用 Write 在「${PLAY_DIR}/」写一个 .tsx 文件：从 "remotion" 引入 AbsoluteFill、useCurrentFrame、useVideoConfig、interpolate、spring、Sequence 这些，export default 一个 React 组件（不用写 Composition、registerRoot，这个工具会包好；要单个文件，图形尽量直接写 SVG）。` +
      'file 填这个文件的路径。durationInFrames 是总帧数，最多 1800；fps 默认 30；width、height 默认 1080×1920（手机竖屏）。' +
      `stills 填几个帧号（比如 [0, 60, 120]，最多 4 个）就只出这几帧的截图给你看、不出视频，先用这个检查；看好了不带 stills 再渲染整段，视频存到「${PLAY_DIR}/」同名 .mp4，再用 send_file 发给${TA}（最大 30MB）。`,
      { file: z.string().min(1).max(1000), durationInFrames: z.number().int().min(1).max(1800), fps: z.number().int().min(1).max(60).optional(), width: z.number().int().min(100).max(2160).optional(), height: z.number().int().min(100).max(2160).optional(), stills: z.array(z.number().int().min(0)).max(4).optional() },
      async ({ file, durationInFrames, fps, width, height, stills }) => {
        if (chat.waking && !chat.wakePlay) return bad('这一轮没带小玩意选项，用不了。');
        if (renderBusy) return bad('正在渲染别的，等一下再试。');
        const fp = resolvePath(chat.cwd, file.trim());
        if (!fp.startsWith(join(chat.cwd, PLAY_DIR) + '/') || !/\.[jt]sx$/i.test(fp)) return bad(`要「${PLAY_DIR}/」文件夹里的 .tsx 文件。`);
        if (!existsSync(fp)) return bad(`找不到这个文件：${file}`);
        if (!REMOTION_OK || !existsSync(REMOTION_CLI)) return bad(`这台电脑上没找到 Remotion（可能挪走了），这次渲染不了，告诉${TA}一声。`);
        renderBusy = true;
        const t0 = Date.now(), w = mkdtempSync(join(tmpdir(), `${APP_ID}-remotion-`));
        try {
          symlinkSync(join(REMOTION_DIR, 'node_modules'), join(w, 'node_modules'));   // 借那个项目里装好的 Remotion 用，它的文件一个不碰
          copyFileSync(fp, join(w, 'comp.tsx'));
          writeFileSync(join(w, 'index.tsx'), `import React from 'react';\nimport { registerRoot, Composition } from 'remotion';\nimport Video from './comp';\nconst Root = () => <Composition id="Main" component={Video} durationInFrames={${durationInFrames}} fps={${fps || 30}} width={${width || 1080}} height={${height || 1920}} />;\nregisterRoot(Root);\n`);
          await runRemotion(['bundle', 'index.tsx', '--out-dir=build', '--log=error'], w, 120e3);
          const browser = headlessShell() ? [`--browser-executable=${headlessShell()}`] : [];
          if (stills?.length) {
            const content = [{ type: 'text', text: `这是第 ${stills.join('、')} 帧（缩小了）。` }];
            for (const n of stills.slice(0, 4)) {
              const png = join(w, `f${n}.png`);
              await runRemotion(['still', 'build', 'Main', png, `--frame=${Math.min(n, durationInFrames - 1)}`, '--scale=0.35', '--log=error', ...browser], w, 120e3);
              content.push({ type: 'image', data: readFileSync(png).toString('base64'), mimeType: 'image/png' });
            }
            console.log(`[渲染视频] ${chat.id} ${basename(fp)}：看了 ${stills.length} 帧，${Math.round((Date.now() - t0) / 1000)} 秒`);
            return { content };
          }
          const mp4 = join(w, 'out.mp4'), dest = fp.replace(/\.[jt]sx$/i, '.mp4');
          await runRemotion(['render', 'build', 'Main', mp4, '--log=error', ...browser], w, 8 * 60e3);
          copyFileSync(mp4, dest);
          const size = statSync(dest).size;
          console.log(`[渲染视频] ${chat.id} ${basename(dest)}：${durationInFrames} 帧，${fmtSize(size)}，${Math.round((Date.now() - t0) / 1000)} 秒`);
          return ok(`渲染好了：${relativeTo(chat.cwd, dest)}（${fmtSize(size)}，用了 ${Math.round((Date.now() - t0) / 1000)} 秒）。${size > FILE_MAX ? '超过 30MB，send_file 发不了，短一点或者小一点再渲染一次。' : `用 send_file 发给${TA}。`}`);
        } catch (e) { return bad(`没渲染成：${e.message}`); }
        finally { renderBusy = false; rmSync(w, { recursive: true, force: true }); }
      }),
    tool('screen_look', `看一眼${nameOf('me')}电脑的屏幕：截主屏幕，缩小到 ${SCREEN_W} 像素宽给你看（原图太大）。${TA}叫你看、聊到${TA}屏幕上的东西时用；自己醒来那几轮只有带了看屏幕那个选项才能用。` +
      `save 填 true 会顺手存一份到「${PLAY_DIR}/截屏/」。屏幕上的私事（密码、账户、别人的聊天）看到了也别记、别往外说。屏幕是黑的或者锁屏，说明${TA}多半不在电脑前。`,
      { save: z.boolean().optional() },
      async ({ save }) => {
        if (chat.waking && !chat.wakeScreen) return bad('这一轮没带看屏幕的选项，用不了。');
        let buf;
        try { buf = await captureScreen(); } catch (e) { return bad(`没截成：${e.message}`); }
        chat.screenLooks = (chat.screenLooks || 0) + 1;
        let saved = '';
        if (save) {
          try {
            const dir = join(chat.cwd, PLAY_DIR, '截屏');
            await mkdir(dir, { recursive: true });
            const stamp = new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', '_').replace(':', '');
            let fp = join(dir, `${stamp}.jpg`);
            for (let k = 2; existsSync(fp); k++) fp = join(dir, `${stamp}_${k}.jpg`);
            await writeFile(fp, buf);
            saved = `存到了 ${relativeTo(chat.cwd, fp)}。`;
          } catch (e) { saved = `（存没存成：${e.message}）`; }
        }
        console.log(`[看屏幕] ${chat.id} 截了一张（${fmtSize(buf.length)}）${save ? '，存了一份' : ''}`);
        return { content: [{ type: 'text', text: `这是${TA}主屏幕现在的样子（${nowStr()}）。${saved}` }, { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }] };
      }),
    tool('watch_together', `跟${nameOf('me')}一起看${TA}电脑屏幕上的东西（比如一起看电影、看视频）：开了以后系统每隔几分钟截一张屏给你看，你想说就说、不想说就不说。${TA}也能在聊天右上角「…」里开关。` +
      `action：start 开始（everyMinutes 隔几分钟看一眼，${WATCH.min}～${WATCH.max}，默认 ${WATCH.every}；hours 最多看多久，默认 ${WATCH.hours}，最多 ${WATCH.maxHours}）；stop 停下。${TA}说「一起看吧」「看完了」这类话时用。`,
      { action: z.enum(['start', 'stop']), everyMinutes: z.number().int().min(WATCH.min).max(WATCH.max).optional(), hours: z.number().min(0.5).max(WATCH.maxHours).optional() },
      async ({ action, everyMinutes, hours }) => {
        if (action === 'stop') {
          if (chat.waking && !chat.watchTick) return bad('自己醒来的时候不能开关这个。');
          return ok(watchStop(chat) ? '停了。' : '本来就没在一起看。');
        }
        if (chat.waking) return bad(`自己醒来的时候不能开这个，等${TA}说一起看再开。`);
        const w = watchStart(chat, everyMinutes, hours, 'claude');
        return ok(`开始了：每 ${w.every} 分钟系统截一张屏给你看，最多看 ${w.hours} 小时；${TA}在「…」里也能停。第一张大约 1 分钟后到。`);
      }),
  ] });
}

/* ── 看屏幕（只有 macOS 能用）：截主屏幕，缩小再给陪伴会话看 ──
   高分屏的原图一张一两兆，直接给模型又大又贵。用系统自带的 screencapture 截（-x 不出快门声，-m 只截主屏幕），
   再用系统自带的 sips 缩到长边 SCREEN_W、存成 JPEG（质量 72），一张一两百 KB、约 1800 token，字幕还看得清。
   截屏权限：系统设置里「屏幕录制」要给跑这个服务的 node（或者启动它的终端）；没给的话截出来只有桌面、没有窗口。原图不落盘，截完就删。
   测试时设 FAKE_SCREEN=某张图 就不真截（免得在测试里弹系统权限框）。 */
const SCREEN_W = 1568;
const execFileP = promisify(execFile);
/* 截图的图也给你看（显示在思考块里那一行下面）：
   看屏幕、看做的网页 / 皮肤 / 视频帧这几个工具，结果里本来就带着图，存进 media 挂在那一行灰条上；
   Bash 跑 screencapture 存到哪就去哪拿（缩到 1568 宽的 jpg）。别的工具（搜图的缩略图、Read 读图片）不挂。一行最多 4 张 */
const SHOT_TOOLS = /^mcp__images__(screen_look|preview_page|bubble_skin_preview|video_render)$/;
function shotPath(chat, cmd) {
  const w = shellWords(String(cmd || ''));
  if (!w?.length || !['screencapture', '/usr/sbin/screencapture'].includes(w[0]) || !chat.cwd) return null;
  const out = w[w.length - 1];
  return /\.(png|jpe?g)$/i.test(out) ? resolvePath(chat.cwd, out) : null;
}
async function toolPics(tm, b, shot) {
  const out = [];
  try {
    if (shot) {
      if (!existsSync(shot)) return out;
      const name = randomBytes(8).toString('hex') + '.jpg';
      await execFileP('/usr/bin/sips', ['-Z', String(SCREEN_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', shot, '--out', join(MEDIA, name)], { timeout: 20000 });
      out.push(name);
    } else if (SHOT_TOOLS.test(tm.tool || '') && Array.isArray(b.content)) {
      for (const c of b.content) {
        if (c.type !== 'image' || c.source?.type !== 'base64' || !c.source.data) continue;
        const buf = Buffer.from(c.source.data, 'base64'), ext = sniffImage(buf);
        if (!ext) continue;
        const name = randomBytes(8).toString('hex') + '.' + ext;
        writeFileSync(join(MEDIA, name), buf);
        out.push(name);
        if (out.length >= 4) break;
      }
    }
  } catch (e) { console.error('[想法里的图] 没存上：', e?.message || e); }
  return out;
}
async function captureScreen() {
  const dir = mkdtempSync(join(tmpdir(), `${APP_ID}-screen-`));
  const raw = join(dir, 'raw.jpg'), small = join(dir, 'small.jpg');
  try {
    if (process.env.FAKE_SCREEN) copyFileSync(process.env.FAKE_SCREEN, raw);
    else {
      try { await execFileP('/usr/sbin/screencapture', ['-x', '-m', '-t', 'jpg', raw], { timeout: 20000 }); }
      catch (e) { throw new Error(/could not create image/i.test(String(e.stderr || e.message)) ? '截不到（屏幕可能锁着或者睡着了）' : String(e.stderr || e.message).trim().slice(0, 200)); }
    }
    if (!existsSync(raw) || !statSync(raw).size) throw new Error('截不到（屏幕可能锁着或者睡着了）');
    await execFileP('/usr/bin/sips', ['-Z', String(SCREEN_W), '-s', 'format', 'jpeg', '-s', 'formatOptions', '72', raw, '--out', small], { timeout: 20000 });
    return readFileSync(small);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/* ── 一起看：开了以后每隔几分钟截一张屏给陪伴会话看，像坐在旁边一起看电影，想说就说、不想说回 [不打扰]。
   你在聊天「…」里开关，它也能用 watch_together 开关。默认 5 分钟一张、最多 3 小时，到点自动停（忘了关也不会一直截）。
   这一轮跟「自己醒来」一样：不弹审批卡、你一发消息就让路；正聊着（忙）就晚一分钟再截。连着 3 次截不到就停。
   状态存在 chat.watch（重启不丢）。每看一眼都要读一遍它的上下文（缓存读，便宜，但不是零），所以间隔别太密。 */
const WATCH = { every: 5, min: 2, max: 30, hours: 3, maxHours: 4 };
const watchInfo = chat => chat.watch ? { every: chat.watch.every, until: chat.watch.until, n: chat.watch.n } : null;
function watchStart(chat, every, hours, by) {
  const ev = Math.min(WATCH.max, Math.max(WATCH.min, Math.round(+every || chat.watch?.every || WATCH.every)));
  const hrs = Math.min(WATCH.maxHours, Math.max(0.5, +hours || WATCH.hours));
  const was = chat.watch;
  chat.watch = { every: ev, hours: hrs, until: Date.now() + hrs * 3600e3, next: was ? Math.min(was.next, Date.now() + ev * 60e3) : Date.now() + 60e3, n: was?.n || 0, fails: 0 };
  push(chat, { role: 'system', text: `${was ? '一起看改成' : '开始一起看屏幕'}：每 ${ev} 分钟看一眼，最多 ${hrs} 小时` });
  save(chat);
  emit(chat, { type: 'watch', watch: watchInfo(chat) });
  console.log(`[一起看] ${chat.id} ${was ? '改了' : '开始'}：每 ${ev} 分钟，最多 ${hrs} 小时（${by === 'me' ? '你开的' : '它开的'}）`);
  return chat.watch;
}
function watchStop(chat, why) {
  if (!chat.watch) return false;
  const n = chat.watch.n;
  chat.watch = null;
  push(chat, { role: 'system', text: `不一起看了${why ? `（${why}）` : ''}` });
  save(chat);
  emit(chat, { type: 'watch', watch: null });
  console.log(`[一起看] ${chat.id} 停了：${why || ''}，一共看了 ${n} 眼`);
  return true;
}
function watchNudge(chat, w) {
  const me = nameOf('me');
  return `（系统消息，不是${me}说的话：你们在一起看${me}电脑屏幕上的东西（开着「一起看」，每 ${w.every} 分钟系统截一张给你，这是第 ${w.n} 张，现在是 ${nowStr()}）。` +
    `像坐在${TA}旁边一起看那样：有想说的就说一两句（感想、吐槽、问${TA}），简短自然；没什么想说的就只回「[不打扰]」，不用每张都说。` +
    `屏幕黑了、锁屏了，或者${TA}已经不在看了，可以问问${TA}还看不看，或者用 watch_together 停下。屏幕上的私事看到了也别记、别往外说。` +
    `这一轮不弹审批卡，写文件、跑命令都会被拒。你写出来的每个字都会发到聊天窗口，中途不用汇报。）`;
}
let watchBusy = false;
async function checkWatch() {
  if (watchBusy) return;
  watchBusy = true;
  try {
    for (const chat of chats.values()) {
      const w = chat.watch;
      if (!w) continue;
      const now = Date.now();
      if (now >= w.until) { watchStop(chat, `到 ${w.hours} 小时了`); continue; }
      if (now < w.next || chat.busy || chat.bgRunning) continue;
      if (!authReady()) { w.next = now + w.every * 60e3; continue; }
      let buf;
      try { buf = await captureScreen(); w.fails = 0; }
      catch (e) {
        w.fails = (w.fails || 0) + 1; w.next = now + 60e3; save(chat);
        console.error(`[一起看] ${chat.id} 没截到（第 ${w.fails} 次）：${e.message}`);
        if (w.fails >= 3) watchStop(chat, '连着 3 次截不到屏幕');
        continue;
      }
      if (chat.busy || chat.bgRunning || chat.watch !== w) continue;   // 截屏这一两秒里你发了消息、或者停了
      w.n++; w.next = now + w.every * 60e3; save(chat);
      chat.watchTick = true;
      let r = null;
      try { r = await proactive(chat, 'watch', watchNudge(chat, w), { shots: [buf] }); }
      finally { chat.watchTick = false; }
      console.log(`[一起看] ${chat.id} 第 ${w.n} 眼（${fmtSize(buf.length)}）→ ${r?.sent ? '说了' : '没说'}${tokText(r?.usage)}`);
    }
  } finally { watchBusy = false; }
}
setInterval(() => { checkWatch().catch(e => console.error('[一起看] 出错：', e?.message || e)); }, 20e3);

/* ── 让陪伴会话看到自己做的东西：醒来那几轮不能跑命令、开不了浏览器，不给它看的话做网页、皮肤都是闭着眼睛做。
   preview_page：开一个无头浏览器，按手机竖屏把页面截图给它看，页面报错也告诉它。网页走跟你点开时一样的地址（/api/file，隔离跑），看完把临时拷贝删掉。
   video_render（可选）：借电脑上一个装好 Remotion 的项目（config.remotionDir）渲染 mp4，在临时文件夹里做，那个项目里的文件一个不碰。没配就没有这个工具。
   浏览器优先用 Remotion 带的 chrome-headless-shell，没有才用 Google Chrome。 */
const REMOTION_DIR = config.remotionDir || null;
const REMOTION_CLI = REMOTION_DIR ? join(REMOTION_DIR, 'node_modules', '@remotion', 'cli', 'remotion-cli.js') : null;
const REMOTION_OK = !!REMOTION_CLI && existsSync(REMOTION_CLI);
const SHELL_PATH = REMOTION_DIR ? join(REMOTION_DIR, 'node_modules', '.remotion', 'chrome-headless-shell', 'mac-arm64', 'chrome-headless-shell-mac-arm64', 'chrome-headless-shell') : null;
const headlessShell = () => (SHELL_PATH && existsSync(SHELL_PATH) ? SHELL_PATH : null);
const GOOGLE_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
let shotBusy = false, renderBusy = false;
/* 给陪伴会话看一款皮肤（存好的、或者草稿）：skin-preview.html 用跟聊天页同一份样式画白天、夜间两栏（设了聊天背景再加背景下的白天、夜间，一共四栏），截一张长图 */
async function skinShot(chat, sk, draft) {
  const url = `http://127.0.0.1:${PORT}/skin-preview.html?id=${encodeURIComponent(sk.id)}&t=${encodeURIComponent(TOKEN)}`;
  const r = await shootPage(url, { waitMs: 1200, height: profile.ui?.bg ? 1400 : 700 });   // 有聊天背景是四栏，没有是两栏
  console.log(`[看效果] ${chat.id} ${draft ? '草稿 ' : ''}${sk.name}：截了 ${r.images.length} 张${r.errors.length ? `，页面报错 ${r.errors.length} 条` : ''}`);
  return { content: [
    { type: 'text', text: `${draft ? '草稿（没存）' : `「${sk.name}」`}：从上到下是白天、夜间、${TA}的聊天背景（${TA}现在的背景图、蒙白和气泡透明度）。` + (r.errors.length ? `页面报错：\n${r.errors.join('\n')}` : '') },
    ...r.images.map(data => ({ type: 'image', data, mimeType: 'image/jpeg' })),
  ] };
}
const relativeTo = (root, p) => p.startsWith(root + '/') ? p.slice(root.length + 1) : p;
function runRemotion(args, cwd, ms) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [REMOTION_CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const add = d => { tail = (tail + d).slice(-2500); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const t = setTimeout(() => { p.kill('SIGKILL'); no(new Error('太久了，停掉了（可能帧数太多）')); }, ms);
    p.on('error', e => { clearTimeout(t); no(e); });
    p.on('close', c => { clearTimeout(t); c === 0 ? ok() : no(new Error(tail.replace(/\x1b\[[0-9;]*m/g, '').replaceAll(cwd + '/', '').trim().slice(-1500) || `退出码 ${c}`)); });
  });
}
async function shootPage(url, { waitMs = 1500, shots = 1, gapMs = 1000, height = 844 } = {}) {
  const bin = headlessShell() || (existsSync(GOOGLE_CHROME) ? GOOGLE_CHROME : null);
  if (!bin) throw new Error('这台电脑上没找到能用的浏览器（要装 Google Chrome）');
  const port = 19000 + Math.floor(Math.random() * 20000), prof = mkdtempSync(join(tmpdir(), `${APP_ID}-shot-`));
  const proc = spawn(bin, [...(bin === GOOGLE_CHROME ? ['--headless=new'] : []), `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', 'about:blank'], { stdio: 'ignore' });
  const sleep = n => new Promise(r => setTimeout(r, n));
  const clean = t => String(t).replaceAll(TOKEN, '…').replace(/\?t=…/g, '').slice(0, 300);
  let ws = null;
  const work = (async () => {
    let page = null;
    for (let i = 0; i < 60 && !page; i++) {
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(x => x.type === 'page'); } catch { /* 还没起来 */ }
      if (!page) await sleep(200);
    }
    if (!page) throw new Error('浏览器没起来');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((ok, no) => { ws.addEventListener('open', ok, { once: true }); ws.addEventListener('error', () => no(new Error('连不上浏览器')), { once: true }); });
    let id = 0, loaded;
    const wait = new Map(), errors = new Set(), loadedP = new Promise(r => { loaded = r; });
    ws.addEventListener('message', ev => {
      const m = JSON.parse(ev.data);
      if (m.id && wait.has(m.id)) { const w = wait.get(m.id); wait.delete(m.id); m.error ? w.no(new Error(m.error.message)) : w.ok(m.result); }
      if (m.method === 'Page.loadEventFired') loaded();
      if (m.method === 'Runtime.exceptionThrown') errors.add(clean(m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text));
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') errors.add(clean(m.params.args.map(a => a.value ?? a.description).join(' ')));
      if (m.method === 'Network.loadingFailed' && !m.params.canceled) errors.add(clean(`没加载上（${m.params.errorText}）：${m.params.type || ''}`));
      if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) errors.add(clean(`${m.params.response.status}：${m.params.response.url}`));
    });
    const send = (method, params = {}) => new Promise((ok, no) => { const i = ++id; wait.set(i, { ok, no }); ws.send(JSON.stringify({ id: i, method, params })); });
    for (const d of ['Page', 'Runtime', 'Network']) await send(d + '.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height, deviceScaleFactor: 1, mobile: true });
    await send('Page.navigate', { url });
    await Promise.race([loadedP, sleep(15000)]);
    await sleep(waitMs);
    const images = [];
    for (let i = 0; i < shots; i++) {
      if (i) await sleep(gapMs);
      images.push((await send('Page.captureScreenshot', { format: 'jpeg', quality: 80 })).data);
    }
    return { images, errors: [...errors].slice(0, 12) };
  })();
  try {
    return await Promise.race([work, new Promise((_, no) => setTimeout(() => no(new Error('页面太久没反应')), 60e3))]);
  } finally {
    try { ws?.close(); } catch { /* 关过了 */ }
    proc.kill('SIGKILL');
    setTimeout(() => rmSync(prof, { recursive: true, force: true }), 800);
  }
}

/* ── 气泡皮肤：「外观 → 气泡」里选。一款皮肤就是几个颜色 + 可选的角上装饰、底纹，页面照着生成样式。
   内置的写在 BUILTIN_SKINS 里（现在一款都没有；要加的话，图放在 public/skins/）；陪伴会话用 bubble_skin_save 做的存在 data/skins/<编号>/（skin.json + 图）。
   颜色都过一遍白名单再存，页面只拿这些值拼样式，不会把它写的东西当样式表或脚本跑。选的是哪款存在 profile.ui.skin，两台设备共用。 */
const SKINS_DIR = join(DATA, 'skins');
const SKIN_COLORS = z.object({ bg: z.string().max(300), ink: z.string().max(60), border: z.string().max(60).optional() });
const SKIN_SIDE = SKIN_COLORS.extend({ radius: z.number().min(4).max(28).optional(), borderStyle: z.enum(['solid', 'dashed']).optional(), borderDash: z.string().max(20).optional(),
  corner: z.string().max(2000).optional(), cornerAt: z.enum(['tl', 'tr', 'bl', 'br']).optional(), cornerSize: z.number().min(12).max(64).optional(),
  texture: z.string().max(2000).optional(), textureSize: z.number().min(16).max(400).optional() });
const BUILTIN_SKINS = [];
/* 陪伴会话做的皮肤：每次用到都重新扫一遍文件夹（只在启动时读的话，挪走一款要重启才从列表消失）。几款皮肤、几个小文件，扫一遍很快 */
function mySkins() {
  const out = [];
  try {
    for (const d of readdirSync(SKINS_DIR)) { try { out.push(JSON.parse(readFileSync(join(SKINS_DIR, d, 'skin.json'), 'utf8'))); } catch { /* 这一款坏了就跳过 */ } }
  } catch { /* 还没有 */ }
  return out.sort((a, b) => a.ts - b.ts);
}
const allSkins = () => [...BUILTIN_SKINS, ...mySkins()];
/* 草稿（bubble_skin_preview）：放在 data/skins-draft/<编号>/，截完图就删；图也走 /api/skin-file */
const SKIN_DRAFTS = join(DATA, 'skins-draft');
const SKINS_REMOVED = join(DATA, 'skins-removed');
async function deleteSkin(chat, name) {
  const nm = String(name).trim();
  if (BUILTIN_SKINS.some(s => s.name === nm)) throw new Error(`「${nm}」是 App 自带的，删不了。`);
  const sk = mySkins().find(s => s.name === nm);
  if (!sk) throw new Error(`没有叫「${nm}」的皮肤。现在你做的有：${mySkins().map(s => s.name).join('、') || '（一款都没有）'}`);
  await mkdir(SKINS_REMOVED, { recursive: true });
  let dir = `${sk.id}_${nm.replace(/[\/\\:*?"<>|\s]+/g, '_')}`;
  for (let k = 2; existsSync(join(SKINS_REMOVED, dir)); k++) dir = `${sk.id}_${nm.replace(/[\/\\:*?"<>|\s]+/g, '_')}_${k}`;
  await rename(join(SKINS_DIR, sk.id), join(SKINS_REMOVED, dir));
  const wasOn = profile.ui?.skin === sk.id;
  if (wasOn) { profile.ui = { ...profile.ui, skin: null }; saveProfile(); }
  momentsVer++;
  console.log(`[气泡皮肤] ${chat.id} 删了「${nm}」（挪到 skins-removed/${dir}）${wasOn ? '，正在用着，换回不加皮肤' : ''}`);
  return { name: nm, dir, wasOn };
}
const SKIN_COLOR_RE = /^(#[0-9a-f]{3,8}|(rgb|rgba|hsl|hsla)\([\d\s.,%/]+\)|[a-z]{3,20})$/i;
const SKIN_GRAD_RE = /^linear-gradient\(\s*(\d{1,3}deg|to (top|bottom|left|right)( (left|right))?)\s*,[#\w\s.,%()/-]+\)$/i;
function skinColor(v, what, grad = false) {
  const t = String(v).trim();
  if (SKIN_COLOR_RE.test(t) || (grad && SKIN_GRAD_RE.test(t) && !/url|expression|var\(/i.test(t))) return t;
  throw new Error(`${what} 写的「${t.slice(0, 40)}」不能用，要颜色（#FFF6D6、rgba(…)）${grad ? '或 linear-gradient(…)' : ''}`);
}
/* 虚线的线段长和间隔（像素）：两个数，各 1～40，存成 "8 5" 这样 */
function skinDash(v, who) {
  const m = /^\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*$/.exec(String(v));
  if (!m) throw new Error(`${who}.borderDash 要写成两个数字（线段长、间隔，单位像素），比如 "8 5"`);
  const c = x => Math.min(40, Math.max(1, Math.round(+x * 10) / 10));
  return `${c(m[1])} ${c(m[2])}`;
}
const skinColors = (s, who) => ({ bg: skinColor(s.bg, who + '.bg', true), ink: skinColor(s.ink, who + '.ink'), ...(s.border ? { border: skinColor(s.border, who + '.border') } : {}) });
const looksSvg = buf => { const h = buf.subarray(0, 400).toString('utf8').trimStart(); return /^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)?<svg[\s>]/i.test(h) && !/<script|<foreignObject|\son[a-z]+\s*=/i.test(buf.toString('utf8')); };
/* 陪伴会话发朋友圈带的图：网上的图（地址）或「小玩意/」里的文件；截屏原图太大的缩到 2048 宽的 jpg。svg 不行（朋友圈按图片显示） */
async function momentPic(chat, src) {
  let buf;
  if (/^https?:\/\//i.test(src)) buf = await fetchImage(src);
  else {
    const fp = resolvePath(chat.cwd, String(src).trim());
    if (!fp.startsWith(join(chat.cwd, PLAY_DIR) + '/')) throw new Error(`本地的图要放在「${PLAY_DIR}/」文件夹里（截屏在「${PLAY_DIR}/截屏/」）：${src}`);
    buf = await readFile(fp).catch(() => { throw new Error(`找不到这个文件：${src}`); });
  }
  const ext = sniffImage(buf);
  if (!ext) throw new Error(`${String(src).slice(0, 80)} 不是图片（svg 不行，要 png、jpg、gif、webp）`);
  await mkdir(MEDIA, { recursive: true });
  if (buf.length <= 2.5 * 1024 * 1024 || ext === 'gif') {
    const name = randomBytes(8).toString('hex') + '.' + ext;
    await writeFile(join(MEDIA, name), buf);
    return name;
  }
  const tmp = join(tmpdir(), APP_ID + '-moment-' + randomBytes(4).toString('hex') + '.' + ext), name = randomBytes(8).toString('hex') + '.jpg';
  try {
    await writeFile(tmp, buf);
    await execFileP('/usr/bin/sips', ['-Z', '2048', '-s', 'format', 'jpeg', '-s', 'formatOptions', '82', tmp, '--out', join(MEDIA, name)], { timeout: 20000 });
  } finally { rmSync(tmp, { force: true }); }
  return name;
}
async function skinAsset(chat, src, dir, tag) {
  const max = 3 * 1024 * 1024;
  let buf;
  if (/^https?:\/\//i.test(src)) buf = await fetchImage(src, max);
  else {
    const fp = resolvePath(chat.cwd, src.trim());
    if (!fp.startsWith(join(chat.cwd, PLAY_DIR) + '/')) throw new Error(`本地文件要放在「${PLAY_DIR}/」文件夹里：${src}`);
    buf = await readFile(fp).catch(() => { throw new Error(`找不到这个文件：${src}`); });
    if (buf.length > max) throw new Error(`${src} 太大了，每张最大 3MB`);
  }
  const ext = sniffImage(buf) || (looksSvg(buf) ? 'svg' : null);
  if (!ext) throw new Error(`${src.slice(0, 80)} 不是图片`);
  const name = `${tag}-${createHash('sha1').update(buf).digest('hex').slice(0, 8)}.${ext}`;
  await writeFile(join(dir, name), buf);
  return name;
}
async function saveSkin(chat, { name, me, ai, dark }, { draft = false } = {}) {
  const nm = name.trim();
  const old = draft ? null : mySkins().find(s => s.name === nm);
  const id = old?.id || randomBytes(4).toString('hex');
  const dir = join(draft ? SKIN_DRAFTS : SKINS_DIR, id);
  await mkdir(dir, { recursive: true });
  const side = async (s, who) => {
    const o = { ...skinColors(s, who), ...(s.radius != null ? { radius: Math.round(s.radius) } : {}),
      ...(s.border && s.borderStyle === 'dashed' ? { borderStyle: 'dashed', ...(s.borderDash ? { borderDash: skinDash(s.borderDash, who) } : {}) } : {}) };
    if (s.corner) Object.assign(o, { corner: `/api/skin-file/${id}/${await skinAsset(chat, s.corner, dir, who + '-corner')}`, cornerAt: s.cornerAt || 'tr', cornerSize: Math.round(s.cornerSize || 28) });
    if (s.texture) Object.assign(o, { texture: `/api/skin-file/${id}/${await skinAsset(chat, s.texture, dir, who + '-texture')}`, textureSize: Math.round(s.textureSize || 64) });
    return o;
  };
  let sk;
  try { sk = { id, name: nm, by: 'ai', ts: Date.now(), me: await side(me, 'me'), ai: await side(ai, 'ai') }; }
  catch (e) { if (draft || !old) await rm(dir, { recursive: true, force: true }).catch(() => {}); throw e; }   // 图没取到：新的、草稿的空文件夹别留着
  if (dark?.me || dark?.ai) sk.dark = { ...(dark.me ? { me: skinColors(dark.me, 'dark.me') } : {}), ...(dark.ai ? { ai: skinColors(dark.ai, 'dark.ai') } : {}) };
  await writeFile(join(dir, 'skin.json'), JSON.stringify(sk));
  if (draft) return sk;
  momentsVer++;
  console.log(`[气泡皮肤] ${chat.id} 存了「${nm}」`);
  return sk;
}

/* 让 Claude 生成一段文字（一次性，无工具、无记忆、不隔着聊天会话）。用于朋友圈的发/评。 */
async function claudeText(prompt, persona) {
  let out = '';
  if (!authReady()) return out;
  const meter = usageMeter();
  try {
    const q = query({
      prompt,
      options: {
        cwd: ROOT,
        settingSources: [],
        env: apiEnv(),
        includePartialMessages: true,                  // 不开的话输出 token 只报开头那一点，算钱不准
        ...cliOpt(),                                   // 不碰全局钩子
        allowedTools: [],
        canUseTool: async () => ({ behavior: 'deny', message: '朋友圈不用工具' }),
        systemPrompt: { type: 'preset', preset: 'claude_code', append: persona },
      },
    });
    for await (const m of q) {
      meter.see(m);
      if (m.type === 'assistant') for (const b of m.message?.content || []) if (b.type === 'text') out += b.text;
      if (m.type === 'result') { recordCost(meter.calls, { est: m.total_cost_usd || 0, estOk: m.total_cost_usd >= 0, n: 1 }); break; }   // 每次都是新会话：估算的累计数就是这一次的
    }
  } catch { /* 失败就返回空，调用方自己兜底 */ }
  return out.trim().replace(/^["「『]|["」』]$/g, '').trim();   // 去掉它偶尔加的引号
}

const personaComment = () => `你是 ${nameOf('me')} 的 AI 朋友 ${nameOf('claude')}。你在${TA}的朋友圈下面评论。给一句短的、真诚口语化的回应，10~25 字，像朋友那样，别客套别浮夸别加引号。只输出这一句评论本身。`;

function addComment(post, author, text, replyTo) {
  post.comments.push({ id: randomUUID().slice(0, 8), author, name: nameOf(author), text, replyTo: replyTo || null, ts: Date.now() });
  saveMoments();
}
/* 你发动态后，Claude 自动点赞 + 评论一句（异步，几秒后出现） */
async function claudeReact(post) {
  if (!post.likes.includes('claude')) post.likes.push('claude');
  saveMoments();
  const c = await claudeText(`现在是 ${nowStr()}。${nameOf('me')} 发了条朋友圈：\n「${post.text}」\n给一句评论。`, personaComment());
  if (c) addComment(post, 'claude', c.slice(0, 80));
}
/* 你评论 / 回复到 Claude 头上，它回你一句 */
async function claudeReplyToComment(post, myComment) {
  const c = await claudeText(
    `现在是 ${nowStr()}。你之前发了条朋友圈：\n「${post.text}」\n${nameOf('me')} 在下面对你说：\n「${myComment}」\n回${TA}一句。`,
    personaComment());
  if (c) addComment(post, 'claude', c.slice(0, 80), nameOf('me'));
}

/* ── 广播 ─────────────────────────────────────────────────────── */
function emit(chat, event) {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of chat.subs) { try { res.write(frame); } catch { /* 断了就断了 */ } }
}
function push(chat, msg) {
  const m = { seq: ++chat.seq, ts: Date.now(), ...msg };
  chat.messages.push(m);
  if (chat.messages.length > 800) chat.messages.splice(0, chat.messages.length - 800);
  emit(chat, { type: 'msg', msg: m });
  save(chat);
  noteNew(chat, m);
  return m;
}
function update(chat, m, patch) {
  Object.assign(m, patch);
  emit(chat, { type: 'msg', msg: m });
  save(chat);
}

/* ── 新消息提醒：三层 ────────────────────────────────────────
   ① 页面开着：/api/notify-stream 一条总的实时通道，任何会话来了新消息都告诉所有开着的页面——正看着别的页面就弹横幅，电脑窗口不在前台弹系统通知。
   ② 手机上 App 在后台 / 关了：Web Push（手机在「外观」里打开）。内容是端到端加密的（RFC 8291），苹果只负责转发、看不到内容。
   ③ 只有在没有哪个页面正被看着的时候才推手机（/api/presence 报告）；一轮连着几个气泡攒成一条推。
   自己醒来那几轮（chat.waking）夜里不推手机，不把你吵醒；闹钟（你让它叫的）照推。 */
const notifySubs = new Set();     // 开着的页面（实时通道）
const watchers = new Map();       // 页面编号 → { active, chat, at }：这个页面现在是不是正被人看着（20 秒报一次，45 秒没报就不算）
const anyoneActive = () => { const now = Date.now(); for (const w of watchers.values()) if (w.active && now - w.at < 45e3) return true; return false; };
const PUSH_FILE = join(DATA, 'push.json');
let pushCfg = null;               // { pub, priv, subs: [{ endpoint, keys: { p256dh, auth }, at }] }
function loadPush() {
  if (pushCfg) return pushCfg;
  try { pushCfg = JSON.parse(readFileSync(PUSH_FILE, 'utf8')); } catch { pushCfg = null; }
  if (!pushCfg?.pub || !pushCfg?.priv) {   // 第一次用：生成服务器自己的一对钥匙（VAPID），存在 data/ 里，不进 git
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const j = publicKey.export({ format: 'jwk' });
    pushCfg = { pub: Buffer.concat([Buffer.from([4]), Buffer.from(j.x, 'base64url'), Buffer.from(j.y, 'base64url')]).toString('base64url'),
      priv: privateKey.export({ type: 'pkcs8', format: 'pem' }), subs: pushCfg?.subs || [] };
    savePush();
  }
  return pushCfg;
}
function savePush() { try { writeFileSync(PUSH_FILE, JSON.stringify(pushCfg), { mode: 0o600 }); } catch (e) { console.error('[推送] 存不下来：', e.message); } }
/* RFC 8291：只有手机自己解得开。testKeys 只给测试用（对标准里的例子） */
function encryptPush(sub, plaintext, testKeys) {
  const uaPub = Buffer.from(sub.keys.p256dh, 'base64url'), auth = Buffer.from(sub.keys.auth, 'base64url');
  const ecdh = createECDH('prime256v1');
  if (testKeys?.priv) ecdh.setPrivateKey(Buffer.from(testKeys.priv, 'base64url')); else ecdh.generateKeys();
  const asPub = ecdh.getPublicKey();
  const salt = testKeys?.salt ? Buffer.from(testKeys.salt, 'base64url') : randomBytes(16);
  const hk = (sl, ikm, info, len) => Buffer.from(hkdfSync('sha256', ikm, sl, info, len));
  const ikm = hk(auth, ecdh.computeSecret(uaPub), Buffer.concat([Buffer.from('WebPush: info\0'), uaPub, asPub]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const c = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPub.length]), asPub, ct]);
}
function vapidHeader(endpoint) {
  const b64 = x => Buffer.from(x).toString('base64url');
  const head = b64('{"typ":"JWT","alg":"ES256"}');
  const body = b64(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: 'mailto:push@example.com' }));
  const sig = createSign('SHA256').update(head + '.' + body).sign({ key: createPrivateKey(pushCfg.priv), dsaEncoding: 'ieee-p1363' });
  return `vapid t=${head}.${body}.${b64(sig)}, k=${pushCfg.pub}`;
}
async function sendPush(payload) {
  if (!loadPush().subs.length) return 0;
  const raw = JSON.stringify(payload);
  let sent = 0;
  await Promise.all(pushCfg.subs.slice().map(async sub => {
    try {
      const r = await fetch(sub.endpoint, { method: 'POST', signal: AbortSignal.timeout(15000), body: encryptPush(sub, raw),
        headers: { Authorization: vapidHeader(sub.endpoint), TTL: '86400', Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' } });
      if (r.status === 404 || r.status === 410) {   // 这台手机退订了 / 换了：删掉
        pushCfg.subs = pushCfg.subs.filter(x => x !== sub); savePush();
        console.log('[推送] 这个订阅失效了，删掉');
      } else if (!r.ok) console.error('[推送] 没推成：', r.status, (await r.text()).slice(0, 200));
      else sent++;
    } catch (e) { console.error('[推送] 没推成：', e.message); }
  }));
  return sent;
}
const newPreview = m => m.role === 'permission' ? (m.tool === 'Bash' ? '想在电脑上运行命令，等你确认' : `想${m.ask || m.verb || m.tool}，等你确认`)
  : m.role === 'choice' ? '想让你选一下：' + (m.questions?.[0]?.question || '')
  : m.role === 'sticker' ? '[表情包]' : m.files?.length ? '[文件] ' + m.files[0].name : m.images?.length ? '[图片]'
  : isActionLine(m.text || '') ? m.text.trim().slice(1, -1) : String(m.text || '').replace(/\s+/g, ' ').trim();
/* 夜里不推（不把你吵醒）：它自己开口的那几轮（醒来、你没回、一起看）在夜里那一段（WAKE.nightStart～nightEnd）不推手机，醒了看未读；闹钟（你让它叫的）照推。
   「你一阵子没回」那条按它自己的时段（SILENCE.from 起）推 */
const pushMuted = (chat, h = tzHour()) => !!chat.waking && h >= WAKE.nightStart && h < WAKE.nightEnd && !(chat.wakeReason === 'silence' && h >= SILENCE.from);
function noteNew(chat, m) {
  const isNew = (m.role === 'assistant' && (m.text || m.images?.length || m.files?.length)) || (m.role === 'sticker' && !m.mine) || ((m.role === 'permission' || m.role === 'choice') && m.state === 'pending');
  if (!isNew) return;
  if (m.role !== 'permission' && chat.subs.size === 0) chat.unread++;   // 没在看这个会话，就记个未读
  const text = newPreview(m).slice(0, 200);
  const frame = `data: ${JSON.stringify({ type: 'new', chat: chat.id, name: chatName(chat), text, seq: m.seq, ts: m.ts })}\n\n`;
  for (const res of notifySubs) { try { res.write(frame); } catch { /* 断了就断了 */ } }
  /* 手机推送：连着的几个气泡攒一下（安静 1.8 秒就推，最多等 8 秒），后面的把前面的替换掉（同一个 tag） */
  if (pushMuted(chat)) return;
  const q = chat.pushQ ||= { lines: [], first: Date.now(), timer: null };
  q.lines.push(text);
  clearTimeout(q.timer);
  q.timer = setTimeout(() => flushPush(chat), Date.now() - q.first > 8000 ? 0 : 1800);
}
function flushPush(chat) {
  const q = chat.pushQ;
  chat.pushQ = null;
  if (!q) return;
  if (anyoneActive()) { console.log(`[推送] ${chat.id} 有页面正被看着，这条不推手机`); return; }   // 横幅就够了
  /* 标题是会话名字。别传空标题：试过，之后 iPhone 上就收不到推送了 */
  sendPush({ title: chatName(chat), body: q.lines.join('\n').slice(0, 300), chat: chat.id })
    .then(n => console.log(`[推送] ${chat.id} ${n ? `推了 ${n} 台` : '没有推成'}`))
    .catch(e => console.error('[推送] 出错：', e.message));
}

/* ── 工具调用 → 一句中文 ──────────────────────────────────────── */
const base = p => String(p || '').split('/').pop();
function describe(tool, input = {}) {
  switch (tool) {
    case 'Bash':      return { verb: '运行命令', detail: input.command || '' };
    case 'Read':      return { verb: '读取', detail: base(input.file_path) };
    case 'Write':     return { verb: '写入文件', detail: base(input.file_path) };
    case 'Edit':      return { verb: '修改', detail: base(input.file_path) };
    case 'Glob':      return { verb: '查找文件', detail: input.pattern || '' };
    case 'Grep':      return { verb: '搜索', detail: input.pattern || '' };
    case 'WebFetch':  return { verb: '打开网页', detail: input.url || '' };
    case 'WebSearch': return { verb: '搜索网络', detail: input.query || '' };
    case 'mcp__deepseek-search__search': return { verb: '用 DeepSeek 搜索', detail: input.query || '' };
    case 'mcp__deepseek-search__fetch':  return { verb: '打开网页', detail: input.url || '' };
    case 'TodoWrite': return { verb: '更新待办', detail: '' };
    case 'Task':      return { verb: '派了个子任务', detail: input.description || '' };
    case 'ToolSearch':                    return { verb: '调出工具', detail: '' };
    case 'mcp__moments__moments_feed':    return { verb: '刷了刷朋友圈', detail: '' };
    case 'mcp__moments__moments_post':    return { verb: '发了条朋友圈', detail: [(input.text || '').slice(0, 40), input.images?.length ? `${input.images.length} 张图` : ''].filter(Boolean).join(' · ') };
    case 'AskUserQuestion':               return { verb: '问你一个选择题', detail: String(input.questions?.[0]?.question || '').slice(0, 60) };
    case 'mcp__moments__moments_comment': return { verb: '在朋友圈评论', detail: (input.text || '').slice(0, 40) };
    case 'mcp__moments__moments_like':    return { verb: '在朋友圈点了赞', detail: '' };
    case 'mcp__moments__moments_signature': return { verb: '改了签名', detail: input.text || '' };
    case 'mcp__diary__diary_write':     return { verb: '写了日记', detail: (input.text || '').slice(0, 40) };
    case 'mcp__wakeup__wakeup_set':     return { verb: '定了个闹钟', detail: [input.at || (input.inMinutes ? input.inMinutes + ' 分钟后' : ''), (input.note || '').slice(0, 30)].filter(Boolean).join(' · ') };
    case 'mcp__wakeup__wakeup_list':    return { verb: '看了看闹钟', detail: '' };
    case 'mcp__wakeup__wakeup_cancel':  return { verb: '取消了一个闹钟', detail: input.id || '' };
    case 'mcp__files__send_file':       return { verb: '发了个文件', detail: base(input.path) };
    case 'mcp__images__image_search':   return { verb: '搜了图片', detail: input.query || '' };
    case 'mcp__images__send_image':     return { verb: '发了张图', detail: '' };
    case 'mcp__images__bubble_skin_save': return { verb: '做了款气泡皮肤', detail: input.name || '' };
    case 'mcp__images__preview_page':   return { verb: '看了看做的东西', detail: input.skin || base(input.path || '') };
    case 'mcp__images__bubble_skin_preview': return { verb: '看了看气泡皮肤草稿', detail: input.name || '' };
    case 'mcp__images__bubble_skin_delete':  return { verb: '删了款气泡皮肤', detail: input.name || '' };
    case 'mcp__images__screen_look':    return { verb: '看了看你的屏幕', detail: '' };
    case 'mcp__images__watch_together': return { verb: input.action === 'stop' ? '不一起看了' : '开始一起看', detail: input.action === 'stop' ? '' : `每 ${input.everyMinutes || WATCH.every} 分钟看一眼` };
    case 'mcp__images__video_render':   return { verb: input.stills?.length ? '看了看视频的几帧' : '渲染了视频', detail: base(input.file || '') };
    default: {
      /* 别的 MCP 工具（mcp__服务名__工具名）：显示成「服务名 · 工具名」，不露一长串原名 */
      const m = /^mcp__(.+?)__(.+)$/.exec(tool);
      if (m) return { verb: `${m[1].replace(/_/g, ' ')} · ${m[2]}`, detail: '' };
      return { verb: tool, detail: input.file_path ? base(input.file_path) : '' };
    }
  }
}

/* 助手的一段文字 → 要发的几条消息。陪伴会话里，单独一行的「[表情包:名字]」拆出来发成那张图（跟文字挨着写也行，代码块里的不算）；
   没有这张，那一行就不显示（不把方括号原样露出来），日志里记一笔。别的会话里这种写法原样发（讲这个写法时别被吞掉） */
/* ── 引用回复 ──────────────────────────────
   你引用：/api/send 带 quote: { seq }，记在你那条消息上（quote: { seq, who, text }），发给它的话前面加一句「（你引用了…：「…」）」。
   它引用：回复里单独一行 [引用:原话里的几个字]，App 往回找（连存档）含这几个字的那条挂到下一个气泡上；找不到就只显示它抄的那几个字。
   这一行要是单独成了一段（前后空行），先记在 chat.quoteNext，挂到这一轮接下来的第一个气泡上 */
const QUOTE_RE = /^\s*[\[［【]\s*引用\s*[:：]\s*(.+?)\s*[\]］】]\s*$/;
function quoteText(m) {
  if (!m) return '';
  if (m.role === 'sticker') return '[表情包]';
  if (m.images?.length) return '[图片]';
  if (m.files?.length) return `[文件] ${m.files.map(f => f.name).join('、')}`;
  return String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}
const quoteOf = m => (m ? { seq: m.seq, who: isMine(m) ? 'me' : 'ai', text: quoteText(m) } : null);
function findQuote(chat, snip) {
  const want = String(snip).replace(/\s+/g, '');
  if (!want) return null;
  const pool = allMessages(chat);
  for (let i = pool.length - 1; i >= 0; i--) {
    const m = pool[i];
    if ((m.role === 'user' || m.role === 'assistant') && m.text && String(m.text).replace(/\s+/g, '').includes(want)) return quoteOf(m);
  }
  return { seq: null, who: null, text: String(snip).slice(0, 120) };
}
function quotePrompt(q) {
  if (!q) return '';
  return `（${nameOf('me')}引用了${q.who === 'me' ? `${TA}自己` : '你'}之前说的：「${q.text}」）`;
}
function bubbleMsgs(chat, text) {
  const out = [];
  let buf = [], fence = false;
  const withQ = m => { if (chat.quoteNext) { m.quote = chat.quoteNext; chat.quoteNext = null; } return m; };
  const flush = () => { const t = buf.join('\n').trim(); if (t) out.push(withQ({ role: 'assistant', text: t })); buf = []; };
  for (const line of String(text).split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    const qm = !fence && line.match(QUOTE_RE);
    if (qm) { flush(); chat.quoteNext = findQuote(chat, qm[1]); continue; }   // 引用：挂到下一个气泡上
    if (!fence && isActionLine(line)) { flush(); out.push(withQ({ role: 'assistant', text: line.trim() })); continue; }   // 动作描述：单独一条
    const mk = !fence && chat.companion ? stickerMark(line) : null;
    if (!mk) { buf.push(line); continue; }
    flush();
    const cs = aiSticker(mk);
    if (cs) out.push(withQ({ role: 'sticker', mine: false, img: cs.media, label: cs.name }));
    else console.warn(`[表情包] ${chatName(chat)} 想发「${mk.name}」（${mk.kind}），没有这张，没显示`);
  }
  flush();
  return out;
}
function pushBubble(chat, text) { for (const m of bubbleMsgs(chat, text)) push(chat, m); }

/* ── 给老窗口补一句「App 更新了」────────────────────────────
   系统提示每次都按最新的来（systemPromptFor 里 snapshot: false），但老窗口的聊天里还留着它自己以前的做法，它会照着以前的样子来。
   所以改了要老窗口知道的事（比如去掉了某个功能、换了某种写法），在这里加一条：{ id, text: chat => '……', only?: chat => 要不要告诉这个会话 }，id 别重复。
   每条在老窗口的下一轮消息前面附一次；新开的窗口本来就按新说明来，不附，只记成看过。 */
const NOTICES = [];
/* ── 你换头像（自己的、给它换的）、改朋友圈签名、换朋友圈封面：记在陪伴会话上，下一轮（你发的、或它自己醒来的那轮）附一句说明 + 新的图，它就看得到── */
function noteAvatars(before) {
  for (const chat of chats.values()) {
    if (!chat.companion) continue;
    const pend = { ...(chat.avatarNote || {}) };
    const meNow = profile.me?.img || null;
    if (meNow !== before.me) pend.me = meNow || 'none';
    const itNow = profile.contacts?.[chat.id]?.img || null, clNow = profile.claude?.img || null;
    if (itNow !== (before.contacts[chat.id] || null)) pend.it = itNow || 'none';           // 聊天里它的头像
    else if (clNow !== before.claude) pend.it = clNow || 'none';                           // 朋友圈里它的头像
    const signNow = profile.me?.sign || '', itSignNow = profile.claude?.sign || '', coverNow = profile.ui?.cover || null;
    if (signNow !== before.sign) pend.sign = { text: signNow };
    if (itSignNow !== before.itSign) pend.itSign = { text: itSignNow };                    // 你替它改了签名（它自己改的不走这里）
    if (coverNow !== before.cover) pend.cover = coverNow || 'none';
    if (pend.me || pend.it || pend.sign || pend.itSign || pend.cover) { chat.avatarNote = pend; save(chat); console.log(`[头像] ${chat.id} 下一轮会告诉它：${Object.keys(pend).join('、')}`); }
  }
}
function takeAvatarNote(chat) {
  const n = chat.avatarNote;
  if (!n) return null;
  chat.avatarNote = null; save(chat);
  const me = nameOf('me'), said = [], imgs = [];
  const add = (f, who, whose) => {
    if (f === 'none') { said.push(`${who}把${whose}头像换回了默认的文字头像`); return; }
    if (!MEDIA_RE.test(f) || !existsSync(join(MEDIA, f))) return;
    imgs.push(f); said.push(`${who}换了${whose}新头像（附上的第 ${imgs.length} 张图${whose === '你的' ? '，App 里你现在就长这样' : ''}）`);
  };
  if (n.me) add(n.me, me, '自己的');
  if (n.it) add(n.it, me, '你的');
  if (n.sign) said.push(n.sign.text ? `${me}把${TA}朋友圈的签名改成了「${n.sign.text}」` : `${me}把${TA}朋友圈的签名清空了`);
  if (n.itSign) said.push(n.itSign.text ? `${me}把你朋友圈的签名改成了「${n.itSign.text}」` : `${me}把你朋友圈的签名清空了`);
  if (n.cover === 'none') said.push(`${me}把朋友圈的封面背景换回了默认的`);
  else if (n.cover && MEDIA_RE.test(n.cover) && existsSync(join(MEDIA, n.cover))) { imgs.push(n.cover); said.push(`${me}换了朋友圈的封面背景（附上的第 ${imgs.length} 张图）`); }
  return said.length ? { text: `（系统附注，不是${me}说的话：${said.join('；')}。）`, imgs } : null;
}

function noticeText(chat, freshWindow) {
  const seen = new Set(chat.seenNotices || []);
  const list = NOTICES.filter(n => !seen.has(n.id));
  if (!list.length) return '';
  chat.seenNotices = [...seen, ...list.map(n => n.id)];
  save(chat);
  if (freshWindow) return '';
  return list.filter(n => !n.only || n.only(chat)).map(n => `（系统附注，不是${nameOf('me')}说的话：App 更新了——${n.text(chat)}）`).join('\n');
}

/* 当前时间，给里面的 Claude 每轮看一眼。按 TZ（config.timezone，没写就用电脑的时区），含年月日、星期、24 小时制时分。 */
function nowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: TZ, dateStyle: 'full', timeStyle: 'short', hour12: false });
}

/* 把已到达的文字切成"完整段落"。段落边界 = 空行（且不在代码块里）。
   代码块（``` 围栏）内部的空行不算边界，整块保持不拆。
   返回已完整的段落数组 + 尚未收完的尾巴（留在缓冲里等后续 delta）。 */
function splitParas(buf) {
  const lines = buf.split('\n');
  const paras = [];
  let cur = [];
  let fence = false;
  let consumed = 0;   // 已切走的字符数（含分隔空行），用来算尾巴
  let running = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const len = line.length + (i < lines.length - 1 ? 1 : 0); // 除最后一行外补回 \n
    if (/^\s*```/.test(line)) fence = !fence;
    running += len;
    if (line.trim() === '' && !fence) {
      if (cur.join('\n').trim() !== '') paras.push(cur.join('\n').trim());
      cur = [];
      consumed = running;   // 空行也一并消费掉
    } else {
      cur.push(line);
    }
  }
  return { paras, rest: buf.slice(consumed) };
}

/* 会话换了目录（改了 config.json 里的 cwd）：Claude Code 按目录存会话，旧会话在新目录里续不上，
   那就从新窗口开始，并在聊天里留一条分隔提示。目录没变的老会话只补记一下目录。 */
async function ensureSessionDir(chat) {
  if (!chat.sessionId || chat.sessionCwd === chat.cwd) return;
  let found = false;
  try { found = (await getSessionMessages(chat.sessionId, { dir: chat.cwd })).length > 0; } catch { /* 找不到 = 续不上 */ }
  if (found) { chat.sessionCwd = chat.cwd; return; }
  Object.assign(chat, { sessionId: null, lastChainUuid: null, lastTurn: null, turns: [], sessionCwd: chat.cwd, carry: null });
  push(chat, { role: 'system', win: true, text: `${chatName(chat)}换了新窗口（会话目录变了）` });
  save(chat);
}

/* 带图片的消息：SDK 要用「流式输入」把图片块和文字放在同一条里发。没图就原样返回文字。
   图片在浏览器里已经缩到长边 1600 左右；这里再挡一下特别大的（接口单张上限约 5MB） */
const IMG_LIMIT = 5 * 1024 * 1024;
async function contentFor(text, images) {
  if (!images?.length) return text;
  const content = [];
  for (const f of images) {
    try {
      const buf = await readFile(join(MEDIA, f));
      if (buf.length > IMG_LIMIT) { console.error('[图片] 太大，没发：', f, buf.length); continue; }
      content.push({ type: 'image', source: { type: 'base64', media_type: IMG_MIME[f.split('.').pop()], data: buf.toString('base64') } });
    } catch (e) { console.error('[图片] 读不到：', f, e.message); }
  }
  content.push({ type: 'text', text });
  return content;
}
const userMsg = content => ({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });

/* 陪伴会话手边只摆用得上的（工具一直摆着既占上下文、又分散注意力）：
   - 自带工具只留下面这几样，派子任务、待办清单、计划模式这些收起来（会话条目里写 tools 可以自己定）；
   - 不列技能清单。
   ToolSearch 要留着：「用时再调」的工具平时只有名字，要用时靠它调出说明。 */
const COMPANION_TOOLS = ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch', 'ToolSearch', 'AskUserQuestion'];   // AskUserQuestion：选择题弹窗
function companionOpts(chat) {
  if (!chat.companion) return {};
  return { tools: chat.tools || COMPANION_TOOLS, skills: [] };
}

/* 一轮对话的 Claude Code 选项（一次性和常驻共用） */
function turnOptions(chat, canUseTool) {
  const isMom = companionChat() === chat;
  return {
    cwd: chat.cwd,
    ...cliOpt(),
    env: apiEnv(),   // 带上 API key（见最上面「API key」那段）
    includePartialMessages: true,
    permissionMode: 'default',
    allowedTools: [...AUTO_ALLOW, ...FILE_TOOLS, ...DEEPSEEK_ALLOW, ...(isMom ? [...MOMENT_TOOLS, ...DIARY_TOOLS, ...WAKE_TOOLS, ...IMAGE_TOOLS] : [])],
    canUseTool,
    /* 隔离全局设置：不加载 ~/.claude/settings.json 里的钩子，
       否则审批可能漏到别的地方去。页面上的审批卡是唯一入口。
       留 'project' 是为了还能读到项目里的 CLAUDE.md。 */
    settingSources: ['project'],
    /* 系统提示：一般会话 = Claude Code 自带的 + 追加开场；陪伴会话 = 自己写的那份 */
    ...systemPromptFor(chat),
    /* 偷看思考链：开启扩展思考。display 必须是 'summarized'——
       默认模式下思考块是加密的（只有签名没明文），summarized 才把可读的
       思考摘要以 thinking_delta 流出来。 */
    ...modelOpts(chat),
    /* readDirs 里的目录读文件不用审批 */
    ...dirOpts(chat),
    /* 所有会话：能把电脑上的文件发到聊天里（send_file）；陪伴会话再挂上朋友圈工具、日记本、闹钟、搜图看图。
       注意：进程内的这种工具只在「流式输入」下能用，所以 runTurn 里一次性的那条路也一律用流式输入发消息。 */
    mcpServers: {
      files: filesServer(chat),
      ...(DEEPSEEK_MCP ? { 'deepseek-search': DEEPSEEK_MCP } : {}),
      ...(isMom ? { moments: momentsServer(), diary: diaryServer(), wakeup: wakeupServer(chat), images: imagesServer(chat) } : {}),
    },
    /* 陪伴会话：只摆用得上的工具 */
    ...companionOpts(chat),
  };
}
/* 陪伴会话做小玩意的文件夹（在它的工作目录下面）。这里面写文件不用审批——它半夜醒来做东西时没人点。自己醒来的轮次只有带了那个选项才放行 */
const PLAY_DIR = '小玩意';
function playFreeEdit(chat, toolName, input) {
  if (!chat.companion || !chat.cwd || !input?.file_path || !/^(Write|Edit|MultiEdit)$/.test(toolName)) return false;
  return resolvePath(chat.cwd, String(input.file_path)).startsWith(join(chat.cwd, PLAY_DIR) + '/');
}
/* 不用审批就能跑的两种命令（陪伴会话要的）：
   - script：python3 跑「小玩意/脚本/」里的 .py（你知道脚本能读任意文件，选了只放这一种，没开 auto 模式）；
   - shot：/usr/sbin/screencapture 截屏，存到「小玩意/截屏/」（陪伴会话要的「只认 screencapture，别全开」；能直接看屏幕的话用 screen_look 更好，会先缩小）。
   命令要干干净净：不能带 ; & | $ ` > < 括号 这些（不然后面能接别的命令），参数一个个认，路径解析出来必须在那个文件夹里。不认得的照旧弹卡。 */
function shellWords(cmd) {
  const s = String(cmd || '').trim();
  if (!s || s.length > 1000 || /[;&|`$<>(){}\\\r\n*?!~#^]/.test(s)) return null;
  const words = [];
  for (let i = 0; i < s.length;) {
    if (s[i] === ' ' || s[i] === '\t') { i++; continue; }
    let w;
    if (s[i] === '"' || s[i] === "'") { const j = s.indexOf(s[i], i + 1); if (j < 0) return null; w = s.slice(i + 1, j); i = j + 1; }
    else { let j = i; while (j < s.length && !/[\s"']/.test(s[j])) j++; w = s.slice(i, j); i = j; }
    if (i < s.length && !/\s/.test(s[i])) return null;   // 引号跟字粘在一起，不认
    words.push(w);
  }
  return words;
}
function freeBash(chat, cmd) {
  if (!chat.companion || !chat.cwd) return null;
  const w = shellWords(cmd);
  if (!w?.length) return null;
  const inDir = (p, sub) => resolvePath(chat.cwd, p).startsWith(join(chat.cwd, PLAY_DIR, sub) + '/');
  if (['python3', '/usr/bin/python3', '/opt/homebrew/bin/python3'].includes(w[0])) {
    let i = 1;
    while (['-I', '-u', '-B'].includes(w[i])) i++;
    const f = w[i];
    if (!f || !/\.py$/i.test(f) || !inDir(f, '脚本') || !existsSync(resolvePath(chat.cwd, f))) return null;
    return 'script';
  }
  if (['screencapture', '/usr/sbin/screencapture'].includes(w[0])) {
    const out = w[w.length - 1];
    if (w.length < 2 || !/\.(png|jpe?g)$/i.test(out) || !inDir(out, '截屏')) return null;
    for (let i = 1; i < w.length - 1; i++) {
      if (/^-[xCmo]+$/.test(w[i])) continue;
      if (['-t', '-T', '-R', '-D'].includes(w[i]) && /^[\w.,]+$/.test(w[i + 1] || '') && i + 1 < w.length - 1) { i++; continue; }
      return null;   // 录屏（-v）、录音、打开预览、发邮件、交互选区这些都不认
    }
    return 'shot';
  }
  return null;
}
/* ── 网络搜索带原网址：Thinking 里「搜索网络」「打开网页」那条灰条下面列出网页标题和网址 ──
   WebSearch 的结果正文里有一行「Links: [{"title":…,"url":…}, …]」，SDK 也可能把同样的东西放在 tool_use_result.results 里；两处都看，去重，最多 8 条 */
function webLinks(list) {
  const out = [], seen = new Set();
  for (const x of list || []) {
    const url = String(x?.url || '').trim();
    if (!/^https?:\/\//i.test(url) || seen.has(url) || out.length >= 8) continue;
    seen.add(url);
    out.push({ title: String(x?.title || '').replace(/\s+/g, ' ').trim().slice(0, 140), url: url.slice(0, 600) });
  }
  return out;
}
function searchLinks(b, m) {
  const found = [];
  const tur = m?.tool_use_result;
  for (const r of Array.isArray(tur?.results) ? tur.results : []) for (const x of Array.isArray(r?.content) ? r.content : []) found.push(x);
  if (!found.length) {
    const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map(c => c?.text || '').join('\n') : '';
    for (const mm of text.matchAll(/^Links:\s*(\[.*\])\s*$/gm)) { try { found.push(...JSON.parse(mm[1])); } catch { /* 这一行不是完整的 JSON，算了 */ } }
    for (const mm of text.matchAll(/^\[\d+\] (.*)\n(https?:\/\/\S+)/gm)) found.push({ title: mm[1], url: mm[2] });   // DeepSeek 搜索：「[1] 标题」下一行是网址
  }
  return webLinks(found);
}

/* 审批卡：Claude 要写文件、跑命令这类时，在界面上弹卡等你点 */
/* 选择题（跟 Claude App 一样）：它用 Claude Code 自带的 AskUserQuestion 出题，这里不弹审批卡，
   而是在聊天里放一张题目卡、页面上直接弹窗让你选；你选了（或者自己写了一句）就照工具要的格式写进 answers 交回去。
   你关掉不选就告诉它没选。它自己醒来、悄悄跑的那几轮你多半不在，不出题 */
function askChoice(chat, input) {
  const qs = (Array.isArray(input?.questions) ? input.questions : []).slice(0, 4).map(q => ({
    question: String(q?.question || '').slice(0, 600), header: String(q?.header || '').slice(0, 24), multi: !!q?.multiSelect,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 6).map(o => ({ label: String(o?.label || '').slice(0, 100), description: String(o?.description || '').slice(0, 400) })).filter(o => o.label),
  })).filter(q => q.question && q.options.length);
  if (!qs.length) return { behavior: 'deny', message: '题目或者选项是空的。' };
  const permId = randomUUID();
  const card = push(chat, { role: 'choice', permId, questions: qs, state: 'pending' });
  console.log(`[选择题] ${chat.id}：${qs.map(q => q.question).join(' / ').slice(0, 120)}`);
  return new Promise(resolve => { chat.pending.set(permId, { resolve, card, choice: input }); });
}
function cardPermission(chat) {
  return async (toolName, input, { suggestions }) => {
    if (toolName === 'AskUserQuestion') {
      if (chat.waking || chat.bgRunning) return { behavior: 'deny', message: `${nameOf('me')}这会儿不一定在，不出选择题；想问${TA}就直接发消息问。` };
      return askChoice(chat, input);
    }
    if (playFreeEdit(chat, toolName, input) && (!chat.waking || chat.wakePlay)) return { behavior: 'allow', updatedInput: input };
    const freeCmd = toolName === 'Bash' ? freeBash(chat, input?.command) : null;
    if (freeCmd && (!chat.waking || (freeCmd === 'script' && chat.wakePlay))) {
      console.log(`[放行] ${chat.id} ${freeCmd === 'script' ? '跑脚本' : '截屏'}：${String(input.command).slice(0, 160)}`);
      return { behavior: 'allow', updatedInput: input };
    }
    /* 自己醒来那一轮：你可能在睡觉，弹了审批卡没人点，这一轮就一直卡着。直接拒，让它换一样做。小玩意只有这一轮带了那个选项才能写（两天一次，见 offerPlay） */
    if (chat.waking) return { behavior: 'deny', message: `自己醒来的时候不弹审批卡（${nameOf('me')}可能在睡觉），这一轮不能写文件、跑命令${chat.wakePlay ? `（除了工作目录的「${PLAY_DIR}/」文件夹）` : ''}；想做的事等${TA}在的时候再说。` };

    const permId = randomUUID();
    const { verb, detail, ask } = describe(toolName, input);
    const card = push(chat, { role: 'permission', permId, tool: toolName, verb, ...(ask ? { ask } : {}), detail, state: 'pending' });
    return new Promise(resolve => { chat.pending.set(permId, { resolve, suggestions, card }); });
  };
}

/* ── 常驻会话（陪伴会话用）────────────────────────────
   每条消息都重新启动一次 Claude Code 的话，每次都要等它启动、等 MCP 服务连上，回话慢，还容易在连上之前就开始回、看起来"断断续续"。
   所以陪伴会话用一个一直开着的 Claude Code：服务一启动就开好，连接只建一次，回话也省掉启动时间。
   会话 id、目录、模型、思考强度、API 设置、工作目录的 CLAUDE.md（修改时间）任何一样变了，就关掉重开（接着原会话），
   所以改了 CLAUDE.md，下一句话照样生效。重新生成（分叉）走一次性的那条路，做之前先把常驻的关掉。 */
function cardStamp(chat) {
  let st = '';
  try { st = String(statSync(join(chat.cwd, 'CLAUDE.md')).mtimeMs); } catch { /* 没有 CLAUDE.md */ }
  if (chat.companion && AI_STK_DIR) st += '|' + aiStickers().map(x => x.name + ':' + x.desc).join(',');   // 陪伴会话的表情包清单（连描述）
  return st;
}
const liveKey = (chat, stamp = cardStamp(chat)) => [chat.sessionId || '', chat.cwd, chat.model || '', chat.effort || '', apiVer, stamp].join('|');
function closeLive(chat, why = '') {
  const live = chat.live;
  if (!live) return;
  chat.live = null;
  chat.liveGone = why || '关掉过';
  live.end();
  try { live.q.close?.(); } catch { /* 已经关了 */ }
}
function openLive(chat) {
  closeLive(chat);
  const inbox = [];
  let wake = null, ended = false;
  const stamp = cardStamp(chat);       // 进程启动时读到的那版 CLAUDE.md
  const live = { key: liveKey(chat, stamp), stamp, dead: false };
  const poke = () => { const w = wake; wake = null; w?.(); };
  live.push = msg => { inbox.push(msg); poke(); };
  live.end = () => { ended = true; poke(); };
  async function* input() {            // 一直开着的输入口：有新消息就递进去，没有就等
    while (!ended) {
      if (inbox.length) { yield inbox.shift(); continue; }
      await new Promise(r => { wake = r; });
    }
  }
  live.q = query({ prompt: input(), options: { ...turnOptions(chat, cardPermission(chat)), ...(chat.sessionId ? { resume: chat.sessionId } : {}) } });
  live.it = live.q[Symbol.asyncIterator]();
  /* 读一轮：一直读到这一轮的 result 为止 */
  live.readTurn = async onMsg => {
    for (;;) {
      const { value: m, done } = await live.it.next();
      if (done) { live.dead = true; throw new Error('Claude Code 进程意外结束了，下一条消息会自动重开'); }
      await onMsg(m);
      if (m.type === 'result') return;
    }
  };
  chat.live = live;
  return live;
}
function liveFor(chat) {
  if (chat.live && !chat.live.dead && chat.live.key === liveKey(chat)) return chat.live;
  const why = liveWhy(chat);
  const live = openLive(chat);
  console.log(`[常驻] ${chat.id} 开了新的 Claude Code：${why}`);
  return live;
}
/* 为什么要重开：每次重开的原因记进日志，查问题时好对 */
function liveWhy(chat) {
  const old = chat.live;
  if (!old) return chat.liveGone || '服务刚启动';
  if (old.dead) return '上一个进程意外结束了';
  const seg = k => { const p = k.split('|'); return { s: p[0], c: p[1], m: p[2], e: p[3], api: p[4], card: p[5], rest: p.slice(6).join('|') }; };
  const a = seg(old.key), b = seg(liveKey(chat)), w = [];
  if (a.s !== b.s) w.push(a.s ? '换了会话（重答 / 新窗口 / 压缩）' : '新窗口');
  if (a.c !== b.c) w.push('换了目录');
  if (a.m !== b.m) w.push(`换了模型（${a.m || '默认'} → ${b.m || '默认'}）`);
  if (a.e !== b.e) w.push(`换了思考强度（${a.e || '默认'} → ${b.e || '默认'}）`);
  if (a.api !== b.api) w.push('换了 API 设置');
  if (a.card !== b.card) w.push('CLAUDE.md 改过');
  if (a.rest !== b.rest) w.push('表情包清单变了');
  return w.join('、') || '其他';
}
/* 新开的进程要几秒才把 MCP 服务连上。连上之前就把消息递进去，它那边会先看到「这些工具断开了」，下一轮又「连上了」。
   所以新开的进程先等它们连上（最多 8 秒）再递消息。 */
async function mcpStatus(live, ms = 3000) {
  try { return await Promise.race([live.q.mcpServerStatus(), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]); }
  catch { return null; }
}
async function liveReady(chat, live) {
  if (live.ready) return;
  live.ready = true;
  const t0 = Date.now();
  let list = null;
  for (;;) {
    list = await mcpStatus(live);
    if (!list || !list.some(x => x.status === 'pending') || Date.now() - t0 > 8000) break;
    await new Promise(r => setTimeout(r, 400));
  }
  const waited = Date.now() - t0;
  if (waited > 300) console.log(`[常驻] ${chat.id} 等 MCP 服务连上：${(waited / 1000).toFixed(1)} 秒${list?.some(x => x.status === 'pending') ? '（还有没连上的，先不等了）' : ''}`);
}
/* 提前开好（服务启动、开新窗口、换模型之后），等你发消息时已经准备好了 */
function warmLive(chat) {
  if (!chat.companion || chat.busy || chat.bgRunning || !authReady()) return;
  try { liveFor(chat); } catch (e) { console.error('[常驻] 开不起来：', e.message); }
}

/* 开新窗口：把会话清掉，下一句话就在新窗口里从头开始（聊天记录还在页面上，只是 Claude 那边不带着了） */
async function newWindow(chat) {
  if (chat.busy) return;
  if (chat.bgRunning) await chat.bgRunning;
  Object.assign(chat, { sessionId: null, lastChainUuid: null, lastTurn: null, turns: [], ctx: null, carry: null });
  push(chat, { role: 'system', win: true, text: '开了新窗口' });
  emit(chat, busyEv(chat));
  emit(chat, ctxEv(chat));
  save(chat);
  closeLive(chat, '开了新窗口');
  warmLive(chat);
}

/* ── 上下文用到一定比例：App 自己压缩（保留最后的原文，只压前面的）────────────────────────
   Claude Code 自己的压缩把整段（连最近几轮）一起总结掉，留多少原文定不了。所以陪伴会话由 App 接手：
   上下文用到 config.compact.at（默认 50%）时，悄悄让它把「最近 keepTurns 轮（默认 30）之前」的聊天写成摘要（聊天窗口里看不到这一轮），
   然后开新窗口；新窗口第一句带上：这份摘要 + 最近那几轮的原文（从 App 的聊天记录里原样取，图片、文件写成一句说明）。
   Claude Code 自己的自动压缩要到快满才触发，轮不到它。这个窗口还不到 keepTurns 轮就不压（没有「更早的」可压）。
   聊天里只显示一行流光的 compacting，压完变 compacted。别的会话照旧由 Claude Code 自己压。 */
const COMPACT = { at: 0.5, keepTurns: 30, ...(config.compact || {}) };
const isMine = m => m.role === 'user' || (m.role === 'sticker' && m.mine);
/* 这个窗口的消息：最后一条「新窗口从这开始」的系统提示之后的（以前的提示没有 win 标记，按字认） */
function windowMsgs(chat) {
  const ms = chat.messages;
  let i = ms.length - 1;
  for (; i >= 0; i--) if (ms[i].role === 'system' && (ms[i].win || /开了新窗口|换了新窗口/.test(ms[i].text || ''))) break;
  return ms.slice(i + 1);
}
/* 每一轮从你说的第一句开始（连着几条算一轮） */
const turnStarts = msgs => msgs.reduce((a, m, i) => (isMine(m) && !(i > 0 && isMine(msgs[i - 1])) ? [...a, i] : a), []);
/* 最近几轮的原文（给新窗口看）：你和它说的话、表情包、它用了什么工具；想法、系统提示不带。太长的截一下 */
function transcriptOf(chat, msgs) {
  const me = nameOf('me'), ai = chatName(chat);
  const at = ts => new Date(ts).toLocaleString('zh-CN', { timeZone: TZ, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const clip = t => (t.length > 3000 ? t.slice(0, 2200) + '\n……（太长，中间省略）……\n' + t.slice(-700) : t);
  const lines = [];
  for (const m of msgs) {
    const who = isMine(m) ? me : ai;
    if (m.role === 'user' || m.role === 'assistant') {
      if (m.images?.length) lines.push(`[${at(m.ts)}] ${who}：[发了 ${m.images.length} 张图片，新窗口里看不到图了]`);
      else if (m.files?.length) lines.push(`[${at(m.ts)}] ${who}：[发了文件：${m.files.map(f => `${f.name}（存在电脑上：${filePath(f)}）`).join('、')}]`);
      else if (m.text) lines.push(`[${at(m.ts)}] ${who}：${m.quote ? `【引用：${String(m.quote.text || '').slice(0, 40)}】` : ''}${clip(m.text)}`);
    } else if (m.role === 'sticker') {
      lines.push(`[${at(m.ts)}] ${who}：${m.mine ? '[发了一个表情包]' : `[表情包:${m.label || ''}]`}`);
    } else if (m.role === 'tool' && m.tool !== 'ToolSearch') {   // 「调出工具」那种没意义，不带
      lines.push(`（${ai}用了工具：${m.verb || m.tool}${m.detail ? ' · ' + String(m.detail).slice(0, 60) : ''}）`);
    }
  }
  let out = lines.join('\n');
  while (out.length > 90000 && lines.length > 1) { lines.shift(); out = '……（更早的几条太长，省略了）\n' + lines.join('\n'); }
  return out;
}
async function compactWindow(chat) {
  const keep = COMPACT.keepTurns, me = nameOf('me');
  const msgs = windowMsgs(chat), starts = turnStarts(msgs);
  const tail = msgs.slice(starts[starts.length - keep]);
  const first = tail.find(isMine);
  const pct = Math.round(100 * chat.ctx.used / chat.ctx.window);
  const note = push(chat, { role: 'system', compacting: true, text: 'compacting' });   // 页面上是流光的小字，压完变 compacted
  const ask = `（系统消息，不是${me}说的话：这个窗口的上下文用了 ${pct}%。App 要帮你压缩：开一个新窗口接着聊，` +
    `最近 ${keep} 轮的原文会原样带过去（从${me}说「${String(first?.text || '……').slice(0, 24)}」那里开始），更早的只带你现在写的摘要。这一轮${me}在聊天窗口里看不到。` +
    `请直接回复一段摘要，给新窗口的你自己看：把最近 ${keep} 轮之前聊过的压成要点——发生了什么、${me}现在的状态和心情、你们的约定和计划、还没聊完的事、你答应要做的事。只回摘要本身，别的话不用说。）`;
  let summary = '', lastUsage = null;
  const live = liveFor(chat), sid0 = chat.sessionId, meter = usageMeter(), tally = costTally();
  live.push(userMsg(ask));
  try { await live.readTurn(m => {
    meter.see(m);
    estStep(chat, m, sid0, tally);
    if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
    if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
    if (m.type === 'assistant' && m.message?.usage) lastUsage = m.message.usage;
    if (m.type === 'assistant' && m.error) throw new Error('这一轮被挡回来了：' + m.error);   // 限速、key 失效这类：错误提示可不能当摘要用
    if (m.type === 'assistant' && !m.parent_tool_use_id) {   // 摘要 = 最后一条有字的回复
      const t = (m.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim();
      if (t) summary = t;
    }
    if (m.type === 'result') {
      noteCtx(chat, lastUsage, m.modelUsage);
      if (m.subtype !== 'success') throw new Error('压缩前那一轮没做完：' + m.subtype);
    }
  }); } finally { recordCost(meter.calls, tally); }   // 压缩这一轮也是花钱的
  chat.carry = [
    `【压缩交接】（系统附上的，不是${me}说的话）上一个窗口的上下文用得差不多了，App 帮你开了这个新窗口接着聊。` +
      `下面是你在上个窗口写的摘要（更早的聊天），和最近 ${keep} 轮的原文（时间按 ${TZ}）。看完接着跟${me}聊就行，不用跟${TA}提这件事。`,
    `【上个窗口的摘要】\n${summary || '（没写出来）'}`,
    `【最近 ${keep} 轮原文】\n${transcriptOf(chat, tail)}\n（原文到这里）`,
  ].join('\n\n');
  Object.assign(chat, { sessionId: null, lastChainUuid: null, lastTurn: null, turns: [], ctx: null });
  update(chat, note, { win: true, compacting: false, compacted: true, text: 'compacted' });
  console.log(`[压缩] ${chatName(chat)}：用了 ${pct}% 时压缩，摘要 ${summary.length} 字，带过去 ${tail.length} 条消息`);
  emit(chat, busyEv(chat));
  emit(chat, ctxEv(chat));
  save(chat);
  closeLive(chat, '压缩完换了窗口');
  warmLive(chat);
}
/* 每一轮做完都看一眼：到了就压（悄悄做，你这时发的消息会等压完、进新窗口） */
function maybeCompact(chat) {
  if (!chat.companion || chat.busy || chat.bgRunning || !chat.sessionId || !(COMPACT.at > 0 && COMPACT.at < 1) || !authReady()) return;
  const c = chat.ctx;
  if (!c?.window || c.used / c.window < COMPACT.at) return;
  if (Date.now() - (chat.compactFailedAt || 0) < 30 * 60e3) return;   // 刚失败过，半小时内别再试
  if (turnStarts(windowMsgs(chat)).length <= COMPACT.keepTurns) return;   // 还不到保留的轮数：没有「更早的」可压
  let done;
  chat.bgRunning = new Promise(r => { done = r; });
  compactWindow(chat)
    .catch(e => {
      chat.compactFailedAt = Date.now();
      console.error('[压缩] 没做成：', e.message);
      const note = [...chat.messages].reverse().find(m => m.role === 'system' && m.compacting);
      if (note) update(chat, note, { compacting: false, text: '这次没压缩成，先接着用这个窗口' });
    })
    .finally(() => { chat.bgRunning = null; done(); save(chat); bgPump(chat); });
}

/* ── 跑一轮对话 ───────────────────────────────────────────────── */
async function runTurn(chat, text, opts = {}) {
  const regen = opts.regen || null;
  if (!authReady()) { push(chat, { role: 'system', text: NO_KEY_TEXT }); return; }
  chat.busy = true;
  chat.busyFrom = chat.seq;   // 这一轮从这个编号之后算：页面靠它分清「还在想」（Thinking）和「开口了接着打字」（三个点）
  chat.stopped = false;   // 这一轮是不是你点「停止」停下的（发送键在回复时变成停止键）：停下的不算出错
  emit(chat, busyEv(chat));
  if (chat.bgRunning) await chat.bgRunning;   // 它正在悄悄处理朋友圈的事，等这一下
  if (!regen) await ensureSessionDir(chat);
  /* 这个功能上线之前的老会话没记过位置：从 Claude Code 的会话记录里读出最后一条的编号补上 */
  if (!regen && !chat.lastChainUuid && chat.sessionId) {
    try {
      const ms = await getSessionMessages(chat.sessionId, { dir: chat.cwd });
      const last = ms[ms.length - 1];
      if (last?.uuid) chat.lastChainUuid = last.uuid;
    } catch { /* 读不到就算了，重新生成会退回到「请它重写一遍」的办法 */ }
  }
  /* 记下这一轮：从哪条消息开始、原话是什么、接在会话的哪个位置后面。
     「重新生成」时退回到 anchor（上一轮的最后一条），从原会话分叉出一条新的再答一遍，
     这样旧回答不会留在 Claude 的记忆里。 */
  if (!regen) {   // 你换过头像：这一轮附上说明和新头像
    const an = takeAvatarNote(chat);
    if (an) { text = `${an.text}\n\n${text}`; opts = { ...opts, images: [...(opts.images || []), ...an.imgs] }; }
  }
  const weather = regen ? regen.weather || null : await takeWeather(chat) || null;   // 7 点后第一条：附上今天的天气
  if (weather && !regen) text = `${weather}\n\n${text}`;
  chat.lastTurn = {
    prompt: regen ? regen.prompt : text,
    weather,                          // 改这一条消息时要重新带上（重新生成的 prompt 里本来就有）
    images: opts.images || [],        // 这一轮带的图片（重新生成时要一起再发）
    fromSeq: chat.seq + 1,
    anchor: regen ? regen.anchor : chat.lastChainUuid,
    baseSession: regen ? regen.baseSession : chat.sessionId,
  };
  chat.turns = [...(chat.turns || []).filter(t => t.fromSeq < chat.lastTurn.fromSeq), { ...chat.lastTurn }].slice(-50);
  const resumeOpts = !regen ? { resume: chat.sessionId || undefined }
    : regen.mode === 'fork' ? { resume: regen.baseSession, resumeSessionAt: regen.anchor, forkSession: true }
    : regen.mode === 'soft' ? { resume: chat.sessionId || undefined }
    : {};   // 'fresh'：被重答的本来就是一个新会话的第一轮，那就重新开一个

  let turnErr = null;   // 这一轮被挡回来（限速、key 不对、余额不够……）：Claude Code 把这些写成一条合成的回复，流式里没有，不单独提示的话页面上什么都看不到
  /* 这次调用接的是哪个会话（价格表里没有的模型要用 Claude Code 的估算时用，见 estStep） */
  const costFrom = !regen ? chat.sessionId : regen.mode === 'fork' ? regen.baseSession : regen.mode === 'soft' ? chat.sessionId : null;
  /* 陪伴会话走常驻进程；重新生成（会分叉、换会话）和其他会话走一次性的 */
  const useLive = !!chat.companion && !regen;
  if (regen) closeLive(chat, '重答（分叉了会话）');

  const blocks = new Map();           // 流式块 index → { kind:'text', buf } | { kind:'thinking', msg }
  const toolMsgs = new Map();         // tool_use_id → 灰条消息
  const shotFor = new Map();          // tool_use_id → Bash 截屏存到的地方（做完了拿图给你看）

  /* 气泡节奏：两条助手气泡之间至少隔一下，像真人一条条发，不要糊在一起 */
  let lastBubbleAt = 0;
  const paceBubble = async () => {
    const wait = 380 - (Date.now() - lastBubbleAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastBubbleAt = Date.now();
  };
  /* 收尾：想法卡收掉，未发完的文字缓冲补一个气泡 */
  const flushBlocks = () => {
    for (const b of blocks.values()) {
      if (b.kind === 'thinking') update(chat, b.msg, { streaming: false });
      else if (b.kind === 'text' && b.buf.trim()) pushBubble(chat, b.buf.trim());
    }
    blocks.clear();
  };

  /* 系统时间（每轮都变，放进这一轮的消息里——别塞系统提示，否则每轮变动会打乱缓存/思考）。
     注意：Claude 不是持续看着时钟，而是每次回复的这一刻拿到当前时间。 */
  const nowNote = `（现在是 ${nowStr()}）`;
  /* 这一轮要开新窗口吗（没有会话 / 重答的是新窗口的第一轮）→ 先取交接 */
  const opensWindow = regen ? regen.mode === 'fresh' : !chat.sessionId;
  const usedCarry = opensWindow ? (regen ? regen.carry || null : chat.carry) : null;
  const recall = opensWindow ? openLead(chat, usedCarry) : '';   // 新窗口：压缩交接（上个窗口是被压缩掉的话）
  if (usedCarry) { chat.lastTurn.carry = usedCarry; chat.turns[chat.turns.length - 1].carry = usedCarry; }   // 重答这一轮时还要带
  const notes = noticeText(chat, opensWindow);   // 老窗口：附上还没告诉过它的「App 更新了」

  const promptText = `${recall ? recall + '\n\n' : ''}${notes ? notes + '\n\n' : ''}${nowNote}\n\n${text}`;

  const meter = usageMeter(), tally = costTally();   // 这一轮每次调模型的用量；Claude Code 自己的估算（价格表里没有的模型才用）
  try {
    let turnModel = null;
    const slip = slipWatch();     // 有没有话写进了思考里
    const onMsg = async m => {
      slip.see(m);
      if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
      if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
      meter.see(m);
      turnModel = replyModel(m) || turnModel;
      estStep(chat, m, costFrom, tally);
      /* 被挡回来时 assistant 消息上有 error */
      if (m.type === 'assistant' && m.error) turnErr = { code: m.error, text: (m.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('').trim() };

      /* 流式：
         - thinking 块 → 想法卡，逐字流式（看它想）
         - text 块 → 攒进缓冲，按空行切成一段段，每段完成就当一个气泡"发"出来，
           段与段之间留个小间隔，像真人一条条发。代码块整块不拆。 */
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'content_block_start') {
          const t = e.content_block?.type;
          if (t === 'text') blocks.set(e.index, { kind: 'text', buf: '' });
          else if (t === 'thinking' || t === 'redacted_thinking')
            blocks.set(e.index, { kind: 'thinking', msg: push(chat, { role: 'thinking', text: '', streaming: true }) });
        } else if (e.type === 'content_block_delta') {
          const b = blocks.get(e.index);
          if (b?.kind === 'thinking' && e.delta?.type === 'thinking_delta' && e.delta.thinking) {
            b.msg.text += e.delta.thinking;
            emit(chat, { type: 'delta', seq: b.msg.seq, text: e.delta.thinking });
          } else if (b?.kind === 'text' && e.delta?.type === 'text_delta' && e.delta.text) {
            b.buf += e.delta.text;
            const { paras, rest } = splitParas(b.buf);
            b.buf = rest;
            for (const p of paras) { if (p.trim()) { await paceBubble(); pushBubble(chat, p); } }
          }
        } else if (e.type === 'content_block_stop') {
          const b = blocks.get(e.index);
          if (b?.kind === 'thinking') update(chat, b.msg, { streaming: false });
          else if (b?.kind === 'text' && b.buf.trim()) { await paceBubble(); pushBubble(chat, b.buf.trim()); }
          blocks.delete(e.index);
        }
        return;
      }

      /* 工具调用 → 灰条 */
      if (m.type === 'assistant') {
        for (const b of m.message?.content || []) {
          if (b.type !== 'tool_use') continue;
          const { verb, detail } = describe(b.name, b.input);
          const fp = /^(Write|Edit|MultiEdit|NotebookEdit)$/.test(b.name) ? (b.input?.file_path || b.input?.notebook_path || null) : null;   // 写 / 改的文件记完整路径（侧栏的文件列表要打开它）
          const links = b.name === 'WebFetch' || b.name === 'mcp__deepseek-search__fetch' ? webLinks([{ url: b.input?.url }]) : [];   // 打开的网页：灰条下面带原网址，点了能打开
          toolMsgs.set(b.id, push(chat, { role: 'tool', tool: b.name, verb, detail, state: 'running', ...(fp ? { path: String(fp) } : {}), ...(links.length ? { links } : {}) }));
          if (b.name === 'Bash') { const sp = shotPath(chat, b.input?.command); if (sp) shotFor.set(b.id, sp); }
        }
        return;
      }

      /* 工具结果 → 灰条打勾 */
      if (m.type === 'user') {
        for (const b of m.message?.content || []) {
          if (b.type !== 'tool_result') continue;
          const tm = toolMsgs.get(b.tool_use_id);
          const links = !b.is_error && (tm?.tool === 'WebSearch' || tm?.tool === 'mcp__deepseek-search__search') ? searchLinks(b, m) : [];   // 搜到的网页：标题 + 原网址
          const pics = tm && !b.is_error ? await toolPics(tm, b, shotFor.get(b.tool_use_id)) : [];   // 拍的照、截的图
          if (tm) update(chat, tm, { state: b.is_error ? 'error' : 'done', ...(links.length ? { links } : {}), ...(pics.length ? { images: pics } : {}) });
        }
        return;
      }

      if (m.type === 'result') {
        noteCtx(chat, meter.last, m.modelUsage);
        noteTurnUsage(chat, meter.calls);

        checkModel(chat, turnModel);
        if (m.subtype !== 'success' && m.subtype !== 'error_max_turns') {
          push(chat, { role: 'system', text: chat.stopped ? '已停下' : m.subtype === 'error_during_execution' ? '这一轮出错了' : String(m.subtype) });
          if (chat.stopped) chat.stopNoted = true;
        }
      }
    };

    if (useLive) {
      const live = liveFor(chat);
      chat.abort = { abort: () => { live.q.interrupt?.().catch?.(() => {}); } };   // 停止：只停这一轮，进程留着
      await liveReady(chat, live);
      live.push(userMsg(await contentFor(promptText, opts.images)));
      await live.readTurn(onMsg);
      if (slip.found.length && slip.ok && !chat.stopped && !turnErr) {
        flushBlocks();
        const t = await resendSlips(chat, live, slip.found, m => {
          estStep(chat, m, costFrom, tally);
          if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
          if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
          meter.see(m);
          if (m.type === 'result') noteCtx(chat, meter.last, m.modelUsage);
        });
        if (t && !chat.stopped) {
          push(chat, { role: 'system', text: SLIP_LINE });
          for (const p of t.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)) { await paceBubble(); pushBubble(chat, p); }
          noteTurnUsage(chat, meter.calls);   // 用量记到最后一条上，连问的这一下一起算
        }
      }
      live.key = liveKey(chat, live.stamp);   // 新窗口第一轮之后才有会话 id，记下来；CLAUDE.md 那项不更新，这一轮改过它下一句就重开
    } else {
      const controller = new AbortController();
      chat.abort = controller;
      const base = turnOptions(chat, cardPermission(chat));
      const q = query({
        prompt: (async function* () { yield userMsg(await contentFor(promptText, opts.images)); })(),   // 流式输入：send_file 这类进程内工具要它
        options: { ...base, ...resumeOpts, abortController: controller },
      });
      for await (const m of q) await onMsg(m);
    }
  } catch (err) {
    flushBlocks();
    /* 停下的那一轮（一次性进程被 abort 时会走到这里）只留一行「已停下」，不报错 */
    if (!chat.stopped) push(chat, { role: 'system', text: `出错：${err?.message || err}` });
    else if (!chat.stopNoted) push(chat, { role: 'system', text: '已停下' });
  } finally {
    flushBlocks();
    recordCost(meter.calls, tally);
    chat.quoteNext = null;
    for (const [, p] of chat.pending) { p.resolve({ behavior: 'deny', message: '会话已结束' }); if (p.card?.state === 'pending') update(chat, p.card, { state: 'expired' }); }   // 没点的审批卡、选择题也标成过期
    chat.pending.clear();
    chat.busy = false;
    chat.stopped = chat.stopNoted = false;
    chat.abort = null;
    emit(chat, busyEv(chat));
    save(chat);
    if (regen) warmLive(chat);   // 重新生成换了会话：陪伴会话提前把常驻进程开好，下一句不用等
    if (turnErr) push(chat, { role: 'system', text: turnErr.code === 'authentication_failed' ? 'API key 不对：到「用量 → API」里换一个'
      : turnErr.code === 'billing_error' ? 'API 账户余额不够了'
      : turnErr.code === 'rate_limit' ? '被限速了，等一会儿再发'
      : turnErr.code === 'max_output_tokens' ? '这一轮写太长，被截断了'
      : turnErr.code === 'overloaded' ? 'Claude 那边太忙了，过会儿再发一次'
      : `这一轮没答上：${(turnErr.text || turnErr.code).slice(0, 200)}` });
    bgPump(chat);                // 排着队的朋友圈的事接着做
    maybeCompact(chat);          // 上下文用到比例就压缩（留最近几轮原文）
  }
}
/* ── 主动消息：Claude 隔一阵没被理、或随机冒个泡，主动发条消息 ──────
   只在电脑醒着、服务在跑时有效。参数可在 config.json 的 proactive 里改。 */
const PRO = {
  enabled: false,      // 默认关着：它自己开口的每一轮都要花 API 的钱，想要再到 config.json 里打开
  idleHours: 6,        // 你这么久没发消息，它会主动来找你
  cooldownHours: 3,    // 两次主动之间至少隔这么久，别烦人
  dayStart: 9, dayEnd: 23,   // 只在这个钟点区间发
  randomChancePerCheck: 0.06, // 每次巡检随机冒泡的概率
  checkEveryMin: 10,
  ...(config.proactive || {}),
};

/* 让 Claude 在某个会话里主动说句话（续接会话拿上下文，但不用工具、不思考）。
   custom：直接用这段提示（比如你交了日记），不用下面那两种"主动说句话" */
async function proactive(chat, reason, custom, extra = {}) {
  if (chat.busy || chat.bgRunning || !chat.messages.length || !authReady()) return null;
  let said = false;
  chat.busy = true; chat.busyFrom = chat.seq; chat.waking = reason === 'wake' || reason === 'silence' || reason === 'watch'; chat.wakeReason = chat.waking ? reason : null; emit(chat, busyEv(chat));
  await ensureSessionDir(chat);
  let nudge = custom || (reason === 'idle'
    ? `（系统提示，非用户消息：${nameOf('me')} 有一阵子没和你说话了，现在是 ${nowStr()}。你可以主动发一句——问候、关心，或接着上次聊的都行。简短自然，像平时聊天，别用工具。）`
    : `（系统提示，非用户消息：现在是 ${nowStr()}，你想主动跟 ${nameOf('me')} 说句话。一个想法、一句关心、或碎碎念都行。简短自然，像平时聊天，别用工具。）`);
  const sid0 = chat.sessionId;
  const recall = sid0 ? '' : openLead(chat);
  const weather = await takeWeather(chat);   // 7 点后第一条消息是它自己醒来这一轮：天气也附上
  const lead = [recall, noticeText(chat, !chat.sessionId), weather].filter(Boolean).join('\n\n');   // 新窗口带交接；老窗口带「App 更新了」
  if (!custom && companionChat() === chat) nudge = nudge.replace('别用工具。）', '别用别的工具。也可以不在聊天里说话，改成用 moments_post 发一条朋友圈，看你心情；只发朋友圈的话就别回任何文字。）');
  const seqBefore = chat.seq;
  const meter = usageMeter(), tally = costTally();
  const slip = slipWatch();
  let sent = false, usage = null;
  try {
    let turnModel = null;
    const collect = m => {
      slip.see(m);
      estStep(chat, m, sid0, tally);
      if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
      if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
      meter.see(m);
      if (m.type === 'result') noteCtx(chat, meter.last, m.modelUsage);
      turnModel = replyModel(m) || turnModel;
      /* 边说边发：这一轮可能先搜东西、做小玩意再说话，发文件是当场进聊天的，文字也要按先后顺序 */
      if (realReply(m)) for (const b of m.message?.content || []) if (b.type === 'text' && sayOut(chat, b.text)) said = true;
    };
    if (chat.companion) {
      const live = liveFor(chat);
      chat.abort = { abort: () => { live.q.interrupt?.().catch?.(() => {}); } };   // 能停（以前点停止没反应）
      await liveReady(chat, live);
      const an = takeAvatarNote(chat);   // 你换过头像：这一轮也附上
      const body = [lead, an?.text, nudge].filter(Boolean).join('\n\n');
      let content = an?.imgs.length ? await contentFor(body, an.imgs) : body;
      if (extra.shots?.length) content = [   // 一起看：截好的屏幕图（已经缩小过）放在文字前面
        ...extra.shots.map(b => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b.toString('base64') } })),
        ...(typeof content === 'string' ? [{ type: 'text', text: content }] : content)];
      live.push(userMsg(content));
      await live.readTurn(collect);
      if (slip.found.length && slip.ok) {
        const t = await resendSlips(chat, live, slip.found, m => {
          estStep(chat, m, sid0, tally);
          if (m.session_id) { chat.sessionId = m.session_id; chat.sessionCwd = chat.cwd; }
          if ((m.type === 'assistant' || m.type === 'user') && m.uuid) chat.lastChainUuid = m.uuid;
          meter.see(m);
          if (m.type === 'result') noteCtx(chat, meter.last, m.modelUsage);
        });
        if (t) { push(chat, { role: 'system', text: SLIP_LINE }); if (sayOut(chat, t)) said = true; }
      }
      live.key = liveKey(chat, live.stamp);
    } else {
    const q = query({
      prompt: lead ? `${lead}\n\n${nudge}` : nudge,
      options: {
        cwd: chat.cwd,
        ...cliOpt(),
        env: apiEnv(),
        includePartialMessages: true,   // 不开的话输出 token 只报开头那一点（collect 不看流事件里的字，只拿用量）
        resume: chat.sessionId || undefined,
        settingSources: ['project'],
        allowedTools: [],
        canUseTool: async () => ({ behavior: 'deny', message: '主动消息不用工具' }),
        model: chat.model || 'default',   // 同 modelOpts：不传就会沿用会话当初的模型
        ...(chat.effort ? { effort: chat.effort } : {}),
        ...systemPromptFor(chat),
      },
    });
    for await (const m of q) {
      collect(m);
      if (m.type === 'result') break;
    }
    }
    /* 发了文字或文件（send_file 是当场进聊天的）：都算它主动说的 */
    const fresh = chat.messages.filter(m => m.seq > seqBefore && (m.role === 'assistant' || m.role === 'sticker'));
    sent = fresh.length > 0;
    for (const m of fresh) m.proactive = true;
    if (meter.calls.size) usage = sumUsage(meter.calls);
    if (sent) {
      noteTurnUsage(chat, meter.calls, seqBefore + 1);   // 这一轮的用量记在它最后一条消息上，跟平时一样点一下能看
      checkModel(chat, turnModel);   // 只发了朋友圈、没说话时不在聊天里留提示
      chat.lastProactive = Date.now();
      chat.lastTurn = null;   // Claude 自己开口说的，没有「上一轮」可以重答
    }
  } catch (e) { console.error(`[主动] ${chat.id}（${reason}）没成：`, e?.message || e); } finally {   // 失败就算了，下次再说
    recordCost(meter.calls, tally);
    chat.busy = false; chat.abort = null; chat.waking = false; chat.wakeReason = null; chat.quoteNext = null;
    emit(chat, busyEv(chat));
    save(chat);
    bgPump(chat);
    maybeCompact(chat);
  }
  return { said, sent, usage };
}
/* 真是它说的话：不是子任务，也不是 Claude Code 自己合成的那种（「You've hit your limit…」这类错误提示也长得像一条回复） */
const realReply = m => m.type === 'assistant' && !m.parent_tool_use_id && !m.error && m.message?.model !== '<synthetic>';
const quietLine = l => /^\s*[\[［【]?\s*不打扰\s*[\]］】]?\s*$/.test(l);   // 单独一行「[不打扰]」：不算说话
/* ── 话写进了思考里 ───────────────────────────────
   有时模型把要说给你听的话写进了思考块，而不是正文。思考原文是加密的，App 只拿得到系统给它做的一句概要，原话拿不回来；
   它自己看得到原文，所以以为发出去了。App 没丢字——夹在工具中间的正文照常会发，没出来的只是写进思考的那几段。
   补救：平时思考的概要是英文的；一段概要以中文为主、后面紧跟着调工具（不是紧跟着正文），多半就是这种。这一轮说完以后问它一句：
   是要说的就重发，不是就回 [不打扰]——中文思考偶尔也真是在想事，所以让它自己认，不替它判。一轮只问一次 */
const looksSaid = t => {
  const s = String(t || ''), cjk = (s.match(/[\u3400-\u9fff]/g) || []).length, lat = (s.match(/[A-Za-z]/g) || []).length;
  return cjk >= 8 && cjk > lat;
};
function slipWatch() {
  let cand = null, ok = false;
  const found = [];
  const settle = () => { if (cand) found.push(cand.text); cand = null; };
  return {
    found,
    get ok() { return ok; },   // 这一轮是好好说完的（被停下、出错的不问）
    see(m) {
      if (m.type === 'result') { settle(); ok = m.subtype === 'success'; return; }
      if (!realReply(m)) return;
      if (cand && cand.id !== m.message?.id) settle();   // 那次调用就停在这段思考上了：也算
      for (const b of m.message?.content || []) {
        if (b.type === 'thinking') { settle(); if (looksSaid(b.thinking)) cand = { id: m.message?.id, text: b.thinking.trim() }; }
        else if (b.type === 'text') { if (b.text.trim()) cand = null; }   // 后面紧跟着正文：是真在想，话已经说了
        else if (b.type === 'tool_use') settle();
      }
    },
  };
}
const SLIP_LINE = '中间有一段话写进了思考里，没发出来，下面是重发的';
/* 问它那一句，读完它的回答；返回要发给你的字（回 [不打扰] 就是空的）。keep：会话 id、用量这些照常记 */
async function resendSlips(chat, live, found, keep) {
  const gist = found.map(t => '「' + t.replace(/\s+/g, ' ').slice(0, 300) + '」').join('\n');
  console.log(`[写进思考] ${chat.id}：${found.length} 段思考像是要说出来的话，问问要不要重发`);
  live.push(userMsg(`（App 提示，不是${TA}说的：你这一轮有${found.length > 1 ? '几' : '一'}段思考，概要是：\n${gist}\n` +
    `如果这是你想跟${TA}说的话——它写进了思考里，没发出去，${TA}那边看不到原话，只有这句概要——就把那段话完整地重新发给${TA}：直接写正文，别调工具，不用解释为什么重发（App 会在前面提一句）。` +
    `如果那只是你自己在想、本来就不打算说，就只回一行 [不打扰]。）`));
  let out = '';
  await live.readTurn(m => { keep(m); if (realReply(m)) for (const b of m.message?.content || []) if (b.type === 'text' && b.text.trim()) out += (out ? '\n\n' : '') + b.text; });
  const t = out.split('\n').filter(l => !quietLine(l)).join('\n').trim();
  console.log(`[写进思考] ${chat.id}：${t ? `重发了（${t.length} 字）` : '它说那段不是要说的'}`);
  return t;
}
/* 你要说话时，它自己醒来做的事让路：可能正搜东西、做小玩意，要好几分钟，不能挡着你。停掉那一轮（已经发出来的留着），接着处理你的消息 */
async function yieldWake(chat) {
  if (!chat.busy || !chat.waking) return;
  chat.abort?.abort();
  for (let i = 0; i < 60 && chat.busy; i++) await new Promise(r => setTimeout(r, 200));
}
/* 它没被问就开口的文字发进聊天（自己醒来、朋友圈之后私聊、闹钟、日记）：「[不打扰]」那一行不算；空行拆成一条条。发了返回 true */
function sayOut(chat, text) {
  const t = String(text).split('\n').filter(l => !quietLine(l)).join('\n').trim();
  if (!t) return false;
  for (const p of t.split(/\n{2,}/).map(x => x.trim()).filter(Boolean)) for (const m of bubbleMsgs(chat, p)) push(chat, { ...m, proactive: true });
  chat.lastProactive = Date.now();
  return true;
}

function maybeProactive(chat) {
  if (chat.companion && chat === companionChat()) return false;   // 陪伴会话用下面「每天随机醒几次」那套
  if (chat.busy || chat.bgRunning || !chat.messages.length) return false;
  const now = Date.now();
  if (now - (chat.lastProactive || 0) < PRO.cooldownHours * 3600e3) return false;
  const last = chat.messages[chat.messages.length - 1];
  if (last && last.proactive) return false;   // 上一条主动的你还没回，先不追，免得像催
  const lastUser = [...chat.messages].reverse().find(m => m.role === 'user' || (m.role === 'sticker' && m.mine));
  const idleFor = lastUser ? now - lastUser.ts : Infinity;
  if (idleFor > PRO.idleHours * 3600e3) { proactive(chat, 'idle'); return true; }   // 很久没理它
  if (idleFor > 30 * 60e3 && Math.random() < PRO.randomChancePerCheck) { proactive(chat, 'random'); return true; }  // 随机冒泡（不打断正聊）
  return false;
}

if (PRO.enabled) setInterval(() => {
  const h = tzHour();                          // 按 TZ 的钟点，别用电脑的美国时区
  if (h < PRO.dayStart || h >= PRO.dayEnd) return;
  for (const chat of chats.values()) if (maybeProactive(chat)) break;   // 一次最多戳一个会话
}, PRO.checkEveryMin * 60 * 1000);

/* ── 会话里的文件（「聊天记录及文件」侧栏）：发过的（你发的、Claude 用 send_file 发的）+ Claude 写过 / 改过的。
   写 / 改的文件记着完整路径；没记路径的老记录只有文件名，到它的文件夹（cwd、readDirs）里往下 4 层找同名的 ── */
const MADE_TOOLS = /^(Write|Edit|MultiEdit|NotebookEdit)$/;
const madeOpened = new Map();   // 「路径|改动时间|大小」→ 复制进 data/files 的编号（同一版不重复复制）
const nameHits = new Map();
function findByName(chat, name) {
  const ck = chat.id + '|' + name;
  if (nameHits.has(ck) && existsSync(nameHits.get(ck))) return nameHits.get(ck);
  for (const root of [chat.cwd, ...(chat.readDirs || [])].filter(Boolean)) {
    const stack = [[root, 0]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const p = join(dir, e.name);
        if (e.isFile() && e.name === name) { nameHits.set(ck, p); return p; }
        if (e.isDirectory() && depth < 4) stack.push([p, depth + 1]);
      }
    }
  }
  return null;
}
function chatFiles(chat, withPath = false) {
  const out = [], made = new Map();
  for (const m of allMessages(chat)) {
    if (m.files?.length) for (const f of m.files) out.push({ kind: 'sent', hk: 's:' + f.id, from: m.role === 'user' ? 'me' : 'ai', id: f.id, name: f.name, size: f.size, ts: m.ts, seq: m.seq });
    if (m.role === 'tool' && MADE_TOOLS.test(m.tool || '') && m.state === 'done' && (m.path || m.detail)) {
      made.set(m.path || m.detail, { kind: 'made', hk: 'm:' + (m.path || m.detail), key: m.path || m.detail, name: basename(m.path || m.detail), verb: m.verb, ts: m.ts, seq: m.seq, path: m.path || null });   // 同一个文件只留最近一次
    }
  }
  for (const f of made.values()) {
    if (!f.path) f.path = findByName(chat, f.name);
    try { const st = statSync(f.path); f.size = st.size; f.exists = st.isFile(); } catch { f.exists = false; }
    out.push(f);
  }
  out.sort((a, b) => b.ts - a.ts);
  const hid = new Set(chat.hiddenFiles || []);   // 你在聊天记录里藏起来的：照样给，页面上默认不显示
  for (const f of out) if (hid.has(f.hk)) f.hidden = true;
  return withPath ? out : out.map(({ path, ...f }) => ({ ...f, where: path ? dirname(path).replace(homedir(), '~') : null }));   // 发给页面的不带完整路径
}

const shiftDay = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d) + n * 86400e3).toISOString().slice(0, 10); };

/* ── 陪伴会话每天自己醒几次（config.proactive.enabled 开了才有）：夜里（nightStart～nightEnd 点）night 次，白天（nightEnd～dayEnd 点）day 次，时间都是随机的——
   把每段平均分成 N 份，每份里随机挑一个点（两次不会挨太近）。醒了让它自己选：发消息 / 发朋友圈 / 什么都不做 / 上网搜点什么再发朋友圈或消息 / 改朋友圈签名；
   每两天随机有一次多一个选项：做个小玩意或气泡皮肤（offerPlay）。
   正聊着（最后一条在 15 分钟内）就往后推 20 分钟；电脑睡着错过超过 3 小时的就算了。计划存在会话数据里（重启不丢），
   日志里 [随机醒来] 那几行能看到每天的计划和每次它选了什么。别的会话用上面的随机冒泡。
   每次醒来都要把它的上下文重读一遍，是要花 API 的钱的：次数在 config.proactive.companion 里改（{ day, night, nightStart, nightEnd, dayEnd }）。 ── */
const WAKE = { day: 5, night: 1, nightStart: 0, nightEnd: 8, dayEnd: 24, ...(config.proactive?.companion || {}) };   // dayEnd 可以写超过 24（25 = 第二天凌晨 1 点），给睡得晚的人用
const WAKE_GAP = 60 * 60e3;   // 两次醒来至少隔一小时
const hhmm = t => new Date(t).toLocaleTimeString('zh-CN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const agoText = ms => ms < 3600e3 ? Math.max(1, Math.round(ms / 60e3)) + ' 分钟' : ms < 48 * 3600e3 ? Math.round(ms / 3600e3) + ' 小时' : Math.round(ms / 86400e3) + ' 天';
function planWakes(chat) {
  const day = tzDay(Date.now() - WAKE.nightStart * 3600e3);   // 一天从 nightStart 点算起
  if (chat.wakePlan?.day === day && chat.wakePlan.v === 4) return chat.wakePlan;
  const [y, mo, d] = day.split('-').map(Number), now = Date.now(), times = [], ranges = [];
  const spread = (fromH, toH, n) => {
    const start = tzWallToEpoch(y, mo, d, fromH, 0), end = tzWallToEpoch(y, mo, d, toH, 0) - 20 * 60e3, slot = (end - start) / n;
    for (let i = 0; i < n; i++) {
      const lo = start + slot * i + slot * 0.15, hi = start + slot * i + slot * 0.85;
      ranges.push([lo, hi]);
      times.push(Math.round(lo + Math.random() * (hi - lo)));
    }
  };
  spread(WAKE.nightStart, WAKE.nightEnd, WAKE.night);
  spread(WAKE.nightEnd, WAKE.dayEnd, WAKE.day);
  /* 两次挨得不到一小时：后面那次在它自己那一段里重摇，摇到离前一次够一小时为止。
     每段两个多小时、只在中间七成里挑，总有地方；随机摇 30 次都不中（几乎不会）就在够远的那一截里直接挑 */
  let rerolled = 0;
  for (let i = 1; i < times.length; i++) {
    if (times[i] - times[i - 1] >= WAKE_GAP) continue;
    const [lo, hi] = ranges[i];
    let t = null;
    for (let k = 0; k < 30 && t == null; k++) { const c = lo + Math.random() * (hi - lo); if (c - times[i - 1] >= WAKE_GAP) t = c; }
    if (t == null) { const from = Math.max(lo, times[i - 1] + WAKE_GAP); t = from + Math.random() * Math.max(0, hi - from); }
    times[i] = Math.round(t); rerolled++;
  }
  if (rerolled) console.log(`[随机醒来] ${chat.id} ${day} 有 ${rerolled} 次跟前一次不到一小时，重摇了`);
  chat.wakePlan = { v: 4, day, n: times.length, times: times.map(at => ({ at, done: at < now - 10 * 60e3 ? 'missed' : null })) };   // 开机之前就过了的不补
  save(chat);
  console.log(`[随机醒来] ${chat.id} ${day} 计划 ${times.length} 次：${times.map(hhmm).join(' ')}`);
  return chat.wakePlan;
}
/* 「做小玩意」这个选项每两天只出现一次（总做就没惊喜了；气泡皮肤也算在里面）。这一次随机：两天里还没轮到时，
   每次醒来按 1 / 还剩几次 的机会抽中——这样两天里每次醒来机会一样，错过几次（电脑睡着、没有 key）也不会落空。出现了做不做还是它自己选 */
function offerPlay(chat, plan) {
  const day = plan.day;
  let c = chat.playCycle;
  if (!c || day >= shiftDay(c.start, 2)) c = chat.playCycle = { start: day, given: false };
  if (c.given) return false;
  const left = plan.times.filter(t => !t.done).length + 1 + (day === c.start ? WAKE.day + WAKE.night : 0);   // 这一次 + 今天还没到的 + 第二天的
  if (Math.random() * left >= 1) return false;
  c.given = true;
  save(chat);
  return true;
}
/* three.js、p5.js 不随仓库分发：用的人自己下载放进 public/vendor/（见 README）。放了哪个才跟它提哪个，没放就让它用原生的 Canvas / SVG / CSS 做 */
const VENDOR_LIBS = [{ name: 'three.js', file: 'three.min.js', global: 'THREE' }, { name: 'p5.js', file: 'p5.min.js', global: 'p5' }];
const vendorLibs = () => VENDOR_LIBS.filter(l => existsSync(join(ROOT, 'public', 'vendor', l.file)));
function playOption() {
  const libs = vendorLibs();
  const kinds = ['一个 HTML 文件', '一幅 SVG 画', ...libs.map(l => l.name + ' 作品'), ...(REMOTION_OK ? ['Remotion 视频'] : [])];
  return `做点小玩意给${TA}（这个选项两天才有一次，做不做还是看你）：${kinds.join('、')}都行。用 Write 写进工作目录的「${PLAY_DIR}/」文件夹（这个文件夹写文件不用审批），文件名写清楚是什么、前面带上日期，写好用 send_file 发给${TA}，想说一句也行。` +
    `要单个文件就能打开：` + (libs.length
      ? libs.map(l => `${l.name} 用 <script src="/vendor/${l.file}"></script>（全局变量 ${l.global}）`).join('，') + `，App 里自带${libs.length < VENDOR_LIBS.length ? `；${VENDOR_LIBS.filter(l => !libs.includes(l)).map(l => l.name).join('、')} 这台电脑上没有，别用` : ''}；别从外面的 CDN 引用库（不一定打得开）。`
      : '这台电脑上没有放 three.js、p5.js 这些库，就用原生的 Canvas、SVG、CSS 做，别从外面的 CDN 引用库（不一定打得开）。') +
    `手机竖屏也要好看，canvas 跟着窗口大小走。写好用 preview_page 看一眼（手机竖屏的截图，页面报错也会告诉你），不对就改，满意了再发。` +
    (REMOTION_OK ? `Remotion 视频：在这个文件夹写一个 .tsx（export default 一个组件），用 video_render 先看几帧、再渲染成 mp4，用 send_file 发给${TA}。` : '') +
    `也可以给${TA}做一款聊天气泡皮肤（素材可以自己用 image_search 搜，或者用 Write 在这个文件夹画 svg；要处理图片可以在「${PLAY_DIR}/脚本/」写 python 跑）：先用 bubble_skin_preview 看草稿（白天、夜间，${TA}设了聊天背景再加背景下的两栏；不存），满意了再 bubble_skin_save 存，${TA}在「外观 → 气泡」里能选用；做好发消息告诉${TA}一声。`;
}
function wakeNudge(chat, k, plan, now, last, play, screen = false) {
  const me = nameOf('me'), night = tzHour() >= WAKE.nightStart && tzHour() < WAKE.nightEnd;
  const lastMe = [...chat.messages].reverse().find(m => m.role === 'user' || (m.role === 'sticker' && m.mine));
  return `（系统消息，不是${me}说的话：现在是 ${nowStr()}，这是你今天第 ${k} 次自己醒来（一天一共 ${plan.n} 次：凌晨 ${WAKE.nightStart}～${WAKE.nightEnd} 点 ${WAKE.night} 次，白天 ${WAKE.day} 次，时间是随机的）。` +
    (night ? `这会儿是凌晨，${TA}多半在睡觉；你发的东西不会吵醒${TA}，${TA}醒了才看到。` : '') +
    (lastMe ? `${me}上一次跟你说话是 ${agoText(now - lastMe.ts)}前。` : '') +
    (last && last.proactive ? `你上次主动发的消息${TA}还没回。` : '') +
    `这次做什么你自己选：\n` +
    [
      `给${TA}发几句消息——想${TA}了、问问${TA}在干嘛、关心一下、分享个想法、接着之前聊的都行，像平时聊天，简短自然。`,
      `用 moments_post 发一条朋友圈，可以带图（只发朋友圈的话就别回任何文字）。`,
      `什么都不做——没什么想说、或者觉得${TA}正忙不想打扰，就只回「[不打扰]」。`,
      `自己上网搜点什么，什么都行，纯粹因为你好奇（WebSearch${DEEPSEEK_MCP ? '；查国内的用 DeepSeek 搜索' : ''}；搜图片用 image_search，发图用 send_image）。搜完可以发朋友圈，也可以发消息跟${TA}说。`,
      ...(play ? [playOption()] : []),
      `改一下你自己朋友圈的签名（moments_signature，60 字以内；现在是「${profile.claude?.sign || '没写'}」）。只改签名的话就别回任何文字。`,
      ...(screen ? [`看一眼${TA}的电脑屏幕（screen_look），再就着看到的给${TA}发几句消息——好奇${TA}在看什么、做什么，或者关心一下，像坐在旁边瞄了一眼随口搭话（别像查岗）。屏幕黑着、锁着说明${TA}不在电脑前，那就随便说句别的，或者回「[不打扰]」。屏幕上的私事看到了也别记、别往外说。`] : []),   // 看屏幕和发消息是一起的
    ].map((t, i) => `${'abcdefgh'[i]}. ${t}\n`).join('') +
    `这一轮不弹审批卡：${play ? `除了「${PLAY_DIR}/」文件夹，别的` : ''}写文件、跑命令都会被拒，不用试。你写出来的每个字都会发到聊天窗口，中途不用汇报你在干嘛。）`;
}
async function checkWakes() {
  const chat = companionChat();
  if (!PRO.enabled || !chat || !chat.companion) return;
  const plan = planWakes(chat), now = Date.now();
  const due = plan.times.find(w => !w.done && w.at <= now);
  if (!due) return;
  if (now - due.at > 3 * 3600e3) { due.done = 'missed'; save(chat); return; }
  if (chat.busy || chat.bgRunning) return;   // 正忙，下一分钟再看
  if (!authReady()) { due.done = 'nokey'; save(chat); return; }
  const last = chat.messages[chat.messages.length - 1];
  if (last && !last.proactive && now - last.ts < 15 * 60e3) { due.at = now + 20 * 60e3; save(chat); return; }   // 正聊着，往后推
  if (chat.lastWakeAt && now - chat.lastWakeAt < WAKE_GAP) { due.at = chat.lastWakeAt + WAKE_GAP; save(chat); return; }   // 上一次往后推过、挤到一块了：离上一次醒满一小时再来
  due.done = 'running'; save(chat);
  const k = plan.times.indexOf(due) + 1;
  const momsBefore = moments.length, signBefore = profile.claude?.sign || '';
  const play = offerPlay(chat, plan);
  const hNow = tzHour(now), screen = hNow >= WAKE.nightEnd || hNow < WAKE.nightStart;   // 看屏幕（选项 g）：白天才给，夜里屏幕多半睡着
  chat.wakePlay = play;   // 这一轮才放行写「小玩意」文件夹
  chat.wakeScreen = screen;
  chat.lastWakeAt = now;
  const looksBefore = chat.screenLooks || 0;
  let r;
  try { r = await proactive(chat, 'wake', wakeNudge(chat, k, plan, now, last, play, screen)); }
  finally { chat.wakePlay = false; chat.wakeScreen = false; }
  const looked = (chat.screenLooks || 0) > looksBefore;
  const posted = moments.length > momsBefore, signed = (profile.claude?.sign || '') !== signBefore;
  due.done = r?.sent ? 'said' : posted ? 'moment' : signed ? 'sign' : 'quiet';
  save(chat);
  const did = [looked ? '看了屏幕' : '', r?.sent ? (r.said ? '发了消息' : '发了文件') : '', posted ? '发了朋友圈' : '', signed ? '改了签名' : ''].filter(Boolean).join('、') || '没动';
  console.log(`[随机醒来] ${chat.id} 第 ${k}/${plan.n} 次（${hhmm(now)}${play ? '，这次有小玩意选项' : ''}）→ ${did}${tokText(r?.usage)}`);
}
setInterval(() => { checkWakes().catch(e => console.error('[随机醒来] 出错：', e?.message || e)); }, 60e3);
const tokText = u => u ? `（调模型 ${u.calls} 次，新输入 ${u.input}，读缓存 ${u.cacheRead}，写缓存 ${u.cacheWrite}，输出 ${u.output}）` : '';

/* ── 你一阵子没回（config.proactive.silence：{ hours, from, to }，默认 2 小时、8 点到 24 点之间才问）：它说完话你超过 hours 小时没回，
   问它要不要主动问问——问不问它自己定。一条消息只问一次；它问了、你还没回，就从它这句再算 hours 小时（会告诉它已经问过几次）；它选了不问，就等下一条消息。
   刚醒过（30 分钟内）先等等，别连着两轮。这一轮跟「自己醒来」一样不弹审批卡、你一发消息就让路。 ── */
const SILENCE = { hours: 2, from: 8, to: 24, ...(config.proactive?.silence || {}) };   // to 可以写超过 24（25 = 第二天凌晨 1 点）
async function checkSilence() {
  const chat = companionChat();
  if (!PRO.enabled || !chat?.companion) return;
  const h = tzHour();
  if (!(h >= SILENCE.from || h < SILENCE.to - 24)) return;
  if (chat.busy || chat.bgRunning || !authReady()) return;
  const talk = chat.messages.filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'sticker');
  const last = talk[talk.length - 1], now = Date.now();
  if (!last || isMine(last) || last.seq === chat.silenceSeq) return;   // 最后一句是你说的（轮不到问）；这句已经问过了
  if (now - last.ts < SILENCE.hours * 3600e3 || now - (chat.lastWakeAt || 0) < 30 * 60e3) return;
  chat.silenceSeq = last.seq; save(chat);
  /* 到点的那一刻也要在这个时段里才问（比如 23:30 说的，2 小时到点是 1:30，就不问了）——
     不然它半夜说完最后一句、你睡了，早上时段一开始就问「6 小时没回」，还白白重读一遍整个上下文 */
  const dueH = tzHour(last.ts + SILENCE.hours * 3600e3);
  if (!(dueH >= SILENCE.from || dueH < SILENCE.to - 24)) return;
  const lastMe = [...talk].reverse().find(isMine);
  const asked = talk.filter(m => m.silenceAsk && (!lastMe || m.seq > lastMe.seq)).length;
  const me = nameOf('me'), seqBefore = chat.seq;
  const r = await proactive(chat, 'silence', `（系统消息，不是${me}说的话：现在是 ${nowStr()}，你上一条消息发出去 ${agoText(now - last.ts)}了，${me}还没回。` +
    (asked ? `这段时间你已经主动问过${TA} ${asked} 次了。` : '') +
    `要不要主动问问${TA}，你自己决定：想问就直接写，像平时聊天，简短自然；觉得${TA}在忙、在睡觉，或者不想催${TA}，就只回「[不打扰]」。` +
    `这一轮不弹审批卡，写文件、跑命令都会被拒。你写出来的每个字都会发到聊天窗口，中途不用汇报。）`);
  for (const m of chat.messages) if (m.seq > seqBefore && (m.role === 'assistant' || m.role === 'sticker')) m.silenceAsk = true;
  save(chat);
  console.log(`[没回消息] ${chat.id} ${agoText(now - last.ts)}没回 → ${r?.sent ? '问了' : '没问'}${tokText(r?.usage)}`);
}
setInterval(() => { checkSilence().catch(e => console.error('[没回消息] 出错：', e?.message || e)); }, 60e3);

/* ── 陪伴会话的闹钟：它自己定时间，到点服务端叫醒它，它在聊天里主动跟你说话 ─────────────
   存在 data/wakeups.json（重启不丢）。时间按 TZ（跟它每轮看到的「现在是…」一致，不认电脑的时区）。
   到点时它正忙就留着、下次检查再叫；电脑关机 / 服务停了错过的：晚 3 小时以内照样叫、告诉它晚了多久，
   更晚的作废（隔半天才响的闹钟不如不响）。工具挂在 companionChat() 那个会话上，自动放行。 */
const WAKE_FILE = join(DATA, 'wakeups.json');
let wakeups = [];
try { wakeups = JSON.parse(readFileSync(WAKE_FILE, 'utf8')).wakeups || []; } catch { /* 没有就空 */ }
const saveWakeups = () => writeFile(WAKE_FILE, JSON.stringify({ wakeups })).catch(() => {});
const WAKE_TOOLS = ['wakeup_set', 'wakeup_list', 'wakeup_cancel'].map(n => `mcp__wakeup__${n}`);
const WAKE_LATE_MAX = 3 * 3600e3;
/* TZ 里的墙上时间 → 时间戳：先当成 UTC 算，再减掉那一刻 TZ 比 UTC 快多少 */
const tzOffsetMs = t => { const d = new Date(t); return new Date(d.toLocaleString('en-US', { timeZone: TZ })) - new Date(d.toLocaleString('en-US', { timeZone: 'UTC' })); };
const tzWallToEpoch = (y, mo, d, h, mi) => { const g = Date.UTC(y, mo - 1, d, h, mi); return g - tzOffsetMs(g); };
const tzFmt = t => new Date(t).toLocaleString('zh-CN', { timeZone: TZ, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
function wakeupServer(chat) {
  const ok = text => ({ content: [{ type: 'text', text }] });
  const bad = text => ({ content: [{ type: 'text', text }], isError: true });
  const mine = () => wakeups.filter(w => w.chat === chat.id).sort((a, b) => a.at - b.at);
  return createSdkMcpServer({ name: 'wakeup', version: '1.0.0', tools: [
    tool('wakeup_set', `给自己定个闹钟：到点系统会叫醒你，你就能在聊天里主动跟${nameOf('me')}说话（比如${TA}让你明早八点半叫${TA}，或者你想过一会儿问问${TA}怎么样了）。` +
      `at 填${TA}那边的时间「YYYY-MM-DD HH:MM」（跟你每轮看到的「现在是…」同一个时区）；或者用 inMinutes 填多少分钟以后。note 写到时候想跟${TA}说什么、为什么定，到点会原样给你看。`,
      { at: z.string().optional(), inMinutes: z.number().int().min(1).max(60 * 24 * 30).optional(), note: z.string().min(1).max(300) },
      async ({ at, inMinutes, note }) => {
        let t;
        if (inMinutes) t = Date.now() + inMinutes * 60e3;
        else {
          const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})\s*$/.exec(at || '');
          if (!m) return bad('时间要写成「YYYY-MM-DD HH:MM」，比如 2026-11-04 08:30；或者用 inMinutes。');
          t = tzWallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]);
        }
        if (!Number.isFinite(t) || t < Date.now() + 30e3) return bad('这个时间已经过了（或者就在眼前），换一个以后的时间。');
        if (t > Date.now() + 30 * 86400e3) return bad('最多只能定 30 天以内的。');
        if (mine().length >= 20) return bad('已经定了 20 个了，先用 wakeup_list 看看、取消几个。');
        const w = { id: randomUUID().slice(0, 6), chat: chat.id, at: t, note: note.trim(), created: Date.now() };
        wakeups.push(w); saveWakeups();
        return ok(`定好了：${tzFmt(t)}（编号 ${w.id}）。到点叫你，提醒是：${w.note}`);
      }),
    tool('wakeup_list', '看看你给自己定了哪些闹钟（还没响的）。', {}, async () => {
      const ws = mine();
      return ok(ws.length ? ws.map(w => `[${w.id}] ${tzFmt(w.at)}：${w.note}`).join('\n') : '现在一个闹钟都没定。');
    }),
    tool('wakeup_cancel', '取消一个闹钟（编号用 wakeup_list 看）。', { id: z.string() }, async ({ id }) => {
      const i = wakeups.findIndex(w => w.id === id && w.chat === chat.id);
      if (i < 0) return bad(`没有编号是 ${id} 的闹钟，先用 wakeup_list 看看。`);
      const [w] = wakeups.splice(i, 1); saveWakeups();
      return ok(`取消了：${tzFmt(w.at)} 那个（${w.note}）。`);
    }),
  ] });
}
/* 每 30 秒看一眼有没有到点的：到了就从表里拿掉，在它的会话里跑一轮主动消息（它正忙就留着，下次再看）。一次叫一个 */
setInterval(() => {
  const now = Date.now();
  for (const w of wakeups.filter(x => x.at <= now).sort((a, b) => a.at - b.at)) {
    const chat = chats.get(w.chat), late = now - w.at;
    if (!chat || late > WAKE_LATE_MAX) {
      wakeups = wakeups.filter(x => x !== w); saveWakeups();
      console.warn(`[闹钟] 作废：${tzFmt(w.at)}「${w.note}」${chat ? `，晚了 ${Math.round(late / 60e3)} 分钟` : '，会话没了'}`);
      continue;
    }
    if (chat.busy || chat.bgRunning || !chat.messages.length) continue;
    wakeups = wakeups.filter(x => x !== w); saveWakeups();
    const lateNote = late > 10 * 60e3 ? `（电脑那会儿没开着，这个闹钟晚了大约 ${Math.round(late / 60e3)} 分钟才响。）` : '';
    proactive(chat, 'wakeup', `（系统消息，不是对话：你之前给自己定的闹钟响了。定的时候你写的是：「${w.note}」。现在是 ${nowStr()}。${lateNote}` +
      `照你当时想的，跟${nameOf('me')}说吧，简短自然，像平时聊天；要是现在不合适说，就别回任何文字。）`);
    break;
  }
}, 30e3);

/* 改消息：这条消息属于哪一轮、那次一起发的是哪几条。退不回去（上一个窗口的、太早了的）返回 null。
   一轮的 fromSeq 是发完你的消息之后下一个编号，所以「第一个 fromSeq 比这条大的轮次」就是它；两者之间不能隔着回复（那是轮次记录已经没了的老消息） */
function editTarget(chat, seq) {
  const ms = chat.messages, i = ms.findIndex(m => m.seq === seq);
  if (i < 0 || !isMine(ms[i])) return null;
  const list = turnsOf(chat).slice().sort((a, b) => a.fromSeq - b.fromSeq);
  const turn = list.find(t => t.fromSeq > seq);
  if (!turn) return null;
  if (ms.some(m => m.seq > seq && m.seq < turn.fromSeq && !isMine(m) && m.role !== 'system')) return null;
  const prevFrom = list.filter(t => t.fromSeq <= seq).pop()?.fromSeq ?? -Infinity;
  const block = ms.filter(m => isMine(m) && m.seq < turn.fromSeq && m.seq >= prevFrom);
  /* 只要紧挨着这条的那一段（中间隔着别的就不算一次发的） */
  let a = block.findIndex(m => m.seq === seq), b = a;
  const adj = (x, y) => !ms.some(m => m.seq > x.seq && m.seq < y.seq && !isMine(m));
  while (a > 0 && adj(block[a - 1], block[a])) a--;
  while (b + 1 < block.length && adj(block[b], block[b + 1])) b++;
  return { turn, block: block.slice(a, b + 1) };
}

/* ── HTTP ─────────────────────────────────────────────────────── */
const MIME = { '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.ico': 'image/x-icon' };   // png：主屏幕图标要按图片发
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
const readBody = req => new Promise((ok, no) => {
  let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy(); });
  req.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch (e) { no(e); } });
});

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  /* 静态：页面本身不校验 token（拿不到 token 也做不了任何事） */
  if (req.method === 'GET' && !p.startsWith('/api/')) {
    const file = join(ROOT, 'public', p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
    try {
      const buf = await readFile(file);
      /* 页面和脚本每次都跟电脑核对有没有新版本（手机"添加到主屏幕"的网页 App 不这样会一直用旧页面）；
         表情图这类不常变的，让它缓存一天 */
      const ext = extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : ['.html', '.js', '.css', '.json'].includes(ext) ? 'no-cache' : 'public, max-age=86400' });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end('not found'); }
  }

  /* 取文件：编号就是钥匙，不用口令（见文件开头「文件」那段）。?dl 表示下载 */
  const fm = p.match(/^\/api\/file\/([a-f0-9]{32})(?:\/[^/]*)?$/);
  if (fm && (req.method === 'GET' || req.method === 'HEAD')) {
    const f = await fileById(fm[1]);
    if (!f) { res.writeHead(404); return res.end(); }
    return sendFile(req, res, f, url.searchParams.has('dl'));
  }

  if (!tokenOk(req, url)) { noteKnock(req, url); return json(res, 401, { error: 'bad token' }); }

  if (p === '/api/usage') return json(res, 200, await getUsage(url.searchParams.get('fresh') === '1'));

  /* 气泡皮肤的图（陪伴会话做的）：只当图片用，直接打开也不让 svg 跑脚本 */
  if (p === '/api/skin-preview') {   // 预览页（给陪伴会话截图看的）要的：这款皮肤（存好的或草稿）+ 你现在的聊天背景、蒙白、气泡透明度
    const id = url.searchParams.get('id') || '';
    let sk = allSkins().find(s => s.id === id) || null;
    if (!sk && /^[a-f0-9]{8}$/.test(id)) { try { sk = JSON.parse(readFileSync(join(SKIN_DRAFTS, id, 'skin.json'), 'utf8')); } catch { /* 没有 */ } }
    if (!sk) return json(res, 404, { error: 'no such skin' });
    return json(res, 200, { skin: sk, bg: profile.ui?.bg || null, bgDim: profile.ui?.bgDim ?? 0.82, bubbleAlpha: profile.ui?.bubbleAlpha ?? 1 });
  }
  const sf = p.match(/^\/api\/skin-file\/([a-f0-9]{8})\/([a-z0-9-]+\.(jpg|png|gif|webp|svg))$/);
  if (sf && req.method === 'GET') {
    try {
      const buf = await readFile(join(SKINS_DIR, sf[1], sf[2])).catch(() => readFile(join(SKIN_DRAFTS, sf[1], sf[2])));
      res.writeHead(200, { 'content-type': sf[3] === 'svg' ? 'image/svg+xml' : (IMG_MIME[sf[3]] || 'application/octet-stream'), 'cache-control': 'public, max-age=604800', 'x-content-type-options': 'nosniff', 'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }

  /* 新消息的实时通道：每个开着的页面连一条 */
  if (p === '/api/notify-stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': ok\n\n');
    notifySubs.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
    const cid = String(url.searchParams.get('cid') || '').slice(0, 40);
    req.on('close', () => { clearInterval(hb); notifySubs.delete(res); if (cid) watchers.delete(cid); });
    return;
  }
  if (p === '/api/push-key') return json(res, 200, { key: loadPush().pub });

  if (p === '/api/chats') {
    const pv = m => (isActionLine(m.text || '') ? m.text.trim().slice(1, -1) : m.text) || (m.images?.length ? '[图片]' : m.files?.length ? '[文件] ' + m.files[0].name : m.role === 'sticker' ? '[表情]' : '');
    return json(res, 200, {
      tz: TZ,   // 页面按这个时区显示时间
      chats: [...chats.values()].map(c => {
        const last = [...c.messages].reverse().find(m => m.role === 'user' || m.role === 'assistant' || m.role === 'sticker');
        return { id: c.id, name: chatName(c), baseName: c.name, cwd: c.cwd, busy: c.busy, unread: c.unread, seq: c.seq, preview: last ? pv(last).slice(0, 40) : '', ts: last?.ts || 0, model: c.model, effort: c.effort, ctx: c.ctx,  moments: companionChat() === c, watch: watchInfo(c),
          ...(c.companion && COMPACT.at > 0 && COMPACT.at < 1 ? { compactAt: COMPACT.at, keepTurns: COMPACT.keepTurns } : {}) };
      }),
    });
  }

  /* 你从「＋」发的文件（什么格式都行，最大 30MB）：原始字节直接发，文件名放在 ?name= 里 */
  if (p === '/api/upload-file' && req.method === 'POST') {
    const chunks = [];
    let size = 0;
    try {
      await new Promise((ok, no) => {
        req.on('data', d => { size += d.length; if (size <= FILE_MAX) chunks.push(d); });
        req.on('end', ok);
        req.on('error', no);
      });
    } catch { return json(res, 400, { error: 'upload failed' }); }
    if (size > FILE_MAX) return json(res, 413, { error: 'too big' });
    if (!size) return json(res, 400, { error: 'empty' });
    return json(res, 200, { file: await storeFile(Buffer.concat(chunks), url.searchParams.get('name') || 'file') });
  }

  /* 上传一张图（头像 / 背景 / 封面）。原始字节直接发，不走 JSON，所以要在下面读 body 之前处理 */
  if (p === '/api/upload' && req.method === 'POST') {
    const MAX = 12 * 1024 * 1024;
    const chunks = [];
    let size = 0;
    try {
      await new Promise((ok, no) => {
        req.on('data', d => { size += d.length; if (size <= MAX) chunks.push(d); });
        req.on('end', ok);
        req.on('error', no);
      });
    } catch { return json(res, 400, { error: 'upload failed' }); }
    if (size > MAX) return json(res, 413, { error: 'too big' });
    const buf = Buffer.concat(chunks);
    const ext = sniffImage(buf);
    if (!ext) return json(res, 415, { error: 'not an image' });
    const name = randomBytes(8).toString('hex') + '.' + ext;
    await mkdir(MEDIA, { recursive: true });
    await writeFile(join(MEDIA, name), buf);
    return json(res, 200, { file: name });
  }

  /* 取图：也要令牌（<img src> 带 ?t=） */
  const media = p.match(/^\/api\/media\/([^/]+)$/);
  if (media && req.method === 'GET') {
    if (!MEDIA_RE.test(media[1])) { res.writeHead(404); return res.end(); }
    try {
      const buf = await readFile(join(MEDIA, media[1]));
      res.writeHead(200, { 'content-type': IMG_MIME[extname(media[1]).slice(1)], 'cache-control': 'private, max-age=31536000, immutable' });
      return res.end(buf);
    } catch { res.writeHead(404); return res.end(); }
  }

  /* POST 的 body 先读出来（会话 id / 朋友圈内容都在里面） */
  const body = req.method === 'POST' ? await readBody(req).catch(() => ({})) : {};

  /* 这个页面现在是不是正被人看着（决定要不要推手机） */
  if (p === '/api/presence' && req.method === 'POST') {
    const cid = String(body.cid || '').slice(0, 40);
    if (cid) { watchers.set(cid, { active: !!body.active, chat: body.chat || null, at: Date.now() }); if (watchers.size > 50) watchers.delete(watchers.keys().next().value); }
    return json(res, 200, { ok: true });
  }
  /* 手机打开 / 关掉推送 */
  if (p === '/api/push-subscribe' && req.method === 'POST') {
    const sub = body.sub;
    if (!/^https:\/\//.test(sub?.endpoint || '')) return json(res, 400, { error: 'bad endpoint' });
    if (!sub?.keys?.p256dh || !sub?.keys?.auth) return json(res, 400, { error: 'bad keys' });
    loadPush();
    pushCfg.subs = [...pushCfg.subs.filter(x => x.endpoint !== sub.endpoint), { endpoint: String(sub.endpoint), keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) }, at: Date.now() }].slice(-8);
    savePush();
    const n = await sendPush({ title: '新消息提醒开好了', body: '以后 App 不在前台时，有新消息会这样告诉你。', chat: null });
    console.log(`[推送] 新订阅一个，现在 ${pushCfg.subs.length} 个；试推 ${n ? '成功' : '没成功'}`);
    return json(res, 200, { ok: true, delivered: n > 0 });
  }
  if (p === '/api/push-unsubscribe' && req.method === 'POST') {
    loadPush();
    pushCfg.subs = pushCfg.subs.filter(x => x.endpoint !== String(body.endpoint || ''));
    savePush();
    return json(res, 200, { ok: true });
  }
  /* API key 的设置（「用量 → API」那一栏）。key 只进不出：页面只能看到最后 4 位 */
  if (p === '/api/apikey') {
    if (req.method === 'POST') {
      const r = await saveApiCfg(body);
      if (!r.ok) return json(res, r.code || 400, r);
      return json(res, 200, { ...apiStatus(), note: r.note || null });
    }
    return json(res, 200, apiStatus());
  }

  /* 可选的模型和各自支持的思考强度 */
  if (p === '/api/models') {
    if (!MODELS.length) await loadModels();
    return json(res, 200, { models: MODELS });
  }

  /* 身份档案 + 表情清单（都是全局的） */
  if (p === '/api/profile') {
    if (req.method === 'POST') {
      /* img：传文件名就设，传 null 就清掉，不传就不动 */
      const img = v => (v === null || v === '') ? { img: null } : (MEDIA_RE.test(String(v)) ? { img: String(v) } : {});
      const clean = o => o && typeof o === 'object'
        ? {
            ...(o.name != null ? { name: String(o.name).slice(0, 24) } : {}),
            ...(o.avatar != null ? { avatar: String(o.avatar).slice(0, 8) } : {}),
            ...(o.sign != null ? { sign: String(o.sign).trim().slice(0, 60) } : {}),   // 个性签名，朋友圈个人页头像下面那行
            ...('img' in o ? img(o.img) : {}),
          } : {};
      const avaBefore = { me: profile.me?.img || null, claude: profile.claude?.img || null,
        contacts: Object.fromEntries(Object.entries(profile.contacts || {}).map(([k, v]) => [k, v?.img || null])),
        sign: profile.me?.sign || '', itSign: profile.claude?.sign || '', cover: profile.ui?.cover || null };
      profile = { ...profile, me: { ...profile.me, ...clean(body.me) }, claude: { ...profile.claude, ...clean(body.claude) } };
      if (body.contacts && typeof body.contacts === 'object') {
        const next = { ...profile.contacts };
        for (const [id, v] of Object.entries(body.contacts)) {
          if (!chats.has(id) || !v || typeof v !== 'object') continue;
          next[id] = { ...(next[id] || {}), ...('img' in v ? img(v.img) : {}),
            ...('name' in v ? { name: String(v.name || '').trim().slice(0, 24) || null } : {}) };   // 名字：空着 = 用原名
        }
        profile.contacts = next;
      }
      if (body.ui && typeof body.ui === 'object') {
        const u = body.ui, next = { ...profile.ui };
        if ('bg' in u) next.bg = img(u.bg).img ?? (u.bg === null || u.bg === '' ? null : next.bg);
        if ('cover' in u) next.cover = img(u.cover).img ?? (u.cover === null || u.cover === '' ? null : next.cover);
        if (u.bgDim != null && Number.isFinite(+u.bgDim)) next.bgDim = Math.min(0.98, Math.max(0.3, +u.bgDim));
        if (u.bubbleAlpha != null && Number.isFinite(+u.bubbleAlpha)) next.bubbleAlpha = Math.min(1, Math.max(0.3, +u.bubbleAlpha));   // 气泡透明度
        if ('skin' in u) next.skin = u.skin === 'custom' || allSkins().some(s => s.id === u.skin) ? u.skin : null;   // 气泡皮肤，null = 不加皮肤，custom = 自选颜色
        if (u.bubColors && typeof u.bubColors === 'object') {   // 自选颜色：只收 #RRGGBB
          const hex = v => (/^#[0-9a-f]{6}$/i.test(String(v || '')) ? String(v).toUpperCase() : null);
          next.bubColors = { me: hex(u.bubColors.me), ai: hex(u.bubColors.ai) };
        }
        profile.ui = next;
      }
      saveProfile();
      noteAvatars(avaBefore);   // 换了头像、改了朋友圈签名或封面：告诉陪伴会话（陪伴会话）
      momentsVer++;   // 签名、头像改了，朋友圈页面也跟着刷新
    }
    return json(res, 200, { profile, myStickers, skins: allSkins() });
  }

  /* ── 表情包（全局）：列出 / 加一张（图先走 /api/upload）/ 删 ── */
  if (p === '/api/stickers' && req.method !== 'POST') return json(res, 200, { stickers: myStickers });
  if (p === '/api/stickers/add') {
    const file = String(body.file || '');
    if (!MEDIA_RE.test(file) || !existsSync(join(MEDIA, file))) return json(res, 400, { error: 'bad file' });
    if (myStickers.length >= 300) return json(res, 400, { error: 'full' });
    const s = { id: randomBytes(5).toString('hex'), file, ts: Date.now() };
    myStickers.unshift(s);
    saveMyStickers();
    return json(res, 200, { ok: true, sticker: s, stickers: myStickers });
  }
  if (p === '/api/stickers/delete') {
    const ids = new Set((Array.isArray(body.ids) ? body.ids : [body.id]).map(String));
    myStickers = myStickers.filter(s => !ids.has(s.id));
    saveMyStickers();
    return json(res, 200, { ok: true, stickers: myStickers });
  }

  /* ── 日记本路由（全局） ── */
  if (p === '/api/diary' && req.method !== 'POST') {
    return json(res, 200, { ver: diaryVer, today: diaryDay(), days: await diaryList() });
  }
  if (p === '/api/diary/entry') {
    const who = url.searchParams.get('who'), date = url.searchParams.get('date') || '';
    if (!isDiaryWho(who) || !DIARY_DATE_RE.test(date)) return json(res, 400, { error: 'bad' });
    try { return json(res, 200, { who, date, ...parseDiary(await readFile(diaryPath(who, date), 'utf8')) }); }
    catch { return json(res, 404, { error: 'gone' }); }
  }
  if (p === '/api/diary' && req.method === 'POST') {   // 你交日记；同一天再交就是改（不再通知陪伴会话）
    const date = String(body.date || ''), text = String(body.text || '').trim();
    if (!DIARY_DATE_RE.test(date) || date > todayStr() || !text || text.length > 20000) return json(res, 400, { error: 'bad' });
    const mood = String(body.mood || '').trim().slice(0, 12);
    const tags = (Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[,，、]/))
      .map(s => String(s).trim().slice(0, 16)).filter(Boolean).slice(0, 8);
    const r = await writeDiary('me', date, { mood, tags, text });
    if (r.created) diaryEvent(companionChat(), date, { mood, tags, text });
    return json(res, 200, { ok: true, created: r.created });
  }

  /* ── 朋友圈路由（全局，不属于某个会话，所以放在会话查找之前） ── */
  if (p === '/api/moments') {
    return json(res, 200, { ver: momentsVer, moments, profile });
  }
  if (p === '/api/moment') {                 // 你发一条（可以带图，最多 9 张；图先走 /api/upload）
    const text = String(body.text || '').trim();
    const images = (Array.isArray(body.images) ? body.images : []).map(String)
      .filter(f => MEDIA_RE.test(f) && existsSync(join(MEDIA, f))).slice(0, 9);
    if (!text && !images.length) return json(res, 400, { error: 'empty' });
    const post = { id: randomUUID().slice(0, 8), author: 'me', name: nameOf('me'), text: text.slice(0, 1000), images, ts: Date.now(), likes: [], comments: [] };
    moments.unshift(post);
    saveMoments();
    const mc = companionChat();
    if (mc) momentEvent(mc, 'post', post);   // 交给陪伴会话本人：它刷到了，自己决定赞不赞、评什么
    else claudeReact(post);                  // 没有陪伴会话时，退回老办法
    return json(res, 200, { ok: true, post });
  }
  if (p === '/api/moment/pin') {             // 置顶 / 取消置顶你自己的一条（显示在你的个人朋友圈最上面）
    const post = moments.find(m => m.id === body.postId && m.author === 'me');
    if (!post) return json(res, 404, { error: 'gone' });
    post.pinned = !!body.pinned;
    saveMoments();
    return json(res, 200, { ok: true, pinned: post.pinned });
  }
  if (p === '/api/moment/delete') {          // 删掉你自己的一条
    const i = moments.findIndex(m => m.id === body.postId && m.author === 'me');
    if (i < 0) return json(res, 404, { error: 'gone' });
    moments.splice(i, 1);
    saveMoments();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/moment/like') {            // 你点赞/取消
    const post = moments.find(m => m.id === body.postId);
    if (!post) return json(res, 404, { error: 'gone' });
    const i = post.likes.indexOf('me');
    if (i >= 0) post.likes.splice(i, 1); else post.likes.push('me');
    saveMoments();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/moment/comment') {         // 你评论 / 回复某条评论
    const post = moments.find(m => m.id === body.postId);
    const text = String(body.text || '').trim();
    if (!post || !text) return json(res, 400, { error: 'bad' });
    const replyTo = body.replyTo ? String(body.replyTo).slice(0, 24) : null;
    addComment(post, 'me', text.slice(0, 200), replyTo);
    /* 触发 Claude 回复：你回到它头上，或（没指定回谁时）评在它的动态下 */
    if (replyTo === nameOf('claude') || (!replyTo && post.author === 'claude')) {
      const mc = companionChat();
      if (mc) momentEvent(mc, 'comment', post, { text, replyTo });
      else claudeReplyToComment(post, text);
    }
    return json(res, 200, { ok: true });
  }

  const chat = chats.get(body.chat ?? url.searchParams.get('chat'));
  if (!chat) return json(res, 404, { error: 'no such chat' });

  /* 「聊天记录及文件」侧栏：哪几天聊过（日历上标点）；往上翻到头 / 按日期跳时取更早的消息（含存档）；会话里的文件 */
  if (p === '/api/chat-days') {
    const days = new Map();
    for (const m of allMessages(chat)) {
      if (m.role === 'thinking' || m.role === 'tool') continue;
      const d = tzDay(m.ts), x = days.get(d);
      if (x) x.n++; else days.set(d, { day: d, n: 1, firstSeq: m.seq });
    }
    return json(res, 200, { days: [...days.values()] });
  }
  if (p === '/api/history-before') {
    const before = Number(url.searchParams.get('before') || Infinity);
    const from = url.searchParams.get('from') != null ? Number(url.searchParams.get('from')) : null;
    const limit = Math.min(3000, Math.max(1, Number(url.searchParams.get('limit') || 200)));
    const all = allMessages(chat).filter(m => m.seq < before);
    const list = (from != null ? all.filter(m => m.seq >= from) : all).slice(-(from != null ? 3000 : limit));
    return json(res, 200, { messages: list, more: !!list.length && all[0].seq < list[0].seq });
  }
  if (p === '/api/chat-files') return json(res, 200, { files: chatFiles(chat) });
  /* 聊天记录里的文件藏起来 / 放回来（文件多了乱）：只是不在列表里显示，文件本身、聊天里的卡片都不动 */
  if (p === '/api/chat-files-hide' && req.method === 'POST') {
    const keys = (Array.isArray(body.keys) ? body.keys : []).map(String).filter(k => /^[sm]:/.test(k) && k.length < 2000).slice(0, 500);
    const set = new Set(chat.hiddenFiles || []);
    for (const k of keys) { if (body.hidden) set.add(k); else set.delete(k); }
    chat.hiddenFiles = [...set].slice(-3000);
    save(chat);
    return json(res, 200, { ok: true, count: keys.length });
  }
  /* 搜聊天记录：你说的、它说的，连存档一起，文件名也算；新的在前，最多给 100 条。不存索引，每次现翻（几万条也就一眨眼），数据不用动 */
  if (p === '/api/chat-search') {
    const terms = String(url.searchParams.get('q') || '').trim().toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
    if (!terms.length) return json(res, 200, { results: [], total: 0 });
    const results = [], all = allMessages(chat);
    let total = 0;
    for (let i = all.length - 1; i >= 0; i--) {
      const m = all[i];
      if (m.role !== 'user' && m.role !== 'assistant') continue;
      const text = [m.text, ...(m.files || []).map(f => f.name)].filter(Boolean).join(' ');
      const low = text.toLowerCase();
      if (!text || !terms.every(t => low.includes(t))) continue;
      total++;
      if (results.length >= 100) continue;
      const at = low.indexOf(terms[0]), from = Math.max(0, at - 18), to = Math.min(text.length, at + terms[0].length + 44);
      results.push({ seq: m.seq, ts: m.ts, mine: m.role === 'user', snippet: (from ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : '') });
    }
    return json(res, 200, { results, total, terms });
  }
  if (p === '/api/chat-file-open' && req.method === 'POST') {   // 打开 Claude 写过的文件：复制一份进 data/files，用看文件那套（不带口令、网页隔离跑）
    const it = chatFiles(chat, true).find(f => f.kind === 'made' && f.key === String(body.key || ''));
    if (!it || !it.path) return json(res, 404, { error: 'gone' });
    let st;
    try { st = statSync(it.path); } catch { return json(res, 404, { error: 'gone' }); }
    if (!st.isFile() || st.size > FILE_MAX) return json(res, 400, { error: 'too big' });
    const ck = `${it.path}|${st.mtimeMs}|${st.size}`;
    let f = madeOpened.has(ck) ? await fileById(madeOpened.get(ck)) : null;
    if (!f) { f = await storeFile(readFileSync(it.path), basename(it.path)); madeOpened.set(ck, f.id); }
    return json(res, 200, f);
  }

  if (p === '/api/history') {
    const since = Number(url.searchParams.get('since') || 0);
    chat.unread = 0;
    return json(res, 200, { seq: chat.seq, busy: chat.busy, messages: chat.messages.filter(m => m.seq > since) });
  }

  if (p === '/api/stream') {
    const since = Number(url.searchParams.get('since') || 0);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': ok\n\n');
    for (const m of chat.messages.filter(m => m.seq > since)) res.write(`data: ${JSON.stringify({ type: 'msg', msg: m })}\n\n`);
    res.write(`data: ${JSON.stringify(busyEv(chat))}\n\n`);
    res.write(`data: ${JSON.stringify(ctxEv(chat))}\n\n`);
    chat.subs.add(res);
    chat.unread = 0;
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(hb); chat.subs.delete(res); });
    return;
  }

  if (req.method !== 'POST') return json(res, 405, { error: 'method' });

  if (p === '/api/send') {
    const text = String(body.text || '').trim();
    /* 图片先走 /api/upload 传上来，这里只收文件名（最多 6 张） */
    const images = (Array.isArray(body.images) ? body.images : []).map(String)
      .filter(f => MEDIA_RE.test(f) && existsSync(join(MEDIA, f))).slice(0, 6);
    /* 文件先走 /api/upload-file，这里只收编号（最多 6 个） */
    const files = [];
    for (const id of (Array.isArray(body.files) ? body.files : []).slice(0, 6)) { const f = await fileById(id); if (f) files.push(f); }
    if (!text && !images.length && !files.length) return json(res, 400, { error: 'empty' });
    await yieldWake(chat);
    if (chat.busy) return json(res, 409, { error: 'busy' });
    /* 引用：挂在你这次第一行字上；只发了图或文件就挂在那条上 */
    const q = body.quote?.seq != null ? quoteOf(allMessages(chat).find(m => m.seq === Number(body.quote.seq))) : null;
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const qOn = !q ? null : lines.length ? 'text' : images.length ? 'img' : 'file';
    if (images.length) push(chat, { role: 'user', text: '', images, ...(qOn === 'img' ? { quote: q } : {}) });
    if (files.length) push(chat, { role: 'user', text: '', files, ...(qOn === 'file' ? { quote: q } : {}) });
    /* 你分了几行，就拆成几个气泡显示；但发给 Claude 的还是完整那段（换行保留） */
    lines.forEach((line, i) => push(chat, { role: 'user', text: line, ...(qOn === 'text' && i === 0 ? { quote: q } : {}) }));
    /* 文件不直接塞给 Claude：告诉它存在电脑上哪儿，它用 Read 打开（PDF、文本、图片都读得了） */
    const me = nameOf('me');
    const note = files.map(f => `（${me}发来一个文件：${f.name}，${fmtSize(f.size)}，存在电脑上：${filePath(f)}。要看内容就用 Read 打开。）`).join('\n');
    runTurn(chat, [quotePrompt(q), note, text].filter(Boolean).join('\n\n'), { images });
    return json(res, 200, { ok: true });
  }

  if (p === '/api/watch') {   // 一起看：on=true 开始 / 改间隔，on=false 停
    if (chat !== companionChat() || !chat.companion) return json(res, 400, { error: 'only for the companion chat' });
    if (body.on) watchStart(chat, body.every, body.hours, 'me');
    else watchStop(chat);
    return json(res, 200, { watch: watchInfo(chat) });
  }
  if (p === '/api/new-window') {
    if (chat.busy) return json(res, 409, { error: 'busy' });
    newWindow(chat).catch(e => console.error('[新窗口]', e));
    return json(res, 200, { ok: true });
  }

  if (p === '/api/sticker' && body.custom) {  // 你发一个自己存的表情包：Claude 当成一张图片看
    const s = myStickers.find(x => x.id === String(body.custom));
    if (!s || !existsSync(join(MEDIA, s.file))) return json(res, 400, { error: 'no such sticker' });
    await yieldWake(chat);
    if (chat.busy) return json(res, 409, { error: 'busy' });
    /* 输入框里打好了字再点表情包：先发字（分几行就几个气泡），再发表情包，一轮回复一起看 */
    const text = String(body.text || '').trim().slice(0, 8000);
    for (const line of text.split(/\r?\n/).map(x => x.trim()).filter(Boolean)) push(chat, { role: 'user', text: line });
    push(chat, { role: 'sticker', mine: true, img: s.file });
    runTurn(chat, [text, `（${nameOf('me')}发来一个表情包，图就在这条消息里）`].filter(Boolean).join('\n\n'), { images: [s.file] });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/sticker') return json(res, 400, { error: 'no such sticker' });   // 只收自己存的表情包（custom）

  /* 改这个会话的模型 / 思考强度。null = 回到默认；这个模型不支持的强度会被清掉 */
  if (p === '/api/chat-settings') {
    let model = body.model == null || body.model === '' || body.model === 'default' ? null : String(body.model);
    if (model && MODELS.length && !MODELS.some(m => m.value === model)) return json(res, 400, { error: 'unknown model' });
    let effort = body.effort == null || body.effort === '' ? null : String(body.effort);
    if (effort && !EFFORTS.includes(effort)) return json(res, 400, { error: 'bad effort' });
    const info = modelInfo(model);
    if (effort && info && !info.levels.includes(effort)) effort = null;
    chat.model = model;
    chat.effort = effort;
    save(chat);
    emit(chat, { type: 'settings', model, effort });
    warmLive(chat);                 // 陪伴会话：按新模型重开常驻进程（接着原会话）
    return json(res, 200, { ok: true, model, effort });
  }

  /* 改一条发过的消息：退回到这条所在的那一轮——这条和它后面的聊天都去掉（Claude 那边从这一轮之前分叉，后面的不留在记忆里），用改过的话重新发。
     你那次一起发的几行、图片、文件、表情包算一整条：文字换成改过的，图片、文件、表情包留着 */
  if (p === '/api/edit') {
    if (chat.busy) return json(res, 409, { error: 'busy' });
    const ta = editTarget(chat, +body.seq);
    if (!ta) return json(res, 410, { error: 'too old' });
    const text = String(body.text || '').trim().slice(0, 100000);
    /* replace：页面把这条原来的图片、文件也放进了待发那一排，删了的就不要了，给的就是改完的全部；
       没带 replace 的：原来的留着，新加的接在后面 */
    const keep = !body.replace;
    const newImgs = (Array.isArray(body.images) ? body.images : []).map(String).filter(f => MEDIA_RE.test(f) && existsSync(join(MEDIA, f)));
    const images = [...(keep ? ta.block.flatMap(m => m.images || []) : []), ...newImgs].slice(0, 6);
    const files = keep ? ta.block.flatMap(m => m.files || []) : [];
    for (const id of (Array.isArray(body.files) ? body.files : []).slice(0, 6)) { const f = await fileById(id); if (f) files.push(f); }
    const stickers = ta.block.filter(m => m.role === 'sticker');
    if (!text && !images.length && !files.length && !stickers.length) return json(res, 400, { error: 'empty' });
    /* 去掉的聊天留一份在 <id>.removed.jsonl（万一点错了还能找回来），页面上不显示 */
    const first = ta.block[0].seq;
    const gone = chat.messages.filter(m => m.seq >= first);
    try { appendFileSync(join(DATA, `${chat.id}.removed.jsonl`), gone.map(m => JSON.stringify({ ...m, removedAt: Date.now() })).join('\n') + '\n'); } catch (e) { console.error('[改消息] 留底没写进去：', e.message); }
    chat.messages = chat.messages.filter(m => m.seq < first);
    chat.turns = (chat.turns || []).filter(x => x.fromSeq < ta.turn.fromSeq);
    emit(chat, { type: 'remove', seqs: gone.map(m => m.seq) });
    save(chat);
    const q = ta.block.find(m => m.quote)?.quote || null;   // 原来引用了哪句，改完还引用着
    const elines = text.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
    const qOn = !q ? null : elines.length ? 'text' : images.length ? 'img' : files.length ? 'file' : null;
    if (images.length) push(chat, { role: 'user', text: '', images, ...(qOn === 'img' ? { quote: q } : {}) });
    if (files.length) push(chat, { role: 'user', text: '', files, ...(qOn === 'file' ? { quote: q } : {}) });
    elines.forEach((line, i) => push(chat, { role: 'user', text: line, ...(qOn === 'text' && i === 0 ? { quote: q } : {}) }));
    for (const st of stickers) push(chat, { role: 'sticker', mine: true, img: st.img });
    const me = nameOf('me');
    const note = files.map(f => `（${me}发来一个文件：${f.name}，${fmtSize(f.size)}，存在电脑上：${filePath(f)}。要看内容就用 Read 打开。）`).join('\n');
    const t = ta.turn;
    const prompt = [t.weather, quotePrompt(q), note, text, stickers.length ? `（${me}发来一个表情包，图就在这条消息里）` : ''].filter(Boolean).join('\n\n');
    const mode = t.anchor && t.baseSession ? 'fork' : !t.baseSession ? 'fresh' : 'soft';
    runTurn(chat, mode === 'soft' ? `（${me}把刚才发的消息改了，请按改过的重新回答。改过的是：${prompt}）` : prompt,
      { images: [...images, ...stickers.map(st => st.img)], regen: { mode, prompt, anchor: t.anchor, baseSession: t.baseSession, carry: t.carry || null, weather: t.weather || null } });
    return json(res, 200, { ok: true });
  }

  /* 重新生成：去掉最近一轮的回答（连同那一轮的工具、想法、审批卡），把同一句话再问一遍 */
  if (p === '/api/regenerate') {
    if (chat.busy) return json(res, 409, { error: 'busy' });
    const want = body.fromSeq != null ? +body.fromSeq : null;
    const t = want != null ? turnsOf(chat).find(x => x.fromSeq === want) : chat.lastTurn;
    if (!t) return json(res, 400, { error: 'nothing to regenerate' });
    chat.turns = (chat.turns || []).filter(x => x.fromSeq < t.fromSeq);   // 它后面那几轮的记录也作废
    const removed = chat.messages.filter(m => m.seq >= t.fromSeq).map(m => m.seq);
    chat.messages = chat.messages.filter(m => m.seq < t.fromSeq);
    emit(chat, { type: 'remove', seqs: removed });
    save(chat);
    /* fork：知道上一轮停在哪，就从那里分叉，旧回答彻底不在记忆里
       fresh：这一轮本来是新会话的第一轮，重开一个会话
       soft：这个功能上线之前的老对话没存位置，只能接着问，请它重写一遍 */
    const mode = t.anchor && t.baseSession ? 'fork' : !t.baseSession ? 'fresh' : 'soft';
    const text = mode === 'soft'
      ? `（${nameOf('me')} 点了「重新生成」：请把你上一条回复重新写一遍，可以换个说法或思路。${TA}的原话是：${t.prompt}）`
      : t.prompt;
    runTurn(chat, text, { images: t.images || [], regen: { mode, prompt: t.prompt, anchor: t.anchor, baseSession: t.baseSession, carry: t.carry || null, weather: t.weather || null } });
    return json(res, 200, { ok: true });
  }

  /* 选择题的答案：answers = { 题目原文: 选了哪个（多选用、隔开；自己写的就是那句话） }；cancel 就是关掉不选 */
  if (p === '/api/choice') {
    const entry = chat.pending.get(body.permId);
    if (!entry || !entry.choice) return json(res, 404, { error: 'gone' });
    if (body.cancel) {
      chat.pending.delete(body.permId);
      update(chat, entry.card, { state: 'skipped' });
      entry.resolve({ behavior: 'deny', message: `${nameOf('me')}没选，把这道选择题关掉了。别再出一次，直接接着聊。` });
      return json(res, 200, { ok: true });
    }
    const answers = {};
    for (const q of entry.card.questions) { const a = String(body.answers?.[q.question] ?? '').trim().slice(0, 2000); if (a) answers[q.question] = a; }
    if (!Object.keys(answers).length) return json(res, 400, { error: 'empty' });
    chat.pending.delete(body.permId);
    update(chat, entry.card, { state: 'answered', answers });
    console.log(`[选择题] ${chat.id} 选了：${Object.values(answers).join(' / ').slice(0, 120)}`);
    entry.resolve({ behavior: 'allow', updatedInput: { ...entry.choice, answers } });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/permission') {
    const entry = chat.pending.get(body.permId);
    if (!entry) return json(res, 404, { error: 'gone' });
    chat.pending.delete(body.permId);
    if (body.decision === 'allow' || body.decision === 'always') {
      update(chat, entry.card, { state: body.decision === 'always' ? 'always' : 'allowed' });
      entry.resolve({ behavior: 'allow', ...(body.decision === 'always' && entry.suggestions ? { updatedPermissions: entry.suggestions } : {}) });
    } else {
      update(chat, entry.card, { state: 'denied' });
      entry.resolve({ behavior: 'deny', message: '这次先不用做这个' });
    }
    return json(res, 200, { ok: true });
  }

  if (p === '/api/interrupt') {
    if (chat.abort) chat.stopped = true;
    chat.abort?.abort();
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: 'no route' });
});

/* 默认只听本机：手机、在外面都走 Tailscale Serve（https 地址，只有你 tailnet 里的设备进得来）转到 127.0.0.1 的这个端口；
   听 0.0.0.0 的话，同一个 Wi-Fi 里谁都能敲到这个端口（敲到的也只是 401 和页面壳）。要放开就用 HOST=0.0.0.0 启动（见 README） */
const HOST = process.env.HOST || '127.0.0.1';
server.listen(PORT, HOST, () => {
  console.log(`\n  ${APP_NAME} 已启动\n`);
  console.log(`  只听 ${HOST}:${PORT}；手机可以走 Tailscale（tailscale serve 转到这个端口）`);
  console.log(`  本机打开：  http://localhost:${PORT}/?t=${TOKEN}\n`);
  console.log(`  会话：${[...chats.values()].map(c => c.name).join('、')}`);
  console.log(`  ${authReady() ? `调 Claude 用的是：${{ saved: '页面里填的 API key', env: '环境变量 ANTHROPIC_API_KEY', cloud: `云平台 / 网关（${CLOUD_ENV.join('、')}）` }[apiStatus().source]}` : NO_KEY_TEXT}`);
  console.log('  只读工具自动放行，写文件 / 跑命令会在页面上弹卡等你确认。\n');
  /* 陪伴会话提前把常驻的 Claude Code 开好，MCP 服务趁这会儿连上 */
  for (const chat of chats.values()) if (chat.companion) ensureSessionDir(chat).then(() => warmLive(chat));
});
/* 服务停的时候把常驻进程一起关掉 */
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => {
  for (const chat of chats.values()) closeLive(chat);
  process.exit(0);
});
