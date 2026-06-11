import { For, createMemo, createSignal } from "solid-js";
import { Dialog, SqlPreview } from "../Dialog";
import { substituteParams, type Param, type ParamValue } from "../sql/params";

// Pre-run parameter prompt: one row per detected `$n` / `:name` with a value
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
        <SqlPreview sql={preview()} />
        <div class="form-actions">
          <button type="button" class="ghost" onClick={props.onClose}>Cancel</button>
          <button type="submit" class="run">Run ▶</button>
        </div>
      </form>
    </Dialog>
  );
}
