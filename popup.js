/* 火羽直播实时字幕 — popup */

'use strict';

const SERVERS = [
  { id: 's1', label: '线路一', ip: '123.60.104.22' },
  { id: 's2', label: '线路二', ip: '106.15.35.175' }
];

const $ = (id) => document.getElementById(id);

let cfg = null;
let state = null;
let tick = null;

/* ------------------------------ 与后台通信 ------------------------------ */

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage({ target: 'bg', ...msg });
  } catch (e) {
    return { ok: false, error: String(e) };
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

function renderServers() {
  const list = $('srvList');
  list.replaceChildren();

  const mode = (cfg && cfg.serverMode) || 'auto';
  const health = (state && state.health) || {};
  const activeId = state && state.activeId;

  // 自动选择项
  const auto = document.createElement('div');
  auto.className = 'srv' + (mode === 'auto' ? ' sel' : '');
  auto.innerHTML =
    '<span class="dot ' + (mode === 'auto' ? 'ok' : '') + '"></span>' +
    '<div><div class="nm">自动选择</div><div class="ip">按健康度与延迟自动择优</div></div>' +
    '<div class="st">' + (mode === 'auto' ? '<b>已启用</b>' : '点击启用') + '</div>';
  auto.onclick = () => setCfg({ serverMode: 'auto' });
  list.appendChild(auto);

  SERVERS.forEach((s) => {
    const h = health[s.id];
    const isActive = state && state.activeId === s.id && state.sse !== 'idle';

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
        // 接口通了但没在转写（多为未开播）
        dot = 'warn';
        stText = shortReason(h.reason) || (h.lat + ' ms');
      }
    }

    const el = document.createElement('div');
    el.className = 'srv' + (mode === s.id ? ' sel' : '') + (isActive ? ' act' : '');
    el.innerHTML =
      '<span class="dot ' + dot + '"></span>' +
      '<div><div class="nm">' + s.label + '</div><div class="ip">' + s.ip + '</div></div>' +
      '<div class="st"><b>' + escapeHtml(stText) + '</b></div>';
    el.onclick = () => setCfg({ serverMode: mode === s.id ? 'auto' : s.id });
    list.appendChild(el);
  });
}

function shortReason(r) {
  if (!r) return '';
  const s = String(r);
  return s.length > 12 ? s.slice(0, 12) + '…' : s;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderStatus() {
  if (!state) return;

  const info = sseInfo(state.sse);
  $('sseText').textContent = info.text;
  $('dot').className = 'dot ' + info.dot;

  const active = SERVERS.find((s) => s.id === state.activeId);
  const h = active ? (state.health || {})[active.id] : null;

  $('latTag').textContent = h && h.lat != null ? (active.label + ' · ' + h.lat + 'ms') : '—';

  const bits = [];
  const meta = state.meta;
  if (meta && meta.room) {
    bits.push('房间：' + (meta.room.name || meta.room.title || meta.room.id));
  }
  if (meta) {
    const live = meta.live && meta.live.live;
    bits.push(live ? '● 直播中' : '○ 未开播');
    if (meta.viewers != null) bits.push(meta.viewers + ' 人在看');
    if (meta.msg) bits.push(meta.msg);
  }
  if (state.lastError) bits.push('⚠ ' + state.lastError);

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
  $('onlyThisRoom').checked = !!cfg.onlyThisRoom;
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
  renderStatus();
  renderServers();
  renderForm();
}

/* ------------------------------ 事件绑定 ------------------------------ */

$('enabled').addEventListener('change', async (e) => {
  await send({ kind: 'setEnabled', value: e.target.checked });
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
$('onlyThisRoom').addEventListener('change', (e) => setCfg({ onlyThisRoom: e.target.checked }));

$('reconnect').addEventListener('click', async () => {
  $('sseText').textContent = '重新探测中…';
  await send({ kind: 'reconnect' });
  setTimeout(refresh, 900);
});

$('openRoom').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://live.bilibili.com/' + ((cfg && cfg.roomId) || '22748536') });
});

/* ------------------------------ 启动 ------------------------------ */

// 后台推送状态变化时立即刷新（轮询作为兜底）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.target === 'ui' && msg.kind === 'state' && msg.state) {
    state = msg.state;
    renderStatus();
    renderServers();
  }
});

refresh().then(() => {
  tick = setInterval(refresh, 1000);
});

window.addEventListener('unload', () => {
  if (tick) clearInterval(tick);
});
