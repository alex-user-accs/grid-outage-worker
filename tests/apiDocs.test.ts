import { describe, expect, it } from "vitest";
import { kindOf } from "@docs/annotations";
import { buildAnnotatedSpec, specStats } from "@/lib/apiDocs";

describe("annotated API docs", () => {
  const spec = buildAnnotatedSpec({ "/v1.0/station/latest": 42 });
  const ops = Object.entries(spec.paths).flatMap(([path, o]) => Object.values(o).map((op) => ({ path, op })));

  it("keeps all 40 Deye operations", () => {
    expect(ops).toHaveLength(40);
    expect(specStats().total).toBe(40);
  });

  it("flags every control/strategy command as WRITE, but not result lookups", () => {
    expect(kindOf("/v1.0/order/{orderId}")).toBe("read");
    expect(kindOf("/v1.0/strategy/dynamicControl/readResult")).toBe("read");
    expect(kindOf("/v1.0/strategy/dynamicControl/read")).toBe("device-read");
    expect(specStats()).toMatchObject({ write: 18, deviceRead: 4 });
    for (const { path, op } of ops) {
      if (/\/(order|strategy)\//.test(path) && !/orderId|\/read/.test(path)) {
        expect(kindOf(path)).toBe("write");
        expect(op.summary).toMatch(/^⚠️ WRITE/);
      }
    }
  });

  it("marks endpoints we poll as used, with live counts", () => {
    const latest = ops.find((o) => o.path === "/v1.0/station/latest")!.op;
    expect(latest.description).toContain("USED BY THIS APP");
    expect(latest.description).toContain("Calls today: 42");
    expect(latest["x-our-usage"]).toMatchObject({ kind: "read", used: true });
  });

  it("never marks a write endpoint as used", () => {
    for (const { path, op } of ops) if (kindOf(path) === "write") expect((op["x-our-usage"] as { used: boolean }).used).toBe(false);
  });
});
