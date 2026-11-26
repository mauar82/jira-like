#!/usr/bin/env node
/* Kanban server — stores everything in SQLite and saves every change the moment the browser sends it.
 * Zero dependencies (Node >= 22.13 for the built-in node:sqlite).
 *
 *   PORT=3000 HOST=127.0.0.1 DB_PATH=./data/kanban.db KANBAN_PASSWORD=secret node server.js
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createBoard, HttpError } from './core.js';

process.removeAllListeners('warning'); // silence node:sqlite "experimental" warning
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w); });
const { DatabaseSync } = await import('node:sqlite');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'kanban.db');
const PASSWORD = process.env.KANBAN_PASSWORD || '';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 20 * 1024 * 1024;

// ---------- database ----------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec('PRAGMA journal_mode = WAL;');
const stmts = new Map();
const prep = sql => { let st = stmts.get(sql); if (!st) { st = sqlite.prepare(sql); stmts.set(sql, st); } return st; };
const board = createBoard({
  all: (sql, ...a) => prep(sql).all(...a),
  get: (sql, ...a) => prep(sql).get(...a),
  run: (sql, ...a) => Number(prep(sql).run(...a).changes),
  exec: sql => sqlite.exec(sql),
  tx: fn => {
    sqlite.exec('BEGIN IMMEDIATE');
    try { const r = fn(); sqlite.exec('COMMIT'); return r; }
    catch (e) { sqlite.exec('ROLLBACK'); throw e; }
  },
});

// ---------- auth (optional single password) ----------
let secret = board.getSetting('secret');
if (!secret) { secret = crypto.randomBytes(32).toString('hex'); board.setSetting('secret', secret); }
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

  if (route === 'GET /api/state') return send(res, 200, { ...board.readState(), auth: !!PASSWORD, realtime: 'sse' });

  if (route === 'POST /api/changes') {
    const body = await readJson(req);
    const saved = board.applyChanges(body);
    broadcast('change', { origin: String(body.clientId || ''), ...saved });
    return send(res, 200, saved);
  }

  if (route === 'POST /api/import') {
    board.importAll(await readJson(req));
    broadcast('reload', {});
    return send(res, 200, board.readState());
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

const shutdown = () => { for (const c of clients) c.end(); server.close(() => { sqlite.close(); process.exit(0); }); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
