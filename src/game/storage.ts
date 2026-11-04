export interface SavedData {
  best: number;
  sfx: boolean;
  music: boolean;
  tutorialSeen: boolean;
  hintsSeen: string[];
}

const KEY = "galvanis.v1";

const defaults = (): SavedData => ({ best: 0, sfx: true, music: true, tutorialSeen: false, hintsSeen: [] });

export function loadSaved(): SavedData {
  try {
    const raw = window.localStorage.getItem(KEY);
    return raw ? { ...defaults(), ...(JSON.parse(raw) as Partial<SavedData>) } : defaults();
  } catch {
    return defaults();
  }
}

export function saveData(data: SavedData): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    // Storage unavailable (private mode, blocked): progress just isn't kept.
  }
}
