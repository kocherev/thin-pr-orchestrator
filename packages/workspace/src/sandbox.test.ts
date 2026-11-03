import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createScratchRepo, loadRepoConfig, openWorkspace } from "./index.js";

// CI creates the user and runs `pnpm test:sandbox` with a canary secret, so every process above the check holds it
// in its environment. The scrub drops it by name, as it drops ANTHROPIC_API_KEY.
const user = process.env.THIN_PR_CHECK_USER;
const canary = process.env.THIN_PR_CANARY_KEY ?? "";
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe.runIf(process.platform === "linux" && user)("checks as THIN_PR_CHECK_USER", () => {
  it("cannot read the run's secrets from any process, write .git, or outlive the check", async () => {
    expect(canary).toMatch(/^canary-[a-z]/);
    const repo = createScratchRepo({ "src/a.ts": "export const a = 1;\n" });
    cleanups.push(() => repo.remove());
    const attack = [
      // The pattern does not match its own text, so a count above 0 is a real canary.
      `for p in /proc/[0-9]*; do tr '\\0' '\\n' 2>/dev/null < $p/environ; done | grep -c 'canary-[a-z]'`,
      "echo hook 2>/dev/null >> .git/hooks/post-commit || echo hooks-denied",
      "echo x 2>/dev/null >> .git/config || echo config-denied",
      "setsid sleep 600 > /dev/null 2>&1 < /dev/null & echo $! > src/leftover.pid",
      "echo built > src/out.txt",
      // A check may use git, such as a drift check on generated files.
      "git diff --quiet HEAD -- src/a.ts && echo git-works",
      "true",
    ].join("; ");
    const config = { ...loadRepoConfig(repo.dir), checks: { typecheck: attack, test: "true" } };
    const workspace = await openWorkspace({ dir: repo.dir, baseSha: repo.baseSha, config, checkUser: user });

    const { exitCode, logTail } = await workspace.runCheck("typecheck");

    expect(exitCode).toBe(0);
    expect(logTail).not.toContain(canary);
    expect(logTail.split("\n").filter(Boolean)).toEqual(["0", "hooks-denied", "config-denied", "git-works"]);
    const pid = Number(readFileSync(join(repo.dir, "src/leftover.pid"), "utf8"));
    expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
    // The run can still edit and diff what the check wrote.
    await workspace.replace("src/out.txt", "built", "edited");
    expect((await workspace.diff()).files.map((file) => file.path)).toEqual(["src/leftover.pid", "src/out.txt"]);
  });
});
