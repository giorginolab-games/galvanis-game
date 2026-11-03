import type { UiRefs } from "./types";

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!(element instanceof HTMLElement)) {
    throw new Error(`Missing required element #${id}`);
  }

  return element as T;
}

export function getUiRefs(): UiRefs {
  return {
    stage: el<HTMLDivElement>("stage"),
    hint: el("hint"),
    titleScreen: el("titleScreen"),
    tutorialScreen: el("tutorialScreen"),
    pauseOverlay: el("pauseOverlay"),
    gameOverOverlay: el("gameOverOverlay"),
    score: el("score"),
    best: el("best"),
    titleBest: el("titleBest"),
    level: el("level"),
    lines: el("lines"),
    levelBar: el("levelBar"),
    miniScore: el("miniScore"),
    miniLevel: el("miniLevel"),
    miniPulse: el("miniPulse"),
    nextCanvas: el<HTMLCanvasElement>("nextCanvas"),
    pulsePips: Array.from(el("pulsePips").querySelectorAll<HTMLElement>(".pip-fill")),
    pulseReady: el("pulseReady"),
    finalScore: el("finalScore"),
    finalLevel: el("finalLevel"),
    finalLines: el("finalLines"),
    finalChain: el("finalChain"),
    newBest: el("newBest"),
    playBtn: el<HTMLButtonElement>("playBtn"),
    howBtn: el<HTMLButtonElement>("howBtn"),
    resumeBtn: el<HTMLButtonElement>("resumeBtn"),
    pauseHelpBtn: el<HTMLButtonElement>("pauseHelpBtn"),
    quitBtn: el<HTMLButtonElement>("quitBtn"),
    restartBtn: el<HTMLButtonElement>("restartBtn"),
    overTitleBtn: el<HTMLButtonElement>("overTitleBtn"),
    pauseBtn: el<HTMLButtonElement>("pauseBtn"),
    helpBtn: el<HTMLButtonElement>("helpBtn"),
    sfxButtons: [el<HTMLButtonElement>("sfxBtn"), el<HTMLButtonElement>("titleSfxBtn")],
    musicButtons: [el<HTMLButtonElement>("musicBtn"), el<HTMLButtonElement>("titleMusicBtn")],
    touchButtons: Array.from(el("touchControls").querySelectorAll<HTMLButtonElement>(".touch-btn")),
    tutorial: {
      step: el("tutorialStep"),
      art: el("tutorialArt"),
      title: el("tutorialTitle"),
      body: el("tutorialBody"),
      dots: el("tutorialDots"),
      prev: el<HTMLButtonElement>("tutorialPrev"),
      next: el<HTMLButtonElement>("tutorialNext"),
      skip: el<HTMLButtonElement>("tutorialSkip"),
    },
  };
}
