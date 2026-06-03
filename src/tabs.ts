// Editor tab model. Each tab carries its own SQL buffer, file binding, and a
// snapshot of its last result grid. Only the tab that last ran a cursorable query
// streams live (there is one server-side cursor per connection); other tabs show a
// frozen snapshot.

export type ResultSnapshot = {
  columns: string[];
  rows: (string | null)[][];
  done: boolean;
  status: string;
  runErr: string;
  elapsed: number;
  lastQuery: string;
  scrollTop: number;
};

export const EMPTY_RESULT: ResultSnapshot = {
  columns: [],
  rows: [],
  done: true,
  status: "",
  runErr: "",
  elapsed: 0,
  lastQuery: "",
  scrollTop: 0,
};

export type Tab = {
  id: string;
  title: string;
  sql: string;
  filePath: string | null;
  dirty: boolean;
  /** Active schema for this console (Postgres search_path); null = connection default. */
  searchSchema: string | null;
  result: ResultSnapshot;
};

let counter = 0;

/** Basename of a file path (handles both / and \ separators). */
export function basename(p: string): string {
  return p.split(/[\\/]/).pop() || p;
}

export function makeTab(init?: Partial<Tab>): Tab {
  counter += 1;
  return {
    id: `tab-${counter}`,
    title: init?.title ?? `Untitled ${counter}`,
    sql: init?.sql ?? "",
    filePath: init?.filePath ?? null,
    dirty: init?.dirty ?? false,
    searchSchema: init?.searchSchema ?? null,
    result: init?.result ?? { ...EMPTY_RESULT },
  };
}
