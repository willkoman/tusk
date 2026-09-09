import { type JSX, Switch, Match } from "solid-js";
import type { NodeDescriptor, RelationDetail } from "./Tree";
import { ColumnForm } from "./forms/ColumnForm";
import { EditColumnForm } from "./forms/EditColumnForm";
import { CreateTableForm } from "./forms/CreateTableForm";
import { ModifyTableForm } from "./forms/ModifyTableForm";
import { IndexForm } from "./forms/IndexForm";
import { ConstraintForm } from "./forms/ConstraintForm";
import { SchemaForm } from "./forms/SchemaForm";
import { DatabaseForm } from "./forms/DatabaseForm";
import { RenameDialog } from "./forms/RenameDialog";
import { DuplicateDialog } from "./forms/DuplicateDialog";
import { CommentDialog } from "./forms/CommentDialog";
import { ConfirmDialog, type DangerFacts } from "./forms/ConfirmDialog";
import { FilterBuilder } from "./forms/FilterBuilder";
import type { FilterTree } from "./grid/filterModel";
import type { RefColumn, RefTable } from "./forms/FkEditor";

export type { RefColumn, RefTable };

/** All dialog variants. In-memory only (closures are fine). */
export type DialogState =
  | { kind: "addColumn"; ctx: NodeDescriptor }
  | { kind: "editColumn"; ctx: NodeDescriptor }
  | { kind: "modifyTable"; ctx: NodeDescriptor; detail: RelationDetail; schemas?: string[]; tables?: RefTable[] }
  | { kind: "createTable"; schema: string; tables?: RefTable[] }
  | { kind: "createSchema" }
  | { kind: "createDatabase" }
  | { kind: "addIndex"; ctx: NodeDescriptor; columns: string[] }
  | { kind: "addConstraint"; ctx: NodeDescriptor; columns: string[]; columnTypes?: Record<string, string>; tables: RefTable[] }
  | { kind: "rename"; title: string; current: string; build: (newName: string) => string }
  | { kind: "duplicate"; title: string; defaultName: string; build: (newName: string, withData: boolean) => string }
  | { kind: "comment"; title: string; current: string; build: (text: string | null) => string }
  | {
      /** Visual result-grid filter builder. Runs nothing itself — it hands the
       *  tree back to App, which re-streams the wrapped query. */
      kind: "filter";
      columns: string[];
      types?: Record<string, string>;
      dialect: string;
      initial: FilterTree;
      prefill?: string;
      onApply: (tree: FilterTree) => void;
      onOpenQuery: (tree: FilterTree) => void;
      onCopyWhere: (where: string) => void;
    }
  | {
      kind: "confirm";
      title: string;
      /** Qualified name, shown under the title in mono. */
      subtitle?: string;
      primaryLabel: string;
      lead?: string;
      lines?: string[];
      /** What the confirmation states before it destroys anything. */
      facts?: DangerFacts;
      /** Require this exact name to be typed before the primary unlocks. */
      confirmName?: string;
      showCascade?: boolean;
      showRestartIdentity?: boolean;
      build: (o: { cascade: boolean; restartIdentity: boolean }) => string;
    };

export type DialogKind = DialogState["kind"];

type Handlers = {
  /** Production badge, rendered in every confirmation's title. */
  titleBadge?: JSX.Element;
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
  /** Lazy per-table column detail for the foreign-key picker (PK/unique marked).
   *  One handler for every dialog that embeds `FkEditor`. */
  onLoadColumns?: (schema: string, table: string) => Promise<RefColumn[] | null>;
};

/** Single dispatcher — renders the form matching `state`. Each form owns its
 *  local state, so App.tsx only tracks one `activeDialog` signal. */
export function WorkbenchDialogs(props: { state: DialogState | null } & Handlers) {
  // Narrow helper: the parent only renders when state is non-null per kind.
  const s = () => props.state!;
  const h = { onClose: props.onClose, onRun: props.onRun, onEditAsSql: props.onEditAsSql };

  return (
    <Switch>
      <Match when={props.state?.kind === "addColumn"}>
        <ColumnForm ctx={(s() as Extract<DialogState, { kind: "addColumn" }>).ctx} {...h} />
      </Match>
      <Match when={props.state?.kind === "editColumn"}>
        <EditColumnForm ctx={(s() as Extract<DialogState, { kind: "editColumn" }>).ctx} {...h} />
      </Match>
      <Match when={props.state?.kind === "modifyTable"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "modifyTable" }>;
          return (
            <ModifyTableForm
              ctx={st.ctx}
              detail={st.detail}
              schemas={st.schemas}
              tables={st.tables}
              loadColumns={props.onLoadColumns}
              {...h}
            />
          );
        })()}
      </Match>
      <Match when={props.state?.kind === "createTable"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "createTable" }>;
          return <CreateTableForm schema={st.schema} tables={st.tables} loadColumns={props.onLoadColumns} {...h} />;
        })()}
      </Match>
      <Match when={props.state?.kind === "createSchema"}>
        <SchemaForm {...h} />
      </Match>
      <Match when={props.state?.kind === "createDatabase"}>
        <DatabaseForm {...h} />
      </Match>
      <Match when={props.state?.kind === "addIndex"}>
        <IndexForm
          ctx={(s() as Extract<DialogState, { kind: "addIndex" }>).ctx}
          columns={(s() as Extract<DialogState, { kind: "addIndex" }>).columns}
          {...h}
        />
      </Match>
      <Match when={props.state?.kind === "addConstraint"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "addConstraint" }>;
          return (
            <ConstraintForm
              ctx={st.ctx}
              columns={st.columns}
              columnTypes={st.columnTypes}
              tables={st.tables}
              loadColumns={props.onLoadColumns}
              {...h}
            />
          );
        })()}
      </Match>
      <Match when={props.state?.kind === "rename"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "rename" }>;
          return <RenameDialog title={st.title} current={st.current} build={st.build} {...h} />;
        })()}
      </Match>
      <Match when={props.state?.kind === "duplicate"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "duplicate" }>;
          return <DuplicateDialog title={st.title} defaultName={st.defaultName} build={st.build} {...h} />;
        })()}
      </Match>
      <Match when={props.state?.kind === "comment"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "comment" }>;
          return <CommentDialog title={st.title} current={st.current} build={st.build} {...h} />;
        })()}
      </Match>
      <Match when={props.state?.kind === "filter"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "filter" }>;
          return (
            <FilterBuilder
              columns={st.columns}
              types={st.types}
              dialect={st.dialect}
              initial={st.initial}
              prefill={st.prefill}
              onApply={st.onApply}
              onOpenQuery={st.onOpenQuery}
              onCopyWhere={st.onCopyWhere}
              onClose={props.onClose}
            />
          );
        })()}
      </Match>
      <Match when={props.state?.kind === "confirm"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "confirm" }>;
          return (
            <ConfirmDialog
              title={st.title}
              titleBadge={props.titleBadge}
              subtitle={st.subtitle}
              primaryLabel={st.primaryLabel}
              lead={st.lead}
              lines={st.lines}
              facts={st.facts}
              confirmName={st.confirmName}
              showCascade={st.showCascade}
              showRestartIdentity={st.showRestartIdentity}
              build={st.build}
              {...h}
            />
          );
        })()}
      </Match>
    </Switch>
  );
}
