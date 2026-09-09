// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { ContextMenu, type MenuItem } from "./ContextMenu";

// The submenu is keyboard-first: a group opens with ArrowRight, closes with
// ArrowLeft/Escape, and a disabled leaf inside it keeps its own reason. Only a
// rendered menu can pin that — navigation reads the real DOM (`:scope >
// [role="menuitem"]`), so a wrapper element around a row would break it silently.

afterEach(cleanup);

const flush = () => new Promise<void>((r) => queueMicrotask(() => r()));

function open(items: MenuItem[], onClose = () => {}) {
  const view = render(() => <ContextMenu x={10} y={10} items={items} onClose={onClose} />);
  const rows = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>(':scope > [role="menuitem"]')];
  return {
    ...view,
    root: () => view.container.querySelector<HTMLElement>(".ctx-menu")!,
    sub: () => view.container.querySelector<HTMLElement>(".ctx-sub"),
    rootRows: () => rows(view.container.querySelector<HTMLElement>(".ctx-menu")!),
    subRows: () => {
      const s = view.container.querySelector<HTMLElement>(".ctx-sub");
      return s ? rows(s) : [];
    },
  };
}

describe("ContextMenu nesting", () => {
  it("opens a group with ArrowRight, navigates it, and closes it with ArrowLeft", async () => {
    const ran = vi.fn();
    const view = open([
      { label: "Select 100 rows", onClick: () => {} },
      {
        label: "Copy",
        items: [
          { label: "Copy name", onClick: ran },
          { label: "Copy qualified name", onClick: () => {} },
        ],
      },
    ]);
    await flush();
    expect(view.sub()).toBeNull();

    const group = view.rootRows()[1];
    group.focus();
    fireEvent.keyDown(view.root(), { key: "ArrowRight" });
    await flush();
    expect(view.sub()).not.toBeNull();
    expect(group.getAttribute("aria-expanded")).toBe("true");
    // Focus moved into the submenu, and Arrow keys stay inside it.
    expect(document.activeElement).toBe(view.subRows()[0]);
    fireEvent.keyDown(view.root(), { key: "ArrowDown" });
    expect(document.activeElement).toBe(view.subRows()[1]);

    fireEvent.keyDown(view.root(), { key: "ArrowLeft" });
    await flush();
    expect(view.sub()).toBeNull();
    expect(document.activeElement).toBe(group);
    expect(ran).not.toHaveBeenCalled();
  });

  it("opens a group with Enter too, and lands on its first entry", async () => {
    const view = open([{ label: "Generate", items: [{ label: "SELECT", onClick: () => {} }] }]);
    await flush();
    view.rootRows()[0].focus();
    fireEvent.keyDown(view.root(), { key: "Enter" });
    await flush();
    expect(view.sub()).not.toBeNull();
    expect(document.activeElement).toBe(view.subRows()[0]);
  });

  it("runs a submenu item and closes the whole menu", async () => {
    const ran = vi.fn();
    const onClose = vi.fn();
    const view = open([{ label: "Copy", items: [{ label: "Copy name", onClick: ran }] }], onClose);
    await flush();
    fireEvent.click(view.rootRows()[0]);
    await flush();
    fireEvent.click(view.subRows()[0]);
    expect(ran).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps the disabled reason on the leaf and refuses to run it", async () => {
    const ran = vi.fn();
    const view = open([
      { label: "Data", items: [{ label: "Import data into table…", disabled: true, title: "Requires INSERT on orders", onClick: ran }] },
    ]);
    await flush();
    fireEvent.mouseEnter(view.rootRows()[0]);
    await flush();
    const leaf = view.sub()!.querySelector<HTMLElement>('[role="menuitem"]')!;
    expect(leaf.getAttribute("title")).toBe("Requires INSERT on orders");
    expect(leaf.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(leaf);
    expect(ran).not.toHaveBeenCalled();
  });

  it("closes an open group when the pointer moves to a plain row, and Escape closes the group first", async () => {
    const onClose = vi.fn();
    const view = open([
      { label: "Copy", items: [{ label: "Copy name", onClick: () => {} }] },
      { label: "Drop…", danger: true, onClick: () => {} },
    ], onClose);
    await flush();
    fireEvent.mouseEnter(view.rootRows()[0]);
    await flush();
    expect(view.sub()).not.toBeNull();
    fireEvent.mouseEnter(view.rootRows()[1]);
    await flush();
    expect(view.sub()).toBeNull();

    fireEvent.mouseEnter(view.rootRows()[0]);
    await flush();
    fireEvent.keyDown(view.root(), { key: "Escape" });
    await flush();
    expect(view.sub()).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(view.root(), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
