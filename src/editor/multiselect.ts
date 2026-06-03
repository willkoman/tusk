import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, rectangularSelection, crosshairCursor } from "@codemirror/view";

// Multiple selections + Alt-drag rectangular (column) selection. Occurrence
// highlighting lives in search.ts to avoid registering it twice.
export function multiSelect(): Extension {
  return [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    rectangularSelection(),
    crosshairCursor(),
  ];
}
