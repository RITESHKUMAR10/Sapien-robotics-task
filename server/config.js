'use strict';

module.exports = {
  PORT: Number(process.env.PORT) || 3000,

  // Capacity
  MAX_PLAYERS: 12,
  MAX_ROOMS: 5000,

  // Timing
  RECONNECT_GRACE_MS: 30000, // a dropped player keeps their seat + score this long
  DRAWER_GRACE_MS: 8000,     // a dropped drawer gets this long before the turn is abandoned
  CHOOSE_MS: 15000,
  TURN_END_MS: 5000,
  WAIT_MS: 60000,            // waiting for players to come back before giving up

  // Canvas (logical coordinates; clients scale it for display)
  CANVAS_W: 800,
  CANVAS_H: 600,

  // Abuse limits
  MAX_MSG_BYTES: 16 * 1024,  // ws frame limit; bigger frames close the connection
  MAX_CHAT_LEN: 100,
  MAX_NAME_LEN: 20,
  MAX_WORDS: 500,
  MAX_WORD_LEN: 30,
  MAX_PTS_PER_MSG: 40,       // points in a single stroke_pts message
  MAX_PTS_PER_TURN: 20000,   // total points a drawer may add in one turn
  MAX_OPS_PER_TURN: 300,     // strokes + fills per turn
  MAX_BRUSH: 40,
  BUFFER_LIMIT: 2 * 1024 * 1024, // drop clients that cannot keep up

  // Token buckets: capacity, refill per second
  RATE: {
    global: [120, 80],
    chat: [4, 0.8],
    stroke: [60, 45],
    action: [10, 5],
  },

  // Settings bounds
  ROUNDS: [1, 10, 3],
  DRAW_TIME: [20, 180, 80],
};
