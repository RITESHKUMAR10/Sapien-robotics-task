# Design note — Doodle Duel

## 1. How the canvas is synced and how strokes are sent

The server keeps, per room, an **op-log**: an ordered list of `stroke` (`colour`, `size`, `[x0,y0,x1,y1,…]`) and `fill` (`colour`, `x`, `y`) operations in a fixed 800×600 logical coordinate space (clients scale to any display size). The log *is* the canvas; nothing is stored as pixels on the server.

- **Live drawing:** the drawer renders locally first (zero perceived lag), buffers points and flushes them every ~33 ms as `stroke_pts` messages (≤40 points each, integers only). The server validates them, appends to the log and relays to everyone else. That's ~30 small messages/s per drawer rather than one per mouse event. Each relayed message carries a server sequence number.
- **Eraser** is just a white stroke; **fill** is a tiny `{x,y,colour}` op that every client replays with the same scanline flood-fill on the same op order, so no bitmaps ever cross the wire. **Undo** pops the last op and **clear** empties the log; both are broadcast.
- **Late joiners / reconnects** receive `sync {seq, ops}`, the whole log, and redraw it. The same message is the recovery path for any inconsistency, and the replay at the end of the game is just the saved log of each turn played back stroke by stroke.

## 2. Latency and ordering

- One WebSocket per player (TCP) ⇒ messages from a given sender are delivered in order. The server is the single serialiser per room (single-threaded event loop), so all viewers see the same total order, stamped with `seq`.
- Clients check `seq === last + 1`. A gap (e.g. the server dropped a slow client) triggers a `resync` instead of guessing, so canvases can't silently diverge. Verified in a 3-browser run: all three canvases were pixel-identical.
- The drawer doesn't wait for an echo; the server doesn't echo strokes back to the drawer.
- Timekeeping is server-side only. State messages carry `endsAt` and `serverNow`; clients compute a clock offset and just *display* the countdown. Points use the server's remaining time, so latency and clock skew can't be gamed.
- Latency levers: `perMessageDeflate` off, points batched at ~33 ms, integer coordinates. Measured stroke fan-out (drawer → viewer) at moderate load is p50 ≈ 4 ms / p99 ≈ 14 ms on localhost; on the internet add normal network RTT/2.

## 3. What happens when the server restarts

Everything is **in memory**, so a restart (or crash) ends all running games. This was a deliberate trade-off for a single-instance game of this size; the behaviour is graceful rather than stuck:

- On `SIGINT/SIGTERM` the server tells clients (`server_restart`) and closes sockets cleanly.
- Clients auto-reconnect with backoff and try to rejoin with their token. The new process has no such room, so they get `room_not_found`, return to the home screen and see "Room not found. It may have ended or the server restarted."
- If we needed to survive restarts, the op-log + scores + settings are small and serialisable; I'd snapshot them to Redis on each phase change (not per stroke) and restore rooms lazily on first join, accepting that the in-flight stroke/turn is lost. Not built because it's out of scope for the brief.

Related failure modes that *are* handled: a player dropping for ≤30 s keeps seat+score; a drawer dropping for >8 s ends the turn; a dead TCP connection is detected by a 15 s ping/pong heartbeat; a slow client is disconnected when its send buffer exceeds 2 MB and then resyncs on reconnect.

## 4. How many rooms one instance handles, and how I measured it

Measured with `npm run loadtest` (`loadtest/load.js`): rooms of 4 players, the drawer streaming ~30 `stroke_pts` messages/s continuously (worse than real play, where people pause, pick words and wait between turns), guessers sending chat every 2.5 s. It ramps 50 rooms at a time, holds 8 s, and records drawer→guesser fan-out latency plus the server's event-loop lag and CPU (`GET /stats`).

Result (Node 22, Windows 11 laptop; load generator and server on the *same* machine, so this is a conservative figure):

| Rooms | Players | Server out msgs/s | p50 / p95 / p99 latency (ms) | Loop lag p99 (ms) | CPU (1 core) |
|---|---|---|---|---|---|
| 50 | 200 | 3.9 k | 4 / 9 / 14 | 24 | 32 % |
| 100 | 400 | 7.9 k | 8 / 14 / 27 | 26 | 49 % |
| 200 | 800 | 17.5 k | 12 / 27 / 40 | 29 | 79 % |
| 250 | 1000 | 24.2 k | 18 / 44 / 55 | 32 | 97 % |
| 300 | 1200 | 29.2 k | 36 / 82 / 106 | 45 | 97 % |
| 400 | 1600 | 39.3 k | 182 / 418 / 463 | 143 | 97 % |

**Conclusion:** one Node process (one core) saturates at about **250–300 rooms with every drawer scribbling non-stop** (~1,000–1,200 connected players, ~25–30 k messages/s). Latency stays under ~60 ms p99 up to ~250 rooms and falls off a cliff past ~300 once the core is pinned. Because real drawers are idle much of the time, I'd expect roughly 2× that in practice, but I'd plan on **~200 busy rooms per instance** for headroom. Memory is small (~140 MB RSS at 400 rooms), so CPU on the broadcast path is the limit. To scale beyond that: run one process per core and shard by room code (rooms never interact), using sticky routing by code at the load balancer.
