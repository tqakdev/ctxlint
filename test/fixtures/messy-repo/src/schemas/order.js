function validateOrder(body) {
  if (!body || typeof body.sku !== "string" || typeof body.total !== "number") {
    return { ok: false, message: "order requires sku (string) and total (number)" };
  }
  return { ok: true, value: body };
}

module.exports = { validateOrder };
