import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dialog, DialogFooter } from "../Dialog";
import { SqlField } from "../SqlField";
import {
  droppableIndexes,
  mentionsIdentifier,
  needsRebuild,
  scriptNote,
  tableDiff,
  tableDiffProblems,
  validateColumns,
  type Dependent,
  type FkSpec,
} from "../sql/ddl";
import { ddlCaps } from "../sql/ddlCaps";
import type { Column, NodeDescriptor, RelationDetail } from "../Tree";
import { emptyFk, fkSpecOf, FkEditor, type FkDraft, type RefColumn, type RefTable } from "./FkEditor";

type Row = {
  uid: number;
  orig: { name: string; type: string; nullable: boolean; default: string; comment: string; identity?: boolean } | null;
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  comment: string;
  isPk: boolean;
  origPk: boolean;
  dropped: boolean;
  identity?: boolean;
  /** Catalog-only column facts a rebuild must carry across verbatim; the dialog never
   *  edits them, and a generated column refuses to be rewritten at all. */
  collate?: string;
  check?: string;
  generated?: string;
  onUpdate?: string;
};

/** A generated column cannot be restated by MySQL's MODIFY nor recreated from the
 *  dialog's fields, so its inputs are read-only. */
const isGenerated = (r: Row) => !!r.generated?.trim();

let uid = 1;
const fromColumn = (c: Column): Row => ({
  uid: uid++,
  orig: {
    name: c.name,
    type: c.data_type,
    nullable: c.nullable,
    default: c.default ?? "",
    comment: c.comment ?? "",
    identity: c.identity ?? false,
  },
  name: c.name,
  type: c.data_type,
  nullable: c.nullable,
  default: c.default ?? "",
  comment: c.comment ?? "",
  isPk: c.is_pk,
  origPk: c.is_pk,
  dropped: false,
  identity: c.identity ?? false,
  collate: c.collate ?? undefined,
  check: c.check ?? undefined,
  generated: c.generated ?? undefined,
  onUpdate: c.on_update ?? undefined,
});
const newRow = (): Row => ({
  uid: uid++,
  orig: null,
  name: "",
  type: "text",
  nullable: true,
  default: "",
  comment: "",
  isPk: false,
  origPk: false,
  dropped: false,
  identity: false,
});

type UniqueDraft = { uid: number; name: string; columns: string[] };
type CheckDraft = { uid: number; name: string; expr: string };

/** DataGrip-style table modifier: edit columns (rename/type/null/default/PK/comment),
 *  add/drop columns, add and drop constraints and indexes, rename + comment the table,
 *  and (PostgreSQL) move it to another schema. The diff → ALTER script (`tableDiff` in
 *  sql/ddl.ts) is the live preview; on SQLite a change ALTER TABLE cannot express is
 *  emitted as the documented table rebuild instead. */
export function ModifyTableForm(props: {
  ctx: NodeDescriptor;
  detail: RelationDetail;
  /** Schemas the table can be moved to (PostgreSQL). */
  schemas?: string[];
  /** Tables the FK picker can point at. */
  tables?: RefTable[];
  loadColumns?: (schema: string, table: string) => Promise<RefColumn[] | null>;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
}) {
  const caps = ddlCaps();
  const schema = props.ctx.schema!;
  const table = props.ctx.name;
  const [cols, setCols] = createStore<Row[]>(props.detail.columns.map(fromColumn));
  const [tableName, setTableName] = createSignal(table);
  const [tableSchema, setTableSchema] = createSignal(schema);
  const [tableComment, setTableComment] = createSignal(props.detail.comment ?? "");
  const [dropIdx, setDropIdx] = createSignal<Record<string, boolean>>({});
  const [dropCon, setDropCon] = createSignal<Record<string, boolean>>({});
  const [uniques, setUniques] = createStore<UniqueDraft[]>([]);
  const [checks, setChecks] = createStore<CheckDraft[]>([]);
  const [fks, setFks] = createStore<(FkDraft & { uid: number })[]>([]);
  const [showAdd, setShowAdd] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");

  const colNames = () => cols.filter((r) => !r.dropped && r.name.trim()).map((r) => r.name.trim());
  const localCols = () =>
    cols.filter((r) => !r.dropped && r.name.trim()).map((r) => ({ name: r.name.trim(), data_type: r.type }));
  const addRow = () => setCols(produce((c) => c.push(newRow())));
  const removeRow = (i: number) => {
    const r = cols[i];
    if (r.orig) setCols(i, "dropped", !r.dropped);
    else setCols(produce((c) => c.splice(i, 1)));
  };
  const move = (i: number, by: number) =>
    setCols(
      produce((c) => {
        const j = i + by;
        if (j < 0 || j >= c.length) return;
        const [row] = c.splice(i, 1);
        c.splice(j, 0, row);
      }),
    );

  const constraintKinds = createMemo(() => Object.fromEntries(props.detail.constraints.map((c) => [c.name, c.kind])));
  // An index that BACKS a constraint is listed once, under Constraints. Ticking it in
  // both lists emitted two drops for the one object; the second fails, and on MySQL —
  // where every DDL statement commits as it runs — the first one stays applied.
  const shownIndexes = createMemo(() => droppableIndexes(props.detail.indexes, props.detail.constraints));
  // Indexes that must be replayed after a SQLite rebuild: the explicit ones the user is
  // keeping (constraint-backed indexes come back with the recreated CREATE TABLE).
  const keepIndexes = createMemo(() =>
    shownIndexes()
      .filter((ix) => !ix.primary && !dropIdx()[ix.name] && ix.def.trim())
      .map((ix) => ix.def),
  );
  // Constraints the rebuilt CREATE TABLE must carry across verbatim. The primary key is
  // excluded because it comes from the column list; everything else would otherwise be
  // silently lost when the original table is dropped.
  const keepConstraints = createMemo(() =>
    props.detail.constraints
      .filter((c) => c.kind !== "primary_key" && !dropCon()[c.name] && c.def.trim())
      .map((c) => c.def),
  );
  // SQLite stores a trigger's whole CREATE text and the DROP takes the table's triggers
  // with it, so the rebuild replays them instead of asking the user to redo it by hand.
  const keepTriggers = createMemo(() =>
    caps.rebuild ? props.detail.triggers.filter((t) => t.def.trim()).map((t) => t.def) : [],
  );
  // Everything the rebuild recreates verbatim, with the columns each object names:
  // dropping or renaming one of those columns must be refused, not emitted.
  const dependents = createMemo<Dependent[]>(() => [
    ...shownIndexes()
      .filter((ix) => !ix.primary && !dropIdx()[ix.name])
      .map((ix) => ({ name: ix.name, kind: "index" as const, columns: ix.columns ?? [] })),
    ...props.detail.constraints
      .filter((c) => c.kind !== "primary_key" && !dropCon()[c.name])
      .map((c) => ({ name: c.name, kind: "constraint" as const, columns: c.columns ?? [] })),
    ...props.detail.triggers.map((t) => ({
      name: t.name,
      kind: "trigger" as const,
      columns: props.detail.columns.map((c) => c.name).filter((n) => mentionsIdentifier(t.def, n)),
    })),
  ]);

  const spec = createMemo(() => ({
    schema,
    table,
    newName: tableName(),
    newSchema: tableSchema(),
    newComment: tableComment(),
    origComment: props.detail.comment ?? "",
    pkName: props.detail.constraints.find((c) => c.kind === "primary_key")?.name,
    columns: cols.map((r) => ({
      orig: r.orig,
      name: r.name,
      type: r.type,
      nullable: r.nullable,
      default: r.default,
      comment: r.comment,
      isPk: r.isPk,
      origPk: r.origPk,
      dropped: r.dropped,
      identity: r.identity,
      collate: r.collate,
      check: r.check,
      generated: r.generated,
      onUpdate: r.onUpdate,
    })),
    dropIndexes: shownIndexes().filter((ix) => dropIdx()[ix.name]).map((ix) => ix.name),
    dropConstraints: props.detail.constraints.filter((c) => dropCon()[c.name]).map((c) => c.name),
    constraintKinds: constraintKinds(),
    addUniques: uniques.filter((u) => u.columns.length).map((u) => ({ name: u.name, columns: u.columns })),
    addChecks: checks.filter((c) => c.expr.trim()).map((c) => ({ name: c.name, expr: c.expr })),
    addForeignKeys: fks.map(fkSpecOf).filter((f): f is FkSpec => !!f),
    keepIndexes: keepIndexes(),
    keepConstraints: keepConstraints(),
    keepTriggers: keepTriggers(),
    tableOptions: props.detail.table_options ?? "",
    origOrder: props.detail.columns.map((c) => c.name),
    dependents: dependents(),
    definitionRead: props.detail.definition_read ?? true,
  }));

  const problems = createMemo(() => [
    ...validateColumns(
      cols.filter((r) => !r.dropped),
      caps,
    ),
    ...tableDiffProblems(spec(), caps),
  ]);
  const errors = () => problems().filter((p) => p.level === "error");
  const rebuilding = createMemo(() => needsRebuild(spec(), caps));
  const sql = createMemo(() => (errors().length ? "" : tableDiff(spec())));
  const note = createMemo(() => {
    if (!sql()) return "";
    const base = scriptNote(sql(), caps);
    if (!rebuilding()) return base;
    const trg = props.detail.triggers.length
      ? ` Its triggers (${props.detail.triggers.map((t) => t.name).join(", ")}) are dropped with the table and recreated afterwards.`
      : "";
    return `SQLite can't change this in place, so Tusk rebuilds the table (create → copy → drop → rename): the columns, their CHECK/COLLATE/generated clauses, the primary key, the table options and the constraints and indexes listed above are all recreated.${trg} ${base}`;
  });

  const toggleUniqueCol = (i: number, c: string) =>
    setUniques(i, "columns", (cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  const apply = async () => {
    if (!sql()) return;
    setBusy(true);
    setError("");
    const r = await props.onRun(sql());
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
  };

  return (
    <Dialog title={`Modify table · ${table}`} onClose={props.onClose} width={Math.min(window.innerWidth - 80, 1100)}>
      <div class="modify-head">
        <label>Table name<input value={tableName()} onInput={(e) => setTableName(e.currentTarget.value)} /></label>
        <Show when={caps.comments !== "none"}>
          <label>Comment<input value={tableComment()} onInput={(e) => setTableComment(e.currentTarget.value)} placeholder="(none)" /></label>
        </Show>
        <Show when={caps.setSchema && (props.schemas?.length ?? 0) > 1}>
          <label>
            Schema
            <select value={tableSchema()} onChange={(e) => setTableSchema(e.currentTarget.value)}>
              <For each={props.schemas}>{(s) => <option value={s}>{s}</option>}</For>
            </select>
          </label>
        </Show>
      </div>

      <div class="field-label">Columns</div>
      <div class="col-builder modify-cols">
        <div class="col-builder-head modify-row">
          <span class="cb-move" />
          <span>Name</span>
          <span>Type</span>
          <span class="cb-flag">Null</span>
          <span class="cb-flag">PK</span>
          <span>Default</span>
          <span>Comment</span>
          <span class="cb-x" />
        </div>
        <For each={cols}>
          {(c, i) => (
            <div class="col-builder-row modify-row" classList={{ "row-dropped": c.dropped, "row-new": !c.orig }}>
              {/* Column order is only expressible where the table can be rebuilt
                  (SQLite); everywhere else ALTER TABLE has no way to move a column. */}
              <span class="cb-move">
                <Show when={caps.rebuild}>
                  <button class="icon" title="Move up" disabled={i() === 0} onClick={() => move(i(), -1)}>↑</button>
                  <button class="icon" title="Move down" disabled={i() === cols.length - 1} onClick={() => move(i(), 1)}>↓</button>
                </Show>
              </span>
              <input value={c.name} disabled={c.dropped} onInput={(e) => setCols(i(), "name", e.currentTarget.value)} placeholder="name" />
              <Show when={!isGenerated(c)} fallback={<span class="mono muted-hint">{c.type}</span>}>
                <SqlField value={c.type} typesOnly onChange={(v) => setCols(i(), "type", v)} placeholder="type" />
              </Show>
              <input class="cb-flag" type="checkbox" disabled={c.dropped || isGenerated(c)} checked={c.nullable} onChange={(e) => setCols(i(), "nullable", e.currentTarget.checked)} />
              <input class="cb-flag" type="checkbox" disabled={c.dropped || isGenerated(c)} checked={c.isPk} onChange={(e) => setCols(i(), "isPk", e.currentTarget.checked)} />
              <Show
                when={!isGenerated(c)}
                fallback={<span class="mono muted-hint" title={c.generated}>generated</span>}
              >
                <SqlField value={c.default} columns={colNames()} onChange={(v) => setCols(i(), "default", v)} placeholder="(none)" />
              </Show>
              <input
                value={c.comment}
                disabled={c.dropped || isGenerated(c) || caps.comments === "none"}
                onInput={(e) => setCols(i(), "comment", e.currentTarget.value)}
                placeholder={caps.comments === "none" ? `no comments on ${caps.label}` : "(none)"}
              />
              <button class="icon cb-x" title={c.orig ? (c.dropped ? "Keep" : "Drop column") : "Remove"} onClick={() => removeRow(i())}>
                {c.orig && c.dropped ? "↺" : "✕"}
              </button>
            </div>
          )}
        </For>
        <button class="ghost full" onClick={addRow}>＋ Add column</button>
      </div>

      <Show when={shownIndexes().length}>
        <div class="field-label">Indexes</div>
        <div class="drop-list">
          <For each={shownIndexes()}>
            {(ix) => (
              <label class="checkbox drop-row" classList={{ "row-dropped": dropIdx()[ix.name] }}>
                <input
                  type="checkbox"
                  disabled={ix.primary}
                  checked={!!dropIdx()[ix.name]}
                  onChange={(e) => setDropIdx({ ...dropIdx(), [ix.name]: e.currentTarget.checked })}
                />
                <span class="mono">{ix.name}</span>
                <span class="muted-hint">{ix.primary ? "pk (managed above)" : ix.unique ? "unique" : "drop"}</span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.detail.constraints.length}>
        <div class="field-label">Constraints</div>
        <div class="drop-list">
          <For each={props.detail.constraints}>
            {(c) => (
              <label class="checkbox drop-row" classList={{ "row-dropped": dropCon()[c.name] }}>
                <input
                  type="checkbox"
                  disabled={caps.dropConstraint === "none" && !caps.rebuild}
                  checked={!!dropCon()[c.name]}
                  onChange={(e) => setDropCon({ ...dropCon(), [c.name]: e.currentTarget.checked })}
                />
                <span class="mono">{c.name}</span>
                <span class="muted-hint">
                  {c.kind.replace("_", " ")}
                  {caps.dropConstraint === "none" && !caps.rebuild ? ` · ${caps.label} can't drop this via ALTER` : ""}
                </span>
              </label>
            )}
          </For>
        </div>
      </Show>

      <Show when={caps.addConstraint || caps.rebuild}>
        <button class="ghost full" onClick={() => setShowAdd(!showAdd())}>
          {showAdd() ? "▾" : "▸"} Add unique / check / foreign-key constraints
        </button>
        <Show when={showAdd()}>
          <div class="field-label">New UNIQUE constraints</div>
          <For each={uniques}>
            {(u, i) => (
              <div class="con-block">
                <input value={u.name} onInput={(e) => setUniques(i(), "name", e.currentTarget.value)} placeholder="constraint name (optional)" />
                <div class="chip-picker">
                  <For each={colNames()}>
                    {(c) => (
                      <button class="chip" classList={{ active: u.columns.includes(c) }} onClick={() => toggleUniqueCol(i(), c)}>
                        {u.columns.includes(c) ? `${u.columns.indexOf(c) + 1}. ` : ""}{c}
                      </button>
                    )}
                  </For>
                </div>
                <button class="ghost" onClick={() => setUniques(produce((x) => x.splice(i(), 1)))}>Remove</button>
              </div>
            )}
          </For>
          <button class="ghost full" onClick={() => setUniques(produce((x) => x.push({ uid: uid++, name: "", columns: [] })))}>
            ＋ Add unique constraint
          </button>

          <div class="field-label">New CHECK constraints</div>
          <For each={checks}>
            {(c, i) => (
              <div class="con-block">
                <input value={c.name} onInput={(e) => setChecks(i(), "name", e.currentTarget.value)} placeholder="constraint name (optional)" />
                <SqlField value={c.expr} columns={colNames()} onChange={(v) => setChecks(i(), "expr", v)} placeholder="e.g. price > 0" />
                <button class="ghost" onClick={() => setChecks(produce((x) => x.splice(i(), 1)))}>Remove</button>
              </div>
            )}
          </For>
          <button class="ghost full" onClick={() => setChecks(produce((x) => x.push({ uid: uid++, name: "", expr: "" })))}>
            ＋ Add check constraint
          </button>

          <Show when={props.tables}>
            <div class="field-label">New foreign keys</div>
            <For each={fks}>
              {(f, i) => (
                <div class="fk-block">
                  <FkEditor
                    localColumns={localCols()}
                    tables={props.tables ?? []}
                    loadColumns={props.loadColumns}
                    value={f}
                    onChange={(patch) => setFks(i(), patch)}
                  />
                  <button class="ghost" onClick={() => setFks(produce((x) => x.splice(i(), 1)))}>Remove foreign key</button>
                </div>
              )}
            </For>
            <button class="ghost full" onClick={() => setFks(produce((x) => x.push({ ...emptyFk(), uid: uid++ })))}>
              ＋ Add foreign key
            </button>
          </Show>
        </Show>
      </Show>

      <Show when={errors().length}>
        <div class="error">{errors()[0].message}</div>
      </Show>
      <Show when={note()}>
        <div class="muted-hint script-note">{note()}</div>
      </Show>
      <DialogFooter
        sql={sql()}
        error={error()}
        busy={busy()}
        disabled={!sql()}
        primaryLabel={rebuilding() ? "Rebuild table" : "Apply changes"}
        onPrimary={apply}
        onEditAsSql={() => props.onEditAsSql(sql())}
        onCancel={props.onClose}
      />
    </Dialog>
  );
}
