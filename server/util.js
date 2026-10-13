'use strict';

const crypto = require('crypto');
const C = require('./config');

class TokenBucket {
  constructor([capacity, perSec]) {
    this.cap = capacity;
    this.rate = perSec;
    this.tokens = capacity;
    this.last = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.cap, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}

const normalize = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').trim();

// A near-miss: one edit away (two for long words). Exact matches are handled before this.
function isClose(guess, word) {
  if (guess.length < 3 || Math.abs(guess.length - word.length) > 2) return false;
  const d = levenshtein(guess, word);
  return d === 1 || (word.length >= 8 && d === 2);
}

function cleanText(s, max) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function toInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const randomId = () => crypto.randomBytes(4).toString('hex');
const randomToken = () => crypto.randomBytes(16).toString('hex');

// Validates host-supplied settings. Returns { settings } or { error }.
function parseSettings(raw, defaultWords) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const rounds = toInt(raw.rounds, C.ROUNDS[0], C.ROUNDS[1]) ?? C.ROUNDS[2];
  const drawTime = toInt(raw.drawTime, C.DRAW_TIME[0], C.DRAW_TIME[1]) ?? C.DRAW_TIME[2];

  let words = defaultWords;
  const list = Array.isArray(raw.words) ? raw.words.join('\n') : typeof raw.words === 'string' ? raw.words : '';
  if (list.trim()) {
    if (list.length > 20000) return { error: 'Word list is too long.' };
    const seen = new Set();
    for (const part of list.split(/[\n,]+/)) {
      const w = normalize(part);
      if (w.length < 2 || w.length > C.MAX_WORD_LEN) continue;
      if (!/^[\p{L}\p{N} '-]+$/u.test(w)) continue;
      seen.add(w);
      if (seen.size >= C.MAX_WORDS) break;
    }
    if (seen.size < 3) return { error: 'Please give at least 3 valid words (letters/numbers, 2-30 chars).' };
    words = [...seen];
  }
  return { settings: { rounds, drawTime, words } };
}

module.exports = {
  TokenBucket, levenshtein, normalize, isClose, cleanText, toInt, shuffle,
  randomId, randomToken, parseSettings,
};
