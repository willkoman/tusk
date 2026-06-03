import { Switch, Match } from "solid-js";
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
import { ConfirmDialog } from "./forms/ConfirmDialog";

type RefTable = { schema: string; name: string; columns: { name: string }[] };

/** All dialog variants. In-memory only (closures are fine). */
export type DialogState =
  | { kind: "addColumn"; ctx: NodeDescriptor }
  | { kind: "editColumn"; ctx: NodeDescriptor }
  | { kind: "modifyTable"; ctx: NodeDescriptor; detail: RelationDetail }
  | { kind: "createTable"; schema: string }
  | { kind: "createSchema" }
  | { kind: "createDatabase" }
  | { kind: "addIndex"; ctx: NodeDescriptor; columns: string[] }
  | { kind: "addConstraint"; ctx: NodeDescriptor; columns: string[]; tables: RefTable[] }
  | { kind: "rename"; title: string; current: string; build: (newName: string) => string }
  | { kind: "duplicate"; title: string; defaultName: string; build: (newName: string, withData: boolean) => string }
  | { kind: "comment"; title: string; current: string; build: (text: string | null) => string }
  | {
      kind: "confirm";
      title: string;
      primaryLabel: string;
      showCascade?: boolean;
      showRestartIdentity?: boolean;
      build: (o: { cascade: boolean; restartIdentity: boolean }) => string;
    };

export type DialogKind = DialogState["kind"];

type Handlers = {
  onClose: () => void;
  onRun: (sql: string) => Promise<{ ok: boolean; error?: string }>;
  onEditAsSql: (sql: string) => void;
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
          return <ModifyTableForm ctx={st.ctx} detail={st.detail} {...h} />;
        })()}
      </Match>
      <Match when={props.state?.kind === "createTable"}>
        <CreateTableForm schema={(s() as Extract<DialogState, { kind: "createTable" }>).schema} {...h} />
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
        <ConstraintForm
          ctx={(s() as Extract<DialogState, { kind: "addConstraint" }>).ctx}
          columns={(s() as Extract<DialogState, { kind: "addConstraint" }>).columns}
          tables={(s() as Extract<DialogState, { kind: "addConstraint" }>).tables}
          {...h}
        />
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
      <Match when={props.state?.kind === "confirm"}>
        {(() => {
          const st = s() as Extract<DialogState, { kind: "confirm" }>;
          return (
            <ConfirmDialog
              title={st.title}
              primaryLabel={st.primaryLabel}
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
