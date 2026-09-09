import { type JSX, createMemo, createSignal, For, Show } from "solid-js";
import { Dialog, DialogFooter } from "../Dialog";

/** What the confirmation states about the object before it destroys it. */
export type DangerFacts = {
  /** "table", "schema", "index" … — the kind, spelled out. */
  kind?: string;
  /** Qualified name, shown in mono. */
  name?: string;
  /** Planner row estimate, when the Explorer already has one. */
  rows?: string;
  /** On-disk size, when known. */
  size?: string;
  /** Objects a CASCADE would take with it, when known. */
  dependents?: string[];
};

/**
 * Destructive confirmation (DROP / TRUNCATE).
 *
 * An irreversible action on a live database gets more than a sentence: it names
 * the object and its kind, states how much data goes, and — for a table, schema
 * or database — will not run until the name is typed back. The danger button
 * stands alone next to Cancel, so there is no second destructive control beside
 * it to mis-click, and "Edit as SQL" is a deliberate escape hatch rather than a
 * neighbour of the primary.
 */
export function ConfirmDialog(props: {
  title: string;
  titleBadge?: JSX.Element;
  /** One line under the title naming what is acted on. */
  subtitle?: string;
  primaryLabel: string;
  /** One sentence above the list: what the primary action does. */
  lead?: string;
  /** Body lines shown above the options, e.g. every object a drop will destroy. */
  lines?: string[];
  facts?: DangerFacts;
  /** Require the object's name to be typed before the primary unlocks. */
  confirmName?: string;
  showCascade?: boolean;
  showRestartIdentity?: boolean;
  build: (o: { cascade: boolean; restartIdentity: boolean }) => string;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const [cascade, setCascade] = createSignal(false);
  const [restartIdentity, setRestartIdentity] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const sql = createMemo(() => props.build({ cascade: cascade(), restartIdentity: restartIdentity() }));
  const locked = () => !!props.confirmName && typed().trim() !== props.confirmName;
  const facts = () => props.facts ?? {};
  const hasFacts = () => !!(facts().kind || facts().name || facts().rows || facts().size);

  const apply = async () => {
    if (locked()) return;
    setBusy(true);
    setError("");
    const r = await props.onRun(sql());
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
  };

  return (
    <Dialog
      title={props.title}
      titleBadge={props.titleBadge}
      subtitle={props.subtitle}
      size="md"
      noAutoFocus
      onClose={props.onClose}
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          disabled={locked()}
          primaryLabel={props.primaryLabel}
          primaryDanger
          hideEditAsSql
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
          extra={
            <button class="ghost" onClick={() => props.onEditAsSql(sql())}>Edit as SQL</button>
          }
        />
      }
    >
      <Show when={props.lead}>
        <p class="danger-lead">{props.lead}</p>
      </Show>
      <Show when={hasFacts()}>
        <dl class="danger-facts">
          <Show when={facts().kind}>
            <dt>Object</dt>
            <dd class="plain">{facts().kind}</dd>
          </Show>
          <Show when={facts().name}>
            <dt>Name</dt>
            <dd>{facts().name}</dd>
          </Show>
          <Show when={facts().rows}>
            <dt>Rows</dt>
            <dd class="plain">{facts().rows}</dd>
          </Show>
          <Show when={facts().size}>
            <dt>Size</dt>
            <dd class="plain">{facts().size}</dd>
          </Show>
        </dl>
      </Show>
      <Show when={facts().dependents?.length}>
        <div class="field-label">Dependent objects</div>
        <ul class="danger-deps">
          <For each={facts().dependents}>{(d) => <li>{d}</li>}</For>
        </ul>
      </Show>
      <Show when={props.lines?.length}>
        <ul class="confirm-list">
          <For each={props.lines}>{(l) => <li>{l}</li>}</For>
        </ul>
      </Show>
      <Show when={props.showCascade}>
        <label class="checkbox">
          <input type="checkbox" checked={cascade()} onChange={(e) => setCascade(e.currentTarget.checked)} />
          Also drop everything that depends on it (CASCADE)
        </label>
      </Show>
      <Show when={props.showRestartIdentity}>
        <label class="checkbox">
          <input type="checkbox" checked={restartIdentity()} onChange={(e) => setRestartIdentity(e.currentTarget.checked)} />
          Reset owned sequences to their start (RESTART IDENTITY)
        </label>
      </Show>
      <Show when={props.confirmName}>
        <label class="type-confirm">
          <span class="type-confirm-ask">Type <b>{props.confirmName}</b> to confirm</span>
          <input
            value={typed()}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => setTyped(e.currentTarget.value)}
          />
        </label>
      </Show>
    </Dialog>
  );
}
