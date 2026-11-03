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
}

export interface RangeControl {
  input: HTMLInputElement;
  value: HTMLElement;
}

export interface ToggleControl {
  input: HTMLInputElement;
}

export interface UiRefs {
  stage: HTMLDivElement;
  gameOverOverlay: HTMLDivElement;
  pieceCount: HTMLElement;
  activeName: HTMLElement;
  gameState: HTMLElement;
  resetBtn: HTMLButtonElement;
  pauseBtn: HTMLButtonElement;
  spawnBtn: HTMLButtonElement;
  scanBtn: HTMLButtonElement;
  pulseCount: HTMLElement;
  pulseBar: HTMLElement;
  gravityY: RangeControl;
  friction: RangeControl;
  rest: RangeControl;
  blockSize: RangeControl;
  lockDelay: RangeControl;
  insulatingChance: RangeControl;
  bandX: RangeControl;
  voltage: RangeControl;
  highVoltage: RangeControl;
  sleeping: ToggleControl;
  freezeBlocks: ToggleControl;
  showBand: ToggleControl;
  eraseOnPath: ToggleControl;
}
