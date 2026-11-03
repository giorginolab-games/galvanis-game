import * as Matter from "matter-js";
import {
  AIR_BREAKDOWN_KV_PER_PX,
  BAND_WALL_THICKNESS,
  FLASH_DURATION_MS,
  FLASH_TIMEOUT_BUFFER_MS,
  SETTLE_CONFIRM_MS,
  SPAWN_Y,
  TETROMINO_NAMES,
  WALL_THICKNESS,
} from "./constants";
import { getUiRefs, syncLabels } from "./dom";
import { findLeftRightPath, jitteredPolyline, polylineLength, truncatePolyline } from "./pathfinding";
import { freezeTetromino, isTetrominoBody, makeTetromino, sleepTetromino, wakeTetromino } from "./pieces";
import type { AirArc, FlashState, PathNode, StageSize, TetrominoBody, TetrominoName, UiRefs } from "./types";

type BandWalls = {
  left: Matter.Body | null;
  right: Matter.Body | null;
};

export class GalvanisGame {
  private readonly ui: UiRefs;
  private readonly engine: Matter.Engine;
  private readonly runner: Matter.Runner;
  private readonly render: Matter.Render;
  private readonly keyState = new Set<string>();
  private readonly viewport: StageSize = { width: 1, height: 1 };
  private readonly uiAbort = new AbortController();

  private walls: Matter.Body[] = [];
  private bandWalls: BandWalls = { left: null, right: null };
  private pieceCount = 0;
  private activePiece: TetrominoBody | null = null;
  private gameOver = false;
  private isPaused = false;
  private firstContactTime: number | null = null;
  private isResolvingTurn = false;
  private isSettlingAfterFlash = false;
  private settledSince: number | null = null;
  private flash: FlashState = { points: null, until: 0, startedAt: 0, leftX: 0, rightX: 0, pathNodes: null, arcs: [], route: [] };
  private flashTimer: number | null = null;
  private resizeObserver: ResizeObserver | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.keyState.add(event.code);

    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(event.code)) {
      event.preventDefault();
    }

    if (event.code === "Space") {
      this.hardDrop();
    }
  };

  private readonly onBlur = (): void => {
    this.keyState.clear();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.keyState.delete(event.code);
  };

  private readonly onTick = (): void => {
    if (this.gameOver || this.isPaused) {
      return;
    }

    const now = performance.now();

    if (this.flash.points && now >= this.flash.until) {
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

          this.resumeAfterTurnResolution();
        }
      } else {
        this.settledSince = null;
      }
    } else if (this.isResolvingTurn && !this.flash.points && !this.activePiece) {
      this.resumeAfterTurnResolution();
    }

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

      if (isLanding) {
        this.firstContactTime ??= performance.now();
      }
    }
  };

  private readonly onAfterRender = (): void => {
    const { context } = this.render;
    const { leftX, rightX } = this.getBandBounds();

    this.startViewTransform();

    if (this.ui.showBand.input.checked) {
      context.save();
      context.globalAlpha = 0.08;
      context.fillStyle = "#66b0ff";
      context.fillRect(leftX, 0, rightX - leftX, this.viewport.height);
      context.globalAlpha = 0.8;
      context.strokeStyle = "#3aa0ff";
      context.lineWidth = 2;
      context.setLineDash([6, 6]);
      context.beginPath();
      context.moveTo(leftX, 0);
      context.lineTo(leftX, this.viewport.height);
      context.stroke();
      context.beginPath();
      context.moveTo(rightX, 0);
      context.lineTo(rightX, this.viewport.height);
      context.stroke();

      // Longest air gap the applied voltage can break down.
      const reach = Number(this.ui.voltage.input.value) / AIR_BREAKDOWN_KV_PER_PX;

      if (reach > 0) {
        context.globalAlpha = 0.5;
        context.strokeStyle = "#9fe870";
        context.lineWidth = 1.5;
        context.setLineDash([4, 4]);
        context.beginPath();
        context.moveTo(leftX + BAND_WALL_THICKNESS / 2 + reach, 0);
        context.lineTo(leftX + BAND_WALL_THICKNESS / 2 + reach, this.viewport.height);
        context.stroke();
        context.beginPath();
        context.moveTo(rightX - BAND_WALL_THICKNESS / 2 - reach, 0);
        context.lineTo(rightX - BAND_WALL_THICKNESS / 2 - reach, this.viewport.height);
        context.stroke();
      }

      context.setLineDash([]);
      context.restore();
    }

    if (this.flash.pathNodes && performance.now() < this.flash.until) {
      this.drawConductionPath(context, this.flash.pathNodes);
    }

    this.endViewTransform();
  };

  constructor() {
    this.ui = getUiRefs();
    this.measureStage();
    this.engine = Matter.Engine.create({ enableSleeping: true });
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
      },
    });

    this.engine.gravity.y = Number(this.ui.gravityY.input.value);
    this.setRenderBounds();
    this.bindUi();
    this.bindRuntimeEvents();
    syncLabels(this.ui);
    this.makeWalls();
    this.updateBandWalls();
  }

  start(): void {
    Matter.Render.run(this.render);
    Matter.Runner.run(this.runner, this.engine);
    this.attachResizeHandling();
    this.startNextTurn();
    this.updateStatusLabel();
  }

  destroy(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
    }

    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onBlur);
    this.uiAbort.abort();
    Matter.Events.off(this.engine, "collisionStart", this.onCollisionStart);
    Matter.Events.off(this.runner, "tick", this.onTick);
    Matter.Events.off(this.render, "afterRender", this.onAfterRender);
    window.removeEventListener("resize", this.handleResize);
    this.resizeObserver?.disconnect();
    Matter.Render.stop(this.render);
    Matter.Runner.stop(this.runner);
  }

  private bindUi(): void {
    const { signal } = this.uiAbort;

    this.ui.gravityY.input.addEventListener("input", () => {
      this.engine.gravity.y = Number(this.ui.gravityY.input.value);
      syncLabels(this.ui);
    }, { signal });

    for (const control of [
      this.ui.friction.input,
      this.ui.rest.input,
      this.ui.blockSize.input,
      this.ui.lockDelay.input,
      this.ui.insulatingChance.input,
      this.ui.bandX.input,
      this.ui.voltage.input,
    ]) {
      control.addEventListener("input", () => {
        syncLabels(this.ui);

        if (control === this.ui.bandX.input) {
          this.updateBandWalls();
        }
      }, { signal });
    }

    this.ui.sleeping.input.addEventListener("change", () => {
      this.engine.enableSleeping = this.ui.sleeping.input.checked;

      if (this.activePiece) {
        Matter.Sleeping.set(this.activePiece, false);
      }
    }, { signal });

    this.ui.resetBtn.addEventListener("click", () => this.reset(), { signal });
    this.ui.pauseBtn.addEventListener("click", () => this.togglePause(), { signal });
    this.ui.spawnBtn.addEventListener("click", () => {
      if (!this.activePiece && !this.isResolvingTurn && !this.isPaused) {
        this.spawnRandom();
      }
    }, { signal });
    this.ui.scanBtn.addEventListener("click", () => this.triggerScanAndFlash(), { signal });
  }

  private bindRuntimeEvents(): void {
    Matter.Events.on(this.engine, "collisionStart", this.onCollisionStart);
    Matter.Events.on(this.runner, "tick", this.onTick);
    Matter.Events.on(this.render, "afterRender", this.onAfterRender);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onBlur);
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
  }

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
    const floor = Matter.Bodies.rectangle(width / 2, height + thickness / 2 - 8, width + thickness * 2, thickness, {
      isStatic: true,
      render: { fillStyle: "#0a0d22" },
    });
    const left = Matter.Bodies.rectangle(-thickness / 2 + 8, height / 2, thickness, height * 2, {
      isStatic: true,
      render: { fillStyle: "#0a0d22" },
    });
    const right = Matter.Bodies.rectangle(width + thickness / 2 - 8, height / 2, thickness, height * 2, {
      isStatic: true,
      render: { fillStyle: "#0a0d22" },
    });
    const ceiling = Matter.Bodies.rectangle(width / 2, -thickness / 2, width + thickness * 2, thickness, {
      isStatic: true,
      render: { fillStyle: "#0a0d22" },
    });

    this.walls = [floor, left, right, ceiling];
    Matter.World.add(this.engine.world, this.walls);
  }

  private getBandBounds(): { leftX: number; rightX: number } {
    const bandHalfWidth = Number(this.ui.bandX.input.value);
    const center = this.viewport.width / 2;

    return {
      leftX: center - bandHalfWidth,
      rightX: center + bandHalfWidth,
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

    const leftWall = Matter.Bodies.rectangle(
      leftX,
      this.viewport.height / 2,
      BAND_WALL_THICKNESS,
      this.viewport.height * 2,
      wallOptions,
    );
    const rightWall = Matter.Bodies.rectangle(
      rightX,
      this.viewport.height / 2,
      BAND_WALL_THICKNESS,
      this.viewport.height * 2,
      wallOptions,
    );

    this.bandWalls = {
      left: leftWall,
      right: rightWall,
    };

    Matter.World.add(this.engine.world, [leftWall, rightWall]);
  }

  private togglePause(): void {
    this.isPaused = !this.isPaused;

    if (this.isPaused) {
      Matter.Runner.stop(this.runner);
      this.ui.pauseBtn.textContent = "Resume";
    } else {
      Matter.Runner.run(this.runner, this.engine);
      this.ui.pauseBtn.textContent = "Pause";
    }

    this.updateStatusLabel();
  }

  private reset(): void {
    for (const body of Matter.Composite.allBodies(this.engine.world)) {
      if (!body.isStatic || isTetrominoBody(body)) {
        Matter.World.remove(this.engine.world, body);
      }
    }

    this.clearFlash();
    this.makeWalls();
    this.updateBandWalls();
    this.pieceCount = 0;
    this.activePiece = null;
    this.gameOver = false;
    this.firstContactTime = null;
    this.isResolvingTurn = false;
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.ui.pieceCount.textContent = "0";
    this.ui.activeName.textContent = "-";
    this.startNextTurn();
    this.updateStatusLabel();
  }

  private startNextTurn(): void {
    if (this.gameOver || this.activePiece || this.isResolvingTurn) {
      return;
    }

    this.spawnRandom();
  }

  private spawnRandom(): void {
    if (this.gameOver) {
      return;
    }

    const name = TETROMINO_NAMES[Math.floor(Math.random() * TETROMINO_NAMES.length)] as TetrominoName;
    const piece = makeTetromino(
      name,
      this.viewport.width / 2,
      SPAWN_Y,
      Number(this.ui.blockSize.input.value),
      Number(this.ui.friction.input.value),
      Number(this.ui.rest.input.value),
      Math.random() < Number(this.ui.insulatingChance.input.value) / 100,
    );

    Matter.World.add(this.engine.world, piece);
    this.activePiece = piece;
    this.pieceCount += 1;
    this.ui.pieceCount.textContent = String(this.pieceCount);
    this.ui.activeName.textContent = name;
    this.updateStatusLabel();
    Matter.Body.setVelocity(piece, { x: (Math.random() - 0.5) * 0.5, y: 0 });
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
    if (!this.activePiece) {
      return;
    }

    Matter.Body.applyForce(this.activePiece, this.activePiece.position, { x: 0, y: 0.08 });
  }

  private considerLocking(): void {
    if (!this.activePiece || this.isResolvingTurn || this.gameOver || this.firstContactTime === null) {
      return;
    }

    if (this.activePiece.speed >= 0.4) {
      return;
    }

    const elapsed = performance.now() - this.firstContactTime;

    if (elapsed < Number(this.ui.lockDelay.input.value)) {
      return;
    }

    if (this.ui.freezeBlocks.input.checked) {
      freezeTetromino(this.activePiece);
    }

    const lockedPiece = this.activePiece;
    this.activePiece = null;
    this.ui.activeName.textContent = "-";
    this.firstContactTime = null;

    if (this.isNearSpawnHeight(lockedPiece)) {
      this.setGameOver();
      return;
    }

    this.isResolvingTurn = true;
    this.updateStatusLabel();
    this.triggerScanAndFlash();
  }

  private isNearSpawnHeight(body: Matter.Body): boolean {
    return body.bounds.min.y <= SPAWN_Y + Number(this.ui.blockSize.input.value) * 1.25;
  }

  private hasTopOutTetromino(): boolean {
    return Matter.Composite.allBodies(this.engine.world).some((body) => isTetrominoBody(body) && this.isNearSpawnHeight(body));
  }

  private setGameOver(): void {
    this.gameOver = true;
    this.activePiece = null;
    this.firstContactTime = null;
    this.isResolvingTurn = false;
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.ui.activeName.textContent = "-";
    this.updateStatusLabel();
  }

  private resumeAfterTurnResolution(): void {
    this.isSettlingAfterFlash = false;
    this.settledSince = null;
    this.isResolvingTurn = false;
    this.updateStatusLabel();

    if (!this.activePiece) {
      this.startNextTurn();
    }
  }

  private triggerScanAndFlash(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }

    const result = findLeftRightPath(
      this.engine.world,
      this.viewport,
      Number(this.ui.bandX.input.value),
      Number(this.ui.voltage.input.value),
    );

    if (!result) {
      this.clearFlash();

      if (this.isResolvingTurn) {
        this.resumeAfterTurnResolution();
      }

      return;
    }

    this.flash.points = result.route.flatMap((segment) => segment.points);
    this.flash.startedAt = performance.now();
    this.flash.until = this.flash.startedAt + FLASH_DURATION_MS;
    this.flash.leftX = result.leftX;
    this.flash.rightX = result.rightX;
    this.flash.pathNodes = result.pathNodes;
    this.flash.arcs = result.arcs;
    this.flash.route = result.route;
    this.flashTimer = window.setTimeout(() => {
      // While paused, leave the flash for onTick to finish after resume.
      if (!this.isPaused) {
        this.finishFlash();
      }
    }, FLASH_DURATION_MS + FLASH_TIMEOUT_BUFFER_MS);
  }

  private finishFlash(): void {
    if (this.flashTimer !== null) {
      window.clearTimeout(this.flashTimer);
      this.flashTimer = null;
    }

    let erased = false;

    if (this.flash.pathNodes && this.ui.eraseOnPath.input.checked) {
      const parents = new Set(this.flash.pathNodes.map((node) => node.parent));

      for (const parent of parents) {
        Matter.World.remove(this.engine.world, parent);
      }

      erased = parents.size > 0;
    }

    this.flash.pathNodes = null;
    this.flash.arcs = [];
    this.flash.route = [];
    this.flash.points = null;
    this.flash.until = 0;

    if (erased || this.isResolvingTurn) {
      this.wakeTetrominoesAfterFlash();
    }

    if (this.isResolvingTurn) {
      this.isSettlingAfterFlash = true;
      this.settledSince = null;
      this.updateStatusLabel();
    }
  }

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

    this.flash = { points: null, until: 0, startedAt: 0, leftX: 0, rightX: 0, pathNodes: null, arcs: [], route: [] };
  }

  private updateStatusLabel(): void {
    this.ui.gameOverOverlay.hidden = !this.gameOver;
    this.ui.gameState.textContent = this.gameOver
      ? "Game Over"
      : this.isPaused
        ? "Paused"
        : this.isResolvingTurn
          ? "Resolving"
          : "Running";
  }

  private drawConductionPath(context: CanvasRenderingContext2D, nodes: PathNode[]): void {
    const now = performance.now();
    const elapsed = now - this.flash.startedAt;
    const growth = Math.min(1, elapsed / (FLASH_DURATION_MS * 0.35));
    const fade = Math.min(1, (this.flash.until - now) / (FLASH_DURATION_MS * 0.25));
    const pulse = 0.75 + 0.25 * Math.sin(elapsed / 40);

    // The bolt creeps along block surfaces; a light jitter keeps it crackling without leaving the outline.
    const segments = this.flash.route.map((segment) => ({
      air: segment.air,
      points: jitteredPolyline(segment.points, segment.air ? 0.8 : 0.3),
    }));
    const lengths = segments.map((segment) => polylineLength(segment.points));
    let visible = lengths.reduce((sum, length) => sum + length, 0) * growth;

    context.save();
    context.globalAlpha = fade;

    // Outline the blocks that make up the shortest path as the bolt reaches them.
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
      context.lineWidth = segment.air ? 12 : 10;
      this.strokePolyline(context, part, 0.7);
      context.shadowBlur = 0;
      context.strokeStyle = segment.air ? "#ffd6fb" : "#ffffff";
      context.lineWidth = segment.air ? 4 : 3.5;
      this.strokePolyline(context, part, 1);
    }

    if (growth >= 1) {
      this.drawAirLabels(context, this.flash.arcs);
    }

    context.restore();
  }

  /** Labels each air gap the discharge breaks down with its width and the kV it takes. */
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
