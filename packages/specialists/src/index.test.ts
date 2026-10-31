import { describe, expect, it } from "vitest";
import { createStubSpecialists, listSpecialists, packageId } from "./index.js";

describe("@thin-pr/specialists", () => {
  it("returns a fixed fixture for each stub step", async () => {
    expect(packageId).toBe("@thin-pr/specialists");
    expect(listSpecialists().map((specialist) => specialist.id)).toEqual([
      "planner",
      "implementer",
      "tester",
      "reviewer",
      "pr-writer",
    ]);

    const specialists = createStubSpecialists();
    const input = {
      issue: "Fix the stub.",
      templateId: "stub-run",
      prior: [],
    };
    await expect(specialists.plan.run({ ...input, step: "plan" })).resolves.toEqual({
      step: "plan",
      summary: "Plan the stub change.",
    });
    await expect(
      specialists.gate.run({
        ...input,
        step: "gate",
        prior: [
          { step: "plan", summary: "Plan the stub change." },
          { step: "implement", summary: "Apply the stub change." },
          { step: "test", summary: "Stub checks passed." },
          { step: "review", summary: "Stub review found nothing." },
        ],
      }),
    ).resolves.toMatchObject({ step: "gate", summary: "pass" });
  });
});
