// Settings → AI. Three sections, all self-contained (backend calls go through `commands`, like SlackPane):
//
//   Providers — a grid of tiles (mark, name, kind, status); the selected one opens below
//   it with two groups: **Connection** (key entry — never echoed back — API base, region,
//   origin approval, Bedrock's two planes, Test) and **Models** (the ONE model control:
//   `ModelMultiPicker`, where a checkbox = offered in the pickers and ★ = the provider's
//   default; fed by the live catalog once the provider is usable, else the shipped
//   fallback ids). Keys live in the OS keychain, one account per provider id.
//
//   Assistant — settings shared by every provider: sample-row sharing, reply token cap.
//
//   Skills — user-authored instruction bundles fed to the assistant. Workspace-scoped
//   (every connection) or database-scoped. Stored on disk as Markdown-with-frontmatter by
//   `skills.rs`, so export is a file copy and any .md can be imported.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { pickOpenPath, pickSavePath, UNVERIFIED_PICKER } from "../filePicker";
import {
  AI_PROVIDERS, aiStore, defaultModel, isKeyless, normalizeMaxTokens,
  approvedBaseOverride, connectionTestProbe, endpointOrigin, normalizeAiConfig, originApproved,
  originNeedsConsent, providerInfo, providerModels, resolveBaseUrl, withDefaultModel, withEnabledModels,
  type AiConfig, type AiProvider,
} from "../ai/store";
import { ModelMultiPicker } from "../ai/ModelMultiPicker";
import { ProviderMark } from "../ai/providerIcons";
import { BEDROCK_MANTLE_REGIONS, MANTLE_PREFIX, bedrockHost, bedrockMantleBase } from "../ai/providers";
import { emptySkill, type Skill } from "../ai/skills";
import { KeyedSerialQueue } from "../asyncQueue";
import { KeyedStaleGuard } from "../staleGuard";
import { commands, errorMessage } from "../commands";

const errMsg = errorMessage;

/** Per-provider live state: does a key exist, and what did Test say. */
type ProbeState = { hasKey: boolean; testing: boolean; note: string; ok: boolean | null };

export function AiPane(props: { database: string }) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [configError, setConfigError] = createSignal("");
  const setConfig = (patch: Partial<AiConfig>) => {
    const next = normalizeAiConfig({ ...cfg(), ...patch });
    if (!aiStore.save(next)) {
      setCfg({ ...next, shareSamples: false });
      setConfigError("Could not save AI settings. Sample sharing stays off.");
      return false;
    }
    // aiStore synchronously publishes its canonical value (including models[provider]);
    // do not overwrite that subscriber update with the pre-normalized input.
    setConfigError("");
    return true;
  };

  const [maxTokensInput, setMaxTokensInput] = createSignal(String(cfg().maxTokens));
  const [probe, setProbe] = createSignal<Record<string, ProbeState>>({});
  const patchProbe = (id: AiProvider, p: Partial<ProbeState>) =>
    setProbe((m) => ({ ...m, [id]: { ...{ hasKey: false, testing: false, note: "", ok: null }, ...m[id], ...p } }));

  const [keyInput, setKeyInput] = createSignal<Record<string, string>>({});
  /** The provider whose settings are open below the grid; starts on the active one. */
  const [selected, setSelected] = createSignal<AiProvider>(cfg().provider);
  const [liveModels, setLiveModels] = createSignal<Partial<Record<AiProvider, string[]>>>({});
  /** Everything the provider offers right now (live), else the shipped fallback ids. */
  const catalogFor = (pid: AiProvider) => liveModels()[pid] ?? providerModels(pid);
  const [catalogState, setCatalogState] = createSignal<Record<string, { loading: boolean; error: string; live: boolean }>>({});
  const patchCatalog = (pid: AiProvider, p: Partial<{ loading: boolean; error: string; live: boolean }>) =>
    setCatalogState((m) => ({ ...m, [pid]: { ...{ loading: false, error: "", live: false }, ...m[pid], ...p } }));
  const catalogGuard = new KeyedStaleGuard<AiProvider>();
  /** Fetch the provider's live catalog for curation (no completion probe — Test does that). */
  async function fetchCatalog(pid: AiProvider) {
    const spec = providerInfo(pid);
    if (!originApproved(cfg(), pid)) { patchCatalog(pid, { error: "Approve the custom API origin first." }); return; }
    const base = resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid));
    if (!base) { patchCatalog(pid, { error: "Set an API base URL first." }); return; }
    const token = catalogGuard.mint(pid);
    patchCatalog(pid, { loading: true, error: "" });
    try {
      const list = await commands.aiListModels({
        provider: pid, wire: spec.wire, baseUrl: base, allowNoKey: !spec.needsKey,
      });
      if (!catalogGuard.current(pid, token)) return;
      if (list.length) setLiveModels((m) => ({ ...m, [pid]: list }));
      patchCatalog(pid, { loading: false, live: list.length > 0, error: list.length ? "" : "The provider returned no models." });
    } catch (e) {
      if (catalogGuard.current(pid, token)) patchCatalog(pid, { loading: false, error: errMsg(e) });
    }
  }
  /** Why the live catalog can't be fetched yet; empty once the provider is usable
   *  (keyless, or a key that is saved and its origin approved). */
  const refreshBlocked = (pid: AiProvider): string => {
    if (!originApproved(cfg(), pid)) return "approve the custom origin first";
    if (!isKeyless(pid) && !probe()[pid]?.hasKey) return "save a key first";
    if (!resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid))) return "set an API base first";
    return "";
  };
  /** Selecting a usable provider loads its live catalog once, so the model list is real
   *  before the user reaches it. */
  const loadCatalogOnce = (pid: AiProvider) => {
    if (!liveModels()[pid] && !catalogState()[pid]?.loading && !refreshBlocked(pid)) void fetchCatalog(pid);
  };
  const selectProvider = (pid: AiProvider) => {
    setSelected(pid);
    loadCatalogOnce(pid);
  };
  /** Arrow keys move through the grid in reading order (Home/End jump to the ends). */
  const onGridKey = (e: KeyboardEvent, pid: AiProvider) => {
    const ids = AI_PROVIDERS.map((x) => x.id);
    const at = ids.indexOf(pid);
    const cols = (() => {
      const tiles = [...((e.currentTarget as HTMLElement).parentElement?.children ?? [])] as HTMLElement[];
      const top = tiles[0]?.offsetTop;
      const n = tiles.filter((t) => t.offsetTop === top).length;
      return Math.max(1, n);
    })();
    const next =
      e.key === "ArrowRight" ? at + 1
      : e.key === "ArrowLeft" ? at - 1
      : e.key === "ArrowDown" ? at + cols
      : e.key === "ArrowUp" ? at - cols
      : e.key === "Home" ? 0
      : e.key === "End" ? ids.length - 1
      : null;
    if (next === null || next < 0 || next >= ids.length) return;
    e.preventDefault();
    selectProvider(ids[next]);
    const tiles = (e.currentTarget as HTMLElement).parentElement?.children;
    (tiles?.[next] as HTMLElement | undefined)?.focus();
  };
  /** Region-scoped providers (Bedrock): the region the configured base points at. */
  const currentRegion = (pid: AiProvider): string | null =>
    providerInfo(pid).regionOf?.(resolveBaseUrl(pid, cfg().baseUrls[pid] ?? "")) ?? null;
  const regionChoices = (pid: AiProvider): string[] => {
    const list = [...(providerInfo(pid).regions ?? [])];
    const cur = currentRegion(pid);
    if (cur && !list.includes(cur)) list.unshift(cur);
    return list;
  };
  /** Point the provider at a region's endpoint. The registry default region is stored as
   *  "no override". The catalog belongs to the old region, so it is dropped and refetched. */
  function pickRegion(pid: AiProvider, region: string) {
    const spec = providerInfo(pid);
    if (!region || !spec.regionBase) return;
    const base = spec.regionBase(region);
    if (!setConfig({ baseUrls: { ...cfg().baseUrls, [pid]: base === spec.baseUrl ? "" : base } })) return;
    catalogGuard.invalidate(pid);
    setLiveModels((m) => { const { [pid]: _gone, ...rest } = m; return rest; });
    patchCatalog(pid, { live: false, error: "", loading: false });
    if (!refreshBlocked(pid)) void fetchCatalog(pid);
  }
  const probeGuard = new KeyedStaleGuard<AiProvider>();
  const keyMutations = new KeyedSerialQueue<AiProvider>();
  const nextProbe = (pid: AiProvider) => probeGuard.mint(pid);
  const probeCurrent = (pid: AiProvider, token: number) => probeGuard.current(pid, token);

  const providerBase = (pid: AiProvider) =>
    originApproved(cfg(), pid) ? resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid)) : "";
  const refreshKeys = async () => {
    await Promise.all(AI_PROVIDERS.map(async (p) => {
      const generation = nextProbe(p.id);
      const baseUrl = providerBase(p.id);
      const hasKey = isKeyless(p.id) || (!!baseUrl && await commands.aiHasKey(p.id, baseUrl).catch(() => false));
      if (probeCurrent(p.id, generation)) patchProbe(p.id, { hasKey });
    }));
    // Keyless providers are usable at once; keyed ones once the probe saw their key.
    loadCatalogOnce(selected());
  };
  let unsubscribeConfig = () => {};
  onMount(() => {
    unsubscribeConfig = aiStore.subscribe((next) => {
      probeGuard.invalidateAll();
      setProbe((current) => Object.fromEntries(
        Object.entries(current).map(([provider, state]) => [provider, { ...state, testing: false, note: "", ok: null }]),
      ));
      setCfg(next);
      void refreshKeys();
    });
    void refreshKeys();
    void refreshSkills();
  });
  onCleanup(() => {
    probeGuard.dispose();
    catalogGuard.dispose();
    unsubscribeConfig();
  });

  /** Test = fetch the provider's model catalog with the stored key. A reachable provider
   *  returns ids; anything else surfaces the real error rather than a green tick. */
  async function testProvider(pid: AiProvider) {
    const spec = providerInfo(pid);
    if (!originApproved(cfg(), pid)) {
      patchProbe(pid, { ok: false, note: "Approve the custom API origin first." });
      return;
    }
    const base = resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid));
    if (!base) { patchProbe(pid, { ok: false, note: "Set an API base URL first." }); return; }
    const probe = connectionTestProbe(cfg(), pid);
    const generation = nextProbe(pid);
    patchProbe(pid, { testing: true, note: "", ok: null });
    try {
      const list = await commands.aiListModels({
        provider: pid, wire: spec.wire, baseUrl: base, allowNoKey: !spec.needsKey,
        // `/models` is public on some gateways. Keyed providers also make a tiny
        // completion request so a green result proves the credential itself works.
        probe,
      });
      if (!probeCurrent(pid, generation)) return;
      if (list.length) { setLiveModels((m) => ({ ...m, [pid]: list })); patchCatalog(pid, { live: true, error: "" }); }
      patchProbe(pid, {
        testing: false,
        ok: true,
        note: `${spec.needsKey ? "Authenticated. " : ""}${list.length} models available.`,
      });
    } catch (e) {
      if (probeCurrent(pid, generation)) patchProbe(pid, { testing: false, ok: false, note: errMsg(e) });
    }
  }

  async function saveKey(pid: AiProvider) {
    const k = (keyInput()[pid] ?? "").trim();
    if (!k) return;
    const override = cfg().baseUrls[pid] ?? "";
    if (!originApproved(cfg(), pid)) {
      patchProbe(pid, { note: "Approve the custom API origin first.", ok: false });
      return;
    }
    const baseUrl = resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid));
    if (!baseUrl) {
      patchProbe(pid, { note: "Set an API base URL first.", ok: false });
      return;
    }
    const generation = nextProbe(pid);
    try {
      await keyMutations.run(pid, () => commands.aiSaveKey(pid, k, baseUrl, originNeedsConsent(pid, override)));
      if (!probeCurrent(pid, generation)) return;
      setKeyInput((m) => ({ ...m, [pid]: "" }));
      patchProbe(pid, { hasKey: true, note: "Key saved.", ok: null });
      aiStore.broadcast(cfg());
      void testProvider(pid);
    } catch (e) {
      if (probeCurrent(pid, generation)) patchProbe(pid, { note: errMsg(e), ok: false });
    }
  }
  async function clearKey(pid: AiProvider) {
    const generation = nextProbe(pid);
    try {
      await keyMutations.run(pid, () => commands.aiClearKey(pid));
      if (!probeCurrent(pid, generation)) return;
      patchProbe(pid, { hasKey: false, note: "", ok: null });
      // The catalog was fetched with the key just removed; fall back to the shipped ids.
      setLiveModels((m) => { const { [pid]: _gone, ...rest } = m; return rest; });
      patchCatalog(pid, { live: false, error: "", loading: false });
      aiStore.broadcast(cfg());
    } catch (e) {
      if (probeCurrent(pid, generation)) patchProbe(pid, { note: errMsg(e), ok: false });
    }
  }

  const status = (pid: AiProvider) => {
    const p = probe()[pid];
    if (!originApproved(cfg(), pid)) return { label: "Origin approval needed", short: "Needs approval", cls: "off" };
    if (isKeyless(pid)) return { label: "No key needed", short: "Local", cls: "ok" };
    if (p?.hasKey) return { label: "Connected", short: "Ready", cls: "ok" };
    return { label: "No key", short: "Not set up", cls: "off" };
  };
  const isActive = (pid: AiProvider) => cfg().provider === pid;
  /** How many providers are usable right now — a key saved, or keyless and local. */
  const configured = createMemo(() =>
    AI_PROVIDERS.filter((p) => originApproved(cfg(), p.id) && probe()[p.id]?.hasKey).length,
  );

  // ---------------------------------------------------------------- skills

  const [skills, setSkills] = createSignal<Skill[]>([]);
  const [editing, setEditing] = createSignal<Skill | null>(null);
  const [skillNote, setSkillNote] = createSignal("");
  const refreshSkills = () => commands.skillsList().then(setSkills).catch(() => setSkills([]));

  const inScope = (s: Skill) => s.scope === "workspace" || (!!props.database && s.database === props.database);
  const activeCount = createMemo(() => skills().filter((s) => s.enabled && inScope(s)).length);

  async function persist(s: Skill) {
    try {
      await commands.skillsSave(s);
      await refreshSkills();
      setSkillNote("");
      return true;
    } catch (e) {
      setSkillNote(errMsg(e));
      return false;
    }
  }
  async function toggleSkill(s: Skill) {
    await persist({ ...s, enabled: !s.enabled });
  }
  async function removeSkill(s: Skill) {
    await commands.skillsDelete(s.id).catch((e) => setSkillNote(errMsg(e)));
    await refreshSkills();
  }
  async function exportSkill(s: Skill) {
    // A destination Tusk cannot prove the user chose is not written to (see filePicker).
    const picked = await pickSavePath({ defaultPath: `${s.id || s.name}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!picked.path) return;
    if (!picked.verified) { setSkillNote(UNVERIFIED_PICKER); return; }
    const path = picked.path;
    try {
      const text = await commands.skillsExport(s.id);
      await commands.writeTextFile(path, text);
      setSkillNote(`Exported ${s.name}.`);
    } catch (e) { setSkillNote(errMsg(e)); }
  }
  async function importSkill() {
    const picked = await pickOpenPath({ filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }] });
    if (!picked.path) return;
    if (!picked.verified) { setSkillNote(UNVERIFIED_PICKER); return; }
    const path = picked.path;
    try {
      const text = await commands.readTextFile(path);
      const stem = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Imported skill";
      const s = await commands.skillsImport(text, stem);
      await refreshSkills();
      setSkillNote(`Imported “${s.name}”.`);
    } catch (e) { setSkillNote(errMsg(e)); }
  }

  return (
    <div class="ai-pane">
      {/* ------------------------------------------------ providers */}
      <section class="ai-section">
        <header class="ai-section-head">
          <h3 class="ai-section-title">Providers</h3>
          <span class="ai-section-sub">{configured()} set up</span>
        </header>
        <div class="settings-note">
          Pick a provider to connect it and choose its models. Switch providers from the
          chat header. Keys live in your OS keychain.
        </div>
        <Show when={configError()}><div class="error">{configError()}</div></Show>

      <div class="ai-grid" role="listbox" aria-label="AI providers">
        <For each={AI_PROVIDERS}>
          {(p) => {
            const st = () => status(p.id);
            return (
              <button
                type="button"
                role="option"
                class="ai-tile"
                classList={{ sel: selected() === p.id, active: isActive(p.id), ready: st().cls === "ok" }}
                aria-selected={selected() === p.id}
                title={`${p.label} — ${isActive(p.id) ? "active provider" : st().label}`}
                onClick={() => selectProvider(p.id)}
                onKeyDown={(e) => onGridKey(e, p.id)}
              >
                <Show when={isActive(p.id)}><span class="ai-tile-badge">Active</span></Show>
                <span class="ai-tile-mark"><ProviderMark provider={p.id} size={26} /></span>
                <span class="ai-tile-name">{p.short}</span>
                <span class="ai-tile-kind">{p.kind}</span>
                <span class="ai-tile-state" classList={{ ok: st().cls === "ok" }}>
                  <span class="ai-tile-dot" aria-hidden="true" />
                  {st().short}
                </span>
              </button>
            );
          }}
        </For>
      </div>

      <Show when={providerInfo(selected())}>
        {(spec) => {
          const p = () => spec();
          const st = () => status(p().id);
          return (
            <div class="ai-detail" classList={{ active: isActive(p().id) }}>
              <header class="ai-detail-head">
                <span class="ai-detail-mark"><ProviderMark provider={p().id} size={30} /></span>
                <span class="ai-detail-title">
                  <span class="ai-detail-name">
                    {p().label}
                    <Show when={isActive(p().id)}><span class="ai-chip accent">Active</span></Show>
                    <span class="ai-chip" classList={{ ok: st().cls === "ok", off: st().cls === "off" }}>{st().label}</span>
                  </span>
                  <Show when={p().note}><small>{p().note}</small></Show>
                </span>
                <button class="run" disabled={isActive(p().id)} onClick={() => setConfig({ provider: p().id, model: cfg().models[p().id] ?? defaultModel(p().id) })}>
                  {isActive(p().id) ? "Active provider" : "Use this provider"}
                </button>
              </header>

              {/* ---- Connection: everything needed to reach the provider ---- */}
              <div class="ai-card-group">Connection</div>

              <Show when={p().needsKey}>
                {/* `display: contents` form: a bare password input outside one
                    makes every Chromium build log a DOM warning. */}
                <form class="subform" onSubmit={(e) => e.preventDefault()}>
                <label class="settings-row">
                  <span class="settings-label">
                    <span>{p().id === "bedrock" ? "Bedrock API key" : "API key"}</span>
                    <small>{probe()[p().id]?.hasKey ? "Paste a new key to replace the saved one." : p().id === "bedrock" ? "A long- or short-term key from the Bedrock console. Stored in your OS keychain." : "Stored in your OS keychain."}</small>
                  </span>
                  <span class="settings-inline">
                    <input
                      type="password"
                      autocomplete="current-password"
                      placeholder={probe()[p().id]?.hasKey ? "Type to replace" : "Paste key"}
                      value={keyInput()[p().id] ?? ""}
                      onInput={(e) => setKeyInput((m) => ({ ...m, [p().id]: e.currentTarget.value }))}
                      onKeyDown={(e) => { if (e.key === "Enter" && (keyInput()[p().id] ?? "").trim()) void saveKey(p().id); }}
                    />
                    <button class="run" type="button" disabled={!(keyInput()[p().id] ?? "").trim()} onClick={() => void saveKey(p().id)}>Save</button>
                  </span>
                </label>
                </form>
              </Show>

              <Show when={p().regions && p().regionBase && p().regionOf}>
                <label class="settings-row">
                  <span class="settings-label">
                    <span>Region</span>
                    <small>Models, profiles and access differ per region. The key works in every one.</small>
                  </span>
                  <select
                    value={currentRegion(p().id) ?? ""}
                    onChange={(e) => pickRegion(p().id, e.currentTarget.value)}
                  >
                    <Show when={!currentRegion(p().id)}><option value="" disabled>Custom endpoint</option></Show>
                    <For each={regionChoices(p().id)}>
                      {(r) => <option value={r}>{p().id === "bedrock" && BEDROCK_MANTLE_REGIONS.includes(r) ? `${r} · runtime + Mantle` : r}</option>}
                    </For>
                  </select>
                </label>
              </Show>

              <label class="settings-row">
                <span class="settings-label">
                  <span>API base</span>
                  <small>{p().id === "custom" ? "Required. The prefix before /v1." : p().regions ? "Set by the region. Override only for a VPC endpoint or proxy." : "Leave blank to use the provider's endpoint."}</small>
                </span>
                <input
                  placeholder={p().baseHint}
                  value={cfg().baseUrls[p().id] ?? ""}
                  onInput={(e) => setConfig({ baseUrls: { ...cfg().baseUrls, [p().id]: e.currentTarget.value } })}
                />
              </label>

              <Show when={originNeedsConsent(p().id, cfg().baseUrls[p().id] ?? "")}>
                <label class="settings-row">
                  <span class="settings-label">
                    <span>Allow custom origin</span>
                    <small>
                      Your key, prompts, schema, and any shared sample rows go to <code>{endpointOrigin(cfg().baseUrls[p().id] ?? "") ?? "invalid URL"}</code>.
                    </small>
                  </span>
                  <input
                    type="checkbox"
                    checked={originApproved(cfg(), p().id)}
                    onChange={(e) => {
                      const next = { ...cfg().approvedOrigins };
                      const origin = endpointOrigin(cfg().baseUrls[p().id] ?? "");
                      if (e.currentTarget.checked && origin) next[p().id] = origin;
                      else delete next[p().id];
                      if (e.currentTarget.checked && !origin) {
                        setConfigError("Enter a valid HTTP(S) API base first.");
                        return;
                      }
                      if (!setConfig({ approvedOrigins: next })) {
                        e.currentTarget.checked = originApproved(cfg(), p().id);
                        return;
                      }
                    }}
                  />
                </label>
              </Show>
              <Show when={isKeyless(p().id)}>
                <div class="ai-note">Keyless endpoints must be on localhost or a loopback IP.</div>
              </Show>

              <Show when={p().id === "bedrock"}>
                <BedrockPlanes
                  base={resolveBaseUrl("bedrock", cfg().baseUrls.bedrock ?? "")}
                  catalog={liveModels().bedrock}
                />
              </Show>

              <div class="ai-card-actions">
                <button class="ghost" disabled={probe()[p().id]?.testing} onClick={() => void testProvider(p().id)}>
                  {probe()[p().id]?.testing ? "Testing…" : "Test connection"}
                </button>
                <Show when={p().needsKey && p().keyUrl}>
                  <button class="ghost" onClick={() => void openUrl(p().keyUrl)}>Get a key ↗</button>
                </Show>
                <span class="spacer" />
                <Show when={p().needsKey && probe()[p().id]?.hasKey}>
                  <button class="ghost danger" onClick={() => void clearKey(p().id)}>Remove key</button>
                </Show>
              </div>
              <Show when={probe()[p().id]?.note}>
                <div classList={{ "ai-note": probe()[p().id]?.ok !== false, error: probe()[p().id]?.ok === false }}>
                  {probe()[p().id]?.note}
                </div>
              </Show>

              {/* ---- Models: the one place a model is chosen for this provider ---- */}
              <div class="ai-card-group">
                Models
                <small>Ticked models appear in the pickers; ★ marks the default. Nothing ticked offers all.</small>
              </div>
              <ModelMultiPicker
                catalog={catalogFor(p().id)}
                live={!!catalogState()[p().id]?.live}
                loading={!!catalogState()[p().id]?.loading}
                error={catalogState()[p().id]?.error ?? ""}
                refreshBlocked={refreshBlocked(p().id)}
                selected={cfg().enabledModels[p().id] ?? []}
                defaultModel={cfg().models[p().id] ?? defaultModel(p().id)}
                groupOf={p().modelGroup}
                onChange={(list) => setConfig(withEnabledModels(cfg(), p().id, list))}
                onDefault={(model) => setConfig(withDefaultModel(cfg(), p().id, model))}
                onRefresh={() => void fetchCatalog(p().id)}
              />
            </div>
          );
        }}
      </Show>

      </section>

      {/* ------------------------------------------------ assistant */}
      <section class="ai-section">
        <header class="ai-section-head">
          <h3 class="ai-section-title">Assistant</h3>
        </header>

        <label class="settings-row">
          <span class="settings-label">
            <span>Share sample rows with the model</span>
            <small>Sends real rows from relevant tables to the provider. Off by default.</small>
          </span>
          <input
            type="checkbox"
            checked={cfg().shareSamples}
            onChange={(e) => {
              if (!setConfig({ shareSamples: e.currentTarget.checked })) {
                e.currentTarget.checked = cfg().shareSamples;
              }
            }}
          />
        </label>

        <label class="settings-row">
          <span class="settings-label">
            <span>Reply max tokens</span>
            <small>Longest reply the model may return (256–128,000).</small>
          </span>
          <input
            type="number"
            min="256"
            max="128000"
            step="256"
            value={maxTokensInput()}
            onInput={(e) => {
              setMaxTokensInput(e.currentTarget.value);
              if (e.currentTarget.value.trim()) setConfig({ maxTokens: normalizeMaxTokens(e.currentTarget.value, cfg().maxTokens) });
            }}
            onBlur={() => {
              const normalized = normalizeMaxTokens(maxTokensInput(), cfg().maxTokens);
              setConfig({ maxTokens: normalized });
              setMaxTokensInput(String(normalized));
            }}
          />
        </label>
      </section>

      {/* ------------------------------------------------ skills */}
      <section class="ai-section">
        <header class="ai-section-head">
          <h3 class="ai-section-title">Skills</h3>
          <span class="ai-section-sub">
            {activeCount()} active{props.database ? ` on ${props.database}` : ""}
          </span>
          <div class="ai-section-actions">
            <button class="ghost" onClick={() => void importSkill()}>Import…</button>
            {/* Default a new skill to the database you're looking at; workspace when there
                isn't one. Either way the target is adopted, never typed. */}
            <button class="run" onClick={() => setEditing({ ...emptySkill(), scope: props.database ? "database" : "workspace", database: props.database })}>+ New skill</button>
          </div>
        </header>
        <div class="settings-note">
          Instructions the assistant follows on every question. <b>Workspace</b> skills apply
          everywhere;<b> database</b> skills only on a matching database.
        </div>

      <Show when={skillNote()}><div class="ai-note">{skillNote()}</div></Show>

      <div class="ai-skills">
        <Show when={skills().length === 0}>
          <div class="ai-empty-box">
            No skills yet. Select <b>New skill</b> to write one, or
            <b> Import…</b> an existing <code>.md</code> file.
          </div>
        </Show>
        <For each={skills()}>
          {(s) => (
            <div class="ai-skill" classList={{ dim: !s.enabled || !inScope(s) }}>
              <input class="ai-skill-on" type="checkbox" checked={s.enabled} title={s.enabled ? "Enabled" : "Disabled"} onChange={() => void toggleSkill(s)} />
              <div class="ai-skill-main">
                <div class="ai-skill-name">
                  <span class="ai-skill-title">{s.name}</span>
                  <span class="ai-chip">{s.scope === "database" ? `db: ${s.database}` : "workspace"}</span>
                  <Show when={s.enabled && !inScope(s)}><span class="ai-chip off">not this database</span></Show>
                </div>
                <Show when={s.description}><div class="ai-skill-desc">{s.description}</div></Show>
              </div>
              <div class="ai-skill-actions">
                <button class="ghost" onClick={() => setEditing({ ...s })}>Edit</button>
                <button class="ghost" onClick={() => void exportSkill(s)}>Export</button>
                <button class="ghost danger" onClick={() => void removeSkill(s)}>Delete</button>
              </div>
            </div>
          )}
        </For>
      </div>

      <Show when={editing()}>
        {(sk) => (
          <div class="ai-skill-edit">
            <header class="ai-section-head">
              <h3 class="ai-section-title">{sk().id ? "Edit skill" : "New skill"}</h3>
            </header>
            <label class="settings-row">
              <span>Name</span>
              <input value={sk().name} onInput={(e) => setEditing({ ...sk(), name: e.currentTarget.value })} placeholder="Revenue definitions" />
            </label>
            <label class="settings-row">
              <span>Description</span>
              <input value={sk().description} onInput={(e) => setEditing({ ...sk(), description: e.currentTarget.value })} placeholder="One line shown here and to the model" />
            </label>
            <label class="settings-row">
              <span>Scope</span>
              <select
                value={sk().scope}
                onChange={(e) => {
                  const scope = e.currentTarget.value as Skill["scope"];
                  // The database is a fact about the connection, not something to retype.
                  // Keep an existing target when re-selecting the scope; otherwise adopt
                  // whatever we're connected to.
                  setEditing({ ...sk(), scope, database: scope === "database" ? (sk().database || props.database) : "" });
                }}
              >
                <option value="workspace">Workspace (every connection)</option>
                <option value="database" disabled={!props.database && !sk().database}>
                  {props.database ? `This database (${props.database})` : "One database (connect first)"}
                </option>
              </select>
            </label>
            <Show when={sk().scope === "database"}>
              <div class="settings-row">
                <span>Applies to</span>
                <span class="ai-scope-target">
                  <code>{sk().database || "—"}</code>
                  {/* Editing a skill written against a different database: say so plainly and
                      offer the one-click fix rather than a text field to get wrong. */}
                  <Show when={props.database && sk().database && sk().database !== props.database}>
                    <span class="ai-scope-warn">not the connected database</span>
                    <button class="ghost" onClick={() => setEditing({ ...sk(), database: props.database })}>
                      Retarget to {props.database}
                    </button>
                  </Show>
                </span>
              </div>
            </Show>
            <div class="ai-skill-bodylabel">Instructions (Markdown). Sent to the model as written.</div>
            <textarea
              class="ai-skill-body"
              rows={16}
              value={sk().body}
              onInput={(e) => setEditing({ ...sk(), body: e.currentTarget.value })}
              placeholder={"Markdown. For example:\n\n- “Revenue” always excludes refunds (status <> 'refunded').\n- Prefer the `analytics.*` views over raw tables.\n- Dates are UTC; report by calendar month."}
            />
            <div class="ai-card-actions">
              <button class="ghost" onClick={() => { setEditing(null); setSkillNote(""); }}>Cancel</button>
              <span class="spacer" />
              <button
                class="run"
                disabled={!sk().name.trim() || (sk().scope === "database" && !sk().database.trim())}
                onClick={async () => { if (await persist(sk())) setEditing(null); }}
              >
                {sk().id ? "Save skill" : "Create skill"}
              </button>
            </div>
          </div>
        )}
      </Show>
      </section>
    </div>
  );
}

/** Bedrock's two inference planes for the configured base: where each lives, what it
 *  speaks, and (once the catalog is loaded) how many models it serves this account. One
 *  key and one region cover both; the backend routes each model id to its plane. */
function BedrockPlanes(props: { base: string; catalog?: string[] }) {
  const host = () => bedrockHost(props.base);
  const runtimeHost = () => {
    try { return new URL(props.base).host; } catch { return props.base; }
  };
  const mantle = () => bedrockMantleBase(props.base);
  const counts = () => {
    const list = props.catalog;
    if (!list) return null;
    const onMantle = list.filter((m) => m.startsWith(MANTLE_PREFIX)).length;
    return { runtime: list.length - onMantle, mantle: onMantle };
  };
  const runtimeNote = () => {
    const c = counts();
    return c ? `${c.runtime} model${c.runtime === 1 ? "" : "s"}` : "";
  };
  const mantleNote = () => {
    const c = counts();
    if (!mantle()) {
      return host()?.fips ? "No FIPS endpoint: Mantle is off." : "Needs AWS's own regional endpoint.";
    }
    if (c) return c.mantle ? `${c.mantle} model${c.mantle === 1 ? "" : "s"}` : "Not offered in this region or to this key.";
    return host() && BEDROCK_MANTLE_REGIONS.includes(host()!.region) ? "" : "May not be offered in this region.";
  };
  return (
    <div class="ai-planes">
      <div class="ai-plane">
        <span class="ai-plane-name">Runtime</span>
        <code class="ai-plane-host">{runtimeHost()}</code>
        <span class="ai-plane-what">Converse: inference profiles, models, ARNs</span>
        <span class="ai-plane-count">{runtimeNote()}</span>
      </div>
      <div class="ai-plane" classList={{ off: !mantle() || counts()?.mantle === 0 }}>
        <span class="ai-plane-name">Mantle</span>
        <code class="ai-plane-host">{mantle() ? new URL(mantle()!).host : "—"}</code>
        <span class="ai-plane-what">OpenAI/Anthropic-compatible, listed as <code>mantle/…</code></span>
        <span class="ai-plane-count">{mantleNote()}</span>
      </div>
      <div class="ai-note">
        The same key and region serve both. Profiles named for a geography (<code>us.</code>, <code>eu.</code>, <code>apac.</code>) keep
        requests there; <code>global.</code> may route anywhere. Tusk picks the Mantle route
        (chat completions, Responses or Anthropic Messages) for each model.
      </div>
    </div>
  );
}
