import { z } from "zod";
import { githubHeaders } from "./installation-token.js";

// The Action listens for the same label. This file name is the switch between the two runtimes.
export const ACTION_WORKFLOW = "thin-pr.yml";

const workflowSchema = z.object({ state: z.string() });

/**
 * True when the repository has an enabled thin-pr workflow, so the Action already handles the label and the App
 * must not. A repository without the workflow, or with it disabled, belongs to the App.
 */
export async function actionWorkflowEnabled(input: {
  readonly owner: string;
  readonly repo: string;
  readonly token: string;
  readonly fetch: typeof fetch;
}): Promise<boolean> {
  const response = await input.fetch(
    `https://api.github.com/repos/${input.owner}/${input.repo}/actions/workflows/${ACTION_WORKFLOW}`,
    { headers: githubHeaders(`Bearer ${input.token}`) },
  );
  if (response.status === 404) {
    await response.body?.cancel();
    return false;
  }
  if (response.status !== 200) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`GitHub returned ${response.status} for ${ACTION_WORKFLOW} in ${input.owner}/${input.repo}: ${detail}`);
  }
  return workflowSchema.parse(await response.json()).state === "active";
}
