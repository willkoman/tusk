// Settings → AI. Two sections, both self-contained (direct `invoke`s, like SlackPane):
//
//   Providers — one card each. Key status, key entry (never echoed back), default model
//   grouped by tier, base URL where it's editable, and a Test button that actually calls
//   the provider's model catalog. Keys live in the OS keychain, one account per provider id.
//
//   Skills — user-authored instruction bundles fed to the assistant. Workspace-scoped
//   (every connection) or database-scoped. Stored on disk as Markdown-with-frontmatter by
//   `skills.rs`, so export is a file copy and any .md can be imported.

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  AI_PROVIDERS, aiStore, defaultModel, groupByTier, isKeyless, modelNote, normalizeMaxTokens,
  approvedBaseOverride, connectionTestProbe, endpointOrigin, normalizeAiConfig, originApproved,
  originNeedsConsent, providerInfo, providerModels, resolveBaseUrl,
  withProviderModel, type AiConfig, type AiProvider,
} from "../ai/store";
import { emptySkill, type Skill } from "../ai/skills";
import { KeyedSerialQueue } from "../asyncQueue";

const errMsg = (e: unknown): string => (e as { message?: string })?.message ?? String(e);

/** Per-provider live state: does a key exist, and what did Test say. */
type ProbeState = { hasKey: boolean; testing: boolean; note: string; ok: boolean | null };

export function AiPane(props: { database: string }) {
  const [cfg, setCfg] = createSignal<AiConfig>(aiStore.load());
  const [configError, setConfigError] = createSignal("");
  const setConfig = (patch: Partial<AiConfig>) => {
    const next = normalizeAiConfig({ ...cfg(), ...patch });
    if (!aiStore.save(next)) {
      setCfg({ ...next, shareSamples: false });
      setConfigError("Could not save AI settings. Sample sharing remains off unless its privacy choice is stored successfully.");
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
  const [expanded, setExpanded] = createSignal<AiProvider | null>(null);
  const [liveModels, setLiveModels] = createSignal<Partial<Record<AiProvider, string[]>>>({});
  const modelsFor = (pid: AiProvider) => liveModels()[pid] ?? providerModels(pid);
  const probeGeneration = new Map<AiProvider, number>();
  const keyMutations = new KeyedSerialQueue<AiProvider>();
  let mounted = true;
  const nextProbe = (pid: AiProvider) => {
    const generation = (probeGeneration.get(pid) ?? 0) + 1;
    probeGeneration.set(pid, generation);
    return generation;
  };
  const probeCurrent = (pid: AiProvider, generation: number) => mounted && probeGeneration.get(pid) === generation;

  const providerBase = (pid: AiProvider) =>
    originApproved(cfg(), pid) ? resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid)) : "";
  const refreshKeys = async () => {
    await Promise.all(AI_PROVIDERS.map(async (p) => {
      const generation = nextProbe(p.id);
      const baseUrl = providerBase(p.id);
      const hasKey = isKeyless(p.id) || (!!baseUrl && await invoke<boolean>("ai_has_key", {
        provider: p.id,
        baseUrl,
      }).catch(() => false));
      if (probeCurrent(p.id, generation)) patchProbe(p.id, { hasKey });
    }));
  };
  let unsubscribeConfig = () => {};
  onMount(() => {
    unsubscribeConfig = aiStore.subscribe((next) => {
      for (const provider of AI_PROVIDERS) nextProbe(provider.id);
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
    mounted = false;
    for (const provider of AI_PROVIDERS) nextProbe(provider.id);
    unsubscribeConfig();
  });

  /** Test = fetch the provider's model catalog with the stored key. A reachable provider
   *  returns ids; anything else surfaces the real error rather than a green tick. */
  async function testProvider(pid: AiProvider) {
    const spec = providerInfo(pid);
    if (!originApproved(cfg(), pid)) {
      patchProbe(pid, { ok: false, note: "Approve the custom API origin before testing it." });
      return;
    }
    const base = resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid));
    if (!base) { patchProbe(pid, { ok: false, note: "Set an API base URL first." }); return; }
    const probe = connectionTestProbe(cfg(), pid);
    const generation = nextProbe(pid);
    patchProbe(pid, { testing: true, note: "", ok: null });
    try {
      const list = await invoke<string[]>("ai_list_models", {
        provider: pid, wire: spec.wire, baseUrl: base, allowNoKey: !spec.needsKey,
        // `/models` is public on some gateways. Keyed providers also make a tiny
        // completion request so a green result proves the credential itself works.
        probe,
      });
      if (!probeCurrent(pid, generation)) return;
      if (list.length) setLiveModels((m) => ({ ...m, [pid]: list }));
      patchProbe(pid, {
        testing: false,
        ok: true,
        note: `${spec.needsKey ? "Authenticated; " : ""}${list.length} models available`,
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
      patchProbe(pid, { note: "Approve the custom API origin before saving a key for it.", ok: false });
      return;
    }
    const baseUrl = resolveBaseUrl(pid, approvedBaseOverride(cfg(), pid));
    if (!baseUrl) {
      patchProbe(pid, { note: "Set an API base URL first.", ok: false });
      return;
    }
    const generation = nextProbe(pid);
    try {
      await keyMutations.run(pid, () => invoke("ai_save_key", {
          provider: pid,
          key: k,
          baseUrl,
          approveOrigin: originNeedsConsent(pid, override),
        }));
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
      await keyMutations.run(pid, () => invoke("ai_clear_key", { provider: pid }));
      if (!probeCurrent(pid, generation)) return;
      patchProbe(pid, { hasKey: false, note: "", ok: null });
      aiStore.broadcast(cfg());
    } catch (e) {
      if (probeCurrent(pid, generation)) patchProbe(pid, { note: errMsg(e), ok: false });
    }
  }

  const status = (pid: AiProvider) => {
    const p = probe()[pid];
    if (!originApproved(cfg(), pid)) return { label: "Origin approval needed", cls: "off" };
    if (isKeyless(pid)) return { label: "No key needed", cls: "ok" };
    if (p?.hasKey) return { label: "Connected", cls: "ok" };
    return { label: "No key", cls: "off" };
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
  const refreshSkills = () => invoke<Skill[]>("skills_list").then(setSkills).catch(() => setSkills([]));

  const inScope = (s: Skill) => s.scope === "workspace" || (!!props.database && s.database === props.database);
  const activeCount = createMemo(() => skills().filter((s) => s.enabled && inScope(s)).length);

  async function persist(s: Skill) {
    try {
      await invoke<Skill>("skills_save", { skill: s });
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
    await invoke("skills_delete", { id: s.id }).catch((e) => setSkillNote(errMsg(e)));
    await refreshSkills();
  }
  async function exportSkill(s: Skill) {
    const path = await saveDialog({ defaultPath: `${s.id || s.name}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    try {
      const text = await invoke<string>("skills_export", { id: s.id });
      await invoke("write_text_file", { path, contents: text });
      setSkillNote(`Exported ${s.name}.`);
    } catch (e) { setSkillNote(errMsg(e)); }
  }
  async function importSkill() {
    const picked = await openDialog({ multiple: false, filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }] });
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (!path) return;
    try {
      const text = await invoke<string>("read_text_file", { path });
      const stem = path.split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") ?? "Imported skill";
      const s = await invoke<Skill>("skills_import", { text, fallbackName: stem });
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
          Each provider stores its key separately in your OS keychain — add several and switch
          models from the chat header. Keys never reach the web view.
        </div>
        <Show when={configError()}><div class="error">{configError()}</div></Show>

      <div class="ai-cards">
        <For each={AI_PROVIDERS}>
          {(p) => {
            const st = () => status(p.id);
            const open = () => expanded() === p.id;
            return (
              <div class="ai-card" classList={{ active: isActive(p.id), open: open() }}>
                <button class="ai-card-head" onClick={() => setExpanded(open() ? null : p.id)}>
                  <span class="ai-card-name">
                    {p.label}
                    <Show when={isActive(p.id)}><span class="ai-chip accent">Active</span></Show>
                  </span>
                  <span class="ai-chip" classList={{ ok: st().cls === "ok", off: st().cls === "off" }}>{st().label}</span>
                  <span class="ai-card-model">{isActive(p.id) ? cfg().model || "—" : cfg().models[p.id] ?? ""}</span>
                  <span class="ai-card-caret">{open() ? "▾" : "▸"}</span>
                </button>

                <Show when={open()}>
                  <div class="ai-card-body">
                    <Show when={p.note}><div class="ai-note">{p.note}</div></Show>

                    <Show when={p.needsKey}>
                      <label class="settings-row">
                        <span>API key</span>
                        <input
                          type="password"
                          placeholder={probe()[p.id]?.hasKey ? "saved in keychain — type to replace" : "paste key"}
                          value={keyInput()[p.id] ?? ""}
                          onInput={(e) => setKeyInput((m) => ({ ...m, [p.id]: e.currentTarget.value }))}
                        />
                      </label>
                      <div class="ai-card-actions">
                        <Show when={p.keyUrl}>
                          <button class="ghost" onClick={() => void openUrl(p.keyUrl)}>Get a key ↗</button>
                        </Show>
                        <span class="spacer" />
                        <Show when={probe()[p.id]?.hasKey}>
                          <button class="ghost" onClick={() => void clearKey(p.id)}>Remove key</button>
                        </Show>
                        <button class="run" disabled={!(keyInput()[p.id] ?? "").trim()} onClick={() => void saveKey(p.id)}>Save key</button>
                      </div>
                    </Show>

                    <label class="settings-row">
                      <span>Default model</span>
                      <select
                        value={cfg().models[p.id] ?? defaultModel(p.id)}
                        onChange={(e) => {
                          const next = withProviderModel(cfg(), p.id, e.currentTarget.value);
                          setConfig(next);
                        }}
                      >
                        <For each={groupByTier(p.id, modelsFor(p.id))}>
                          {(g) => (
                            <optgroup label={g.label}>
                              <For each={g.models}>{(m) => <option value={m} title={modelNote(p.id, m)}>{m}</option>}</For>
                            </optgroup>
                          )}
                        </For>
                      </select>
                    </label>

                    <label class="settings-row">
                      <span>API base {p.id === "custom" ? "(required)" : "(optional)"}</span>
                      <input
                        placeholder={p.baseHint}
                        value={cfg().baseUrls[p.id] ?? ""}
                        onInput={(e) => setConfig({ baseUrls: { ...cfg().baseUrls, [p.id]: e.currentTarget.value } })}
                      />
                    </label>

                    <Show when={originNeedsConsent(p.id, cfg().baseUrls[p.id] ?? "")}>
                      <label class="settings-row" title="A saved key, prompts, schema context, and enabled sample rows may be sent to this origin.">
                        <span>Allow custom origin</span>
                        <input
                          type="checkbox"
                          checked={originApproved(cfg(), p.id)}
                          onChange={(e) => {
                            const next = { ...cfg().approvedOrigins };
                            const origin = endpointOrigin(cfg().baseUrls[p.id] ?? "");
                            if (e.currentTarget.checked && origin) next[p.id] = origin;
                            else delete next[p.id];
                            if (e.currentTarget.checked && !origin) {
                              setConfigError("Enter a valid HTTP(S) API base before approving its origin.");
                              return;
                            }
                            if (!setConfig({ approvedOrigins: next })) {
                              e.currentTarget.checked = originApproved(cfg(), p.id);
                              return;
                            }
                          }}
                        />
                      </label>
                      <div class="ai-note">
                        Custom origin: <code>{endpointOrigin(cfg().baseUrls[p.id] ?? "") ?? "invalid URL"}</code>. Approval is required before credentials or database context can be sent there.
                      </div>
                    </Show>
                    <Show when={isKeyless(p.id)}>
                      <div class="ai-note">Keyless endpoints are accepted only on localhost or a loopback IP.</div>
                    </Show>

                    <div class="ai-card-actions">
                      <button class="ghost" disabled={probe()[p.id]?.testing} onClick={() => void testProvider(p.id)}>
                        {probe()[p.id]?.testing ? "Testing…" : "Test connection"}
                      </button>
                      <span class="spacer" />
                      <button class="run" disabled={isActive(p.id)} onClick={() => setConfig({ provider: p.id, model: cfg().models[p.id] ?? defaultModel(p.id) })}>
                        {isActive(p.id) ? "Active" : "Use this provider"}
                      </button>
                    </div>
                    <Show when={probe()[p.id]?.note}>
                      <div classList={{ "ai-note": probe()[p.id]?.ok !== false, error: probe()[p.id]?.ok === false }}>
                        {probe()[p.id]?.ok === true ? "✅ " : probe()[p.id]?.ok === false ? "❌ " : ""}
                        {probe()[p.id]?.note}
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            );
          }}
        </For>
      </div>

        <label class="settings-row" title="Send a few sample rows of relevant tables so the model understands your real data. Real values leave your machine.">
          <span>Share sample data with the model</span>
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

        <label
          class="settings-row"
          title="Upper bound on the AI's reply length, in tokens. Too low cuts replies (and their SQL) off mid-sentence; the provider may cap it lower than this."
        >
          <span>AI reply max tokens</span>
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
          Instructions you write once and the assistant follows every time — house definitions,
          naming conventions, which tables to prefer. <b>Workspace</b> skills apply everywhere;
          <b> database</b> skills only on a matching database.
        </div>

      <Show when={skillNote()}><div class="ai-note">{skillNote()}</div></Show>

      <div class="ai-skills">
        <Show when={skills().length === 0}>
          <div class="ai-empty-box">
            No skills yet. A skill is just Markdown — <b>New skill</b> to write one, or
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
              <input value={sk().description} onInput={(e) => setEditing({ ...sk(), description: e.currentTarget.value })} placeholder="One line — shown in this list, and to the model" />
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
                <option value="workspace">Workspace — every connection</option>
                <option value="database" disabled={!props.database && !sk().database}>
                  {props.database ? `This database — ${props.database}` : "One database (connect first)"}
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
            <div class="ai-skill-bodylabel">Instructions (Markdown) — this text is what reaches the model.</div>
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
