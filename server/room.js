'use strict';

const C = require('./config');
const {
  TokenBucket, normalize, isClose, cleanText, toInt, shuffle, randomId, randomToken,
} = require('./util');

const HINT_FRACTIONS = [0.35, 0.55, 0.75];
const COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * One game room. The server owns all game state: the word, the clock, guess
 * checking, scoring and the canvas op-log. Clients only ever send intents.
 */
class Room {
  constructor(code, settings, onEmpty) {
    this.code = code;
    this.settings = settings;
    this.onEmpty = onEmpty;
    this.players = new Map(); // id -> player
    this.hostId = null;
    this.seq = 0; // monotonically increasing canvas-op sequence number
    this.timers = { turn: null, hints: [], drawer: null };
    this.resetGame();
  }

  resetGame() {
    this.clearTurnTimers();
    this.phase = 'lobby'; // lobby | choosing | drawing | turn_end | waiting | game_over
    this.round = 0;
    this.queue = [];
    this.drawerId = null;
    this.word = null;
    this.choices = null;
    this.hintArr = null;
    this.hint = '';
    this.endsAt = 0;
    this.turnMs = 0;
    this.ops = [];
    this.cur = null;
    this.totalPts = 0;
    this.drawings = [];
    this.usedWords = new Set();
    this.turnResult = null;
    this.gains = new Map();
    this.expectedGuessers = 1;
    for (const p of this.players.values()) {
      p.score = 0;
      p.guessed = false;
    }
  }

  // ---------------------------------------------------------------- players

  connectedPlayers() {
    return [...this.players.values()].filter((p) => p.connected);
  }

  findByToken(token) {
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  addPlayer(name, ws) {
    if (this.players.size >= C.MAX_PLAYERS) throw new Error('room_full');
    const p = {
      id: randomId(),
      token: randomToken(),
      name,
      score: 0,
      ws,
      connected: true,
      guessed: false,
      graceTimer: null,
      buckets: {
        chat: new TokenBucket(C.RATE.chat),
        stroke: new TokenBucket(C.RATE.stroke),
        action: new TokenBucket(C.RATE.action),
      },
    };
    this.players.set(p.id, p);
    if (!this.hostId) { this.hostId = p.id; this.ownerId = p.id; } // creator keeps host rights across refreshes
    // Joined mid-game: they get a drawing turn this round.
    if (this.round > 0 && this.phase !== 'game_over') this.queue.push(p.id);
    return p;
  }

  reconnect(p, ws) {
    clearTimeout(p.graceTimer);
    p.graceTimer = null;
    if (p.ws && p.ws !== ws) {
      try { p.ws.close(4000, 'replaced'); } catch { /* already closing */ }
    }
    p.ws = ws;
    p.connected = true;
    if (p.id === this.ownerId) this.hostId = p.id;
    if (p.id === this.drawerId && this.timers.drawer) {
      clearTimeout(this.timers.drawer);
      this.timers.drawer = null;
    }
  }

  // Called after the "joined" message so the client always sees joined -> state -> sync.
  afterJoin(p, isReconnect) {
    if (!isReconnect) this.system(`${p.name} joined`);
    this.broadcastState();
    this.sendSync(p);
    if (this.phase === 'game_over') this.sendReplays(p);
    if (this.phase === 'waiting') this.maybeResume();
  }

  onDisconnect(p, ws) {
    if (p.ws !== ws) return; // a newer connection already replaced this one
    p.ws = null;
    p.connected = false;
    if (this.hostId === p.id) {
      const next = this.connectedPlayers()[0];
      if (next) this.hostId = next.id;
    }
    p.graceTimer = setTimeout(() => this.removePlayer(p), C.RECONNECT_GRACE_MS);
    if (p.id === this.drawerId && (this.phase === 'choosing' || this.phase === 'drawing')) {
      this.timers.drawer = setTimeout(() => this.drawerGone(), C.DRAWER_GRACE_MS);
    }
    this.broadcastState();
    this.checkAllGuessed();
  }

  removePlayer(p) {
    if (!this.players.has(p.id)) return;
    clearTimeout(p.graceTimer);
    this.players.delete(p.id);
    this.queue = this.queue.filter((id) => id !== p.id);
    if (this.hostId === p.id) {
      this.hostId = (this.connectedPlayers()[0] || [...this.players.values()][0] || {}).id || null;
    }
    if (this.players.size === 0) return this.destroy();
    this.system(`${p.name} left`);
    if (p.id === this.drawerId && (this.phase === 'choosing' || this.phase === 'drawing')) {
      this.drawerGone(); // broadcasts state itself
    } else {
      this.broadcastState();
      this.checkAllGuessed();
    }
  }

  destroy() {
    this.clearTurnTimers();
    clearTimeout(this.waitTimer);
    for (const p of this.players.values()) clearTimeout(p.graceTimer);
    this.onEmpty();
  }

  // ---------------------------------------------------------------- sending

  raw(p, str) {
    const ws = p.ws;
    if (!ws || ws.readyState !== 1) return;
    if (ws.bufferedAmount > C.BUFFER_LIMIT) return ws.terminate(); // too slow; it will resync on reconnect
    ws.send(str);
  }

  send(p, obj) {
    this.raw(p, JSON.stringify(obj));
  }

  broadcast(obj, except = null) {
    const str = JSON.stringify(obj);
    for (const p of this.players.values()) if (p !== except) this.raw(p, str);
  }

  system(text) {
    this.broadcast({ t: 'chat', kind: 'system', text });
  }

  // What a given player is allowed to know. The word is only ever included
  // for the drawer, for players who already guessed it, or once the turn is over.
  viewFor(p) {
    const revealed = this.word && (
      this.phase === 'turn_end' || p.id === this.drawerId || p.guessed
    );
    return {
      t: 'state',
      code: this.code,
      you: p.id,
      phase: this.phase,
      settings: { rounds: this.settings.rounds, drawTime: this.settings.drawTime, words: this.settings.words.length },
      round: this.round,
      hostId: this.hostId,
      drawerId: this.drawerId,
      endsAt: this.endsAt,
      serverNow: Date.now(),
      hint: this.phase === 'drawing' ? this.hint : '',
      word: revealed ? this.word : undefined,
      choices: this.phase === 'choosing' && p.id === this.drawerId ? this.choices : undefined,
      turnResult: this.phase === 'turn_end' ? this.turnResult : undefined,
      players: [...this.players.values()].map((q) => ({
        id: q.id, name: q.name, score: q.score, connected: q.connected,
        guessed: q.guessed && (this.phase === 'drawing' || this.phase === 'turn_end'),
      })),
    };
  }

  broadcastState() {
    for (const p of this.players.values()) this.send(p, this.viewFor(p));
  }

  sendSync(p) {
    this.send(p, { t: 'sync', seq: this.seq, ops: this.ops });
  }

  sendReplays(p) {
    this.send(p, { t: 'replays', drawings: this.drawings });
  }

  // ---------------------------------------------------------------- messages

  handle(p, msg) {
    switch (msg.t) {
      case 'chat':
        if (!p.buckets.chat.take()) return this.send(p, { t: 'error', code: 'rate', message: 'Slow down!' });
        return this.onChat(p, msg.text);
      case 'start':
        return this.start(p);
      case 'play_again':
        if (p.id === this.hostId && this.phase === 'game_over') {
          this.resetGame();
          this.broadcast({ t: 'sync', seq: ++this.seq, ops: [] });
          this.broadcastState();
        }
        return;
      case 'choose_word':
        if (this.phase === 'choosing' && p.id === this.drawerId) {
          const i = toInt(msg.index, 0, this.choices.length - 1);
          if (i !== null) this.chooseWord(i);
        }
        return;
      case 'stroke_begin': case 'stroke_pts': case 'stroke_end': case 'fill':
        if (!p.buckets.stroke.take()) return;
        return this.onDraw(p, msg);
      case 'undo': case 'clear':
        if (!p.buckets.action.take()) return;
        return this.onDraw(p, msg);
      case 'resync':
        if (p.buckets.action.take()) this.sendSync(p);
        return;
      default:
    }
  }

  onChat(p, raw) {
    const text = cleanText(raw, C.MAX_CHAT_LEN);
    if (!text) return;
    const base = { t: 'chat', kind: 'chat', from: p.id, name: p.name, text };

    if (this.phase === 'drawing') {
      const isDrawer = p.id === this.drawerId;
      if (isDrawer || p.guessed) {
        // Only people who already know the word can see this chat, so it can't leak it.
        const msg = { ...base, private: true };
        for (const q of this.players.values()) if (q.guessed || q.id === this.drawerId) this.send(q, msg);
        return;
      }
      const guess = normalize(text);
      const word = normalize(this.word);
      if (guess === word) return this.award(p);
      if (isClose(guess, word)) {
        // The near-miss text is shown only to the person who typed it.
        this.send(p, base);
        return this.send(p, { t: 'chat', kind: 'close', text: 'Close!' });
      }
    }
    this.broadcast(base);
  }

  onDraw(p, m) {
    if (this.phase !== 'drawing' || p.id !== this.drawerId) return;
    const err = (message) => this.send(p, { t: 'error', code: 'draw_limit', message });

    switch (m.t) {
      case 'stroke_begin': {
        const c = typeof m.c === 'string' && COLOR_RE.test(m.c) ? m.c.toLowerCase() : null;
        const w = toInt(m.w, 1, C.MAX_BRUSH);
        const x = toInt(m.x, 0, C.CANVAS_W);
        const y = toInt(m.y, 0, C.CANVAS_H);
        if (!c || w === null || x === null || y === null) return;
        if (this.ops.length >= C.MAX_OPS_PER_TURN || this.totalPts >= C.MAX_PTS_PER_TURN) return err('Drawing limit reached for this turn.');
        this.cur = { k: 's', c, w, pts: [x, y] };
        this.ops.push(this.cur);
        this.totalPts++;
        return this.broadcast({ t: 'stroke_begin', seq: ++this.seq, c, w, x, y }, p);
      }
      case 'stroke_pts': {
        if (!this.cur || !Array.isArray(m.pts)) return;
        const n = Math.min(m.pts.length >> 1, C.MAX_PTS_PER_MSG);
        if (this.totalPts + n > C.MAX_PTS_PER_TURN) return err('Drawing limit reached for this turn.');
        const pts = [];
        for (let i = 0; i < n; i++) {
          const x = toInt(m.pts[2 * i], 0, C.CANVAS_W);
          const y = toInt(m.pts[2 * i + 1], 0, C.CANVAS_H);
          if (x === null || y === null) return;
          pts.push(x, y);
        }
        if (!pts.length) return;
        this.cur.pts.push(...pts);
        this.totalPts += n;
        const out = { t: 'stroke_pts', seq: ++this.seq, pts };
        if (typeof m.ts === 'number') out.ts = m.ts; // lets load tests measure fan-out latency
        return this.broadcast(out, p);
      }
      case 'stroke_end':
        this.cur = null;
        return this.broadcast({ t: 'stroke_end', seq: ++this.seq }, p);
      case 'fill': {
        const c = typeof m.c === 'string' && COLOR_RE.test(m.c) ? m.c.toLowerCase() : null;
        const x = toInt(m.x, 0, C.CANVAS_W - 1);
        const y = toInt(m.y, 0, C.CANVAS_H - 1);
        if (!c || x === null || y === null) return;
        if (this.ops.length >= C.MAX_OPS_PER_TURN) return err('Drawing limit reached for this turn.');
        this.cur = null;
        this.ops.push({ k: 'f', c, x, y });
        return this.broadcast({ t: 'fill', seq: ++this.seq, c, x, y }, p);
      }
      case 'undo':
        this.cur = null;
        this.ops.pop();
        return this.broadcast({ t: 'undo', seq: ++this.seq }, p);
      case 'clear':
        this.cur = null;
        this.ops = [];
        return this.broadcast({ t: 'clear', seq: ++this.seq }, p);
      default:
    }
  }

  // ---------------------------------------------------------------- game flow

  start(p) {
    if (p.id !== this.hostId || this.phase !== 'lobby') return;
    if (this.connectedPlayers().length < 2) {
      return this.send(p, { t: 'error', code: 'need_players', message: 'Need at least 2 players to start.' });
    }
    this.round = 0;
    this.queue = [];
    this.nextTurn();
  }

  clearTurnTimers() {
    clearTimeout(this.timers.turn);
    clearTimeout(this.timers.drawer);
    this.timers.hints.forEach(clearTimeout);
    this.timers = { turn: null, hints: [], drawer: null };
  }

  pickChoices(n = 3) {
    let pool = this.settings.words.filter((w) => !this.usedWords.has(w));
    if (pool.length < n) {
      this.usedWords.clear();
      pool = this.settings.words.slice();
    }
    return shuffle(pool).slice(0, n);
  }

  nextTurn() {
    this.clearTurnTimers();
    clearTimeout(this.waitTimer);

    if (this.connectedPlayers().length < 2) {
      this.phase = 'waiting';
      this.drawerId = null;
      this.word = null;
      this.endsAt = Date.now() + C.WAIT_MS;
      this.broadcastState();
      this.waitTimer = setTimeout(() => this.endGame(), C.WAIT_MS);
      return;
    }

    let drawer = null;
    while (!drawer) {
      if (!this.queue.length) {
        this.round++;
        if (this.round > this.settings.rounds) return this.endGame();
        this.queue = [...this.players.keys()];
      }
      const p = this.players.get(this.queue.shift());
      if (p && p.connected) drawer = p;
    }

    this.phase = 'choosing';
    this.drawerId = drawer.id;
    this.word = null;
    this.hint = '';
    this.choices = this.pickChoices(3);
    this.ops = [];
    this.cur = null;
    this.totalPts = 0;
    this.gains = new Map();
    this.turnResult = null;
    for (const p of this.players.values()) p.guessed = false;
    this.endsAt = Date.now() + C.CHOOSE_MS;

    this.broadcastState();
    this.broadcast({ t: 'sync', seq: ++this.seq, ops: [] });
    this.timers.turn = setTimeout(() => this.chooseWord(Math.floor(Math.random() * this.choices.length)), C.CHOOSE_MS);
  }

  chooseWord(index) {
    clearTimeout(this.timers.turn);
    this.word = this.choices[index];
    this.usedWords.add(this.word);
    this.choices = null;

    this.phase = 'drawing';
    this.turnMs = this.settings.drawTime * 1000;
    this.endsAt = Date.now() + this.turnMs;
    this.hintArr = [...this.word].map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? '_' : ch));
    this.hint = this.hintArr.join('');
    this.expectedGuessers = Math.max(1, this.connectedPlayers().length - 1);

    const hidden = this.hintArr.filter((ch) => ch === '_').length;
    const reveals = Math.min(HINT_FRACTIONS.length, Math.floor(hidden / 2));
    for (let i = 0; i < reveals; i++) {
      this.timers.hints.push(setTimeout(() => this.revealLetter(), this.turnMs * HINT_FRACTIONS[i]));
    }
    this.timers.turn = setTimeout(() => this.endTurn('time'), this.turnMs);
    this.broadcastState();
  }

  revealLetter() {
    if (this.phase !== 'drawing') return;
    const chars = [...this.word];
    const hiddenIdx = this.hintArr.map((ch, i) => (ch === '_' ? i : -1)).filter((i) => i >= 0);
    if (hiddenIdx.length <= 1) return;
    const i = hiddenIdx[Math.floor(Math.random() * hiddenIdx.length)];
    this.hintArr[i] = chars[i];
    this.hint = this.hintArr.join('');
    for (const p of this.players.values()) {
      if (p.id !== this.drawerId && !p.guessed) this.send(p, { t: 'hint', hint: this.hint });
    }
  }

  award(p) {
    const left = Math.max(0, this.endsAt - Date.now());
    const pts = 100 + Math.round((400 * left) / this.turnMs); // 100..500, faster = more
    p.score += pts;
    p.guessed = true;
    this.addGain(p, pts);

    const drawer = this.players.get(this.drawerId);
    if (drawer) {
      const bonus = Math.round(pts / this.expectedGuessers);
      drawer.score += bonus;
      this.addGain(drawer, bonus);
    }
    this.system(`${p.name} guessed the word!`);
    this.broadcastState();
    this.checkAllGuessed();
  }

  addGain(p, pts) {
    const g = this.gains.get(p.id) || { name: p.name, gain: 0 };
    g.gain += pts;
    this.gains.set(p.id, g);
  }

  checkAllGuessed() {
    if (this.phase !== 'drawing') return;
    const eligible = this.connectedPlayers().filter((p) => p.id !== this.drawerId);
    if (eligible.length > 0 && eligible.every((p) => p.guessed)) this.endTurn('all_guessed');
  }

  // The drawer vanished (left, or stayed disconnected past the grace period).
  drawerGone() {
    this.timers.drawer = null;
    if (this.phase === 'choosing' || this.phase === 'drawing') this.endTurn('drawer_left');
  }

  endTurn(reason) {
    if (this.phase !== 'choosing' && this.phase !== 'drawing') return;
    this.clearTurnTimers();
    const drawer = this.players.get(this.drawerId);
    if (this.word && this.ops.length) {
      this.drawings.push({
        round: this.round,
        drawer: drawer ? drawer.name : 'Someone',
        word: this.word,
        ops: this.ops,
      });
    }
    this.turnResult = {
      word: this.word,
      reason,
      gains: [...this.gains.values()].sort((a, b) => b.gain - a.gain),
    };
    this.cur = null;
    this.phase = 'turn_end';
    this.endsAt = Date.now() + C.TURN_END_MS;
    this.broadcastState();
    this.timers.turn = setTimeout(() => this.nextTurn(), C.TURN_END_MS);
  }

  maybeResume() {
    if (this.phase === 'waiting' && this.connectedPlayers().length >= 2) this.nextTurn();
  }

  endGame() {
    this.clearTurnTimers();
    clearTimeout(this.waitTimer);
    this.phase = 'game_over';
    this.drawerId = null;
    this.word = null;
    this.hint = '';
    this.endsAt = 0;
    this.broadcastState();
    for (const p of this.players.values()) this.sendReplays(p);
  }
}

module.exports = { Room };
