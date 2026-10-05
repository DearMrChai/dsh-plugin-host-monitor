window.__ModuleLoader__.load({
  id: 'dsh-plugin-host-monitor',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const react = require('react');
    const { createElement, useEffect, useState, useCallback, useRef } = react;
    const h = createElement;
    let _meas = null; // 复用的隐藏测宽元素（收起态动态排版用）

    // ===== 皮肤色板（A/B/C，随 DSH 深/浅自动切换其中一版） =====
    // IDCOL：每模块身份色（标题/左边条/sparkline/ok态进度条）
    // SEM：跨模块统一语义色（warn/danger/ok，ok 仅用于“好=绿”的正负型指标与状态点）
    const IDCOL = {
      gpu:  { dark: '#5aa7ff', light: '#2f6fbf' },
      vllm: { dark: '#45c3e0', light: '#0e7a9d' },
      cpu:  { dark: '#4dc9a0', light: '#158a63' },
    };
    const SEM = {
      ok:     { dark: '#3ad49a', light: '#128a5e' },
      warn:   { dark: '#f5a623', light: '#b45309' },
      danger: { dark: '#ff5a5f', light: '#d92d20' },
    };
    function bgLuminance() {
      try {
        const bg = window.getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-bg-base').trim() || '';
        const m = bg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
        if (m) return 0.2126 * +m[1] + 0.7152 * +m[2] + 0.0722 * +m[3];
        const hex = bg.replace('#', '').trim();
        if (/^[0-9a-fA-F]{6}$/.test(hex)) {
          const r = parseInt(hex.slice(0, 2), 16), g = parseInt(hex.slice(2, 4), 16), b = parseInt(hex.slice(4, 6), 16);
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
      } catch { /* ignore */ }
      return null;
    }
    const pickTheme = () => (bgLuminance() !== null && bgLuminance() > 130) ? 'light' : 'dark';

    // ===== 告警闪烁（持续超阈值由渲染层判定；注入一次样式） =====
    const STYLE_CSS =
      '@keyframes hmBlinkWarn{0%,100%{box-shadow:0 0 0 0 rgba(245,166,35,0);opacity:1}50%{box-shadow:0 0 14px 3px rgba(245,166,35,.45);opacity:.88}}' +
      '@keyframes hmBlinkDanger{0%,100%{box-shadow:0 0 0 0 rgba(255,90,95,0);opacity:1}50%{box-shadow:0 0 16px 4px rgba(255,90,95,.55);opacity:.85}}' +
      '@keyframes hmDotPulse{0%,100%{box-shadow:0 0 0 0 rgba(255,90,95,0)}50%{box-shadow:0 0 0 4px rgba(255,90,95,.35)}}' +
      '.hm-blink-warn{animation:hmBlinkWarn 1.2s ease-in-out infinite}' +
      '.hm-blink-danger{animation:hmBlinkDanger .9s ease-in-out infinite}' +
      '.hm-dot-danger{animation:hmDotPulse 1s ease-in-out infinite}' +
      '.hm-spin{width:10px;height:10px;border:2px solid rgba(128,128,128,.32);border-top-color:currentColor;border-radius:50%;animation:hmSpin .7s linear infinite}' +
      '@keyframes hmSpin{to{transform:rotate(360deg)}}';

    const UI_KEY = 'dsh:host-monitor:ui';
    const loadUI = () => { try { const s = localStorage.getItem(UI_KEY); return s ? JSON.parse(s) : {}; } catch { return {}; } };
    const saveUI = (p) => { try { localStorage.setItem(UI_KEY, JSON.stringify(p)); } catch {} };
    const fmtTok = (n) => (n === null || n === undefined) ? '—' : n >= 1e9 ? (n / 1e9).toFixed(2) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
    const fmtBps = (b) => (b === null || b === undefined) ? '—' : b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB/s' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB/s' : b >= 1e3 ? (b / 1e3).toFixed(1) + ' KB/s' : Math.round(b) + ' B/s';
    const winLabel = (w) => { if (!w) return '近1h'; const m = Math.max(1, Math.round(w.spanMs / 60000)); return m >= 60 ? '近' + Math.round(m / 60) + 'h' : '近' + m + 'm'; };
    let dragMoved = false;

    // 由实时阈值得到状态等级
    const levelOf = (v, warn, danger) => (v === null || v === undefined) ? 'offline' : (v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok');
    const utilLevelOf = (v, warn, danger) => (v === null || v === undefined) ? 'offline' : (v >= danger ? 'danger' : v >= warn ? 'warn' : 'ok');

    // ===== sparkline（内联 SVG，零依赖） =====
    function sparkPath(points, n, w, hgt, lo, hi) {
      const X = (i) => (n <= 1 ? 0 : (i / (n - 1)) * w);
      const Y = (v) => (hgt - 2) - ((v - lo) / (hi - lo)) * (hgt - 4);
      let d = '';
      for (let i = 0; i < points.length; i += 1) {
        const v = points[i];
        if (typeof v !== 'number' || !Number.isFinite(v)) continue;
        d += (d ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
      }
      return d;
    }
    const sparkline = (points, o = {}) => {
      const w = o.w || 288, hgt = o.h || 30;
      const color = o.color || '#45c3e0';
      const valid = (points || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (valid.length < 2) return null;
      let lo = o.min, hi = o.max;
      if (lo === null || lo === undefined) lo = Math.min.apply(null, valid);
      if (hi === null || hi === undefined) hi = Math.max.apply(null, valid);
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const d = sparkPath(points || [], (points || []).length, w, hgt, lo, hi);
      if (!d) return null;
      const area = d + ' L' + w + ' ' + hgt + ' L0 ' + hgt + ' Z';
      return h('svg', { width: '100%', height: hgt, viewBox: '0 0 ' + w + ' ' + hgt, preserveAspectRatio: 'none', style: { display: 'block', margin: '2px 0 5px' } }, [
        o.fill !== false ? h('path', { d: area, fill: color, opacity: 0.12 }) : null,
        h('path', { d, fill: 'none', stroke: color, strokeWidth: 1.5, strokeLinejoin: 'round', strokeLinecap: 'round', vectorEffect: 'non-scaling-stroke' }),
      ]);
    };
    const sparklineMulti = (series, o = {}) => {
      const w = o.w || 288, hgt = o.h || 30;
      const all = [];
      for (const s of series) for (const v of s.points || []) if (typeof v === 'number' && Number.isFinite(v)) all.push(v);
      if (all.length < 2) return null;
      let lo = o.min, hi = o.max;
      if (lo === null || lo === undefined) lo = Math.min.apply(null, all);
      if (hi === null || hi === undefined) hi = Math.max.apply(null, all);
      if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
      const n = Math.max.apply(null, series.map((s) => (s.points || []).length));
      const paths = [];
      series.forEach((s, si) => {
        const d = sparkPath(s.points || [], n, w, hgt, lo, hi);
        if (d) paths.push(h('path', { key: si, d, fill: 'none', stroke: s.color, strokeWidth: 1.5, strokeLinejoin: 'round', vectorEffect: 'non-scaling-stroke' }));
      });
      return h('svg', { width: '100%', height: hgt, viewBox: '0 0 ' + w + ' ' + hgt, preserveAspectRatio: 'none', style: { display: 'block', margin: '2px 0 5px' } }, paths);
    };
    const legend = (items) => h('div', { style: { display: 'flex', gap: '8px', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary, #adb2b8)', marginBottom: '1px' } },
      items.map((it) => h('span', { key: it.text, style: { display: 'inline-flex', alignItems: 'center', gap: '3px' } }, [
        h('span', { style: { width: '10px', height: '2px', background: it.color, borderRadius: 1 } }), it.text,
      ])));

    // 前端窗口差值（与 core.windowDelta 同逻辑，作用于 history 帧）
    function windowDeltaClient(frames, key, spanMs) {
      const vals = [];
      const until = frames.length ? frames[frames.length - 1].ts : 0;
      for (const f of frames) {
        const v = key.split('.').reduce((o, k) => (o == null ? null : o[k]), f);
        if (typeof v === 'number' && Number.isFinite(v) && until - f.ts <= spanMs) vals.push({ ts: f.ts, v });
      }
      if (vals.length < 2) return null;
      const first = vals[0], last = vals[vals.length - 1];
      if (last.v < first.v) return null;
      return { delta: last.v - first.v, spanMs: last.ts - first.ts };
    }

    const HostMonitorView = () => {
      const [st, setSt] = useState(null);
      const [hist, setHist] = useState([]);
      const [expanded, setExpanded] = useState(true);
      const [pos, setPos] = useState(null);
      const [refreshing, setRefreshing] = useState(false);
      const panelRef = useRef(null);

      const status = st || {};
      const pollMs = status.cfg?.intervalMs ?? 3000;   // 0 = 已关闭（不轮询）

      // ===== 主题解析（皮肤已撤：固定方案 A——数值中性、条 ok=模块身份色；深浅色自动跟随 DSH 主题） =====
      const theme = pickTheme();                 // 'light' | 'dark'
      const P = {
        textPrimary: 'var(--dsw-alias-label-primary, #f9fafb)',
        textSecondary: 'var(--dsw-alias-label-secondary, #cfd3d6)',
        textTertiary: 'var(--dsw-alias-label-tertiary, #adb2b8)',
        border: 'var(--dsw-alias-border-l2, rgb(255 255 255 / 12%))',
        bgHeader: theme === 'light' ? 'rgba(0,0,0,0.045)' : 'rgba(255,255,255,0.04)',
        bgCard: theme === 'light' ? 'rgba(0,0,0,0.02)' : 'rgba(255,255,255,0.025)',
      };
      const identityCol = (m) => IDCOL[m][theme];          // 模块身份色
      const sCol = (lv) => SEM[lv][theme];                 // 语义色（warn/danger/ok）
      const dotColor = (lv) => lv === 'offline' ? P.textTertiary : sCol(lv);   // 状态点：ok 恒绿
      const valueColor = (lv) =>                           // 数值文字：正常 = 主文字色（方案 A 中性化，固定）
        lv === 'offline' ? P.textTertiary
        : lv === 'warn' || lv === 'danger' ? sCol(lv)
        : P.textPrimary;
      const fillColor = (m, lv) =>                         // 进度条：ok = 模块身份色（方案 A，固定）
        lv === 'warn' || lv === 'danger' ? sCol(lv)
        : lv === 'offline' ? P.textTertiary
        : identityCol(m);

      useEffect(() => {
        const u = loadUI();
        if (typeof u.expanded === 'boolean') setExpanded(u.expanded);
        if (typeof u.x === 'number') {
          const W = 350;
          setPos({ x: Math.max(0, Math.min(window.innerWidth - W, u.x)), y: Math.max(0, Math.min(window.innerHeight - 40, u.y)) });
        }
        let aliveFlag = true;
        const refresh = async () => {
          const pS = fetch('/monitor/api/status').then((r) => r.json()).catch(() => null);
          const pH = fetch('/monitor/api/history?spanMs=3600000&maxPoints=120').then((r) => r.json()).catch(() => null);
          const [s, hd] = await Promise.all([pS, pH]);
          if (!aliveFlag) return;
          setSt(s);
          if (hd && Array.isArray(hd.frames)) setHist(hd.frames);
        };
        refresh();
        const t = pollMs > 0 ? setInterval(refresh, pollMs) : null;
        return () => { aliveFlag = false; if (t) clearInterval(t); };
      }, [pollMs]);

      const toggle = () => { const n = !expanded; setExpanded(n); saveUI({ expanded: n, ...(pos || {}) }); };
      const doRefresh = async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
          const r = await (await fetch('/monitor/api/refresh')).json().catch(() => null);
          if (r && r.ok) setSt(r);
          const hd = await (await fetch('/monitor/api/history?spanMs=3600000&maxPoints=120')).json().catch(() => null);
          if (hd && Array.isArray(hd.frames)) setHist(hd.frames);
        } catch {} finally { setRefreshing(false); }
      };
      const refreshNow = async () => { try { setSt(await (await fetch('/monitor/api/status')).json()); } catch {} };
      const switchHost = async (hx) => { await fetch('/monitor/api/host?host=' + encodeURIComponent(hx)); refreshNow(); };
      const switchInterval = async (ms) => { await fetch('/monitor/api/config?intervalMs=' + ms); refreshNow(); };

      // ===== 整面板拖拽 + 边缘磁吸 =====
      const startDrag = useCallback((e) => {
        if (e.target !== e.currentTarget && e.target.closest('button,select')) return;
        dragMoved = false;
        const sx = e.clientX, sy = e.clientY;
        const rect = (panelRef.current || e.currentTarget).getBoundingClientRect();
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        const move = (ev) => {
          if (!dragMoved && (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy)) > 4) dragMoved = true;
          const SNAP = 28;
          let x = Math.max(0, Math.min(window.innerWidth - rect.width, ev.clientX - dx));
          let y = Math.max(0, Math.min(window.innerHeight - rect.height, ev.clientY - dy));
          if (x <= SNAP) x = 0;
          else if ((window.innerWidth - (x + rect.width)) <= SNAP) x = window.innerWidth - rect.width;
          if (y <= SNAP) y = 0;
          else if ((window.innerHeight - (y + rect.height)) <= SNAP) y = window.innerHeight - rect.height;
          setPos({ x, y });
          saveUI({ expanded, x, y });
        };
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        e.preventDefault();
      }, [expanded]);

      const pillClick = () => { if (dragMoved) { dragMoved = false; return; } toggle(); };

      const connected = status.connected === true;
      const alerts = status.alerts || [];
      const latest = status.latest || null;
      const health = status.health || 'offline';
      const th = status.cfg?.thresholds || {};
      // 模块显示勾选（设置卡可调；缺字段默认显示）
      const showGpu = status.cfg?.showGpu !== false;
      const showVllm = status.cfg?.showVllm !== false;
      const showCpu = status.cfg?.showCpu !== false;
      // 三段阈值解析（兼容旧配置：重启前缺字段时回退默认值）
      const T = {
        gpuTempWarn: th.gpuTempWarn ?? 82, gpuTempDanger: th.gpuTempDanger ?? 90,
        cpuTempWarn: th.cpuTempWarn ?? 70, cpuTempDanger: th.cpuTempDanger ?? 85,
        memPctWarn: th.memPctWarn ?? 70, memPctDanger: th.memPctDanger ?? 85,
        gpuUtilWarn: th.gpuUtilWarn ?? 70, gpuUtilDanger: th.gpuUtilDanger ?? 90,
        vramWarn: th.vramWarn ?? 70, vramDanger: th.vramDanger ?? 90,
        vllmKVWarn: th.vllmKVWarn ?? 70, vllmKVDanger: th.vllmKVDanger ?? 90,
        vllmWaitingWarn: th.vllmWaitingWarn ?? 8,
        mtpOk: th.mtpOk ?? 70, mtpWarnMin: th.mtpWarnMin ?? 50,
      };
      // 正向指标的阈值刻度线（高=危险）
      const lvMarks = (warn, danger, unit) => [
        { at: warn, color: sCol('warn'), title: warn + (unit || '%') + ' 紧张' },
        { at: danger, color: sCol('danger'), title: danger + (unit || '%') + ' 危险' },
      ];
      const linkLabel = status.linkNote || '';
      const hostSelect = status.cfg?.host || '192.168.31.142';
      const intervalMs = status.cfg?.intervalMs ?? 3000;   // ?? 而非 ||：0（关闭）不能被兜底成 3000
      const sim = status.cfg?.simulate === true;
      const dotLevel = connected ? (health === 'danger' ? 'danger' : health === 'warn' ? 'warn' : 'ok') : 'offline';
      const css = pos ? { left: pos.x, top: pos.y } : { right: 14, top: 96 };

      // ===== 持续超阈值闪烁（真实持续 SUST 帧才闪） =====
      const SUST = 3;
      const streakRef = useRef({});
      const streak = (key, lv) => {
        const s = streakRef.current[key];
        const n = (s && s.lv === lv) ? s.n + 1 : 1;
        streakRef.current[key] = { lv, n };
        return n;
      };
      const blinkFor = (key, cardLevel) => {
        const lv = cardLevel;
        if (lv === 'danger') return streak(key + ':d', lv) >= SUST ? 'danger' : null;
        if (lv === 'warn') return streak(key + ':w', lv) >= SUST ? 'warn' : null;
        streak(key + ':d', 'ok'); streak(key + ':w', 'ok');
        return null;
      };
      const blinkCls = (lv) => lv === 'danger' ? ' hm-blink-danger' : lv === 'warn' ? ' hm-blink-warn' : '';
      const dotCls = (lv) => lv === 'danger' ? ' hm-dot-danger' : '';

      // ===== 基础 UI 件 =====
      const dot = (lv, big) => h('span', { className: dotCls(lv), style: {
        width: big ? 9 : 7, height: big ? 9 : 7, borderRadius: '50%', flexShrink: 0, background: dotColor(lv),
        boxShadow: lv === 'danger' ? '0 0 6px 1px ' + sCol('danger') : lv === 'warn' ? '0 0 5px 1px ' + sCol('warn') : 'none',
        transition: 'background .3s ease',
      } });
      const mRow = (label, value, lv, valueTitle) => h('div', {
        style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', lineHeight: 1.55, marginTop: '4px', gap: '6px' },
        title: valueTitle || undefined,
      }, [
        h('span', { style: { minWidth: 0, color: P.textSecondary, fontSize: '11px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        h('span', { style: { color: valueColor(lv), fontSize: '13px', fontVariantNumeric: 'tabular-nums', fontFamily: 'var(--ds-font-family, inherit)' } }, value),
      ]);
      const bar = (pct, lv, moduleId, marks) => h('div', { style: { position: 'relative', height: 6, borderRadius: 3, background: P.border, overflow: 'hidden', margin: '3px 0 4px' } }, [
        h('div', { style: { height: '100%', width: Math.max(0, Math.min(100, Number(pct) || 0)) + '%', background: fillColor(moduleId, lv), borderRadius: 3, transition: 'width .5s ease, background .4s ease' } }),
        (marks || []).map((m) => h('div', { key: m.at, title: m.title, style: { position: 'absolute', top: 0, bottom: 0, left: m.at + '%', width: 1, background: m.color || P.textTertiary, opacity: 0.75 } })),
      ]);
      const mBar = (label, value, lv, pct, moduleId, marks, force, tip) => {
        return [
          mRow(label, value, lv, tip),
          (force || (pct !== null && pct !== undefined)) ? bar(pct ?? 0, lv, moduleId, marks) : null,
        ].filter(Boolean);
      };
      const card = (cls, accent, headerLeft, headerRight, children) => h('div', {
        className: cls || undefined,
        style: { border: '1px solid ' + P.border, borderLeft: '3px solid ' + accent, borderRadius: 8, padding: '6px 9px', marginBottom: '7px', background: P.bgCard },
      }, [
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '12px', marginBottom: '1px', gap: '6px' } }, [headerLeft, headerRight]),
        ...children,
      ]);

      const selectStyle = { background: P.bgCard, color: P.textPrimary, border: '1px solid ' + P.border, borderRadius: '5px', fontSize: '11px', padding: '2px 5px', fontFamily: 'inherit', colorScheme: theme };
      const hostSelectEl = h('select', { value: hostSelect, onChange: (e) => switchHost(e.target.value), style: selectStyle, title: '切换目标' }, [
        h('option', { value: '192.168.31.142' }, '192.168.31.142'),
        h('option', { value: '10.226.127.71' }, '10.226.127.71 · ZeroTier'),
      ]);
      const freqSelectEl = h('select', { value: String(intervalMs), onChange: (e) => switchInterval(Number(e.target.value)), style: selectStyle, title: '采集频率（关闭=停止采集，SSH 断开）' }, [
        [1, '1s'], [2, '2s'], [3, '3s'], [5, '5s'], [10, '10s'], [30, '30s'], [60, '60s'], [0, '关闭'],
      ].map(([s, lab]) => h('option', { key: s, value: String(s * 1000) }, lab)));

      // ===== GPU 板块（每张 GPU 顶层卡，独立闪烁；不可折叠） =====
      const gpus = latest?.gpu || [];
      const gpuLevel = (g) => {
        const t = levelOf(g.tempC ?? null, T.gpuTempWarn, T.gpuTempDanger);
        const u = utilLevelOf(g.utilPct ?? null, T.gpuUtilWarn, T.gpuUtilDanger);
        if (t === 'danger' || u === 'danger') return 'danger';
        return (t === 'warn' || u === 'warn') ? 'warn' : (t === 'offline' && u === 'offline' ? 'offline' : 'ok');
      };
      const gpuCards = (() => {
        if (!gpus.length) return [];
        return gpus.map((g) => {
          const name = (g.name || '').replace(/^NVIDIA GeForce /, '');
          const memP = g.memTotalMB > 0 ? Math.round((g.memUsedMB ?? 0) / g.memTotalMB * 100) : null;
          const utilPts = hist.map((f) => (f.gpu || []).find((x) => x.idx === g.idx)?.utilPct ?? null);
          const tLv = gpuLevel(g), uLv = utilLevelOf(g.utilPct ?? null, T.gpuUtilWarn, T.gpuUtilDanger), vLv = utilLevelOf(memP, T.vramWarn, T.vramDanger);
          return card(blinkCls(blinkFor('gpu' + g.idx, tLv)), identityCol('gpu'),
            h('span', { style: { color: identityCol('gpu'), fontSize: '12px' } }, 'GPU' + g.idx + (name ? ' · ' + name : '')),
            h('span', { style: { color: valueColor(tLv), fontSize: '13px', fontVariantNumeric: 'tabular-nums' } }, (g.tempC ?? '—') + '℃'),
            [
              ...mBar('使用率', (g.utilPct ?? '—') + '%', uLv, g.utilPct, 'gpu', lvMarks(T.gpuUtilWarn, T.gpuUtilDanger)),
              sparkline(utilPts, { color: identityCol('gpu'), min: 0, max: 100 }),
              ...mBar('显存', ((g.memUsedMB ?? 0) / 1024).toFixed(1) + ' / ' + ((g.memTotalMB ?? 0) / 1024).toFixed(0) + 'G', vLv, memP, 'gpu', lvMarks(T.vramWarn, T.vramDanger)),
            ]);
        });
      })();

      // ===== CPU / 内存板块 =====
      const cpuTempC = latest?.cpuTempC;
      const cpuUtil = latest?.cpuUtilPct;
      const memPct = latest?.memPct;
      const memUsedMB = latest?.memUsedMB, memTotalMB = latest?.memTotalMB;
      const cpuModel = status.cpuModel || '—';
      const cpuTLevel = levelOf(cpuTempC ?? null, T.cpuTempWarn, T.cpuTempDanger);
      const cpuULevel = utilLevelOf(cpuUtil ?? null, 90, 98);
      const memLevel = utilLevelOf(memPct ?? null, T.memPctWarn, T.memPctDanger);
      const cpuBlockLv = (cpuTLevel === 'danger' ? 'danger' : (cpuTLevel === 'warn' || cpuULevel === 'warn' || memLevel === 'warn' ? 'warn' : (connected ? 'ok' : 'offline')));
      const cpuMemCard = card(blinkCls(blinkFor('cpuCard', cpuBlockLv)), identityCol('cpu'), null, null, [
        h('div', { style: { marginBottom: '3px' } }, [
          h('span', { style: { color: identityCol('cpu'), fontSize: '12px' } }, 'CPU · ' + cpuModel),
        ]),
        ...mBar('CPU 温度', (cpuTempC ?? '—') + '℃', cpuTLevel, cpuTempC, 'cpu', lvMarks(T.cpuTempWarn, T.cpuTempDanger, '℃')),
        mRow('CPU 使用率', (cpuUtil ?? '—') + '%', cpuULevel),
        sparkline(hist.map((f) => f.cpuUtilPct ?? null), { color: identityCol('cpu'), min: 0, max: 100 }),
        ...mBar('内存', ((memPct ?? '—') + '% · ' + ((memUsedMB ?? 0) / 1024).toFixed(1) + '/' + ((memTotalMB ?? 0) / 1024).toFixed(1) + 'G'), memLevel, memPct, 'cpu', lvMarks(T.memPctWarn, T.memPctDanger)),
      ]);

      // ===== 推理板块（唯一保留标题栏；无图标） =====
      const vllmNow = latest?.vllm || null;
      const vn = vllmNow;
      const vllmModel = status.vllmModelName || status.cfg?.vllmModelName || '';
      const vllmAlive = vllmNow?.alive === true;
      const vllmKV = vllmNow?.kvCacheUsagePct;
      // 0.10.0：swap 入口状态（llama-swap 感知）——无数据时分档：加载中/模型未装载/入口掉线/离线
      const sw = status.swap || null;
      const loadingArm = sw && sw.state === 'loading' ? (sw.loadingArm || '') : '';
      const vState = !vllmAlive
        ? ((sw && sw.up === true && sw.state === 'loading' && loadingArm) ? 'loading'
          : (sw && sw.up === true && sw.state === 'idle') ? 'idle-model'
          : (sw && sw.up === false) ? 'down'
          : 'off')
        : (vllmNow.waitingCount > 0 ? ((vllmNow.waitingCount >= (T.vllmWaitingWarn || 8)) ? 'backlog' : 'queue')
        : (vllmNow.runningCount > 0 ? 'busy' : 'idle'));
      const vLv = { off: 'offline', 'idle-model': 'offline', loading: 'offline', down: 'warn', idle: 'ok', busy: 'ok', queue: 'warn', backlog: 'danger' }[vState];
      const vStateLabel = { off: '离线', 'idle-model': '模型未装载', loading: '换臂中', down: '入口掉线', idle: '空闲', busy: '生成中', queue: '排队中', backlog: '排队积压' }[vState];
      const genPts = hist.map((f) => f.vllmGen ?? null);
      const promptPts = hist.map((f) => f.vllmPrompt ?? null);
      const mtpMarks = [{ at: T.mtpWarnMin, color: sCol('danger'), title: T.mtpWarnMin + '% 危险线' }, { at: T.mtpOk, color: sCol('ok'), title: T.mtpOk + '% 优良线' }];
      const winGen = hist.length ? windowDeltaClient(hist, 'vllmGenTotal', 3600000) : null;
      const winPrompt = hist.length ? windowDeltaClient(hist, 'vllmPromptTotal', 3600000) : null;
      const totTip = '自进程启动累计：生成 ' + fmtTok(vllmNow?.generationTokensTotal) + ' · 处理 ' + fmtTok(vllmNow?.promptTokensTotal) + '（重启归零）';
      const rateTip = vllmNow?.engine === 'llama'
        ? 'llama 引擎：探针实测——每探针间隔发一发 64-token 小请求，读服务端自计时 timings（首次探针完成前显示 —；空闲期值不变属正常）'
        : 'vLLM 引擎：/metrics 计数器差值速率 + 直方图均值';
      const mtpLv = vllmNow?.specAcceptRate == null ? 'offline'
        : (vllmNow.specAcceptRate >= T.mtpOk ? 'ok' : vllmNow.specAcceptRate >= T.mtpWarnMin ? 'warn' : 'danger');

      const titleText = (vState === 'loading' && loadingArm) ? ('推理 · 加载中 ' + loadingArm)
        : (vllmModel ? '推理 · ' + vllmModel : '推理');
      // 占位说明一律不加（用户 2026-10-05 裁定：顶部状态位已表达；服务起来了下面的表自然出现，无需占位行）
      const offBody = vState === 'down' ? '推理入口掉线（:8000 无 /running 与 /metrics 响应）'
        : (vState === 'loading' || vState === 'idle-model') ? ''
        : (vllmModel ? '当前进程暂无 /metrics 数据' : '暂无运行中的模型');
      const vllmCard = card(blinkCls(blinkFor('vllmCard', vLv)), identityCol('vllm'),
        h('span', {
          title: titleText,
          style: { color: vllmAlive ? identityCol('vllm') : P.textSecondary, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, flex: 1, fontSize: '12px' },
        }, titleText),
        h('span', { style: { color: valueColor(vLv), fontSize: '11px', flexShrink: 0, whiteSpace: 'nowrap' } }, vStateLabel),
        vllmAlive ? [
          mRow('运行中 / 排队', (vn?.runningCount ?? 0) + ' / ' + (vn?.waitingCount ?? 0) + ' 个', (vn?.waitingCount ?? 0) >= (T.vllmWaitingWarn || 8) ? 'warn' : 'ok'),
          ...mBar('KV 缓存使用率', (vllmKV === null ? '—' : vllmKV + '%'), utilLevelOf(vllmKV, T.vllmKVWarn, T.vllmKVDanger), vllmKV, 'vllm', lvMarks(T.vllmKVWarn, T.vllmKVDanger), true),
          legend([{ text: '生成', color: identityCol('vllm') }, { text: '处理(输入)', color: P.textSecondary }]),
          sparklineMulti([{ points: genPts, color: identityCol('vllm') }, { points: promptPts, color: P.textSecondary }], { min: 0 }),
          mRow('生成速率', (vn?.genTokPerSec ?? '—') + ' t/s', 'ok', rateTip),
          mRow('输入速率', (vn?.promptTokPerSec ?? '—') + ' t/s', 'ok', rateTip),
          mRow('首字时延 TTFT', (vn?.ttftMs ?? '—') + ' ms', (vn?.ttftMs ?? 0) > 500 ? 'warn' : 'ok', rateTip),
          mRow('单字输出 TPOT', (vn?.tpotMs ?? '—') + ' ms', (vn?.tpotMs ?? 0) > 150 ? 'warn' : 'ok', rateTip),
          mRow(winLabel(winGen) + ' 生成 / 处理', (winGen ? fmtTok(winGen.delta) : '—') + ' / ' + (winPrompt ? fmtTok(winPrompt.delta) : '—') + ' tok', 'ok', totTip),
          [
            ...mBar('MTP 接受率', (vn?.specAcceptRate == null ? '—' : vn.specAcceptRate + '%'), mtpLv, vn?.specAcceptRate, 'vllm', mtpMarks, true, '近 60s 接受/草稿 滑窗比值；空闲（无新生成）显示「—」（累计比值空闲时会冻结，不再采用）'),
            mRow('MTP draft / acc', fmtTok(vn?.specDraftTokens) + ' / ' + fmtTok(vn?.specAcceptedTokens), 'ok', '自推理进程启动累计：draft tokens / accepted tokens'),
          ],
        ].filter((x) => x !== null && x !== undefined) : [
          // offBody 为空（模型未装载）时不占行——只剩标题 + 状态位
          ...(offBody ? [h('div', { style: { color: P.textSecondary, fontSize: '12px', padding: '3px 0 6px' } }, offBody)] : []),
        ]);

      const base = {
        position: 'fixed', zIndex: 9999, fontFamily: 'var(--ds-font-family, "Segoe UI", system-ui, sans-serif)',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #151517) 92%, transparent)', color: P.textPrimary, border: '1px solid ' + P.border, borderRadius: '10px',
        boxShadow: '0 4px 20px rgba(0,0,0,.35)', boxSizing: 'border-box', pointerEvents: 'auto',
      };
      // 主机标识：自动跟随远端 hostname（core.setHost 更新），无数据时退回目标 IP 标签
      const hostTag = sim ? '模拟' : (status.host || hostSelect);

      // ===== 收起态：顶栏同款 + 标题与 + 之间按优先级动态填关键数据（实测宽度贪心填充，不溢出） =====
      if (!expanded) {
        const cTitle = sim ? '监控（模拟）' : (intervalMs === 0 ? '监控 · 已暂停' : '监控 · ' + hostTag);
        const gpuAll = latest?.gpu || [];
        const g0 = gpuAll[0] || null, g1 = gpuAll[1] || null;
        const vNow = latest?.vllm || null;
        const worst = (la, lb) => (la === 'danger' || lb === 'danger' ? 'danger' : (la === 'warn' || lb === 'warn' ? 'warn' : 'ok'));
        const lvColor = (lv) => lv === 'danger' ? sCol('danger') : lv === 'warn' ? sCol('warn') : P.textPrimary;
        const measEl = () => {
          if (!_meas) { _meas = document.createElement('span'); _meas.style.cssText = 'position:absolute;top:-9999px;left:-9999px;visibility:hidden;white-space:nowrap;font-variant-numeric:tabular-nums'; document.body.appendChild(_meas); }
          // 字体保真：var() 在 body 上解析不到 DSH 应用内变量，改用已挂载面板的计算字体校正测量（首帧兜底）
          try { const ff = panelRef.current && getComputedStyle(panelRef.current).fontFamily; if (ff) _meas.style.fontFamily = ff; } catch { /* ignore */ }
          return _meas;
        };
        const wOf = (s, px) => { const el = measEl(); el.style.fontSize = px + 'px'; el.textContent = s; return el.offsetWidth; };
        const itemW = (it) => (it.lab ? wOf(it.lab, 9) + 3 : 0) + wOf(it.val, 11);
        const titleW = wOf(cTitle, 13);
        const plusW = wOf('+', 14) + 4;                  // "+" 文本宽 + 左右 padding 2×2
        // 三小容器槽位峰值宽（容器定宽依据：99/99℃｜100/100%｜1234 t/s）
        const labW = wOf('GPU', 9) + 3;
        const Z1 = labW + wOf('99/99℃', 11), Z2 = wOf('100/100%', 11), Z3 = wOf('1234 t/s', 11) + 8;
        const SEP_W = wOf('｜', 11);                     // "｜" 自然宽度（实测；分隔符不再定宽）
        const fixW = Z1 + Z2 + Z3 + SEP_W * 2;          // + 两条分隔符自然宽
        // 三联实时值
        const tempVal = (g0?.tempC ?? '—') + '/' + (g1?.tempC ?? '—') + '℃';
        const tempLv = worst(levelOf(g0?.tempC ?? null, T.gpuTempWarn, T.gpuTempDanger), levelOf(g1?.tempC ?? null, T.gpuTempWarn, T.gpuTempDanger));
        const utilVal = (g0?.utilPct ?? '—') + '/' + (g1?.utilPct ?? '—') + '%';
        const utilLv = worst(utilLevelOf(g0?.utilPct ?? null, T.gpuUtilWarn, T.gpuUtilDanger), utilLevelOf(g1?.utilPct ?? null, T.gpuUtilWarn, T.gpuUtilDanger));
        const tsVal = (vNow?.genTokPerSec ?? '—') + ' t/s';
        // 统一优先级列表：贪心按序填三槽；peak=该槽可容纳宽度；值含—(无数据)不占槽；按模块显示勾选过滤
        const items = [
          ...(showGpu ? [
            { lab: 'GPU', val: tempVal, tip: 'GPU0/GPU1 温度', lv: tempLv, peak: Z1 },
            { lab: '', val: utilVal, tip: 'GPU0/GPU1 使用率', need: 0, lv: utilLv, peak: Z2 },
          ] : []),
          ...(showVllm ? [
            { lab: '', val: tsVal, tip: '生成速率', lv: 'ok', peak: Z3 },
            { lab: '排队', val: (vNow?.runningCount ?? '—') + '/' + (vNow?.waitingCount ?? '—'), tip: '推理 运行中 / 排队', lv: (vNow?.waitingCount ?? 0) >= (T.vllmWaitingWarn || 8) ? 'warn' : 'ok', peak: Z3 },
          ] : []),
          ...(showCpu ? [
            { lab: 'CPU', val: (latest?.cpuTempC ?? '—') + '℃ ' + (latest?.cpuUtilPct ?? '—') + '%', tip: 'CPU 温度 · 使用率', lv: worst(levelOf(latest?.cpuTempC ?? null, T.cpuTempWarn, T.cpuTempDanger), utilLevelOf(latest?.cpuUtilPct ?? null, 90, 98)), peak: Z1 },
            { lab: 'MEM', val: (latest?.memPct ?? '—') + '%', tip: '内存使用率', lv: utilLevelOf(latest?.memPct ?? null, T.memPctWarn, T.memPctDanger), peak: Z3 },
          ] : []),
        ];
        // 槽位贪心：按优先级遍历 → 满3槽止 → 无数据跳过 → 依赖不满足跳过 → 超槽宽跳过 → 占槽
        const slots = [];
        for (let i = 0; i < items.length; i++) {
          const it = items[i];
          if (slots.length >= 3) break;
          if (it.val.indexOf('—') !== -1) continue;
          if (it.need != null && slots.indexOf(items[it.need]) === -1) continue;
          if (itemW(it) > it.peak) continue;
          slots.push(it);
        }
        return h('button', {
          ref: panelRef, onClick: pillClick, onPointerDown: startDrag,
          title: '按住拖动 · 点击展开',
          style: { ...css, ...base, width: 350, display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 10px', cursor: 'grab', background: P.bgHeader, userSelect: 'none', whiteSpace: 'nowrap', overflow: 'hidden' },
        }, [
          dot(dotLevel, true),
          h('span', { style: { fontSize: '13px', flexShrink: 0, marginRight: '6px' } }, cTitle),
          // 定宽三槽容器：槽位内容由贪心决定（左起/居中/右贴边），空槽留白，｜ 只出现在相邻占用槽之间
          h('span', { title: '三槽贪心：GPU温度 › 使用率 › 生成速率 › 排队 › CPU › 内存（无数据自动跳过）', style: { display: 'inline-flex', alignItems: 'baseline', width: fixW, flexShrink: 1, minWidth: 0 } }, [
            ...[0, 1, 2].flatMap((zi) => {
              const it = slots[zi];
              const zone = h('span', {
                key: 'z' + zi,
                style: { flex: '1 1 ' + [Z1, Z2, Z3][zi] + 'px', display: 'inline-flex', alignItems: 'baseline', justifyContent: zi === 0 ? 'flex-start' : zi === 1 ? 'center' : 'flex-end', gap: '3px', minWidth: 0, overflow: 'hidden' },
              }, it ? [
                it.lab ? h('span', { style: { color: P.textTertiary, fontSize: '9px' } }, it.lab) : null,
                h('span', { style: { color: lvColor(it.lv), fontSize: '11px', fontVariantNumeric: 'tabular-nums' } }, it.val),
              ] : null);
              const sep = zi > 0 && slots[zi - 1] && it ? h('span', { key: 's' + zi, style: { flexShrink: 0, textAlign: 'center', color: P.textTertiary, opacity: 0.5, fontSize: '11px' } }, '｜') : null;
              return sep ? [sep, zone] : [zone];
            }),
          ]),
          h('span', { title: '展开', style: { marginLeft: 'auto', fontSize: '14px', color: P.textTertiary, cursor: 'pointer', padding: '0 2px', userSelect: 'none' } }, '+'),
        ]);
      }

      // ===== 展开态：整面板可拖 =====
      return h('div', {
        ref: panelRef, style: { ...css, ...base, width: 350, overflow: 'hidden' }, onPointerDown: startDrag,
      }, [
        h('style', null, STYLE_CSS),
        h('div', {
          onPointerDown: startDrag, title: '按住拖动 · 点 − 收起',
          style: { display: 'flex', alignItems: 'center', gap: '7px', padding: '8px 10px', cursor: 'grab', background: P.bgHeader, borderBottom: '1px solid ' + P.border, userSelect: 'none' },
        }, [
          dot(dotLevel, true),
          h('span', { style: { fontSize: '13px' } }, sim ? '监控（模拟）' : (intervalMs === 0 ? '监控 · 已暂停' : '监控 · ' + hostTag)),
          h('button', { onClick: toggle, title: '收起', style: { background: 'transparent', border: 'none', color: P.textTertiary, fontSize: '14px', cursor: 'pointer', padding: '0 2px', marginLeft: 'auto' } }, '−'),
        ]),
        h('div', { style: { padding: '7px 10px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'space-between' } }, [
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: P.textSecondary } }, [
            h('span', { style: { fontSize: '10px' } }, '目标：'), hostSelectEl,
          ]),
          h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '4px', color: P.textSecondary } }, [
            h('span', { style: { fontSize: '10px' } }, '频率：'), freqSelectEl,
          ]),
          h('button', {
            onClick: doRefresh, disabled: intervalMs === 0 || refreshing,
            title: intervalMs === 0 ? '采集已关闭：先在「频率」开启采集' : '立刻拉取一帧最新监控数据（含模型名）',
            style: { position: 'relative', background: 'transparent', border: '1px solid ' + P.border, color: intervalMs === 0 ? P.textTertiary : P.textSecondary, fontSize: '10px', borderRadius: 5, padding: '2px 8px', cursor: intervalMs === 0 ? 'default' : 'pointer', flexShrink: 0, opacity: intervalMs === 0 ? 0.5 : 1 },
          }, refreshing ? [
            // 文案恒为「刷新」不换字（visibility:hidden 保留占位，宽度不变），加载动画居中覆盖在按钮上
            h('span', { style: { visibility: 'hidden' } }, '刷新'),
            h('span', { style: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' } }, [
              h('span', { className: 'hm-spin' }),
            ]),
          ] : '刷新'),
        ]),
        h('div', { style: { padding: '0 10px 8px' } }, [
          latest ? [
            ...(showGpu ? gpuCards : []),
            ...(showVllm ? [vllmCard] : []),
            ...(showCpu ? [cpuMemCard] : []),
          ]
            : (intervalMs === 0 ? null : h('div', { style: { color: sCol('warn'), fontSize: '12px', padding: '6px 0' } }, '暂无数据：等待首个采样…')),
        ]),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', padding: '6px 10px 7px', marginTop: '8px', fontSize: '10px', color: P.textTertiary, borderTop: '1px solid ' + P.border } }, [
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 } },
            (intervalMs === 0 ? '已暂停（采集关闭）'
              : (linkLabel || (connected ? '链路正常' : '未连接（自动重连中）')) + ' · ' + (status.samples ?? 0) + ' 帧' + ' · 频率' + (intervalMs / 1000).toFixed(intervalMs % 1000 ? 1 : 0) + 's')),
          h('span', {
            title: '服务器网络速度（整机物理网口合计，采样间隔差值；' + (latest?.net?.ifname || '暂无数据') + '）',
            style: { flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', color: P.textSecondary },
          }, '↑ ' + fmtBps(latest?.net?.upBps) + ' ↓ ' + fmtBps(latest?.net?.downBps)),
        ]),
      ]);
    };

    // ===== 设置卡（Plugins 标签页）：settings.plugin.item 插槽注册 =====
    // 卡片样式对照 DSH 标准卡片（--dsw-alias-* 设计令牌），client bundle 无 CSS 管道 → 内联 CSS-in-JS
    const SET_T = {
      borderL2: 'var(--dsw-alias-border-l2)', labelDimmed: 'var(--dsw-alias-label-dimmed)',
      labelPrimary: 'var(--dsw-alias-label-primary)', labelSecondary: 'var(--dsw-alias-label-secondary)',
      labelTertiary: 'var(--dsw-alias-label-tertiary)', labelError: 'var(--dsw-alias-label-error)',
      bgLayer2: 'var(--dsw-alias-bg-layer-2)', bgLayer3: 'var(--dsw-alias-bg-layer-3)',
      bgModulePlatform: 'var(--dsw-alias-bg-module-platform)', brandPrimary: 'var(--dsw-alias-brand-primary)',
    };
    const SC = {
      card: { listStyle: 'none', border: '1px solid ' + SET_T.borderL2, borderRadius: 12, background: SET_T.bgLayer3, transition: 'border-color .16s, background .16s' },
      cardOpen: { background: SET_T.bgLayer2, borderColor: SET_T.labelDimmed },
      header: { width: '100%', appearance: 'none', border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, padding: '14px 16px', borderRadius: 12 },
      headText: { flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 },
      name: { fontSize: 15, fontWeight: 600, lineHeight: 1.4, color: SET_T.labelPrimary },
      description: { fontSize: 13, lineHeight: 1.5, color: SET_T.labelTertiary },
      chevron: { flex: 'none', color: SET_T.labelTertiary, transition: 'transform .16s' },
      chevronOpen: { transform: 'rotate(180deg)' },
      body: { borderTop: '1px solid ' + SET_T.borderL2, margin: '0 16px', paddingBottom: 8 },
      pending: { flex: 'none', borderRadius: 999, padding: '1px 8px', fontSize: 11, lineHeight: '17px', fontWeight: 500, whiteSpace: 'nowrap', background: SET_T.bgModulePlatform, color: SET_T.labelSecondary },
      footer: { display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '12px 0 4px', borderTop: '1px solid ' + SET_T.borderL2 },
      field: { display: 'flex', flexDirection: 'column', gap: 6, padding: '12px 0' },
      fieldBorder: { borderTop: '1px solid ' + SET_T.borderL2 },
      head: { display: 'flex', alignItems: 'center', gap: 8 },
      label: { flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.5, color: SET_T.labelPrimary },
      input: { height: 34, padding: '0 12px', border: '1px solid ' + SET_T.borderL2, borderRadius: 8, background: SET_T.bgLayer3, font: 'inherit', fontSize: 13, lineHeight: 1.5, color: SET_T.labelPrimary, width: '100%', boxSizing: 'border-box' },
      invalid: { margin: 0, fontSize: 12, lineHeight: 1.5, color: SET_T.labelError },
      hint: { margin: 0, fontSize: 12, lineHeight: 1.5, color: SET_T.labelTertiary },
      checkLabel: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: SET_T.labelPrimary, cursor: 'pointer', marginRight: 14 },
      subTitle: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: SET_T.labelSecondary, paddingTop: 4, cursor: 'pointer', background: 'none', border: 'none', font: 'inherit' },
      btn: { border: '1px solid ' + SET_T.borderL2, borderRadius: 8, padding: '6px 14px', fontSize: 13, fontWeight: 500, cursor: 'pointer', background: SET_T.bgLayer3, color: SET_T.labelPrimary },
      btnDisabled: { opacity: .45, cursor: 'default' },
    };
    const ChevronIcon = ({ style, open }) => h('svg', { width: 14, height: 14, viewBox: '0 0 14 14', fill: 'none', xmlns: 'http://www.w3.org/2000/svg', style: open ? { ...style, ...SC.chevronOpen } : style }, [
      h('path', { d: 'M3 5.5 7 9.5 11 5.5', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }),
    ]);
    const HM_BOOL_KEYS = ['simulate', 'showGpu', 'showVllm', 'showCpu'];
    const HM_STR_KEYS = ['host', 'sshUser', 'sshPass', 'vllmBaseUrl', 'vllmModelName'];
    const HM_NUM_KEYS = ['intervalMs', 'probeIntervalMs', 'maxSamples', 'maxEvents', 'offlineMsFactor'];
    const HM_THR_FIELDS = [
      ['gpuTempWarn', 'GPU 温度预警 ℃'], ['gpuTempDanger', 'GPU 温度危险 ℃'],
      ['cpuTempWarn', 'CPU 温度预警 ℃'], ['cpuTempDanger', 'CPU 温度危险 ℃'],
      ['memPctWarn', '内存预警 %'], ['memPctDanger', '内存危险 %'],
      ['gpuUtilWarn', 'GPU 使用率预警 %'], ['gpuUtilDanger', 'GPU 使用率危险 %'],
      ['gpuUtilHighFrames', 'GPU 满载连续帧数'], ['vramWarn', '显存预警 %'], ['vramDanger', '显存危险 %'],
      ['vllmKVWarn', 'KV 缓存预警 %'], ['vllmKVDanger', 'KV 缓存危险 %'],
      ['vllmWaitingWarn', '请求排队预警（个）'], ['mtpOk', 'MTP 接受率 OK %'], ['mtpWarnMin', 'MTP 接受率预警下限 %'],
    ];
    const HM_FREQ_OPTS = [[0, '关闭（默认）'], [1000, '1 秒'], [2000, '2 秒'], [3000, '3 秒'], [5000, '5 秒'], [10000, '10 秒'], [30000, '30 秒'], [60000, '60 秒']];
    const HM_HOST_OPTS = [['192.168.31.142', '局域网 192.168.31.142'], ['10.226.127.71', 'ZeroTier 10.226.127.71']];

    function MonitorSettingsCard({ value, set }) {
      const [open, setOpen] = useState(false);
      const [thrOpen, setThrOpen] = useState(false);
      // local = 本地固化基准：保存后立即生效，不等 settings describe 快照刷新（异步有延迟，
      // 否则保存后 UI 会短暂回退到保存前的旧值，需刷新才同步）——勾选→保存链路本身是好的
      // local = 本地固化基准：保存后立即生效并持久化到 localStorage——settings describe 快照
      // 异步刷新有延迟（保存后回退旧值 / 页面刷新后首渲染读旧值），local 优先绕开时序；
      // host-monitor 的 settings 仅由本卡片修改，local 与后端值始终一致
      const [local, setLocal] = useState(() => {
        try { const s = localStorage.getItem('dsh:host-monitor:settings-local'); return s ? JSON.parse(s) : null; } catch { return null; }
      });
      const base = local ?? value ?? {};
      const [bools, setBools] = useState(null);
      const [strs, setStrs] = useState(null);
      const [nums, setNums] = useState(null);
      const [thrs, setThrs] = useState(null);
      const boolDirty = bools !== null && HM_BOOL_KEYS.some((k) => bools[k] !== !!base[k]);
      const strDirty = strs !== null && HM_STR_KEYS.some((k) => strs[k] !== (base[k] ?? ''));
      const numDirty = nums !== null && HM_NUM_KEYS.some((k) => nums[k] !== String(base[k] ?? ''));
      const thrDirty = thrs !== null && HM_THR_FIELDS.some(([k]) => thrs[k] !== String(base.thresholds?.[k] ?? ''));
      const invalid = (nums !== null && HM_NUM_KEYS.some((k) => nums[k] !== '' && !Number.isFinite(Number(nums[k])))) ||
        (thrs !== null && HM_THR_FIELDS.some(([k]) => thrs[k] !== '' && !Number.isFinite(Number(thrs[k]))));
      const dirty = boolDirty || strDirty || numDirty || thrDirty;
      const cur = {
        ...base,
        ...(bools || {}),
        ...(strs || {}),
        ...Object.fromEntries(HM_NUM_KEYS.map((k) => [k, nums ? (nums[k] === '' ? undefined : Number(nums[k])) : base[k]])),
      };
      const setBool = (k, v) => setBools((d) => ({ ...(d ?? base), [k]: v }));
      const setStr = (k, v) => setStrs((d) => ({ ...(d ?? base), [k]: v }));
      const setNum = (k, v) => setNums((d) => ({ ...(d ?? Object.fromEntries(HM_NUM_KEYS.map((x) => [x, String(base[x] ?? '')]))), [k]: v }));
      const setThr = (k, v) => setThrs((d) => ({ ...(d ?? Object.fromEntries(HM_THR_FIELDS.map(([x]) => [x, String(base.thresholds?.[x] ?? '')]))), [k]: v }));
      const onSave = () => {
        if (!dirty || invalid) return;
        for (const k of HM_BOOL_KEYS) if (bools !== null && bools[k] !== !!base[k]) set(k, bools[k]);
        for (const k of HM_STR_KEYS) if (strs !== null && strs[k] !== (base[k] ?? '')) set(k, strs[k]);
        for (const k of HM_NUM_KEYS) if (nums !== null && nums[k] !== String(base[k] ?? '')) set(k, nums[k] === '' ? undefined : Number(nums[k]));
        if (thrs !== null && thrDirty) {
          const t = { ...(base.thresholds || {}) };
          for (const [k] of HM_THR_FIELDS) t[k] = thrs[k] === '' ? undefined : Number(thrs[k]);
          set('thresholds', t);
        }
        // 本地固化新值为基准：立即反映，不等 settings describe 快照刷新（避免"保存后回退旧值"的时间差）
        const next = { ...base };
        if (bools !== null) Object.assign(next, bools);
        if (strs !== null) Object.assign(next, strs);
        if (nums !== null) for (const k of HM_NUM_KEYS) next[k] = nums[k] === '' ? undefined : Number(nums[k]);
        if (thrs !== null) {
          next.thresholds = { ...(next.thresholds || {}) };
          for (const [k] of HM_THR_FIELDS) next.thresholds[k] = thrs[k] === '' ? undefined : Number(thrs[k]);
        }
        setLocal(next);
        try { localStorage.setItem('dsh:host-monitor:settings-local', JSON.stringify(next)); } catch {}
        setBools(null); setStrs(null); setNums(null); setThrs(null);
      };
      const onDiscard = () => { setBools(null); setStrs(null); setNums(null); setThrs(null); };
      const name = '服务器监控';
      const description = 'SSH 监控远程 GPU×2 / CPU / 内存 / 推理服务：模块显示、采集频率与阈值可调';
      const field = (label, hint, control) => h('div', { style: { ...SC.field, ...SC.fieldBorder } }, [
        h('div', { style: SC.head }, [h('span', { style: SC.label }, label)]),
        control,
        hint ? h('p', { style: SC.hint }, hint) : null,
      ]);
      return h('li', { style: open ? { ...SC.card, ...SC.cardOpen } : SC.card }, [
        h('button', { type: 'button', style: SC.header, 'aria-expanded': open, onClick: () => setOpen(!open) }, [
          h('span', { style: SC.headText }, [
            h('span', { style: SC.name }, name),
            h('span', { style: SC.description }, description),
          ]),
          dirty ? h('span', { style: SC.pending }, '未保存') : null,
          h(ChevronIcon, { style: SC.chevron, open }),
        ]),
        open ? h('div', { style: SC.body }, [
          field('目标主机', '切换监控目标（局域网 / ZeroTier）', h('select', { value: cur.host ?? '192.168.31.142', onChange: (e) => setStr('host', e.target.value), style: SC.input }, HM_HOST_OPTS.map(([v, l]) => h('option', { value: v, key: v }, l)))),
          field('采集频率', '0 = 关闭采集（默认）；选秒数即手动开启', h('select', { value: String(cur.intervalMs ?? 0), onChange: (e) => setNum('intervalMs', e.target.value), style: SC.input }, HM_FREQ_OPTS.map(([v, l]) => h('option', { value: String(v), key: v }, l)))),
          field('模块显示', '小窗各信息块是否显示（收起态三槽同步遵循）', h('div', { style: { display: 'flex', flexWrap: 'wrap' } }, [
            h('label', { style: SC.checkLabel }, [h('input', { type: 'checkbox', checked: !!cur.showGpu, onChange: (e) => setBool('showGpu', e.target.checked) }), h('span', {}, '显卡块')]),
            h('label', { style: SC.checkLabel }, [h('input', { type: 'checkbox', checked: !!cur.showVllm, onChange: (e) => setBool('showVllm', e.target.checked) }), h('span', {}, '推理块')]),
            h('label', { style: SC.checkLabel }, [h('input', { type: 'checkbox', checked: !!cur.showCpu, onChange: (e) => setBool('showCpu', e.target.checked) }), h('span', {}, 'CPU·内存块')]),
          ])),
          field('模拟模式', '不连 142，本地生成演示数据', h('label', { style: SC.checkLabel }, [h('input', { type: 'checkbox', checked: !!cur.simulate, onChange: (e) => setBool('simulate', e.target.checked) }), h('span', {}, '启用模拟')])),
          field('SSH 用户', '', h('input', { value: cur.sshUser ?? '', onChange: (e) => setStr('sshUser', e.target.value), style: SC.input })),
          field('SSH 密码', '仅存本机 DSH 设置文件', h('input', { type: 'password', value: cur.sshPass ?? '', onChange: (e) => setStr('sshPass', e.target.value), style: SC.input })),
          field('推理服务地址', '宿主机直连取数；{host} 占位=当前目标 IP', h('input', { value: cur.vllmBaseUrl ?? '', onChange: (e) => setStr('vllmBaseUrl', e.target.value), style: SC.input })),
          field('模型名兜底', '留空 = 自动读取失败时不显示模型名', h('input', { value: cur.vllmModelName ?? '', onChange: (e) => setStr('vllmModelName', e.target.value), style: SC.input })),
          field('探针间隔 ms', 'llama.cpp 速率/时延探针间隔；0 = 关', h('input', { value: nums ? (nums.probeIntervalMs ?? '') : String(base.probeIntervalMs ?? 60000), onChange: (e) => setNum('probeIntervalMs', e.target.value), style: SC.input })),
          h('div', { style: { ...SC.field, ...SC.fieldBorder } }, [
            h('button', { type: 'button', style: SC.subTitle, onClick: () => setThrOpen(!thrOpen) }, [h(ChevronIcon, { style: SC.chevron, open: thrOpen }), h('span', {}, '告警阈值（' + HM_THR_FIELDS.length + ' 项）')]),
            thrOpen ? h('div', { style: { marginTop: 4 } }, HM_THR_FIELDS.map(([k, l]) => h('div', { key: k, style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 0' } }, [
              h('span', { style: { flex: 1, fontSize: 12, color: SET_T.labelSecondary } }, l),
              h('input', { value: thrs ? (thrs[k] ?? '') : String(base.thresholds?.[k] ?? ''), onChange: (e) => setThr(k, e.target.value), style: { ...SC.input, width: 90, flex: 'none' } }),
            ]))) : null,
          ]),
          invalid ? h('p', { style: SC.invalid }, '存在非法数字，无法保存') : null,
          h('div', { style: SC.footer }, [
            h('button', { type: 'button', style: { border: 'none', background: 'none', padding: 0, font: 'inherit', fontSize: 12, color: SET_T.labelSecondary, cursor: 'pointer' }, onClick: onDiscard, disabled: !dirty }, '放弃'),
            h('button', { type: 'button', style: { ...SC.btn, ...(dirty && !invalid ? {} : SC.btnDisabled) }, onClick: onSave, disabled: !dirty || invalid }, '保存'),
          ]),
        ]) : null,
      ]);
    }

    exports.inject = ['slots'];
    exports.apply = (ctx) => {
      ctx.slots.inject('shell.overlay', () => ctx.slots.register(
        { name: 'shell.overlay', id: 'host-monitor', order: 100, label: '🖥 服务器监控' },
        HostMonitorView,
      ));
      // 设置卡（Plugins 标签页）：settings.plugin.item 插槽，key = namespace 名；注册失败不影响浮动小窗
      // 0.9.0 桌面端适配：settingsScope 不再进 inject——桌面端 0.2.0 客户端运行时无此服务，
      // 声明它会让整个 client 模块永久 pending（浮动小窗都不会出现，2026-09-29 实测）。
      // 跨平台取法：先属性访问（web 端 runtime 模块增强=真实属性），抛错/缺席再 ctx.get（provided service）；
      // 桌面端两路皆空 → 跳过设置卡，浮动小窗不受影响（cordis ctx.get 缺席服务返回 undefined 不抛错，已实证）。
      try {
        let settingsScope;
        try { settingsScope = ctx.settingsScope; } catch (e) { /* 桌面端：ctx 代理拒绝未注入属性 */ }
        if (!settingsScope) { try { settingsScope = ctx.get('settingsScope'); } catch (e) { /* 无此方法或服务 */ } }
        if (settingsScope) {
          const scope = settingsScope.bind({ namespace: 'host-monitor' });
          ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
            name: 'settings.plugin.item',
            key: 'host-monitor',
            inject: () => ({
              value: scope.getSnapshot().value ?? {},
              set: (field, value) => { scope.set(field, value); },
            }),
          }, MonitorSettingsCard));
        }
      } catch (err) {
        console.warn('[host-monitor] settings card register failed:', err);
      }
    };
    return module.exports;
  }
});
