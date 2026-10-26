/* Smush Solver page: board setup, the turn-by-turn solver loop (the browser
 * version of `smush_solver.py --interactive --agent beam+`), and the About
 * diagram. The search itself lives in smush.js.
 *
 * A game is a pure function of (board, spicy letter at the start, actions), so
 * undo and restoring a saved game both just replay the action list. */
(function () {
  'use strict';

  const S = window.Smush;
  const $ = id => document.getElementById(id);
  const STORE = 'smush-solver:v1';
  const EXAMPLE = { letters: 'eaghitvwy', spice: 'w' };
  const MIN_THINK_MS = 250;     // keeps the searching state from flashing past
  const CHILI = '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M12.6 1.4a.6.6 0 0 1 .9.6c-.1.6-.4 1.1-.9 1.4.9.6 1.4 1.7 1.2 2.9-.5 3.6-4.4 7.7-11 8.3a.5.5 0 0 1-.3-.9c3.2-2.1 4.6-4.6 5.4-7.1.5-1.7 1.9-2.8 3.5-2.8.3-.9.4-1.7 1.2-2.4z"/></svg>';

  const up = s => s.toUpperCase();
  const fmt = n => Math.round(n).toLocaleString('en-US');
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const delay = ms => new Promise(r => setTimeout(r, ms));

  let dict = null;
  const dictionary = () => dict || (dict = new S.Dictionary(window.SMUSH_WORDS));
  const specs = new Map();
  /** Board for nine letters, gold letter first; outer letters sorted like the CLI. */
  function specFor(letters) {
    if (!specs.has(letters)) {
      const hub = letters[0], outer = letters.slice(1).split('').sort();
      specs.set(letters, S.makeSpec(hub, outer, dictionary().playable(hub, letters)));
    }
    return specs.get(letters);
  }

  const setup = { letters: EXAMPLE.letters, spice: EXAMPLE.spice, example: true };
  let game = null;
  let searchId = 0;

  // --- setup -------------------------------------------------------------------

  function letterProblem(s) {
    if (!s.length) return 'Type the nine letters from your board, gold letter first.';
    const dup = [...s].find((c, i) => s.indexOf(c) !== i);
    if (dup) return `${up(dup)} is in there twice. A Smush board has nine different letters.`;
    if (s.length !== 9) return `That's ${plural(s.length, 'letter')}. A Smush board has nine.`;
    return null;
  }

  function onLettersInput(e) {
    const s = e.target.value.toLowerCase().replace(/[^a-z]/g, '');
    setup.letters = s;
    setup.example = false;
    if (setup.spice && (!s.includes(setup.spice) || s[0] === setup.spice)) setup.spice = null;
    $('setup-error').textContent = '';
    renderSetup();
    save();
  }

  function makeGold(c) {
    const s = setup.letters;
    if (!s.includes(c) || s[0] === c) return;
    setup.letters = c + s.replace(c, '');
    if (setup.spice === c) setup.spice = null;
    setup.example = false;
    $('letters').value = up(setup.letters);
    renderSetup();
    save();
  }

  function onSubmit(e) {
    e.preventDefault();
    const problem = letterProblem(setup.letters);
    const error = $('setup-error');
    if (problem) { error.textContent = problem; return; }
    if (!setup.spice) { error.textContent = 'Tap the letter that is spicy in the game right now.'; return; }
    if (!specFor(setup.letters).n) {
      error.textContent = 'No dictionary words fit these letters. Check them against the game.';
      return;
    }
    error.textContent = '';
    startGame(setup.letters, setup.spice, []);
    $('turn').focus({ preventScroll: true });
    $('turn').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function renderSetup() {
    const s = setup.letters;
    $('example-tag').hidden = !setup.example;
    const outer = s.slice(1, 9).split('').sort();
    paintBoard({
      hub: s[0] || '', outer, lives: new Int8Array(8).fill(S.USES),
      spice: setup.spice ? outer.indexOf(setup.spice) : -1, pickable: true,
    });
    const ok = !letterProblem(s);
    if (ok) {
      const spec = specFor(s);
      const pangrams = spec.isPangram.reduce((a, b) => a + b, 0);
      $('board-meta').textContent = `${fmt(spec.n)} words · ${plural(pangrams, 'pangram')}`;
    } else {
      $('board-meta').textContent = `${Math.min(s.length, 9)} of 9 letters`;
    }
    const choices = [...new Set(s.slice(1, 9))].sort();
    $('spice-pick').innerHTML = choices.length
      ? choices.map(c => `<button type="button" class="chip-btn" data-letter="${c}" aria-pressed="${c === setup.spice}" aria-label="${up(c)}">${up(c)}</button>`).join('')
      : '<p class="help">Your letters appear here once you type them.</p>';
  }

  // --- game ----------------------------------------------------------------------

  function startGame(letters, spiceLetter, actions) {
    searchId++;
    const spec = specFor(letters);
    game = {
      letters, spec, spice0: spec.outer.indexOf(spiceLetter), actions: actions.slice(),
      cache: [], rng: S.makeRng(0), phase: 'thinking', suggestion: null,
    };
    replay();
    save();
    render();
    think();
  }

  function canPlay(spec, state, w) {
    if (w === undefined || state.played[w]) return false;
    for (let s = 0; s < S.N_SLOTS; s++) if (spec.cost[w * S.N_SLOTS + s] > state.lives[s]) return false;
    return true;
  }

  /** Rebuild state and the played-words log from the action list. */
  function replay() {
    const { spec } = game;
    let state = S.newGame(spec, game.spice0);
    const log = [];
    let finished = false;
    for (let i = 0; i < game.actions.length; i++) {
      const a = game.actions[i], w = spec.index.get(a.word);
      if (a.type === 'finish') { finished = true; game.actions.length = i + 1; break; }
      if (!canPlay(spec, state, w)) { game.actions.length = i; break; }   // stale save
      if (a.type === 'play') {
        const bd = S.moveBreakdown(spec, state, w);
        state = S.step(spec, state, w, 0)[0];
        if (a.spice) state.spice = spec.outer.indexOf(a.spice);
        log.push({ type: 'play', word: a.word, bd });
      } else {
        state = S.copyState(state);   // not in the game's list: never suggest it again
        state.played[w] = 1;
        log.push({ type: 'reject', word: a.word });
      }
    }
    game.state = state;
    game.log = log;
    game.finished = finished;
  }

  function act(action) {
    game.cache.length = game.actions.length + 1;
    game.actions.push(action);
    replay();
    save();
    think();
  }

  function undo() {
    if (!game.actions.length) return;
    game.actions.pop();
    replay();
    save();
    think();
  }

  function newBoard() {
    searchId++;
    game = null;
    save();
    render();
    $('letters').focus({ preventScroll: true });
    $('solver').scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  function show(phase, suggestion) {
    game.phase = phase;
    game.suggestion = suggestion || null;
    render();
  }

  async function think() {
    const id = ++searchId;
    const { spec, state } = game;
    if (game.finished) return show('done');
    if (S.isOver(spec, state)) return show('over');
    const cached = game.cache[game.actions.length];
    if (cached) return show(cached.move === S.STOP ? 'stop' : 'suggest', cached);

    show('thinking');
    const started = performance.now();
    await delay(0);
    const result = await S.suggestAsync(spec, state, game.rng, S.DEFAULTS, {
      onProgress: (done, total) => { if (id === searchId) setProgress(done / total); },
      isCancelled: () => id !== searchId,
    });
    if (!result || id !== searchId) return;
    setProgress(1);
    const wait = MIN_THINK_MS - (performance.now() - started);
    if (wait > 0) await delay(wait);
    if (id !== searchId) return;
    game.cache[game.actions.length] = result;
    show(result.move === S.STOP ? 'stop' : 'suggest', result);
  }

  function setProgress(f) {
    const bar = $('progress-bar');
    if (!bar) return;
    bar.style.width = `${Math.round(f * 100)}%`;
    bar.parentElement.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }

  // --- rendering --------------------------------------------------------------------

  const tiles = [];

  function buildBoard() {
    const board = $('board');
    for (let i = 0; i < 9; i++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'tile';
      b.innerHTML = '<span class="flag"></span><span class="badge"></span><span class="tile-letter"></span>'
        + '<span class="pips"><i></i><i></i><i></i><i></i><i></i></span><span class="hub-mark" aria-hidden="true">∞</span>';
      b.addEventListener('click', () => { if (!game && b.dataset.letter) makeGold(b.dataset.letter); });
      board.appendChild(b);
      tiles.push(b);
    }
  }

  /** Grid order matches the game: four outer letters, the gold hub, four more. */
  function paintBoard({ hub, outer, lives, spice, uses = null, smush = null, pickable = false }) {
    for (let i = 0; i < 9; i++) {
      const b = tiles[i], isHub = i === 4, slot = i < 4 ? i : i - 1;
      const letter = isHub ? hub : (outer[slot] || '');
      const left = isHub ? 0 : lives[slot];
      const spend = uses && !isHub ? uses[slot] : 0;
      const spicy = !isHub && !!letter && slot === spice;
      b.dataset.letter = letter;
      b.querySelector('.tile-letter').textContent = up(letter);
      b.classList.toggle('is-hub', isHub && !!letter);
      b.classList.toggle('is-empty', !letter);
      b.classList.toggle('is-spicy', spicy);
      b.classList.toggle('is-out', !isHub && !!letter && left === 0);
      b.classList.toggle('is-used', spend > 0);
      b.querySelector('.flag').textContent = smush && smush[slot] && !isHub ? 'Smush' : '';
      b.querySelector('.badge').innerHTML = spicy ? CHILI : '';
      b.querySelectorAll('.pips i').forEach((pip, k) => {
        pip.className = k < left - spend ? '' : k < left ? 'spend' : 'off';
      });
      b.disabled = !pickable || !letter || isHub;
      let label = letter ? up(letter) : 'Empty tile';
      if (letter && isHub) label += ', gold letter, unlimited uses';
      else if (letter) {
        label += `, ${plural(left, 'use')} left`;
        if (spicy) label += ', spicy';
        if (spend) label += `, the suggested word spends ${spend}`;
        if (pickable) label += '. Press to make it the gold letter';
      }
      b.setAttribute('aria-label', label);
      b.title = pickable && letter && !isHub ? `Make ${up(letter)} the gold letter` : '';
    }
  }

  function render() {
    const inGame = !!game;
    $('setup').hidden = inGame;
    $('turn').hidden = !inGame;
    $('stats').hidden = !inGame;
    $('board-key').hidden = !inGame;
    $('log-card').hidden = !inGame;
    if (!inGame) return renderSetup();

    const { spec, state, phase, suggestion } = game;
    const move = phase === 'suggest' ? suggestion.move : -1;
    const uses = move >= 0 ? Array.from({ length: S.N_SLOTS }, (_, s) => spec.cost[move * S.N_SLOTS + s]) : null;
    const smush = uses && uses.map((u, s) => u > 0 && u === state.lives[s]);
    paintBoard({ hub: spec.hub, outer: spec.outer, lives: state.lives, spice: state.spice, uses, smush });
    const pangrams = spec.isPangram.reduce((a, b) => a + b, 0);
    $('board-meta').textContent = `${fmt(spec.n)} words · ${plural(pangrams, 'pangram')}`;
    renderStats(state);
    renderTurn();
    renderLog();
  }

  function renderStats(state) {
    const n = state.nPlayed, ice = $('st-ice');
    $('st-points').textContent = fmt(state.score);
    $('st-words').textContent = String(n);
    if (!state.cold) { ice.textContent = 'Lost'; ice.className = 'ice-off'; }
    else if (n >= S.ICE_MIN) { ice.textContent = 'Active ×5'; ice.className = 'ice-on'; }
    else { ice.textContent = `${n} of ${S.ICE_MIN} words`; ice.className = 'ice-on'; }
    $('st-total').textContent = n > 0 ? fmt(S.stateTotal(state)) : '–';
  }

  function multChips(bd) {
    const chips = [];
    if (bd.spicy) chips.push(`<span class="mchip spice">Spicy +${bd.spicy}</span>`);
    if (bd.smushed) chips.push(`<span class="mchip">Smush +${bd.smushed}</span>`);
    if (bd.pangram) chips.push(`<span class="mchip gold">Pangram +${bd.pangram}</span>`);
    return chips.join('');
  }

  function tally(state) {
    const rows = S.bonusRows(state).map(r => {
      const label = r.key === 'words' ? `Word points, ${r.label}` : r.label;
      return `<tr class="${r.key}"><th scope="row">${label}</th><td>${r.effect}</td></tr>`;
    });
    return `<table class="tally"><tbody>${rows.join('')}`
      + `<tr class="total"><th scope="row">Final score</th><td>${fmt(S.stateTotal(state))}</td></tr></tbody></table>`;
  }

  function renderTurn() {
    const { spec, state, phase, suggestion: r } = game;
    const wordNo = state.nPlayed + 1;
    const undoBtn = game.actions.length ? '<button type="button" class="btn ghost" data-act="undo">Undo</button>' : '';
    let html;

    if (phase === 'thinking') {
      const shortlist = Math.min(S.DEFAULTS.topK, S.legalList(spec, state).length);
      html = `
        <div class="turn-top"><p class="label">Word ${wordNo}</p></div>
        <p class="searching">Searching…</p>
        <div class="progress" role="progressbar" aria-label="Search progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="progress-bar"></span></div>
        <p class="small">Trying the ${plural(shortlist, 'best word')} against ${S.DEFAULTS.samples} random spice futures, each played out to the end of the game.</p>
        ${undoBtn ? `<div class="turn-actions">${undoBtn}</div>` : ''}`;
    } else if (phase === 'suggest') {
      const w = r.move, word = spec.words[w];
      const bd = S.moveBreakdown(spec, state, w);
      const options = spec.outer.filter((c, s) => state.lives[s] - spec.cost[w * S.N_SLOTS + s] > 0 && s !== state.spice);
      const ask = options.length
        ? `<p class="ask" id="ask">Played it? Tap the letter that's spicy now.<small>Or press its key.</small></p>
           <div class="chips" role="group" aria-labelledby="ask">${options.map(c =>
             `<button type="button" class="chip-btn" data-spice="${c}" aria-label="${up(c)} is spicy now">${up(c)}</button>`).join('')}</div>`
        : `<p class="ask">Played it?<small>No letters are left for the chili to jump to.</small></p>
           <div><button type="button" class="btn primary" data-act="played">I played it</button></div>`;
      html = `
        <div class="turn-top"><p class="label">Word ${wordNo} · Play this</p></div>
        <p class="big-word" style="--len:${word.length}">${up(word)}</p>
        <div class="score-line">
          <span class="pts">+${fmt(bd.points)}</span>
          <span class="formula">${bd.base} × ${bd.mult}</span>
          <span class="mchips">${multChips(bd)}</span>
        </div>
        <p class="projection">Projected final score <b>${fmt(r.value)}</b>, averaged over ${S.DEFAULTS.samples} spice futures.</p>
        <hr class="divider">
        <div class="ask-block">${ask}</div>
        <div class="turn-actions">
          <button type="button" class="btn ghost" data-act="reject">Smush rejected it</button>
          <button type="button" class="btn ghost" data-act="finish">Finish game</button>
          ${undoBtn}
        </div>`;
    } else {
      let title, body;
      if (phase === 'stop') {
        const best = r.candidates.reduce((m, c) => Math.max(m, c.value), 0);
        title = 'Stop here';
        body = `Tap <b>I'm done</b> in Smush now. Stopping scores ${fmt(r.stopValue)}. The best word left averages ${fmt(best)} if you keep going.`;
      } else if (phase === 'over') {
        title = 'All smushed';
        body = 'No playable words are left, so the game is over.';
      } else {
        title = 'Game finished';
        body = 'Here is the tally for the words you played.';
      }
      html = `
        <div class="turn-top"><p class="label">${phase === 'stop' ? 'Solver says' : 'Game over'}</p></div>
        <p class="big-word" style="--len:${Math.max(title.length, 9)}">${title}</p>
        <p class="body">${body}</p>
        ${tally(state)}
        <div class="turn-actions">${undoBtn}<button type="button" class="btn ghost" data-act="new">New board</button></div>`;
    }
    const turn = $('turn');
    turn.innerHTML = html;
    turn.dataset.phase = phase;
  }

  function renderLog() {
    let n = 0;
    const items = game.log.map(e => {
      if (e.type === 'reject') {
        return `<li class="rejected"><span class="n">–</span><span class="w">${up(e.word)}</span><span class="p">0</span>`
          + '<span class="tags"><span class="mchip">Rejected by Smush</span></span></li>';
      }
      n++;
      return `<li><span class="n">${n}</span><span class="w">${up(e.word)}</span><span class="p">+${fmt(e.bd.points)}</span>`
        + `<span class="tags">${multChips(e.bd)}</span></li>`;
    }).reverse();
    $('log').innerHTML = items.length ? items.join('') : '<li class="empty">Words you play will show up here, newest first.</li>';
  }

  // --- events -----------------------------------------------------------------------------

  function onTurnClick(e) {
    const b = e.target.closest('button');
    if (!b || !game) return;
    const { spec, phase, suggestion } = game;
    if (b.dataset.spice && phase === 'suggest') {
      act({ type: 'play', word: spec.words[suggestion.move], spice: b.dataset.spice });
      return;
    }
    switch (b.dataset.act) {
      case 'played': if (phase === 'suggest') act({ type: 'play', word: spec.words[suggestion.move], spice: null }); break;
      case 'reject': if (phase === 'suggest') act({ type: 'reject', word: spec.words[suggestion.move] }); break;
      case 'finish': act({ type: 'finish' }); break;
      case 'undo': undo(); break;
      case 'new': newBoard(); break;
    }
  }

  function onKey(e) {
    if (!game || game.phase !== 'suggest' || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (!/^[a-z]$/.test(k)) return;
    const btn = $('turn').querySelector(`[data-spice="${k}"]`);
    if (btn) { e.preventDefault(); btn.click(); }
  }

  // --- saving --------------------------------------------------------------------------------

  function serialize() {
    return {
      setup: { ...setup },
      game: game && { letters: game.letters, spice: game.spec.outer[game.spice0], actions: game.actions },
    };
  }

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(serialize())); } catch (e) { /* storage unavailable */ }
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { return null; }
  }

  function restore(data) {
    if (data && data.setup && typeof data.setup.letters === 'string') {
      setup.letters = data.setup.letters.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12);
      const spice = data.setup.spice;
      setup.spice = typeof spice === 'string' && setup.letters.slice(1).includes(spice) ? spice : null;
      setup.example = !!data.setup.example;
    }
    $('letters').value = up(setup.letters);
    const g = data && data.game;
    if (g && typeof g.letters === 'string' && !letterProblem(g.letters) && g.letters.slice(1).includes(g.spice)) {
      startGame(g.letters, g.spice, Array.isArray(g.actions) ? g.actions : []);
    }
  }

  // --- About diagram -------------------------------------------------------------------------

  /** A beam of 3 with 3 branches per game, drawn over four steps. */
  function drawBeam() {
    const svg = $('beam-svg');
    const NS = 'http://www.w3.org/2000/svg';
    const x0 = 44, dx = 138, top = 52, bottom = 196, mid = (top + bottom) / 2;
    const keep = [null, [0, 1, 2], [1, 4, 6], [2, 3, 7], [1, 5, 8]];
    const bestIdx = 5;
    const edges = [], nodes = [{ x: x0, y: mid, cls: 'kept' }];
    let parents = [{ x: x0, y: mid }];
    for (let d = 1; d < keep.length; d++) {
      const x = x0 + d * dx, kids = [];
      parents.forEach(p => { for (let j = 0; j < 3; j++) kids.push({ p }); });
      kids.forEach((k, i) => {
        k.x = x;
        k.y = kids.length === 1 ? mid : top + i * (bottom - top) / (kids.length - 1);
        const kept = keep[d].includes(i);
        edges.push({ ...k, kept });
        nodes.push({ x: k.x, y: k.y, cls: kept ? (d === keep.length - 1 && i === bestIdx ? 'kept best' : 'kept') : '' });
      });
      parents = kids.filter((_, i) => keep[d].includes(i));
    }
    const el = (tag, attrs, text) => {
      const n = document.createElementNS(NS, tag);
      for (const k in attrs) n.setAttribute(k, attrs[k]);
      if (text) n.textContent = text;
      svg.appendChild(n);
      return n;
    };
    edges.sort((a, b) => a.kept - b.kept).forEach(e => {
      const mx = (e.p.x + e.x) / 2;
      el('path', { class: `bm-edge${e.kept ? ' kept' : ''}`, d: `M${e.p.x} ${e.p.y} C${mx} ${e.p.y} ${mx} ${e.y} ${e.x} ${e.y}` });
    });
    nodes.forEach(n => el('circle', { class: `bm-node ${n.cls}`, cx: n.x, cy: n.y, r: n.cls ? 6.5 : 4.5 }));
    ['Now', '+1 word', '+2 words', '+3 words', '+4 words'].forEach((t, d) =>
      el('text', { class: 'bm-text', x: x0 + d * dx, y: 232, 'text-anchor': 'middle' }, t));
    let lx = 0;
    [['kept', 'kept', 6.5], ['', 'dropped', 4.5], ['kept best', 'best line so far', 6.5]].forEach(([cls, label, r]) => {
      el('circle', { class: `bm-node ${cls}`, cx: lx + 8, cy: 14, r });
      el('text', { class: 'bm-text', x: lx + 20, y: 18 }, label);
      lx += 34 + label.length * 7.4;
    });
  }

  // --- boot ------------------------------------------------------------------------------------

  function start(data) {
    buildBoard();
    drawBeam();
    $('letters').addEventListener('input', onLettersInput);
    $('setup').addEventListener('submit', onSubmit);
    $('spice-pick').addEventListener('click', e => {
      const b = e.target.closest('button[data-letter]');
      if (!b) return;
      setup.spice = b.dataset.letter;
      $('setup-error').textContent = '';
      renderSetup();
      save();
    });
    $('turn').addEventListener('click', onTurnClick);
    document.addEventListener('keydown', onKey);
    restore(data && (data.setup || data.game) ? data : load());
    render();
  }

  const hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(serialize);
  if (hot && hot.ready) hot.ready(start);
  else start((hot && hot.data) || {});
})();
