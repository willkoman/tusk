import { For, Show, createSignal } from "solid-js";
import { DEFAULT_THRESHOLDS, type MonitorThresholds } from "../monitor/model";
import { monitorThresholds, resetMonitorThresholds, setMonitorThresholds } from "../monitor/thresholds";

type Field = { key: keyof MonitorThresholds; label: string; hint: string; unit: string; step: number; min: number; max: number };

const FIELDS: Field[] = [
  { key: "sessionsWarnPct", label: "Sessions — amber", hint: "Share of max_connections in use.", unit: "%", step: 1, min: 1, max: 100 },
  { key: "sessionsDangerPct", label: "Sessions — red", hint: "Share of max_connections in use.", unit: "%", step: 1, min: 1, max: 100 },
  { key: "oldestXactWarnMin", label: "Oldest transaction — amber", hint: "A long transaction holds back vacuum.", unit: "min", step: 1, min: 0.1, max: 10_080 },
  { key: "oldestXactDangerMin", label: "Oldest transaction — red", hint: "", unit: "min", step: 1, min: 0.1, max: 10_080 },
  { key: "blockedWarn", label: "Blocked sessions — amber", hint: "At or above this many sessions waiting on locks. 0 turns it off.", unit: "", step: 1, min: 0, max: 100_000 },
  { key: "lagWarnSec", label: "Replication lag — amber", hint: "0 turns it off.", unit: "s", step: 1, min: 0, max: 86_400 },
  { key: "cacheHitWarnPct", label: "Cache hit — amber below", hint: "Workloads differ widely; off (0) by default.", unit: "%", step: 0.5, min: 0, max: 100 },
  { key: "slotRetainedWarnGiB", label: "Inactive slot WAL — amber", hint: "WAL an inactive replication slot keeps. 0 turns it off.", unit: "GiB", step: 1, min: 0, max: 100_000 },
  { key: "wraparoundDangerHeadroomM", label: "Wraparound headroom — red", hint: "Transactions left before the 2³¹ limit.", unit: "M", step: 50, min: 1, max: 2_000 },
];

/** Settings → Monitor: where the Monitor tab's tiles and lists turn amber or red. */
export function MonitorPane() {
  const [notice, setNotice] = createSignal("");
  const t = monitorThresholds;
  const set = (key: keyof MonitorThresholds, input: HTMLInputElement) => {
    const value = input.valueAsNumber;
    if (Number.isFinite(value)) {
      setNotice(setMonitorThresholds({ [key]: value }) ? "" : "Could not save; the thresholds apply until Tusk restarts.");
    }
    // Show what was kept: a clamped, rejected or reordered value snaps back.
    input.value = String(t()[key]);
  };
  return (
    <>
      <For each={FIELDS}>
        {(f) => (
          <label class="settings-row">
            <span class="settings-label">
              <span>{f.label}</span>
              <small>{f.hint || `Default ${DEFAULT_THRESHOLDS[f.key]}${f.unit ? ` ${f.unit}` : ""}.`}</small>
            </span>
            <span class="settings-inline">
              <input
                type="number"
                min={f.min}
                max={f.max}
                step={f.step}
                value={t()[f.key]}
                onChange={(e) => set(f.key, e.currentTarget)}
              />
              <span class="settings-unit">{f.unit}</span>
            </span>
          </label>
        )}
      </For>
      <div class="settings-note">
        Amber means a number needs attention, red means trouble; nothing here is ever drawn green. Every Monitor tab uses these at once.
      </div>
      <div class="settings-actions">
        <button class="ghost" onClick={() => setNotice(resetMonitorThresholds() ? "" : "Could not save the reset.")}>Reset to defaults</button>
      </div>
      <Show when={notice()}><div class="error">{notice()}</div></Show>
    </>
  );
}
