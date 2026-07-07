import { describe, expect, it } from "vitest";
import { createFakeRepo } from "./db.js";

describe("fake repo", () => {
  it("assigns sequential fake ids", async () => {
    const repo = createFakeRepo();
    const order = await repo.insertOrder({ sku: "SKU-1", quantity: 2 });
    expect(order.id).toBe("fake-0");
  });
});
