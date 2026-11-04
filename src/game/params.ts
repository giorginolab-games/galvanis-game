/** Every tunable the simulation reads. The difficulty curve writes some of these; the debug panel can edit all. */
export interface Params {
  gravityY: number;
  friction: number;
  restitution: number;
  blockSize: number;
  lockDelay: number;
  /** Probability (0..1) that a spawned piece is an insulator. */
  insulatingChance: number;
  bandHalfWidth: number;
  /** Low (always-on) voltage, kV. */
  voltage: number;
  /** High-voltage pulse, kV. */
  highVoltage: number;
  sleeping: boolean;
  freezeBlocks: boolean;
  debugOverlay: boolean;
  eraseOnPath: boolean;
  autoDifficulty: boolean;
}

export type NumericParam = { [K in keyof Params]: Params[K] extends number ? K : never }[keyof Params];
export type BooleanParam = { [K in keyof Params]: Params[K] extends boolean ? K : never }[keyof Params];

export const DEFAULT_PARAMS: Params = {
  gravityY: 0.6,
  friction: 0.08,
  restitution: 0.05,
  blockSize: 30,
  lockDelay: 600,
  insulatingChance: 0.12,
  bandHalfWidth: 200,
  voltage: 54,
  highVoltage: 150,
  sleeping: true,
  freezeBlocks: false,
  debugOverlay: false,
  eraseOnPath: true,
  autoDifficulty: true,
};

/** Parameters driven by the level: faster falls, shorter lock delay, more insulators, weaker low-voltage arcs. */
export const DIFFICULTY_KEYS = ["gravityY", "lockDelay", "insulatingChance", "voltage"] as const satisfies readonly NumericParam[];

export function difficultyFor(level: number): Pick<Params, (typeof DIFFICULTY_KEYS)[number]> {
  const step = Math.max(0, level - 1);

  return {
    gravityY: Math.min(1.8, 0.6 + 0.09 * step),
    lockDelay: Math.max(220, 600 - 30 * step),
    insulatingChance: Math.min(0.45, 0.12 + 0.025 * step),
    voltage: Math.max(27, 54 - 3 * step),
  };
}
