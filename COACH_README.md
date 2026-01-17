# Realtime Coach (Browser-only)

This repo has been extended with a **Realtime Move Coach** panel (mini-map style) inside:

`src/gui/xiangqi.html`

It runs **fully in the browser** using the bundled Wukong engine (`src/engine/wukong.js`).

## How to run (Windows)

1. Make sure you have **Python 3** installed.
2. Double-click: `RUN_COACH_WINDOWS.bat`
3. Open:

`http://127.0.0.1:8000/src/gui/xiangqi.html`

## Use the coach

On the right side, click **Enable**.

After every move, the coach will automatically analyze and show:

- **Best move** for the side to move
- Highlighted **from/to** squares + arrow on the mini-map
- Current **eval** and **PV** (if available)

You can adjust **Depth** (higher = stronger, but slower).

## Implementation

- UI added directly in `src/gui/xiangqi.html`
- Logic in: `src/gui/game/coach.js`
