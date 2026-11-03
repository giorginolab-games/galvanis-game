# galvanis

Physics-driven falling-block prototype built with TypeScript, Vite, and Matter.js.

Shamelessly vibe-coded.

You place falling tetrominoes in a continuous world with friction. Conductive pieces can form
a path between the two inner band walls; when that happens, the path flashes and the touched
pieces burn away. Press Enter for a limited high-voltage pulse that burns several paths at once; cleared lines recharge it.

Live page: [tonigi.github.io/galvanis-game](https://tonigi.github.io/galvanis-game/)

## Development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

The site is deployed automatically from [`main`](https://github.com/tonigi/galvanis-game/tree/main) via GitHub Actions and GitHub Pages.
