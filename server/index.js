'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { monitorEventLoopDelay } = require('perf_hooks');

const C = require('./config');
const DEFAULT_WORDS = require('./words');
const { Room } = require('./room');
const { TokenBucket, cleanText, parseSettings } = require('./util');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  for (;;) {
    let code = '';
    for (let i = 0; i < 5; i++) code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    if (!rooms.has(code)) return code;
  }
}

// ------------------------------------------------------------------ HTTP

const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
let lastCpu = process.cpuUsage();
let lastCpuAt = Date.now();

function stats() {
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  const cpuPct = ((cpu.user + cpu.system) / 1000 / Math.max(1, now - lastCpuAt)) * 100;
  lastCpu = process.cpuUsage();
  lastCpuAt = now;
  let players = 0;
  let connected = 0;
  for (const r of rooms.values()) {
    players += r.players.size;
    connected += r.connectedPlayers().length;
  }
  const out = {
    rooms: rooms.size,
    players,
    connected,
    cpuPct: +cpuPct.toFixed(1),
    loopLagP50Ms: +(loop.percentile(50) / 1e6).toFixed(2),
    loopLagP99Ms: +(loop.percentile(99) / 1e6).toFixed(2),
    loopLagMaxMs: +(loop.max / 1e6).toFixed(2),
    rssMB: +(process.memoryUsage().rss / 1048576).toFixed(1),
  };
  loop.reset();
  return out;
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400);
    return res.end();
  }
  if (pathname === '/stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(stats()));
  }
  if (pathname === '/' || pathname.startsWith('/r/')) pathname = '/index.html';
  const file = path.normalize(path.join(PUBLIC, pathname));
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
});

// ------------------------------------------------------------------ WebSocket

const wss = new WebSocketServer({
  server,
  path: '/ws',
  maxPayload: C.MAX_MSG_BYTES, // oversized frames close the connection
  perMessageDeflate: false,    // trade bandwidth for lower latency/CPU on tiny messages
});

function reply(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function handleLobbyMessage(conn, msg) {
  const { ws } = conn;
  if (msg.t === 'ping') return reply(ws, { t: 'pong', ts: msg.ts });
  if (conn.player) return false;

  if (msg.t === 'create') {
    if (rooms.size >= C.MAX_ROOMS) return reply(ws, { t: 'error', code: 'busy', message: 'Server is full, try later.' });
    const parsed = parseSettings(msg.settings, DEFAULT_WORDS);
    if (parsed.error) return reply(ws, { t: 'error', code: 'bad_settings', message: parsed.error });
    const code = newCode();
    const room = new Room(code, parsed.settings, () => rooms.delete(code));
    rooms.set(code, room);
    const p = room.addPlayer(cleanText(msg.name, C.MAX_NAME_LEN) || 'Player', ws);
    attach(conn, room, p, false);
    return;
  }

  if (msg.t === 'join') {
    const room = rooms.get(String(msg.room || '').toUpperCase().slice(0, 8));
    if (!room) {
      return reply(ws, {
        t: 'error', code: 'room_not_found',
        message: 'Room not found. It may have ended or the server restarted.',
      });
    }
    let p = typeof msg.token === 'string' ? room.findByToken(msg.token) : null;
    const isReconnect = !!p;
    try {
      if (p) room.reconnect(p, ws);
      else p = room.addPlayer(cleanText(msg.name, C.MAX_NAME_LEN) || 'Player', ws);
    } catch (e) {
      return reply(ws, { t: 'error', code: e.message, message: 'This room is full.' });
    }
    attach(conn, room, p, isReconnect);
  }
}

function attach(conn, room, p, isReconnect) {
  conn.room = room;
  conn.player = p;
  reply(conn.ws, { t: 'joined', code: room.code, id: p.id, token: p.token });
  room.afterJoin(p, isReconnect);
}

wss.on('connection', (ws) => {
  const conn = { ws, room: null, player: null, bucket: new TokenBucket(C.RATE.global), strikes: 0 };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (data, isBinary) => {
    if (isBinary) return ws.close(1003, 'text only');
    if (!conn.bucket.take()) {
      if (++conn.strikes > 200) ws.close(1008, 'rate limit');
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    if (!conn.player) return handleLobbyMessage(conn, msg);
    if (msg.t === 'ping') return reply(ws, { t: 'pong', ts: msg.ts });
    if (msg.t === 'leave') {
      const { room, player } = conn;
      conn.player = null;
      conn.room = null;
      room.removePlayer(player);
      return reply(ws, { t: 'left' });
    }
    if (conn.player.ws !== ws) return; // superseded by a newer connection
    conn.room.handle(conn.player, msg);
  });

  ws.on('close', () => {
    if (conn.player) conn.room.onDisconnect(conn.player, ws);
  });
  ws.on('error', () => {});
});

// Detect half-open sockets quickly so a dropped player starts their grace timer.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

function shutdown() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) {
    reply(ws, { t: 'server_restart' });
    ws.close(1012, 'restarting');
  }
  server.close();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(C.PORT, () => {
  console.log(`Doodle Duel listening on http://localhost:${C.PORT}`);
});
