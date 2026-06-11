import { createSignal, For, Show, type JSX } from "solid-js";
import { Icon, type IconName } from "./Icons";

export type Column = {
  name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
  is_fk: boolean;
  default: string | null;
  comment: string | null;
};
export type Idx = { name: string; unique: boolean; primary: boolean; def: string };
export type Con = { name: string; kind: string; def: string };
export type RelStub = {
  name: string;
  kind: string;
  comment: string | null;
  rows: number | null; // planner estimate (PG reltuples); null = unknown / non-PG
  size: string | null; // pretty total size (tables/matviews)
};
export type Trg = { name: string; def: string };
export type RelationDetail = {
  name: string;
  kind: string;
  comment: string | null;
  columns: Column[];
  indexes: Idx[];
  constraints: Con[];
  triggers: Trg[];
};
export type Func = { name: string; args: string; returns: string };
export type SchemaT = {
  name: string;
  tables: RelStub[];
  views: RelStub[];
  sequences: string[];
  functions: Func[];
};
export type DbTree = { database: string; databases: string[]; schemas: SchemaT[] };

export type NodeKind =
  | "database"
  | "schema"
  | "table"
  | "view"
  | "matview"
  | "column"
  | "index"
  | "constraint"
  | "sequence"
  | "function"
  | "trigger";

/** Identifies a tree node for the context menu / actions. */
export type NodeDescriptor = {
  kind: NodeKind;
  schema?: string; // owning schema (also set to its own name when kind === "schema")
  table?: string; // owning relation (for column/index/constraint)
  name: string; // the object's own name (db name when kind === "database")
  detail?: RelationDetail; // loaded relation detail, when available
  column?: Column; // for kind === "column"
  trigger?: Trg; // for kind === "trigger" (def carried so Copy DDL needs no roundtrip)
};

/** Stable identity key for selection/highlight (ignores transient `detail`). */
export const nodeKey = (n: NodeDescriptor) => `${n.kind}|${n.schema ?? ""}|${n.table ?? ""}|${n.name}`;

const conIconName = (k: string): IconName =>
  k === "primary_key" ? "key" : k === "foreign_key" ? "link" : k === "unique" ? "hash" : k === "check" ? "check" : "dot";

export function Tree(props: {
  tree: DbTree;
  details: Record<string, RelationDetail>;
  filter?: string;
  selectedKey?: string;
  onRunTable: (schema: string, name: string) => void;
  onExpandTable: (schema: string, name: string) => void;
  onContext: (e: MouseEvent, node: NodeDescriptor) => void;
  onSelect: (node: NodeDescriptor) => void;
}) {
  const [open, setOpen] = createSignal<Set<string>>(new Set(["db", "s:public", "c:public:tables"]));
  const f = () => (props.filter ?? "").trim().toLowerCase();
  const match = (s: string) => s.toLowerCase().includes(f());
  // While filtering, auto-expand structural containers (db / schema / category) so
  // matches are visible — but NOT relations (that would show endless "loading…").
  const isOpen = (k: string) => {
    if (f() && (k === "db" || k.startsWith("s:") || k.startsWith("c:"))) return true;
    return open().has(k);
  };

  // Schemas/objects narrowed by the filter. A schema whose own name matches keeps
  // all its children; otherwise only matching children are shown.
  const shownSchemas = (): SchemaT[] => {
    if (!f()) return props.tree.schemas;
    return props.tree.schemas
      .map((s) =>
        match(s.name)
          ? s
          : {
              ...s,
              tables: s.tables.filter((r) => match(r.name)),
              views: s.views.filter((r) => match(r.name)),
              sequences: s.sequences.filter(match),
              functions: s.functions.filter((fn) => match(fn.name)),
            },
      )
      .filter((s) => match(s.name) || s.tables.length || s.views.length || s.sequences.length || s.functions.length);
  };
  const toggle = (k: string) => {
    const s = new Set(open());
    s.has(k) ? s.delete(k) : s.add(k);
    setOpen(s);
  };

  function Row(p: {
    depth: number;
    icon: JSX.Element;
    label: string;
    detail?: string;
    title?: string;
    muted?: boolean;
    header?: boolean;
    expandable?: boolean;
    open?: boolean;
    selected?: boolean;
    onToggle?: () => void;
    onActivate?: () => void;
    onContext?: (e: MouseEvent) => void;
    onSelect?: () => void;
  }) {
    return (
      <div
        class="tw-row"
        classList={{ muted: p.muted, selected: p.selected, "is-header": p.header }}
        title={p.title}
        style={{ "padding-left": `${p.depth * 13 + 6}px`, "--d": p.depth }}
        onClick={() => {
          p.onSelect?.();
          p.expandable ? p.onToggle?.() : p.onActivate?.();
        }}
        onDblClick={() => p.onActivate?.()}
        onContextMenu={(e) => {
          e.stopPropagation();
          p.onSelect?.();
          p.onContext?.(e);
        }}
      >
        <span class="tw-caret">{p.expandable ? (p.open ? "▾" : "▸") : ""}</span>
        <span class="tw-icon">{p.icon}</span>
        <span class="tw-label">{p.label}</span>
        <Show when={p.detail}>
          <span class="tw-detail" classList={{ "is-count": /^\d+$/.test(p.detail!) }}>{p.detail}</span>
        </Show>
      </div>
    );
  }

  const colTitle = (c: Column) =>
    [c.default ? `default: ${c.default}` : null, c.comment ? `💬 ${c.comment}` : null]
      .filter(Boolean)
      .join("\n") || undefined;

  // ≈1.2K / ≈34M style row estimate for the tw-detail slot.
  const fmtApprox = (n: number): string =>
    n < 1_000
      ? `${n}`
      : n < 1_000_000
        ? `${+(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}K`
        : n < 1_000_000_000
          ? `${+(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`
          : `${+(n / 1_000_000_000).toFixed(1)}B`;

  const relMeta = (rel: RelStub): string | undefined => {
    const parts: string[] = [];
    if (rel.rows != null) parts.push(`≈${fmtApprox(rel.rows)}`);
    if (rel.size) parts.push(rel.size);
    return parts.length ? parts.join(" · ") : undefined;
  };

  const relation = (schema: string, rel: RelStub, depth: number) => {
    const isView = rel.kind === "view" || rel.kind === "matview";
    const kind = rel.kind as NodeKind;
    const tk = `${isView ? "view" : "tbl"}:${schema}:${rel.name}`;
    const ck = `${tk}:cols`;
    const ik = `${tk}:idx`;
    const xk = `${tk}:con`;
    const gk = `${tk}:trg`;
    const dkey = `${schema}.${rel.name}`;
    const det = () => props.details[dkey] as RelationDetail | undefined;
    const openRel = () => {
      const willOpen = !isOpen(tk);
      toggle(tk);
      if (willOpen) props.onExpandTable(schema, rel.name);
    };
    return (
      <>
        <Row
          depth={depth}
          icon={<Icon name={isView ? "eye" : "table"} />}
          label={rel.name}
          detail={relMeta(rel) ?? (det() ? `${det()!.columns.length}` : undefined)}
          title={rel.comment ?? undefined}
          expandable
          open={isOpen(tk)}
          selected={props.selectedKey === nodeKey({ kind, schema, name: rel.name })}
          onToggle={openRel}
          onActivate={() => props.onRunTable(schema, rel.name)}
          onSelect={() => props.onSelect({ kind, schema, name: rel.name, detail: det() })}
          onContext={(e) => props.onContext(e, { kind, schema, name: rel.name, detail: det() })}
        />
        <Show when={isOpen(tk)}>
          <Show when={det()} fallback={<Row depth={depth + 1} icon={<Icon name="dot" />} label="loading…" muted />}>
            {(d) => (
              <>
                <Row depth={depth + 1} header icon={<Icon name="columns" />} label="Columns" detail={`${d().columns.length}`} expandable open={isOpen(ck)} onToggle={() => toggle(ck)} />
                <Show when={isOpen(ck)}>
                  <For each={d().columns}>
                    {(c) => (
                      <Row
                        depth={depth + 2}
                        icon={<Icon name={c.is_pk ? "key" : c.is_fk ? "link" : "dot"} />}
                        label={c.name}
                        detail={c.data_type + (c.nullable ? "" : " ·NN")}
                        title={colTitle(c)}
                        selected={props.selectedKey === nodeKey({ kind: "column", schema, table: rel.name, name: c.name })}
                        onSelect={() => props.onSelect({ kind: "column", schema, table: rel.name, name: c.name, column: c })}
                        onContext={(e) => props.onContext(e, { kind: "column", schema, table: rel.name, name: c.name, column: c })}
                      />
                    )}
                  </For>
                </Show>
                <Show when={d().indexes.length}>
                  <Row depth={depth + 1} header icon={<Icon name="index" />} label="Indexes" detail={`${d().indexes.length}`} expandable open={isOpen(ik)} onToggle={() => toggle(ik)} />
                  <Show when={isOpen(ik)}>
                    <For each={d().indexes}>
                      {(x) => (
                        <Row
                          depth={depth + 2}
                          icon={<Icon name={x.primary ? "key" : x.unique ? "hash" : "index"} />}
                          label={x.name}
                          detail={x.primary ? "pk" : x.unique ? "unique" : ""}
                          title={x.def}
                          selected={props.selectedKey === nodeKey({ kind: "index", schema, table: rel.name, name: x.name })}
                          onSelect={() => props.onSelect({ kind: "index", schema, table: rel.name, name: x.name })}
                          onContext={(e) => props.onContext(e, { kind: "index", schema, table: rel.name, name: x.name })}
                        />
                      )}
                    </For>
                  </Show>
                </Show>
                <Show when={d().constraints.length}>
                  <Row depth={depth + 1} header icon={<Icon name="shield" />} label="Constraints" detail={`${d().constraints.length}`} expandable open={isOpen(xk)} onToggle={() => toggle(xk)} />
                  <Show when={isOpen(xk)}>
                    <For each={d().constraints}>
                      {(cn) => (
                        <Row
                          depth={depth + 2}
                          icon={<Icon name={conIconName(cn.kind)} />}
                          label={cn.name}
                          detail={cn.kind.replace("_", " ")}
                          title={cn.def}
                          selected={props.selectedKey === nodeKey({ kind: "constraint", schema, table: rel.name, name: cn.name })}
                          onSelect={() => props.onSelect({ kind: "constraint", schema, table: rel.name, name: cn.name })}
                          onContext={(e) => props.onContext(e, { kind: "constraint", schema, table: rel.name, name: cn.name })}
                        />
                      )}
                    </For>
                  </Show>
                </Show>
                <Show when={d().triggers.length}>
                  <Row depth={depth + 1} header icon={<Icon name="bolt" />} label="Triggers" detail={`${d().triggers.length}`} expandable open={isOpen(gk)} onToggle={() => toggle(gk)} />
                  <Show when={isOpen(gk)}>
                    <For each={d().triggers}>
                      {(tg) => (
                        <Row
                          depth={depth + 2}
                          icon={<Icon name="bolt" />}
                          label={tg.name}
                          title={tg.def}
                          selected={props.selectedKey === nodeKey({ kind: "trigger", schema, table: rel.name, name: tg.name })}
                          onSelect={() => props.onSelect({ kind: "trigger", schema, table: rel.name, name: tg.name, trigger: tg })}
                          onContext={(e) => props.onContext(e, { kind: "trigger", schema, table: rel.name, name: tg.name, trigger: tg })}
                        />
                      )}
                    </For>
                  </Show>
                </Show>
              </>
            )}
          </Show>
        </Show>
      </>
    );
  };

  const category = (schema: string, cat: string, icon: IconName, label: string, rels: RelStub[]) => {
    const k = `c:${schema}:${cat}`;
    return (
      <>
        <Row depth={2} header icon={<Icon name={icon} />} label={label} detail={`${rels.length}`} expandable open={isOpen(k)} onToggle={() => toggle(k)} />
        <Show when={isOpen(k)}>
          <For each={rels}>{(rel) => relation(schema, rel, 3)}</For>
        </Show>
      </>
    );
  };

  const schemaBlock = (s: SchemaT) => {
    const sk = `s:${s.name}`;
    const seqK = `c:${s.name}:seq`;
    const fnK = `c:${s.name}:fn`;
    return (
      <>
        <Row
          depth={1}
          icon={<Icon name="folder" />}
          label={s.name}
          expandable
          open={isOpen(sk)}
          selected={props.selectedKey === nodeKey({ kind: "schema", schema: s.name, name: s.name })}
          onToggle={() => toggle(sk)}
          onSelect={() => props.onSelect({ kind: "schema", schema: s.name, name: s.name })}
          onContext={(e) => props.onContext(e, { kind: "schema", schema: s.name, name: s.name })}
        />
        <Show when={isOpen(sk)}>
          <Show when={s.tables.length}>{category(s.name, "tables", "table", "Tables", s.tables)}</Show>
          <Show when={s.views.length}>{category(s.name, "views", "eye", "Views", s.views)}</Show>
          <Show when={s.sequences.length}>
            <Row depth={2} header icon={<Icon name="hash" />} label="Sequences" detail={`${s.sequences.length}`} expandable open={isOpen(seqK)} onToggle={() => toggle(seqK)} />
            <Show when={isOpen(seqK)}>
              <For each={s.sequences}>
                {(sq) => (
                  <Row
                    depth={3}
                    icon={<Icon name="hash" />}
                    label={sq}
                    selected={props.selectedKey === nodeKey({ kind: "sequence", schema: s.name, name: sq })}
                    onSelect={() => props.onSelect({ kind: "sequence", schema: s.name, name: sq })}
                    onContext={(e) => props.onContext(e, { kind: "sequence", schema: s.name, name: sq })}
                  />
                )}
              </For>
            </Show>
          </Show>
          <Show when={s.functions.length}>
            <Row depth={2} header icon={<Icon name="func" />} label="Functions" detail={`${s.functions.length}`} expandable open={isOpen(fnK)} onToggle={() => toggle(fnK)} />
            <Show when={isOpen(fnK)}>
              <For each={s.functions}>
                {(fn) => (
                  <Row
                    depth={3}
                    icon={<Icon name="func" />}
                    label={fn.name}
                    detail={fn.returns}
                    title={`${fn.name}(${fn.args}) → ${fn.returns}`}
                    selected={props.selectedKey === nodeKey({ kind: "function", schema: s.name, name: fn.name })}
                    onSelect={() => props.onSelect({ kind: "function", schema: s.name, name: fn.name })}
                    onContext={(e) => props.onContext(e, { kind: "function", schema: s.name, name: fn.name })}
                  />
                )}
              </For>
            </Show>
          </Show>
        </Show>
      </>
    );
  };

  return (
    <div class="tw">
      <For each={props.tree.databases}>
        {(dbn) => {
          const cur = dbn === props.tree.database;
          return (
            <>
              <Row
                depth={0}
                icon={<Icon name="database" />}
                label={dbn}
                muted={!cur}
                expandable={cur}
                open={isOpen("db")}
                selected={props.selectedKey === nodeKey({ kind: "database", name: dbn })}
                onToggle={() => toggle("db")}
                onSelect={() => props.onSelect({ kind: "database", name: dbn })}
                onContext={(e) => props.onContext(e, { kind: "database", name: dbn })}
              />
              <Show when={cur && isOpen("db")}>
                <For each={shownSchemas()}>{(s) => schemaBlock(s)}</For>
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}
