/* Kanban — a lightweight Jira-like board. No build step, no dependencies.
 * Data lives on the server (server.js, SQLite); every change is saved immediately. */
(() => {
  'use strict';


  const TYPES = [
    { id: 'task', name: '작업', icon: '✓' },
    { id: 'story', name: '스토리', icon: 'S' },
    { id: 'bug', name: '버그', icon: '!' },
    { id: 'epic', name: '에픽', icon: 'E' },
  ];
  const PRIORITIES = [
    { id: 'highest', name: '최상', icon: '⇈', rank: 0 },
    { id: 'high', name: '높음', icon: '↑', rank: 1 },
    { id: 'medium', name: '보통', icon: '=', rank: 2 },
    { id: 'low', name: '낮음', icon: '↓', rank: 3 },
    { id: 'lowest', name: '최하', icon: '⇊', rank: 4 },
  ];
  const typeById = Object.fromEntries(TYPES.map(t => [t.id, t]));
  const prioById = Object.fromEntries(PRIORITIES.map(p => [p.id, p]));

  // ---------- utils ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const now = () => new Date().toISOString();
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const el = (tag, attrs = {}, ...children) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else n.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) if (c != null) n.append(c);
    return n;
  };
  const fmtDate = iso => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const dueState = due => {
    if (!due) return '';
    const diff = (new Date(due + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000;
    if (diff < 0) return 'overdue';
    if (diff <= 2) return 'soon';
    return '';
  };
  const fmtDue = due => {
    const [, m, d] = due.split('-');
    return `${+m}/${+d}`;
  };

  // Tiny, safe markdown: escape first, then apply a few patterns.
  function renderMarkdown(src) {
    if (!src.trim()) return '';
    const blocks = [];
    let text = esc(src).replace(/```([\s\S]*?)```/g, (_, code) => {
      blocks.push(`<pre><code>${code.replace(/^\n/, '')}</code></pre>`);
      return `\u0000${blocks.length - 1}\u0000`;
    });
    const inline = s => s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    const out = [];
    for (const para of text.split(/\n{2,}/)) {
      const lines = para.split('\n');
      if (lines.every(l => /^\s*[-*] /.test(l))) {
        out.push('<ul>' + lines.map(l => `<li>${inline(l.replace(/^\s*[-*] /, ''))}</li>`).join('') + '</ul>');
      } else if (/^\u0000\d+\u0000$/.test(para.trim())) {
        out.push(para.trim());
      } else {
        out.push(`<p>${lines.map(inline).join('<br>')}</p>`);
      }
    }
    return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
  }

  // ---------- state (source of truth = server) ----------
  // The browser keeps an in-memory copy. Every change is diffed against a snapshot and sent to the
  // server immediately (POST /api/changes); other open browsers receive it live via /api/events.
  const PREFS_KEY = 'kanban.prefs';
  const EPOCH = '2000-01-01T00:00:00.000Z';
  const clientId = uid();

  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); } catch { }
  const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify({ theme: state.theme, activeProjectId: state.activeProjectId })); } catch { } };

  let state = {
    theme: prefs.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    activeProjectId: prefs.activeProjectId,
    projects: [],
    issues: [],
  };
  let loaded = false;
  let authRequired = false;

  function normalize(s) {
    for (const p of s.projects) {
      p.updatedAt ||= EPOCH;
      p.columns = Array.isArray(p.columns) && p.columns.length ? p.columns : [{ id: uid(), name: '할 일', done: false }];
      p.nextNum = Math.max(+p.nextNum || 1, 1);
    }
    const byId = new Map(s.projects.map(p => [p.id, p]));
    s.issues = s.issues.filter(i => byId.has(i.projectId));
    for (const i of s.issues) {
      const p = byId.get(i.projectId);
      i.labels ||= []; i.checklist ||= []; i.comments ||= [];
      i.createdAt ||= EPOCH; i.updatedAt ||= i.createdAt;
      if (!p.columns.some(c => c.id === i.status)) i.status = p.columns[0].id;
      if (i.num >= p.nextNum) p.nextNum = i.num + 1;
    }
    if (!s.projects.some(p => p.id === s.activeProjectId)) s.activeProjectId = s.projects[0]?.id;
    return s;
  }

  // Change tracking: diff projects/issues against the last state the server knows about.
  const sigOf = o => { const { updatedAt, nextNum, ...rest } = o; return JSON.stringify(rest); };
  let snap = new Map();
  function rebuildSnap() {
    snap = new Map();
    for (const p of state.projects) snap.set(p.id, sigOf(p));
    for (const i of state.issues) snap.set(i.id, sigOf(i));
  }
  function collectChanges() {
    const t = now();
    const out = { projects: [], issues: [], deleted: [] };
    const seen = new Set();
    for (const p of state.projects) {
      seen.add(p.id);
      const sig = sigOf(p);
      if (snap.get(p.id) !== sig) { p.updatedAt = t; snap.set(p.id, sig); out.projects.push(p); }
    }
    for (const i of state.issues) {
      seen.add(i.id);
      const sig = sigOf(i);
      if (snap.get(i.id) !== sig) { i.updatedAt = t; snap.set(i.id, sig); out.issues.push(i); }
    }
    for (const id of [...snap.keys()]) if (!seen.has(id)) { snap.delete(id); out.deleted.push(id); }
    return out;
  }

  // ---------- server I/O ----------
  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method, cache: 'no-store', credentials: 'same-origin',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch { const e = new Error('서버에 연결할 수 없습니다'); e.status = 0; throw e; }
    let data = null;
    try { data = await res.json(); } catch { }
    if (!res.ok) { const e = new Error(data?.error || `HTTP ${res.status}`); e.status = res.status; throw e; }
    return data;
  }

  // Outgoing queue: changes are merged per entity and sent one request at a time, in order.
  const outbox = { projects: new Map(), issues: new Map(), deleted: new Set() };
  let sending = false, retryTimer = null, retryDelay = 1000;
  let saveStatus = 'ok', saveMessage = '';
  const outboxSize = () => outbox.projects.size + outbox.issues.size + outbox.deleted.size;

  function enqueue(ch) {
    for (const p of ch.projects) outbox.projects.set(p.id, p);
    for (const i of ch.issues) { outbox.issues.set(i.id, i); outbox.deleted.delete(i.id); }
    for (const id of ch.deleted) { outbox.deleted.add(id); outbox.projects.delete(id); outbox.issues.delete(id); }
  }

  async function sendOutbox() {
    if (sending || !outboxSize()) return;
    clearTimeout(retryTimer);
    sending = true;
    setSaveStatus('busy');
    const batch = {
      clientId,
      projects: [...outbox.projects.values()].map(o => ({ ...o })),
      issues: [...outbox.issues.values()].map(o => ({ ...o })),
      deleted: [...outbox.deleted],
    };
    outbox.projects.clear(); outbox.issues.clear(); outbox.deleted.clear();
    try {
      const saved = await api('POST', '/api/changes', batch);
      retryDelay = 1000;
      applySaved(saved);
      setSaveStatus(outboxSize() ? 'busy' : 'ok');
    } catch (e) {
      if (e.status === 401) { requeue(batch); setSaveStatus('error', '로그인이 필요합니다'); showLogin(); }
      else if (e.status >= 400 && e.status < 500) {
        // Rejected by the server (validation, duplicate key…): drop it and reload the truth.
        setSaveStatus('error', e.message);
        toast('저장 실패: ' + e.message);
        await reloadState();
      } else {
        requeue(batch);
        setSaveStatus(e.status === 0 ? 'offline' : 'error', e.message);
        retryTimer = setTimeout(sendOutbox, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15000);
      }
    } finally {
      sending = false;
      if (outboxSize() && saveStatus === 'busy') sendOutbox();
    }
  }
  function requeue(batch) {
    // Newer edits made while the request was in flight take precedence.
    for (const p of batch.projects) if (!outbox.projects.has(p.id) && !outbox.deleted.has(p.id)) outbox.projects.set(p.id, getProjectById(p.id) || p);
    for (const i of batch.issues) if (!outbox.issues.has(i.id) && !outbox.deleted.has(i.id)) { const cur = getIssue(i.id); if (cur) outbox.issues.set(i.id, cur); }
    for (const id of batch.deleted) outbox.deleted.add(id);
  }

  // Server may assign a different issue number (another device took it) or a new nextNum.
  function applySaved(saved) {
    let changed = false;
    for (const sp of saved.projects || []) {
      const p = getProjectById(sp.id);
      if (p && sp.nextNum > p.nextNum) p.nextNum = sp.nextNum;
    }
    for (const si of saved.issues || []) {
      const i = getIssue(si.id);
      if (i && i.num !== si.num) {
        const before = sigOf(i);
        i.num = si.num;
        if (snap.get(i.id) === before) snap.set(i.id, sigOf(i));
        changed = true;
        if (currentIssueId === i.id) history.replaceState(null, '', '#' + issueKey(i));
      }
    }
    if (changed) refreshUi();
  }

  // Changes made on other devices / tabs.
  function applyRemote(ch) {
    if (ch.origin === clientId) return;
    for (const rp of ch.projects || []) {
      if (outbox.projects.has(rp.id)) continue;
      const idx = state.projects.findIndex(p => p.id === rp.id);
      if (idx >= 0) state.projects[idx] = rp; else state.projects.push(rp);
      snap.set(rp.id, sigOf(rp));
    }
    for (const ri of ch.issues || []) {
      if (outbox.issues.has(ri.id)) continue;
      const idx = state.issues.findIndex(i => i.id === ri.id);
      if (idx >= 0) state.issues[idx] = ri; else state.issues.push(ri);
      snap.set(ri.id, sigOf(ri));
    }
    const del = new Set(ch.deleted || []);
    if (del.size) {
      state.projects = state.projects.filter(p => !del.has(p.id));
      state.issues = state.issues.filter(i => !del.has(i.id) && !del.has(i.projectId));
      for (const id of del) snap.delete(id);
    }
    normalize(state);
    rebuildSnapKeepingPending();
    refreshUi();
  }
  // normalize() may repair references; record those as known-to-server unless they are pending.
  function rebuildSnapKeepingPending() {
    const known = new Set([...state.projects.map(p => p.id), ...state.issues.map(i => i.id)]);
    for (const id of [...snap.keys()]) if (!known.has(id)) snap.delete(id);
  }

  async function reloadState() {
    const data = await api('GET', '/api/state');
    authRequired = !!data.auth;
    realtime = data.realtime || 'sse';
    state.projects = data.projects;
    state.issues = data.issues;
    normalize(state);
    rebuildSnap();
    loaded = true;
    refreshUi();
  }

  // Live updates: SSE on the Node server, WebSocket on Cloudflare (Durable Object).
  let realtime = 'sse';
  let events = null, ws = null, wsTimer = null, wsPing = null, wsDelay = 1000;
  let liveOpened = false;
  function onLiveMessage(msg) {
    if (msg.type === 'reload') reloadState().catch(() => { });
    else if (msg.type === 'change' || msg.projects) applyRemote(msg);
  }
  function onLiveOpen() {
    // After a reconnect we may have missed events: fetch everything again (once our queue is flushed).
    if (liveOpened && !outboxSize() && !sending) reloadState().catch(() => { });
    liveOpened = true;
    if (saveStatus === 'offline') { setSaveStatus(outboxSize() ? 'busy' : 'ok'); sendOutbox(); }
  }
  function onLiveLost() { if (!outboxSize()) setSaveStatus('offline', '서버 연결 끊김 — 재연결 중'); }

  function connectEvents() {
    if (realtime === 'ws') return connectWs();
    if (events) events.close();
    events = new EventSource('/api/events');
    events.addEventListener('change', e => { try { applyRemote(JSON.parse(e.data)); } catch (err) { console.warn(err); } });
    events.addEventListener('reload', () => reloadState().catch(() => { }));
    events.addEventListener('open', onLiveOpen);
    events.addEventListener('error', onLiveLost);
  }
  function connectWs() {
    clearTimeout(wsTimer); clearInterval(wsPing);
    if (ws) { ws.onclose = null; ws.close(); }
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/ws`);
    ws.onopen = () => { wsDelay = 1000; onLiveOpen(); wsPing = setInterval(() => { if (ws.readyState === 1) ws.send('ping'); }, 30000); };
    ws.onmessage = e => { if (e.data === 'pong') return; try { onLiveMessage(JSON.parse(e.data)); } catch (err) { console.warn(err); } };
    ws.onclose = () => {
      clearInterval(wsPing);
      onLiveLost();
      wsTimer = setTimeout(connectWs, wsDelay);
      wsDelay = Math.min(wsDelay * 2, 15000);
    };
  }
  // Phones suspend background tabs: reconnect and refresh when the page becomes visible again.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !loaded) return;
    if (realtime === 'ws' && (!ws || ws.readyState > 1)) connectWs();
    else if (!outboxSize() && !sending) reloadState().catch(() => { });
  });

  let saveTimer = null;
  function flushSave() {
    if (saveTimer == null) return;
    clearTimeout(saveTimer); saveTimer = null;
    if (!loaded) return;
    const ch = collectChanges();
    if (ch.projects.length || ch.issues.length || ch.deleted.length) { enqueue(ch); sendOutbox(); }
  }
  // Called after every mutation. Batches only what happens in the same tick (e.g. a drag that
  // reorders several cards, or fast typing) — the request goes out right away.
  function save() {
    savePrefs();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, 120);
  }
  window.addEventListener('beforeunload', e => {
    if (saveTimer != null) flushSave();
    if (outboxSize() || sending) { e.preventDefault(); e.returnValue = ''; }
  });

  function setSaveStatus(s, msg = '') { saveStatus = s; saveMessage = msg; renderSaveStatus(); }
  function renderSaveStatus() {
    const b = $('#syncBtn');
    if (!b) return;
    const labels = { ok: '저장됨', busy: '저장 중…', error: '저장 실패', offline: '연결 끊김' };
    b.dataset.status = saveStatus;
    b.querySelector('.sync-label').textContent = labels[saveStatus] + (saveStatus !== 'ok' && outboxSize() ? ` (${outboxSize()})` : '');
    b.title = (saveMessage || labels[saveStatus]) + (outboxSize() ? `\n전송 대기 중인 변경 ${outboxSize()}개 — 자동 재시도` : '\n모든 변경이 서버에 저장되었습니다');
  }

  function refreshUi() {
    if (!loaded) return;
    if (ui.quickAddCol && !project().columns.some(c => c.id === ui.quickAddCol)) ui.quickAddCol = null;
    render();
    if (!issueOverlay.hidden && !creating) fillIssueModal();
  }

  const getProjectById = id => state.projects.find(p => p.id === id);

  const project = () => state.projects.find(p => p.id === state.activeProjectId) || state.projects[0];
  const projectIssues = () => state.issues.filter(i => i.projectId === project().id);
  const issueKey = i => `${(state.projects.find(p => p.id === i.projectId) || project()).key}-${i.num}`;
  const getIssue = id => state.issues.find(i => i.id === id);
  const colById = id => project().columns.find(c => c.id === id);
  const isDone = i => !!colById(i.status)?.done;

  function touch(issue) { issue.updatedAt = now(); save(); }

  // ---------- UI state ----------
  const ui = {
    view: 'board',
    search: '',
    type: '',
    priority: '',
    label: '',
    sort: { key: 'updatedAt', asc: false },
    quickAddCol: null,
  };
  try { Object.assign(ui, JSON.parse(sessionStorage.getItem('kanban.ui') || '{}'), { quickAddCol: null }); } catch { }
  const saveUi = () => { try { sessionStorage.setItem('kanban.ui', JSON.stringify(ui)); } catch { } };

  function matches(i) {
    if (ui.type && i.type !== ui.type) return false;
    if (ui.priority && i.priority !== ui.priority) return false;
    if (ui.label && !i.labels.includes(ui.label)) return false;
    if (ui.search) {
      const q = ui.search.toLowerCase();
      const hay = `${issueKey(i)} ${i.title} ${i.desc} ${i.labels.join(' ')}`.toLowerCase();
      if (!q.split(/\s+/).every(t => hay.includes(t))) return false;
    }
    return true;
  }
  const filtersActive = () => !!(ui.search || ui.type || ui.priority || ui.label);

  // ---------- rendering ----------
  const boardEl = $('#boardView');
  const listEl = $('#listView');

  function render() {
    if (!loaded) return;
    applyTheme();
    renderHeader();
    if (ui.view === 'board') { boardEl.hidden = false; listEl.hidden = true; renderBoard(); }
    else { boardEl.hidden = true; listEl.hidden = false; renderList(); }
    document.title = `${project().name} · Kanban`;
  }

  function applyTheme() { document.documentElement.dataset.theme = state.theme; }

  function allLabels() {
    const set = new Set();
    projectIssues().forEach(i => i.labels.forEach(l => set.add(l)));
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  function fillSelect(sel, items, value, placeholder) {
    sel.innerHTML = '';
    if (placeholder) sel.append(el('option', { value: '', text: placeholder }));
    for (const it of items) sel.append(el('option', { value: it.value, text: it.text }));
    sel.value = value;
    if (sel.value !== value) sel.value = '';
  }

  function renderHeader() {
    fillSelect($('#projectSelect'), [
      ...state.projects.map(p => ({ value: p.id, text: `${p.name} (${p.key})` })),
      { value: '__new', text: '+ 새 프로젝트…' },
    ], project().id);
    fillSelect($('#filterType'), TYPES.map(t => ({ value: t.id, text: t.name })), ui.type, '모든 유형');
    fillSelect($('#filterPriority'), PRIORITIES.map(p => ({ value: p.id, text: p.name })), ui.priority, '모든 우선순위');
    const labels = allLabels();
    if (ui.label && !labels.includes(ui.label)) ui.label = '';
    fillSelect($('#filterLabel'), labels.map(l => ({ value: l, text: l })), ui.label, '모든 라벨');
    if (document.activeElement !== $('#search')) $('#search').value = ui.search;
    $('#clearFilters').hidden = !filtersActive();
    document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === ui.view));
  }

  function typeIcon(type) {
    const t = typeById[type] || TYPES[0];
    return el('span', { class: `type-icon type-${t.id}`, title: t.name, text: t.icon });
  }
  function prioIcon(prio) {
    const p = prioById[prio] || prioById.medium;
    return el('span', { class: `prio prio-${p.id}`, title: `우선순위: ${p.name}`, text: p.icon });
  }

  function cardEl(i) {
    const card = el('div', { class: 'card' + (isDone(i) ? ' done' : ''), tabindex: 0, dataset: { id: i.id } });
    if (i.labels.length) card.append(el('div', { class: 'labels' }, i.labels.map(l => el('span', { class: 'chip', text: l }))));
    card.append(el('div', { class: 'title', text: i.title }));
    const row = el('div', { class: 'row' }, typeIcon(i.type), prioIcon(i.priority));
    if (i.checklist.length) {
      const done = i.checklist.filter(c => c.done).length;
      row.append(el('span', { title: '체크리스트', text: `☑ ${done}/${i.checklist.length}` }));
    }
    if (i.comments.length) row.append(el('span', { title: '댓글', text: `💬 ${i.comments.length}` }));
    if (i.due) row.append(el('span', { class: `due ${isDone(i) ? '' : dueState(i.due)}`, title: `마감 ${i.due}`, text: `📅 ${fmtDue(i.due)}` }));
    if (i.points != null && i.points !== '') row.append(el('span', { class: 'points', title: '포인트', text: i.points }));
    row.append(el('span', { class: 'key', text: issueKey(i) }));
    card.append(row);
    return card;
  }

  function renderBoard() {
    const p = project();
    const issues = projectIssues();
    const scroll = boardEl.scrollLeft;
    const prevQa = boardEl.querySelector('.quick-add textarea');
    const qaText = prevQa ? prevQa.value : '';
    const qaFocused = !prevQa || document.activeElement === prevQa;
    const colScroll = {};
    boardEl.querySelectorAll('.column').forEach(c => { colScroll[c.dataset.col] = c.querySelector('.cards').scrollTop; });
    boardEl.innerHTML = '';

    for (const col of p.columns) {
      const all = issues.filter(i => i.status === col.id).sort((a, b) => a.order - b.order);
      const shown = all.filter(matches);
      const overWip = col.wip && all.length > col.wip;
      const count = filtersActive() ? `${shown.length}/${all.length}` : `${all.length}`;

      const nameEl = el('span', { class: 'col-name', title: '더블클릭해서 이름 변경', text: col.name });
      nameEl.addEventListener('dblclick', () => renameColumnInline(col, nameEl));

      const head = el('div', { class: 'col-head' },
        nameEl,
        el('span', { class: 'col-count', title: col.wip ? `WIP 제한 ${col.wip}` : '이슈 수', text: col.wip ? `${count} / ${col.wip}` : count }),
        col.done ? el('span', { title: '완료 컬럼', text: '✓' }) : null,
        el('button', { class: 'icon-btn', title: '컬럼 설정', text: '⋯', onclick: () => columnMenu(col) }),
      );
      const cards = el('div', { class: 'cards', dataset: { col: col.id } }, shown.map(cardEl));
      const column = el('div', { class: 'column' + (overWip ? ' over-wip' : ''), dataset: { col: col.id } }, head, cards);

      if (ui.quickAddCol === col.id) column.append(quickAddEl(col));
      else column.append(el('button', { class: 'add-card', text: '+ 이슈 만들기', onclick: () => { ui.quickAddCol = col.id; renderBoard(); } }));

      boardEl.append(column);
    }
    boardEl.append(el('button', { class: 'add-column', text: '+ 컬럼 추가', onclick: addColumn }));

    boardEl.scrollLeft = scroll;
    boardEl.querySelectorAll('.column').forEach(c => { if (colScroll[c.dataset.col]) c.querySelector('.cards').scrollTop = colScroll[c.dataset.col]; });
    const qa = boardEl.querySelector('.quick-add textarea');
    if (qa) { qa.value = qaText; if (qaFocused) qa.focus(); }
  }

  // Parse "#label" and "!priority" tokens from quick-add text.
  function parseQuick(text) {
    const labels = [];
    let priority = null;
    let type = null;
    const prioAlias = { '!!': 'highest', '!highest': 'highest', '!high': 'high', '!medium': 'medium', '!low': 'low', '!lowest': 'lowest', '!최상': 'highest', '!높음': 'high', '!보통': 'medium', '!낮음': 'low', '!최하': 'lowest' };
    const typeAlias = { bug: 'bug', 버그: 'bug', story: 'story', 스토리: 'story', epic: 'epic', 에픽: 'epic', task: 'task', 작업: 'task' };
    const title = text.replace(/(^|\s)(#[^\s#]+|!!|![^\s!]+)/g, (m, pre, tok) => {
      if (tok.startsWith('#')) {
        const name = tok.slice(1);
        if (typeAlias[name.toLowerCase()] && !type) { type = typeAlias[name.toLowerCase()]; return pre; }
        labels.push(name); return pre;
      }
      const p = prioAlias[tok.toLowerCase()];
      if (p) { priority = p; return pre; }
      return m;
    }).replace(/\s+/g, ' ').trim();
    return { title, labels, priority, type };
  }

  function quickAddEl(col) {
    const ta = el('textarea', { rows: 2, placeholder: '무엇을 해야 하나요?' });
    const wrap = el('div', { class: 'quick-add' }, ta, el('div', { class: 'hint', text: 'Enter 생성 · Esc 취소 · #라벨 #bug !high' }));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        const parsed = parseQuick(ta.value);
        if (!parsed.title) return;
        createIssue({ status: col.id, ...parsed, type: parsed.type || 'task', priority: parsed.priority || 'medium' });
        ta.value = '';
        renderBoard();
      } else if (e.key === 'Escape') {
        e.stopPropagation();
        ui.quickAddCol = null; renderBoard();
      }
    });
    ta.addEventListener('blur', () => setTimeout(() => {
      if (ui.quickAddCol === col.id && !ta.value.trim() && document.activeElement !== ta) { ui.quickAddCol = null; renderBoard(); }
    }, 150));
    return wrap;
  }

  function createIssue(fields) {
    const p = project();
    const status = fields.status || p.columns[0].id;
    const sameCol = state.issues.filter(i => i.projectId === p.id && i.status === status);
    const issue = {
      id: uid(), projectId: p.id, num: p.nextNum++, title: '', desc: '', type: 'task', priority: 'medium',
      labels: [], due: '', points: null, checklist: [], comments: [], createdAt: now(), updatedAt: now(),
      ...fields,
      status,
      order: sameCol.length ? Math.max(...sameCol.map(i => i.order)) + 1 : 0,
    };
    state.issues.push(issue);
    save();
    return issue;
  }

  // ---------- list view ----------
  const LIST_COLS = [
    { key: 'type', name: 'T' },
    { key: 'num', name: '키' },
    { key: 'title', name: '요약' },
    { key: 'status', name: '상태' },
    { key: 'priority', name: '우선순위' },
    { key: 'due', name: '마감' },
    { key: 'updatedAt', name: '업데이트' },
  ];
  function sortValue(i, key) {
    switch (key) {
      case 'priority': return prioById[i.priority]?.rank ?? 9;
      case 'status': return project().columns.findIndex(c => c.id === i.status);
      case 'due': return i.due || '9999';
      case 'title': return i.title.toLowerCase();
      default: return i[key];
    }
  }
  function renderList() {
    const rows = projectIssues().filter(matches);
    const { key, asc } = ui.sort;
    rows.sort((a, b) => {
      const va = sortValue(a, key), vb = sortValue(b, key);
      return (va < vb ? -1 : va > vb ? 1 : 0) * (asc ? 1 : -1);
    });
    listEl.innerHTML = '';
    if (!rows.length) {
      listEl.append(el('div', { class: 'empty', text: filtersActive() ? '조건에 맞는 이슈가 없습니다.' : '이슈가 없습니다. C 키를 눌러 만들어 보세요.' }));
      return;
    }
    const thead = el('tr', {}, LIST_COLS.map(c => el('th', {
      class: (key === c.key ? 'sorted' : '') + (key === c.key && asc ? ' asc' : ''),
      text: c.name,
      onclick: () => { ui.sort = { key: c.key, asc: key === c.key ? !asc : true }; saveUi(); renderList(); },
    })));
    const tbody = el('tbody', {}, rows.map(i => {
      const col = colById(i.status);
      return el('tr', { onclick: () => openIssue(i.id) },
        el('td', {}, typeIcon(i.type)),
        el('td', { text: issueKey(i) }),
        el('td', { class: 'title-cell' }, el('span', { text: i.title }), ' ', ...i.labels.map(l => el('span', { class: 'chip', text: l }))),
        el('td', {}, el('span', { class: 'status-pill' + (col?.done ? ' done' : ''), text: col?.name || '?' })),
        el('td', {}, prioIcon(i.priority), ' ', prioById[i.priority]?.name || ''),
        el('td', {}, i.due ? el('span', { class: `due ${col?.done ? '' : dueState(i.due)}`, text: i.due }) : ''),
        el('td', { class: 'muted', text: fmtDate(i.updatedAt) }),
      );
    }));
    listEl.append(el('table', {}, el('thead', {}, thead), tbody));
  }

  // ---------- drag & drop (pointer events: works for mouse + touch) ----------
  let drag = null;
  boardEl.addEventListener('pointerdown', e => {
    const card = e.target.closest('.card');
    if (!card || e.button !== 0) return;
    drag = { card, id: card.dataset.id, startX: e.clientX, startY: e.clientY, started: false, pointerId: e.pointerId };
  });
  window.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
      startDrag(e);
    }
    moveDrag(e);
  });
  window.addEventListener('pointerup', e => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const d = drag; drag = null;
    if (!d.started) { openIssue(d.id); return; }
    endDrag(d, true);
  });
  window.addEventListener('pointercancel', () => { if (drag?.started) endDrag(drag, false); drag = null; });

  function startDrag(e) {
    const rect = drag.card.getBoundingClientRect();
    drag.started = true;
    drag.offX = drag.startX - rect.left;
    drag.offY = drag.startY - rect.top;
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.classList.add('drag-ghost');
    drag.ghost.style.width = rect.width + 'px';
    document.body.append(drag.ghost);
    drag.placeholder = el('div', { class: 'placeholder' });
    drag.placeholder.style.height = rect.height + 'px';
    drag.card.replaceWith(drag.placeholder);
    document.body.classList.add('dragging');
    drag.scrollTimer = setInterval(autoScroll, 16);
  }

  function moveDrag(e) {
    drag.x = e.clientX; drag.y = e.clientY;
    drag.ghost.style.left = (e.clientX - drag.offX) + 'px';
    drag.ghost.style.top = (e.clientY - drag.offY) + 'px';
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const column = under?.closest('.column');
    boardEl.querySelectorAll('.drop-target').forEach(c => c !== column && c.classList.remove('drop-target'));
    if (!column) return;
    column.classList.add('drop-target');
    const list = column.querySelector('.cards');
    const cards = [...list.querySelectorAll('.card')];
    const after = cards.find(c => {
      const r = c.getBoundingClientRect();
      return e.clientY < r.top + r.height / 2;
    });
    if (after) { if (drag.placeholder.nextSibling !== after) list.insertBefore(drag.placeholder, after); }
    else if (list.lastElementChild !== drag.placeholder) list.append(drag.placeholder);
  }

  function autoScroll() {
    if (!drag?.started || drag.x == null) return;
    const edge = 60, speed = 14;
    const br = boardEl.getBoundingClientRect();
    if (drag.x < br.left + edge) boardEl.scrollLeft -= speed;
    else if (drag.x > br.right - edge) boardEl.scrollLeft += speed;
    const list = drag.placeholder.parentElement;
    if (list) {
      const lr = list.getBoundingClientRect();
      if (drag.y < lr.top + 40) list.scrollTop -= speed;
      else if (drag.y > lr.bottom - 40) list.scrollTop += speed;
    }
  }

  function endDrag(d, commit) {
    clearInterval(d.scrollTimer);
    d.ghost.remove();
    document.body.classList.remove('dragging');
    boardEl.querySelectorAll('.drop-target').forEach(c => c.classList.remove('drop-target'));
    if (commit && d.placeholder.parentElement) {
      const list = d.placeholder.parentElement;
      const colId = list.dataset.col;
      const issue = getIssue(d.id);
      const col = colById(colId);
      // Ordered visible ids in the target column with the moved card at the placeholder position.
      const visibleIds = [...list.children].map(n => n === d.placeholder ? d.id : n.dataset.id).filter(Boolean);
      // Merge with hidden (filtered-out) cards, keeping their relative order.
      const colIssues = projectIssues().filter(i => i.status === colId && i.id !== d.id).sort((a, b) => a.order - b.order);
      const visibleSet = new Set(visibleIds);
      const merged = [];
      let vi = 0;
      for (const i of colIssues) {
        if (visibleSet.has(i.id)) { while (visibleIds[vi] !== i.id) merged.push(visibleIds[vi++]); merged.push(visibleIds[vi++]); }
        else merged.push(i.id);
      }
      while (vi < visibleIds.length) merged.push(visibleIds[vi++]);
      merged.forEach((id, idx) => { getIssue(id).order = idx; });
      if (issue.status !== colId) {
        const from = colById(issue.status)?.name;
        issue.status = colId;
        issue.comments.push({ id: uid(), system: true, text: `상태 변경: ${from} → ${col.name}`, at: now() });
        if (col.wip && projectIssues().filter(i => i.status === colId).length > col.wip) toast(`"${col.name}" WIP 제한(${col.wip}) 초과`);
      }
      touch(issue);
    }
    renderBoard();
    const moved = boardEl.querySelector(`.card[data-id="${d.id}"]`);
    if (moved) moved.focus({ preventScroll: true });
  }

  // ---------- columns ----------
  function renameColumnInline(col, nameEl) {
    const input = el('input', { class: 'col-name-input', value: col.name });
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const finish = ok => {
      if (ok && input.value.trim()) { col.name = input.value.trim(); save(); }
      renderBoard();
    };
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) finish(true);
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    });
    input.addEventListener('blur', () => finish(true), { once: true });
  }

  function addColumn() {
    dialog('컬럼 추가', body => {
      const name = el('input', { placeholder: '예: QA', maxlength: 40 });
      body.append(el('label', {}, '이름', name), btns('추가', () => {
        if (!name.value.trim()) return false;
        const p = project();
        const doneIdx = p.columns.findIndex(c => c.done);
        const col = { id: uid(), name: name.value.trim(), done: false };
        // Insert before the first "done" column so the workflow stays left→right.
        if (doneIdx >= 0) p.columns.splice(doneIdx, 0, col); else p.columns.push(col);
        save(); render();
      }));
      setTimeout(() => name.focus());
    });
  }

  function columnMenu(col) {
    const p = project();
    const idx = p.columns.indexOf(col);
    dialog(`컬럼: ${col.name}`, body => {
      const name = el('input', { value: col.name, maxlength: 40 });
      const wip = el('input', { type: 'number', min: 0, value: col.wip || '', placeholder: '제한 없음' });
      const done = el('input', { type: 'checkbox' }); done.checked = !!col.done;
      body.append(
        el('label', {}, '이름', name),
        el('label', {}, 'WIP 제한 (이 컬럼 최대 이슈 수)', wip),
        el('label', { style: 'flex-direction:row;align-items:center;gap:8px' }, done, '완료 컬럼으로 취급 (취소선, 마감 경고 해제)'),
        btns('저장', () => {
          if (name.value.trim()) col.name = name.value.trim();
          col.wip = +wip.value > 0 ? +wip.value : undefined;
          col.done = done.checked;
          save(); render();
        }),
        el('hr'),
        el('button', { class: 'menu-item', text: '← 왼쪽으로 이동', disabled: idx === 0, onclick: () => { p.columns.splice(idx, 1); p.columns.splice(idx - 1, 0, col); save(); closeDialog(); render(); } }),
        el('button', { class: 'menu-item', text: '오른쪽으로 이동 →', disabled: idx === p.columns.length - 1, onclick: () => { p.columns.splice(idx, 1); p.columns.splice(idx + 1, 0, col); save(); closeDialog(); render(); } }),
        el('button', { class: 'menu-item danger', text: '컬럼 삭제', onclick: () => deleteColumn(col) }),
      );
    });
  }

  function deleteColumn(col) {
    const p = project();
    if (p.columns.length <= 1) { toast('마지막 컬럼은 삭제할 수 없습니다'); return; }
    const inCol = projectIssues().filter(i => i.status === col.id);
    const target = p.columns.find(c => c.id !== col.id);
    if (inCol.length && !confirm(`이 컬럼의 이슈 ${inCol.length}개는 "${target.name}"(으)로 이동됩니다. 삭제할까요?`)) return;
    const base = projectIssues().filter(i => i.status === target.id).length;
    inCol.forEach((i, n) => { i.status = target.id; i.order = base + n; });
    p.columns = p.columns.filter(c => c.id !== col.id);
    save(); closeDialog(); render();
  }

  // ---------- projects ----------
  function projectDialog(existing) {
    dialog(existing ? '프로젝트 설정' : '새 프로젝트', body => {
      const name = el('input', { value: existing?.name || '', placeholder: '예: 사이드 프로젝트', maxlength: 60 });
      const key = el('input', { value: existing?.key || '', placeholder: '예: SIDE', maxlength: 10, style: 'text-transform:uppercase' });
      name.addEventListener('input', () => {
        if (!existing && !key.dataset.touched) key.value = name.value.replace(/[^A-Za-z]/g, '').slice(0, 4).toUpperCase();
      });
      key.addEventListener('input', () => { key.dataset.touched = 1; });
      body.append(el('label', {}, '이름', name), el('label', {}, '키 (이슈 번호 접두사, 영문 대문자)', key), btns(existing ? '저장' : '만들기', () => {
        const k = key.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        if (!name.value.trim() || !/^[A-Z][A-Z0-9]*$/.test(k)) { toast('이름과 키(영문으로 시작)를 입력하세요'); return false; }
        if (state.projects.some(p => p.key === k && p !== existing)) { toast('이미 사용 중인 키입니다'); return false; }
        if (existing) { existing.name = name.value.trim(); existing.key = k; }
        else {
          const id = uid();
          state.projects.push({
            id, key: k, name: name.value.trim(), nextNum: 1,
            columns: [
              { id: uid(), name: '할 일', done: false },
              { id: uid(), name: '진행 중', done: false },
              { id: uid(), name: '완료', done: true },
            ],
          });
          state.activeProjectId = id;
        }
        save(); render();
      }));
      if (existing && state.projects.length > 1) {
        body.append(el('hr'), el('button', {
          class: 'menu-item danger', text: '프로젝트 삭제', onclick: () => {
            const n = state.issues.filter(i => i.projectId === existing.id).length;
            if (!confirm(`"${existing.name}"과(와) 이슈 ${n}개를 영구 삭제할까요?`)) return;
            state.issues = state.issues.filter(i => i.projectId !== existing.id);
            state.projects = state.projects.filter(p => p !== existing);
            state.activeProjectId = state.projects[0].id;
            save(); closeDialog(); render();
          },
        }));
      }
      setTimeout(() => name.focus());
    });
  }

  // ---------- issue modal ----------
  const issueOverlay = $('#issueOverlay');
  let currentIssueId = null;
  let creating = false;   // modal is a draft for a new issue
  let draft = null;

  const f = {
    key: $('#issueKey'), title: $('#issueTitle'), desc: $('#issueDesc'), descPreview: $('#descPreview'), descToggle: $('#descToggle'),
    status: $('#issueStatus'), type: $('#issueType'), priority: $('#issuePriority'), due: $('#issueDue'), points: $('#issuePoints'),
    labelsEdit: $('#labelsEdit'), labelInput: $('#labelInput'), labelList: $('#labelList'),
    checklist: $('#checklist'), checkInput: $('#checkInput'), checkBar: $('#checkBar'), checkProgress: $('#checkProgress'),
    comments: $('#comments'), commentInput: $('#commentInput'), commentBtn: $('#commentBtn'),
    meta: $('#issueMeta'), del: $('#deleteIssueBtn'), createBtn: $('#createConfirmBtn'),
  };

  const cur = () => creating ? draft : getIssue(currentIssueId);

  function openIssue(id) {
    creating = false; currentIssueId = id; draft = null;
    fillIssueModal();
    issueOverlay.hidden = false;
    history.replaceState(null, '', '#' + issueKey(getIssue(id)));
  }

  function openCreate(statusId) {
    creating = true; currentIssueId = null;
    const p = project();
    draft = { title: '', desc: '', type: 'task', priority: 'medium', status: statusId || p.columns[0].id, labels: [], due: '', points: null, checklist: [], comments: [] };
    fillIssueModal();
    issueOverlay.hidden = false;
    setDescEditing(false);
    f.title.focus();
  }

  function closeIssue() {
    if (creating && draft.title.trim() && !confirm('작성 중인 이슈를 버릴까요?')) return;
    if (!creating) commitDesc();
    issueOverlay.hidden = true;
    currentIssueId = null; creating = false; draft = null;
    history.replaceState(null, '', location.pathname + location.search);
    render();
  }

  function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; }

  function fillIssueModal() {
    const i = cur();
    if (!i) { issueOverlay.hidden = true; return; }
    f.key.textContent = creating ? '새 이슈' : issueKey(i);
    if (document.activeElement !== f.title) f.title.value = i.title;
    requestAnimationFrame(() => autoGrow(f.title));
    fillSelect(f.status, project().columns.map(c => ({ value: c.id, text: c.name })), i.status);
    fillSelect(f.type, TYPES.map(t => ({ value: t.id, text: `${t.icon}  ${t.name}` })), i.type);
    fillSelect(f.priority, PRIORITIES.map(p => ({ value: p.id, text: `${p.icon}  ${p.name}` })), i.priority);
    f.due.value = i.due || '';
    f.points.value = i.points ?? '';
    if (f.desc.hidden) f.desc.value = i.desc;
    renderDescPreview();
    renderLabels();
    renderChecklist();
    renderComments();
    f.del.hidden = creating;
    f.createBtn.hidden = !creating;
    f.commentInput.closest('.comment-box').hidden = creating;
    f.meta.innerHTML = creating ? '' :
      `만든 날짜 ${esc(fmtDate(i.createdAt))}<br>업데이트 ${esc(fmtDate(i.updatedAt))}`;
  }

  function update(fn) {
    const i = cur();
    if (!i) return;
    fn(i);
    if (!creating) { touch(i); render(); }
  }

  f.title.addEventListener('input', () => { autoGrow(f.title); update(i => { i.title = f.title.value.replace(/\n/g, ' '); }); });
  f.title.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      if (creating && (e.metaKey || e.ctrlKey)) confirmCreate(); else f.title.blur();
    }
  });
  f.status.addEventListener('change', () => update(i => {
    if (i.status === f.status.value) return;
    const from = colById(i.status)?.name, to = colById(f.status.value)?.name;
    i.status = f.status.value;
    const sameCol = projectIssues().filter(x => x.status === i.status && x !== i);
    i.order = sameCol.length ? Math.max(...sameCol.map(x => x.order)) + 1 : 0;
    if (!creating) i.comments.push({ id: uid(), system: true, text: `상태 변경: ${from} → ${to}`, at: now() });
    renderComments();
  }));
  f.type.addEventListener('change', () => update(i => { i.type = f.type.value; }));
  f.priority.addEventListener('change', () => update(i => { i.priority = f.priority.value; }));
  f.due.addEventListener('change', () => update(i => { i.due = f.due.value; }));
  f.points.addEventListener('input', () => update(i => { i.points = f.points.value === '' ? null : Math.max(0, +f.points.value); }));

  // description
  function renderDescPreview() {
    const i = cur();
    const html = renderMarkdown(i.desc || '');
    f.descPreview.innerHTML = html || '설명을 추가하려면 클릭하세요…';
    f.descPreview.classList.toggle('empty-desc', !html);
  }
  function setDescEditing(on) {
    f.desc.hidden = !on;
    f.descPreview.hidden = on;
    f.descToggle.textContent = on ? '미리보기' : '편집';
    if (on) { f.desc.value = cur().desc; f.desc.focus(); }
    else renderDescPreview();
  }
  function commitDesc() {
    if (f.desc.hidden) return;
    const v = f.desc.value;
    if (cur() && cur().desc !== v) update(i => { i.desc = v; });
  }
  f.descPreview.addEventListener('click', e => { if (!e.target.closest('a')) setDescEditing(true); });
  f.descPreview.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); setDescEditing(true); } });
  f.descToggle.addEventListener('click', () => { if (!f.desc.hidden) commitDesc(); setDescEditing(f.desc.hidden); });
  f.desc.addEventListener('input', () => { const i = cur(); if (creating) i.desc = f.desc.value; });
  f.desc.addEventListener('blur', () => { commitDesc(); });
  f.desc.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.stopPropagation(); commitDesc(); setDescEditing(false); }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commitDesc(); if (creating) confirmCreate(); else setDescEditing(false); }
  });

  // labels
  function renderLabels() {
    const i = cur();
    f.labelsEdit.querySelectorAll('.chip').forEach(c => c.remove());
    for (const l of i.labels) {
      f.labelsEdit.insertBefore(el('span', { class: 'chip' }, l, el('button', { title: '제거', text: '×', onclick: () => update(x => { x.labels = x.labels.filter(y => y !== l); renderLabels(); }) })), f.labelInput);
    }
    f.labelList.innerHTML = '';
    allLabels().filter(l => !i.labels.includes(l)).forEach(l => f.labelList.append(el('option', { value: l })));
  }
  f.labelInput.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ',') && !e.isComposing) {
      e.preventDefault();
      const v = f.labelInput.value.trim().replace(/^#/, '').replace(/\s+/g, '-');
      if (v && !cur().labels.includes(v)) update(i => { i.labels.push(v); });
      f.labelInput.value = '';
      renderLabels();
    } else if (e.key === 'Backspace' && !f.labelInput.value && cur().labels.length) {
      update(i => { i.labels.pop(); }); renderLabels();
    }
  });

  // checklist
  function renderChecklist() {
    const i = cur();
    f.checklist.innerHTML = '';
    for (const c of i.checklist) {
      const cb = el('input', { type: 'checkbox' }); cb.checked = c.done;
      cb.addEventListener('change', () => update(x => { x.checklist.find(y => y.id === c.id).done = cb.checked; renderChecklist(); }));
      const text = el('span', { text: c.text, title: '더블클릭해서 편집' });
      text.addEventListener('dblclick', () => {
        const v = prompt('항목 편집', c.text);
        if (v != null && v.trim()) update(x => { x.checklist.find(y => y.id === c.id).text = v.trim(); renderChecklist(); });
      });
      f.checklist.append(el('li', { class: c.done ? 'done' : '' }, cb, text,
        el('button', { title: '삭제', text: '✕', onclick: () => update(x => { x.checklist = x.checklist.filter(y => y.id !== c.id); renderChecklist(); }) })));
    }
    const done = i.checklist.filter(c => c.done).length;
    const total = i.checklist.length;
    f.checkProgress.textContent = total ? `${done}/${total}` : '';
    f.checkBar.style.width = total ? `${(done / total) * 100}%` : '0';
    f.checkBar.parentElement.hidden = !total;
  }
  f.checkInput.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = f.checkInput.value.trim();
      if (!v) return;
      update(i => { i.checklist.push({ id: uid(), text: v, done: false }); });
      f.checkInput.value = '';
      renderChecklist();
    }
  });

  // comments
  function renderComments() {
    const i = cur();
    f.comments.innerHTML = '';
    for (const c of [...i.comments].reverse()) {
      const li = el('li', { class: c.system ? 'muted' : '' },
        el('div', { class: 'c-meta' }, el('span', { text: fmtDate(c.at) }),
          c.system ? null : el('button', { text: '삭제', onclick: () => update(x => { x.comments = x.comments.filter(y => y.id !== c.id); renderComments(); }) })),
        el('div', { text: c.text }));
      if (c.system) li.style.background = 'transparent';
      f.comments.append(li);
    }
  }
  function addComment() {
    const v = f.commentInput.value.trim();
    if (!v) return;
    update(i => { i.comments.push({ id: uid(), text: v, at: now() }); });
    f.commentInput.value = '';
    renderComments();
  }
  f.commentBtn.addEventListener('click', addComment);
  f.commentInput.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addComment(); } });

  function confirmCreate() {
    if (!creating) return;
    commitDesc();
    const parsed = parseQuick(f.title.value);
    if (!parsed.title) { f.title.focus(); toast('요약을 입력하세요'); return; }
    const d = draft;
    const issue = createIssue({ ...d, title: parsed.title, labels: [...new Set([...d.labels, ...parsed.labels])], priority: parsed.priority || d.priority, type: parsed.type || d.type });
    creating = false; draft = null;
    issueOverlay.hidden = true;
    render();
    toast(`${issueKey(issue)} 생성됨`, '열기', () => openIssue(issue.id));
  }
  f.createBtn.addEventListener('click', confirmCreate);

  f.del.addEventListener('click', () => {
    const i = getIssue(currentIssueId);
    if (!i) return;
    const idx = state.issues.indexOf(i);
    state.issues.splice(idx, 1);
    save();
    issueOverlay.hidden = true; currentIssueId = null;
    history.replaceState(null, '', location.pathname + location.search);
    render();
    toast(`${issueKey(i)} 삭제됨`, '실행 취소', () => { state.issues.splice(idx, 0, i); save(); render(); });
  });

  issueOverlay.addEventListener('mousedown', e => { if (e.target === issueOverlay) closeIssue(); });
  issueOverlay.querySelector('[data-close]').addEventListener('click', closeIssue);

  // ---------- generic dialog ----------
  const dialogOverlay = $('#dialogOverlay');
  function dialog(title, build) {
    $('#dialogTitle').textContent = title;
    const body = $('#dialogBody');
    body.innerHTML = '';
    build(body);
    dialogOverlay.hidden = false;
  }
  function closeDialog() { if (!$('#loginPw')) dialogOverlay.hidden = true; }
  function btns(label, onOk) {
    const ok = el('button', { class: 'primary', text: label, onclick: () => { if (onOk() !== false) closeDialog(); } });
    const wrap = el('div', { class: 'btns' }, el('button', { class: 'text-btn', text: '취소', onclick: closeDialog }), ok);
    setTimeout(() => {
      $('#dialogBody').querySelectorAll('input').forEach(inp => inp.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok.click(); }
      }));
    });
    return wrap;
  }
  dialogOverlay.addEventListener('mousedown', e => { if (e.target === dialogOverlay) closeDialog(); });
  dialogOverlay.querySelector('[data-close]').addEventListener('click', closeDialog);

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, actionLabel, action) {
    const t = $('#toast');
    t.innerHTML = '';
    t.append(el('span', { text: msg }));
    if (actionLabel) t.append(el('button', { text: actionLabel, onclick: () => { t.hidden = true; action(); } }));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, actionLabel ? 6000 : 2500);
  }

  // ---------- main menu: export / import / shortcuts ----------
  function exportJson() {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `kanban-backup-${todayStr()}.json` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function exportCsv() {
    const p = project();
    const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Key', 'Summary', 'Status', 'Type', 'Priority', 'Labels', 'Due', 'Points', 'Created', 'Updated', 'Description']];
    for (const i of projectIssues()) rows.push([issueKey(i), i.title, colById(i.status)?.name, typeById[i.type]?.name, prioById[i.priority]?.name, i.labels.join(' '), i.due, i.points ?? '', i.createdAt, i.updatedAt, i.desc]);
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\n')], { type: 'text/csv' });
    const a = el('a', { href: URL.createObjectURL(blob), download: `${p.key}-${todayStr()}.csv` });
    document.body.append(a); a.click(); a.remove();
  }
  $('#importFile').addEventListener('change', async e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const s = JSON.parse(await file.text());
      if (!Array.isArray(s.projects) || !Array.isArray(s.issues) || !s.projects.length) throw new Error('형식 오류');
      if (!confirm('현재 데이터를 가져온 파일로 덮어씁니다. 계속할까요?')) return;
      flushSave();
      const data = await api('POST', '/api/import', { projects: s.projects, issues: s.issues });
      state.projects = data.projects; state.issues = data.issues;
      normalize(state); rebuildSnap(); render(); toast('가져오기 완료 (서버에 저장됨)');
    } catch (err) { toast('가져오기 실패: ' + err.message); }
  });

  function showShortcuts() {
    dialog('키보드 단축키', body => {
      const rows = [
        ['C', '새 이슈 만들기'], ['/', '검색'], ['B / L', '보드 / 목록 보기'], ['1 – 9', '첫 번째 컬럼부터 빠른 추가'],
        ['Esc', '닫기 · 필터 지우기'], ['Enter', '포커스된 카드 열기'], ['Ctrl/⌘ + Enter', '이슈 생성 · 댓글 저장'], ['?', '이 도움말'],
      ];
      body.append(el('table', { class: 'kbd-table' }, rows.map(([k, d]) => el('tr', {}, el('td', {}, el('kbd', { text: k })), el('td', { text: d })))));
      body.append(el('p', { class: 'muted', html: '빠른 생성 문법: <kbd>#라벨</kbd> <kbd>#bug</kbd> <kbd>#story</kbd> <kbd>!high</kbd> <kbd>!!</kbd>(최상)' }));
    });
  }

  $('#menuBtn').addEventListener('click', () => dialog('메뉴', body => {
    const item = (text, fn, cls = '') => el('button', { class: 'menu-item ' + cls, text, onclick: () => { closeDialog(); fn(); } });
    body.append(
      item('⌨  키보드 단축키', showShortcuts),
      el('hr'),
      item('⬇  JSON 백업 내보내기 (전체)', exportJson),
      item('⬆  JSON 백업 가져오기', () => $('#importFile').click()),
      item('⬇  CSV 내보내기 (현재 프로젝트)', exportCsv),
      ...(authRequired ? [item('로그아웃', logout)] : []),
      el('hr'),
      item('완료 컬럼 이슈 모두 삭제', () => {
        const done = projectIssues().filter(isDone);
        if (!done.length) return toast('완료된 이슈가 없습니다');
        if (!confirm(`완료된 이슈 ${done.length}개를 삭제할까요? (먼저 내보내기로 백업을 권장)`)) return;
        const ids = new Set(done.map(i => i.id));
        state.issues = state.issues.filter(i => !ids.has(i.id)); save(); render();
      }, 'danger'),
      el('p', { class: 'muted', style: 'font-size:12px;margin:4px 0 0', text: '모든 변경은 즉시 서버에 저장되고, 열려 있는 다른 기기에도 실시간으로 반영됩니다.' }),
    );
  }));

  // ---------- header events ----------
  $('#projectSelect').addEventListener('change', e => {
    if (e.target.value === '__new') { e.target.value = project().id; projectDialog(); return; }
    state.activeProjectId = e.target.value; ui.quickAddCol = null; save(); render();
  });
  $('#projectMenuBtn').addEventListener('click', () => projectDialog(project()));
  document.querySelectorAll('.view-btn').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  function setView(v) { ui.view = v; saveUi(); render(); }
  let searchTimer;
  $('#search').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { ui.search = e.target.value.trim(); saveUi(); render(); }, 80);
  });
  $('#search').addEventListener('keydown', e => { if (e.key === 'Escape') { e.target.value = ''; ui.search = ''; e.target.blur(); render(); } });
  $('#filterType').addEventListener('change', e => { ui.type = e.target.value; saveUi(); render(); });
  $('#filterPriority').addEventListener('change', e => { ui.priority = e.target.value; saveUi(); render(); });
  $('#filterLabel').addEventListener('change', e => { ui.label = e.target.value; saveUi(); render(); });
  $('#clearFilters').addEventListener('click', clearFilters);
  function clearFilters() { Object.assign(ui, { search: '', type: '', priority: '', label: '' }); saveUi(); render(); }
  $('#createBtn').addEventListener('click', () => openCreate());
  $('#themeBtn').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; savePrefs(); applyTheme(); });

  // ---------- global keyboard ----------
  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;

    if (!loaded) return;
    if (e.key === 'Escape') {
      if (!dialogOverlay.hidden) { closeDialog(); return; }
      if (!issueOverlay.hidden) { if (typing) e.target.blur(); closeIssue(); return; }
      if (ui.quickAddCol) { ui.quickAddCol = null; renderBoard(); return; }
      if (filtersActive() && !typing) { clearFilters(); return; }
    }
    if (typing || e.metaKey || e.ctrlKey || e.altKey) {
      if (creating && e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !issueOverlay.hidden) { e.preventDefault(); confirmCreate(); }
      return;
    }
    if (!dialogOverlay.hidden || !issueOverlay.hidden) return;

    if (e.key === 'c' || e.key === 'C' || e.key === 'ㅊ') { e.preventDefault(); openCreate(); }
    else if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
    else if (e.key === '?') { showShortcuts(); }
    else if (e.key === 'b' || e.key === 'ㅠ') setView('board');
    else if (e.key === 'l' || e.key === 'ㅣ') setView('list');
    else if (/^[1-9]$/.test(e.key) && ui.view === 'board') {
      const col = project().columns[+e.key - 1];
      if (col) { e.preventDefault(); ui.quickAddCol = col.id; renderBoard(); }
    } else if (e.key === 'Enter' && e.target.classList?.contains('card')) openIssue(e.target.dataset.id);
  });

  // Deep link: #DEV-12 opens that issue.
  function openFromHash() {
    const m = decodeURIComponent(location.hash.slice(1)).match(/^([A-Z][A-Z0-9]*)-(\d+)$/);
    if (!m) return;
    const p = state.projects.find(x => x.key === m[1]);
    const i = p && state.issues.find(x => x.projectId === p.id && x.num === +m[2]);
    if (i) { state.activeProjectId = p.id; render(); openIssue(i.id); }
  }
  window.addEventListener('hashchange', openFromHash);

  // ---------- login / boot ----------
  function showLogin(msg) {
    if (!dialogOverlay.hidden && $('#loginPw')) return;
    dialog('로그인', body => {
      const pw = el('input', { id: 'loginPw', type: 'password', placeholder: '비밀번호', autocomplete: 'current-password' });
      const err = el('div', { class: 'sync-error', hidden: !msg, text: msg || '' });
      const go = el('button', { class: 'primary', text: '로그인' });
      const submit = async () => {
        go.disabled = true; err.hidden = true;
        try {
          await api('POST', '/api/login', { password: pw.value });
          pw.remove(); closeDialog(); await boot();
        } catch (e) { err.hidden = false; err.textContent = e.message; go.disabled = false; pw.select(); }
      };
      go.addEventListener('click', submit);
      pw.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) submit(); });
      body.append(pw, err, el('div', { class: 'btns' }, go));
      dialogOverlay.querySelector('[data-close]').hidden = true;
      setTimeout(() => pw.focus());
    });
  }
  async function logout() {
    await api('POST', '/api/logout').catch(() => { });
    location.reload();
  }

  async function boot() {
    try {
      await reloadState();
    } catch (e) {
      if (e.status === 401) { showLogin(); return; }
      boardEl.innerHTML = '';
      boardEl.append(el('div', { class: 'empty' }, e.status ? e.message : `서버에 연결할 수 없습니다: ${e.message}`, el('br'), el('button', { class: 'primary', style: 'margin-top:12px', text: '다시 시도', onclick: boot })));
      return;
    }
    dialogOverlay.querySelector('[data-close]').hidden = false;
    renderSaveStatus();
    connectEvents();
    openFromHash();
  }

  applyTheme();
  boardEl.append(el('div', { class: 'empty', text: '불러오는 중…' }));
  boot();
})();
