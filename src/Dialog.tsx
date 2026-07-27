import { type JSX, Show, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";

/** Generic modal shell — reuses the `.modal` / `.modal-overlay` CSS. */
export function Dialog(props: {
  title: string;
  onClose: () => void;
  width?: number;
  /** Extra class on the modal box (e.g. "modal-tall" for full-height viewers). */
  class?: string;
  /** When false, the ✕ and overlay-click dismissal are disabled (e.g. while busy). */
  dismissable?: boolean;
  children: JSX.Element;
}) {
  let modal: HTMLDivElement | undefined;
  let priorFocus: HTMLElement | null = null;
  const canClose = () => props.dismissable !== false;
  const focusable = () => modal
    ? [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      .filter((el) => !el.hasAttribute("hidden") && el.getClientRects().length > 0)
    : [];
  onMount(() => {
    priorFocus = document.activeElement as HTMLElement | null;
    queueMicrotask(() => {
      if (modal?.isConnected && !modal.contains(document.activeElement)) modal.focus();
    });
  });
  onCleanup(() => {
    if (priorFocus?.isConnected) priorFocus.focus();
  });
  return (
    <div
      class="modal-overlay"
      data-blocking-dialog="true"
      onClick={() => canClose() && props.onClose()}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          if (canClose()) props.onClose();
          return;
        }
        if (e.key !== "Tab") return;
        const items = focusable();
        if (!items.length) {
          e.preventDefault();
          modal?.focus();
          return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === modal || !modal?.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <div
        ref={modal}
        class="modal"
        role="dialog"
        aria-modal="true"
        aria-label={props.title}
        tabindex={-1}
        classList={{ [props.class ?? ""]: !!props.class }}
        style={props.width ? { width: `${props.width}px` } : undefined}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          {props.title}
          <span class="spacer" />
          <button class="icon modal-x" title="Close" aria-label="Close" disabled={!canClose()} onClick={props.onClose}><Icon name="close" /></button>
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
