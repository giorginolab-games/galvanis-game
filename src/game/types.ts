import type * as Matter from "matter-js";
import type { SHAPES } from "./constants";

export type TetrominoName = keyof typeof SHAPES;

export interface TetrominoPluginData {
  isTetromino: true;
  name: TetrominoName;
  frozen: boolean;
  isInsulating: boolean;
}

export type TetrominoBody = Matter.Body & {
  plugin: TetrominoPluginData;
};

export interface StageSize {
  width: number;
  height: number;
}

export interface BandBounds {
  leftX: number;
  rightX: number;
}

export interface PathNode {
  id: number;
  part: Matter.Body;
  parent: TetrominoBody;
  cx: number;
  cy: number;
  bounds: Matter.Bounds;
}

export interface AirArc {
  from: { x: number; y: number };
  to: { x: number; y: number };
  length: number;
}

/** A piece of the discharge route: along a conductor surface, or an arc across an air gap. */
export interface RouteSegment {
  points: Array<{ x: number; y: number }>;
  air: boolean;
}

/** One discharge path: the blocks it crosses, its air-gap arcs and its drawn route. */
export interface Bolt {
  pathNodes: PathNode[];
  arcs: AirArc[];
  route: RouteSegment[];
}

export interface FlashState {
  until: number;
  startedAt: number;
  leftX: number;
  rightX: number;
  bolts: Bolt[] | null;
  high: boolean;
  /** Link in the current chain reaction (1 = first burn of the turn). */
  chain: number;
}

export interface UiRefs {
  stage: HTMLDivElement;
  hint: HTMLElement;
  titleScreen: HTMLElement;
  tutorialScreen: HTMLElement;
  pauseOverlay: HTMLElement;
  gameOverOverlay: HTMLElement;
  score: HTMLElement;
  best: HTMLElement;
  titleBest: HTMLElement;
  level: HTMLElement;
  lines: HTMLElement;
  levelBar: HTMLElement;
  miniScore: HTMLElement;
  miniLevel: HTMLElement;
  miniPulse: HTMLElement;
  nextCanvas: HTMLCanvasElement;
  pulsePips: HTMLElement[];
  pulseReady: HTMLElement;
  finalScore: HTMLElement;
  finalLevel: HTMLElement;
  finalLines: HTMLElement;
  finalChain: HTMLElement;
  newBest: HTMLElement;
  playBtn: HTMLButtonElement;
  howBtn: HTMLButtonElement;
  resumeBtn: HTMLButtonElement;
  pauseHelpBtn: HTMLButtonElement;
  quitBtn: HTMLButtonElement;
  restartBtn: HTMLButtonElement;
  overTitleBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  helpBtn: HTMLButtonElement;
  sfxButtons: HTMLButtonElement[];
  musicButtons: HTMLButtonElement[];
  touchButtons: HTMLButtonElement[];
  tutorial: {
    step: HTMLElement;
    art: HTMLElement;
    title: HTMLElement;
    body: HTMLElement;
    dots: HTMLElement;
    prev: HTMLButtonElement;
    next: HTMLButtonElement;
    skip: HTMLButtonElement;
  };
}
