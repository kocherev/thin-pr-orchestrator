---
name: unslop
description: >
  Cut machine-written patterns from public copy. Use when editing README.md,
  docs/, WORKING.md, or a pull request title and body. Apply after
  skills/technical-writing.
---

# Unslop

Edit the text to remove the patterns below. Preserve the meaning. Match the direct voice already in `README.md` and `WORKING.md`.

Rule numbers are stable. A removed rule leaves a gap.

## Content

3. **Superficial -ing phrases.** "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". Delete the phrase, or replace it with the source, the file, or the number.
5. **Vague attributions.** "Experts believe", "Industry reports suggest". Name the source, or delete the claim.

## Language

7. **Stock vocabulary.** Additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape as an abstraction, pivotal, showcase, tapestry as an abstraction, testament, underscore, vibrant. Use a plain word.
8. **Fancy ways to say "is".** "serves as", "stands as", "boasts", "features". Say "is" or "has".
9. **"Not just X, but Y."** State the point in one sentence.
10. **Forced groups of three.** Use the real count. This repo has five specialists and three gate rules. Do not pad a list to three, and do not cut a real fourth item.
11. **Synonym cycling.** Pick one name and repeat it. The control plane is `packages/core`. Do not also call it the engine, the runtime, and the brain.
12. **False ranges.** "From X to Y" where X and Y are not a scale. List the topics.

## Style

13. **Em dashes.** Do not use them. Use a period or a comma. Do not use a parenthetical aside, an en dash, or a hyphen as a dash. A hyphen inside a compound such as `small-feature` stays. Parentheses that belong to code, a function call, or a quoted command line stay.
14. **Colon overuse.** A colon before a list or a fenced example is fine. A colon as a mid-sentence joint is not.
15. **Boldface overuse.** Do not bold every name.
16. **Inline-header lists.** A bold label that restates the sentence is noise. A bold lead-in that names the item, ends with a period, and is followed by new detail is fine.
17. **Title case headings.** Use sentence case.
18. **Decorative emojis.** Remove them from headings and bullets.
19. **Curly quotes.** Use straight quotes.

## Closings and filler

20. **Stock closings.** "I hope this helps", "Let me know if", "Of course", "Certainly". Delete them.
22. **Praise before the point.** Start with the fact.
23. **Filler.** "In order to" is "to". Delete "It is important to note that".
24. **Stacked hedges.** "could potentially possibly" is "may", or it is a fact with a condition.
25. **Empty endings.** End on the command, the file, or the number. Do not add a sentence about the future in general.

## Jargon

26. **Abstract stand-ins.** If a plain word exists, use it. "Control plane" is the name of `packages/core` in this repo, so keep it. Do not add substrate, wedge, vector, locus, nexus, north star, flywheel, or a metaphor in place of the package name.
27. **Say what it does.** Name the function, the flag, or the count. Cut a sentence that could be pasted into another project's docs unchanged.
28. **Dense sentences.** One idea per sentence. Split the sentence that makes the reader reread.
29. **Active voice.** Name the actor. Passive is fine when the actor is unknown.
30. **Weak verbs with adverbs.** Use the verb, or use the number.
31. **Plain words.** "utilize" becomes "use". "facilitate" becomes "help". "numerous" becomes "many".
32. **Mannered lines.** Aphorisms, personified code, and stock framing. Say what the code does.
33. **Over-compression.** Write the articles and the verb. Spell the path. A quoted error string stays exact.
