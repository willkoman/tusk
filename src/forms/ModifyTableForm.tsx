import { createMemo, createSignal, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { Dialog, DialogFooter } from "../Dialog";
import { Icon } from "../Icons";
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
import { ConfirmDialog } from "./ConfirmDialog";
import {
  dropLines,
  dropSummary,
  droppedNames,
  isDropped,
  sectionLabel,
  setDropped,
  tallyTotal,
  type DropSet,
  type DropTally,
} from "./dropState";
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

/** Editable fields whose value the dialog diffs against the catalog. */
export type ColumnField = "name" | "type" | "nullable" | "default" | "comment" | "isPk";

/**
 * Whether one field of an existing column now differs from what the catalog
 * reported. A column the dialog added has no catalog side, so nothing is marked
 * "changed" on it — the whole row is already marked as new. Pure; tested.
 */
export function changed(row: Pick<Row, "orig" | ColumnField | "origPk">, field: ColumnField): boolean {
  const orig = row.orig;
  if (!orig) return false;
  switch (field) {
    case "name":
      return row.name !== orig.name;
    case "type":
      return row.type !== orig.type;
    case "nullable":
      return row.nullable !== orig.nullable;
    case "default":
      return (row.default ?? "") !== (orig.default ?? "");
    case "comment":
      return (row.comment ?? "") !== (orig.comment ?? "");
    case "isPk":
      return row.isPk !== row.origPk;
  }
}

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
  const [dropIdx, setDropIdx] = createSignal<DropSet>({});
  const [dropCon, setDropCon] = createSignal<DropSet>({});
  const [uniques, setUniques] = createStore<UniqueDraft[]>([]);
  const [checks, setChecks] = createStore<CheckDraft[]>([]);
  const [fks, setFks] = createStore<(FkDraft & { uid: number })[]>([]);
  const [showAdd, setShowAdd] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);

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
      .filter((ix) => !ix.primary && !isDropped(dropIdx(), ix.name) && ix.def.trim())
      .map((ix) => ix.def),
  );
  // Constraints the rebuilt CREATE TABLE must carry across verbatim. The primary key is
  // excluded because it comes from the column list; everything else would otherwise be
  // silently lost when the original table is dropped.
  const keepConstraints = createMemo(() =>
    props.detail.constraints
      .filter((c) => c.kind !== "primary_key" && !isDropped(dropCon(), c.name) && c.def.trim())
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
      .filter((ix) => !ix.primary && !isDropped(dropIdx(), ix.name))
      .map((ix) => ({ name: ix.name, kind: "index" as const, columns: ix.columns ?? [] })),
    ...props.detail.constraints
      .filter((c) => c.kind !== "primary_key" && !isDropped(dropCon(), c.name))
      .map((c) => ({ name: c.name, kind: "constraint" as const, columns: c.columns ?? [] })),
    ...props.detail.triggers.map((t) => ({
      name: t.name,
      kind: "trigger" as const,
      columns: props.detail.columns.map((c) => c.name).filter((n) => mentionsIdentifier(t.def, n)),
    })),
  ]);

  const indexNames = createMemo(() => shownIndexes().map((ix) => ix.name));
  const constraintNames = createMemo(() => props.detail.constraints.map((c) => c.name));
  const droppedIndexes = createMemo(() => droppedNames(dropIdx(), indexNames()));
  const droppedConstraints = createMemo(() => droppedNames(dropCon(), constraintNames()));
  const droppedColumns = createMemo(() =>
    cols.filter((r) => r.dropped && r.orig).map((r) => r.orig!.name),
  );
  /** Every object one Apply would destroy — the section counts, the footer line and
   *  the confirmation all read this one tally. */
  const tally = createMemo<DropTally>(() => ({
    columns: droppedColumns(),
    indexes: droppedIndexes(),
    constraints: droppedConstraints(),
  }));

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
    dropIndexes: droppedIndexes(),
    dropConstraints: droppedConstraints(),
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
    return `Tusk rebuilds the table: create, copy, drop, rename. Columns, primary key, table options and every kept constraint, index and trigger are recreated. Foreign-key enforcement is off during the run. ${base}`;
  });

  const toggleUniqueCol = (i: number, c: string) =>
    setUniques(i, "columns", (cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));

  const run = async (script: string) => {
    setBusy(true);
    setError("");
    const r = await props.onRun(script);
    setBusy(false);
    if (r.ok) props.onClose();
    else setError(r.error ?? "failed");
    return r;
  };
  /** A drop is irreversible once applied, so Apply stops for a confirmation that
   *  names every object. Without a pending drop it runs straight away. */
  const apply = () => {
    if (!sql()) return;
    if (tallyTotal(tally())) setConfirming(true);
    else void run(sql());
  };

  return (
    <>
    <Dialog
      title="Modify table"
      subtitle={`${schema}.${table}`}
      size="xl"
      onClose={props.onClose}
      footer={
        <DialogFooter
          sql={sql()}
          error={error()}
          busy={busy()}
          disabled={!sql()}
          summary={dropSummary(tally())}
          primaryLabel={rebuilding() ? "Rebuild table" : "Apply changes"}
          primaryDanger={tallyTotal(tally()) > 0}
          onPrimary={apply}
          onEditAsSql={() => props.onEditAsSql(sql())}
          onCancel={props.onClose}
        />
      }
    >
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

      <div class="field-label">{sectionLabel("Columns", droppedColumns().length)}</div>
      <div class="col-builder cb-scroll">
        <div class="cb-head">
          <span />
          <span>Name</span>
          <span>Type</span>
          <span>Flags</span>
          <span class="cb-head-actions">Action</span>
        </div>
        <For each={cols}>
          {(c, i) => (
            <div class="cb-col" classList={{ "row-dropped": c.dropped, "row-new": !c.orig }}>
              <div class="cb-line1">
                {/* Column order is only expressible where the table can be rebuilt
                    (SQLite); everywhere else ALTER TABLE has no way to move a column. */}
                <span class="cb-order">
                  <Show when={caps.rebuild}>
                    <button class="icon" title="Move up" disabled={i() === 0} onClick={() => move(i(), -1)}><Icon name="arrowUp" /></button>
                    <button class="icon" title="Move down" disabled={i() === cols.length - 1} onClick={() => move(i(), 1)}><Icon name="arrowDown" /></button>
                  </Show>
                </span>
                <input
                  value={c.name}
                  classList={{ "cb-changed": changed(c, "name") }}
                  disabled={c.dropped}
                  onInput={(e) => setCols(i(), "name", e.currentTarget.value)}
                  placeholder="name"
                />
                <Show when={!isGenerated(c)} fallback={<span class="mono muted-hint">{c.type}</span>}>
                  <span classList={{ "cb-changed": changed(c, "type") }}>
                    <SqlField value={c.type} typesOnly onChange={(v) => setCols(i(), "type", v)} placeholder="type" />
                  </span>
                </Show>
                <span class="cb-flags">
                  <label class="cb-flag" classList={{ "cb-changed": changed(c, "nullable") }} title="Nullable">
                    <input type="checkbox" disabled={c.dropped || isGenerated(c)} checked={c.nullable} onChange={(e) => setCols(i(), "nullable", e.currentTarget.checked)} />
                    Null
                  </label>
                  <label class="cb-flag" classList={{ "cb-changed": changed(c, "isPk") }} title="Primary key">
                    <input type="checkbox" disabled={c.dropped || isGenerated(c)} checked={c.isPk} onChange={(e) => setCols(i(), "isPk", e.currentTarget.checked)} />
                    PK
                  </label>
                </span>
              </div>
              {/* Line 2 precedes the actions in the DOM so Tab runs
                  name → type → flags → default → comment. */}
              <div class="cb-line2">
                <label class="cb-sub" classList={{ "is-set": !!c.default?.trim(), "cb-changed": changed(c, "default") }}>
                  <span class="cb-sub-label">Default</span>
                  <Show
                    when={!isGenerated(c)}
                    fallback={<span class="mono muted-hint" title={c.generated}>generated</span>}
                  >
                    <SqlField value={c.default} columns={colNames()} onChange={(v) => setCols(i(), "default", v)} placeholder="(none)" />
                  </Show>
                </label>
                <label class="cb-sub" classList={{ "is-set": !!c.comment?.trim(), "cb-changed": changed(c, "comment") }}>
                  <span class="cb-sub-label">Comment</span>
                  <input
                    value={c.comment}
                    disabled={c.dropped || isGenerated(c) || caps.comments === "none"}
                    onInput={(e) => setCols(i(), "comment", e.currentTarget.value)}
                    placeholder={caps.comments === "none" ? `no comments on ${caps.label}` : "(none)"}
                  />
                </label>
              </div>
              {/* Columns, indexes and constraints all drop the same way: a named
                  button that flips the row into a reversible "will be dropped" state. */}
              <span class="cb-actions">
                <Show
                  when={c.orig && c.dropped}
                  fallback={
                    <button class="btn-drop" onClick={() => removeRow(i())}>{c.orig ? "Drop" : "Remove"}</button>
                  }
                >
                  <button class="btn-keep" onClick={() => removeRow(i())}>Keep</button>
                </Show>
              </span>
            </div>
          )}
        </For>
        <button class="ghost cb-add" onClick={addRow}><Icon name="plus" /> Add column</button>
      </div>

      <Show when={shownIndexes().length}>
        <div class="field-label">{sectionLabel("Indexes", droppedIndexes().length)}</div>
        <div class="drop-list">
          <For each={shownIndexes()}>
            {(ix) => (
              <div class="drop-row" classList={{ "row-dropped": isDropped(dropIdx(), ix.name) }}>
                <span class="mono">{ix.name}</span>
                <span class="muted-hint">{ix.primary ? "primary key" : ix.unique ? "unique" : "index"}</span>
                <Show
                  when={!ix.primary}
                  fallback={<span class="drop-locked">Managed in Columns</span>}
                >
                  <Show
                    when={isDropped(dropIdx(), ix.name)}
                    fallback={
                      <button class="btn-drop" onClick={() => setDropIdx(setDropped(dropIdx(), ix.name, true))}>Drop</button>
                    }
                  >
                    <button class="btn-keep" onClick={() => setDropIdx(setDropped(dropIdx(), ix.name, false))}>Keep</button>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={props.detail.constraints.length}>
        <div class="field-label">{sectionLabel("Constraints", droppedConstraints().length)}</div>
        <div class="drop-list">
          <For each={props.detail.constraints}>
            {(c) => (
              <div class="drop-row" classList={{ "row-dropped": isDropped(dropCon(), c.name) }}>
                <span class="mono">{c.name}</span>
                <span class="muted-hint">{c.kind.replace("_", " ")}</span>
                <Show
                  when={caps.dropConstraint !== "none" || caps.rebuild}
                  fallback={<span class="drop-locked">No constraint drop on {caps.label}</span>}
                >
                  <Show
                    when={isDropped(dropCon(), c.name)}
                    fallback={
                      <button class="btn-drop" onClick={() => setDropCon(setDropped(dropCon(), c.name, true))}>Drop</button>
                    }
                  >
                    <button class="btn-keep" onClick={() => setDropCon(setDropped(dropCon(), c.name, false))}>Keep</button>
                  </Show>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>

      <Show when={caps.addConstraint || caps.rebuild}>
        <button class="ghost full" onClick={() => setShowAdd(!showAdd())}>
          <Icon name={showAdd() ? "chevronDown" : "chevronRight"} /> Add unique / check / foreign-key constraints
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
            <Icon name="plus" /> Add unique constraint
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
            <Icon name="plus" /> Add check constraint
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
              <Icon name="plus" /> Add foreign key
            </button>
          </Show>
        </Show>
      </Show>

      <Show when={errors().length}>
        <div class="field-error">{errors()[0].message}</div>
      </Show>
      <Show when={note()}>
        <div class="muted-hint script-note">{note()}</div>
      </Show>
    </Dialog>
    <Show when={confirming()}>
      <ConfirmDialog
        title="Apply changes?"
        subtitle={`${schema}.${table}`}
        lead="These objects are dropped and cannot be recovered."
        lines={dropLines(tally())}
        primaryLabel={rebuilding() ? "Rebuild table" : "Apply changes"}
        build={() => sql()}
        onClose={() => setConfirming(false)}
        onRun={(script) => run(script)}
        onEditAsSql={(script) => {
          setConfirming(false);
          props.onEditAsSql(script);
        }}
      />
    </Show>
    </>
  );
}
