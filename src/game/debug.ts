import { DIFFICULTY_KEYS, type BooleanParam, type NumericParam, type Params } from "./params";

interface RangeSpec {
  key: NumericParam;
  id: string;
  /** Input value = param * scale. */
  scale?: number;
  format: (value: number) => string;
}

const RANGES: RangeSpec[] = [
  { key: "gravityY", id: "gravityY", format: (v) => v.toFixed(2) },
  { key: "friction", id: "friction", format: (v) => v.toFixed(3) },
  { key: "restitution", id: "rest", format: (v) => v.toFixed(2) },
  { key: "blockSize", id: "blockSize", format: (v) => v.toFixed(0) },
  { key: "lockDelay", id: "lockDelay", format: (v) => v.toFixed(0) },
  { key: "insulatingChance", id: "insulatingChance", scale: 100, format: (v) => `${Math.round(v * 100)}%` },
  { key: "bandHalfWidth", id: "bandX", format: (v) => v.toFixed(0) },
  { key: "voltage", id: "voltage", format: (v) => v.toFixed(0) },
  { key: "highVoltage", id: "highVoltage", format: (v) => v.toFixed(0) },
];

const TOGGLES: Array<{ key: BooleanParam; id: string }> = [
  { key: "sleeping", id: "sleeping" },
  { key: "freezeBlocks", id: "freezeBlocks" },
  { key: "debugOverlay", id: "showBand" },
  { key: "eraseOnPath", id: "eraseOnPath" },
  { key: "autoDifficulty", id: "autoDifficulty" },
];

function byId<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);

  if (!element) {
    throw new Error(`Missing required element #${id}`);
  }

  return element as T;
}

/**
 * Developer panel: hidden unless the page is opened with `?debug` or toggled with the backquote key.
 * Edits `params` in place and reports which key changed.
 */
export class DebugPanel {
  private readonly panel = byId<HTMLElement>("debugPanel");
  private readonly stats = byId<HTMLElement>("debugStats");
  private readonly ranges = RANGES.map((spec) => ({
    spec,
    input: byId<HTMLInputElement>(spec.id),
    label: byId<HTMLElement>(`${spec.id}Val`),
  }));
  private readonly toggles = TOGGLES.map((spec) => ({ spec, input: byId<HTMLInputElement>(spec.id) }));

  constructor(
    private readonly params: Params,
    onChange: (key: keyof Params) => void,
    actions: { spawn: () => void; scan: () => void },
    signal: AbortSignal,
  ) {
    for (const { spec, input, label } of this.ranges) {
      input.addEventListener(
        "input",
        () => {
          this.params[spec.key] = Number(input.value) / (spec.scale ?? 1);
          label.textContent = spec.format(this.params[spec.key]);

          // Hand-tuning a level-driven value takes it out of the difficulty curve's hands.
          if ((DIFFICULTY_KEYS as readonly string[]).includes(spec.key) && this.params.autoDifficulty) {
            this.params.autoDifficulty = false;
            this.sync();
          }

          onChange(spec.key);
        },
        { signal },
      );
    }

    for (const { spec, input } of this.toggles) {
      input.addEventListener(
        "change",
        () => {
          this.params[spec.key] = input.checked;
          onChange(spec.key);
        },
        { signal },
      );
    }

    byId("spawnBtn").addEventListener("click", actions.spawn, { signal });
    byId("scanBtn").addEventListener("click", actions.scan, { signal });

    this.setVisible(new URLSearchParams(window.location.search).has("debug"));
    this.sync();
  }

  get visible(): boolean {
    return !this.panel.hidden;
  }

  setVisible(visible: boolean): void {
    this.panel.hidden = !visible;
  }

  toggle(): void {
    this.setVisible(!this.visible);
  }

  /** Writes current params back into the controls (after the difficulty curve changes them). */
  sync(): void {
    for (const { spec, input, label } of this.ranges) {
      input.value = String(this.params[spec.key] * (spec.scale ?? 1));
      label.textContent = spec.format(this.params[spec.key]);
    }

    for (const { spec, input } of this.toggles) {
      input.checked = this.params[spec.key];
    }
  }

  setStats(text: string): void {
    if (this.visible) {
      this.stats.textContent = text;
    }
  }
}
