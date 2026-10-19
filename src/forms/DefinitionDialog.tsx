import { For, Show } from "solid-js";
import { Dialog } from "../Dialog";
import { highlightSql } from "../ai/sqlHighlight";

/** What the Explorer's "View definition" shows. `sql: null` = still loading. */
export type DefinitionView = {
  title: string;
  subtitle: string;
  sql: string | null;
  error: string | null;
};

/**
 * Read-only definition viewer for one Explorer object (constraint, index, trigger,
 * function/procedure, sequence, view, table). It runs nothing: Copy and Open in new
 * tab hand the text to the caller, and a new tab opened from it starts clean.
 */
export function DefinitionDialog(props: {
  view: DefinitionView;
  onCopy: (sql: string) => void;
  onOpenInTab: (sql: string) => void;
  onRetry?: () => void;
  onClose: () => void;
}) {
  const ready = () => (props.view.error ? null : props.view.sql);
  return (
    <Dialog
      title={props.view.title}
      subtitle={props.view.subtitle}
      size="lg"
      class="def-dialog"
      noAutoFocus
      onClose={props.onClose}
      footer={
        <div class="form-actions">
          <button class="ghost" disabled={!ready()} onClick={() => props.onCopy(ready()!)}>Copy</button>
          <button class="ghost" disabled={!ready()} onClick={() => props.onOpenInTab(ready()!)}>Open in new tab</button>
          <button class="run" onClick={props.onClose}>Close</button>
        </div>
      }
    >
      <Show
        when={!props.view.error}
        fallback={
          <div class="def-state">
            <div class="error">{props.view.error}</div>
            <Show when={props.onRetry}>
              <button class="ghost" onClick={() => props.onRetry!()}>Try again</button>
            </Show>
          </div>
        }
      >
        <Show when={props.view.sql !== null} fallback={<div class="def-state muted"><span class="spinner-sm" />Reading definition…</div>}>
          <pre class="ddl-code def-code"><code><For each={highlightSql(props.view.sql!)}>{(t) => (t.cls ? <span class={t.cls}>{t.text}</span> : t.text)}</For></code></pre>
        </Show>
      </Show>
    </Dialog>
  );
}
