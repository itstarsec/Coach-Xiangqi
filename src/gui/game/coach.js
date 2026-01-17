/*
  Realtime Coach (Browser-only)
  - No npm, no node.
  - Uses the same in-page Wukong engine instance already created in xiangqi.js.
  - Watches moves via updatePgn()/drawBoard() hook and suggests the best move for the side to move.
  - Renders a "mini-map" panel (LoL-ish) with from/to highlights and an arrow.

  Notes:
  - This file intentionally does NOT modify engine state except calling engine.search(depth),
    which is exactly how the original GUI computes bot moves.
*/

(function () {
  'use strict';

  // Performance-first coaching policy:
  // - In this GUI, the player is typically RED.
  // - Engine search is synchronous (blocks the main thread), so we avoid doing
  //   extra work when it's BLACK to move to keep the UI smooth.
  const COACH_ONLY_WHEN_RED_TO_MOVE = true;

  // Use the same bot profile as the in-game "Liudahua" (book + time control).
  // In the original GUI, Liudahua uses opening book and time=5s.
  const COACH_BOT_NAME = 'Liudahua';
  // Keep searches short to minimize stutter on weaker CPUs.
  const COACH_TIME_SECONDS = 0.12;   // ~120ms budget
  const COACH_DEPTH_FALLBACK = 18;   // when time isn't available

  // Required globals (created by src/gui/game/xiangqi.js)
  if (typeof window.engine === 'undefined') {
    console.warn('[Coach] engine not found. coach disabled.');
    return;
  }

  // ---- UI refs (mini-map only) ----
  const elMinimap = document.getElementById('coach-minimap');
  const elCanvas = document.getElementById('coach-canvas');
  const elMoveLabel = document.getElementById('coach-move-label');

  if (!elMinimap || !elCanvas || !elMoveLabel) {
    console.warn('[Coach] UI not found. coach disabled.');
    return;
  }

  // Single canvas render (much smoother than creating/removing many DOM nodes)
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

  // ---- helpers ----
  const PIECE_TO_CHAR = ['.', 'P', 'A', 'B', 'N', 'C', 'R', 'K', 'p', 'a', 'b', 'n', 'c', 'r', 'k'];
  const PIECE_NAME_VI = {
    P: 'Tốt', A: 'Sĩ', B: 'Tượng', N: 'Mã', C: 'Pháo', R: 'Xe', K: 'Tướng',
    p: 'Tốt', a: 'Sĩ', b: 'Tượng', n: 'Mã', c: 'Pháo', r: 'Xe', k: 'Tướng'
  };

  function sideName(side) {
    // 0 = RED, 1 = BLACK in this engine
    return side ? 'Đen' : 'Đỏ';
  }

  function ucciFromMove(move) {
    const s = window.engine.squareToString(window.engine.getSourceSquare(move));
    const t = window.engine.squareToString(window.engine.getTargetSquare(move));
    return (s + t);
  }

  function fileToIndex(ch) {
    return ch.charCodeAt(0) - 'a'.charCodeAt(0);
  }

  function ucciToFenRow(ucci) {
    // UCCI ranks: 0 (Red side bottom) .. 9 (Black side top)
    // FEN rows:   0 (top) .. 9 (bottom)
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

  // Build coordinate->square map once (engine uses 11x14 mailbox internally)
  const coordToSquare = (function buildMap() {
    const map = Object.create(null);
    for (let sq = 0; sq < 11 * 14; sq++) {
      const c = window.engine.squareToString(sq);
      if (c && c !== 'xx') map[c] = sq;
    }
    return map;
  })();

  function getPieceCharAtCoord(coord) {
    const sq = coordToSquare[coord];
    if (typeof sq === 'undefined') return '.';
    const piece = window.engine.getPiece(sq);
    return PIECE_TO_CHAR[piece] || '.';
  }

  function getPieceCharAtSquare(square) {
    const piece = window.engine.getPiece(square);
    return PIECE_TO_CHAR[piece] || '.';
  }

  function clamp(n, a, b) {
    return Math.max(a, Math.min(b, n));
  }

  // ---- coach engine helpers (book + time control like built-in bots) ----
  function getCoachBookLines() {
    try {
      if (window.bots && window.bots[COACH_BOT_NAME] && Array.isArray(window.bots[COACH_BOT_NAME].book)) {
        return window.bots[COACH_BOT_NAME].book;
      }
    } catch (_) {}
    return [];
  }

  function getCoachBookMove() {
    // Deterministic (pick first matching line) to avoid "random" blunders.
    const bookLines = getCoachBookLines();
    if (!bookLines.length) return 0;

    const moves = (typeof window.engine.getMoves === 'function') ? window.engine.getMoves() : [];
    if (!moves || !moves.length) {
      const firstLine = bookLines[0];
      const firstMove = String(firstLine).trim().split(/\s+/)[0];
      return window.engine.moveFromString(firstMove);
    }

    const currentLine = moves.join(' ');
    for (let i = 0; i < bookLines.length; i++) {
      const line = bookLines[i];
      if (line.includes(currentLine) && line.split(currentLine)[0] === '') {
        try {
          const next = line.split(currentLine)[1].trim().split(/\s+/)[0];
          return window.engine.moveFromString(next);
        } catch (_) {
          return 0;
        }
      }
    }
    return 0;
  }

  function timedSearch(depth, seconds) {
    // Mirrors xiangqi.js think(): reset TC, set fixed time, then search with depth=64.
    try {
      if (typeof window.engine.resetTimeControl === 'function' && typeof window.engine.getTimeControl === 'function' && typeof window.engine.setTimeControl === 'function') {
        window.engine.resetTimeControl();
        const timing = window.engine.getTimeControl();
        const startTime = Date.now();
        timing.timeSet = 1;
        timing.time = Math.max(0.25, seconds) * 1000;
        timing.stopTime = startTime + timing.time;
        window.engine.setTimeControl(timing);
      }
    } catch (_) {}
    return window.engine.search(depth);
  }

  function pickBestMoveStrong(depthUi) {
    // 1) opening book (Liudahua) if available
    let m = getCoachBookMove();
    if (m && m !== 0) return m;

    // 2) time-based search (strongest in this GUI)
    const depth = COACH_DEPTH_FALLBACK;
    m = timedSearch(depth, COACH_TIME_SECONDS);
    if (m && m !== 0) return m;

    // 3) fallback depth from UI (in case TC isn't available)
    m = window.engine.search(depthUi);
    if (m && m !== 0) return m;

    // 4) last resort: first legal move
    const moves = window.engine.generateLegalMoves();
    return (moves && moves.length) ? moves[0].move : 0;
  }

  // ---- minimap drawing (canvas) ----
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
    // vertical (9 files)
    for (let i = 1; i < 9; i++) {
      const x = i * W / 9;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    // horizontal (10 ranks)
    for (let j = 1; j < 10; j++) {
      const y = j * H / 10;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPiecesCanvas(W, H) {
    // FEN-like traversal: top row (rank 9) -> bottom (rank 0)
    const r = Math.max(2.5, Math.min(6, Math.min(W / 60, H / 60)));
    for (let rank = 9; rank >= 0; rank--) {
      const row = 9 - rank; // 0..9 top->bottom
      for (let file = 0; file < 9; file++) {
        const coord = String.fromCharCode('a'.charCodeAt(0) + file) + String(rank);
        const pch = getPieceCharAtCoord(coord);
        if (pch === '.') continue;
        const pos = cellToXY(file, row, W, H);
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
        ctx.fillStyle = (pch === pch.toUpperCase()) ? '#ff4d4d' : 'rgba(230,238,247,0.85)';
        ctx.fill();
      }
    }
  }

  function drawHintCanvas(ucci, W, H) {
    if (!ucci || ucci.length < 4) return;
    const c = ucciToFenRow(ucci);
    const a = cellToXY(c.fromFile, c.fromRow, W, H);
    const b = cellToXY(c.toFile, c.toRow, W, H);

    // arrow
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
    ctx.fillStyle = 'rgba(255,208,0,0.9)';
    ctx.beginPath();
    ctx.moveTo(b.x, b.y);
    ctx.lineTo(b.x - headLen * Math.cos(ang - Math.PI / 6), b.y - headLen * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(b.x - headLen * Math.cos(ang + Math.PI / 6), b.y - headLen * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // from/to rings
    const ringR = Math.max(6, Math.min(12, Math.min(W / 30, H / 30)));
    ctx.save();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = '#00d4ff';
    ctx.beginPath();
    ctx.arc(a.x, a.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#ffd000';
    ctx.beginPath();
    ctx.arc(b.x, b.y, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  // ---- coaching loop ----
  // Auto-enabled: no clicks needed.
  let enabled = true;
  let busy = false;
  let lastMoveCount = -1;
  let lastBestMoveUcci = '';
  let lastPv = '';
  let lastAnalyzeTs = 0;

  // Tunables for "fast glance" coaching (keep searches short to avoid stutter)
  const COACH_DEPTH_UI = 10;
  const MIN_INTERVAL_MS = 350;   // don't analyze too frequently

  function currentMoveCount() {
    try {
      return window.engine.moveStack().length;
    } catch (_) {
      return 0;
    }
  }

  function render(payload) {
    // Draw on the next frame (prevents layout thrash)
    requestAnimationFrame(() => {
      resizeCanvas();
      const W = elMinimap.clientWidth;
      const H = elMinimap.clientHeight;
      ctx.clearRect(0, 0, W, H);
      drawGrid(W, H);
      drawPiecesCanvas(W, H);
      drawHintCanvas(payload.bestmoveUcci, W, H);
    });

    // Keep text minimal: only show the move (for quick execution).
    elMoveLabel.textContent = payload.bestmoveUcci
      ? payload.bestmoveUcci.slice(0, 2) + ' → ' + payload.bestmoveUcci.slice(2, 4)
      : '…';
  }

  function analyzeNow(reason) {
    if (!enabled) return;
    if (busy) return;

    busy = true;
    lastAnalyzeTs = Date.now();

    const run = () => {
      try {
        const depthUi = COACH_DEPTH_UI;

        const side = window.engine.getSide(); // 0=RED,1=BLACK

        // Smoothness: only compute when it's RED to move (most common training flow).
        if (COACH_ONLY_WHEN_RED_TO_MOVE && side === window.engine.COLOR.BLACK) {
          render({ bestmoveUcci: '' });
          return;
        }

        const bestMove = pickBestMoveStrong(depthUi);

        const bestUcci = bestMove ? ucciFromMove(bestMove) : '';
        lastBestMoveUcci = bestUcci;

        // Score/pv are published to globals by the engine during search
        const scoreRaw = (typeof window.guiScore !== 'undefined') ? window.guiScore : null;
        const depthRaw = (typeof window.guiDepth !== 'undefined') ? window.guiDepth : null;
        const pvRaw = (typeof window.guiPv !== 'undefined') ? window.guiPv : '';
        lastPv = pvRaw || '';

        // Determine piece name at source
        let pieceName = '';
        let pieceChar = '.';
        if (bestMove) {
          const srcSq = window.engine.getSourceSquare(bestMove);
          pieceChar = getPieceCharAtSquare(srcSq);
          pieceName = PIECE_NAME_VI[pieceChar] || 'Quân';
        }

        const scoreText = (scoreRaw === null || scoreRaw === undefined)
          ? '?'
          : (typeof scoreRaw === 'string' ? scoreRaw : (scoreRaw / 100).toFixed(2));

        const sideToCoach = window.engine.COLOR.RED;

        render({ bestmoveUcci: bestUcci, pv: pvRaw });
      } catch (e) {
        // Don't spam the UI; just show placeholder.
        elMoveLabel.textContent = '…';
      } finally {
        busy = false;
      }
    };

    // Prefer idle time when available (reduces perceived lag while dragging pieces)
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 250 });
    } else {
      setTimeout(run, 0);
    }
  }

  let pendingTimer = null;
  function scheduleAnalyze(reason) {
    const n = currentMoveCount();
    if (n === lastMoveCount && reason !== 'force') return;
    lastMoveCount = n;

    // Debounce + rate limit (prevents back-to-back searches during fast UI updates)
    const now = Date.now();
    const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastAnalyzeTs));

    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }

    if (wait > 0) {
      pendingTimer = setTimeout(() => analyzeNow(reason), wait);
      return;
    }

    analyzeNow(reason);
  }

  // ---- hook existing GUI lifecycle ----
  // We hook updatePgn() because it's called after both user moves and bot moves.
  // This avoids depending on DOM structure.
  const originalUpdatePgn = window.updatePgn;
  if (typeof originalUpdatePgn === 'function') {
    window.updatePgn = function () {
      const r = originalUpdatePgn.apply(this, arguments);
      scheduleAnalyze('move');
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

  const originalNewGame = window.newGame;
  if (typeof originalNewGame === 'function') {
    window.newGame = function () {
      const r = originalNewGame.apply(this, arguments);
      scheduleAnalyze('new');
      return r;
    };
  }

  // ---- UI events ----
  // No click events: this is a "glanceable" overlay.

  // Initial paint (no hint yet)
  resizeCanvas();
  render({ bestmoveUcci: '' });

  // Kickstart analysis ASAP.
  scheduleAnalyze('init');

  // Keep canvas crisp on resize/orientation changes
  window.addEventListener('resize', () => {
    resizeCanvas();
    render({ bestmoveUcci: lastBestMoveUcci || '' });
  });
})();
