import { describe, expect, it } from "vitest";
import { KeyedSerialQueue } from "./asyncQueue";

describe("KeyedSerialQueue", () => {
  it("runs work for one key in invocation order", async () => {
    const queue = new KeyedSerialQueue<string>();
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = queue.run("file", async () => {
      order.push("first:start");
      await blocked;
      order.push("first:end");
    });
    const second = queue.run("file", async () => { order.push("second"); });

    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
  });

  it("continues after a rejected task and does not serialize other keys", async () => {
    const queue = new KeyedSerialQueue<string>();
    const other = queue.run("other", async () => "ready");
    const failed = queue.run("same", async () => { throw new Error("failed"); });
    const recovered = queue.run("same", async () => "recovered");

    await expect(other).resolves.toBe("ready");
    await expect(failed).rejects.toThrow("failed");
    await expect(recovered).resolves.toBe("recovered");
  });
});
