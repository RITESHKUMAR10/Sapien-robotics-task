'use strict';
/**
 * Capacity probe. Ramps up rooms of 4 players (1 drawer streaming ~30 stroke
 * messages/s, 3 guessers chatting) and, at every step, reports:
 *   - stroke fan-out latency (drawer send -> guesser receive), p50/p95/p99
 *   - server event-loop lag and CPU (from the server's /stats endpoint)
 * It stops when latency or lag crosses a threshold.
 *
 *   node loadtest/load.js [--host localhost:3000] [--step 50] [--max 1000] [--hold 10]
 *
 * Run the server (npm start) in another terminal first. Generator and server
 * share the machine, so results are a conservative lower bound.
 */
const WebSocket = require('ws');

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const HOST = arg('host', 'localhost:3000');
const STEP = Number(arg('step', 50));
const MAX = Number(arg('max', 1000));
const HOLD = Number(arg('hold', 10));
const PER_ROOM = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let latencies = [];
let received = 0;
let connectErrors = 0;

class Bot {
  constructor(isHost) {
    this.isHost = isHost;
    this.drawing = false;
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://${HOST}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', (e) => { connectErrors++; reject(e); });
      this.ws.on('message', (d) => this.onMessage(JSON.parse(d)));
    });
  }
  send(o) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(o)); }
  onMessage(m) {
    received++;
    if (m.t === 'joined') { this.id = m.id; this.code = m.code; this.joined?.(); }
    else if (m.t === 'stroke_pts' && m.ts) latencies.push(Date.now() - m.ts);
    else if (m.t === 'state') {
      if (m.phase === 'choosing' && m.drawerId === this.id && m.choices) this.send({ t: 'choose_word', index: 0 });
      if (m.phase === 'drawing') {
        if (m.drawerId === this.id) this.startDrawing();
        else this.startGuessing();
      }
    }
  }
  waitJoined() { return new Promise((r) => { this.joined = r; }); }
  startDrawing() {
    if (this.drawing) return;
    this.drawing = true;
    let x = 400, y = 300, n = 0;
    this.send({ t: 'stroke_begin', c: '#000000', w: 6, x, y });
    this.timer = setInterval(() => {
      const pts = [];
      for (let i = 0; i < 4; i++) {
        x = Math.max(0, Math.min(800, x + (Math.random() - 0.5) * 30));
        y = Math.max(0, Math.min(600, y + (Math.random() - 0.5) * 30));
        pts.push(Math.round(x), Math.round(y));
      }
      this.send({ t: 'stroke_pts', pts, ts: Date.now() });
      if (++n % 60 === 0) {
        this.send({ t: 'stroke_end' });
        this.send({ t: 'stroke_begin', c: '#ff0000', w: 6, x: Math.round(x), y: Math.round(y) });
      }
    }, 33);
  }
  startGuessing() {
    if (this.guessing) return;
    this.guessing = true;
    this.timer = setInterval(() => this.send({ t: 'chat', text: `guess ${Math.random().toString(36).slice(2, 7)}` }), 2500);
  }
  close() { clearInterval(this.timer); this.ws.close(); }
}

const bots = [];
async function spawnRoom() {
  const host = new Bot(true);
  await host.open();
  const hostJoined = host.waitJoined();
  host.send({ t: 'create', name: 'host', settings: { rounds: 1, drawTime: 180 } });
  await hostJoined;
  bots.push(host);
  for (let i = 1; i < PER_ROOM; i++) {
    const b = new Bot(false);
    await b.open();
    const j = b.waitJoined();
    b.send({ t: 'join', room: host.code, name: `p${i}` });
    await j;
    bots.push(b);
  }
  host.send({ t: 'start' });
}

const pct = (arr, p) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor((arr.length * p) / 100))] : NaN);
const getStats = () => fetch(`http://${HOST}/stats`).then((r) => r.json());

(async () => {
  console.log(`Ramping by ${STEP} rooms (${PER_ROOM} players each), holding ${HOLD}s per step\n`);
  console.log('rooms  players  srv-msg/s   p50    p95    p99 (ms)   loop-lag p99   cpu%   rssMB');
  let rooms = 0;
  while (rooms < MAX) {
    const batch = [];
    for (let i = 0; i < STEP; i++) {
      batch.push(spawnRoom().catch(() => {}));
      if (i % 10 === 9) await Promise.all(batch.splice(0)); // gentle ramp
    }
    await Promise.all(batch);
    rooms += STEP;
    await sleep(2000); // let games start
    await getStats(); // resets the server's lag/CPU window
    latencies = [];
    received = 0;
    await sleep(HOLD * 1000);
    const s = await getStats();
    const sorted = latencies.sort((a, b) => a - b);
    const rate = Math.round(received / HOLD);
    console.log(
      `${String(s.rooms).padStart(5)}  ${String(s.connected).padStart(7)}  ${String(rate).padStart(9)}  `
      + `${String(pct(sorted, 50)).padStart(4)}  ${String(pct(sorted, 95)).padStart(5)}  ${String(pct(sorted, 99)).padStart(5)}      `
      + `${String(s.loopLagP99Ms).padStart(9)}      ${String(s.cpuPct).padStart(5)}  ${String(s.rssMB).padStart(6)}`,
    );
    if (pct(sorted, 99) > 250 || s.loopLagP99Ms > 100 || connectErrors > 20) {
      console.log('\nThreshold crossed (p99 latency > 250ms or loop lag p99 > 100ms): stopping.');
      break;
    }
  }
  bots.forEach((b) => b.close());
  await sleep(300);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
