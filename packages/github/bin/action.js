#!/usr/bin/env node
// The entry for action.yml. It runs from the target repo's checkout, so tsx resolves from here, not from there.
import { register } from "tsx/esm/api";

register();
await import("../src/action.ts");
