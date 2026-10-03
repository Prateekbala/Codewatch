import { cpSync } from "node:fs";

cpSync(
  new URL("../src/core/prompts/templates", import.meta.url),
  new URL("../dist/core/prompts/templates", import.meta.url),
  { recursive: true },
);
