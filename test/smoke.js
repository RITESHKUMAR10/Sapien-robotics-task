'use strict';
// End-to-end checks of the server-authority rules. Spawns its own server.
const { spawn } = require('child_process');
const path = require('path');
const WebSocket = require('ws');

const PORT = 4100 + Math.floor(Math.random() * 500);
const URL = `ws://localhost:${PORT}/ws`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
};

class Bot {
  constructor(name) {
    this.name = name;
    this.raw = [];
    this.msgs = [];
    this.state = null;
  }
  open() {
    return new Promise((res) => {
      this.ws = new WebSocket(URL);
      this.ws.on('message', (d) => {
        const s = d.toString();
        this.raw.push(s);
        const m = JSON.parse(s);
        this.msgs.push(m);
        if (m.t === 'state') this.state = m;
        if (m.t === 'joined') { this.id = m.id; this.token = m.token; this.code = m.code; }
      });
      this.ws.on('open', res);
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  me() { return this.state.players.find((p) => p.id === this.id); }
  async waitFor(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (fn()) return true;
      await sleep(25);
    }
    return false;
  }
}

async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((r) => srv.stdout.once('data', r));

  try {
    const [a, b, c] = [new Bot('Ann'), new Bot('Bob'), new Bot('Cy')];
    await Promise.all([a.open(), b.open(), c.open()]);
    a.send({ t: 'create', name: 'Ann', settings: { rounds: 2, drawTime: 30, words: 'apple, banana, cherry, grape' } });
    await a.waitFor(() => a.code);
    b.send({ t: 'join', room: a.code, name: 'Bob' });
    c.send({ t: 'join', room: a.code, name: 'Cy' });
    await Promise.all([b.waitFor(() => b.id), c.waitFor(() => c.id)]);
    check(a.code && a.code.length === 5, 'room created with shareable code');

    b.send({ t: 'start' });
    await sleep(150);
    check(a.state.phase === 'lobby', 'only the host can start the game');
    a.send({ t: 'start' });
    await a.waitFor(() => a.state.phase === 'choosing');
    const bots = [a, b, c];
    const drawer = bots.find((x) => x.id === a.state.drawerId);
    const guessers = bots.filter((x) => x !== drawer);
    check(Array.isArray(drawer.state.choices) && drawer.state.choices.length === 3, 'drawer is offered 3 words');
    check(guessers.every((g) => g.state.choices === undefined), 'guessers are not sent the word choices');

    const word = drawer.state.choices[0];
    drawer.send({ t: 'choose_word', index: 0 });
    await guessers[0].waitFor(() => guessers[0].state.phase === 'drawing');
    check(drawer.state.word === word, 'drawer sees the word');
    check(guessers.every((g) => g.state.word === undefined && /_/.test(g.state.hint)), 'guessers only get a hint mask');

    // Stroke relay
    drawer.send({ t: 'stroke_begin', c: '#ff0000', w: 6, x: 10, y: 10 });
    drawer.send({ t: 'stroke_pts', pts: [12, 12, 14, 14] });
    drawer.send({ t: 'stroke_end' });
    await guessers[0].waitFor(() => guessers[0].msgs.some((m) => m.t === 'stroke_end'));
    const seqs = guessers[0].msgs.filter((m) => m.seq && m.t.startsWith('stroke')).map((m) => m.seq);
    check(seqs.length === 3 && seqs[1] === seqs[0] + 1 && seqs[2] === seqs[1] + 1, 'strokes relayed in order with sequence numbers');
    guessers[1].send({ t: 'stroke_begin', c: '#000000', w: 5, x: 1, y: 1 });
    await sleep(100);
    check(!drawer.msgs.some((m) => m.t === 'stroke_begin'), 'non-drawer strokes are ignored');

    // Guessing
    const [g1, g2] = guessers;
    g1.send({ t: 'chat', text: word.slice(0, -1) });
    await g1.waitFor(() => g1.msgs.some((m) => m.kind === 'close'));
    check(g1.msgs.some((m) => m.kind === 'close'), 'near-miss shows "close!" to the guesser');
    await sleep(100);
    check(!g2.msgs.some((m) => m.kind === 'close' || m.text === word.slice(0, -1)), 'near-miss is invisible to other players');

    g1.send({ t: 'chat', text: word.toUpperCase() });
    await g1.waitFor(() => g1.me().score > 0);
    const pts = g1.me().score;
    check(pts >= 100 && pts <= 500, `correct guess awards points (${pts})`);
    check(g1.state.word === word && g2.state.word === undefined, 'word revealed only to the player who guessed');
    check(!g2.raw.some((s) => s.toLowerCase().includes(word)), 'word never appears in any message sent to a non-guesser');

    g1.send({ t: 'chat', text: `the word is ${word}` });
    await sleep(150);
    check(!g2.msgs.some((m) => m.kind === 'chat' && m.text.includes(word)), 'a player who guessed cannot reveal the word in chat');

    // Reconnect keeps score
    g1.ws.close();
    await sleep(200);
    const g1b = new Bot('Bob2');
    await g1b.open();
    g1b.send({ t: 'join', room: a.code, token: g1.token });
    await g1b.waitFor(() => g1b.state);
    check(g1b.id === g1.id && g1b.me().score === pts, 'refresh/drop rejoin keeps identity and score');
    check(g1b.msgs.some((m) => m.t === 'sync'), 'rejoining player receives the canvas state');

    // Late joiner sees the canvas
    const d = new Bot('Dee');
    await d.open();
    d.send({ t: 'join', room: a.code, name: 'Dee' });
    await d.waitFor(() => d.msgs.some((m) => m.t === 'sync'));
    const sync = d.msgs.find((m) => m.t === 'sync');
    check(sync.ops.length === 1 && sync.ops[0].pts.length === 6, 'mid-round joiner receives the canvas as it stands');

    // Chat rate limit
    for (let i = 0; i < 40; i++) g2.send({ t: 'chat', text: `spam ${i}` });
    await sleep(300);
    const spamSeen = d.msgs.filter((m) => m.kind === 'chat' && /^spam/.test(m.text)).length;
    check(spamSeen > 0 && spamSeen <= 8, `chat is rate limited (${spamSeen}/40 delivered)`);

    // Stroke flood is rate limited (drawer is still drawing here)
    const before = g1b.msgs.filter((m) => m.t === 'stroke_pts').length;
    drawer.send({ t: 'stroke_begin', c: '#000000', w: 5, x: 5, y: 5 });
    for (let i = 0; i < 400; i++) drawer.send({ t: 'stroke_pts', pts: [i % 800, 10] });
    await sleep(400);
    const got = g1b.msgs.filter((m) => m.t === 'stroke_pts').length - before;
    check(got > 0 && got < 150, `stroke flood is rate limited (${got}/400 relayed)`);

    // Oversize frame closes the socket
    const closed = new Promise((r) => g2.ws.once('close', r));
    g2.ws.send('x'.repeat(40 * 1024));
    check(await Promise.race([closed.then(() => true), sleep(1500).then(() => false)]), 'oversized message closes the connection');

    // Drawer drops and never comes back -> game recovers
    drawer.ws.terminate();
    const recovered = await g1b.waitFor(() => g1b.state.phase === 'turn_end' || g1b.state.phase === 'choosing', 14000);
    check(recovered, 'game recovers when the drawer leaves mid-turn');
    const next = await g1b.waitFor(() => g1b.state.phase === 'choosing' && g1b.state.drawerId !== drawer.id, 9000);
    check(next, 'turn passes to the next player');
  } finally {
    srv.kill();
  }
  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
