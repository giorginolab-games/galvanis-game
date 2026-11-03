export const SPAWN_Y = 100;
export const SETTLE_CONFIRM_MS = 250;
export const FLASH_DURATION_MS = 900;
export const FLASH_TIMEOUT_BUFFER_MS = 20;
export const WALL_THICKNESS = 60;
export const BAND_WALL_THICKNESS = 12;
export const BAND_EPSILON = 2;
export const CONTACT_EPSILON = 1;
// Cost multiplier for the empty gap between a band wall and the first/last block, so paths prefer blocks touching the wall.
export const VOID_PENALTY = 10;

export const SHAPES = {
  I: [
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
  ],
  O: [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  T: [
    [0, 0],
    [1, 0],
    [2, 0],
    [1, 1],
  ],
  S: [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  Z: [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  J: [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  L: [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
} as const;

export const PIECE_COLORS = {
  I: "#32d5ff",
  O: "#ffd84a",
  T: "#a77dff",
  S: "#48e07a",
  Z: "#ff6e6e",
  J: "#4a8bff",
  L: "#ff9b41",
} as const;

export const TETROMINO_NAMES = Object.keys(SHAPES) as Array<keyof typeof SHAPES>;
