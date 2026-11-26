#!/usr/bin/env node
/* Kanban server — stores everything in SQLite and saves every change the moment the browser sends it.
 * Zero dependencies (Node >= 22.13 for the built-in node:sqlite).
 *
 *   PORT=3000 HOST=127.0.0.1 DB_PATH=./data/kanban.db KANBAN_PASSWORD=secret node server.js
 */
'use strict';

process.removeAllListeners('warning'); // silence node:sqlite "experimental" warning
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kanban.db');
const PASSWORD = process.env.KANBAN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 20 * 1024 * 1024;

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    next_num INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    num INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, num)
  );
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`);

const q = {
  allProjects: db.prepare('SELECT data, next_num FROM projects ORDER BY rowid'),
  allIssues: db.prepare('SELECT data, num FROM issues ORDER BY project_id, num'),
  getProject: db.prepare('SELECT id, key, next_num FROM projects WHERE id = ?'),
  projectByKey: db.prepare('SELECT id FROM projects WHERE key = ?'),
  insProject: db.prepare('INSERT INTO projects (id, key, next_num, data, updated_at) VALUES (?, ?, ?, ?, ?)'),
  updProject: db.prepare('UPDATE projects SET key = ?, data = ?, updated_at = ? WHERE id = ?'),
  bumpNum: db.prepare('UPDATE projects SET next_num = ? WHERE id = ?'),
  delProject: db.prepare('DELETE FROM projects WHERE id = ?'),
  getIssue: db.prepare('SELECT id, project_id, num FROM issues WHERE id = ?'),
  numTaken: db.prepare('SELECT id FROM issues WHERE project_id = ? AND num = ?'),
  insIssue: db.prepare('INSERT INTO issues (id, project_id, num, data, updated_at) VALUES (?, ?, ?, ?, ?)'),
  updIssue: db.prepare('UPDATE issues SET project_id = ?, num = ?, data = ?, updated_at = ? WHERE id = ?'),
  delIssue: db.prepare('DELETE FROM issues WHERE id = ?'),
  getSetting: db.prepare('SELECT v FROM settings WHERE k = ?'),
  setSetting: db.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),
};

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomBytes(6).toString('base64url');

function readState() {
  return {
    projects: q.allProjects.all().map(r => ({ ...JSON.parse(r.data), nextNum: r.next_num })),
    issues: q.allIssues.all().map(r => ({ ...JSON.parse(r.data), num: r.num })),
  };
}

// ---------- validation ----------
const isStr = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max;
function checkProject(p) {
  if (!p || !isStr(p.id, 64)) throw new HttpError(400, 'project.id 필요');
  if (!isStr(p.name, 200)) throw new HttpError(400, '프로젝트 이름 필요');
  if (typeof p.key !== 'string' || !/^[A-Z][A-Z0-9]{0,9}$/.test(p.key)) throw new HttpError(400, '프로젝트 키는 영문 대문자로 시작 (최대 10자)');
  if (!Array.isArray(p.columns) || !p.columns.length || !p.columns.every(c => c && isStr(c.id, 64) && isStr(c.name, 100)))
    throw new HttpError(400, '컬럼 형식 오류');
}
function checkIssue(i) {
  if (!i || !isStr(i.id, 64) || !isStr(i.projectId, 64)) throw new HttpError(400, 'issue.id / projectId 필요');
  if (typeof i.title !== 'string' || i.title.length > 2000) throw new HttpError(400, '제목 형식 오류');
}

// ---------- writes ----------
function upsertProject(p) {
  checkProject(p);
  const { nextNum, ...data } = p;
  const t = data.updatedAt || nowIso();
  const other = q.projectByKey.get(p.key);
  if (other && other.id !== p.id) throw new HttpError(409, `프로젝트 키 ${p.key} 는 이미 사용 중입니다`);
  const cur = q.getProject.get(p.id);
  if (cur) q.updProject.run(p.key, JSON.stringify(data), t, p.id);
  else q.insProject.run(p.id, p.key, Math.max(1, +nextNum || 1), JSON.stringify(data), t);
  const row = q.getProject.get(p.id);
  return { ...data, nextNum: row.next_num };
}

// Issue numbers are allocated here so two devices can never create the same key.
function upsertIssue(i) {
  checkIssue(i);
  const proj = q.getProject.get(i.projectId);
  if (!proj) throw new HttpError(404, '프로젝트가 없습니다 (다른 기기에서 삭제됨?)');
  const { num: wanted, ...data } = i;
  const t = data.updatedAt || nowIso();
  const cur = q.getIssue.get(i.id);
  let num;
  if (cur && cur.project_id === i.projectId) num = cur.num;
  else {
    const w = Number.isInteger(wanted) && wanted > 0 ? wanted : 0;
    const taken = w ? q.numTaken.get(i.projectId, w) : true;
    num = taken || (w >= proj.next_num + 1000) ? proj.next_num : w; // keep the client's number when free (e.g. undo delete)
  }
  if (num >= proj.next_num) q.bumpNum.run(num + 1, proj.id);
  if (cur) q.updIssue.run(i.projectId, num, JSON.stringify(data), t, i.id);
  else q.insIssue.run(i.id, i.projectId, num, JSON.stringify(data), t);
  return { ...data, num };
}

function applyChanges(body) {
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const issues = Array.isArray(body.issues) ? body.issues : [];
  const deleted = Array.isArray(body.deleted) ? body.deleted.filter(id => typeof id === 'string') : [];
  return tx(() => {
    const out = { projects: projects.map(upsertProject), issues: [], deleted: [] };
    const deletedSet = new Set(deleted);
    // Issues of a project that is being deleted in the same request are skipped.
    out.issues = issues.filter(i => !deletedSet.has(i?.projectId)).map(upsertIssue);
    for (const id of deleted) {
      if (q.delIssue.run(id).changes || q.delProject.run(id).changes) out.deleted.push(id);
    }
    if (!q.allProjects.all().length) throw new HttpError(400, '마지막 프로젝트는 삭제할 수 없습니다');
    // Projects touched by new issues have a new nextNum.
    const touched = new Set(out.issues.map(i => i.projectId));
    const fresh = touched.size ? readState().projects : [];
    for (const pid of touched) if (!out.projects.some(p => p.id === pid)) {
      const full = fresh.find(p => p.id === pid);
      if (full) out.projects.push(full);
    }
    return out;
  });
}

function importAll(body) {
  if (!body || !Array.isArray(body.projects) || !Array.isArray(body.issues) || !body.projects.length)
    throw new HttpError(400, 'projects / issues 배열이 필요합니다');
  tx(() => {
    db.exec('DELETE FROM issues; DELETE FROM projects;');
    for (const p of body.projects) upsertProject(p);
    for (const i of body.issues) if (q.getProject.get(i.projectId)) upsertIssue(i);
  });
}

function seedIfEmpty() {
  if (q.allProjects.all().length) return;
  const t = nowIso();
  const cols = [
    { id: uid(), name: '할 일', done: false },
    { id: uid(), name: '진행 중', done: false, wip: 3 },
    { id: uid(), name: '리뷰', done: false },
    { id: uid(), name: '완료', done: true },
  ];
  const pid = uid();
  const issue = (n, col, title, extra = {}) => ({
    id: uid(), projectId: pid, num: n, title, desc: '', type: 'task', priority: 'medium', status: col.id, order: n,
    labels: [], due: '', points: null, checklist: [], comments: [], createdAt: t, updatedAt: t, ...extra,
  });
  applyChanges({
    projects: [{ id: pid, key: 'DEV', name: '내 프로젝트', columns: cols, nextNum: 1, updatedAt: t }],
    issues: [
      issue(1, cols[0], '카드를 드래그해서 다른 컬럼으로 옮겨보세요', { type: 'story', labels: ['가이드'] }),
      issue(2, cols[0], '빠른 생성: "로그인 버그 #auth !high" 처럼 입력하면 라벨·우선순위가 자동 지정됩니다', { labels: ['가이드'], priority: 'high' }),
      issue(3, cols[1], '단축키는 ? 키로 확인', { labels: ['가이드'], checklist: [{ id: uid(), text: 'C — 새 이슈', done: true }, { id: uid(), text: '/ — 검색', done: false }] }),
      issue(4, cols[3], '보드 만들기', { type: 'epic' }),
    ],
  });
}
seedIfEmpty();

// ---------- auth (optional single password) ----------
let secret = q.getSetting.get('secret')?.v;
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); q.setSetting.run('secret', secret); }
// Changing KANBAN_PASSWORD invalidates existing sessions.
const sessionToken = () => crypto.createHmac('sha256', secret).update('session:' + PASSWORD).digest('base64url');
const safeEqual = (a, b) => {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
};
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
const authed = req => !PASSWORD || safeEqual(parseCookies(req).kb_session || '', sessionToken());
const isHttps = req => req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
function sessionCookie(req, value, maxAge) {
  return `kb_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
const loginAttempts = new Map(); // ip -> [timestamps]
function tooManyAttempts(ip) {
  const t = Date.now();
  const list = (loginAttempts.get(ip) || []).filter(x => t - x < 60000);
  list.push(t);
  loginAttempts.set(ip, list);
  return list.length > 10;
}

// ---------- live updates (Server-Sent Events) ----------
const clients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

// ---------- http ----------
function send(res, status, body, headers = {}) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    if (!/^application\/json\b/.test(req.headers['content-type'] || '')) return reject(new HttpError(415, 'Content-Type: application/json 필요'));
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new HttpError(413, '요청이 너무 큽니다')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'JSON 형식 오류')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, { error: 'not found' });
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
    res.end(buf);
  });
}

async function handleApi(req, res, pathname) {
  const route = `${req.method} ${pathname}`;

  if (route === 'POST /api/login') {
    const ip = req.socket.remoteAddress;
    if (tooManyAttempts(ip)) throw new HttpError(429, '시도가 너무 많습니다. 1분 뒤 다시 시도하세요');
    const { password } = await readJson(req);
    if (!PASSWORD || safeEqual(password || '', PASSWORD)) {
      loginAttempts.delete(ip);
      return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, sessionToken(), 60 * 60 * 24 * 180) });
    }
    throw new HttpError(401, '비밀번호가 틀렸습니다');
  }
  if (route === 'POST /api/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });

  if (!authed(req)) throw new HttpError(401, 'login required');

  if (route === 'GET /api/state') return send(res, 200, { ...readState(), auth: !!PASSWORD });

  if (route === 'POST /api/changes') {
    const body = await readJson(req);
    const saved = applyChanges(body);
    broadcast('change', { origin: String(body.clientId || ''), ...saved });
    return send(res, 200, saved);
  }

  if (route === 'POST /api/import') {
    importAll(await readJson(req));
    broadcast('reload', {});
    return send(res, 200, readState());
  }

  if (route === 'GET /api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  throw new HttpError(404, 'not found');
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  try {
    if (pathname.startsWith('/api/')) await handleApi(req, res, pathname);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, pathname);
    else send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    const status = e.status || (/UNIQUE constraint/.test(e.message) ? 409 : 500);
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: status === 500 ? '서버 오류' : e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Kanban server: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (db: ${DB_PATH})`);
  if (!PASSWORD && !['127.0.0.1', 'localhost', '::1'].includes(HOST))
    console.warn('⚠  KANBAN_PASSWORD 가 설정되지 않았습니다. 외부에 공개된 주소라면 누구나 보드를 수정할 수 있습니다.');
});

const shutdown = () => { for (const c of clients) c.end(); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
