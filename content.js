/* =============================================================
 * 火羽直播实时字幕 — content script
 *
 * 在 B 站直播间画面上叠加一层字幕。
 *   · 用 Shadow DOM 隔离样式，绝不污染 B 站
 *   · 跟随 <video> 的实际位置（含全屏 / 网页全屏 / 窗口缩放）
 *   · 字幕数据由 background → offscreen 的 SSE 长连接推送
 * ============================================================= */

(function () {
  'use strict';

  if (window.__HY_LIVE_SUB__) return;
  window.__HY_LIVE_SUB__ = true;

  /* ------------------------------ 基础配置 ------------------------------ */

  const DEFAULTS = {
    enabled: true,
    serverMode: 'auto',
    fontSize: 26,
    maxLines: 3,
    showJa: true,
    bottomPct: 11,
    delay: 0,
    onlyThisRoom: true,
    roomId: '22748536'
  };

  let cfg = Object.assign({}, DEFAULTS);
  let lines = [];          // [{id, zh, ja, t, ts, el}]
  let meta = null;         // snapshot 摘要
  let notice = '';
  let noticeTimer = null;
  let renderedKey = '';
  let active = false;      // 当前页面是否该显示字幕
  let lastRoom = '';

  /* ------------------------------ Shadow 宿主 ------------------------------ */

  let host = null;
  let root = null;
  let wrapEl = null;
  let toastEl = null;
  let linesEl = null;

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .wrap {
      position: absolute;
      left: 0; right: 0;
      bottom: var(--hy-bottom, 11%);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-end;
      gap: var(--hy-gap, 6px);
      padding: 0 3.5%;
      pointer-events: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC",
                   "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
      text-align: center;
      -webkit-font-smoothing: antialiased;
      opacity: 0;
      transition: opacity .25s ease;
    }
    .wrap.on { opacity: 1; }

    .row {
      max-width: 100%;
      transition: opacity .2s ease;
    }
    .row.cur { animation: hy-in .22s cubic-bezier(.22,.61,.36,1) both; }
    @keyframes hy-in {
      from { opacity: 0; transform: translateY(.22em); }
      to   { opacity: 1; transform: none; }
    }

    .zh {
      display: block;
      color: #fff;
      font-weight: 700;
      font-size: var(--hy-size, 26px);
      line-height: 1.3;
      letter-spacing: .01em;
      word-break: break-word;
      text-wrap: balance;
      paint-order: stroke fill;
      -webkit-text-stroke: .012em rgba(0,0,0,.32);
      text-shadow:
        0 0 1px rgba(0,0,0,.98),
        0 0 4px rgba(0,0,0,.92),
        0 2px 5px rgba(0,0,0,.95),
        0 0 16px rgba(0,0,0,.7);
    }

    .ja {
      display: block;
      margin-top: .16em;
      color: #9dc0ff;
      font-weight: 500;
      font-size: calc(var(--hy-size, 26px) * .56);
      line-height: 1.35;
      word-break: break-word;
      text-shadow: 0 0 3px rgba(0,0,0,.95), 0 1px 4px rgba(0,0,0,.9);
    }
    .ja.hide { display: none; }

    /* 历史行 */
    .row.hist .zh {
      font-size: calc(var(--hy-size, 26px) * .64);
      font-weight: 600;
      color: rgba(255,255,255,.66);
    }
    .row.hist .ja { display: none; }

    /* 翻译还没回填时，先用日语原文占位 */
    .row.pending .zh {
      color: rgba(255,255,255,.82);
      font-weight: 500;
    }

    .toast {
      position: absolute;
      top: 12px; left: 50%;
      transform: translateX(-50%);
      padding: 6px 14px;
      border-radius: 999px;
      background: rgba(16,16,24,.82);
      color: #dfe4ff;
      font-size: 13px;
      font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
      border: 1px solid rgba(120,140,255,.28);
      backdrop-filter: blur(6px);
      pointer-events: none;
      opacity: 0;
      transition: opacity .2s ease;
      white-space: nowrap;
      max-width: 92%;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .toast.on { opacity: 1; }
  `;

  function createHost() {
    if (host) return;
    host = document.createElement('div');
    host.id = 'hy-live-sub-host';
    host.style.cssText = [
      'position:fixed', 'left:0', 'top:0', 'width:0', 'height:0',
      'pointer-events:none', 'z-index:2147483001', 'display:none',
      'contain:layout style'
    ].join(';');

    root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = CSS;

    wrapEl = document.createElement('div');
    wrapEl.className = 'wrap';

    linesEl = document.createElement('div');
    linesEl.className = 'lines';
    linesEl.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:var(--hy-gap,6px);width:100%';

    toastEl = document.createElement('div');
    toastEl.className = 'toast';

    wrapEl.appendChild(linesEl);
    wrapEl.appendChild(toastEl);
    root.appendChild(style);
    root.appendChild(wrapEl);
    document.body.appendChild(host);
  }

  /* ------------------------------ 定位跟踪 ------------------------------ */

  function pickVideo() {
    const vids = document.querySelectorAll('video');
    let best = null;
    let bestArea = 0;
    for (let i = 0; i < vids.length; i++) {
      const v = vids[i];
      if (v.readyState === 0 && v.videoWidth === 0) continue;
      const r = v.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea && r.width > 120 && r.height > 80) {
        bestArea = area;
        best = v;
      }
    }
    return best;
  }

  function mountInto(target) {
    if (!host) return;
    if (host.parentNode !== target) target.appendChild(host);
  }

  function sync() {
    if (!host) return;

    if (!active) {
      host.style.display = 'none';
      return;
    }

    const v = pickVideo();
    if (!v) {
      host.style.display = 'none';
      return;
    }

    const r = v.getBoundingClientRect();
    if (r.width < 120 || r.height < 80) {
      host.style.display = 'none';
      return;
    }

    const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
    // 全屏元素内部才看得见，所以全屏时把宿主挪进去
    const target = (fsEl && fsEl.contains(v)) ? fsEl : document.body;
    mountInto(target);

    if (target === document.body) {
      host.style.position = 'fixed';
      host.style.left = r.left + 'px';
      host.style.top = r.top + 'px';
    } else {
      const tr = target.getBoundingClientRect();
      host.style.position = 'absolute';
      host.style.left = (r.left - tr.left) + 'px';
      host.style.top = (r.top - tr.top) + 'px';
    }
    host.style.width = r.width + 'px';
    host.style.height = r.height + 'px';
    host.style.display = 'block';

    // 字号按播放器高度等比缩放（以 720p 为基准）
    const scale = Math.min(1.95, Math.max(0.6, r.height / 720));
    root.style.setProperty('--hy-size', Math.round(cfg.fontSize * scale) + 'px');
    root.style.setProperty('--hy-bottom', cfg.bottomPct + '%');
  }

  let rafId = 0;
  let lastSync = 0;
  function loop(ts) {
    rafId = requestAnimationFrame(loop);
    if (document.hidden) return;
    if (ts - lastSync < 140) return;   // 约 7fps 的位置刷新，够用且不抢渲染
    lastSync = ts;
    sync();
  }

  /* ------------------------------ 渲染字幕 ------------------------------ */

  function esc(s) {
    return String(s == null ? '' : s);
  }

  function makeRow(line, isCur) {
    const row = document.createElement('div');
    row.className = 'row' + (isCur ? ' cur' : ' hist');

    const zh = document.createElement('span');
    zh.className = 'zh';
    const zhText = line.zh || '';
    zh.textContent = zhText || esc(line.ja);
    if (!zhText) row.classList.add('pending');

    const ja = document.createElement('span');
    ja.className = 'ja' + (cfg.showJa && line.ja ? '' : ' hide');
    // 译文和原文完全一样时没必要重复显示
    ja.textContent = (line.ja && line.ja !== zhText) ? line.ja : '';

    row.dataset.id = line.id != null ? String(line.id) : '';
    row.appendChild(zh);
    row.appendChild(ja);
    return row;
  }

  function rebuild(show) {
    if (!linesEl) return;
    const frag = document.createDocumentFragment();
    show.forEach(function (line, i) {
      frag.appendChild(makeRow(line, i === show.length - 1));
    });
    linesEl.replaceChildren(frag);
    // 历史行越往上越淡
    const rows = linesEl.children;
    for (let i = 0; i < rows.length - 1; i++) {
      const depth = rows.length - 1 - i;
      rows[i].style.opacity = String(Math.max(0.34, 1 - depth * 0.26));
    }
  }

  function updateTexts(show) {
    if (!linesEl) return;
    const rows = linesEl.children;
    for (let i = 0; i < show.length && i < rows.length; i++) {
      const line = show[i];
      const row = rows[i];
      const zh = row.querySelector('.zh');
      const ja = row.querySelector('.ja');
      if (!zh) continue;
      const zhText = line.zh || '';
      const next = zhText || esc(line.ja);
      if (zh.textContent !== next) zh.textContent = next;
      if (zhText) row.classList.remove('pending'); else row.classList.add('pending');
      const jaText = (line.ja && line.ja !== zhText) ? line.ja : '';
      if (ja && ja.textContent !== jaText) ja.textContent = jaText;
      if (ja) ja.classList.toggle('hide', !(cfg.showJa && jaText));
    }
  }

  function render() {
    if (!wrapEl) return;
    const pool = visibleLines();
    const show = pool.slice(-Math.max(1, cfg.maxLines));
    const key = show.map(function (l) { return l.id; }).join(',');

    if (key !== renderedKey) {
      renderedKey = key;
      rebuild(show);
    } else {
      updateTexts(show);
    }

    wrapEl.classList.toggle('on', active && show.length > 0);
  }

  /* 延迟补偿：直播画面通常比主播实际动作晚几秒，
     字幕却是实时的，直接显示会「字幕跑到画面前面」。
     delay 表示字幕相对收到时间的额外延后秒数。 */
  function visibleLines() {
    if (!cfg.delay) return lines;
    const cut = Date.now() - cfg.delay * 1000;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (!l._at || l._at <= cut) out.push(l);
    }
    return out;
  }

  function showToast(text, ms) {
    if (!toastEl) return;
    notice = text;
    toastEl.textContent = text;
    toastEl.classList.add('on');
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () {
      toastEl.classList.remove('on');
    }, ms || 3200);
  }

  /* ------------------------------ 数据合并 ------------------------------ */

  function pushLine(line) {
    if (!line || line.id == null) return;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].id === line.id) {
        if (line.zh) lines[i].zh = line.zh;
        if (line.ja) lines[i].ja = line.ja;
        return;
      }
      if (lines.length - i > 6) break;
    }
    const item = Object.assign({}, line, { _at: Date.now() });
    lines.push(item);
    if (lines.length > 200) lines = lines.slice(-120);
  }

  function applyPatch(id, zh) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].id === id) { lines[i].zh = zh; return true; }
    }
    return false;
  }

  function handleSse(d) {
    if (!d || !active) return;

    switch (d.type) {
      case 'snapshot':
        lines = (d.lines || []).map(function (l) {
          return Object.assign({}, l, { _at: 0 });
        }).slice(-120);
        if (d.room) meta = Object.assign({}, meta, { room: d.room });
        if (d.live) meta = Object.assign({}, meta, { live: d.live });
        render();
        if (d.connected === false && d.msg) showToast(d.msg, 4200);
        break;

      case 'line':
        pushLine(d.line);
        render();
        break;

      case 'line_upd': {
        if (applyPatch(d.id, d.zh)) {
          updateTexts(visibleLines().slice(-Math.max(1, cfg.maxLines)));
        }
        break;
      }

      case 'status':
        if (meta) {
          if (typeof d.viewers === 'number') meta.viewers = d.viewers;
          if (typeof d.connected === 'boolean') meta.connected = d.connected;
          if (d.msg) meta.msg = d.msg;
        }
        break;

      case 'reset':
        lines = [];
        renderedKey = '';
        render();
        break;

      default:
        break;
    }
  }

  /* ------------------------------ 启用判定 ------------------------------ */

  function currentRoom() {
    const m = location.pathname.match(/^\/(\d{1,12})/);
    return m ? m[1] : '';
  }

  function evaluateActive() {
    const room = currentRoom();
    const roomOk = !cfg.onlyThisRoom || room === String(cfg.roomId);
    const wasActive = active;
    active = !!cfg.enabled && !!room && roomOk;

    if (room !== lastRoom) {
      lastRoom = room;
      lines = [];
      renderedKey = '';
    }

    if (host) {
      if (!active) {
        host.style.display = 'none';
        wrapEl.classList.remove('on');
      } else if (!wasActive) {
        renderedKey = '';
        render();
      }
    }
    return active;
  }

  function applyCfg(next) {
    const prev = cfg;
    cfg = Object.assign({}, DEFAULTS, next || {});
    if (cfg.showJa !== prev.showJa || cfg.maxLines !== prev.maxLines ||
        cfg.fontSize !== prev.fontSize || cfg.delay !== prev.delay) {
      renderedKey = '';
    }
    const isActive = evaluateActive();
    if (isActive) {
      createHost();
      render();
      sync();
    }
  }

  /* ------------------------------ 消息通道 ------------------------------ */

  chrome.runtime.onMessage.addListener(function (msg) {
    if (!msg || msg.target !== 'content') return;

    switch (msg.kind) {
      case 'sse':
        handleSse(msg.data);
        break;
      case 'backfill':
        if (active) {
          lines = (msg.lines || []).map(function (l) {
            return Object.assign({}, l, { _at: 0 });
          }).slice(-120);
          if (msg.meta) meta = msg.meta;
          renderedKey = '';
          render();
        }
        break;
      case 'cfg':
        applyCfg(msg.cfg);
        break;
      case 'reset':
        lines = [];
        renderedKey = '';
        render();
        break;
      case 'notice':
        if (active) showToast(msg.text);
        break;
      case 'disabled':
        active = false;
        if (host) host.style.display = 'none';
        if (wrapEl) wrapEl.classList.remove('on');
        break;
      default:
        break;
    }
  });

  /* ------------------------------ 启动 ------------------------------ */

  function boot() {
    try {
      chrome.runtime.sendMessage({ target: 'bg', kind: 'hello' }, function (res) {
        if (chrome.runtime.lastError) {
          // 扩展刚重载 / 后台还没醒，稍后重试
          setTimeout(boot, 1200);
          return;
        }
        if (!res || !res.ok) return;
        applyCfg(res.cfg);
        if (active) {
          createHost();
          sync();
          render();
          if (res.state && res.state.sse === 'error' && res.state.lastError) {
            showToast('字幕连接：' + res.state.lastError, 4000);
          }
        }
      });
    } catch (e) {
      // 扩展被更新/卸载后旧 content script 的上下文会失效，静默退出即可
    }
  }

  // B 站是 SPA，切换直播间不刷新页面
  let lastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      evaluateActive();
      if (active) { createHost(); sync(); render(); }
    }
    if (active) sync();
  }, 800);

  // 延迟补偿需要随真实时间推进刷新显示窗口
  setInterval(function () {
    if (active && cfg.delay > 0) render();
  }, 300);

  document.addEventListener('fullscreenchange', function () {
    if (active) { sync(); }
  });
  document.addEventListener('webkitfullscreenchange', function () {
    if (active) { sync(); }
  });
  window.addEventListener('resize', function () {
    if (active) sync();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
