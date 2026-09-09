import { type Accessor, For, Show } from "solid-js";
import { DEFAULT_PREFS, type EditorPrefs } from "../editor/types";
import { THEMES } from "../themes";
import {
  DENSITIES,
  MAX_LINE_HEIGHT,
  MIN_LINE_HEIGHT,
  clampLineHeight,
  clampScale,
  scaleSteps,
} from "../appearance";

const FONT_PRESETS = ["JetBrains Mono", "Cascadia Code", "Fira Code", "SF Mono", "Menlo", "Consolas", "Courier New"];
const ACCENT_PRESETS = ["#3b82f6", "#2dd4bf", "#a78bfa", "#f472b6", "#fb923c", "#3fb950"];

/** The prefs this pane owns — the set "Reset to defaults" puts back. */
const OWNED = [
  "theme",
  "accent",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "density",
  "uiScale",
  "sidebarSide",
] as const;

/** Are all of this pane's prefs already at their defaults? */
export function isDefaultAppearance(prefs: EditorPrefs): boolean {
  return OWNED.every((k) => prefs[k] === DEFAULT_PREFS[k]);
}

/** The patch that resets this pane. Pure, so the button and the tests agree. */
export function appearanceDefaults(): Partial<EditorPrefs> {
  const patch: Partial<EditorPrefs> = {};
  for (const k of OWNED) (patch as Record<string, unknown>)[k] = DEFAULT_PREFS[k];
  return patch;
}

/**
 * Settings → Appearance. Every control applies live through `update`, the same
 * path the toolbar quick-toggles use.
 */
export function AppearancePane(props: {
  prefs: Accessor<EditorPrefs>;
  update: (patch: Partial<EditorPrefs>) => void;
}) {
  const p = props.prefs;

  return (
    <div class="appearance-pane">
      <section class="settings-section">
        <header class="settings-section-head">
          <h3 class="settings-section-title">Theme</h3>
        </header>
        <label class="settings-row">
          <span class="settings-label">
            <span>Theme</span>
            <small>Palette for the workbench, editor, and syntax highlighting.</small>
          </span>
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
          <span class="settings-label">
            <span>Accent color</span>
            <small>Tints buttons, selection, and focus rings.</small>
          </span>
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
      </section>

      <section class="settings-section">
        <header class="settings-section-head">
          <h3 class="settings-section-title">Layout</h3>
        </header>
        <label class="settings-row">
          <span class="settings-label">
            <span>Density</span>
            <small>Row, tab, and control heights across the app.</small>
          </span>
          <select value={p().density} onChange={(e) => props.update({ density: e.currentTarget.value as EditorPrefs["density"] })}>
            <For each={DENSITIES}>{(d) => <option value={d.id}>{d.label}</option>}</For>
          </select>
        </label>
        <label class="settings-row">
          <span class="settings-label">
            <span>UI scale</span>
            <small>Scales interface text and controls. The editor keeps its own font size.</small>
          </span>
          <select value={String(p().uiScale)} onChange={(e) => props.update({ uiScale: clampScale(Number(e.currentTarget.value)) })}>
            <For each={scaleSteps()}>{(v) => <option value={String(v)}>{v}%</option>}</For>
          </select>
        </label>
        <label class="settings-row">
          <span class="settings-label">
            <span>Explorer side</span>
            <small>Which edge the Explorer sidebar docks to.</small>
          </span>
          <select value={p().sidebarSide} onChange={(e) => props.update({ sidebarSide: e.currentTarget.value as EditorPrefs["sidebarSide"] })}>
            <option value="left">Left</option>
            <option value="right">Right</option>
          </select>
        </label>
      </section>

      <section class="settings-section">
        <header class="settings-section-head">
          <h3 class="settings-section-title">Editor text</h3>
        </header>
        <label class="settings-row">
          <span class="settings-label">
            <span>Editor / grid font</span>
            <small>Monospace face for the editor and result cells. Blank uses the built-in stack.</small>
          </span>
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
          <span>Editor font size</span>
          <input
            type="number"
            min="9"
            max="24"
            value={p().fontSize}
            onChange={(e) => props.update({ fontSize: Math.max(9, Math.min(24, Number(e.currentTarget.value) || DEFAULT_PREFS.fontSize)) })}
          />
        </label>
        <label class="settings-row">
          <span>Editor line height</span>
          <input
            type="number"
            min={MIN_LINE_HEIGHT}
            max={MAX_LINE_HEIGHT}
            step="0.1"
            value={p().lineHeight}
            onChange={(e) => props.update({ lineHeight: clampLineHeight(Number(e.currentTarget.value)) })}
          />
        </label>
      </section>

      <div class="settings-actions">
        <span class="settings-hint">Restores theme, accent, fonts, density, scale, and Explorer side.</span>
        <span class="spacer" />
        <button class="ghost" disabled={isDefaultAppearance(p())} onClick={() => props.update(appearanceDefaults())}>
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
