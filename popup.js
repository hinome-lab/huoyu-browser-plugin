/* 火羽直播实时字幕 — popup */

'use strict';

const $ = (id) => document.getElementById(id);

let cfg = null;
let state = null;
let tick = null;
let curRoom = '';     // 当前标签页所在的直播间
let roomMeta = {};    // { 房间号: { label, servers: [...] } }

/* ------------------------------ 与后台通信 ------------------------------ */

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage({ target: 'bg', ...msg });
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function readCurrentTab() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const m = tab && tab.url && tab.url.match(/live\.bilibili\.com\/(\d{1,12})/);
    curRoom = m ? m[1] : '';
  } catch (_) {
    curRoom = '';
  }
}

/* ------------------------------ 渲染 ------------------------------ */

function sseInfo(s) {
  const map = {
    idle: { text: '未启动', dot: '' },
    connecting: { text: '正在连接…', dot: 'warn' },
    open: { text: '已连接', dot: 'ok' },
    error: { text: '连接异常', dot: 'bad' }
  };
  return map[s] || { text: s || '未知', dot: '' };
}

/* 当前该显示哪一组服务器：优先后台正在服务的房间，其次当前标签页的房间 */
function currentPool() {
  const active = state && state.activeRoom;
  if (active && roomMeta[active]) return { room: active, meta: roomMeta[active] };
  if (curRoom && roomMeta[curRoom]) return { room: curRoom, meta: roomMeta[curRoom] };
  return { room: curRoom, meta: null };
}

function renderServers() {
  const list = $('srvList');
  list.replaceChildren();

  const pool = currentPool();
  const mode = (cfg && cfg.serverMode) || 'auto';
  const health = (state && state.health) || {};

  if (!pool.meta) {
    const el = document.createElement('div');
    el.className = 'srv';
    el.style.cursor = 'default';
    el.innerHTML =
      '<span class="dot"></span>' +
      '<div><div class="nm">当前直播间无字幕服务</div>' +
      '<div class="ip">' + (curRoom ? ('房间 ' + curRoom) : '不在直播间页面') + '</div></div>' +
      '<div class="st">—</div>';
    list.appendChild(el);
    return;
  }

  // 自动选择
  const auto = document.createElement('div');
  auto.className = 'srv' + (mode === 'auto' ? ' sel' : '');
  auto.innerHTML =
    '<span class="dot ' + (mode === 'auto' ? 'ok' : '') + '"></span>' +
    '<div><div class="nm">自动选择</div><div class="ip">按健康度与延迟自动择优</div></div>' +
    '<div class="st">' + (mode === 'auto' ? '<b>已启用</b>' : '点击启用') + '</div>';
  auto.onclick = () => setCfg({ serverMode: 'auto' });
  list.appendChild(auto);

  pool.meta.servers.forEach((s) => {
    const h = health[s.id];
    const isActive = state && state.activeId === s.id && state.sse !== 'idle' &&
                     state.activeRoom === pool.room;
    const isLocked = mode === s.id;

    let dot = '';
    let stText = '未探测';
    if (h) {
      if (h.score <= -500) {
        dot = 'bad';
        stText = shortReason(h.reason) || '不可用';
      } else if (h.connected) {
        dot = 'ok';
        stText = h.lat + ' ms';
        if (h.viewers != null) stText += ' · ' + h.viewers + '人';
      } else {
        dot = 'warn';
        stText = shortReason(h.reason) || (h.lat + ' ms');
      }
    }

    const el = document.createElement('div');
    el.className = 'srv' + (isLocked ? ' sel' : '') + (isActive ? ' act' : '');
    const host = s.base.replace(/^https?:\/\//, '');
    el.innerHTML =
      '<span class="dot ' + dot + '"></span>' +
      '<div><div class="nm">' + escapeHtml(s.label) + '</div>' +
      '<div class="ip">' + escapeHtml(host) + '</div></div>' +
      '<div class="st"><b>' + escapeHtml(stText) + '</b></div>';
    el.onclick = () => setCfg({ serverMode: isLocked ? 'auto' : s.id });
    list.appendChild(el);
  });
}

function renderRooms() {
  const list = $('roomList');
  list.replaceChildren();

  Object.keys(roomMeta).forEach((id) => {
    const r = roomMeta[id];
    const isActive = state && state.activeRoom === id;
    const el = document.createElement('div');
    el.className = 'srv' + (isActive ? ' act' : '');
    el.innerHTML =
      '<span class="dot ' + (isActive ? 'ok' : '') + '"></span>' +
      '<div><div class="nm">' + escapeHtml(r.label) + '</div>' +
      '<div class="ip">' + id + ' · ' + r.servers.length + ' 条线路</div></div>' +
      '<div class="st">' + (isActive ? '当前' : '打开') + '</div>';
    el.onclick = () => chrome.tabs.create({ url: 'https://live.bilibili.com/' + id });
    list.appendChild(el);
  });
}

function renderStatus() {
  if (!state) return;

  const info = sseInfo(state.sse);
  $('sseText').textContent = info.text;
  $('dot').className = 'dot ' + info.dot;

  const pool = currentPool();
  const srv = pool.meta && state.activeId
    ? pool.meta.servers.find((s) => s.id === state.activeId)
    : null;
  const h = state.activeId ? (state.health || {})[state.activeId] : null;

  $('latTag').textContent = (srv && h && h.lat != null)
    ? (srv.label + ' · ' + h.lat + 'ms')
    : '—';

  const bits = [];
  const meta = state.meta;
  if (meta && meta.room) {
    bits.push('房间：' + (meta.room.name || meta.room.title || meta.room.id));
  } else if (pool.room && roomMeta[pool.room]) {
    bits.push('房间：' + roomMeta[pool.room].label);
  }
  if (meta) {
    const live = meta.live && meta.live.live;
    bits.push(live ? '● 直播中' : '○ 未开播');
    if (meta.viewers != null) bits.push(meta.viewers + ' 人在看');
    if (meta.msg) bits.push(meta.msg);
  }
  if (state.lastError) bits.push('⚠ ' + state.lastError);
  if (!meta && pool.meta && state.sse === 'idle') bits.push('等待直播页建立连接…');

  $('metaText').textContent = bits.length ? bits.join('　·　') : '等待直播页建立连接…';
}

function renderForm() {
  if (!cfg) return;
  $('enabled').checked = !!cfg.enabled;
  $('fontSize').value = cfg.fontSize;
  $('fontSizeVal').textContent = cfg.fontSize + 'px';
  $('maxLines').value = cfg.maxLines;
  $('maxLinesVal').textContent = cfg.maxLines + ' 行';
  $('bottomPct').value = cfg.bottomPct;
  $('bottomPctVal').textContent = cfg.bottomPct + '%';
  $('delay').value = cfg.delay;
  $('delayVal').textContent = cfg.delay ? cfg.delay + ' s' : '关';
  $('showJa').checked = !!cfg.showJa;
}

/* ------------------------------ 工具 ------------------------------ */

function shortReason(r) {
  if (!r) return '';
  const s = String(r);
  return s.length > 12 ? s.slice(0, 12) + '…' : s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ------------------------------ 动作 ------------------------------ */

async function setCfg(patch) {
  const res = await send({ kind: 'setCfg', patch });
  if (res && res.cfg) cfg = res.cfg;
  renderForm();
  await refresh();
}

async function refresh() {
  const res = await send({ kind: 'getStatus' });
  if (!res || !res.ok) {
    $('sseText').textContent = '后台未响应';
    $('dot').className = 'dot bad';
    return;
  }
  cfg = res.cfg;
  state = res.state;
  roomMeta = state.roomMeta || {};
  renderStatus();
  renderServers();
  renderRooms();
  renderForm();
}

/* ------------------------------ 事件绑定 ------------------------------ */

$('enabled').addEventListener('change', async (e) => {
  await send({ kind: 'setEnabled', value: e.target.checked, room: curRoom });
  await refresh();
});

['fontSize', 'maxLines', 'bottomPct', 'delay'].forEach((key) => {
  const el = $(key);
  el.addEventListener('input', () => {
    const v = parseInt(el.value, 10);
    if (key === 'fontSize') $('fontSizeVal').textContent = v + 'px';
    else if (key === 'maxLines') $('maxLinesVal').textContent = v + ' 行';
    else if (key === 'bottomPct') $('bottomPctVal').textContent = v + '%';
    else $('delayVal').textContent = v ? v + ' s' : '关';
  });
  el.addEventListener('change', () => {
    const v = parseInt(el.value, 10);
    setCfg({ [key]: v });
  });
});

$('showJa').addEventListener('change', (e) => setCfg({ showJa: e.target.checked }));

$('reconnect').addEventListener('click', async () => {
  $('sseText').textContent = '重新探测中…';
  await send({ kind: 'reconnect', room: curRoom });
  setTimeout(refresh, 900);
});

$('openRoom').addEventListener('click', () => {
  const pool = currentPool();
  const target = pool.room || Object.keys(roomMeta)[0];
  if (target) chrome.tabs.create({ url: 'https://live.bilibili.com/' + target });
});

/* ------------------------------ 启动 ------------------------------ */

// 后台推送状态变化时立即刷新（轮询作为兜底）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'ui' && msg.kind === 'state' && msg.state) {
    state = msg.state;
    roomMeta = state.roomMeta || {};
    renderStatus();
    renderServers();
    renderRooms();
  }
});

readCurrentTab().then(async () => {
  // 打开面板时顺手"报到"一次，后台若还没连接就把它唤起
  if (curRoom) await send({ kind: 'hello', room: curRoom });
  await refresh();
}).then(() => {
  tick = setInterval(refresh, 1000);
});

window.addEventListener('unload', () => {
  if (tick) clearInterval(tick);
});
