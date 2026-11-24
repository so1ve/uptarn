#!/usr/bin/env node
import { createCli } from "./cli.ts";

await createCli().runMain();
