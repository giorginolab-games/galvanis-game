import type { UiRefs } from "./types";

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}`);
  }

  return element as T;
}

function rangeControl(inputId: string, valueId: string) {
  return {
    input: requiredElement<HTMLInputElement>(inputId),
    value: requiredElement<HTMLElement>(valueId),
  };
}

function toggleControl(inputId: string) {
  return {
    input: requiredElement<HTMLInputElement>(inputId),
  };
}

export function getUiRefs(): UiRefs {
  return {
    stage: requiredElement<HTMLDivElement>("stage"),
    gameOverOverlay: requiredElement<HTMLDivElement>("gameOverOverlay"),
    pieceCount: requiredElement("pieceCount"),
    activeName: requiredElement("activeName"),
    gameState: requiredElement("gameState"),
    resetBtn: requiredElement<HTMLButtonElement>("resetBtn"),
    pauseBtn: requiredElement<HTMLButtonElement>("pauseBtn"),
    spawnBtn: requiredElement<HTMLButtonElement>("spawnBtn"),
    scanBtn: requiredElement<HTMLButtonElement>("scanBtn"),
    gravityY: rangeControl("gravityY", "gravityYVal"),
    friction: rangeControl("friction", "frictionVal"),
    rest: rangeControl("rest", "restVal"),
    blockSize: rangeControl("blockSize", "blockSizeVal"),
    lockDelay: rangeControl("lockDelay", "lockDelayVal"),
    insulatingChance: rangeControl("insulatingChance", "insulatingChanceVal"),
    bandX: rangeControl("bandX", "bandXVal"),
    voltage: rangeControl("voltage", "voltageVal"),
    sleeping: toggleControl("sleeping"),
    freezeBlocks: toggleControl("freezeBlocks"),
    showBand: toggleControl("showBand"),
    eraseOnPath: toggleControl("eraseOnPath"),
  };
}

export function syncLabels(ui: UiRefs): void {
  ui.gravityY.value.textContent = Number(ui.gravityY.input.value).toFixed(2);
  ui.friction.value.textContent = Number(ui.friction.input.value).toFixed(3);
  ui.rest.value.textContent = Number(ui.rest.input.value).toFixed(2);
  ui.blockSize.value.textContent = ui.blockSize.input.value;
  ui.lockDelay.value.textContent = ui.lockDelay.input.value;
  ui.insulatingChance.value.textContent = `${ui.insulatingChance.input.value}%`;
  ui.bandX.value.textContent = ui.bandX.input.value;
  ui.voltage.value.textContent = ui.voltage.input.value;
}
