import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from "@codemirror/search";
import { type Extension } from "@codemirror/state";

// Find & replace panel (regex, replace-all) plus occurrence highlighting.
export { searchKeymap, openSearchPanel };

export function searchExtensions(): Extension {
  return [highlightSelectionMatches(), search({ top: true })];
}
