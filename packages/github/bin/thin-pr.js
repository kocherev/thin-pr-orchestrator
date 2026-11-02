#!/usr/bin/env node
// The workspace packages export TypeScript sources, so the entry loads them through tsx.
import { register } from "tsx/esm/api";

register();
await import("../src/cli.ts");
