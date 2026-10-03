#!/usr/bin/env node
import { main } from "./program.ts";

process.exitCode = await main(process.argv);
