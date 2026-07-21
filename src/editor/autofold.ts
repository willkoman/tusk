import { StateField, RangeSetBuilder, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { docString, lexState } from "./lexer";

// Auto-fold large inline literals (the headline editor feature).
//
// While writing a query, a giant inline list — `IN (1,2,…,5000)`, an `ARRAY[…]`,
// a long string, or a big `$$ … $$` body — collapses to a compact placeholder so
// the query stays scannable. The cursor entering a folded range expands it; leaving
// re-folds it.
//
// Mechanism: a StateField of `Decoration.replace` widgets. Folding is purely a
// display concern — the document text is never modified, so `getRunText()`/export
// always see the full query. Detection runs on the shared lexer (src/editor/lexer.ts),
// so a `(`/`,` inside a string or comment is never miscounted.

export const FOLD_ITEM_THRESHOLD = 100; // items in a bracketed list before it folds
export const FOLD_CHARS_THRESHOLD = 200; // chars in a single literal before it folds

const OPEN_PAREN = 40,
  CLOSE_PAREN = 41,
  OPEN_BRACKET = 91,
  CLOSE_BRACKET = 93,
  COMMA = 44;

type Candidate = { from: number; to: number; label: string };

function fmtSize(chars: number): string {
  return chars >= 1024 ? `${(chars / 1024).toFixed(1)} KB` : `${chars.toLocaleString()} chars`;
}

/** Find foldable regions in the doc. Pure, runs only when the doc changes. */
function detect(state: EditorState): Candidate[] {
  const doc = docString(state);
  if (!doc) return [];
  const { spans } = lexState(state);
  const cands: Candidate[] = [];

  // (1) Big bracketed comma-lists: `( … )` / `[ … ]` with >= threshold items.
  // A stack tracks nesting; commas increment the innermost frame's item count.
  type Frame = { interiorFrom: number; close: number; commas: number };
  const stack: Frame[] = [];
  for (const span of spans) {
    if (span.kind !== "code") continue;
    for (let p = span.from; p < span.to; p++) {
      const cc = doc.charCodeAt(p);
      if (cc === OPEN_PAREN || cc === OPEN_BRACKET) {
        stack.push({ interiorFrom: p + 1, close: cc === OPEN_PAREN ? CLOSE_PAREN : CLOSE_BRACKET, commas: 0 });
      } else if (stack.length && (cc === CLOSE_PAREN || cc === CLOSE_BRACKET)) {
        const fr = stack[stack.length - 1];
        if (cc === fr.close) {
          stack.pop();
          const items = fr.commas + 1;
          if (items >= FOLD_ITEM_THRESHOLD && p > fr.interiorFrom) {
            cands.push({ from: fr.interiorFrom, to: p, label: ` …${items.toLocaleString()} items… ` });
          }
        }
      } else if (cc === COMMA && stack.length) {
        stack[stack.length - 1].commas++;
      }
    }
  }

  // (2) Long single literals: fold the interior, keep the delimiters visible.
  for (const s of spans) {
    if (s.kind !== "string" && s.kind !== "dquote" && s.kind !== "dollar") continue;
    if (s.to - s.from < FOLD_CHARS_THRESHOLD) continue;
    let dl = 1; // delimiter length (' or ")
    if (s.kind === "dollar") {
      const tagEnd = doc.indexOf("$", s.from + 1);
      dl = tagEnd > s.from ? tagEnd - s.from + 1 : 2;
    }
    const from = s.from + dl;
    const to = s.to - dl >= from ? s.to - dl : s.to; // unterminated literal: fold to EOF
    if (to > from + 8) cands.push({ from, to, label: ` …${fmtSize(to - from)}… ` });
  }

  // Normalize: sort and drop overlaps (outer/larger region wins) so the
  // RangeSetBuilder gets a sorted, non-overlapping set.
  cands.sort((a, b) => a.from - b.from || b.to - a.to);
  const out: Candidate[] = [];
  let lastTo = -1;
  for (const c of cands) {
    if (c.from >= lastTo) {
      out.push(c);
      lastTo = c.to;
    }
  }
  return out;
}

class FoldWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }
  eq(other: FoldWidget) {
    return other.label === this.label;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "cm-autofold";
    el.textContent = this.label;
    el.title = "Click to expand";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(el);
      view.dispatch({ selection: { anchor: pos } }); // cursor inside → re-evaluates as expanded
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

/** Fold every candidate the cursor/selection is not currently touching. */
function build(cands: Candidate[], state: EditorState): DecorationSet {
  const sel = state.selection;
  const builder = new RangeSetBuilder<Decoration>();
  for (const c of cands) {
    if (c.to <= c.from) continue;
    let touched = false;
    for (const r of sel.ranges) {
      if (r.from <= c.to + 1 && r.to >= c.from - 1) {
        touched = true;
        break;
      }
    }
    if (touched) continue;
    builder.add(c.from, c.to, Decoration.replace({ widget: new FoldWidget(c.label) }));
  }
  return builder.finish();
}

type FoldValue = { cands: Candidate[]; deco: DecorationSet };

const foldField = StateField.define<FoldValue>({
  create(state) {
    const cands = detect(state);
    return { cands, deco: build(cands, state) };
  },
  update(value, tr) {
    const selMoved = !tr.state.selection.eq(tr.startState.selection);
    if (!tr.docChanged && !selMoved) return value;
    // Candidate geometry only changes on edits; selection-only moves reuse it.
    const cands = tr.docChanged ? detect(tr.state) : value.cands;
    return { cands, deco: build(cands, tr.state) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

/** The auto-fold extension. Wrap in a Compartment to toggle it from prefs. */
export function autoFold(): Extension {
  return foldField;
}
