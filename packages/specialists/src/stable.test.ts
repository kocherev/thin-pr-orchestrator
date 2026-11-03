import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { stripLocalPaths } from "./stable.js";

describe("stripLocalPaths", () => {
  it("makes scratch checkouts relative and hides temp and home folders on any machine", () => {
    const mac = "/private/var/folders/p3/n9zm2_492w70sk4b0h_yd0ch0000gn/T";
    const log = [
      ` RUN  v5.0.5 ${mac}/thin-pr-repo-r1Qjp1/checkout`,
      `  File "${mac}/thin-pr-repo-Y7YOJ5/checkout/test/hidden/test_flags.py", line 9`,
      "RUN v5.0.5 /tmp/thin-pr-repo-AbC123/checkout",
      `worktree ${join(tmpdir(), "thin-pr-local-zz9Q", "checkout")}/src/a.ts`,
      `log at ${join(tmpdir(), "thin-pr-eval-x1", "01.sqlite")}`,
      `cache in ${join(homedir(), ".cache", "vitest")} and /home/runner/work/repo, /Users/someone/x`,
    ].join("\n");

    expect(stripLocalPaths(log)).toBe(
      [
        " RUN  v5.0.5 .",
        '  File "./test/hidden/test_flags.py", line 9',
        "RUN v5.0.5 .",
        "worktree ./src/a.ts",
        "log at $TMPDIR/thin-pr-eval-x1/01.sqlite",
        "cache in ~/.cache/vitest and ~/work/repo, ~/x",
      ].join("\n"),
    );
  });

  it("leaves relative paths, URLs, and lookalike names alone", () => {
    const text = "src/tmp/a.ts ./tmp https://example.test/Users/a/tmp/b /tmpfiles /Usersx/a";
    expect(stripLocalPaths(text)).toBe(text);
  });

  it("leaves lookalikes alone where this machine's temp and home folders are /tmp and /home/runner", async () => {
    vi.resetModules();
    vi.doMock("node:os", async (actual) => ({ ...(await actual<typeof import("node:os")>()), tmpdir: () => "/tmp", homedir: () => "/home/runner" }));
    try {
      const linux = await import("./stable.js");
      const text = "src/tmp/a.ts ./tmp https://example.test/home/runner/x /tmpfiles";
      expect(linux.stripLocalPaths(text)).toBe(text);
      expect(linux.stripLocalPaths("/tmp/thin-pr-repo-A1/checkout/src and /home/runner/work")).toBe("./src and ~/work");
    } finally {
      vi.doUnmock("node:os");
      vi.resetModules();
    }
  });
});
