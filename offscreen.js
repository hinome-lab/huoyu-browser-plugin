/* =============================================================
 * 火羽直播实时字幕 — offscreen
 *
 * 这里是一个特权扩展页面，可以合法地请求 http:// 字幕服务器
 * （B 站页面是 https，在 content script 里直接连会被混合内容策略拦掉）。
 * 本文件只做两件事：挂 SSE 长连接、把事件转给 background。
 * ============================================================= */

'use strict';

let es = null;
let curBase = '';
let curId = '';
let curKey = 'hy';
let lastMsg = 0;
let fail = 0;
let retryTimer = null;
let watchdog = null;

let CACHE = [];
const MAX_CACHE = 400;
const IDLE_LIMIT = 50000;   // 超过这个时间没收到任何事件，判定连接假死

function toBg(kind, extra) {
  try {
    chrome.runtime.sendMessage({ target: 'bg', kind, ...extra }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

function reportState(state, error) {
  toBg('sse-state', { state, error: error || '' });
}

function stopWs() {
  if (watchdog) { clearInterval(watchdog); watchdog = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (es) {
    try { es.close(); } catch (_) {}
    es = null;
  }
}

function pushLine(line) {
  if (!line || line.id == null) return;
  const last = CACHE[CACHE.length - 1];
  if (last && last.id === line.id) return;
  if (CACHE.some(l => l.id === line.id)) return;
  CACHE.push(line);
  if (CACHE.length > MAX_CACHE) CACHE = CACHE.slice(-MAX_CACHE);
}

function applyEvent(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.type) {
    case 'snapshot':
      CACHE = [];
      (d.lines || []).forEach(pushLine);
      break;
    case 'line':
      pushLine(d.line);
      break;
    case 'line_upd': {
      const it = CACHE.find(l => l.id === d.id);
      if (it) it.zh = d.zh;
      break;
    }
    case 'reset':
      CACHE = [];
      break;
    default:
      break;
  }
}

function scheduleReconnect(why) {
  stopWs();
  fail += 1;
  const wait = Math.min(45000, 2000 * Math.pow(2, Math.min(fail - 1, 5)));
  reportState('error', why + '，' + Math.round(wait / 1000) + '秒后重连');
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (curBase) connect(curBase, curId, true);
  }, wait);
}

function connect(base, id, isRetry, key) {
  stopWs();
  curBase = base;
  curId = id || '';
  if (key) curKey = key;
  if (!isRetry) fail = 0;

  reportState('connecting', '');

  const url = base + '/events?k=' + encodeURIComponent(curKey);
  let source;
  try {
    source = new EventSource(url);
  } catch (e) {
    scheduleReconnect('无法建立连接');
    return;
  }
  es = source;
  lastMsg = Date.now();

  source.onopen = () => {
    fail = 0;
    lastMsg = Date.now();
    reportState('open', '');
  };

  source.onmessage = (ev) => {
    lastMsg = Date.now();
    let d;
    try { d = JSON.parse(ev.data); } catch (_) { return; }
    applyEvent(d);
    toBg('sse-event', { data: d, serverId: curId });
  };

  source.onerror = () => {
    // EventSource 自带重连，但服务器 429 / 长时间不可达时它不会退避，
    // 这里主动接管，走指数退避，避免把服务器打爆。
    scheduleReconnect('连接中断');
  };

  // 假死检测：服务器正常情况下每 10 秒左右会推一条 status
  if (watchdog) clearInterval(watchdog);
  watchdog = setInterval(() => {
    if (!es) return;
    if (Date.now() - lastMsg > IDLE_LIMIT) {
      scheduleReconnect('长时间无数据');
    }
  }, 10000);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;

  if (msg.cmd === 'connect') {
    connect(msg.base, msg.id, false, msg.key);
    sendResponse({ ok: true });
    return;
  }

  if (msg.cmd === 'close') {
    stopWs();
    curBase = '';
    CACHE = [];
    reportState('idle', '');
    sendResponse({ ok: true });
    return;
  }

  if (msg.cmd === 'resync') {
    // 直接通过 sendResponse 回给 background，新开的直播页可秒回填历史字幕
    sendResponse({ ok: true, lines: CACHE.slice(-120), serverId: curId });
    return;
  }

  sendResponse({ ok: false });
});
