/* Smush engine and the beam+ solver, ported from smush_engine.py and
 * baselines.py (BonusBeamAgent) so the site runs with no server.
 *
 * A board's word list is compiled into flat typed arrays:
 *   cost[w * 8 + slot]  uses of each outer letter word w spends (the gold hub is free)
 *   base[w]             sum of Scrabble letter values
 *   isPangram[w]
 * The spicy letter's move is driven by a uniform number u in [0, 1), exactly as
 * in the Python engine, so search code can fix the u values to "determinize"
 * the future.
 */
(function (global) {
  'use strict';

  const N_SLOTS = 8;
  const USES = 5;
  const MIN_LEN = 3;
  const MAX_TURNS = 128;   // far more turns than any game can last (40 letter uses)
  const STOP = -1;

  const CLEAN_PLATE = 50, UNASSISTED = 25;
  const HEAVY_LIFTER = 25, HEAVY_MAX = 6;
  const WORD_HOARD = 25, HOARD_MIN = 13;
  const PERFECT_MULT = 2, ICE_MULT = 5, ICE_MIN = 5;
  const NO_ICE = Infinity;   // an iceMin no game reaches: scores without ICE COLD

  const CH_SCORE = [1, 3, 3, 2, 1, 4, 2, 4, 1, 8, 5, 1, 3, 1, 1, 3, 10, 1, 1, 1, 1, 4, 4, 8, 4, 10];
  const A = 97;

  function letterMask(s) {
    let m = 0;
    for (let i = 0; i < s.length; i++) m |= 1 << (s.charCodeAt(i) - A);
    return m;
  }

  function wordScore(w) {
    let s = 0;
    for (let i = 0; i < w.length; i++) s += CH_SCORE[w.charCodeAt(i) - A];
    return s;
  }

  // sfc32: small, fast, seedable PRNG returning floats in [0, 1)
  function makeRng(seed) {
    let a = 0x9e3779b9, b = 0x243f6a88, c = 0xb7e15162, d = seed >>> 0;
    const next = () => {
      a |= 0; b |= 0; c |= 0; d |= 0;
      const t = (((a + b) | 0) + d) | 0;
      d = (d + 1) | 0;
      a = b ^ (b >>> 9);
      b = (c + (c << 3)) | 0;
      c = (c << 21) | (c >>> 11);
      c = (c + t) | 0;
      return (t >>> 0) / 4294967296;
    };
    for (let i = 0; i < 15; i++) next();
    return next;
  }

  // --- dictionary and boards ------------------------------------------------

  class Dictionary {
    constructor(text) {
      this.words = text.split('\n').map(w => w.trim().toLowerCase()).filter(w => w.length >= MIN_LEN);
      this.masks = new Int32Array(this.words.length);
      for (let i = 0; i < this.words.length; i++) this.masks[i] = letterMask(this.words[i]);
    }

    /** Words spelled only from `letters` that contain `hub`. */
    playable(hub, letters) {
      const allowed = letterMask(letters), hubBit = letterMask(hub), out = [];
      for (let i = 0; i < this.masks.length; i++) {
        const m = this.masks[i];
        if ((m & ~allowed) === 0 && (m & hubBit) !== 0) out.push(this.words[i]);
      }
      return out;
    }
  }

  /** Compile a board: `hub` is the gold letter, `outer` the 8 others (slot i <-> outer[i]). */
  function makeSpec(hub, outer, words) {
    const n = words.length;
    const slotOf = new Int8Array(26).fill(-1);
    outer.forEach((ch, i) => { slotOf[ch.charCodeAt(0) - A] = i; });
    const all = letterMask(hub + outer.join(''));
    const cost = new Int8Array(n * N_SLOTS);
    const base = new Int32Array(n);
    const isPangram = new Uint8Array(n);
    const nUsed = new Uint8Array(n);                  // distinct outer letters each word spends
    const usedSlots = new Uint8Array(n * N_SLOTS);    // ...and which slots they are
    const zHi = new Uint32Array(n), zLo = new Uint32Array(n);   // Zobrist keys for word sets
    const rng = makeRng(0x5eed);
    const hubCode = hub.charCodeAt(0);
    for (let r = 0; r < n; r++) {
      const w = words[r], o = r * N_SLOTS;
      for (let i = 0; i < w.length; i++) {
        const code = w.charCodeAt(i);
        if (code !== hubCode) cost[o + slotOf[code - A]]++;
      }
      base[r] = wordScore(w);
      isPangram[r] = (letterMask(w) & all) === all ? 1 : 0;
      let k = 0;
      for (let s = 0; s < N_SLOTS; s++) if (cost[o + s] > 0) usedSlots[o + k++] = s;
      nUsed[r] = k;
      zHi[r] = Math.floor(rng() * 4294967296);
      zLo[r] = Math.floor(rng() * 4294967296);
    }
    const index = new Map(words.map((w, i) => [w, i]));
    return { hub, outer, words, n, cost, base, isPangram, nUsed, usedSlots, zHi, zLo, index };
  }

  // --- game state and rules ---------------------------------------------------

  function newGame(spec, spice) {
    return {
      lives: new Int8Array(N_SLOTS).fill(USES), spice, played: new Uint8Array(spec.n),
      score: 0, nPlayed: 0, cold: true, pangramFirst: false,
    };
  }

  function copyState(s) {
    return { ...s, lives: s.lives.slice(), played: s.played.slice() };
  }

  function fits(spec, w, lives) {
    const o = w * N_SLOTS, cost = spec.cost, used = spec.usedSlots;
    for (let k = 0, m = spec.nUsed[w]; k < m; k++) {
      const s = used[o + k];
      if (cost[o + s] > lives[s]) return false;
    }
    return true;
  }

  /** Indices of the words that are unplayed and affordable. */
  function legalList(spec, state) {
    const out = [];
    for (let w = 0; w < spec.n; w++) if (!state.played[w] && fits(spec, w, state.lives)) out.push(w);
    return Int32Array.from(out);
  }

  function isOver(spec, state) {
    for (let w = 0; w < spec.n; w++) if (!state.played[w] && fits(spec, w, state.lives)) return false;
    return true;
  }

  /** Points word w would score right now (ignores legality). */
  function movePoints(spec, lives, spice, nPlayed, w) {
    const o = w * N_SLOTS, cost = spec.cost, used = spec.usedSlots;
    let mult = 1;
    for (let k = 0, m = spec.nUsed[w]; k < m; k++) {
      const s = used[o + k];
      if (cost[o + s] === lives[s]) mult++;         // smushed: this word spends the letter's last use
    }
    if (spice >= 0) mult += cost[o + spice];
    if (spec.isPangram[w]) mult += nPlayed === 0 ? 4 : 2;
    return spec.base[w] * mult;
  }

  /** Move the spice to a uniformly chosen living slot other than `current`; -1 if none. */
  function nextSpice(lives, current, u) {
    let count = 0;
    for (let s = 0; s < N_SLOTS; s++) if (lives[s] > 0 && s !== current) count++;
    if (count === 0) return -1;
    let pick = Math.floor(u * count);
    for (let s = 0; s < N_SLOTS; s++) {
      if (lives[s] > 0 && s !== current && pick-- === 0) return s;
    }
    return -1;
  }

  /** Bonus parts of a single move, for display. */
  function moveBreakdown(spec, state, w) {
    const o = w * N_SLOTS;
    const spicy = state.spice >= 0 ? spec.cost[o + state.spice] : 0;
    let smushed = 0;
    for (let s = 0; s < N_SLOTS; s++) {
      const c = spec.cost[o + s];
      if (c > 0 && c === state.lives[s]) smushed++;
    }
    const pangram = spec.isPangram[w] ? (state.nPlayed === 0 ? 4 : 2) : 0;
    const mult = 1 + spicy + smushed + pangram;
    return { base: spec.base[w], spicy, smushed, pangram, mult, points: spec.base[w] * mult };
  }

  /** Play word w; returns [newState, points]. Does not mutate `state`. */
  function step(spec, state, w, u) {
    const o = w * N_SLOTS;
    const pts = movePoints(spec, state.lives, state.spice, state.nPlayed, w);
    const lives = state.lives.slice();
    for (let s = 0; s < N_SLOTS; s++) lives[s] -= spec.cost[o + s];
    const played = state.played.slice();
    played[w] = 1;
    const touched = state.spice >= 0 && spec.cost[o + state.spice] > 0;
    return [{
      lives, played, spice: nextSpice(lives, state.spice, u),
      score: state.score + pts, nPlayed: state.nPlayed + 1,
      cold: state.cold && !touched,
      pangramFirst: state.pangramFirst || (state.nPlayed === 0 && spec.isPangram[w] === 1),
    }, pts];
  }

  // --- end-of-game bonuses (as tallied by the live game) ----------------------
  // total = (word points + clean plate + unassisted + heavy lifter / word hoard)
  //         x2 if PERFECT (pangram first, clean plate, no hints)
  //         x5 if ICE COLD (5+ words, none of them used the spicy letter)

  function finalScore(score, lives, n, cold, pangramFirst, hints = 0, iceMin = ICE_MIN) {
    let clean = true;
    for (let s = 0; s < N_SLOTS; s++) if (lives[s] !== 0) { clean = false; break; }
    const noHints = hints === 0;
    let total = score + (clean ? CLEAN_PLATE : 0) + (noHints && n > 0 ? UNASSISTED : 0)
      + (n > 0 && n <= HEAVY_MAX ? HEAVY_LIFTER : 0) + (n >= HOARD_MIN ? WORD_HOARD : 0);
    if (pangramFirst && clean && noHints) total *= PERFECT_MULT;
    if (cold && n >= iceMin) total *= ICE_MULT;
    return total;
  }

  function stateTotal(state) {
    return finalScore(state.score, state.lives, state.nPlayed, state.cold, state.pangramFirst);
  }

  /** What the search maximises: the final total if the game stopped now, with
   * ICE COLD only when `ice` is on (Pangram mode turns it off). */
  function objective(state, ice = true) {
    return finalScore(state.score, state.lives, state.nPlayed, state.cold, state.pangramFirst, 0,
      ice ? ICE_MIN : NO_ICE);
  }

  /** {key, label, effect} rows for an end-of-game summary. */
  function bonusRows(state) {
    let clean = true;
    for (let s = 0; s < N_SLOTS; s++) if (state.lives[s] !== 0) clean = false;
    const n = state.nPlayed;
    const rows = [{ key: 'words', label: `${n} word${n === 1 ? '' : 's'}`, effect: String(state.score) }];
    if (clean) rows.push({ key: 'clean', label: 'Clean plate', effect: `+${CLEAN_PLATE}` });
    if (n > 0) rows.push({ key: 'unassisted', label: 'Unassisted', effect: `+${UNASSISTED}` });
    if (n > 0 && n <= HEAVY_MAX) rows.push({ key: 'heavy', label: 'Heavy lifter', effect: `+${HEAVY_LIFTER}` });
    else if (n >= HOARD_MIN) rows.push({ key: 'hoard', label: 'Word hoard', effect: `+${WORD_HOARD}` });
    if (state.pangramFirst && clean) rows.push({ key: 'perfect', label: 'Perfect game', effect: `×${PERFECT_MULT}` });
    if (state.cold && n >= ICE_MIN) rows.push({ key: 'ice', label: 'ICE COLD', effect: `×${ICE_MULT}` });
    return rows;
  }

  // --- beam+ search -------------------------------------------------------------
  // A search node is one partial game:
  //   {lives, living, spice, score, n, cold, pf, legal, hi, lo}
  // `legal` lists the node's playable words (a child's list is always a subset
  // of its parent's), `living` counts letters with uses left, and hi/lo hash the
  // set of words played since the search root.

  function rootNode(spec, state) {
    let living = 0;
    for (let s = 0; s < N_SLOTS; s++) if (state.lives[s] > 0) living++;
    return {
      lives: state.lives, living, spice: state.spice, score: state.score, n: state.nPlayed,
      cold: state.cold, pf: state.pangramFirst, legal: legalList(spec, state), hi: 0, lo: 0,
    };
  }

  /** Final total right after playing w from `node`, as if the game stopped there.
   * Optimistic: ICE COLD counts from the first word, so the search protects the
   * x5 before the fifth word makes it real (baselines.child_totals). Without
   * `ice` it never counts. */
  function childKey(spec, node, w, ice = true) {
    const o = w * N_SLOTS, cost = spec.cost, used = spec.usedSlots, lives = node.lives;
    let smushed = 0;
    for (let k = 0, m = spec.nUsed[w]; k < m; k++) {
      const s = used[o + k];
      if (cost[o + s] === lives[s]) smushed++;
    }
    const spicy = node.spice >= 0 ? cost[o + node.spice] : 0;
    const pangram = spec.isPangram[w] === 1;
    const pts = spec.base[w] * (1 + smushed + spicy + (pangram ? (node.n === 0 ? 4 : 2) : 0));
    const clean = smushed === node.living;     // every letter that had uses left is now spent
    const n = node.n + 1;
    let total = node.score + pts + (clean ? CLEAN_PLATE : 0) + UNASSISTED
      + (n <= HEAVY_MAX ? HEAVY_LIFTER : 0) + (n >= HOARD_MIN ? WORD_HOARD : 0);
    if (clean && (node.pf || (node.n === 0 && pangram))) total *= PERFECT_MULT;
    if (ice && node.cold && spicy === 0) total *= ICE_MULT;
    return total;
  }

  /** The node reached by playing w; the spice then moves with draw u. */
  function childNode(spec, node, w, u) {
    const o = w * N_SLOTS, cost = spec.cost;
    const lives = node.lives.slice();
    let living = 0;
    for (let s = 0; s < N_SLOTS; s++) {
      lives[s] -= cost[o + s];
      if (lives[s] > 0) living++;
    }
    const parent = node.legal, legal = new Int32Array(parent.length);
    let k = 0;
    for (let i = 0; i < parent.length; i++) {
      const x = parent[i];
      if (x !== w && fits(spec, x, lives)) legal[k++] = x;
    }
    return {
      lives, living, spice: nextSpice(lives, node.spice, u),
      score: node.score + movePoints(spec, node.lives, node.spice, node.n, w), n: node.n + 1,
      cold: node.cold && !(node.spice >= 0 && cost[o + node.spice] > 0),
      pf: node.pf || (node.n === 0 && spec.isPangram[w] === 1),
      legal: legal.subarray(0, k),
      hi: (node.hi ^ spec.zHi[w]) >>> 0, lo: (node.lo ^ spec.zLo[w]) >>> 0,
    };
  }

  /** Best final total (bonuses included, stopping allowed) a beam search finds
   * from `start` when future spice draws are us[from], us[from + 1], ...
   * Each depth expands every game's `branch` best words, merges games that
   * reached the same word set, and keeps the `width` best (baselines.beam_total). */
  function beamTotal(spec, start, us, from, width, branch, ice = true) {
    const iceMin = ice ? ICE_MIN : NO_ICE;
    let beam = [start];
    let best = start.n > 0 ? finalScore(start.score, start.lives, start.n, start.cold, start.pf, 0, iceMin) : 0;
    const topW = new Int32Array(branch), topK = new Float64Array(branch);
    for (let t = from; t < us.length; t++) {
      const candP = [], candW = [], candK = [];
      for (let p = 0; p < beam.length; p++) {
        const node = beam[p], legal = node.legal;
        let cnt = 0;
        for (let i = 0; i < legal.length; i++) {
          const w = legal[i], key = childKey(spec, node, w, ice);
          if (cnt === branch && key <= topK[cnt - 1]) continue;
          let j = cnt < branch ? cnt++ : cnt - 1;     // insertion into a short sorted list
          while (j > 0 && topK[j - 1] < key) { topK[j] = topK[j - 1]; topW[j] = topW[j - 1]; j--; }
          topK[j] = key; topW[j] = w;
        }
        for (let j = 0; j < cnt; j++) { candP.push(p); candW.push(topW[j]); candK.push(topK[j]); }
      }
      if (candK.length === 0) break;
      const order = candK.map((_, i) => i).sort((a, b) => candK[b] - candK[a] || a - b);
      const seen = new Set(), next = [], u = us[t];
      for (const i of order) {
        const node = beam[candP[i]], w = candW[i];
        const hash = ((node.hi ^ spec.zHi[w]) >>> 0) * 2097152 + (((node.lo ^ spec.zLo[w]) >>> 0) >>> 11);
        if (seen.has(hash)) continue;    // the same word set reached in another order
        seen.add(hash);
        const child = childNode(spec, node, w, u);
        next.push(child);
        best = Math.max(best, finalScore(child.score, child.lives, child.n, child.cold, child.pf, 0, iceMin));
        if (next.length === width) break;
      }
      beam = next;
    }
    return best;
  }

  const DEFAULTS = { topK: 12, samples: 8, width: 24, branch: 8, ice: true };

  /** The beam+ agent's search, one beam search per step so callers can pause between them.
   * Shortlists the topK words by optimistic total, samples `samples` spice futures (the
   * same futures for every word), runs a beam search to the end of the game in each,
   * and returns the word with the best average final total, or STOP when stopping now
   * beats them all. With `ice` off, totals leave out ICE COLD (Pangram mode). */
  function* searchSteps(spec, state, rng, params = {}) {
    const { topK, samples, width, branch, ice, futures: given } = { ...DEFAULTS, ...params };
    const root = rootNode(spec, state);
    const stopValue = state.nPlayed > 0 ? objective(state, ice) : -1;
    if (root.legal.length === 0) return { move: STOP, value: stopValue, stopValue, candidates: [] };

    const keys = new Float64Array(spec.n);
    for (const w of root.legal) keys[w] = childKey(spec, root, w, ice);
    const cand = Array.from(root.legal).sort((a, b) => keys[b] - keys[a] || a - b).slice(0, topK);

    const futures = given || Array.from({ length: samples }, () => {
      const us = new Float64Array(MAX_TURNS);
      for (let i = 0; i < MAX_TURNS; i++) us[i] = rng();
      return us;
    });

    let best = STOP, bestV = stopValue;
    const candidates = [];
    const total = cand.length * futures.length;
    for (let i = 0; i < cand.length; i++) {
      const c = cand[i];
      const child = childNode(spec, root, c, 0);
      let v = 0;
      for (let f = 0; f < futures.length; f++) {
        const us = futures[f];
        const start = { ...child, spice: nextSpice(child.lives, root.spice, us[0]) };
        v += beamTotal(spec, start, us, 1, width, branch, ice);
        yield { done: i * futures.length + f + 1, total };
      }
      v /= futures.length;
      candidates.push({ word: c, value: v });
      if (v > bestV) { best = c; bestV = v; }
    }
    return { move: best, value: bestV, stopValue, candidates };
  }

  function suggest(spec, state, rng, params) {
    const it = searchSteps(spec, state, rng, params);
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
    }
  }

  // Yield to the browser without setTimeout's 4 ms clamp.
  const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
  const waiting = [];
  if (channel) channel.port1.onmessage = () => waiting.shift()();
  const yieldToBrowser = () => new Promise(resolve => {
    if (!channel) return setTimeout(resolve, 0);
    waiting.push(resolve);
    channel.port2.postMessage(0);
  });

  /** Same as suggest, but pauses every ~30 ms so the page stays responsive.
   * Resolves to null if isCancelled() turns true. */
  async function suggestAsync(spec, state, rng, params, { onProgress, isCancelled } = {}) {
    const it = searchSteps(spec, state, rng, params);
    let last = performance.now();
    for (;;) {
      const r = it.next();
      if (r.done) return r.value;
      if (performance.now() - last > 30) {
        if (onProgress) onProgress(r.value.done, r.value.total);
        await yieldToBrowser();
        if (isCancelled && isCancelled()) return null;
        last = performance.now();
      }
    }
  }

  global.Smush = {
    N_SLOTS, USES, STOP, MAX_TURNS, DEFAULTS,
    CLEAN_PLATE, UNASSISTED, HEAVY_LIFTER, HEAVY_MAX, WORD_HOARD, HOARD_MIN, PERFECT_MULT, ICE_MULT, ICE_MIN,
    letterMask, wordScore, makeRng, Dictionary, makeSpec, newGame, copyState, legalList, isOver,
    movePoints, nextSpice, moveBreakdown, step, finalScore, stateTotal, objective, bonusRows,
    rootNode, childKey, childNode, beamTotal, searchSteps, suggest, suggestAsync,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
