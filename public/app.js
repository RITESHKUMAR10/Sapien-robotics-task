'use strict';
(() => {
  const W = 800, H = 600;
  const $ = (id) => document.getElementById(id);
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const SESSION_KEY = 'doodle.session'; // sessionStorage: per-tab, survives refresh

  const S = {
    ws: null, code: null, name: '', me: null,
    st: null,            // latest state message
    replays: [],
    ops: [], seq: 0, resyncing: false,
    offset: 0,           // serverNow - clientNow
    tool: 'pen', color: '#000000', size: 7,
    cur: null, pending: [], flushTimer: null,
    overlayKey: '', retryStart: 0, retryN: 0, leaving: false,
  };

  // ------------------------------------------------------------ helpers

  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') n.className = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else n[k] = v;
    }
    for (const k of kids) if (k != null) n.append(k.nodeType ? k : document.createTextNode(k));
    return n;
  }
  const saveSession = (s) => { try { s ? sessionStorage.setItem(SESSION_KEY, JSON.stringify(s)) : sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } };
  const loadSession = () => { try { return JSON.parse(sessionStorage.getItem(SESSION_KEY)); } catch { return null; } };
  const send = (o) => { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); };
  const serverNow = () => Date.now() + S.offset;
  const iAmDrawer = () => S.st && S.st.drawerId === S.me;
  const canDraw = () => S.st && S.st.phase === 'drawing' && iAmDrawer();

  // ------------------------------------------------------------ drawing primitives
  // Both the live canvas and the end-of-game replay use these, so what you see
  // while playing is exactly what is replayed.

  function seg(c, color, w, x0, y0, x1, y1) {
    c.strokeStyle = color;
    c.lineWidth = w;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.beginPath();
    c.moveTo(x0, y0);
    c.lineTo(x1, y1);
    c.stroke();
  }
  function dot(c, color, w, x, y) {
    c.fillStyle = color;
    c.beginPath();
    c.arc(x, y, w / 2, 0, Math.PI * 2);
    c.fill();
  }
  function hexRgb(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  // Scanline flood fill. Deterministic given the same canvas, so every client
  // that applies the same ops in the same order ends with the same pixels.
  function floodFill(c, sx, sy, hex) {
    const img = c.getImageData(0, 0, W, H);
    const d = img.data;
    const [fr, fg, fb] = hexRgb(hex);
    const si = (sy * W + sx) * 4;
    const tr = d[si], tg = d[si + 1], tb = d[si + 2];
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 8) return;
    const TOL = 110; // swallow anti-aliased edge pixels
    const match = (i) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= TOL;
    const seen = new Uint8Array(W * H);
    const stack = [[sx, sy]];
    while (stack.length) {
      const [x, y] = stack.pop();
      const row = y * W;
      if (seen[row + x] || !match((row + x) * 4)) continue;
      let x1 = x, x2 = x;
      while (x1 > 0 && !seen[row + x1 - 1] && match((row + x1 - 1) * 4)) x1--;
      while (x2 < W - 1 && !seen[row + x2 + 1] && match((row + x2 + 1) * 4)) x2++;
      for (let xi = x1; xi <= x2; xi++) {
        const j = row + xi;
        seen[j] = 1;
        d[j * 4] = fr; d[j * 4 + 1] = fg; d[j * 4 + 2] = fb; d[j * 4 + 3] = 255;
      }
      for (const ny of [y - 1, y + 1]) {
        if (ny < 0 || ny >= H) continue;
        let run = false;
        for (let xi = x1; xi <= x2; xi++) {
          const j = ny * W + xi;
          const ok = !seen[j] && match(j * 4);
          if (ok && !run) stack.push([xi, ny]);
          run = ok;
        }
      }
    }
    c.putImageData(img, 0, 0);
  }

  function applyOp(c, op) {
    if (op.k === 'f') return floodFill(c, op.x, op.y, op.c);
    const p = op.pts;
    dot(c, op.c, op.w, p[0], p[1]);
    for (let i = 2; i < p.length; i += 2) seg(c, op.c, op.w, p[i - 2], p[i - 1], p[i], p[i + 1]);
  }
  function whiten(c) { c.fillStyle = '#fff'; c.fillRect(0, 0, W, H); }
  function redraw() {
    whiten(ctx);
    for (const op of S.ops) applyOp(ctx, op);
  }

  // ------------------------------------------------------------ connection

  function wsUrl() { return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws'; }

  function connect(hello) {
    const ws = new WebSocket(wsUrl());
    S.ws = ws;
    ws.onopen = () => { S.retryN = 0; S.retryStart = 0; banner(''); send(hello()); };
    ws.onmessage = (e) => onMsg(JSON.parse(e.data));
    ws.onclose = () => {
      if (S.ws !== ws || S.leaving) return;
      if (!S.code) return homeMsg('Could not reach the server.');
      reconnect();
    };
  }

  // Automatic rejoin: the server keeps our seat and score for 30s.
  function reconnect() {
    if (!S.retryStart) S.retryStart = Date.now();
    if (Date.now() - S.retryStart > 40000) return goHome('Connection lost. The room may have ended.');
    banner('Connection lost – reconnecting…');
    const delay = Math.min(400 * 2 ** S.retryN++, 3000);
    setTimeout(() => {
      if (S.leaving || !S.code) return;
      connect(() => ({ t: 'join', room: S.code, name: S.name, token: S.token }));
    }, delay);
  }

  function banner(text) {
    $('banner').textContent = text;
    $('banner').classList.toggle('hidden', !text);
  }
  function homeMsg(text) { $('homeMsg').textContent = text || ''; }

  function goHome(msg) {
    S.leaving = true;
    S.code = null; S.token = null; S.st = null; S.cur = null;
    saveSession(null);
    const old = S.ws;
    S.ws = null;
    if (old) { try { old.close(); } catch { /* ignore */ } }
    history.replaceState(null, '', '/');
    $('game').classList.add('hidden');
    $('home').classList.remove('hidden');
    banner('');
    homeMsg(msg);
    S.leaving = false;
  }

  // ------------------------------------------------------------ message handling

  function onMsg(m) {
    switch (m.t) {
      case 'joined':
        S.code = m.code; S.me = m.id; S.token = m.token;
        saveSession({ code: m.code, token: m.token, name: S.name });
        history.replaceState(null, '', '/r/' + m.code);
        $('home').classList.add('hidden');
        $('game').classList.remove('hidden');
        $('roomCode').textContent = m.code;
        if (!$('chatLog').childElementCount) addChat('system', 'Share the invite link so friends can join.');
        break;
      case 'state':
        S.st = m;
        S.offset = m.serverNow - Date.now();
        render();
        break;
      case 'sync':
        S.ops = m.ops; S.seq = m.seq; S.resyncing = false;
        redraw();
        break;
      case 'stroke_begin': case 'stroke_pts': case 'stroke_end': case 'fill': case 'undo': case 'clear':
        applyRemote(m);
        break;
      case 'hint':
        if (S.st) { S.st.hint = m.hint; renderHint(); }
        break;
      case 'chat':
        onChat(m);
        break;
      case 'replays':
        S.replays = m.drawings;
        S.overlayKey = '';
        render();
        break;
      case 'pong':
        $('ping').textContent = (Date.now() - m.ts) + ' ms';
        break;
      case 'error':
        if (m.code === 'room_not_found') return goHome(m.message);
        if (!S.code) return homeMsg(m.message);
        if (m.code === 'draw_limit') send({ t: 'resync' });
        addChat('error', m.message);
        break;
      case 'server_restart':
        banner('Server is restarting…');
        break;
      case 'left':
        break;
      default:
    }
  }

  // Ordering: ops carry a server sequence number. Over one WebSocket (TCP) they
  // arrive in order, so a gap means we missed something (e.g. the server dropped
  // us as a slow consumer) and we ask for the authoritative op-log instead of guessing.
  function applyRemote(m) {
    if (S.resyncing) return;
    if (m.seq !== S.seq + 1) {
      S.resyncing = true;
      return send({ t: 'resync' });
    }
    S.seq = m.seq;
    const last = S.ops[S.ops.length - 1];
    switch (m.t) {
      case 'stroke_begin': {
        const op = { k: 's', c: m.c, w: m.w, pts: [m.x, m.y] };
        S.ops.push(op);
        dot(ctx, op.c, op.w, m.x, m.y);
        break;
      }
      case 'stroke_pts':
        if (last && last.k === 's') {
          for (let i = 0; i < m.pts.length; i += 2) {
            const n = last.pts.length;
            seg(ctx, last.c, last.w, last.pts[n - 2], last.pts[n - 1], m.pts[i], m.pts[i + 1]);
            last.pts.push(m.pts[i], m.pts[i + 1]);
          }
        }
        break;
      case 'fill': {
        const op = { k: 'f', c: m.c, x: m.x, y: m.y };
        S.ops.push(op);
        applyOp(ctx, op);
        break;
      }
      case 'undo': S.ops.pop(); redraw(); break;
      case 'clear': S.ops = []; redraw(); break;
      default:
    }
  }

  // ------------------------------------------------------------ chat

  function addChat(kind, text, name, isPrivate) {
    const log = $('chatLog');
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const row = el('div', { class: `msg ${kind}${isPrivate ? ' private' : ''}` });
    if (name) row.append(el('b', {}, name + (isPrivate ? ' 🔒' : '') + ':'));
    row.append(text);
    log.append(row);
    while (log.childElementCount > 200) log.firstChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
  function onChat(m) {
    if (m.kind === 'system') {
      addChat(/guessed the word/.test(m.text) ? 'correct' : 'system', m.text);
    } else if (m.kind === 'close') {
      addChat('close', '🔥 Close!');
    } else {
      addChat('chat', m.text, m.name, m.private);
    }
  }

  // ------------------------------------------------------------ rendering

  function renderHint() {
    const st = S.st;
    const box = $('hint');
    box.textContent = '';
    if (!st) return;
    if (st.phase === 'drawing') {
      const text = st.word || st.hint;
      box.append(text.split('').join(' '));
      if (!st.word) box.append(el('small', {}, `(${text.replace(/[^\p{L}\p{N}_]/gu, '').length} letters)`));
      if (st.word) box.append(el('small', {}, iAmDrawer() ? 'draw this!' : 'you got it'));
    } else if (st.phase === 'choosing') {
      box.append(iAmDrawer() ? 'Pick a word' : 'Get ready…');
    }
  }

  function render() {
    const st = S.st;
    if (!st) return;
    $('roundInfo').textContent = st.round ? `Round ${Math.min(st.round, st.settings.rounds)}/${st.settings.rounds}` : '';
    renderHint();
    renderPlayers();
    renderOverlay();

    const drawing = canDraw();
    $('tools').classList.toggle('disabled', !drawing);
    canvas.classList.toggle('no-draw', !drawing);
    const input = $('chatInput');
    input.placeholder = drawing ? 'Only players who guessed can see this chat'
      : st.phase === 'drawing' ? 'Type your guess…' : 'Say something…';
    updateTimer();
  }

  function renderPlayers() {
    const st = S.st;
    const box = $('players');
    box.textContent = '';
    const sorted = [...st.players].sort((a, b) => b.score - a.score);
    sorted.forEach((p, i) => {
      const tags = [];
      if (p.id === st.hostId) tags.push('👑');
      if (p.id === st.drawerId && ['choosing', 'drawing'].includes(st.phase)) tags.push('✏️');
      if (p.guessed && p.id !== st.drawerId) tags.push('✅');
      box.append(el('div', {
        class: `player${p.id === S.me ? ' me' : ''}${p.connected ? '' : ' offline'}${p.guessed ? ' guessed' : ''}`,
        title: p.connected ? '' : 'Disconnected – has 30s to rejoin',
      },
      el('span', { class: 'rank' }, i + 1),
      el('span', { class: 'nm' }, p.name + (p.id === S.me ? ' (you)' : '')),
      el('span', {}, tags.join(' ')),
      el('span', { class: 'sc' }, p.score)));
    });
  }

  function updateTimer() {
    const st = S.st;
    const t = $('timer');
    if (!st || !st.endsAt || !['choosing', 'drawing', 'turn_end', 'waiting'].includes(st.phase)) {
      t.textContent = '–';
      t.classList.remove('low');
      return;
    }
    const left = Math.max(0, Math.ceil((st.endsAt - serverNow()) / 1000));
    t.textContent = left;
    t.classList.toggle('low', st.phase === 'drawing' && left <= 10);
  }
  setInterval(updateTimer, 250);

  // The overlay is rebuilt only when its key changes, so frequent state
  // broadcasts don't restart a running replay animation.
  function renderOverlay() {
    const st = S.st;
    const ov = $('overlay');
    let key = st.phase;
    if (st.phase === 'lobby') key += `:${st.players.length}:${st.hostId}:${S.me}`;
    else if (st.phase === 'choosing') key += `:${st.endsAt}:${(st.choices || []).join('|')}`;
    else if (st.phase === 'turn_end') key += `:${st.endsAt}`;
    else if (st.phase === 'game_over') key += `:${S.replays.length}`;
    if (key === S.overlayKey) return;
    S.overlayKey = key;
    stopReplay();
    ov.textContent = '';
    ov.className = 'overlay hidden';
    if (st.phase === 'drawing') return;

    const show = (card, top) => {
      ov.className = 'overlay' + (top ? ' top' : '');
      ov.append(card);
    };
    const host = st.hostId === S.me;

    if (st.phase === 'lobby') {
      const link = `${location.origin}/r/${st.code}`;
      show(el('div', { class: 'card' },
        el('h2', {}, 'Waiting for players'),
        el('p', { class: 'muted' }, `${st.settings.rounds} rounds · ${st.settings.drawTime}s per turn · ${st.settings.words} words`),
        el('div', { class: 'link-box' },
          el('input', { value: link, readOnly: true, onclick: (e) => e.target.select() }),
          el('button', { onclick: copyLink }, 'Copy')),
        host
          ? el('button', {
            class: 'primary', disabled: st.players.filter((p) => p.connected).length < 2,
            onclick: () => send({ t: 'start' }),
          }, st.players.length < 2 ? 'Need 2+ players' : 'Start game')
          : el('p', { class: 'muted' }, 'The host will start the game…')));
    } else if (st.phase === 'choosing') {
      if (iAmDrawer() && st.choices) {
        show(el('div', { class: 'card' },
          el('h2', {}, 'Choose a word to draw'),
          el('div', { class: 'choices' },
            ...st.choices.map((w, i) => el('button', { onclick: () => send({ t: 'choose_word', index: i }) }, w)))));
      } else {
        const d = st.players.find((p) => p.id === st.drawerId);
        show(el('div', { class: 'card' }, el('h2', {}, `${d ? d.name : 'Someone'} is choosing a word…`)), true);
      }
    } else if (st.phase === 'turn_end') {
      const r = st.turnResult || {};
      const why = { time: "Time's up!", all_guessed: 'Everyone guessed it!', drawer_left: 'The drawer left.' }[r.reason] || '';
      show(el('div', { class: 'card' },
        el('p', { class: 'muted' }, why),
        el('h2', {}, r.word ? `The word was “${r.word}”` : 'Turn skipped'),
        el('ul', { class: 'gains' },
          ...(r.gains || []).map((g) => el('li', {}, el('span', {}, g.name), el('span', { class: 'pos' }, `+${g.gain}`))))), true);
    } else if (st.phase === 'waiting') {
      show(el('div', { class: 'card' },
        el('h2', {}, 'Waiting for players to reconnect…'),
        el('p', { class: 'muted' }, 'The game resumes when at least 2 players are connected.')));
    } else if (st.phase === 'game_over') {
      renderGameOver(show, host);
    }
  }

  function copyLink() {
    const link = `${location.origin}/r/${S.code}`;
    (navigator.clipboard ? navigator.clipboard.writeText(link) : Promise.reject())
      .then(() => toast('Invite link copied'), () => toast(link));
  }
  let toastTimer;
  function toast(text) {
    banner(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => banner(''), 2000);
  }

  // ------------------------------------------------------------ end-of-game replay

  let replayRaf = 0;
  function stopReplay() { cancelAnimationFrame(replayRaf); replayRaf = 0; }

  // Re-draws a finished drawing stroke by stroke (~6s each, whatever its size).
  function playReplay(rc, ops, onDone) {
    stopReplay();
    const c = rc.getContext('2d', { willReadFrequently: true });
    whiten(c);
    const steps = [];
    for (const op of ops) {
      if (op.k === 'f') steps.push([op]);
      else {
        steps.push([op, 0]);
        for (let i = 2; i < op.pts.length; i += 2) steps.push([op, i]);
      }
    }
    const perFrame = Math.max(1, Math.ceil(steps.length / 360));
    let i = 0;
    const tick = () => {
      for (let n = 0; n < perFrame && i < steps.length; n++, i++) {
        const [op, j] = steps[i];
        if (op.k === 'f') floodFill(c, op.x, op.y, op.c);
        else if (j === 0) dot(c, op.c, op.w, op.pts[0], op.pts[1]);
        else seg(c, op.c, op.w, op.pts[j - 2], op.pts[j - 1], op.pts[j], op.pts[j + 1]);
      }
      if (i < steps.length) replayRaf = requestAnimationFrame(tick);
      else if (onDone) replayRaf = setTimeout(onDone, 1200);
    };
    replayRaf = requestAnimationFrame(tick);
  }

  function renderGameOver(show, host) {
    const st = S.st;
    const sorted = [...st.players].sort((a, b) => b.score - a.score);
    const medals = ['🥇', '🥈', '🥉'];
    const board = el('div', { class: 'scoreboard' },
      ...sorted.map((p, i) => el('div', { class: `player${p.id === S.me ? ' me' : ''}` },
        el('span', { class: 'rank' }, medals[i] || i + 1),
        el('span', { class: 'nm' }, p.name),
        el('span', { class: 'sc' }, p.score))));

    const rc = el('canvas', { width: W, height: H });
    const caption = el('div', { class: 'muted' }, '');
    const tabs = el('div', { class: 'replay-tabs' });
    let auto = true;
    const play = (idx) => {
      const d = S.replays[idx];
      [...tabs.children].forEach((b, i) => b.classList.toggle('active', i === idx));
      caption.textContent = `Round ${d.round} · ${d.drawer} drew “${d.word}”`;
      playReplay(rc, d.ops, () => { if (auto) play((idx + 1) % S.replays.length); });
    };
    S.replays.forEach((d, i) => tabs.append(el('button', { onclick: () => { auto = false; play(i); } }, `${i + 1}. ${d.word}`)));

    const replayCol = S.replays.length
      ? el('div', {}, el('h3', {}, 'Replay'), el('div', { class: 'replay-box' }, rc, caption, tabs))
      : el('p', { class: 'muted' }, 'No drawings to replay.');

    show(el('div', { class: 'card wide' },
      el('h2', {}, `🏆 ${sorted[0] ? sorted[0].name : 'Nobody'} wins!`),
      el('div', { class: 'two-col' }, board, replayCol),
      host
        ? el('button', { class: 'primary', onclick: () => send({ t: 'play_again' }) }, 'Play again')
        : el('p', { class: 'muted' }, 'Waiting for the host to start another game…')));
    if (S.replays.length) play(0);
  }

  // ------------------------------------------------------------ drawing input

  function pos(e) {
    const r = canvas.getBoundingClientRect();
    return [
      Math.max(0, Math.min(W, Math.round(((e.clientX - r.left) * W) / r.width))),
      Math.max(0, Math.min(H, Math.round(((e.clientY - r.top) * H) / r.height))),
    ];
  }

  // Points are buffered and flushed every ~33ms: smooth for viewers but only
  // ~30 small messages/s per drawer instead of one per mouse event.
  function flush() {
    while (S.pending.length) send({ t: 'stroke_pts', pts: S.pending.splice(0, 80), ts: Date.now() });
  }
  function endStroke() {
    if (!S.cur) return;
    flush();
    clearInterval(S.flushTimer);
    send({ t: 'stroke_end' });
    S.cur = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!canDraw() || e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = pos(e);
    if (S.tool === 'fill') {
      const op = { k: 'f', c: S.color, x: Math.min(x, W - 1), y: Math.min(y, H - 1) };
      S.ops.push(op);
      applyOp(ctx, op);
      return send({ t: 'fill', c: op.c, x: op.x, y: op.y });
    }
    const c = S.tool === 'eraser' ? '#ffffff' : S.color;
    S.cur = { k: 's', c, w: S.size, pts: [x, y] };
    S.ops.push(S.cur);
    dot(ctx, c, S.size, x, y);
    send({ t: 'stroke_begin', c, w: S.size, x, y });
    S.flushTimer = setInterval(flush, 33);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!S.cur) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events.length ? events : [e]) {
      const [x, y] = pos(ev);
      const n = S.cur.pts.length;
      if (Math.abs(x - S.cur.pts[n - 2]) + Math.abs(y - S.cur.pts[n - 1]) < 2) continue;
      seg(ctx, S.cur.c, S.cur.w, S.cur.pts[n - 2], S.cur.pts[n - 1], x, y);
      S.cur.pts.push(x, y);
      S.pending.push(x, y);
    }
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => canvas.addEventListener(ev, endStroke));

  function undo() {
    if (!canDraw()) return;
    endStroke();
    S.ops.pop();
    redraw();
    send({ t: 'undo' });
  }
  $('undo').onclick = undo;
  $('clear').onclick = () => {
    if (!canDraw()) return;
    endStroke();
    S.ops = [];
    redraw();
    send({ t: 'clear' });
  };
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && document.activeElement !== $('chatInput')) {
      e.preventDefault();
      undo();
    }
  });

  // tools
  const COLORS = ['#000000', '#6b7280', '#ffffff', '#ef4444', '#f97316', '#facc15', '#22c55e', '#14b8a6',
    '#3b82f6', '#6366f1', '#a855f7', '#ec4899', '#92400e', '#fda4af', '#bef264', '#7dd3fc'];
  COLORS.forEach((c, i) => {
    const b = el('button', { class: 'swatch' + (i === 0 ? ' active' : ''), title: c });
    b.style.background = c;
    b.onclick = () => {
      S.color = c;
      if (S.tool === 'eraser') setTool('pen');
      document.querySelectorAll('.swatch').forEach((s) => s.classList.toggle('active', s === b));
    };
    $('palette').append(b);
  });
  function setTool(t) {
    S.tool = t;
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  }
  document.querySelectorAll('.tool').forEach((b) => { b.onclick = () => setTool(b.dataset.tool); });
  document.querySelectorAll('.size').forEach((b) => {
    b.onclick = () => {
      S.size = Number(b.dataset.size);
      document.querySelectorAll('.size').forEach((x) => x.classList.toggle('active', x === b));
    };
  });

  // ------------------------------------------------------------ chat + home wiring

  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('chatInput').value.trim();
    if (v) send({ t: 'chat', text: v });
    $('chatInput').value = '';
  });
  $('copyLink').onclick = copyLink;
  $('leaveBtn').onclick = () => {
    if (!confirm('Leave this room? You will lose your seat and score.')) return;
    send({ t: 'leave' });
    goHome('');
  };

  document.querySelectorAll('.tabs button').forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
      $('createForm').classList.toggle('hidden', b.dataset.tab !== 'create');
      $('joinForm').classList.toggle('hidden', b.dataset.tab !== 'join');
      homeMsg('');
    };
  });
  const needName = () => {
    S.name = $('name').value.trim();
    if (!S.name) { homeMsg('Please enter your name first.'); $('name').focus(); return false; }
    try { localStorage.setItem('doodle.name', S.name); } catch { /* ignore */ }
    return true;
  };
  $('createForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!needName()) return;
    homeMsg('');
    connect(() => ({
      t: 'create', name: S.name,
      settings: { rounds: Number($('rounds').value), drawTime: Number($('drawTime').value), words: $('words').value },
    }));
  });
  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!needName()) return;
    const room = $('code').value.trim().toUpperCase();
    if (!room) return homeMsg('Enter a room code.');
    homeMsg('');
    connect(() => ({ t: 'join', room, name: S.name }));
  });

  setInterval(() => send({ t: 'ping', ts: Date.now() }), 2000);

  // ------------------------------------------------------------ boot

  whiten(ctx);
  try { $('name').value = localStorage.getItem('doodle.name') || ''; } catch { /* ignore */ }
  const urlRoom = (location.pathname.match(/^\/r\/([A-Za-z0-9]+)/) || [])[1]
    || new URLSearchParams(location.search).get('room');
  const saved = loadSession();

  if (urlRoom) {
    document.querySelector('[data-tab="join"]').click();
    $('code').value = urlRoom.toUpperCase();
    if (saved && saved.code === urlRoom.toUpperCase()) {
      // Refresh: slip back into the same seat using our token.
      S.name = saved.name;
      $('name').value = saved.name;
      S.code = saved.code;
      S.token = saved.token;
      connect(() => ({ t: 'join', room: saved.code, name: saved.name, token: saved.token }));
    }
  }
})();
