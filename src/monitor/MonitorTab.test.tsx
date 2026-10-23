// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import MonitorTab from "./MonitorTab";
import { MonitorSession } from "./session";

// A render per engine: the tab must mount (a crash here once shipped past the type
// checker — a memo read a binding declared below it), show only the views and charts
// that engine has, and keep series it has no counter for out of the legends.

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => { throw new Error("no window"); } }));

beforeAll(() => {
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  Object.assign(globalThis, { ResizeObserver: Observer, IntersectionObserver: Observer });
  window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as never;
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
});

afterEach(cleanup);

function mount(engine: string) {
  const session = new MonitorSession(`conn-${engine}`, { paused: true });
  const view = render(() => (
    <MonitorTab
      session={session}
      connectionLabel="test"
      engine={engine}
      production={undefined}
      onRowMenu={() => {}}
      onQueryMenu={() => {}}
      onOpenSettings={() => {}}
      onChartExport={() => {}}
    />
  ));
  const text = (sel: string) => [...view.container.querySelectorAll<HTMLElement>(sel)].map((e) => e.textContent?.trim() ?? "");
  return { session, view, text };
}

describe("MonitorTab per engine", () => {
  it("PostgreSQL: every view and chart", () => {
    const { text } = mount("postgres");
    expect(text(".mv-views button")).toEqual(["Overview", "Activity", "Locks", "Statements", "Replication", "Tables", "I/O"]);
    const charts = text(".monitor-card h3");
    expect(charts).toContain("Tuples per second");
    expect(charts).toContain("Checkpoints and background writes");
    expect(text(".mc-key-label")).toContain("Fetched");
    expect(text(".mc-key-label")).toContain("LWLock");
    // No system_stats: no Host chart or tiles.
    expect(charts).not.toContain("Host");
    expect(text(".mt-label")).not.toContain("Host CPU");
  });

  it("MySQL: Overview, Activity and Locks, its own names, no series it cannot count", () => {
    const { text } = mount("mysql");
    expect(text(".mv-views button")).toEqual(["Overview", "Activity", "Locks"]);
    const charts = text(".monitor-card h3");
    expect(charts).toEqual(expect.arrayContaining(["Rows per second", "Buffer pool I/O", "Redo log", "Buffer pool flushing"]));
    const keys = text(".mc-key-label");
    expect(keys).toContain("Running");
    expect(keys).toContain("Pages flushed");
    expect(keys).not.toContain("Fetched");
    expect(keys).not.toContain("LWLock");
    expect(keys).not.toContain("Temp files");
    expect(keys).not.toContain("Idle in transaction (aborted)");
    expect(text(".mt-label")).toContain("Redo log");
  });

  it("SQL Server: no rows chart, no rollback series", () => {
    const { text } = mount("mssql");
    expect(text(".mv-views button")).toEqual(["Overview", "Activity", "Locks"]);
    const charts = text(".monitor-card h3");
    expect(charts).not.toContain("Tuples per second");
    expect(charts).not.toContain("Rows per second");
    expect(charts).toEqual(expect.arrayContaining(["Transaction log", "Checkpoints and lazy writes"]));
    const keys = text(".mc-key-label");
    expect(keys).toContain("Parallelism");
    expect(keys).not.toContain("Rollbacks");
    expect(text(".mt-label")).toContain("Log flush");
  });

  it("a view the engine lacks falls back to Overview", () => {
    const session = new MonitorSession("conn-x", { paused: true, view: "statements" });
    render(() => (
      <MonitorTab session={session} connectionLabel="x" engine="mysql" production={undefined}
        onRowMenu={() => {}} onQueryMenu={() => {}} onOpenSettings={() => {}} onChartExport={() => {}} />
    ));
    expect(session.view()).toBe("overview");
  });

  it("an embedded engine gets the explanation, not a monitor", () => {
    const { view } = mount("duckdb");
    expect(view.container.textContent).toContain("An embedded database has no server to watch.");
    expect(view.container.querySelector(".monitor-head")).toBeNull();
  });
});
