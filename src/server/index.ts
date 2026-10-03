import { existsSync } from "node:fs";

import { serve } from "@hono/node-server";

import { loadEnv } from "../core/config/env.ts";

import { createApp } from "./app.ts";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

loadEnv();
const port = Number.parseInt(process.env["PORT"] ?? "3000", 10);
const app = createApp({ port });

serve({ fetch: app.fetch, port }, (info) => {
  process.stdout.write(`listening on http://${info.address}:${info.port}\n`);
});
