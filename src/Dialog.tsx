import { type JSX, Show } from "solid-js";
import { Icon } from "./Icons";

/** Generic modal shell — reuses the `.modal` / `.modal-overlay` CSS. */
export function Dialog(props: {
  title: string;
  onClose: () => void;
  width?: number;
  /** When false, the ✕ and overlay-click dismissal are disabled (e.g. while busy). */
  dismissable?: boolean;
  children: JSX.Element;
}) {
  const canClose = () => props.dismissable !== false;
  return (
    <div class="modal-overlay" onClick={() => canClose() && props.onClose()}>
      <div
        class="modal"
        style={props.width ? { width: `${props.width}px` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          {props.title}
          <span class="spacer" />
          <button class="icon modal-x" disabled={!canClose()} onClick={props.onClose}><Icon name="close" /></button>
        </div>
        {props.children}
      </div>
    </div>
  );
}

/** Live, read-only SQL preview shown in dialog footers. */
export function SqlPreview(props: { sql: string }) {
  return <pre class="sql-preview">{props.sql || "-- nothing to run"}</pre>;
}

/** Shared dialog footer: SQL preview + error line + Cancel / Edit-as-SQL / primary. */
export function DialogFooter(props: {
  sql: string;
  error?: string;
  busy?: boolean;
  disabled?: boolean;
  primaryLabel: string;
  primaryDanger?: boolean;
  onPrimary: () => void;
  onEditAsSql?: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <SqlPreview sql={props.sql} />
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      <div class="form-actions">
        <button class="ghost" onClick={props.onCancel}>Cancel</button>
        <Show when={props.onEditAsSql}>
          <button class="ghost" disabled={props.disabled} onClick={() => props.onEditAsSql!()}>
            Edit as SQL
          </button>
        </Show>
        <button
          classList={{ run: !props.primaryDanger, "btn-danger": props.primaryDanger }}
          disabled={props.disabled || props.busy}
          onClick={props.onPrimary}
        >
          {props.busy ? "Running…" : props.primaryLabel}
        </button>
      </div>
    </>
  );
}
