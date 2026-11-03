# Reject a non-positive --limit in the eval answers script

`python -m kb_evals.answers --limit N` keeps the first N eval rows. `--limit 0` quietly writes an empty file and prints "wrote 0 answers", and a negative number such as `-5` drops the last five rows and keeps the rest. Both look like a successful run, and `make eval-live` then judges an empty or partial file without saying so.

Done when:
- A `--limit` below 1 exits with a nonzero status and a message that says it must be at least 1. This happens before any model call and before any file is written.
- A positive `--limit`, and no `--limit`, behave as before.
