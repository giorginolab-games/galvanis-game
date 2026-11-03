import { PIECE_COLORS } from "./constants";

/** Illustrated how-to-play slides. Art is generated SVG in the game's own visual language. */

const W = 240;
const H = 140;
const S = 26; // block size in the illustrations
const LEFT = 16; // inner face of the left plate
const RIGHT = W - 16; // inner face of the right plate

type Pt = [number, number];

const defs = `
<defs>
  <linearGradient id="tPlate" x1="0" x2="1">
    <stop offset="0" stop-color="#b86a2e"/><stop offset="0.5" stop-color="#ffcf8a"/><stop offset="1" stop-color="#b86a2e"/>
  </linearGradient>
  <filter id="tGlow" x="-20%" y="-50%" width="140%" height="200%">
    <feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
</defs>`;

const plates = (): string =>
  `<rect x="${LEFT - 8}" y="0" width="8" height="${H}" rx="2" fill="url(#tPlate)"/>` +
  `<rect x="${RIGHT}" y="0" width="8" height="${H}" rx="2" fill="url(#tPlate)"/>`;

const block = (x: number, y: number, color: string, insulating = false, opacity = 1): string =>
  insulating
    ? `<rect x="${x + 2}" y="${y + 2}" width="${S - 4}" height="${S - 4}" rx="4" fill="none" stroke="${color}" stroke-width="3.5" opacity="${opacity}"/>`
    : `<rect x="${x + 0.5}" y="${y + 0.5}" width="${S - 1}" height="${S - 1}" rx="4" fill="${color}" opacity="${opacity}"/>`;

/** A row of blocks from the left plate; `gaps[i]` is extra space before block i, `insulators` are hollow indices. */
function row(y: number, count: number, gaps: Record<number, number> = {}, insulators: number[] = [], colorShift = 0): { svg: string; xs: number[] } {
  const colors = Object.values(PIECE_COLORS);
  let x = LEFT;
  let svg = "";
  const xs: number[] = [];

  for (let i = 0; i < count; i += 1) {
    x += gaps[i] ?? 0;
    xs.push(x);
    svg += block(x, y, colors[(i + colorShift) % colors.length], insulators.includes(i));
    x += S;
  }

  return { svg, xs };
}

const polyline = (points: Pt[]): string => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

function zigzag(from: Pt, to: Pt, cuts: number, amplitude: number, seed: number): Pt[] {
  const points: Pt[] = [from];
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const length = Math.hypot(dx, dy) || 1;

  for (let i = 1; i < cuts; i += 1) {
    const t = i / cuts;
    const wobble = Math.sin(seed + i * 2.7) * amplitude;
    points.push([from[0] + dx * t + (-dy / length) * wobble, from[1] + dy * t + (dx / length) * wobble]);
  }

  points.push(to);
  return points;
}

const bolt = (points: Pt[], air = false): string => {
  const color = air ? "#ff5cf0" : "#7ce9ff";
  const core = air ? "#ffd6fb" : "#ffffff";
  return (
    `<polyline points="${polyline(points)}" fill="none" stroke="${color}" stroke-width="6" stroke-linejoin="round" stroke-linecap="round" opacity="0.7" filter="url(#tGlow)"/>` +
    `<polyline points="${polyline(points)}" fill="none" stroke="${core}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`
  );
};

const cross = (x: number, y: number): string =>
  `<g stroke="#ff5a5a" stroke-width="4" stroke-linecap="round"><line x1="${x - 7}" y1="${y - 7}" x2="${x + 7}" y2="${y + 7}"/><line x1="${x + 7}" y1="${y - 7}" x2="${x - 7}" y2="${y + 7}"/></g>`;

const check = (x: number, y: number): string =>
  `<polyline points="${x - 7},${y} ${x - 2},${y + 6} ${x + 8},${y - 6}" fill="none" stroke="#5be38a" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;

const label = (x: number, y: number, text: string, color = "#cfd6ff"): string =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="10" font-weight="700" text-anchor="middle" font-family="Inter, Segoe UI, sans-serif" letter-spacing="0.06em">${text}</text>`;

const svg = (body: string): string => `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${defs}${body}${plates()}</svg>`;

/** A bolt running along the top surface of a row, arcing across each listed gap. */
function surfaceBolt(y: number, segments: Array<[number, number, boolean]>, seed = 1): string {
  return segments
    .map(([x1, x2, air], index) => bolt(zigzag([x1, y], [x2, y], air ? 3 : Math.max(2, Math.round((x2 - x1) / 18)), air ? 4 : 1.6, seed + index), air))
    .join("");
}

function controlsArt(): string {
  const cx = W / 2;
  const t = `${block(cx - S * 1.5, 26, PIECE_COLORS.T)}${block(cx - S * 0.5, 26, PIECE_COLORS.T)}${block(cx + S * 0.5, 26, PIECE_COLORS.T)}${block(cx - S * 0.5, 26 + S, PIECE_COLORS.T)}`;
  const arrows =
    `<g fill="#9fb4ff" opacity="0.85">` +
    `<path d="M${cx - 62} 40 l12 -8 v16 z"/><path d="M${cx + 62} 40 l-12 -8 v16 z"/>` +
    `<path d="M${cx - 6} 86 h12 l-6 10 z"/></g>` +
    `<path d="M${cx + 30} 14 a14 14 0 1 1 -10 -4" fill="none" stroke="#9fb4ff" stroke-width="2.5" opacity="0.85"/>` +
    `<path d="M${cx + 17} 6 l6 4 -6 4 z" fill="#9fb4ff"/>`;
  const stack = row(H - S, 3).svg + row(H - S, 3, { 0: S * 5 }, [], 3).svg;
  return svg(t + arrows + stack);
}

function bridgeArt(): string {
  const y = 90;
  const r = row(y, 8);
  const end = r.xs[7] + S;
  return svg(
    r.svg +
      `<rect x="${LEFT}" y="${y}" width="${end - LEFT}" height="${S}" rx="4" fill="#fff6a0" opacity="0.25"/>` +
      surfaceBolt(y + 1, [[LEFT, RIGHT, false]], 2) +
      label(W / 2, 40, "TOUCH BOTH PLATES") +
      label(W / 2, 56, "→ THE PATH BURNS AWAY", "#7ce9ff"),
  );
}

function gapArt(): string {
  const yTop = 34;
  const yBottom = 96;
  const small = row(yBottom, 8, { 4: 5 }, [], 1);
  const big = row(yTop, 7, { 4: 26 }, [], 4);
  const gapStart = small.xs[3] + S;
  const gapEnd = small.xs[4];
  const bigStart = big.xs[3] + S;
  const bigEnd = big.xs[4];
  return svg(
    big.svg +
      small.svg +
      surfaceBolt(yBottom + 1, [
        [LEFT, gapStart, false],
        [gapStart, gapEnd, true],
        [gapEnd, RIGHT, false],
      ]) +
      cross((bigStart + bigEnd) / 2, yTop + S / 2) +
      check((gapStart + gapEnd) / 2, yBottom - 14) +
      label((bigStart + bigEnd) / 2, yTop - 6, "TOO WIDE", "#ff8f8f") +
      label((gapStart + gapEnd) / 2, yBottom + S + 12, "SMALL GAP: ARCS", "#ff9cf3"),
  );
}

function insulatorArt(): string {
  const y = 90;
  const r = row(y, 8, {}, [4], 2);
  const stop = r.xs[4];
  return svg(
    r.svg +
      surfaceBolt(y + 1, [[LEFT, stop, false]], 4) +
      cross(stop + S / 2, y + S / 2) +
      label(stop + S / 2, y - 12, "HOLLOW = INSULATOR", "#ffb38a") +
      label(W / 2, 40, "NO CURRENT, NO ARCS THROUGH"),
  );
}

function pulseArt(): string {
  const rows: Array<{ y: number; gaps: Record<number, number>; shift: number }> = [
    { y: 26, gaps: { 3: 14 }, shift: 0 },
    { y: 60, gaps: { 5: 10 }, shift: 3 },
    { y: 94, gaps: { 2: 16 }, shift: 5 },
  ];
  let body = "";

  rows.forEach(({ y, gaps, shift }, index) => {
    const r = row(y, 7, gaps, [], shift);
    const gapIndex = Number(Object.keys(gaps)[0]);
    const a = r.xs[gapIndex - 1] + S;
    const b = r.xs[gapIndex];
    const end = r.xs[6] + S;
    body +=
      r.svg +
      surfaceBolt(
        y + 1,
        [
          [LEFT, a, false],
          [a, b, true],
          [b, end, false],
          ...(end < RIGHT - 0.5 ? ([[end, RIGHT, true]] as Array<[number, number, boolean]>) : []),
        ],
        index * 3,
      );
  });

  return svg(body + label(W / 2, H - 4, "ENTER: ALL PATHS AT ONCE", "#ff9cf3"));
}

function scoreArt(): string {
  const dangerY = 18;
  const upper = row(44, 6, { 0: S }, [], 1);
  const burnt = `<rect x="${LEFT}" y="76" width="${RIGHT - LEFT}" height="${S}" rx="4" fill="#fff6a0" opacity="0.35"/>` + surfaceBolt(77, [[LEFT, RIGHT, false]], 6);
  const lower = row(H - S, 8, { 6: 4 }, [2], 4);
  const fall =
    `<g fill="#9fb4ff" opacity="0.8">` +
    [60, 120, 180].map((x) => `<path d="M${x - 5} 72 h10 l-5 7 z"/>`).join("") +
    `</g>`;
  return svg(
    `<line x1="${LEFT}" x2="${RIGHT}" y1="${dangerY}" y2="${dangerY}" stroke="#ff5a5a" stroke-width="2" stroke-dasharray="6 5"/>` +
      label(W / 2, dangerY - 5, "DANGER LINE", "#ff8f8f") +
      upper.svg +
      burnt +
      fall +
      lower.svg,
  );
}

export interface TutorialSlide {
  title: string;
  body: string;
  art: string;
}

export const TUTORIAL_SLIDES: TutorialSlide[] = [
  {
    title: "Steer the falling block",
    body: `<p>Blocks are real physical objects: they slide, tip and tumble.</p>
      <p><span class="kbd">←</span><span class="kbd">→</span> push &nbsp; <span class="kbd">↑</span> spin &nbsp; <span class="kbd">↓</span> soft drop &nbsp; <span class="kbd">Space</span> slam down</p>`,
    art: controlsArt(),
  },
  {
    title: "Bridge the electrodes",
    body: `<p>The two copper plates are live. When solid blocks form a chain touching <em>both</em> plates, current flows and every block on the path <strong>burns away</strong>.</p>`,
    art: bridgeArt(),
  },
  {
    title: "Sparks jump small gaps",
    body: `<p>Current can arc across thin air gaps, shown in <span class="hl-magenta">magenta</span>. All gaps on a path add up: about half a block in total at level 1, less at higher levels. Leaping gaps scores a bonus.</p>`,
    art: gapArt(),
  },
  {
    title: "Mind the insulators",
    body: `<p><span class="hl-orange">Hollow</span> blocks don't conduct, and arcs can't pass through them. You can still stack on them, or route the current around them.</p>`,
    art: insulatorArt(),
  },
  {
    title: "High-voltage pulse",
    body: `<p>Press <span class="kbd">Enter</span> to fire a pulse that arcs across much larger gaps and burns <strong>every</strong> path at once, scoring a multiplier for each. You have a few charges; every line you clear refills half of one. The HUD shows <span class="hl-green">READY</span> when a pulse would hit something.</p>`,
    art: pulseArt(),
  },
  {
    title: "Chain it, don't top out",
    body: `<p>When blocks collapse into a new circuit, it burns as a <strong>chain</strong>, and each link multiplies your score. Every 5 lines the level goes up: blocks fall faster, lock sooner, and insulators show up more often. If the stack reaches the red line, the system overloads.</p>`,
    art: scoreArt(),
  },
];
