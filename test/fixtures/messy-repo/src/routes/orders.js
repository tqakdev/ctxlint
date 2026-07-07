const { Router } = require("express");
const { validateOrder } = require("../schemas/order");
const { formatMoney } = require("../utils/helpers");

const router = Router();

router.post("/", (req, res) => {
  const result = validateOrder(req.body);
  if (!result.ok) {
    return res.status(400).json({ error: result.message });
  }
  res.status(201).json({ id: Date.now(), total: formatMoney(result.value.total) });
});

module.exports = router;
