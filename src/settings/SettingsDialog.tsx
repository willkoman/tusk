import { type Accessor, For, Match, Show, Switch, createSignal } from "solid-js";
import { Dialog, type DialogSize } from "../Dialog";
import { type EditorPrefs } from "../editor/types";
import { type DialectId } from "../sql/dialects";
import { SlackPane, type SlackConnectionOption } from "./SlackPane";
import { AiPane } from "./AiPane";
import { AppearancePane } from "./AppearancePane";
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
  /** Open connections, so Settings → Slack can point the bot at one of them. */
  connections?: () => SlackConnectionOption[];
  /** The connection the workbench has focused (the default a fresh bot start binds to). */
  activeConnectionId?: () => string | null;
}) {
  const [tab, setTab] = createSignal<SettingsTab>(props.initialTab ?? "editor");
  const p = props.prefs;

  // The AI tab holds provider cards and a Markdown skill editor; the lg tier starves
  // both. Every other tab is label+control rows and reads better narrow.
  const size = (): DialogSize => (tab() === "ai" ? "xl" : "lg");

  return (
    <Dialog title="Settings" size={size()} noAutoFocus onClose={props.onClose}>
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
              {/* Font size and line height moved to Appearance → Editor text. */}
              <label class="settings-row">
                <span class="settings-label">
                  <span>Word wrap</span>
                  <small>Wrap long lines instead of scrolling sideways.</small>
                </span>
                <input type="checkbox" checked={p().wordWrap} onChange={(e) => props.update({ wordWrap: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span class="settings-label">
                  <span>Auto-fold large literals</span>
                  <small>Collapses long strings and arrays on screen. The query text is unchanged.</small>
                </span>
                <input type="checkbox" checked={p().autoFold} onChange={(e) => props.update({ autoFold: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span class="settings-label">
                  <span>Check statements against the server</span>
                  <small>Prepares each statement to find errors before you run it.</small>
                </span>
                <input type="checkbox" checked={p().serverLint} onChange={(e) => props.update({ serverLint: e.currentTarget.checked })} />
              </label>
              <label class="settings-row" title={props.connected ? "The dialect follows the connected driver" : undefined}>
                <span class="settings-label">
                  <span>SQL dialect</span>
                  <small>{props.connected ? "Follows the connected driver." : "Used for highlighting and completion until you connect."}</small>
                </span>
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
              <AppearancePane prefs={props.prefs} update={props.update} />
            </Match>

            <Match when={tab() === "grid"}>
              <label class="settings-row">
                <span class="settings-label">
                  <span>Row density</span>
                  <small>Height of a result row.</small>
                </span>
                <select value={p().gridDensity} onChange={(e) => props.update({ gridDensity: e.currentTarget.value as EditorPrefs["gridDensity"] })}>
                  <option value="normal">Normal</option>
                  <option value="compact">Compact</option>
                </select>
              </label>
              <label class="settings-row">
                <span class="settings-label">
                  <span>Zebra striping</span>
                  <small>Tints alternate rows.</small>
                </span>
                <input type="checkbox" checked={p().gridZebra} onChange={(e) => props.update({ gridZebra: e.currentTarget.checked })} />
              </label>
              <label class="settings-row">
                <span class="settings-label">
                  <span>NULL cells show</span>
                  <small>What a SQL NULL looks like in the grid.</small>
                </span>
                <select value={p().gridNullStyle} onChange={(e) => props.update({ gridNullStyle: e.currentTarget.value as EditorPrefs["gridNullStyle"] })}>
                  <option value="null">NULL</option>
                  <option value="empty">(empty)</option>
                  <option value="dash">—</option>
                </select>
              </label>
              <label class="settings-row">
                <span class="settings-label">
                  <span>Fallback column width</span>
                  <small>Columns are sized from their content. This width is used when there is nothing to measure.</small>
                </span>
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
                <span class="settings-label">
                  <span>Copy with column names</span>
                  <small>Adds a header row to copied cells.</small>
                </span>
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
                The plan view opens for EXPLAIN results and from the Explain toolbar action. Raw engine output stays under the Grid toggle.
              </div>
            </Match>

            <Match when={tab() === "ai"}>
              <AiPane database={props.database} />
            </Match>
            <Match when={tab() === "slack"}>
              <SlackPane onOpenAi={() => setTab("ai")} connections={props.connections} activeConnectionId={props.activeConnectionId} />
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
                On: a crash shows its details with copy and email actions. Off: Tusk recovers
                quietly and clears prior reports. Reports exclude connection settings, credentials
                and saved queries.
              </div>
              <div class="settings-note">
                The AI tab's sample-row toggle controls whether real values reach your AI provider.
                Slack tokens and AI keys live only in the OS keychain.
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Dialog>
  );
}
