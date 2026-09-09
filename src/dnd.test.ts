import { describe, expect, it } from "vitest";
import {
  AUTOSCROLL_STEP,
  DRAG_THRESHOLD,
  advanceDrag,
  autoScrollStep,
  beginDrag,
  cancelDrag,
  commitDrag,
  dropDrag,
  insertionSlot,
  insideDropZone,
  isNoopMove,
  passedThreshold,
  reorder,
  slotOffset,
} from "./dnd";

// Four items 100 px wide starting at 0 — edges are the boundaries between them.
const EDGES = [0, 100, 200, 300, 400];

describe("press-and-move threshold", () => {
  it("keeps a click a click below the threshold", () => {
    expect(passedThreshold(0, 0)).toBe(false);
    expect(passedThreshold(DRAG_THRESHOLD - 1, 0)).toBe(false);
    expect(passedThreshold(0, DRAG_THRESHOLD - 1)).toBe(false);
  });

  it("starts on either axis, in either direction", () => {
    expect(passedThreshold(DRAG_THRESHOLD, 0)).toBe(true);
    expect(passedThreshold(-DRAG_THRESHOLD, 0)).toBe(true);
    expect(passedThreshold(0, -DRAG_THRESHOLD)).toBe(true);
  });
});

describe("insertionSlot", () => {
  it("returns the gap nearest the pointer", () => {
    expect(insertionSlot(EDGES, 0)).toBe(0);
    expect(insertionSlot(EDGES, 49)).toBe(0);
    expect(insertionSlot(EDGES, 50)).toBe(1); // past item 0's midpoint
    expect(insertionSlot(EDGES, 149)).toBe(1);
    expect(insertionSlot(EDGES, 150)).toBe(2);
    expect(insertionSlot(EDGES, 351)).toBe(4); // past the last midpoint = after all
  });

  it("clamps beyond either end", () => {
    expect(insertionSlot(EDGES, -1000)).toBe(0);
    expect(insertionSlot(EDGES, 99999)).toBe(4);
  });

  it("handles uneven widths and an empty list", () => {
    expect(insertionSlot([0, 20, 400], 25)).toBe(1);
    expect(insertionSlot([0, 20, 400], 220)).toBe(2);
    expect(insertionSlot([], 10)).toBe(0);
    expect(insertionSlot([0], 10)).toBe(0);
  });

  it("follows the pointer through the scroll offset while auto-scrolling", () => {
    // Content coordinates = clientX - container.left + container.scrollLeft. The
    // pointer parks at the right edge and the container scrolls under it.
    const contentX = (clientX: number, left: number, scrollLeft: number) => clientX - left + scrollLeft;
    const parked = 250; // client x, container.left = 50 -> 200 content px unscrolled
    expect(insertionSlot(EDGES, contentX(parked, 50, 0))).toBe(2);
    expect(insertionSlot(EDGES, contentX(parked, 50, 60))).toBe(3);
    expect(insertionSlot(EDGES, contentX(parked, 50, 160))).toBe(4);
  });
});

describe("slotOffset", () => {
  it("is the boundary the indicator bar sits on", () => {
    expect(slotOffset(EDGES, 0)).toBe(0);
    expect(slotOffset(EDGES, 2)).toBe(200);
    expect(slotOffset(EDGES, 4)).toBe(400);
  });

  it("clamps out-of-range slots and survives an empty list", () => {
    expect(slotOffset(EDGES, -3)).toBe(0);
    expect(slotOffset(EDGES, 99)).toBe(400);
    expect(slotOffset([], 1)).toBe(0);
  });
});

describe("autoScrollStep", () => {
  it("is zero in the middle of the scroller", () => {
    expect(autoScrollStep(500, 100, 900)).toBe(0);
  });

  it("pulls left near the leading edge and right near the trailing one", () => {
    expect(autoScrollStep(110, 100, 900)).toBe(-AUTOSCROLL_STEP);
    expect(autoScrollStep(890, 100, 900)).toBe(AUTOSCROLL_STEP);
  });

  it("shrinks the edge band so a narrow scroller keeps a neutral middle", () => {
    // 30 px wide: a fixed 36 px band would make every position an edge.
    expect(autoScrollStep(115, 100, 130)).toBe(0);
    expect(autoScrollStep(102, 100, 130)).toBe(-AUTOSCROLL_STEP);
    expect(autoScrollStep(128, 100, 130)).toBe(AUTOSCROLL_STEP);
  });

  it("never scrolls a zero-width scroller", () => {
    expect(autoScrollStep(100, 100, 100)).toBe(0);
  });
});

describe("insideDropZone", () => {
  const zone = { left: 0, right: 200, top: 0, bottom: 30 };

  it("accepts a release just outside, within the margin", () => {
    expect(insideDropZone(100, 15, zone)).toBe(true);
    expect(insideDropZone(100, 50, zone)).toBe(true);
    expect(insideDropZone(-20, 15, zone)).toBe(true);
  });

  it("rejects a release well clear of the zone", () => {
    expect(insideDropZone(100, 300, zone)).toBe(false);
    expect(insideDropZone(600, 15, zone)).toBe(false);
  });
});

describe("reorder", () => {
  const list = ["a", "b", "c", "d"];

  it("moves an item forward, accounting for its own removal", () => {
    expect(reorder(list, 0, 2)).toEqual(["b", "a", "c", "d"]);
    expect(reorder(list, 0, 4)).toEqual(["b", "c", "d", "a"]);
  });

  it("moves an item backward", () => {
    expect(reorder(list, 3, 0)).toEqual(["d", "a", "b", "c"]);
    expect(reorder(list, 2, 1)).toEqual(["a", "c", "b", "d"]);
  });

  it("returns the same reference for a no-op slot, so no state write happens", () => {
    expect(reorder(list, 1, 1)).toBe(list);
    expect(reorder(list, 1, 2)).toBe(list);
    expect(isNoopMove(1, 1)).toBe(true);
    expect(isNoopMove(1, 2)).toBe(true);
    expect(isNoopMove(1, 3)).toBe(false);
  });

  it("returns the same reference for out-of-range input", () => {
    expect(reorder(list, -1, 2)).toBe(list);
    expect(reorder(list, 9, 2)).toBe(list);
    expect(reorder(list, 0, -1)).toBe(list);
    expect(reorder(list, 0, 5)).toBe(list);
  });

  it("never mutates the input", () => {
    const copy = [...list];
    reorder(list, 0, 3);
    expect(list).toEqual(copy);
  });
});

describe("drag state machine", () => {
  const slotAt = (x: number) => insertionSlot(EDGES, x);
  const list = ["a", "b", "c", "d"];

  it("stays pending — with an unchanged state — under the threshold", () => {
    const s = beginDrag(0, 10, 10);
    const moved = advanceDrag(s, 12, 10, slotAt(12));
    expect(moved).toBe(s);
    expect(moved.phase).toBe("pending");
    expect(moved.slot).toBeNull();
  });

  it("becomes a drag once the threshold is passed and then tracks the slot", () => {
    let s = beginDrag(0, 10, 10);
    s = advanceDrag(s, 10 + DRAG_THRESHOLD, 10, slotAt(160));
    expect(s.phase).toBe("dragging");
    expect(s.slot).toBe(2);
    const same = advanceDrag(s, 40, 10, 2);
    expect(same).toBe(s); // same slot = no churn for the indicator
    s = advanceDrag(s, 260, 10, slotAt(260));
    expect(s.slot).toBe(3);
  });

  it("commits the slot the indicator was showing", () => {
    let s = beginDrag(0, 10, 10);
    s = advanceDrag(s, 200, 10, slotAt(260));
    s = dropDrag(s);
    expect(s.phase).toBe("dropped");
    expect(commitDrag(s, list)).toEqual(["b", "c", "a", "d"]);
  });

  it("restores nothing on Escape — the order was never touched", () => {
    let s = beginDrag(0, 10, 10);
    s = advanceDrag(s, 200, 10, slotAt(260));
    s = cancelDrag(s);
    expect(s.phase).toBe("cancelled");
    expect(s.slot).toBeNull();
    expect(commitDrag(s, list)).toBe(list);
  });

  it("treats a release under the threshold as a click, not a drop", () => {
    let s = beginDrag(2, 10, 10);
    s = advanceDrag(s, 11, 11, slotAt(11));
    s = dropDrag(s);
    expect(s.phase).toBe("cancelled");
    expect(commitDrag(s, list)).toBe(list);
  });

  it("ignores moves after the drag has ended", () => {
    let s = dropDrag(advanceDrag(beginDrag(0, 10, 10), 200, 10, 3));
    const after = advanceDrag(s, 400, 10, 4);
    expect(after).toBe(s);
    s = cancelDrag(s);
    expect(advanceDrag(s, 400, 10, 4)).toBe(s);
  });

  it("keeps the order for a drop into the item's own slot", () => {
    let s = beginDrag(1, 10, 10);
    s = advanceDrag(s, 120, 10, 2);
    s = dropDrag(s);
    expect(commitDrag(s, list)).toBe(list);
  });
});
