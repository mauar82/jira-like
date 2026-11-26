// Board data logic shared by the Node server (server.js, node:sqlite) and the Cloudflare
// Durable Object (worker/index.js, storage.sql). Each passes in a small SQL adapter:
//   { all(sql, ...args) → rows, get(sql, ...args) → row | undefined, run(sql, ...args) → changes,
//     exec(sql), tx(fn) → fn() inside a transaction }

export class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const nowIso = () => new Date().toISOString();
const uid = () => {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    key TEXT NOT NULL UNIQUE,
    next_num INTEGER NOT NULL DEFAULT 1,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS issues (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    num INTEGER NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (project_id, num)
  );
  CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
`;

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

export function createBoard(db) {
  db.exec(SCHEMA);

  const getProject = id => db.get('SELECT id, key, next_num FROM projects WHERE id = ?', id);
  const projectRows = () => db.all('SELECT data, next_num FROM projects ORDER BY rowid');

  function readState() {
    return {
      projects: projectRows().map(r => ({ ...JSON.parse(r.data), nextNum: r.next_num })),
      issues: db.all('SELECT data, num FROM issues ORDER BY project_id, num').map(r => ({ ...JSON.parse(r.data), num: r.num })),
    };
  }

  function upsertProject(p) {
    checkProject(p);
    const { nextNum, ...data } = p;
    const t = data.updatedAt || nowIso();
    const other = db.get('SELECT id FROM projects WHERE key = ?', p.key);
    if (other && other.id !== p.id) throw new HttpError(409, `프로젝트 키 ${p.key} 는 이미 사용 중입니다`);
    if (getProject(p.id)) db.run('UPDATE projects SET key = ?, data = ?, updated_at = ? WHERE id = ?', p.key, JSON.stringify(data), t, p.id);
    else db.run('INSERT INTO projects (id, key, next_num, data, updated_at) VALUES (?, ?, ?, ?, ?)', p.id, p.key, Math.max(1, +nextNum || 1), JSON.stringify(data), t);
    return { ...data, nextNum: getProject(p.id).next_num };
  }

  // Issue numbers are allocated here so two devices can never create the same key.
  function upsertIssue(i) {
    checkIssue(i);
    const proj = getProject(i.projectId);
    if (!proj) throw new HttpError(404, '프로젝트가 없습니다 (다른 기기에서 삭제됨?)');
    const { num: wanted, ...data } = i;
    const t = data.updatedAt || nowIso();
    const cur = db.get('SELECT id, project_id, num FROM issues WHERE id = ?', i.id);
    let num;
    if (cur && cur.project_id === i.projectId) num = cur.num;
    else {
      // Keep the client's number when it is free (e.g. undo delete), otherwise take the next one.
      const w = Number.isInteger(wanted) && wanted > 0 && wanted < proj.next_num + 1000 ? wanted : 0;
      const taken = !w || db.get('SELECT id FROM issues WHERE project_id = ? AND num = ?', i.projectId, w);
      num = taken ? proj.next_num : w;
    }
    if (num >= proj.next_num) db.run('UPDATE projects SET next_num = ? WHERE id = ?', num + 1, proj.id);
    if (cur) db.run('UPDATE issues SET project_id = ?, num = ?, data = ?, updated_at = ? WHERE id = ?', i.projectId, num, JSON.stringify(data), t, i.id);
    else db.run('INSERT INTO issues (id, project_id, num, data, updated_at) VALUES (?, ?, ?, ?, ?)', i.id, i.projectId, num, JSON.stringify(data), t);
    return { ...data, num };
  }

  function applyChanges(body) {
    const projects = Array.isArray(body.projects) ? body.projects : [];
    const issues = Array.isArray(body.issues) ? body.issues : [];
    const deleted = Array.isArray(body.deleted) ? body.deleted.filter(id => typeof id === 'string') : [];
    return db.tx(() => {
      const out = { projects: projects.map(upsertProject), issues: [], deleted: [] };
      const deletedSet = new Set(deleted);
      out.issues = issues.filter(i => !deletedSet.has(i?.projectId)).map(upsertIssue);
      for (const id of deleted) {
        if (db.run('DELETE FROM issues WHERE id = ?', id)) out.deleted.push(id);
        else if (db.run('DELETE FROM projects WHERE id = ?', id)) {
          db.run('DELETE FROM issues WHERE project_id = ?', id);
          out.deleted.push(id);
        }
      }
      if (!projectRows().length) throw new HttpError(400, '마지막 프로젝트는 삭제할 수 없습니다');
      // Projects that got new issues have a new nextNum.
      const touched = new Set(out.issues.map(i => i.projectId));
      if (touched.size) {
        const fresh = readState().projects;
        for (const pid of touched) if (!out.projects.some(p => p.id === pid)) {
          const full = fresh.find(p => p.id === pid);
          if (full) out.projects.push(full);
        }
      }
      return out;
    });
  }

  function importAll(body) {
    if (!body || !Array.isArray(body.projects) || !Array.isArray(body.issues) || !body.projects.length)
      throw new HttpError(400, 'projects / issues 배열이 필요합니다');
    db.tx(() => {
      db.run('DELETE FROM issues');
      db.run('DELETE FROM projects');
      for (const p of body.projects) upsertProject(p);
      for (const i of body.issues) if (getProject(i.projectId)) upsertIssue(i);
    });
  }

  function seedIfEmpty() {
    if (projectRows().length) return;
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

  const getSetting = k => db.get('SELECT v FROM settings WHERE k = ?', k)?.v;
  const setSetting = (k, v) => db.run('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);

  seedIfEmpty();
  return { readState, applyChanges, importAll, getSetting, setSetting };
}
