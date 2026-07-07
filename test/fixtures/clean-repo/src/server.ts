import Fastify from "fastify";
import { createRepo } from "./lib/db.js";
import { orderSchema } from "./lib/validate.js";

export async function buildServer() {
  const app = Fastify();
  const repo = createRepo();

  app.post("/orders", async (request, reply) => {
    const parsed = orderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "invalid_body", message: "invalid order" } });
    }
    const order = await repo.insertOrder(parsed.data);
    return reply.status(201).send(order);
  });

  return app;
}
