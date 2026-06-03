import { createSignal, For, Show } from "solid-js";

export type Column = {
  name: string;
  data_type: string;
  nullable: boolean;
  is_pk: boolean;
  is_fk: boolean;
  default: string | null;
};
export type Idx = { name: string; unique: boolean; primary: boolean; def: string };
export type Con = { name: string; kind: string; def: string };
export type Relation = {
  name: string;
  kind: string;
  columns: Column[];
  indexes: Idx[];
  constraints: Con[];
};
export type Func = { name: string; args: string; returns: string };
export type SchemaT = {
  name: string;
  tables: Relation[];
  views: Relation[];
  sequences: string[];
  functions: Func[];
};
export type DbTree = { database: string; databases: string[]; schemas: SchemaT[] };

const conIcon = (k: string) =>
  k === "primary_key" ? "🔑" : k === "foreign_key" ? "🔗" : k === "unique" ? "🔒" : k === "check" ? "✓" : "•";

export function Tree(props: { tree: DbTree; onRunTable: (schema: string, name: string) => void }) {
  const [open, setOpen] = createSignal<Set<string>>(new Set(["db", "s:public", "c:public:tables"]));
  const isOpen = (k: string) => open().has(k);
  const toggle = (k: string) => {
    const s = new Set(open());
    s.has(k) ? s.delete(k) : s.add(k);
    setOpen(s);
  };

  function Row(p: {
    depth: number;
    icon: string;
    label: string;
    detail?: string;
    title?: string;
    muted?: boolean;
    expandable?: boolean;
    open?: boolean;
    onToggle?: () => void;
    onActivate?: () => void;
  }) {
    return (
      <div
        class="tw-row"
        classList={{ muted: p.muted }}
        title={p.title}
        style={{ "padding-left": `${p.depth * 13 + 6}px` }}
        onClick={() => (p.expandable ? p.onToggle?.() : p.onActivate?.())}
        onDblClick={() => p.onActivate?.()}
      >
        <span class="tw-caret">{p.expandable ? (p.open ? "▾" : "▸") : ""}</span>
        <span class="tw-icon">{p.icon}</span>
        <span class="tw-label">{p.label}</span>
        <Show when={p.detail}>
          <span class="tw-detail">{p.detail}</span>
        </Show>
      </div>
    );
  }

  const relation = (schema: string, rel: Relation, depth: number) => {
    const tk = `t:${schema}:${rel.name}`;
    const ck = `${tk}:cols`;
    const ik = `${tk}:idx`;
    const xk = `${tk}:con`;
    const isView = rel.kind === "view" || rel.kind === "matview";
    return (
      <>
        <Row
          depth={depth}
          icon={isView ? "👁️" : "🔲"}
          label={rel.name}
          detail={`${rel.columns.length}`}
          expandable
          open={isOpen(tk)}
          onToggle={() => toggle(tk)}
          onActivate={() => props.onRunTable(schema, rel.name)}
        />
        <Show when={isOpen(tk)}>
          <Row depth={depth + 1} icon="▦" label="Columns" detail={`${rel.columns.length}`} expandable open={isOpen(ck)} onToggle={() => toggle(ck)} />
          <Show when={isOpen(ck)}>
            <For each={rel.columns}>
              {(c) => (
                <Row
                  depth={depth + 2}
                  icon={c.is_pk ? "🔑" : c.is_fk ? "🔗" : "•"}
                  label={c.name}
                  detail={c.data_type + (c.nullable ? "" : " ·NN")}
                  title={c.default ? `default: ${c.default}` : undefined}
                />
              )}
            </For>
          </Show>
          <Show when={rel.indexes.length}>
            <Row depth={depth + 1} icon="📑" label="Indexes" detail={`${rel.indexes.length}`} expandable open={isOpen(ik)} onToggle={() => toggle(ik)} />
            <Show when={isOpen(ik)}>
              <For each={rel.indexes}>
                {(x) => (
                  <Row
                    depth={depth + 2}
                    icon={x.primary ? "🔑" : x.unique ? "🔒" : "📑"}
                    label={x.name}
                    detail={x.primary ? "pk" : x.unique ? "unique" : ""}
                    title={x.def}
                  />
                )}
              </For>
            </Show>
          </Show>
          <Show when={rel.constraints.length}>
            <Row depth={depth + 1} icon="🔗" label="Constraints" detail={`${rel.constraints.length}`} expandable open={isOpen(xk)} onToggle={() => toggle(xk)} />
            <Show when={isOpen(xk)}>
              <For each={rel.constraints}>
                {(cn) => <Row depth={depth + 2} icon={conIcon(cn.kind)} label={cn.name} detail={cn.kind.replace("_", " ")} title={cn.def} />}
              </For>
            </Show>
          </Show>
        </Show>
      </>
    );
  };

  const category = (schema: string, cat: string, icon: string, label: string, rels: Relation[]) => {
    const k = `c:${schema}:${cat}`;
    return (
      <>
        <Row depth={2} icon={icon} label={label} detail={`${rels.length}`} expandable open={isOpen(k)} onToggle={() => toggle(k)} />
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
        <Row depth={1} icon="📂" label={s.name} expandable open={isOpen(sk)} onToggle={() => toggle(sk)} />
        <Show when={isOpen(sk)}>
          <Show when={s.tables.length}>{category(s.name, "tables", "📋", "Tables", s.tables)}</Show>
          <Show when={s.views.length}>{category(s.name, "views", "👁️", "Views", s.views)}</Show>
          <Show when={s.sequences.length}>
            <Row depth={2} icon="🔢" label="Sequences" detail={`${s.sequences.length}`} expandable open={isOpen(seqK)} onToggle={() => toggle(seqK)} />
            <Show when={isOpen(seqK)}>
              <For each={s.sequences}>{(sq) => <Row depth={3} icon="#️⃣" label={sq} />}</For>
            </Show>
          </Show>
          <Show when={s.functions.length}>
            <Row depth={2} icon="ƒ" label="Functions" detail={`${s.functions.length}`} expandable open={isOpen(fnK)} onToggle={() => toggle(fnK)} />
            <Show when={isOpen(fnK)}>
              <For each={s.functions}>
                {(f) => <Row depth={3} icon="ƒ" label={f.name} detail={f.returns} title={`${f.name}(${f.args}) → ${f.returns}`} />}
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
              <Row depth={0} icon="🗄️" label={dbn} muted={!cur} expandable={cur} open={isOpen("db")} onToggle={() => toggle("db")} />
              <Show when={cur && isOpen("db")}>
                <For each={props.tree.schemas}>{(s) => schemaBlock(s)}</For>
              </Show>
            </>
          );
        }}
      </For>
    </div>
  );
}
