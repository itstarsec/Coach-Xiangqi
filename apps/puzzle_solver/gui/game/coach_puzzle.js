/*
  Puzzle Mini-map Coach (Browser-only)
  - Ultra-light overlay: only renders a mini-map + bestmove label.
  - Auto-analyzes (no buttons) and is rate-limited to keep UI smooth.
  - Designed for apps/puzzle_solver.

  Notes:
  - engine.search() is synchronous; keep the time budget short.
  - Analyze mainly when it's RED to move (most puzzles are "w").
*/

(function () {
  'use strict';

  if (typeof window.engine === 'undefined') {
    console.warn('[PuzzleCoach] engine not found.');
    return;
  }

  const elMinimap = document.getElementById('coach-minimap');
  const elCanvas = document.getElementById('coach-canvas');
  const elLabel = document.getElementById('coach-move-label');

  if (!elMinimap || !elCanvas || !elLabel) {
    console.warn('[PuzzleCoach] UI not found.');
    return;
  }

  // --- perf policy ---
  // IMPORTANT for puzzles: side-to-move can be RED or BLACK.
  // So we ALWAYS analyze for the current side to move.
  const COACH_ONLY_WHEN_RED_TO_MOVE = false;
  const SEARCH_TIME_SECONDS = 0.12;   // ~120ms
  const SEARCH_DEPTH = 18;            // fallback
  const MIN_INTERVAL_MS = 220;        // rate limit

  // --- canvas setup ---
  const ctx = elCanvas.getContext('2d', { alpha: true, desynchronized: true });
  let dpr = Math.max(1, window.devicePixelRatio || 1);

  function resizeCanvas() {
    const rect = elMinimap.getBoundingClientRect();
    dpr = Math.max(1, window.devicePixelRatio || 1);
    elCanvas.width = Math.round(rect.width * dpr);
    elCanvas.height = Math.round(rect.height * dpr);
    elCanvas.style.width = rect.width + 'px';
    elCanvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- helpers ---
  const PIECE_TO_CHAR = ['.', 'P', 'A', 'B', 'N', 'C', 'R', 'K', 'p', 'a', 'b', 'n', 'c', 'r', 'k'];

  function sideName() {
    try {
      if (window.engine.getSide && window.engine.COLOR) {
        return (window.engine.getSide() === window.engine.COLOR.BLACK) ? 'Đen' : 'Đỏ';
      }
    } catch (_) {}
    return '';
  }

  function sideToMoveIsBlack() {
    try {
      if (window.engine.getSide && window.engine.COLOR) {
        return window.engine.getSide() === window.engine.COLOR.BLACK;
      }
    } catch (_) {}
    return false;
  }

  function flipSquare(square) {
    // Flip 180 degrees for a 9x10 Xiangqi board.
    // a-i => 0-8, 0-9 ranks.
    if (!square || square.length < 2) return square;
    const file = fileToIndex(square[0]);
    const rank = Number(square[1]);
    if (Number.isNaN(file) || Number.isNaN(rank)) return square;
    const ff = 8 - file;
    const fr = 9 - rank;
    return String.fromCharCode('a'.charCodeAt(0) + ff) + String(fr);
  }

  function flipUcci(ucci) {
    if (!ucci || ucci.length < 4) return ucci;
    return flipSquare(ucci.slice(0, 2)) + flipSquare(ucci.slice(2, 4));
  }

  function fileToIndex(ch) {
    return ch.charCodeAt(0) - 'a'.charCodeAt(0);
  }

  function ucciToRows(ucci) {
    // UCCI ranks: 0 (red bottom) .. 9 (black top)
    // Canvas rows: 0 (top) .. 9 (bottom)
    const fromFile = fileToIndex(ucci[0]);
    const fromRank = Number(ucci[1]);
    const toFile = fileToIndex(ucci[2]);
    const toRank = Number(ucci[3]);
    return {
      fromFile,
      fromRow: 9 - fromRank,
      toFile,
      toRow: 9 - toRank,
    };
  }

  const coordToSquare = (function buildMap() {
    const map = Object.create(null);
    for (let sq = 0; sq < 11 * 14; sq++) {
      const c = window.engine.squareToString(sq);
      if (c && c !== 'xx') map[c] = sq;
    }
    return map;
  })();

  function pieceAt(coord) {
    const sq = coordToSquare[coord];
    if (typeof sq === 'undefined') return '.';
    const p = window.engine.getPiece(sq);
    return PIECE_TO_CHAR[p] || '.';
  }

  function cellToXY(file, row, W, H) {
    return {
      x: (file + 0.5) * (W / 9),
      y: (row + 0.5) * (H / 10),
    };
  }

  function drawGrid(W, H) {
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';

    for (let i = 1; i < 9; i++) {
      const x = (i * W) / 9;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }

    for (let j = 1; j < 10; j++) {
      const y = (j * H) / 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawPieces(W, H) {
    const r = Math.max(2.5, Math.min(6, Math.min(W / 60, H / 60)));

    // Traverse ranks: top (9) -> bottom (0)
    for (let rank = 9; rank >= 0; rank--) {
      const row = 9 - rank;
      for (let file = 0; file < 9; file++) {
        const coord = String.fromCharCode('a'.charCodeAt(0) + file) + String(rank);
        const pch = pieceAt(coord);
        if (pch === '.') continue;
        const pos = cellToXY(file, row, W, H);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = (pch === pch.toUpperCase()) ? '#ff4d4d' : 'rgba(230,238,247,0.85)';
        ctx.fill();
      }
    }
  }

  function drawHint(ucci, W, H) {
    if (!ucci || ucci.length < 4) return;

    const c = ucciToRows(ucci);
    const a = cellToXY(c.fromFile, c.fromRow, W, H);
    const b = cellToXY(c.toFile, c.toRow, W, H);

    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,208,0,0.85)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // arrow head
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const headLen = 10;
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(ang - Math.PI / 7), b.y - headLen * Math.sin(ang - Math.PI / 7));
    ctx.lineTo(b.x - headLen * Math.cos(ang + Math.PI / 7), b.y - headLen * Math.sin(ang + Math.PI / 7));
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,208,0,0.85)';
    ctx.fill();

    // from/to rings
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0,212,255,0.95)';
    ctx.beginPath();
    ctx.arc(a.x, a.y, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(255,77,77,0.95)';
    ctx.beginPath();
    ctx.arc(b.x, b.y, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function render(bestUcci) {
    const rect = elMinimap.getBoundingClientRect();
    const W = rect.width;
    const H = rect.height;

    const isBlack = sideToMoveIsBlack();

    ctx.clearRect(0, 0, W, H);

    // For puzzles: when BLACK to move, flip the mini-map so it matches the player's viewpoint.
    ctx.save();
    if (isBlack) {
      ctx.translate(W, H);
      ctx.rotate(Math.PI);
    }
    drawGrid(W, H);
    drawPieces(W, H);
    drawHint(bestUcci, W, H);
    ctx.restore();

    const s = sideName();
    if (bestUcci && bestUcci.length >= 4) {
      // Label should match the flipped viewpoint too.
      const shown = isBlack ? flipUcci(bestUcci) : bestUcci;
      const txt = shown.slice(0, 2) + ' → ' + shown.slice(2, 4);
      elLabel.textContent = s ? (s + ': ' + txt) : txt;
    } else {
      elLabel.textContent = (s ? (s + ' đang phân tích…') : 'Đang phân tích…');
    }
  }

  // --- search helpers ---
  function timedSearch(depth, seconds) {
    try {
      if (typeof window.engine.resetTimeControl === 'function' &&
          typeof window.engine.getTimeControl === 'function' &&
          typeof window.engine.setTimeControl === 'function') {
        window.engine.resetTimeControl();
        const timing = window.engine.getTimeControl();
        const start = Date.now();
        timing.timeSet = 1;
        timing.time = Math.max(0.25, seconds) * 1000;
        timing.stopTime = start + timing.time;
        window.engine.setTimeControl(timing);
      }
    } catch (_) {}

    return window.engine.search(depth);
  }

  function moveToUcci(move) {
    const s = window.engine.squareToString(window.engine.getSourceSquare(move));
    const t = window.engine.squareToString(window.engine.getTargetSquare(move));
    return s + t;
  }

  function currentMoveCount() {
    try {
      const ms = window.engine.moveStack();
      return ms ? ms.length : 0;
    } catch (_) {
      return 0;
    }
  }

  let lastAnalyzeTs = 0;
  let lastMoveCount = -1;
  let pendingTimer = null;
  let lastBestUcci = '';

  function analyzeNow(reason) {
    // avoid too frequent analysis
    const now = Date.now();
    if (now - lastAnalyzeTs < MIN_INTERVAL_MS && reason !== 'force') return;
    lastAnalyzeTs = now;

    // policy: (legacy) optionally skip BLACK-to-move analysis.
    // For puzzles we keep this OFF so both sides get hints.
    if (COACH_ONLY_WHEN_RED_TO_MOVE) {
      try {
        if (window.engine.getSide && window.engine.COLOR && window.engine.getSide() === window.engine.COLOR.BLACK) {
          lastBestUcci = '';
          render('');
          return;
        }
      } catch (_) {}
    }

    elLabel.textContent = (sideName() ? (sideName() + ' đang phân tích…') : 'Đang phân tích…');

    const run = () => {
      let best = 0;
      try {
        best = timedSearch(SEARCH_DEPTH, SEARCH_TIME_SECONDS);
        if (!best) {
          const moves = window.engine.generateLegalMoves();
          best = (moves && moves.length) ? moves[0].move : 0;
        }
      } catch (e) {
        best = 0;
      }

      if (best) {
        lastBestUcci = moveToUcci(best);
        render(lastBestUcci);
      } else {
        lastBestUcci = '';
        render('');
      }
    };

    if (window.requestIdleCallback) {
      window.requestIdleCallback(run, { timeout: 250 });
    } else {
      setTimeout(run, 0);
    }
  }

  function scheduleAnalyze(reason) {
    const n = currentMoveCount();
    if (n === lastMoveCount && reason !== 'force') return;
    lastMoveCount = n;

    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }

    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastAnalyzeTs));
    pendingTimer = setTimeout(() => analyzeNow(reason), wait);
  }

  // --- hook lifecycle ---
  const originalUpdatePgn = window.updatePgn;
  if (typeof originalUpdatePgn === 'function') {
    window.updatePgn = function () {
      const r = originalUpdatePgn.apply(this, arguments);
      scheduleAnalyze('move');
      return r;
    };
  }

  const originalSetPuzzle = window.setPuzzle;
  if (typeof originalSetPuzzle === 'function') {
    window.setPuzzle = function () {
      const r = originalSetPuzzle.apply(this, arguments);
      scheduleAnalyze('force');
      return r;
    };
  }

  const originalUndo = window.undo;
  if (typeof originalUndo === 'function') {
    window.undo = function () {
      const r = originalUndo.apply(this, arguments);
      scheduleAnalyze('undo');
      return r;
    };
  }

  // initial paint
  resizeCanvas();
  render('');
  scheduleAnalyze('force');

  window.addEventListener('resize', () => {
    resizeCanvas();
    render(lastBestUcci || '');
  });
})();
