import { buildServer } from "./server.js";

const port = Number(process.env.PORT ?? 3000);

const server = await buildServer();
await server.listen({ port });
