/**
 * The monitor's amber/red thresholds, shared by every Monitor tab and set in
 * Settings → Monitor. Persisted per machine (`tusk.monitor.thresholds`); an
 * unreadable or out-of-range value falls back to the default, never to "no warning".
 */

import { createSignal } from "solid-js";
import { DEFAULT_THRESHOLDS, normalizeThresholds, type MonitorThresholds } from "./model";

const KEY = "tusk.monitor.thresholds";

function load(): MonitorThresholds {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw || raw.length > 4096) return { ...DEFAULT_THRESHOLDS };
    return normalizeThresholds(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_THRESHOLDS };
  }
}

const [thresholds, setThresholds] = createSignal<MonitorThresholds>(load());

export const monitorThresholds = thresholds;

/** Apply (and persist) new thresholds; false when they could not be saved. */
export function setMonitorThresholds(next: Partial<MonitorThresholds>): boolean {
  const value = normalizeThresholds({ ...thresholds(), ...next });
  setThresholds(value);
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function resetMonitorThresholds(): boolean {
  setThresholds({ ...DEFAULT_THRESHOLDS });
  try {
    localStorage.removeItem(KEY);
    return true;
  } catch {
    return false;
  }
}
