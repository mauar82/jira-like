// Cloudflare deployment: static files from ./public, API in one Durable Object ("Board") that keeps
// all data in its built-in SQLite database and pushes changes to every open browser over WebSocket.
import { DurableObject } from 'cloudflare:workers';
import { createBoard, HttpError } from '../core.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const stub = env.BOARD.get(env.BOARD.idFromName('main'));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });

const enc = new TextEncoder();
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function safeEqual(a, b) {
  const [ha, hb] = await Promise.all([a, b].map(s => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  return crypto.subtle.timingSafeEqual(ha, hb);
}
function cookie(request, name) {
  for (const part of (request.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}

export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    this.board = createBoard({
      all: (q, ...a) => sql.exec(q, ...a).toArray(),
      get: (q, ...a) => sql.exec(q, ...a).toArray()[0],
      run: (q, ...a) => { const c = sql.exec(q, ...a); c.toArray(); return c.rowsWritten; },
      exec: q => { sql.exec(q); },
      tx: fn => ctx.storage.transactionSync(fn),
    });
    let secret = this.board.getSetting('secret');
    if (!secret) {
      secret = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
      this.board.setSetting('secret', secret);
    }
    this.secret = secret;
    this.loginAttempts = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  get password() { return this.env.KANBAN_PASSWORD || ''; }
  sessionToken() { return hmac(this.secret, 'session:' + this.password); }
  sessionCookie(request, value, maxAge) {
    const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
    return `kb_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
  }
  broadcast(msg) {
    const data = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) { try { ws.send(data); } catch { } }
  }
  async readJson(request) {
    if (!/^application\/json\b/.test(request.headers.get('Content-Type') || '')) throw new HttpError(415, 'Content-Type: application/json 필요');
    try { return await request.json(); } catch { throw new HttpError(400, 'JSON 형식 오류'); }
  }

  async fetch(request) {
    try { return await this.route(request); }
    catch (e) {
      const status = e.status || (/UNIQUE constraint/.test(e.message) ? 409 : 500);
      if (status === 500) console.error(e);
      return json(status, { error: status === 500 ? '서버 오류' : e.message });
    }
  }

  async route(request) {
    const { pathname } = new URL(request.url);
    const route = `${request.method} ${pathname}`;

    // Refuse to run open on the internet: a password secret is required.
    if (!this.password) throw new HttpError(503, '서버에 KANBAN_PASSWORD 시크릿이 설정되지 않았습니다. Cloudflare 대시보드 → Workers → kanban → 설정 → 변수 및 비밀에서 추가하세요.');

    if (route === 'POST /api/login') {
      const ip = request.headers.get('CF-Connecting-IP') || 'local';
      const t = Date.now();
      const list = (this.loginAttempts.get(ip) || []).filter(x => t - x < 60000);
      list.push(t); this.loginAttempts.set(ip, list);
      if (list.length > 10) throw new HttpError(429, '시도가 너무 많습니다. 1분 뒤 다시 시도하세요');
      const { password } = await this.readJson(request);
      if (!(await safeEqual(password || '', this.password))) throw new HttpError(401, '비밀번호가 틀렸습니다');
      this.loginAttempts.delete(ip);
      return json(200, { ok: true }, { 'Set-Cookie': this.sessionCookie(request, await this.sessionToken(), 60 * 60 * 24 * 180) });
    }
    if (route === 'POST /api/logout') return json(200, { ok: true }, { 'Set-Cookie': this.sessionCookie(request, '', 0) });

    if (!(await safeEqual(cookie(request, 'kb_session'), await this.sessionToken()))) throw new HttpError(401, 'login required');

    if (route === 'GET /api/state') return json(200, { ...this.board.readState(), auth: true, realtime: 'ws' });

    if (route === 'POST /api/changes') {
      const body = await this.readJson(request);
      const saved = this.board.applyChanges(body);
      this.broadcast({ type: 'change', origin: String(body.clientId || ''), ...saved });
      return json(200, saved);
    }

    if (route === 'POST /api/import') {
      this.board.importAll(await this.readJson(request));
      this.broadcast({ type: 'reload' });
      return json(200, this.board.readState());
    }

    if (route === 'GET /api/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') throw new HttpError(426, 'WebSocket 필요');
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]); // hibernatable: no cost while idle
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    throw new HttpError(404, 'not found');
  }

  webSocketMessage() { }
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch { } }
}
