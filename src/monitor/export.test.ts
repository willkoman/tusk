import { describe, expect, it } from "vitest";
import { chartCsv, csvNumber, csvSampleCount, exportStem, toHex } from "./export";
import { SeriesBuffer } from "./model";

const wall = (t: number) => Date.UTC(2026, 9, 20, 12, 0, 0) + t;

describe("monitor export", () => {
  it("numbers: integers stay integers, fractions keep ten significant digits, non-finite is empty", () => {
    expect(csvNumber(42)).toBe("42");
    expect(csvNumber(0.1 + 0.2)).toBe("0.3");
    expect(csvNumber(1234.56789012345)).toBe("1234.56789");
    expect(csvNumber(NaN)).toBe("");
    expect(csvNumber(Infinity)).toBe("");
    expect(csvNumber(1e-9)).toBe("1e-9");
  });

  it("csv: a range of samples, joined on time across buffers, with quoted headers", () => {
    const a = new SeriesBuffer(16, 2);
    const b = new SeriesBuffer(16, 1);
    a.push(0, [1, 2]);
    a.push(1000, [3, 4]);
    a.gap(2000);
    a.push(3000, [5, 6]);
    b.push(1000, [0.5]);
    b.push(3000, [0.25]);
    const csv = chartCsv(
      [
        { buffer: a, series: 0, label: "Hit (B/s)" },
        { buffer: a, series: 1, label: 'Read, "disk"' },
        { buffer: b, series: 0, label: "Ratio" },
      ],
      500,
      3000,
      wall,
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe('time,Hit (B/s),"Read, ""disk""",Ratio');
    expect(lines[1]).toBe("2026-10-20T12:00:01.000Z,3,4,0.5");
    // The skipped tick stays in the record as an empty row.
    expect(lines[2]).toBe("2026-10-20T12:00:02.000Z,,,");
    expect(lines[3]).toBe("2026-10-20T12:00:03.000Z,5,6,0.25");
    expect(lines[4]).toBe("");
    expect(csvSampleCount(csv)).toBe(3);
  });

  it("csv: an empty range still has its header", () => {
    const a = new SeriesBuffer(4, 1);
    a.push(0, [1]);
    const csv = chartCsv([{ buffer: a, series: 0, label: "x" }], 10, 20, wall);
    expect(csv).toBe("time,x\r\n");
    expect(csvSampleCount(csv)).toBe(0);
  });

  it("file stems are safe and stamped", () => {
    const at = new Date(2026, 9, 20, 9, 5, 7);
    expect(exportStem("prod / main#2", "Block I/O", at)).toBe("monitor-prod-main-2-block-i-o-20261020-090507");
    expect(exportStem("***", "", at)).toBe("monitor-chart-chart-20261020-090507");
  });

  it("hex is lowercase and two digits per byte", () => {
    expect(toHex(new Uint8Array([0x89, 0x50, 0x0a, 0x00, 0xff]))).toBe("89500a00ff");
  });
});
