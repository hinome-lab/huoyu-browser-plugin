/* =============================================================
 * 火羽直播实时字幕 — background (MV3 service worker)
 *
 * 职责：
 *   1. 按直播间归属，探测该房间对应的字幕服务器组，挑最优的一台
 *   2. 通过 offscreen 文档维持到 /events 的 SSE 长连接
 *      （bilibili 是 https，字幕服务器是 http，content script 里直接连会被
 *        混合内容拦截；扩展的 offscreen 页面是特权上下文，不受此限制）
 *   3. 把 SSE 事件转发给「同房间」的直播页，别的直播间一概不打扰
 * ============================================================= */

'use strict';

const KEY = 'hy';

/* 每个直播间对应一组字幕服务器，互相独立、不能串台 */
const ROOMS = {
  '22748536': {
    label: '火羽ひのめ',
    servers: [
      { id: 'hy1', label: '线路一', base: 'http://123.60.104.22:6006' },
      { id: 'hy2', label: '线路二', base: 'http://106.15.35.175:6006' }
    ]
  },
  '21399689': {
    label: 'Milky_Vtuber',
    servers: [
      { id: 'mk1', label: '线路一', base: 'http://123.60.104.22:6007' },
      { id: 'mk2', label: '线路二', base: 'http://8.133.231.186:6006' }
    ]
  }
};

const ALL_SERVERS = Object.values(ROOMS).reduce((a, r) => a.concat(r.servers), []);
const SERVER_IDS = new Set(ALL_SERVERS.map(s => s.id));

const DEFAULT_CFG = {
  enabled: true,
  serverMode: 'auto',   // auto 或某个服务器 id（如 hy1 / mk2）
  fontSize: 26,
  maxLines: 3,
  showJa: true,
  bottomPct: 11,
  delay: 0
};

const MAX_CACHE = 400;
const PROBE_TIMEOUT = 1800;
const RETRY_LADDER = [1500, 3000, 6000, 12000, 25000, 45000];

/* ---------- 运行时状态（SW 可能随时休眠，关键项持久化到 session） ---------- */
const S = {
  sse: 'idle',        // idle | connecting | open | error
  activeRoom: '',     // 当前正在服务的直播间
  activeId: null,     // 当前连的服务器 id
  health: {},         // serverId -> 探测结果
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

/* =========================== 服务器 / 房间工具 =========================== */

function serversOf(room) {
  return (ROOMS[room] && ROOMS[room].servers) || [];
}

function roomLabel(room) {
  return (ROOMS[room] && ROOMS[room].label) || ('房间 ' + room);
}

function findServer(id) {
  return ALL_SERVERS.find(s => s.id === id) || null;
}

function roomOfServer(id) {
  for (const [room, cfg] of Object.entries(ROOMS)) {
    if (cfg.servers.some(s => s.id === id)) return room;
  }
  return '';
}

function roomFromUrl(u) {
  try {
    const m = new URL(u).pathname.match(/^\/(\d{1,12})/);
    return m ? m[1] : '';
  } catch (_) { return ''; }
}

function serverByUrl(u) {
  try {
    const h = new URL(u).hostname;
    const port = new URL(u).port || '80';
    return ALL_SERVERS.find(s => {
      try {
        const x = new URL(s.base);
        return x.hostname === h && (x.port || '80') === port;
      } catch (_) { return false; }
    }) || null;
  } catch (_) { return null; }
}

/* =========================== 状态持久化 =========================== */

async function persist() {
  try {
    await chrome.storage.session.set({
      hyState: {
        sse: S.sse,
        activeRoom: S.activeRoom,
        activeId: S.activeId,
        health: S.health,
        lastError: S.lastError,
        failCount: S.failCount,
        snap: SNAPMETA
      }
    });
  } catch (_) {}
}

async function restore() {
  try {
    const { hyState } = await chrome.storage.session.get('hyState');
    if (!hyState) return;
    S.health = hyState.health || {};
    S.lastError = hyState.lastError || '';
    S.failCount = hyState.failCount || 0;
    SNAPMETA = hyState.snap || null;
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

function scoreFrom(server, j, lat, expectRoom) {
  const msg = String(j.msg || '');
  const net = j.net || {};
  let score = 100;

  if (j.ok !== true) score -= 70;
  if (j.connected !== true) score -= 45;
  if (/未开播/.test(msg)) score -= 30;
  if (/重连|断开|失败|异常/.test(msg)) score -= 25;
  if (net.warn === true) score -= 18;
  if (typeof net.used_pct === 'number' && net.used_pct > 85) score -= 25;

  // 服务器报的房间号对不上，说明连错站点了，重罚
  const srvRoom = j.room ? String(j.room) : '';
  if (srvRoom && expectRoom && srvRoom !== expectRoom) score -= 120;

  if (lat <= 120) score += 22;
  else if (lat <= 350) score += 12;
  else if (lat <= 900) score += 2;
  else if (lat <= 1800) score -= 15;
  else score -= 40;

  return {
    id: server.id, room: srvRoom, score,
    ok: j.ok === true,
    lat,
    connected: j.connected === true,
    viewers: typeof j.viewers === 'number' ? j.viewers : null,
    used_pct: typeof net.used_pct === 'number' ? net.used_pct : null,
    warn: net.warn === true,
    source: j.source || '',
    reason: msg || '正常',
    at: Date.now()
  };
}

async function probeOne(server, expectRoom) {
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
        id: server.id, room: '',
        score: res.status === 429 ? -1000 : -600,
        ok: false, lat, connected: false, viewers: null, used_pct: null, warn: false,
        source: '',
        reason: res.status === 429 ? '人数已满（429）' : ('HTTP ' + res.status),
        at: Date.now()
      };
    }
    return scoreFrom(server, await res.json(), lat, expectRoom);
  } catch (e) {
    return {
      id: server.id, room: '',
      score: -900,
      ok: false, lat: Math.round(performance.now() - t0),
      connected: false, viewers: null, used_pct: null, warn: false,
      source: '',
      reason: (e && e.name === 'AbortError') ? '探测超时' : '连接失败',
      at: Date.now()
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeRoom(room) {
  const pool = serversOf(room);
  if (!pool.length) return [];
  const out = await Promise.all(pool.map(s => probeOne(s, room)));
  out.forEach(r => { S.health[r.id] = r; });
  S.probeAt = Date.now();
  await persist();
  return out;
}

/* =========================== 选路 & 连接 =========================== */

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
    chooseAndConnect('retry:' + why, S.activeRoom);
  }, wait);
  persist();
}

async function connectTo(id) {
  const server = findServer(id);
  if (!server) return;

  // 服务器必须属于当前房间，否则会串台
  const room = roomOfServer(id);
  if (room && S.activeRoom && room !== S.activeRoom) return;

  clearRetry();
  S.activeId = id;
  S.sse = 'connecting';
  S.lastError = '';
  await persist();
  pushState();
  broadcastToTabs({ kind: 'conn', sse: S.sse, serverId: id });

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

async function chooseAndConnect(reason, room) {
  const cfg = await getCfg();
  const target = room || S.activeRoom;

  if (!cfg.enabled || !target || !ROOMS[target]) {
    await stopEverything();
    return;
  }

  // 切房间：先让旧房间的页面安静下来，再清空上一间的数据，避免串台
  if (S.activeRoom && S.activeRoom !== target) {
    await notifyRoomEnd(S.activeRoom);
    CACHE = [];
    SNAPMETA = null;
    S.health = {};
  }
  S.activeRoom = target;
  await persist();

  const pool = serversOf(target);
  if (!pool.length) { await stopEverything(); return; }

  // 手动锁定：只在服务器确实属于当前房间时才生效
  if (cfg.serverMode !== 'auto' && SERVER_IDS.has(cfg.serverMode) && roomOfServer(cfg.serverMode) === target) {
    connectTo(cfg.serverMode);
    return;
  }

  const results = await probeRoom(target);
  const ranked = results.slice().sort((a, b) => b.score - a.score);
  const best = ranked[0];

  if (!best || best.score <= -500) {
    S.sse = 'error';
    S.lastError = best ? best.reason : '没有可用服务器';
    pushState();
    broadcastToTabs({ kind: 'conn', sse: 'error', reason: S.lastError });
    scheduleRetry(reason || 'all-bad');
    return;
  }

  S.failCount = 0;
  connectTo(best.id);
}

async function stopEverything() {
  clearRetry();
  broadcastToTabs({ kind: 'conn', sse: 'idle' });  // 趁 activeRoom 还在，先通知页面收场
  S.sse = 'idle';
  S.activeId = null;
  S.activeRoom = '';
  CACHE = [];
  SNAPMETA = null;
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
    // 服务器要求换线路
    const tgt = serverByUrl(payload.url);
    if (tgt && tgt.id !== S.activeId && roomOfServer(tgt.id) === S.activeRoom) {
      broadcastToTabs({ kind: 'notice', text: '线路繁忙，已自动切换' });
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
    // 防御：服务器推来的房间必须和当前服务的一致
    const srvRoom = payload.room && payload.room.id ? String(payload.room.id) : '';
    if (srvRoom && S.activeRoom && srvRoom !== S.activeRoom) {
      S.lastError = '服务器房间不匹配（' + srvRoom + '）';
      pushState();
      return;
    }

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

async function allLiveTabs() {
  try {
    return await chrome.tabs.query({ url: 'https://live.bilibili.com/*' });
  } catch (_) {
    return [];
  }
}

/* 只发给当前服务的那个房间，别的直播间一律不打扰 */
async function broadcastToTabs(msg) {
  const tabs = await allLiveTabs();
  for (const t of tabs) {
    if (S.activeRoom && roomFromUrl(t.url) !== S.activeRoom) continue;
    try {
      chrome.tabs.sendMessage(t.id, { target: 'content', ...msg }, () => void chrome.runtime.lastError);
    } catch (_) {}
  }
}

/* 通知某个房间的页面：后台不再服务它了 */
async function notifyRoomEnd(room) {
  const tabs = await allLiveTabs();
  for (const t of tabs) {
    if (roomFromUrl(t.url) !== room) continue;
    try {
      chrome.tabs.sendMessage(t.id, { target: 'content', kind: 'room-off' },
        () => void chrome.runtime.lastError);
    } catch (_) {}
  }
}

function snapshotForUi() {
  return {
    sse: S.sse,
    activeRoom: S.activeRoom,
    activeId: S.activeId,
    health: S.health,
    lastEventAt: S.lastEventAt,
    lastError: S.lastError,
    failCount: S.failCount,
    meta: SNAPMETA,
    cacheSize: CACHE.length,
    rooms: Object.keys(ROOMS),
    roomMeta: Object.fromEntries(
      Object.entries(ROOMS).map(([id, r]) => [id, { label: r.label, servers: r.servers }])
    )
  };
}

async function pushState() {
  try {
    chrome.runtime.sendMessage({ target: 'ui', kind: 'state', state: snapshotForUi() },
      () => void chrome.runtime.lastError);
  } catch (_) {}
}

/* 让直播页立刻拿到已有字幕 */
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
    broadcastToTabs({ kind: 'conn', sse: S.sse, reason: S.lastError });
    return;
  }

  /* ---- 来自 content / popup ---- */
  if (msg.target !== 'bg') return;

  (async () => {
    switch (msg.kind) {
      case 'hello': {
        const room = msg.room || (sender.tab && roomFromUrl(sender.tab.url)) || '';
        const supported = !!ROOMS[room];
        const cfg = await getCfg();

        if (supported && cfg.enabled) {
          // 不阻塞首屏：探测 + 建连放到后台跑，页面上会收到 conn 事件再亮起
          if (S.activeRoom !== room || S.sse === 'idle') {
            chooseAndConnect('hello', room).catch(() => {});
          } else if (S.sse === 'open' && sender.tab) {
            requestResync(sender.tab.id);
          }
        } else if (!supported) {
          // 进了不受支持的直播间：没有别的页面在用它就把连接收掉
          if (S.activeRoom === room) {
            await stopEverything();
          } else if (S.activeRoom) {
            const tabs = await allLiveTabs();
            const stillServed = tabs.some(t => roomFromUrl(t.url) === S.activeRoom);
            if (!stillServed) await stopEverything();
          }
        }

        sendResponse({
          ok: true,
          cfg,
          supported,
          serving: S.activeRoom === room && (S.sse === 'open' || S.sse === 'connecting'),
          state: snapshotForUi()
        });
        break;
      }

      case 'getStatus': {
        if (S.activeRoom && Date.now() - S.probeAt > 20000) {
          probeRoom(S.activeRoom).then(() => pushState());
        }
        const cfg = await getCfg();
        sendResponse({ ok: true, cfg, state: snapshotForUi() });
        break;
      }

      case 'setEnabled': {
        await setCfg({ enabled: !!msg.value });
        if (msg.value) {
          const room = msg.room || S.activeRoom;
          if (ROOMS[room]) await chooseAndConnect('toggle-on', room);
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
        if (Object.prototype.hasOwnProperty.call(msg.patch || {}, 'serverMode') && S.activeRoom) {
          chooseAndConnect('mode-change', S.activeRoom);
        }
        sendResponse({ ok: true, cfg });
        break;
      }

      case 'reconnect': {
        const room = msg.room || S.activeRoom;
        if (ROOMS[room]) chooseAndConnect('manual', room);
        sendResponse({ ok: true });
        break;
      }

      case 'pick': {
        if (msg.id && findServer(msg.id)) connectTo(msg.id);
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

/* =========================== 标签页切换 =========================== */

/* 同时开着几个直播间时，跟随当前激活的那个 */
chrome.tabs.onActivated.addListener(async (info) => {
  try {
    const tab = await chrome.tabs.get(info.tabId);
    if (!tab.url || !tab.url.includes('live.bilibili.com')) return;
    const room = roomFromUrl(tab.url);
    if (!room) return;

    const cfg = await getCfg();
    if (!cfg.enabled) return;

    if (ROOMS[room]) {
      if (S.activeRoom !== room) await chooseAndConnect('tab-focus', room);
    }
  } catch (_) {}
});

/* =========================== 生命周期 =========================== */

chrome.runtime.onInstalled.addListener(() => {
  restore().then(() => getCfg().then(cfg => {
    if (!cfg.enabled) return;
    allLiveTabs().then(tabs => {
      const room = tabs.map(t => roomFromUrl(t.url)).find(r => ROOMS[r]);
      if (room) chooseAndConnect('install', room);
    });
  }));
});

chrome.runtime.onStartup.addListener(() => {
  restore().then(() => getCfg().then(cfg => {
    if (!cfg.enabled) return;
    allLiveTabs().then(tabs => {
      const room = tabs.map(t => roomFromUrl(t.url)).find(r => ROOMS[r]);
      if (room) chooseAndConnect('startup', room);
    });
  }));
});

chrome.runtime.onSuspend.addListener(() => {
  persist();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  getCfg().then(cfg => {
    if (Object.prototype.hasOwnProperty.call(changes, 'enabled')) {
      if (changes.enabled.newValue) {
        if (S.activeRoom) chooseAndConnect('cfg-on', S.activeRoom);
      } else {
        stopEverything();
      }
    }
    if (Object.prototype.hasOwnProperty.call(changes, 'serverMode') && cfg.enabled && S.activeRoom) {
      chooseAndConnect('cfg-mode', S.activeRoom);
    }
    broadcastToTabs({ kind: 'cfg', cfg });
  });
});

restore();
