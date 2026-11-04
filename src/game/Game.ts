import * as Matter from "matter-js";
import { SoundEngine } from "./audio";
import {
  AIR_BREAKDOWN_KV_PER_PX,
  BAND_WALL_THICKNESS,
  FLASH_DURATION_MS,
  FLASH_TIMEOUT_BUFFER_MS,
  LINES_PER_LEVEL,
  MAX_LEVEL,
  PIECE_COLORS,
  POINTS_PER_AIR_PX,
  POINTS_PER_CELL,
  POINTS_PER_LOCK,
  PULSE_MAX_CHARGES,
  PULSE_RECHARGE_PER_LINE,
  PULSE_START_CHARGES,
  SETTLE_CONFIRM_MS,
  SHAPES,
  SPAWN_Y,
  TETROMINO_NAMES,
  WALL_THICKNESS,
} from "./constants";
import { DebugPanel } from "./debug";
import { getUiRefs } from "./dom";
import { DEFAULT_PARAMS, difficultyFor, type Params } from "./params";
import { findAllLeftRightPaths, findLeftRightPath, jitteredPolyline, polylineLength, truncatePolyline } from "./pathfinding";
import { freezeTetromino, getTetrominoParts, isTetrominoBody, makeTetromino, sleepTetromino, wakeTetromino } from "./pieces";
import { loadSaved, saveData, type SavedData } from "./storage";
import { TUTORIAL_SLIDES } from "./tutorial";
import type { AirArc, Bolt, FlashState, StageSize, TetrominoBody, TetrominoName, UiRefs } from "./types";

type GameState = "title" | "playing" | "paused" | "over";

type BandWalls = {
  left: Matter.Body | null;
  right: Matter.Body | null;
};

interface QueuedPiece {
  name: TetrominoName;
  insulating: boolean;
}

interface Popup {
  x: number;
  y: number;
  text: string;
  color: string;
  size: number;
  born: number;
  life: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
  color: string;
  size: number;
}

const emptyFlash = (): FlashState => ({ until: 0, startedAt: 0, leftX: 0, rightX: 0, bolts: null, high: false, chain: 0 });

const HELD_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]);
const MAX_PARTICLES = 700;

export class GalvanisGame {
  private readonly ui: UiRefs;
  private readonly params: Params = { ...DEFAULT_PARAMS, ...difficultyFor(1) };
  private readonly saved: SavedData = loadSaved();
  private readonly sound: SoundEngine;
  private readonly debug: DebugPanel;
  private readonly engine: Matter.Engine;
  private readonly runner: Matter.Runner;
  private readonly render: Matter.Render;
  private readonly keyState = new Set<string>();
  private readonly viewport: StageSize = { width: 1, height: 1 };
  private readonly uiAbort = new AbortController();

  private state: GameState = "title";
  private walls: Matter.Body[] = [];
  private bandWalls: BandWalls = { left: null, right: null };
  private activePiece: TetrominoBody | null = null;
  private queue: QueuedPiece[] = [];
  private firstContactTime: number | null = null;
  private isResolvingTurn = false;
  private isSettlingAfterFlash = false;
  private settledSince: number | null = null;
  private pulseCharges = PULSE_START_CHARGES;
  private flash: FlashState = emptyFlash();
  private flashTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  // Run statistics.
  private score = 0;
  private displayedScore = 0;
  private lines = 0;
  private level = 1;
  private chain = 0;
  private bestChain = 0;
  private pieceCount = 0;
  private overSince = 0;
  private hvReady = false;
  private danger = 0;

  // Presentation.
  private popups: Popup[] = [];
  private particles: Particle[] = [];
  private shakeUntil = 0;
  private shakeMagnitude = 0;
  private lastFrame = performance.now();
  private hintQueue: string[] = [];
  private hintTimer: number | null = null;
  private tutorialIndex = 0;
  private tutorialOnClose: (() => void) | null = null;

  // ---- Event handlers --------------------------------------------------------------------------------------------

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (this.tutorialOpen) {
      this.onTutorialKey(event);
      return;
    }

    if (event.code === "Backquote") {
      this.debug.toggle();
      return;
    }

    if (event.code === "KeyM" && !event.repeat) {
      this.toggleAllSound();
      return;
    }

    switch (this.state) {
      case "title":
        if ((event.code === "Enter" || event.code === "Space") && !event.repeat) {
          event.preventDefault();
          this.startGame();
        }
        break;
      case "over":
        if ((event.code === "Enter" || event.code === "Space") && !event.repeat && performance.now() - this.overSince > 800) {
          event.preventDefault();
          this.beginRun();
        }
        break;
      case "paused":
        if ((event.code === "KeyP" || event.code === "Escape") && !event.repeat) {
          this.resume();
        }
        break;
      case "playing":
        if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Enter"].includes(event.code)) {
          event.preventDefault();
        }

        if ((event.code === "KeyP" || event.code === "Escape") && !event.repeat) {
          this.pause();
          return;
        }

        this.pressKey(event.code, event.repeat);
        break;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keyState.delete(event.code);
  };

  private readonly onBlur = (): void => {
    this.keyState.clear();

    if (this.state === "playing") {
      this.pause();
    }
  };

  private readonly onVisibility = (): void => {
    if (document.hidden && this.state === "playing") {
      this.pause();
    }
  };

  private readonly onTick = (): void => {
    if (this.state !== "playing") {
      return;
    }

    const now = performance.now();

    if (this.flash.bolts && now >= this.flash.until) {
      this.finishFlash();
    }

    if (this.isResolvingTurn && this.isSettlingAfterFlash) {
      if (this.areTetrominoesSettled()) {
        this.settledSince ??= now;

        if (now - this.settledSince >= SETTLE_CONFIRM_MS) {
          this.sleepSettledTetrominoes();

          if (this.hasTopOutTetromino()) {
            this.setGameOver();
            return;
          }

          // The collapse may have closed a new circuit: scan again, and a hit continues the chain.
          this.isSettlingAfterFlash = false;
          this.settledSince = null;
          this.triggerScanAndFlash();
        }
      } else {
        this.settledSince = null;
      }
    } else if (this.isResolvingTurn && !this.flash.bolts && !this.activePiece) {
      this.resumeAfterTurnResolution();
    }

    this.debug.setStats(
      `pieces ${this.pieceCount} · active ${this.activePiece?.plugin.name ?? "-"} · ${this.isResolvingTurn ? "resolving" : "running"} · chain ${this.chain} · danger ${this.danger.toFixed(2)}`,
    );

    if (!this.activePiece) {
      return;
    }

    this.applyActiveControls();
    this.considerLocking();
  };

  private readonly onCollisionStart = (event: Matter.IEventCollision<Matter.Engine>): void => {
    if (!this.activePiece) {
      return;
    }

    for (const pair of event.pairs) {
      const touchingActivePiece =
        pair.bodyA === this.activePiece ||
        pair.bodyB === this.activePiece ||
        this.activePiece.parts.includes(pair.bodyA) ||
        this.activePiece.parts.includes(pair.bodyB);

      if (!touchingActivePiece) {
        continue;
      }

      // Only the floor and other tetrominoes count as landing; side/band/ceiling walls must not start the lock timer.
      const other = this.activePiece.parts.includes(pair.bodyA) ? pair.bodyB : pair.bodyA;
      const isLanding = other === this.walls[0] || (other.parent !== other && isTetrominoBody(other.parent)) || isTetrominoBody(other);

      if (isLanding && this.firstContactTime === null) {
        this.firstContactTime = performance.now();
        this.sound.land();
      }
    }
  };

  private readonly onAfterRender = (): void => {
    const { context } = this.render;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;
    const { leftX, rightX } = this.getBandBounds();

    this.startViewTransform();
    this.drawBackdrop(context, leftX, rightX, now);
    this.drawPlates(context, leftX, rightX, now);

    if (this.state !== "title") {
      this.drawDangerLine(context, leftX, rightX, now);
    }

    if (this.flash.bolts && now < this.flash.until) {
      for (const bolt of this.flash.bolts) {
        this.drawConductionPath(context, bolt);
      }
    }

    this.drawParticles(context, now, dt);
    this.drawPopups(context, now);
    this.endViewTransform();
    this.applyShake(now);
    this.tickScoreDisplay(dt);
  };

  // ---- Lifecycle -------------------------------------------------------------------------------------------------

  constructor() {
    this.ui = getUiRefs();
    this.sound = new SoundEngine(this.saved.sfx, this.saved.music);
    this.measureStage();
    this.engine = Matter.Engine.create({ enableSleeping: this.params.sleeping });
    this.runner = Matter.Runner.create();
    this.render = Matter.Render.create({
      element: this.ui.stage,
      engine: this.engine,
      options: {
        width: this.viewport.width,
        height: this.viewport.height,
        wireframes: false,
        background: "transparent",
        pixelRatio: window.devicePixelRatio || 1,
        hasBounds: true,
        // Settled blocks sleep; don't draw them translucent.
        showSleeping: false,
      },
    });

    this.debug = new DebugPanel(
      this.params,
      (key) => this.onParamChange(key),
      {
        spawn: () => {
          if (this.state === "playing" && !this.activePiece && !this.isResolvingTurn) {
            this.spawnNext();
          }
        },
        scan: () => {
          if (this.state === "playing") {
            this.triggerScanAndFlash();
          }
        },
      },
      this.uiAbort.signal,
    );

    this.applyParams();
    this.setRenderBounds();
    this.bindUi();
    this.bindRuntimeEvents();
    this.makeWalls();
    this.updateBandWalls();
    this.updateSoundButtons();
    this.updateHud();
  }

  start(): void {
    Matter.Render.run(this.render);
    Matter.Runner.run(this.runner, this.engine);
    this.attachResizeHandling();
    this.showTitle();
  }

  destroy(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
    }

    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
    }

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    document.removeEventListener("visibilitychange", this.onVisibility);
    this.uiAbort.abort();
    Matter.Events.off(this.engine, "collisionStart", this.onCollisionStart);
    Matter.Events.off(this.runner, "tick", this.onTick);
    Matter.Events.off(this.render, "afterRender", this.onAfterRender);
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver?.disconnect();
    Matter.Render.stop(this.render);
    Matter.Runner.stop(this.runner);
    this.render.canvas.remove();
    this.sound.destroy();
  }

  private bindUi(): void {
    const { signal } = this.uiAbort;
    const on = (element: HTMLElement, handler: () => void): void => {
      element.addEventListener(
        "click",
        () => {
          this.sound.unlock();
          this.sound.click();
          // Drop focus so Space/Enter go to the game, not back to the button.
          element.blur();
          handler();
        },
        { signal },
      );
    };

    on(this.ui.playBtn, () => this.startGame());
    on(this.ui.howBtn, () => this.openTutorial());
    on(this.ui.resumeBtn, () => this.resume());
    on(this.ui.pauseHelpBtn, () => this.openTutorial());
    on(this.ui.quitBtn, () => this.showTitle());
    on(this.ui.restartBtn, () => this.beginRun());
    on(this.ui.overTitleBtn, () => this.showTitle());
    on(this.ui.pauseBtn, () => (this.state === "paused" ? this.resume() : this.pause()));
    on(this.ui.helpBtn, () => {
      if (this.state === "playing") {
        this.pause();
      }

      this.openTutorial();
    });

    for (const button of this.ui.sfxButtons) {
      on(button, () => this.setSfx(!this.sound.sfxOn));
    }

    for (const button of this.ui.musicButtons) {
      on(button, () => this.setMusic(!this.sound.musicOn));
    }

    on(this.ui.tutorial.next, () => this.tutorialStep(1));
    on(this.ui.tutorial.prev, () => this.tutorialStep(-1));
    on(this.ui.tutorial.skip, () => this.closeTutorial());

    for (const button of this.ui.touchButtons) {
      const code = button.dataset.key ?? "";
      const release = (): void => {
        this.keyState.delete(code);
        button.classList.remove("is-down");
      };

      button.addEventListener(
        "pointerdown",
        (event) => {
          event.preventDefault();
          this.sound.unlock();
          button.setPointerCapture(event.pointerId);
          button.classList.add("is-down");

          if (this.state === "playing") {
            this.pressKey(code, false);
          }
        },
        { signal },
      );
      button.addEventListener("pointerup", release, { signal });
      button.addEventListener("pointercancel", release, { signal });
      button.addEventListener("lostpointercapture", release, { signal });
    }
  }

  private bindRuntimeEvents(): void {
    Matter.Events.on(this.engine, "collisionStart", this.onCollisionStart);
    Matter.Events.on(this.runner, "tick", this.onTick);
    Matter.Events.on(this.render, "afterRender", this.onAfterRender);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  private readonly handleResize = (): void => {
    this.measureStage();
    this.resizeRenderSurface();
    this.makeWalls();
    this.updateBandWalls();
  };

  private attachResizeHandling(): void {
    window.addEventListener("resize", this.handleResize);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.ui.stage);
    }

    this.handleResize();
  }

  // ---- Screens & state -------------------------------------------------------------------------------------------

  private showTitle(): void {
    this.resume(false);
    this.clearWorld();
    this.state = "title";
    this.sound.stopMusic();
    this.ui.titleScreen.hidden = false;
    this.ui.pauseOverlay.hidden = true;
    this.ui.gameOverOverlay.hidden = true;
    this.ui.titleBest.textContent = this.saved.best.toLocaleString();
    this.hideHint();
    this.updateHud();
  }

  private startGame(): void {
    this.sound.unlock();

    if (!this.saved.tutorialSeen) {
      this.openTutorial(() => this.beginRun());
    } else {
      this.beginRun();
    }
  }

  /** Starts a fresh run. */
  private beginRun(): void {
    this.resume(false);
    this.clearWorld();
    this.score = 0;
    this.displayedScore = 0;
    this.lines = 0;
    this.level = 1;
    this.chain = 0;
    this.bestChain = 0;
    this.pieceCount = 0;
    this.hvReady = false;
    this.queue = [];
    this.setPulseCharges(PULSE_START_CHARGES, false);
    this.applyDifficulty();
    this.state = "playing";
    this.ui.titleScreen.hidden = true;
    this.ui.pauseOverlay.hidden = true;
    this.ui.gameOverOverlay.hidden = true;
    this.sound.playMusic(this.level);
    this.updateHud();
    this.startNextTurn();
    this.hint("controls", "← → push · ↑ spin · ↓ soft drop · Space slam");
    this.hint("goal", "Connect the two copper plates with solid blocks to burn them away");
  }

  private pause(): void {
    if (this.state !== "playing") {
      return;
    }

    this.state = "paused";
    this.keyState.clear();
    Matter.Runner.stop(this.runner);
    this.ui.pauseOverlay.hidden = false;
    this.ui.pauseBtn.textContent = "Resume";
    this.sound.stopMusic();
  }

  /** Leaves the paused state; `play` false is used when switching screens, so the run doesn't continue. */
  private resume(play = true): void {
    if (this.state !== "paused") {
      return;
    }

    Matter.Runner.run(this.runner, this.engine);
    this.ui.pauseOverlay.hidden = true;
    this.ui.pauseBtn.textContent = "Pause";
    this.state = "playing";

    if (play) {
      this.sound.playMusic(this.level);
    }
  }

  private setGameOver(): void {
    this.state = "over";
    this.overSince = performance.now();
    this.activePiece = null;
    this.firstContactTime = null;
    this.isResolvingTurn = false;
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.keyState.clear();
    this.sound.stopMusic();
    this.sound.gameOver();
    this.shake(10, 500);

    const isBest = this.score > this.saved.best;

    if (isBest) {
      this.saved.best = this.score;
      saveData(this.saved);
    }

    this.displayedScore = this.score;
    this.ui.finalScore.textContent = this.score.toLocaleString();
    this.ui.finalLevel.textContent = String(this.level);
    this.ui.finalLines.textContent = String(this.lines);
    this.ui.finalChain.textContent = this.bestChain > 1 ? `×${this.bestChain}` : "–";
    this.ui.newBest.hidden = !isBest || this.score === 0;
    this.ui.gameOverOverlay.hidden = false;
    this.hideHint();
    this.updateHud();
  }

  private clearWorld(): void {
    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (!body.isStatic || isTetrominoBody(body)) {
        Matter.World.remove(this.engine.world, body);
      }
    }

    this.clearFlash();
    this.makeWalls();
    this.updateBandWalls();
    this.activePiece = null;
    this.firstContactTime = null;
    this.isResolvingTurn = false;
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.popups = [];
    this.particles = [];
    this.keyState.clear();
  }

  // ---- Tutorial --------------------------------------------------------------------------------------------------

  private get tutorialOpen(): boolean {
    return !this.ui.tutorialScreen.hidden;
  }

  private openTutorial(onClose: (() => void) | null = null): void {
    this.tutorialOnClose = onClose;
    this.tutorialIndex = 0;
    this.ui.tutorial.dots.replaceChildren(
      ...TUTORIAL_SLIDES.map((_, index) => {
        const dot = document.createElement("button");
        dot.type = "button";
        dot.className = "tutorial-dot";
        dot.setAttribute("aria-label", `Step ${index + 1}`);
        dot.addEventListener("click", () => {
          this.tutorialIndex = index;
          this.renderTutorial();
        });
        return dot;
      }),
    );
    this.ui.tutorialScreen.hidden = false;
    this.renderTutorial();
  }

  private tutorialStep(direction: 1 | -1): void {
    const next = this.tutorialIndex + direction;

    if (next >= TUTORIAL_SLIDES.length) {
      this.closeTutorial();
      return;
    }

    this.tutorialIndex = Math.max(0, next);
    this.renderTutorial();
  }

  private renderTutorial(): void {
    const slide = TUTORIAL_SLIDES[this.tutorialIndex];
    const last = this.tutorialIndex === TUTORIAL_SLIDES.length - 1;
    const t = this.ui.tutorial;

    t.step.textContent = `${this.tutorialIndex + 1} / ${TUTORIAL_SLIDES.length}`;
    t.art.innerHTML = slide.art;
    t.title.textContent = slide.title;
    t.body.innerHTML = slide.body;
    t.prev.disabled = this.tutorialIndex === 0;
    t.next.textContent = last ? (this.tutorialOnClose ? "Let's go" : "Done") : "Next";
    t.skip.hidden = last;
    t.dots.querySelectorAll(".tutorial-dot").forEach((dot, index) => dot.classList.toggle("is-active", index === this.tutorialIndex));
  }

  private closeTutorial(): void {
    this.ui.tutorialScreen.hidden = true;

    if (!this.saved.tutorialSeen) {
      this.saved.tutorialSeen = true;
      saveData(this.saved);
    }

    const onClose = this.tutorialOnClose;
    this.tutorialOnClose = null;
    onClose?.();
  }

  private onTutorialKey(event: KeyboardEvent): void {
    if (event.repeat) {
      return;
    }

    if (event.code === "ArrowRight" || event.code === "Enter" || event.code === "Space") {
      event.preventDefault();
      this.sound.click();
      this.tutorialStep(1);
    } else if (event.code === "ArrowLeft") {
      event.preventDefault();
      this.sound.click();
      this.tutorialStep(-1);
    } else if (event.code === "Escape") {
      this.closeTutorial();
    }
  }

  // ---- Hints -----------------------------------------------------------------------------------------------------

  /** Shows a one-time contextual tip (each key only ever once per player). */
  private hint(key: string, text: string): void {
    if (this.saved.hintsSeen.includes(key)) {
      return;
    }

    this.saved.hintsSeen.push(key);
    saveData(this.saved);
    this.hintQueue.push(text);

    if (this.hintTimer === null) {
      this.showNextHint();
    }
  }

  private showNextHint(): void {
    const text = this.hintQueue.shift();

    if (text === undefined) {
      this.ui.hint.hidden = true;
      this.hintTimer = null;
      return;
    }

    this.ui.hint.textContent = text;
    this.ui.hint.hidden = false;
    this.ui.hint.classList.remove("hint-in");
    void this.ui.hint.offsetWidth;
    this.ui.hint.classList.add("hint-in");
    this.hintTimer = window.setTimeout(() => this.showNextHint(), 4200);
  }

  private hideHint(): void {
    if (this.hintTimer !== null) {
      window.clearTimeout(this.hintTimer);
      this.hintTimer = null;
    }

    this.hintQueue = [];
    this.ui.hint.hidden = true;
  }

  // ---- Sound settings --------------------------------------------------------------------------------------------

  private setSfx(on: boolean): void {
    this.sound.setSfx(on);
    this.saved.sfx = on;
    saveData(this.saved);
    this.updateSoundButtons();
  }

  private setMusic(on: boolean): void {
    this.sound.setMusic(on);
    this.saved.music = on;
    saveData(this.saved);
    this.updateSoundButtons();
  }

  private toggleAllSound(): void {
    const on = !(this.sound.sfxOn || this.sound.musicOn);
    this.setSfx(on);
    this.setMusic(on);
  }

  private updateSoundButtons(): void {
    for (const button of this.ui.sfxButtons) {
      button.setAttribute("aria-pressed", String(this.sound.sfxOn));
    }

    for (const button of this.ui.musicButtons) {
      button.setAttribute("aria-pressed", String(this.sound.musicOn));
    }
  }

  // ---- Parameters & difficulty -----------------------------------------------------------------------------------

  private onParamChange(key: keyof Params): void {
    if (key === "bandHalfWidth") {
      this.updateBandWalls();
    }

    if (key === "autoDifficulty" && this.params.autoDifficulty) {
      this.applyDifficulty();
      return;
    }

    this.applyParams();
  }

  private applyDifficulty(): void {
    if (this.params.autoDifficulty) {
      Object.assign(this.params, difficultyFor(this.level));
    }

    this.applyParams();
  }

  private applyParams(): void {
    this.engine.gravity.y = this.params.gravityY;
    this.engine.enableSleeping = this.params.sleeping;

    if (this.activePiece) {
      Matter.Sleeping.set(this.activePiece, false);
    }

    this.debug.sync();
  }

  /** Band half-width, clamped so the playfield always fits the stage. */
  private get bandHalfWidth(): number {
    return Math.max(80, Math.min(this.params.bandHalfWidth, this.viewport.width / 2 - 24));
  }

  /** Block size, shrunk on narrow stages so about a dozen blocks span the band. */
  private get blockSize(): number {
    return Math.max(14, Math.min(this.params.blockSize, Math.floor((2 * this.bandHalfWidth) / 12)));
  }

  private get dangerY(): number {
    return SPAWN_Y + this.blockSize * 1.25;
  }

  // ---- World geometry --------------------------------------------------------------------------------------------

  private measureStage(): void {
    this.viewport.width = Math.max(1, this.ui.stage.clientWidth);
    this.viewport.height = Math.max(1, this.ui.stage.clientHeight);
  }

  private resizeRenderSurface(): void {
    const pixelRatio = window.devicePixelRatio || 1;
    this.render.options.width = this.viewport.width;
    this.render.options.height = this.viewport.height;
    this.render.options.pixelRatio = pixelRatio;
    this.render.canvas.width = Math.round(this.viewport.width * pixelRatio);
    this.render.canvas.height = Math.round(this.viewport.height * pixelRatio);
    this.render.canvas.style.width = `${this.viewport.width}px`;
    this.render.canvas.style.height = `${this.viewport.height}px`;
    this.render.context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    this.setRenderBounds();
  }

  private setRenderBounds(): void {
    this.render.bounds.min.x = 0;
    this.render.bounds.min.y = 0;
    this.render.bounds.max.x = this.viewport.width;
    this.render.bounds.max.y = this.viewport.height;
  }

  private makeWalls(): void {
    for (const wall of this.walls) {
      Matter.World.remove(this.engine.world, wall);
    }

    const thickness = WALL_THICKNESS;
    const { width, height } = this.viewport;
    const render = { fillStyle: "#0a0d22" };
    const floor = Matter.Bodies.rectangle(width / 2, height + thickness / 2 - 8, width + thickness * 2, thickness, { isStatic: true, render });
    const left = Matter.Bodies.rectangle(-thickness / 2 + 8, height / 2, thickness, height * 2, { isStatic: true, render });
    const right = Matter.Bodies.rectangle(width + thickness / 2 - 8, height / 2, thickness, height * 2, { isStatic: true, render });
    const ceiling = Matter.Bodies.rectangle(width / 2, -thickness / 2, width + thickness * 2, thickness, { isStatic: true, render });

    this.walls = [floor, left, right, ceiling];
    Matter.World.add(this.engine.world, this.walls);
  }

  private getBandBounds(): { leftX: number; rightX: number } {
    const center = this.viewport.width / 2;

    return {
      leftX: center - this.bandHalfWidth,
      rightX: center + this.bandHalfWidth,
    };
  }

  private updateBandWalls(): void {
    if (this.bandWalls.left) {
      Matter.World.remove(this.engine.world, this.bandWalls.left);
    }

    if (this.bandWalls.right) {
      Matter.World.remove(this.engine.world, this.bandWalls.right);
    }

    const { leftX, rightX } = this.getBandBounds();
    const wallOptions: Matter.IChamferableBodyDefinition = {
      isStatic: true,
      restitution: 0,
      friction: 0.1,
      render: { visible: false },
    };
    const height = this.viewport.height;
    const leftWall = Matter.Bodies.rectangle(leftX, height / 2, BAND_WALL_THICKNESS, height * 2, wallOptions);
    const rightWall = Matter.Bodies.rectangle(rightX, height / 2, BAND_WALL_THICKNESS, height * 2, wallOptions);

    this.bandWalls = { left: leftWall, right: rightWall };
    Matter.World.add(this.engine.world, [leftWall, rightWall]);
  }

  // ---- Pieces & controls -----------------------------------------------------------------------------------------

  /** 7-bag randomiser: each run of seven pieces holds one of every shape. */
  private refillQueue(): void {
    while (this.queue.length < 3) {
      const bag = [...TETROMINO_NAMES];

      for (let i = bag.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [bag[i], bag[j]] = [bag[j], bag[i]];
      }

      for (const name of bag) {
        // The first couple of pieces of a run are always conductive, so the opening is fair.
        const insulating = this.pieceCount + this.queue.length >= 2 && Math.random() < this.params.insulatingChance;
        this.queue.push({ name, insulating });
      }
    }
  }

  private startNextTurn(): void {
    if (this.state !== "playing" || this.activePiece || this.isResolvingTurn) {
      return;
    }

    this.spawnNext();
  }

  private spawnNext(): void {
    this.refillQueue();
    const next = this.queue.shift() as QueuedPiece;
    this.refillQueue();

    const piece = makeTetromino(
      next.name,
      this.viewport.width / 2,
      SPAWN_Y,
      this.blockSize,
      this.params.friction,
      this.params.restitution,
      next.insulating,
    );

    Matter.World.add(this.engine.world, piece);
    this.activePiece = piece;
    this.firstContactTime = null;
    this.chain = 0;
    this.pieceCount += 1;
    Matter.Body.setVelocity(piece, { x: (Math.random() - 0.5) * 0.5, y: 0 });
    this.drawNextPreview();

    if (next.insulating) {
      this.hint("insulator", "Hollow blocks are insulators: no current flows through them");
    }
  }

  private pressKey(code: string, repeat: boolean): void {
    if (HELD_KEYS.has(code)) {
      this.keyState.add(code);
    }

    if (repeat) {
      return;
    }

    switch (code) {
      case "ArrowLeft":
      case "ArrowRight":
        if (this.activePiece) {
          this.sound.move();
        }
        break;
      case "ArrowUp":
        if (this.activePiece) {
          this.sound.rotate();
        }
        break;
      case "Space":
        this.hardDrop();
        break;
      case "Enter":
        this.firePulse();
        break;
    }
  }

  private applyActiveControls(): void {
    if (!this.activePiece) {
      return;
    }

    const impulse = 0.0025 * this.activePiece.mass;

    if (this.keyState.has("ArrowLeft")) {
      Matter.Body.applyForce(this.activePiece, this.activePiece.position, { x: -impulse, y: 0 });
    }

    if (this.keyState.has("ArrowRight")) {
      Matter.Body.applyForce(this.activePiece, this.activePiece.position, { x: impulse, y: 0 });
    }

    if (this.keyState.has("ArrowDown")) {
      Matter.Body.applyForce(this.activePiece, this.activePiece.position, { x: 0, y: impulse * 2 });
    }

    if (this.keyState.has("ArrowUp")) {
      Matter.Body.setAngularVelocity(this.activePiece, -0.18);
    }
  }

  private hardDrop(): void {
    if (!this.activePiece || this.firstContactTime !== null) {
      return;
    }

    this.sound.drop();
    Matter.Body.applyForce(this.activePiece, this.activePiece.position, { x: 0, y: 0.08 });
  }

  private considerLocking(): void {
    if (!this.activePiece || this.isResolvingTurn || this.firstContactTime === null) {
      return;
    }

    if (this.activePiece.speed >= 0.4) {
      return;
    }

    if (performance.now() - this.firstContactTime < this.params.lockDelay) {
      return;
    }

    if (this.params.freezeBlocks) {
      freezeTetromino(this.activePiece);
    }

    const lockedPiece = this.activePiece;
    this.activePiece = null;
    this.firstContactTime = null;

    if (this.isNearSpawnHeight(lockedPiece)) {
      this.setGameOver();
      return;
    }

    this.addScore(POINTS_PER_LOCK * this.level);
    this.isResolvingTurn = true;
    this.triggerScanAndFlash();
  }

  private isNearSpawnHeight(body: Matter.Body): boolean {
    return body.bounds.min.y <= this.dangerY;
  }

  private hasTopOutTetromino(): boolean {
    return Matter.Composite.allBodies(this.engine.world).some((body) => isTetrominoBody(body) && this.isNearSpawnHeight(body));
  }

  private resumeAfterTurnResolution(): void {
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.isResolvingTurn = false;
    this.refreshPulseReadiness();

    if (!this.activePiece) {
      this.startNextTurn();
    }
  }

  // ---- Discharges ------------------------------------------------------------------------------------------------

  /** High-voltage pulse: burns every body-disjoint path the high voltage can break down, at the cost of one charge. */
  private firePulse(): void {
    if (this.state !== "playing" || this.isResolvingTurn || this.flash.bolts) {
      return;
    }

    if (this.pulseCharges < 1) {
      this.sound.denied();
      this.popupCenter("NO CHARGE", "#ff8f8f", 20);
      return;
    }

    const result = findAllLeftRightPaths(
      this.engine.world,
      this.viewport,
      this.bandHalfWidth,
      this.params.highVoltage,
      this.inFlightBodies(),
    );

    // A pulse with nothing to hit is not wasted.
    if (!result) {
      this.sound.denied();
      this.popupCenter("NO PATH IN REACH", "#ff8f8f", 20);
      return;
    }

    this.setPulseCharges(this.pulseCharges - 1);
    this.hvReady = false;
    this.sound.pulseCharge();
    this.startFlash(result.bolts, result.leftX, result.rightX, true, 1);
  }

  private startFlash(bolts: Bolt[], leftX: number, rightX: number, high: boolean, chain: number): void {
    this.flash.bolts = bolts;
    this.flash.high = high;
    this.flash.chain = chain;
    this.flash.startedAt = performance.now();
    this.flash.until = this.flash.startedAt + FLASH_DURATION_MS;
    this.flash.leftX = leftX;
    this.flash.rightX = rightX;
    this.sound.zap(chain, high);
    this.shake(high ? 7 : 3 + Math.min(chain, 5), high ? 420 : 260);
    this.flashTimer = window.setTimeout(() => {
      // While paused, leave the flash for onTick to finish after resume.
      if (this.state === "playing") {
        this.finishFlash();
      }
    }, FLASH_DURATION_MS + FLASH_TIMEOUT_BUFFER_MS);
  }

  /** The piece still under player control is not part of the circuit. */
  private inFlightBodies(): ReadonlySet<Matter.Body> {
    return new Set<Matter.Body>(this.activePiece ? [this.activePiece] : []);
  }

  private setPulseCharges(charges: number, announce = true): void {
    const before = this.pulseCharges;
    this.pulseCharges = Math.min(PULSE_MAX_CHARGES, charges);

    if (announce && Math.floor(this.pulseCharges) > Math.floor(before)) {
      this.sound.chargeGained();
    }

    this.updateHud();
  }

  /** Checks (on a settled board) whether a pulse would hit anything, to light the READY indicator. */
  private refreshPulseReadiness(): void {
    this.hvReady =
      this.pulseCharges >= 1 &&
      findLeftRightPath(this.engine.world, this.viewport, this.bandHalfWidth, this.params.highVoltage, this.inFlightBodies()) !== null;

    if (this.hvReady) {
      this.hint("pulse", "⚡ A high-voltage pulse would land: press Enter");
    }

    this.updateHud();
  }

  private triggerScanAndFlash(): void {
    // A pulse still in flight must apply its burn before a new scan starts.
    if (this.flash.bolts) {
      this.finishFlash();
    }

    const result = findLeftRightPath(
      this.engine.world,
      this.viewport,
      this.bandHalfWidth,
      this.params.voltage,
      this.inFlightBodies(),
    );

    if (!result) {
      this.clearFlash();

      if (this.isResolvingTurn) {
        this.resumeAfterTurnResolution();
      }

      return;
    }

    const chain = this.isResolvingTurn ? ++this.chain : 1;
    this.startFlash([result], result.leftX, result.rightX, false, chain);
  }

  private finishFlash(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }

    let erased = false;

    if (this.flash.bolts && this.params.eraseOnPath) {
      const bolts = this.flash.bolts;
      const parents = new Set(bolts.flatMap((bolt) => bolt.pathNodes.map((node) => node.parent)));

      if (parents.size > 0) {
        this.scoreBurn(bolts, parents);
      }

      for (const parent of parents) {
        this.emitBurnParticles(parent);
        Matter.World.remove(this.engine.world, parent);
      }

      erased = parents.size > 0;

      // Each cleared line recharges the high-voltage pulse.
      this.setPulseCharges(this.pulseCharges + bolts.length * PULSE_RECHARGE_PER_LINE);
      this.addLines(bolts.length);
    }

    this.flash.bolts = null;
    this.flash.until = 0;

    if (erased || this.isResolvingTurn) {
      this.wakeTetrominoesAfterFlash();
    }

    if (this.isResolvingTurn) {
      this.isSettlingAfterFlash = true;
      this.settledSince = null;
    }
  }

  // ---- Scoring ---------------------------------------------------------------------------------------------------

  /**
   * Points = (cells burned × 25 + air bridged in px × 4) × level × chain link × (lines, for a multi-path pulse).
   */
  private scoreBurn(bolts: Bolt[], parents: Set<TetrominoBody>): void {
    let cells = 0;
    let cx = 0;
    let cy = 0;

    for (const parent of parents) {
      cells += getTetrominoParts(parent).length;
      cx += parent.position.x;
      cy += parent.position.y;
    }

    cx /= parents.size;
    cy /= parents.size;

    const air = bolts.reduce((sum, bolt) => sum + bolt.arcs.reduce((total, arc) => total + arc.length, 0), 0);
    const chain = this.flash.chain;
    const multiLine = this.flash.high ? bolts.length : 1;
    const points = Math.round((cells * POINTS_PER_CELL + air * POINTS_PER_AIR_PX) * this.level * chain * multiLine);

    this.addScore(points);
    this.bestChain = Math.max(this.bestChain, chain);
    this.sound.burn();
    this.popup(cx, cy, `+${points.toLocaleString()}`, "#fff6a0", 26 + Math.min(16, Math.log10(points) * 3));

    if (chain > 1) {
      this.popup(cx, cy - 34, `CHAIN ×${chain}`, "#7ce9ff", 22);
    }

    if (multiLine > 1) {
      this.popup(cx, cy - (chain > 1 ? 64 : 34), `${multiLine} LINES ×${multiLine}`, "#ff9cf3", 22);
    }

    if (air >= 6) {
      this.popup(cx, cy + 30, `ARC BONUS ${Math.round(air)} mm`, "#ff9cf3", 14);
    }

    this.hint("clear", "Zap! Leap air gaps and set off chain reactions for bigger scores");
  }

  private addScore(points: number): void {
    this.score += points;
    this.updateHud();
  }

  private addLines(count: number): void {
    this.lines += count;
    const level = Math.min(MAX_LEVEL, 1 + Math.floor(this.lines / LINES_PER_LEVEL));

    if (level > this.level) {
      this.level = level;
      this.applyDifficulty();
      this.sound.levelUp();
      this.sound.setTempoForLevel(level);
      this.popupCenter(`LEVEL ${level}`, "#9fe870", 44, 1800);
      this.hint("level", "Level up: faster falls, quicker locks, weaker arcs, more insulators");
    }

    this.updateHud();
  }

  // ---- HUD -------------------------------------------------------------------------------------------------------

  private updateHud(): void {
    this.ui.best.textContent = Math.max(this.saved.best, this.score).toLocaleString();
    this.ui.level.textContent = String(this.level);
    this.ui.miniLevel.textContent = String(this.level);
    this.ui.miniPulse.textContent = this.pulseCharges.toFixed(1);
    this.ui.lines.textContent = String(this.lines);
    const intoLevel = this.level >= MAX_LEVEL ? LINES_PER_LEVEL : this.lines % LINES_PER_LEVEL;
    this.ui.levelBar.style.width = `${(intoLevel / LINES_PER_LEVEL) * 100}%`;

    this.ui.pulsePips.forEach((pip, index) => {
      const fill = Math.max(0, Math.min(1, this.pulseCharges - index));
      pip.style.width = `${fill * 100}%`;
      pip.parentElement?.classList.toggle("is-full", fill >= 1);
    });

    this.ui.pulseReady.hidden = !(this.hvReady && this.pulseCharges >= 1 && this.state === "playing");

    if (this.state === "title" || this.displayedScore === this.score) {
      this.ui.score.textContent = this.ui.miniScore.textContent = Math.round(this.score).toLocaleString();
    }

    if (this.state === "title") {
      this.clearNextPreview();
    }
  }

  private tickScoreDisplay(dt: number): void {
    if (this.displayedScore === this.score) {
      return;
    }

    this.displayedScore += (this.score - this.displayedScore) * Math.min(1, dt * 8);

    if (Math.abs(this.score - this.displayedScore) < 1) {
      this.displayedScore = this.score;
    }

    this.ui.score.textContent = this.ui.miniScore.textContent = Math.round(this.displayedScore).toLocaleString();
  }

  private clearNextPreview(): void {
    const canvas = this.ui.nextCanvas;
    canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }

  private drawNextPreview(): void {
    const canvas = this.ui.nextCanvas;
    const context = canvas.getContext("2d");
    const next = this.queue[0];

    if (!context || !next) {
      return;
    }

    const ratio = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 120;
    const cssHeight = canvas.clientHeight || 64;

    if (canvas.width !== Math.round(cssWidth * ratio)) {
      canvas.width = Math.round(cssWidth * ratio);
      canvas.height = Math.round(cssHeight * ratio);
    }

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, cssWidth, cssHeight);

    const cells = SHAPES[next.name];
    const columns = Math.max(...cells.map(([x]) => x)) + 1;
    const rows = Math.max(...cells.map(([, y]) => y)) + 1;
    const size = Math.min(22, (cssWidth - 12) / columns, (cssHeight - 12) / rows);
    const ox = (cssWidth - columns * size) / 2;
    const oy = (cssHeight - rows * size) / 2;
    const color = PIECE_COLORS[next.name];

    for (const [x, y] of cells) {
      const px = ox + x * size + 1;
      const py = oy + y * size + 1;
      context.beginPath();
      context.roundRect(px, py, size - 2, size - 2, size * 0.15);

      if (next.insulating) {
        context.lineWidth = Math.max(2, size * 0.14);
        context.strokeStyle = color;
        context.stroke();
      } else {
        context.fillStyle = color;
        context.fill();
      }
    }
  }

  // ---- Physics helpers -------------------------------------------------------------------------------------------

  private wakeTetrominoesAfterFlash(): void {
    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (!isTetrominoBody(body) || body.plugin.frozen || body.isStatic) {
        continue;
      }

      wakeTetromino(body);
    }
  }

  private areTetrominoesSettled(): boolean {
    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (!isTetrominoBody(body) || body.plugin.frozen || body.isStatic) {
        continue;
      }

      if (!body.isSleeping && (body.speed > 0.02 || Math.abs(body.angularSpeed) > 0.02)) {
        return false;
      }
    }

    return true;
  }

  private sleepSettledTetrominoes(): void {
    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (!isTetrominoBody(body) || body.plugin.frozen || body.isStatic) {
        continue;
      }

      sleepTetromino(body);
    }
  }

  private clearFlash(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }

    this.flash = emptyFlash();
  }

  // ---- Effects ---------------------------------------------------------------------------------------------------

  private popup(x: number, y: number, text: string, color: string, size: number, life = 1100): void {
    this.popups.push({ x, y, text, color, size, born: performance.now(), life });
  }

  private popupCenter(text: string, color: string, size: number, life = 1000): void {
    this.popup(this.viewport.width / 2, this.viewport.height * 0.38, text, color, size, life);
  }

  private shake(magnitude: number, duration: number): void {
    this.shakeMagnitude = Math.max(this.shakeMagnitude, magnitude);
    this.shakeUntil = Math.max(this.shakeUntil, performance.now() + duration);
  }

  private applyShake(now: number): void {
    const canvas = this.render.canvas;

    if (now >= this.shakeUntil) {
      if (this.shakeMagnitude !== 0) {
        this.shakeMagnitude = 0;
        canvas.style.transform = "";
      }

      return;
    }

    const falloff = Math.min(1, (this.shakeUntil - now) / 250);
    const m = this.shakeMagnitude * falloff;
    canvas.style.transform = `translate(${((Math.random() * 2 - 1) * m).toFixed(1)}px, ${((Math.random() * 2 - 1) * m).toFixed(1)}px)`;
  }

  private emitBurnParticles(body: TetrominoBody): void {
    const now = performance.now();
    const color = PIECE_COLORS[body.plugin.name as TetrominoName];

    for (const part of getTetrominoParts(body)) {
      for (let i = 0; i < 7 && this.particles.length < MAX_PARTICLES; i += 1) {
        const angle = Math.random() * Math.PI * 2;
        const speed = 60 + Math.random() * 240;
        this.particles.push({
          x: part.position.x + (Math.random() - 0.5) * this.blockSize * 0.7,
          y: part.position.y + (Math.random() - 0.5) * this.blockSize * 0.7,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 120,
          born: now,
          life: 450 + Math.random() * 500,
          color: Math.random() < 0.35 ? "#fff6a0" : color,
          size: 1.5 + Math.random() * 3,
        });
      }
    }
  }

  // ---- Drawing ---------------------------------------------------------------------------------------------------

  /** Everything here goes behind the blocks (destination-over), so it never hides the stack. */
  private drawBackdrop(context: CanvasRenderingContext2D, leftX: number, rightX: number, now: number): void {
    const height = this.viewport.height;
    const face = BAND_WALL_THICKNESS / 2;
    const reach = this.params.voltage / AIR_BREAKDOWN_KV_PER_PX;

    context.save();
    context.globalCompositeOperation = "destination-over";

    // Arc reach: blocks inside these glows can spark across to the plate.
    if (reach > 0) {
      const glow = 0.13 + 0.03 * Math.sin(now / 420);

      for (const [x, direction] of [
        [leftX + face, 1],
        [rightX - face, -1],
      ] as const) {
        const gradient = context.createLinearGradient(x, 0, x + direction * reach, 0);
        gradient.addColorStop(0, `rgba(255, 170, 90, ${glow})`);
        gradient.addColorStop(1, "rgba(255, 170, 90, 0)");
        context.fillStyle = gradient;
        context.fillRect(Math.min(x, x + direction * reach), 0, reach, height);
      }
    }

    // The playfield: lighter than the dead zone outside the plates.
    context.fillStyle = "rgba(102, 140, 255, 0.045)";
    context.fillRect(leftX, 0, rightX - leftX, height);
    context.restore();

    if (this.params.debugOverlay) {
      this.drawDebugBand(context, leftX, rightX, reach);
    }
  }

  private drawDebugBand(context: CanvasRenderingContext2D, leftX: number, rightX: number, reach: number): void {
    const height = this.viewport.height;
    context.save();
    context.globalAlpha = 0.8;
    context.strokeStyle = "#3aa0ff";
    context.lineWidth = 2;
    context.setLineDash([6, 6]);

    for (const x of [leftX, rightX]) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    const highReach = this.params.highVoltage / AIR_BREAKDOWN_KV_PER_PX;

    for (const [r, color] of [
      [reach, "#9fe870"],
      [highReach, "#ff5cf0"],
    ] as const) {
      context.globalAlpha = 0.5;
      context.strokeStyle = color;
      context.lineWidth = 1.5;
      context.setLineDash([4, 4]);

      for (const x of [leftX + BAND_WALL_THICKNESS / 2 + r, rightX - BAND_WALL_THICKNESS / 2 - r]) {
        context.beginPath();
        context.moveTo(x, 0);
        context.lineTo(x, height);
        context.stroke();
      }
    }

    context.restore();
  }

  /** Copper electrodes on the band walls; they flare while current flows. */
  private drawPlates(context: CanvasRenderingContext2D, leftX: number, rightX: number, now: number): void {
    const height = this.viewport.height;
    const half = BAND_WALL_THICKNESS / 2;
    const live = this.flash.bolts && now < this.flash.until;
    const flare = live ? (this.flash.high ? 1 : 0.7) : 0;

    context.save();

    for (const x of [leftX, rightX]) {
      const gradient = context.createLinearGradient(x - half, 0, x + half, 0);
      gradient.addColorStop(0, "#7a3f17");
      gradient.addColorStop(0.45, live ? "#fff1d0" : "#f3b874");
      gradient.addColorStop(1, "#8b4a1d");
      context.shadowColor = live ? (this.flash.high ? "#ff9cf3" : "#7ce9ff") : "#ff9d4d";
      context.shadowBlur = 10 + 22 * flare + 3 * Math.sin(now / 300);
      context.fillStyle = gradient;
      context.fillRect(x - half, 0, BAND_WALL_THICKNESS, height);
    }

    // Idle crackle along the plate faces.
    context.shadowBlur = 8;
    context.shadowColor = "#ffd29a";
    context.strokeStyle = "rgba(255, 228, 190, 0.85)";
    context.lineWidth = 1.2;

    for (const [x, direction] of [
      [leftX + half, 1],
      [rightX - half, -1],
    ] as const) {
      if (Math.random() < 0.06 + flare * 0.5) {
        const y = Math.random() * height;
        const length = 5 + Math.random() * 9;
        context.beginPath();
        context.moveTo(x, y);
        context.lineTo(x + direction * length * 0.5, y + (Math.random() - 0.5) * 8);
        context.lineTo(x + direction * length, y + (Math.random() - 0.5) * 8);
        context.stroke();
      }
    }

    context.restore();
  }

  /** The top-out line, brightening as the stack climbs toward it. */
  private drawDangerLine(context: CanvasRenderingContext2D, leftX: number, rightX: number, now: number): void {
    let top = Infinity;

    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (isTetrominoBody(body) && body !== this.activePiece) {
        top = Math.min(top, body.bounds.min.y);
      }
    }

    const span = this.blockSize * 4;
    this.danger = Math.max(0, Math.min(1, (this.dangerY + span - top) / span));

    if (this.danger > 0.5 && this.state === "playing") {
      this.hint("danger", "Careful! If the stack reaches the red line, it's game over");
    }

    const y = this.dangerY;
    const pulse = this.danger > 0 ? 0.5 + 0.5 * Math.sin(now / (120 + 200 * (1 - this.danger))) : 0;

    context.save();
    context.globalAlpha = 0.22 + 0.5 * this.danger + 0.25 * this.danger * pulse;
    context.strokeStyle = "#ff5a5a";
    context.shadowColor = "#ff5a5a";
    context.shadowBlur = 6 + 14 * this.danger;
    context.lineWidth = 2;
    context.setLineDash([10, 8]);
    context.lineDashOffset = -now / 40;
    context.beginPath();
    context.moveTo(leftX + BAND_WALL_THICKNESS / 2, y);
    context.lineTo(rightX - BAND_WALL_THICKNESS / 2, y);
    context.stroke();

    if (this.danger > 0.25) {
      context.setLineDash([]);
      context.shadowBlur = 0;
      context.fillStyle = "#ff8f8f";
      context.font = "800 10px Inter, 'Segoe UI', sans-serif";
      context.textAlign = "right";
      context.fillText("OVERLOAD", rightX - BAND_WALL_THICKNESS, y - 6);
    }

    context.restore();
  }

  private drawParticles(context: CanvasRenderingContext2D, now: number, dt: number): void {
    if (this.particles.length === 0) {
      return;
    }

    context.save();
    context.globalCompositeOperation = "lighter";

    this.particles = this.particles.filter((particle) => {
      const age = (now - particle.born) / particle.life;

      if (age >= 1) {
        return false;
      }

      particle.vy += 520 * dt;
      particle.vx *= 1 - 1.8 * dt;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      context.globalAlpha = 1 - age;
      context.fillStyle = particle.color;
      context.fillRect(particle.x - particle.size / 2, particle.y - particle.size / 2, particle.size, particle.size);
      return true;
    });

    context.restore();
  }

  private drawPopups(context: CanvasRenderingContext2D, now: number): void {
    if (this.popups.length === 0) {
      return;
    }

    context.save();
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.lineJoin = "round";

    this.popups = this.popups.filter((popup) => {
      const age = (now - popup.born) / popup.life;

      if (age >= 1) {
        return false;
      }

      const pop = age < 0.12 ? 0.6 + (age / 0.12) * 0.5 : 1.1 - Math.min(0.1, (age - 0.12) * 0.5);
      const y = popup.y - 46 * Math.sqrt(age);
      context.globalAlpha = age > 0.7 ? (1 - age) / 0.3 : 1;
      context.font = `900 ${Math.round(popup.size * pop)}px Inter, 'Segoe UI', sans-serif`;
      context.lineWidth = 5;
      context.strokeStyle = "rgba(8, 10, 24, 0.85)";
      context.strokeText(popup.text, popup.x, y);
      context.shadowColor = popup.color;
      context.shadowBlur = 14;
      context.fillStyle = popup.color;
      context.fillText(popup.text, popup.x, y);
      context.shadowBlur = 0;
      return true;
    });

    context.restore();
  }

  private drawConductionPath(context: CanvasRenderingContext2D, bolt: Bolt): void {
    const nodes = bolt.pathNodes;
    const now = performance.now();
    const elapsed = now - this.flash.startedAt;
    const growth = Math.min(1, elapsed / (FLASH_DURATION_MS * 0.35));
    const fade = Math.min(1, (this.flash.until - now) / (FLASH_DURATION_MS * 0.25));
    const pulse = 0.75 + 0.25 * Math.sin(elapsed / 40);

    // The bolt creeps along block surfaces; a light jitter keeps it crackling without leaving the outline.
    const segments = bolt.route.map((segment) => ({
      air: segment.air,
      points: jitteredPolyline(segment.points, segment.air ? 0.8 : 0.3),
    }));
    const lengths = segments.map((segment) => polylineLength(segment.points));
    let visible = lengths.reduce((sum, length) => sum + length, 0) * growth;

    context.save();
    context.globalAlpha = fade;

    // Outline the blocks that make up the path as the bolt reaches them.
    context.lineJoin = "round";
    context.shadowBlur = 14;
    context.shadowColor = "#fff6a0";
    context.strokeStyle = "#fff6a0";
    context.fillStyle = "rgba(255, 246, 160, 0.28)";
    context.lineWidth = 3;

    for (const [index, node] of nodes.entries()) {
      if ((index + 1) / (nodes.length + 1) > growth) {
        break;
      }

      context.globalAlpha = fade * pulse;
      context.beginPath();

      for (const [vertexIndex, vertex] of node.part.vertices.entries()) {
        if (vertexIndex === 0) {
          context.moveTo(vertex.x, vertex.y);
        } else {
          context.lineTo(vertex.x, vertex.y);
        }
      }

      context.closePath();
      context.fill();
      context.stroke();
    }

    context.globalAlpha = fade;
    context.lineCap = "round";

    // Cyan-white along conductor surfaces, magenta where the discharge breaks down air.
    for (const [index, segment] of segments.entries()) {
      if (visible <= 0) {
        break;
      }

      const part = truncatePolyline(segment.points, Math.min(1, visible / Math.max(lengths[index], 1e-6)));
      visible -= lengths[index];

      context.shadowBlur = 18;
      context.shadowColor = segment.air ? "#ff5cf0" : "#7ce9ff";
      context.strokeStyle = segment.air ? "#ff5cf0" : "#7ce9ff";
      context.lineWidth = (segment.air ? 12 : 10) * (this.flash.high ? 1.5 : 1);
      this.strokePolyline(context, part, 0.7);
      context.shadowBlur = 0;
      context.strokeStyle = segment.air ? "#ffd6fb" : "#ffffff";
      context.lineWidth = segment.air ? 4 : 3.5;
      this.strokePolyline(context, part, 1);
    }

    if (growth >= 1 && this.params.debugOverlay) {
      this.drawAirLabels(context, bolt.arcs);
    }

    context.restore();
  }

  /** Debug: labels each air gap the discharge breaks down with its width and the kV it takes. */
  private drawAirLabels(context: CanvasRenderingContext2D, arcs: AirArc[]): void {
    context.save();
    context.shadowBlur = 0;
    context.font = "11px sans-serif";
    context.textAlign = "center";
    context.fillStyle = "#ffd6fb";

    for (const arc of arcs) {
      context.fillText(
        `${arc.length.toFixed(1)} px · ${(arc.length * AIR_BREAKDOWN_KV_PER_PX).toFixed(0)} kV`,
        (arc.from.x + arc.to.x) / 2,
        Math.min(arc.from.y, arc.to.y) - 8,
      );
    }

    context.restore();
  }

  private strokePolyline(context: CanvasRenderingContext2D, points: Array<{ x: number; y: number }>, alpha: number): void {
    context.save();
    context.globalAlpha *= alpha;
    context.beginPath();

    for (const [index, point] of points.entries()) {
      if (index === 0) {
        context.moveTo(point.x, point.y);
      } else {
        context.lineTo(point.x, point.y);
      }
    }

    context.stroke();
    context.restore();
  }

  private startViewTransform(): void {
    (
      Matter.Render as typeof Matter.Render & {
        startViewTransform(render: Matter.Render): void;
      }
    ).startViewTransform(this.render);
  }

  private endViewTransform(): void {
    (
      Matter.Render as typeof Matter.Render & {
        endViewTransform(render: Matter.Render): void;
      }
    ).endViewTransform(this.render);
  }
}
