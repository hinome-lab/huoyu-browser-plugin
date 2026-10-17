/* =============================================================
 * 火羽直播实时字幕 — background (MV3 service worker)
 *
 * 职责：
 *   1. 探测两台字幕服务器的健康度，自动选一台好的
 *   2. 通过 offscreen 文档维持到 /events 的 SSE 长连接
 *      （bilibili 是 https，字幕服务器是 http，content script 里直接连会被
 *        混合内容拦截；扩展的 offscreen 页面是特权上下文，不受此限制）
 *   3. 把 SSE 事件转发给所有 B 站直播页的 content script
 * ============================================================= */

'use strict';

const KEY = 'hy';

const SERVERS = [
  { id: 's1', label: '线路一', base: 'http://123.60.104.22:6006' },
  { id: 's2', label: '线路二', base: 'http://106.15.35.175:6006' }
];

const DEFAULT_CFG = {
  enabled: true,
  serverMode: 'auto',   // auto | s1 | s2
  fontSize: 26,
  maxLines: 3,
  showJa: true,
  bottomPct: 11,
  delay: 0,
  onlyThisRoom: true,
  roomId: '22748536'
};

const MAX_CACHE = 400;      // 缓存多少条字幕用于新页面秒回填
const PROBE_TIMEOUT = 1800; // 健康探测超时
const RETRY_LADDER = [1500, 3000, 6000, 12000, 25000, 45000];

/* ---------- 运行时状态（SW 可能随时休眠，关键项持久化到 session） ---------- */
const S = {
  sse: 'idle',        // idle | connecting | open | error
  activeId: null,
  health: {},         // id -> 探测结果
  lastEventAt: 0,
  lastError: '',
  failCount: 0,
  retryTimer: 0,
  probeAt: 0
};

let CACHE = [];        // [{id, zh, ja, t, ts, el}]
let SNAPMETA = null;   // {room, live, viewers, connected, msg, source, at}
let offscreenBusy = null;

/* =========================== 配置 =========================== */

async function getCfg() {
  const got = await chrome.storage.sync.get(DEFAULT_CFG);
  return { ...DEFAULT_CFG, ...got };
}

async function setCfg(patch) {
  await chrome.storage.sync.set(patch);
}

/* =========================== 状态持久化 =========================== */

async function persist() {
  try {
    await chrome.storage.session.set({
      hyState: {
        sse: S.sse,
        activeId: S.activeId,
        health: S.health,
        lastError: S.lastError,
        failCount: S.failCount,
        snap: SNAPMETA
      }
    });
  } catch (_) { /* session storage 不可用时忽略 */ }
}

async function restore() {
  try {
    const { hyState } = await chrome.storage.session.get('hyState');
    if (!hyState) return;
    S.health = hyState.health || {};
    S.lastError = hyState.lastError || '';
    S.failCount = hyState.failCount || 0;
    SNAPMETA = hyState.snap || null;
    // sse 不恢复成 open：SW 重启后连接状态未知，交给 offscreen 的 state 消息纠正
  } catch (_) {}
}

/* =========================== offscreen 文档 =========================== */

async function hasOffscreen() {
  try {
    if (chrome.runtime.getContexts) {
      const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (ctx && ctx.length) return true;
    }
    if (chrome.offscreen && chrome.offscreen.hasDocument) {
      return await chrome.offscreen.hasDocument();
    }
  } catch (_) {}
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return true;
  if (offscreenBusy) return offscreenBusy;
  offscreenBusy = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['WORKERS'],
        justification: '维持到字幕服务器的 SSE 长连接，避免被混合内容策略拦截'
      });
      return true;
    } catch (e) {
      // 已存在时 createDocument 会抛错，这里视为成功
      if (String(e && e.message).includes('single offscreen')) return true;
      S.lastError = '创建后台通道失败：' + (e && e.message);
      return false;
    } finally {
      offscreenBusy = null;
    }
  })();
  return offscreenBusy;
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (_) {}
}

/* =========================== 健康探测 =========================== */

function scoreFrom(id, j, lat) {
  const msg = String(j.msg || '');
  const net = j.net || {};
  let score = 100;

  if (j.ok !== true) score -= 70;
  if (j.connected !== true) score -= 45;
  if (/未开播/.test(msg)) score -= 30;
  if (/重连|断开|失败|异常/.test(msg)) score -= 25;
  if (net.warn === true) score -= 18;
  if (typeof net.used_pct === 'number' && net.used_pct > 85) score -= 25;

  if (lat <= 120) score += 22;
  else if (lat <= 350) score += 12;
  else if (lat <= 900) score += 2;
  else if (lat <= 1800) score -= 15;
  else score -= 40;

  return {
    id, score,
    ok: j.ok === true,
    lat,
    connected: j.connected === true,
    viewers: typeof j.viewers === 'number' ? j.viewers : null,
    used_pct: typeof net.used_pct === 'number' ? net.used_pct : null,
    warn: net.warn === true,
    room: j.room || null,
    source: j.source || '',
    reason: msg || '正常',
    at: Date.now()
  };
}

async function probeOne(server) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  try {
    const res = await fetch(server.base + '/healthz', {
      cache: 'no-store',
      signal: ctrl.signal,
      credentials: 'omit'
    });
    const lat = Math.round(performance.now() - t0);
    if (!res.ok) {
      return {
        id: server.id,
        score: res.status === 429 ? -1000 : -600,
        ok: false, lat, connected: false, viewers: null, used_pct: null, warn: false,
        room: null, source: '',
        reason: res.status === 429 ? '人数已满（429）' : ('HTTP ' + res.status),
        at: Date.now()
      };
    }
    const j = await res.json();
    return scoreFrom(server.id, j, lat);
  } catch (e) {
    return {
      id: server.id,
      score: -900,
      ok: false, lat: Math.round(performance.now() - t0),
      connected: false, viewers: null, used_pct: null, warn: false,
      room: null, source: '',
      reason: (e && e.name === 'AbortError') ? '探测超时' : '连接失败',
      at: Date.now()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAll() {
  const out = await Promise.all(SERVERS.map(probeOne));
  out.forEach(r => { S.health[r.id] = r; });
  S.probeAt = Date.now();
  await persist();
  return out;
}

/* =========================== 选路 & 连接 =========================== */

function serverById(id) {
  return SERVERS.find(s => s.id === id) || null;
}

function serverByUrl(u) {
  try {
    const h = new URL(u).hostname;
    return SERVERS.find(s => {
      try { return new URL(s.base).hostname === h; } catch (_) { return false; }
    }) || null;
  } catch (_) { return null; }
}

function clearRetry() {
  if (S.retryTimer) { clearTimeout(S.retryTimer); S.retryTimer = 0; }
}

function scheduleRetry(why) {
  clearRetry();
  const n = Math.min(S.failCount, RETRY_LADDER.length - 1);
  const wait = RETRY_LADDER[n];
  S.failCount += 1;
  S.retryTimer = setTimeout(() => {
    S.retryTimer = 0;
    chooseAndConnect('retry:' + why);
  }, wait);
  persist();
}

async function connectTo(id) {
  const server = serverById(id);
  if (!server) return;
  clearRetry();
  S.activeId = id;
  S.sse = 'connecting';
  S.lastError = '';
  await persist();
  pushState();

  const ok = await ensureOffscreen();
  if (!ok) {
    S.sse = 'error';
    scheduleRetry('offscreen');
    pushState();
    return;
  }

  // 刚创建的 offscreen 文档可能还没注册好消息监听，重试几次
  let sent = false;
  for (let i = 0; i < 4 && !sent; i++) {
    try {
      await chrome.runtime.sendMessage({
        target: 'offscreen',
        cmd: 'connect',
        base: server.base,
        key: KEY,
        id: server.id
      });
      sent = true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 200));
    }
  }

  if (!sent) {
    S.sse = 'error';
    S.lastError = '后台字幕通道未就绪';
    scheduleRetry('dispatch');
    pushState();
  }
}

async function chooseAndConnect(reason) {
  const cfg = await getCfg();
  if (!cfg.enabled) {
    await stopEverything();
    return;
  }

  if (cfg.serverMode !== 'auto') {
    const fixed = serverById(cfg.serverMode);
    if (fixed) { connectTo(fixed.id); return; }
  }

  const results = await probeAll();
  const ranked = results.slice().sort((a, b) => b.score - a.score);
  const best = ranked[0];

  // 两台都不健康（限流 / 全挂）：退避后再试，别硬连
  if (!best || best.score <= -500) {
    S.sse = 'error';
    S.lastError = best ? best.reason : '没有可用服务器';
    pushState();
    scheduleRetry(reason || 'all-bad');
    return;
  }

  S.failCount = 0;
  connectTo(best.id);
}

async function stopEverything() {
  clearRetry();
  S.sse = 'idle';
  S.activeId = null;
  await persist();
  try { await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'close' }); } catch (_) {}
  await closeOffscreen();
  pushState();
}

/* =========================== SSE 事件处理 =========================== */

function dedupePush(line) {
  if (!line || line.id == null) return;
  const last = CACHE[CACHE.length - 1];
  if (last && last.id === line.id) {
    if (line.zh) last.zh = line.zh;
    return;
  }
  if (CACHE.some(l => l.id === line.id)) return;
  CACHE.push(line);
  if (CACHE.length > MAX_CACHE) CACHE = CACHE.slice(-MAX_CACHE);
}

function handleSseEvent(payload) {
  S.lastEventAt = Date.now();

  if (payload.type === 'move') {
    // 服务器主动要求换线路："线路繁忙，正在为你切换到更快的线路"
    const tgt = serverByUrl(payload.url);
    if (tgt && tgt.id !== S.activeId) {
      broadcastToTabs({ kind: 'notice', text: '线路繁忙，已自动切换到' + tgt.label });
      connectTo(tgt.id);
    }
    return;
  }

  if (payload.type === 'reset') {
    CACHE = [];
    SNAPMETA = null;
    broadcastToTabs({ kind: 'reset' });
    pushState();
    return;
  }

  if (payload.type === 'snapshot') {
    CACHE = [];
    (payload.lines || []).forEach(dedupePush);
    SNAPMETA = {
      room: payload.room || null,
      live: payload.live || null,
      viewers: payload.viewers,
      connected: payload.connected,
      msg: payload.msg || '',
      source: payload.source || '',
      at: Date.now()
    };
  } else if (payload.type === 'line') {
    dedupePush(payload.line);
  } else if (payload.type === 'line_upd') {
    const it = CACHE.find(l => l.id === payload.id);
    if (it) it.zh = payload.zh;
  } else if (payload.type === 'status') {
    if (SNAPMETA) {
      if (typeof payload.viewers === 'number') SNAPMETA.viewers = payload.viewers;
      if (typeof payload.connected === 'boolean') SNAPMETA.connected = payload.connected;
      if (payload.msg) SNAPMETA.msg = payload.msg;
    }
  }

  broadcastToTabs({ kind: 'sse', data: payload });
  pushState();
}

/* =========================== 与页面通信 =========================== */

async function liveTabs() {
  try {
    return await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  } catch (_) {
    return [];
  }
}

async function broadcastToTabs(msg) {
  const tabs = await liveTabs();
  for (const t of tabs) {
    try {
      chrome.tabs.sendMessage(t.id, { target: 'content', ...msg }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }
}

function snapshotForUi() {
  return {
    sse: S.sse,
    activeId: S.activeId,
    health: S.health,
    lastEventAt: S.lastEventAt,
    lastError: S.lastError,
    failCount: S.failCount,
    meta: SNAPMETA,
    cacheSize: CACHE.length
  };
}

async function pushState() {
  const state = snapshotForUi();
  try {
    chrome.runtime.sendMessage({ target: 'ui', kind: 'state', state }, () => void chrome.runtime.lastError);
  } catch (_) {}
}

/* 让新打开的直播页立即拿到已有字幕：向 offscreen 要缓存 */
async function requestResync(tabId) {
  if (!tabId || !(await hasOffscreen())) return;
  try {
    const r = await chrome.runtime.sendMessage({ target: 'offscreen', cmd: 'resync' });
    if (r && r.ok) {
      chrome.tabs.sendMessage(tabId, {
        target: 'content',
        kind: 'backfill',
        lines: r.lines || [],
        meta: SNAPMETA
      }, () => void chrome.runtime.lastError);
    }
  } catch (_) {}
}

/* =========================== 消息路由 =========================== */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  /* ---- 来自 offscreen ---- */
  if (msg.target === 'bg' && msg.kind === 'sse-event') {
    handleSseEvent(msg.data);
    return;
  }

  if (msg.target === 'bg' && msg.kind === 'sse-state') {
    if (msg.state === 'open') {
      S.sse = 'open';
      S.failCount = 0;
      clearRetry();
    } else if (msg.state === 'connecting') {
      S.sse = 'connecting';
    } else if (msg.state === 'error') {
      S.sse = 'error';
      S.lastError = msg.error || '连接中断';
      scheduleRetry('sse-error');
    }
    persist();
    pushState();
    return;
  }

  if (msg.target === 'bg' && msg.kind === 'resync-data') {
    return;
  }

  /* ---- 来自 content / popup ---- */
  if (msg.target !== 'bg') return;

  (async () => {
    switch (msg.kind) {
      case 'hello': {
        // 直播页加载完成
        const cfg = await getCfg();
        if (cfg.enabled && S.sse === 'idle') chooseAndConnect('hello');
        if (cfg.enabled && S.sse === 'open') requestResync(sender.tab && sender.tab.id);
        sendResponse({ ok: true, cfg, state: snapshotForUi() });
        break;
      }
      case 'getStatus': {
        // 若长时间没探测过，顺手刷一次
        if (Date.now() - S.probeAt > 20000) {
          probeAll().then(() => pushState());
        }
        const cfg = await getCfg();
        sendResponse({ ok: true, cfg, state: snapshotForUi() });
        break;
      }
      case 'setEnabled': {
        await setCfg({ enabled: !!msg.value });
        if (msg.value) {
          await chooseAndConnect('toggle-on');
        } else {
          await stopEverything();
          broadcastToTabs({ kind: 'disabled' });
        }
        sendResponse({ ok: true });
        break;
      }
      case 'setCfg': {
        await setCfg(msg.patch || {});
        const cfg = await getCfg();
        broadcastToTabs({ kind: 'cfg', cfg });
        if (Object.prototype.hasOwnProperty.call(msg.patch || {}, 'serverMode')) {
          chooseAndConnect('mode-change');
        }
        sendResponse({ ok: true, cfg });
        break;
      }
      case 'reconnect': {
        chooseAndConnect('manual');
        sendResponse({ ok: true });
        break;
      }
      case 'pick': {
        if (msg.id) connectTo(msg.id);
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: 'unknown kind' });
    }
  })().catch(e => {
    try { sendResponse({ ok: false, error: String(e) }); } catch (_) {}
  });

  return true;
});

/* =========================== 生命周期 =========================== */

chrome.runtime.onInstalled.addListener(() => {
  // 只有确实有直播页打开时才去连，别白占服务器名额
  restore().then(() => getCfg().then(cfg => {
    if (!cfg.enabled) return;
    liveTabs().then(tabs => { if (tabs.length) chooseAndConnect('install'); });
  }));
});

chrome.runtime.onStartup.addListener(() => {
  restore().then(() => getCfg().then(cfg => {
    if (!cfg.enabled) return;
    liveTabs().then(tabs => { if (tabs.length) chooseAndConnect('startup'); });
  }));
});

chrome.runtime.onSuspend.addListener(() => {
  persist();
});

/* 配置变化（用户在其他窗口改设置） */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  getCfg().then(cfg => {
    if (Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
      if (changes.enabled.newValue) chooseAndConnect('cfg-on');
      else stopEverything();
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'serverMode') && cfg.enabled) {
      chooseAndConnect('cfg-mode');
    }
    broadcastToTabs({ kind: 'cfg', cfg });
  });
});

restore();
