/**
 * Per-camera live-stream quality control.
 * - User-selectable mode via an MQTT `select` (auto / 360p / 720p / 1080p).
 * - "auto" adapts to link health: downgrade one channel after repeated stalls,
 *   upgrade one channel after a sustained stable period (hysteresis).
 * G2H / E1 channel mapping: 0 = max (1080p), 1 = mid (720p), 2 = low (360p).
 * The effective channel is read at bridge construction; changing it requires
 * tearing down and recreating the bridge (handled by the caller).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { getDataDir } from "./state.js";

export type QualityMode = "auto" | "360p" | "720p" | "1080p";
export const QUALITY_OPTIONS: QualityMode[] = ["auto", "360p", "720p", "1080p"];

const CHANNEL: Record<string, number> = { "1080p": 0, "720p": 1, "360p": 2 };
const LABEL: Record<number, string> = { 0: "1080p", 1: "720p", 2: "360p" };

const STALLS_TO_DOWNGRADE = 3;
const UPGRADE_STABLE_MS = 120_000;

// Lossy-link detection: the native worker reports AVIO video sequence gaps as a
// cumulative counter. A weak link can keep delivering occasional keyframes (so
// `unhealthy` never fires and `onHealthy` keeps clearing the stall counter) while
// the picture is actually broken. Downgrade on gap RATE, independent of stalls.
const GAP_WINDOW_MS = 60_000;
const GAPS_TO_DOWNGRADE = 10;
const GAP_DOWNGRADE_COOLDOWN_MS = 60_000;

const mode = new Map<string, QualityMode>();
const channel = new Map<string, number>();
const stalls = new Map<string, number>();
const upgradeTimer = new Map<string, NodeJS.Timeout>();
const gapState = new Map<
  string,
  { last: number; windowStart: number; windowGaps: number; lastDowngrade: number }
>();

function qualityFile(): string {
  return path.join(getDataDir(), "quality.json");
}

export async function loadQuality(): Promise<void> {
  try {
    const raw = JSON.parse(await fs.readFile(qualityFile(), "utf8")) as Record<string, string>;
    for (const [did, m] of Object.entries(raw)) {
      if (QUALITY_OPTIONS.includes(m as QualityMode)) {
        mode.set(did, m as QualityMode);
        channel.set(did, m === "auto" ? 0 : CHANNEL[m]);
      }
    }
  } catch {
    /* no persisted quality yet -> defaults */
  }
}

async function persist(): Promise<void> {
  const obj: Record<string, string> = {};
  for (const [did, m] of mode) obj[did] = m;
  try {
    await fs.writeFile(qualityFile(), JSON.stringify(obj));
  } catch {
    /* best effort */
  }
}

export function getMode(did: string): QualityMode {
  return mode.get(did) ?? "auto";
}

export function getChannel(did: string): number {
  return channel.get(did) ?? 0;
}

/** Human label of the channel actually in use (for the effective-quality sensor). */
export function getEffective(did: string): string {
  return LABEL[getChannel(did)] ?? "1080p";
}

export async function setMode(did: string, m: QualityMode): Promise<void> {
  mode.set(did, m);
  channel.set(did, m === "auto" ? 0 : CHANNEL[m]);
  stalls.set(did, 0);
  gapState.delete(did);
  clearUpgrade(did);
  await persist();
}

function clearUpgrade(did: string): void {
  const t = upgradeTimer.get(did);
  if (t) {
    clearTimeout(t);
    upgradeTimer.delete(did);
  }
}

/**
 * Record a stall. In auto mode, downgrade one channel after enough consecutive
 * stalls. Returns true when the effective channel changed (caller must restart).
 */
export function onStall(did: string): boolean {
  clearUpgrade(did);
  if (getMode(did) !== "auto") return false;
  const n = (stalls.get(did) ?? 0) + 1;
  stalls.set(did, n);
  const cur = getChannel(did);
  if (n >= STALLS_TO_DOWNGRADE && cur < 2) {
    channel.set(did, cur + 1);
    stalls.set(did, 0);
    console.log(`[Quality:${did}] auto downgrade -> ${LABEL[cur + 1]} after ${n} stalls`);
    return true;
  }
  return false;
}

/**
 * Record an AVIO sequence-gap observation (cumulative counter from the native
 * worker). Detects the lossy-but-never-stalled mode that `onStall` misses: enough
 * new gaps within a sliding window means the link cannot sustain the current
 * channel, so downgrade one step. Independent of the keyframe-reset stall counter
 * so periodic keyframes cannot mask sustained loss. Returns true when the
 * effective channel changed (caller must restart the bridge).
 */
export function onGap(did: string, cumulative: number): boolean {
  if (getMode(did) !== "auto") return false;
  const now = Date.now();
  const s = gapState.get(did);
  if (!s || cumulative < s.last) {
    // First observation, or the worker restarted and reset its counter.
    gapState.set(did, { last: cumulative, windowStart: now, windowGaps: 0, lastDowngrade: 0 });
    return false;
  }
  const delta = cumulative - s.last;
  s.last = cumulative;
  if (now - s.windowStart > GAP_WINDOW_MS) {
    s.windowStart = now;
    s.windowGaps = 0;
  }
  s.windowGaps += delta;
  const cur = getChannel(did);
  if (
    s.windowGaps >= GAPS_TO_DOWNGRADE &&
    cur < 2 &&
    now - s.lastDowngrade >= GAP_DOWNGRADE_COOLDOWN_MS
  ) {
    const observed = s.windowGaps;
    s.lastDowngrade = now;
    s.windowStart = now;
    s.windowGaps = 0;
    channel.set(did, cur + 1);
    stalls.set(did, 0);
    clearUpgrade(did);
    console.log(
      `[Quality:${did}] auto downgrade -> ${LABEL[cur + 1]} after ${observed} sequence gaps/${GAP_WINDOW_MS / 1000}s (lossy link)`,
    );
    return true;
  }
  return false;
}

/**
 * Record healthy progress. In auto mode, schedule a one-step upgrade after a
 * sustained stable period; onChange fires (once) if the channel actually changes.
 */
export function onHealthy(did: string, onChange: () => void): void {
  if (getMode(did) !== "auto") return;
  stalls.set(did, 0);
  if (getChannel(did) <= 0) return;
  if (upgradeTimer.has(did)) return;
  const t = setTimeout(() => {
    upgradeTimer.delete(did);
    if (getMode(did) !== "auto") return;
    const cur = getChannel(did);
    if (cur > 0) {
      channel.set(did, cur - 1);
      console.log(`[Quality:${did}] auto upgrade -> ${LABEL[cur - 1]} after stable period`);
      onChange();
    }
  }, UPGRADE_STABLE_MS);
  t.unref();
  upgradeTimer.set(did, t);
}
