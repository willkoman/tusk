import { For, Show, createMemo, createSignal } from "solid-js";
import { Dialog, SqlPreview } from "../Dialog";
import { substituteParams, type Param, type ParamValue } from "../sql/params";

// Pre-run parameter prompt: one row per detected `$n` / `%s` / `:name` with a value
// input, NULL toggle, and raw (unquoted) toggle; live preview of the
// substituted SQL. Values are remembered per tab by the caller.

export function ParamDialog(props: {
  sql: string;
  params: Param[];
  initial: Record<string, ParamValue> | undefined;
  onRun: (values: Record<string, ParamValue>, substituted: string) => void;
  onClose: () => void;
}) {
  const blank = (): ParamValue => ({ value: "", raw: false, isNull: false });
  const [values, setValues] = createSignal<Record<string, ParamValue>>(
    Object.fromEntries(props.params.map((p) => [p.name, props.initial?.[p.name] ?? blank()])),
  );
  const patch = (name: string, v: Partial<ParamValue>) =>
    setValues((m) => ({ ...m, [name]: { ...m[name], ...v } }));

  const preview = createMemo(() => substituteParams(props.sql, values()));
  const previewText = createMemo(() => {
    const text = preview();
    const limit = 20_000;
    return text.length <= limit ? text : `${text.slice(0, limit)}\n-- preview truncated; full SQL will run`;
  });

  return (
    <Dialog title="Query parameters" width={560} onClose={props.onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          props.onRun(values(), preview());
        }}
      >
        <div class="param-rows">
          <For each={props.params}>
            {(p, i) => (
              <div class="param-row">
                <span class="param-name">{p.name}</span>
                <input
                  value={values()[p.name].value}
                  disabled={values()[p.name].isNull}
                  ref={(el) => { if (i() === 0) setTimeout(() => { el.focus(); el.select(); }); }}
                  onInput={(e) => patch(p.name, { value: e.currentTarget.value })}
                  placeholder={values()[p.name].isNull ? "NULL" : "value"}
                />
                <label class="checkbox param-flag" title="Send SQL NULL">
                  <input type="checkbox" checked={values()[p.name].isNull} onChange={(e) => patch(p.name, { isNull: e.currentTarget.checked })} />
                  NULL
                </label>
                <label class="checkbox param-flag" title="Insert the value verbatim (numbers, expressions) instead of as a quoted string">
                  <input type="checkbox" checked={values()[p.name].raw} disabled={values()[p.name].isNull} onChange={(e) => patch(p.name, { raw: e.currentTarget.checked })} />
                  raw
                </label>
              </div>
            )}
          </For>
        </div>
        <Show when={props.params.some((p) => p.name.startsWith("%s #"))}>
          <div class="import-info">
            `%s` values are quoted by default. For PostgreSQL <code>ANY(%s)</code>, enter an array literal such as <code>{`{1,2}`}</code>, or enable raw and enter <code>ARRAY[1,2]</code>.
          </div>
        </Show>
        <SqlPreview sql={previewText()} />
        <div class="form-actions">
          <button type="button" class="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="run">Run ▶</button>
        </div>
      </form>
    </Dialog>
  );
}
