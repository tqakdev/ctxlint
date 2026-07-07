const test = require("node:test");
const assert = require("node:assert");
const { validateOrder } = require("../src/schemas/order");

test("rejects orders without a sku", () => {
  assert.strictEqual(validateOrder({ total: 100 }).ok, false);
});
