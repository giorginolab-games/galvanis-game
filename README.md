# Galvanis

A physics-driven falling-block game built with TypeScript, Vite, and Matter.js.

Shamelessly vibe-coded.

Tetrominoes fall into a continuous world with friction: they slide, tip and tumble. Two copper electrodes
line the playfield. When solid (conductive) blocks form a chain that touches both plates, current flows and
every block on the path burns away. Sparks can leap small air gaps (the air breaks down at ~3 kV/mm), but
hollow insulator blocks neither conduct nor let arcs through them.

Live page: [tonigi.github.io/galvanis-game](https://tonigi.github.io/galvanis-game/)

## How to play

| Key | Action |
| --- | --- |
| ← / → | push the falling block |
| ↑ | spin |
| ↓ | soft drop |
| Space | hard drop |
| Enter | high-voltage pulse: arcs much wider gaps and burns every path at once |
| P / Esc | pause |
| M | mute everything |

On touch devices an on-screen control bar appears below the playfield.

- **Score:** each burn is worth (cells burned × 25 + air gap bridged in mm × 4) × level × chain link, times
  the number of lines for a multi-path pulse. Each locked piece is worth a few points too.
- **Chains:** after a burn the stack collapses. If that closes a new circuit, it burns as the next chain link,
  and each link multiplies the score again.
- **Pulse charges:** you start with 1 (max 3). Every line you clear refills half a charge. The HUD shows
  **READY** when a pulse would hit something.
- **Levels:** every 5 lines. Each level makes blocks fall faster and lock sooner, adds more insulators, and
  lowers the always-on voltage so arcs reach less far.
- **Game over:** if a piece locks above the red overload line.

A first-run tutorial and one-time in-game hints explain everything above. Best score and sound settings are
kept in `localStorage`.

## Development

```bash
npm install
npm run dev
```

Open with `?debug` (or press <kbd>`</kbd> in game) for the developer panel: physics, voltage and difficulty
sliders, path overlays with air-gap labels, and manual spawn/scan buttons. In dev builds the game instance is
exposed as `window.__galvanis` (and Matter.js as `window.__matter`).

### Layout

| File | Purpose |
| --- | --- |
| `src/game/Game.ts` | game loop, state machine (title / playing / paused / over), scoring, rendering effects |
| `src/game/pathfinding.ts` | conduction path search with dielectric breakdown across air gaps |
| `src/game/params.ts` | tunable parameters and the per-level difficulty curve |
| `src/game/audio.ts` | procedural Web Audio sound effects and music (no audio assets) |
| `src/game/tutorial.ts` | tutorial slides with generated SVG art |
| `src/game/debug.ts` | developer panel bindings |
| `src/game/storage.ts` | best score, settings and tutorial/hint progress |

## Production build

```bash
npm run build
```

The site is deployed automatically from [`main`](https://github.com/tonigi/galvanis-game/tree/main) via GitHub Actions and GitHub Pages.
