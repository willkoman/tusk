import { describe, expect, it } from "vitest";
import { KeyedStaleGuard, StaleGuard } from "./staleGuard";

describe("StaleGuard", () => {
  it("only the newest mint is current", () => {
    const guard = new StaleGuard();
    const first = guard.mint();
    const second = guard.mint();
    expect(guard.current(first)).toBe(false);
    expect(guard.current(second)).toBe(true);
  });

  it("invalidate stales outstanding tokens without minting", () => {
    const guard = new StaleGuard();
    const token = guard.mint();
    guard.invalidate();
    expect(guard.current(token)).toBe(false);
    expect(guard.current(guard.mint())).toBe(true);
  });

  it("nothing is current after dispose, even a fresh mint", () => {
    const guard = new StaleGuard();
    const before = guard.mint();
    guard.dispose();
    expect(guard.alive).toBe(false);
    expect(guard.current(before)).toBe(false);
    expect(guard.current(guard.mint())).toBe(false);
  });

  it("out-of-order replies land newest-only", async () => {
    const guard = new StaleGuard();
    const applied: string[] = [];
    let releaseSlow!: () => void;
    const slow = new Promise<void>((resolve) => { releaseSlow = resolve; });
    const request = async (name: string, wait: Promise<void>) => {
      const token = guard.mint();
      await wait;
      if (guard.current(token)) applied.push(name);
    };
    const a = request("slow", slow);
    const b = request("fast", Promise.resolve());
    await b;
    releaseSlow();
    await a;
    expect(applied).toEqual(["fast"]);
  });
});

describe("KeyedStaleGuard", () => {
  it("keys are independent", () => {
    const guard = new KeyedStaleGuard<string>();
    const a = guard.mint("a");
    const b = guard.mint("b");
    guard.mint("a");
    expect(guard.current("a", a)).toBe(false);
    expect(guard.current("b", b)).toBe(true);
  });

  it("invalidateAll stales every key; dispose stales forever", () => {
    const guard = new KeyedStaleGuard<string>();
    const a = guard.mint("a");
    const b = guard.mint("b");
    guard.invalidateAll();
    expect(guard.current("a", a)).toBe(false);
    expect(guard.current("b", b)).toBe(false);
    const c = guard.mint("c");
    expect(guard.current("c", c)).toBe(true);
    guard.dispose();
    expect(guard.alive).toBe(false);
    expect(guard.current("c", c)).toBe(false);
    expect(guard.current("c", guard.mint("c"))).toBe(false);
  });

  it("a token for an unknown key is never current", () => {
    const guard = new KeyedStaleGuard<string>();
    expect(guard.current("never", 1)).toBe(false);
  });
});
