---
name: technical-writing
description: >
  How to write docs in this repo. Use when editing README.md, docs/,
  WORKING.md, CONTRIBUTING.md, or a pull request title and body.
---

# Technical writing

Write so a tired reader gets the fact on the first pass. Then apply `skills/unslop` to the same text.

One document has one job.

- A tutorial shows the steps and the result the reader should see. The fork section in `README.md` is this.
- A how-to is a task for someone who already has the checkout. `WORKING.md` is this.
- A reference lists facts, names, and limits, with no pitch. The eval table and the package list are this.
- An explanation says why, on one bounded topic. `docs/design.md` is this.

Do not teach inside a reference table, and do not argue inside a how-to. Link to the other document.

## Sentences

- Talk to the reader as "you", in the present tense. Use "will" only for something that happens later.
- Name the actor. "The orchestrator opens the draft" is the sentence. "The draft is opened" drops the actor.
- Put the condition before the instruction. "To run one file, use `pnpm exec vitest run <path>`."
- One instruction per sentence. Split a sentence that makes the reader backtrack.
- Use the repo's names. Write `decide`, `thin-pr`, `pnpm eval`, and the real path. Do not invent a synonym for them.
- Keep "the" and "a". Repeat the noun when "it" or "this" could point at two things.
- Use periods. A colon introduces a list or a quoted example, not a second clause.
- Sentence case headings. A task heading is a verb phrase. A concept heading is a noun phrase.

## This repo

Public docs name the command, the file, and the number the command prints. `pnpm eval` prints `gate pass rate: 8/12 (66.7%)` on the committed fixtures. Quote a string the program writes. Do not round it into a different figure.

Code is fenced. A UI label, if one appears, is bold. Pull request text is a short briefing: what changed, how you checked it, and the eval report when eval ran. Do not paste a log that the checks already store.

`skills/working-style` still owns comments in code. Keep a comment only when the code cannot show the reason.
