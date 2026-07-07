const express = require("express");
const ordersRouter = require("./routes/orders");

const app = express();
app.use(express.json());
app.use("/orders", ordersRouter);

app.listen(process.env.PORT || 8080);
