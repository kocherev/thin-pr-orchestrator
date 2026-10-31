import { describe, expect, it } from "vitest";
import { createStubSpecialists, listSpecialists, packageId } from "./index.js";

describe("@thin-pr/specialists", () => {
  it("returns a fixed fixture for each stub step", () => {
    expect(packageId).toBe("@thin-pr/specialists");
    expect(listSpecialists().map((specialist) => specialist.id)).toEqual([
      "plan",
      "implement",
      "test",
      "review",
      "gate",
    ]);

    const specialists = createStubSpecialists();
    const input = {
      issue: "Fix the stub.",
      templateId: "stub-run",
      prior: [],
    };
    expect(specialists.plan.run({ ...input, step: "plan" })).toEqual({
      step: "plan",
      summary: "Plan the stub change.",
    });
    expect(specialists.gate.run({ ...input, step: "gate" }).summary).toBe("pass");
  });
});
