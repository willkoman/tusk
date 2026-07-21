import { type Accessor, For, Match, Show, Switch, createSignal } from "solid-js";
import { Dialog } from "../Dialog";
import { type EditorPrefs } from "../editor/types";
import { type DialectId } from "../sql/dialects";
import { THEMES } from "../themes";
import { SlackPane } from "./SlackPane";
import { AiPane } from "./AiPane";
import { crashConsent, setCrashConsent } from "../store";

export type SettingsTab = "editor" | "appearance" | "grid" | "plans" | "ai" | "slack" | "shortcuts" | "privacy";

const TABS: { id: SettingsTab; label: string }[] = [
  { id: "editor", label: "Editor" },
  { id: "appearance", label: "Appearance" },
  { id: "grid", label: "Grid" },
  { id: "plans", label: "Plans" },
  { id: "ai", label: "AI" },
  { id: "slack", label: "Slack" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "privacy", label: "Privacy" },
];

const FONT_PRESETS = ["JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", "Menlo", "Consolas", "Courier New"];
const ACCENT_PRESETS = ["#3b82f6", "#2dd4bf", "#a78bfa", "#f472b6", "#fb923c", "#3fb950"];

/**
 * Tabbed settings modal. Every control applies live through `update` (the same
 * `updatePrefs` the toolbar quick-toggles use — persisted + flows through the
 * editor's CodeMirror compartments), so there's no OK/Cancel.
 */
export function SettingsDialog(props: {
  prefs: Accessor<EditorPrefs>;
  update: (patch: Partial<EditorPrefs>) => void;
  onClose: () => void;
  initialTab?: SettingsTab;
  /** Connected → the dialect pref is overridden by the driver; show it disabled. */
  connected: boolean;
  /** Connected database name — scopes database-level AI skills. "" when disconnected. */
  database: string;
  /** Rendered inside the Shortcuts tab (lands with the keymap feature). */
  shortcutsPane?: () => any;
}) {
  const [tab, setTab] = createSignal<SettingsTab>(props.initialTab ?? "editor");
  const p = props.prefs;

  // The AI tab holds provider cards and a Markdown skill editor; 680px starves both.
  // Every other tab is label+control rows and reads better narrow.
  const width = () => (tab() === "ai" ? 900 : 680);

  return (
    <Dialog title="Settings" width={width()} onClose={props.onClose}>
      <div class="settings-body">
        <div class="settings-rail">
          <For each={TABS}>
            {(t) => (
              <button class="settings-tab" classList={{ active: tab() === t.id }} onClick={() => setTab(t.id)}>
                {t.label}
              </button>
            )}
          </For>
        </div>
        <div class="settings-pane">
          <Switch>
            <Match when={tab() === "editor"}>
              <label class="settings-row">
                <span>Font size</span>
                <input
                  type="number"
                  min="9"
                  max="24"
                  value={p().fontSize}
                  onChange={(e) => {
                    const v = Math.max(9, Math.min(24, Number(e.currentTarget.value) || 13));
                    props.update({ fontSize: v });
                  }}
                />
              </label>
              <label class="settings-row">
                <span>Word wrap</span>
                <input type="checkbox" checked={p().wordWrap} onChange={(e) => props.update({ wordWrap: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span>Auto-fold large literals</span>
                <input type="checkbox" checked={p().autoFold} onChange={(e) => props.update({ autoFold: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span>Server-side lint (PREPARE-only)</span>
                <input type="checkbox" checked={p().serverLint} onChange={(e) => props.update({ serverLint: e.currentTarget.checked })} />
              </label>
              <label class="settings-row" title={props.connected ? "While connected, the dialect follows the driver" : undefined}>
                <span>SQL dialect{props.connected ? " (follows connection)" : ""}</span>
                <select
                  disabled={props.connected}
                  value={p().dialect}
                  onChange={(e) => props.update({ dialect: e.currentTarget.value as DialectId })}
                >
                  <option value="postgres">PostgreSQL</option>
                  <option value="mysql">MySQL</option>
                  <option value="sqlite">SQLite</option>
                  <option value="mssql">MS SQL</option>
                </select>
              </label>
            </Match>

            <Match when={tab() === "appearance"}>
              <label class="settings-row">
                <span>Theme</span>
                <select value={p().theme} onChange={(e) => props.update({ theme: e.currentTarget.value as EditorPrefs["theme"] })}>
                  <optgroup label="Dark">
                    <For each={THEMES.filter((t) => t.dark)}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                  </optgroup>
                  <optgroup label="Light">
                    <For each={THEMES.filter((t) => !t.dark)}>{(t) => <option value={t.id}>{t.label}</option>}</For>
                  </optgroup>
                  <option value="system">Follow system</option>
                </select>
              </label>
              <label class="settings-row">
                <span>Editor / grid font</span>
                <span class="settings-inline">
                  <input
                    type="text"
                    list="tusk-font-presets"
                    placeholder="default (JetBrains Mono)"
                    value={p().fontFamily}
                    onChange={(e) => props.update({ fontFamily: e.currentTarget.value.trim() })}
                  />
                  <datalist id="tusk-font-presets">
                    <For each={FONT_PRESETS}>{(f) => <option value={f} />}</For>
                  </datalist>
                  <Show when={p().fontFamily}>
                    <button class="ghost" onClick={() => props.update({ fontFamily: "" })}>Reset</button>
                  </Show>
                </span>
              </label>
              <label class="settings-row">
                <span>Accent color</span>
                <span class="settings-inline">
                  <input type="color" value={p().accent} onChange={(e) => props.update({ accent: e.currentTarget.value })} />
                  <For each={ACCENT_PRESETS}>
                    {(c) => (
                      <button
                        class="accent-swatch"
                        classList={{ active: p().accent === c }}
                        style={{ background: c }}
                        title={c}
                        onClick={() => props.update({ accent: c })}
                      />
                    )}
                  </For>
                </span>
              </label>
            </Match>

            <Match when={tab() === "grid"}>
              <label class="settings-row">
                <span>Row density</span>
                <select value={p().gridDensity} onChange={(e) => props.update({ gridDensity: e.currentTarget.value as EditorPrefs["gridDensity"] })}>
                  <option value="normal">Normal</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label class="settings-row">
                <span>Zebra striping</span>
                <input type="checkbox" checked={p().gridZebra} onChange={(e) => props.update({ gridZebra: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span>NULL cells show</span>
                <select value={p().gridNullStyle} onChange={(e) => props.update({ gridNullStyle: e.currentTarget.value as EditorPrefs["gridNullStyle"] })}>
                  <option value="null">NULL</option>
                  <option value="empty">(empty)</option>
                  <option value="dash">—</option>
                </select>
              </label>
              <label class="settings-row">
                <span>Default column width</span>
                <input
                  type="number"
                  min="48"
                  max="900"
                  step="10"
                  value={p().gridColWidth}
                  onChange={(e) => {
                    const v = Math.max(48, Math.min(900, Number(e.currentTarget.value) || 180));
                    props.update({ gridColWidth: v });
                  }}
                />
              </label>
              <label class="settings-row">
                <span>Copy with column names</span>
                <input type="checkbox" checked={p().copyHeaders} onChange={(e) => props.update({ copyHeaders: e.currentTarget.checked })} />
              </label>
            </Match>

            <Match when={tab() === "plans"}>
              <label class="settings-row">
                <span>Tree orientation</span>
                <select value={p().planOrientation} onChange={(e) => props.update({ planOrientation: e.currentTarget.value as EditorPrefs["planOrientation"] })}>
                  <option value="vertical">Top-down</option>
                  <option value="horizontal">Left-to-right</option>
                </select>
              </label>
              <label class="settings-row">
                <span>Heat coloring by</span>
                <select value={p().planHeat} onChange={(e) => props.update({ planHeat: e.currentTarget.value as EditorPrefs["planHeat"] })}>
                  <option value="cost">Cost</option>
                  <option value="time">Actual time</option>
                  <option value="rows">Rows</option>
                  <option value="off">Off</option>
                </select>
              </label>
              <label class="settings-row">
                <span>Node detail</span>
                <select value={p().planDensity} onChange={(e) => props.update({ planDensity: e.currentTarget.value as EditorPrefs["planDensity"] })}>
                  <option value="normal">Normal (metrics on cards)</option>
                  <option value="compact">Compact (labels only)</option>
                </select>
              </label>
              <div class="settings-note">
                The plan view appears automatically when a result is an EXPLAIN output, and via the Explain toolbar action. Raw engine output stays available under the Grid toggle.
              </div>
            </Match>

            <Match when={tab() === "ai"}>
              <AiPane database={props.database} />
            </Match>
            <Match when={tab() === "slack"}>
              <SlackPane />
            </Match>

            <Match when={tab() === "shortcuts"}>
              <Show when={props.shortcutsPane} fallback={<div class="settings-note">Keyboard shortcut customization coming soon.</div>}>
                {props.shortcutsPane!()}
              </Show>
            </Match>

            <Match when={tab() === "privacy"}>
              <label class="settings-row">
                <span>Offer crash reports after a crash</span>
                <input
                  type="checkbox"
                  checked={crashConsent() === "on"}
                  onChange={(e) => setCrashConsent(e.currentTarget.checked ? "on" : "off")}
                />
              </label>
              <div class="settings-note">
                When on, a crash (or a crash recovered from the previous run) shows its details with
                one-click copy/email actions. When off, Tusk recovers quietly and clears prior-run
                reports unshown. Nothing is ever transmitted automatically in either mode — sending a
                report is always an explicit action, and reports never intentionally include connection
                settings, credentials, or saved queries.
              </div>
              <div class="settings-note">
                Also here: the AI tab's "share sample rows" toggle controls whether real table values
                are sent to your AI provider, and Slack tokens/AI keys live only in the OS keychain.
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  );
}
