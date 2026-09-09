import { type JSX, Show, createSignal, onCleanup, onMount } from "solid-js";
import { Icon } from "./Icons";
import { dialogWidth, type DialogSize } from "./dialogWidths";
import { viewportW } from "./viewport";

export type { DialogSize };

/** Elements a dialog may open on. Buttons are excluded on purpose: a dialog must
 *  never open with a destructive primary under the Enter key. */
const FIELD_SELECTOR = 'input:not([type="hidden"]):not(:disabled), select:not(:disabled), textarea:not(:disabled)';

/** Generic modal shell — reuses the `.modal` / `.modal-overlay` CSS. */
export function Dialog(props: {
  title: string;
  /** Rendered beside the title — the production badge, on every confirmation. */
  titleBadge?: JSX.Element;
  /** One short line under the title: what this dialog acts on. */
  subtitle?: string;
  onClose: () => void;
  /** Width tier. Ad-hoc pixel widths are not accepted; add a tier instead. */
  size?: DialogSize;
  /** Extra class on the modal box (e.g. "modal-tall" for full-height viewers). */
  class?: string;
  /** When false, the ✕ and overlay-click dismissal are disabled (e.g. while busy). */
  dismissable?: boolean;
  /** Pinned below the scrolling body: SQL preview + actions. */
  footer?: JSX.Element;
  /** Enter in a single-line field runs this (the dialog's primary action). */
  onEnter?: () => void;
  /** Skip opening focus on the first field (viewers with nothing to type into). */
  noAutoFocus?: boolean;
  children: JSX.Element;
}) {
  let modal: HTMLDivElement | undefined;
  let priorFocus: HTMLElement | null = null;
  const canClose = () => props.dismissable !== false;
  // Width follows the LIVE viewport (src/viewport.ts), not a size read once when the
  // dialog opened: a window that settles or resizes under an open dialog re-sizes it.
  const width = () => dialogWidth(props.size ?? "sm", viewportW());
  const visible = (el: HTMLElement) => !el.hasAttribute("hidden") && el.getClientRects().length > 0;
  const focusable = () => modal
    ? [...modal.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')]
      .filter(visible)
    : [];
  onMount(() => {
    priorFocus = document.activeElement as HTMLElement | null;
    queueMicrotask(() => {
      if (!modal?.isConnected || modal.contains(document.activeElement)) return;
      // Open on the first field so a form is typeable without reaching for the mouse.
      const field = props.noAutoFocus
        ? undefined
        : [...modal.querySelectorAll<HTMLElement>(FIELD_SELECTOR)].filter(visible)[0];
      (field ?? modal).focus();
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
        if (e.key === "Enter" && props.onEnter && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Textareas, buttons and the CodeMirror fields own their own Enter.
          const t = e.target as HTMLElement | null;
          const tag = t?.tagName;
          if (tag === "INPUT" && (t as HTMLInputElement).type !== "checkbox" && (t as HTMLInputElement).type !== "radio") {
            e.preventDefault();
            e.stopPropagation();
            props.onEnter();
          }
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
        style={{ width: `${width()}px` }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="modal-head">
          <div class="modal-titles">
            <div class="modal-title">{props.title}{props.titleBadge}</div>
            <Show when={props.subtitle}>
              <div class="modal-sub">{props.subtitle}</div>
            </Show>
          </div>
          <span class="spacer" />
          <button class="icon modal-x" title="Close" aria-label="Close" disabled={!canClose()} onClick={props.onClose}><Icon name="close" /></button>
        </div>
        <div class="modal-body">{props.children}</div>
        <Show when={props.footer}>
          <div class="modal-foot">{props.footer}</div>
        </Show>
      </div>
    </div>
  );
}

/** Live, read-only SQL preview shown in dialog footers. */
export function SqlPreview(props: { sql: string }) {
  const [copied, setCopied] = createSignal(false);
  let timer: number | undefined;
  onCleanup(() => window.clearTimeout(timer));
  const copy = () => {
    void navigator.clipboard?.writeText(props.sql)?.then(
      () => {
        setCopied(true);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };
  return (
    <div class="sql-preview-wrap">
      <div class="sql-preview-head">
        <span>SQL</span>
        <span class="spacer" />
        <button class="ghost sql-copy" disabled={!props.sql} onClick={copy}>{copied() ? "Copied" : "Copy"}</button>
      </div>
      <pre class="sql-preview" classList={{ "is-empty": !props.sql }}>{props.sql || "Nothing to run yet."}</pre>
    </div>
  );
}

/** Shared dialog footer: SQL preview + error line + Cancel / Edit-as-SQL / primary. */
export function DialogFooter(props: {
  sql: string;
  error?: string;
  busy?: boolean;
  disabled?: boolean;
  primaryLabel: string;
  primaryDanger?: boolean;
  /** One line above the actions, e.g. "Drops 1 index, 2 constraints". */
  summary?: string;
  onPrimary: () => void;
  onEditAsSql?: () => void;
  /** Override the secondary button's label (defaults to "Edit as SQL"). */
  editAsSqlLabel?: string;
  /** Drop the secondary entirely (destructive confirms keep Cancel + primary only). */
  hideEditAsSql?: boolean;
  /** Extra ghost buttons in the right-hand group, before Cancel (e.g. Clear / Copy). */
  extra?: JSX.Element;
  /** A DESTRUCTIVE secondary. The only thing that sits apart, on the far left. */
  destructive?: JSX.Element;
  onCancel: () => void;
}) {
  return (
    <>
      <SqlPreview sql={props.sql} />
      <Show when={props.summary}>
        <div class="drop-summary">{props.summary}</div>
      </Show>
      <Show when={props.error}>
        <div class="error">{props.error}</div>
      </Show>
      {/* One group, right-aligned, Cancel always the button next to the primary.
          A destructive secondary — and nothing else — is pulled left. */}
      <div class="form-actions">
        <Show when={props.destructive}>
          <div class="form-actions-left">{props.destructive}</div>
        </Show>
        {props.extra}
        <Show when={props.onEditAsSql && !props.hideEditAsSql}>
          <button class="ghost" disabled={props.disabled} onClick={() => props.onEditAsSql!()}>
            {props.editAsSqlLabel ?? "Edit as SQL"}
          </button>
        </Show>
        <button class="ghost" onClick={props.onCancel}>Cancel</button>
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
