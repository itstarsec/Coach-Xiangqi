/*
  Realtime Coach (Browser-only) - ULTRA STRENGTH (Main thread)
  - No npm, no node.
  - Uses the same in-page Wukong engine instance already created in xiangqi.js.
  - Watches moves via updatePgn()/drawBoard() hook and suggests the best move for the side to move.
  - Renders a "mini-map" panel with from/to highlights and an arrow.

  ULTRA strength changes:
  - Analyze for BOTH sides depending on side-to-move.
  - Time-control search with large time budget (default 10s).
  - High max depth to allow deeper iterative deepening.
  - Strong anti-jank: analyzes only when position changed, cooldown, debounce, idle callback.
*/

(function () {
  'use strict';

  // =========================
  // ULTRA STRENGTH CONFIG
  // =========================

  // Analyze for BOTH sides (Puzzle / real play)
  const COACH_ONLY_WHEN_RED_TO_MOVE = false;

  // Optional opening book profile (if present). Helps avoid early blunders.
  const COACH_BOT_NAME = 'Liudahua';

  // Stronger-than-level-7: 8–12 seconds typically beats “level 7” style in many UIs.
  // Increase to 12–15 if your CPU is strong and you can tolerate longer freezes.
  const COACH_TIME_SECONDS = 10.0;

  // Give engine room to iterate deep while still stopping by time-control.
  // 64 is common; 96/128 can be stronger if engine respects time-stop well.
  const COACH_DEPTH_TIMED = 128;

  // Fallback if TC APIs are missing
  const COACH_DEPTH_UI = 22;

  // With 10s searches, do NOT analyze too frequently.
  // Cooldown prevents repeated long freezes caused by multiple UI triggers.
  const MIN_INTERVAL_MS = 1800;  // minimum time between analyses
  const DEBOUNCE_MS = 250;       // merge rapid triggers

  // Prefer idle callback to reduce perceived lag while dragging
  const USE_IDLE_CALLBACK = true;
  const IDLE_TIMEOUT_MS = 700;

  // =========================
  // Required globals
  // =========================
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

  // Canvas (single render surface)
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

  function ucciFromMove(move) {
    const s = window.engine.squareToString(window.engine.getSourceSquare(move));
    const t = window.engine.squareToString(window.engine.getTargetSquare(move));
    return (s + t);
  }

  function fileToIndex(ch) {
    return ch.charCodeAt(0) - 'a'.charCodeAt(0);
  }

  function ucciToFenRow(ucci) {
    // UCCI ranks: 0 (Red bottom) .. 9 (Black top)
    // Canvas rows: 0 top .. 9 bottom
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

  // Build coordinate->square map once (engine uses 11x14 mailbox)
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

  // Position fingerprint to prevent redundant heavy search
  function getPositionKey() {
    // Best effort: use fen() if exists, else use move stack as a weaker proxy.
    try {
      if (typeof window.engine.fen === 'function') return window.engine.fen();
    } catch (_) {}

    try {
      if (typeof window.engine.getFen === 'function') return window.engine.getFen();
    } catch (_) {}

    try {
      // moveStack tends to change per position
      return 'ms:' + window.engine.moveStack().length + ':' + (window.engine.getSide ? window.engine.getSide() : '?');
    } catch (_) {}

    return String(Date.now());
  }

  // ---- book + time control ----
  function getCoachBookLines() {
    try {
      if (window.bots && window.bots[COACH_BOT_NAME] && Array.isArray(window.bots[COACH_BOT_NAME].book)) {
        return window.bots[COACH_BOT_NAME].book;
      }
    } catch (_) {}
    return [];
  }

  function getCoachBookMove() {
    // Deterministic first matching line
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

  function setTimeControl(seconds) {
    try {
      if (
        typeof window.engine.resetTimeControl === 'function' &&
        typeof window.engine.getTimeControl === 'function' &&
        typeof window.engine.setTimeControl === 'function'
      ) {
        window.engine.resetTimeControl();
        const timing = window.engine.getTimeControl();
        const startTime = Date.now();
        timing.timeSet = 1;
        timing.time = Math.max(0.25, seconds) * 1000;
        timing.stopTime = startTime + timing.time;
        window.engine.setTimeControl(timing);
        return true;
      }
    } catch (_) {}
    return false;
  }

  function timedSearch(depth, seconds) {
    // Force time-control then search; engine should stop on stopTime
    setTimeControl(seconds);
    return window.engine.search(depth);
  }

  function pickBestMoveUltra() {
    // 1) Opening book (if any)
    let m = getCoachBookMove();
    if (m && m !== 0) return m;

    // 2) Strong timed search
    m = timedSearch(COACH_DEPTH_TIMED, COACH_TIME_SECONDS);
    if (m && m !== 0) return m;

    // 3) Fallback deep-ish fixed depth
    m = window.engine.search(COACH_DEPTH_UI);
    if (m && m !== 0) return m;

    // 4) Last resort
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
    for (let i = 1; i < 9; i++) {
      const x = i * W / 9;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
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
    const r = Math.max(2.5, Math.min(6, Math.min(W / 60, H / 60)));
    for (let rank = 9; rank >= 0; rank--) {
      const row = 9 - rank;
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

    // Arrow
    ctx.save();
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(255,208,0,0.85)';
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    // Arrow head
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

    // From/to rings
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
  let enabled = true;
  let busy = false;

  let lastAnalyzeTs = 0;
  let pendingTimer = null;

  let lastBestMoveUcci = '';
  let lastPositionKey = '';

  function render(bestmoveUcci) {
    requestAnimationFrame(() => {
      resizeCanvas();
      const W = elMinimap.clientWidth;
      const H = elMinimap.clientHeight;
      ctx.clearRect(0, 0, W, H);
      drawGrid(W, H);
      drawPiecesCanvas(W, H);
      drawHintCanvas(bestmoveUcci, W, H);
    });

    elMoveLabel.textContent = bestmoveUcci
      ? bestmoveUcci.slice(0, 2) + ' → ' + bestmoveUcci.slice(2, 4)
      : '…';
  }

  function analyzeNow(reason) {
    if (!enabled || busy) return;

    // Position-change guard
    const key = getPositionKey();
    if (key && key === lastPositionKey && reason !== 'force') {
      // nothing changed, avoid expensive re-search
      render(lastBestMoveUcci || '');
      return;
    }

    const now = Date.now();
    if (now - lastAnalyzeTs < MIN_INTERVAL_MS && reason !== 'force') {
      // too soon; keep last hint
      render(lastBestMoveUcci || '');
      return;
    }

    busy = true;
    lastAnalyzeTs = now;
    lastPositionKey = key;

    const run = () => {
      try {
        const side = window.engine.getSide ? window.engine.getSide() : 0; // 0=RED, 1=BLACK

        if (COACH_ONLY_WHEN_RED_TO_MOVE && side === window.engine.COLOR.BLACK) {
          render('');
          return;
        }

        const bestMove = pickBestMoveUltra();
        const bestUcci = bestMove ? ucciFromMove(bestMove) : '';
        lastBestMoveUcci = bestUcci;

        render(bestUcci);
      } catch (e) {
        elMoveLabel.textContent = '…';
      } finally {
        busy = false;
      }
    };

    if (USE_IDLE_CALLBACK && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    } else {
      setTimeout(run, 0);
    }
  }

  function scheduleAnalyze(reason) {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingTimer = setTimeout(() => analyzeNow(reason), DEBOUNCE_MS);
  }

  // ---- hook existing GUI lifecycle ----
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

  // Initial paint + kickstart
  resizeCanvas();
  render('');
  scheduleAnalyze('init');

  window.addEventListener('resize', () => {
    resizeCanvas();
    render(lastBestMoveUcci || '');
  });
})();