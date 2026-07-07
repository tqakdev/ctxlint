import Fastify from "fastify";

const app = Fastify();

app.get("/health", async () => ({ ok: true }));

await app.listen({ port: 4000 });
