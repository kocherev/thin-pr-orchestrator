# Refuse a desktop.scroll that moves nothing

`desktop.scroll` takes `dy` and `dx`, and both default to 0. A payload such as `{"x": 500, "y": 500}` is accepted: the helper moves the pointer, posts a scroll event of zero lines, and replies `{"ok": true}`. The caller believes the page scrolled. The helper already refuses other payloads that cannot do anything, with a reason the agent can read, and this one should be refused the same way.

Done when:
- A scroll where `dy` and `dx` are both 0, or both left out, is refused with `InvalidRequest` before the executor runs. Over RPC that is code 4000 with a reason.
- A scroll with either `dy` or `dx` non-zero works as before, including the range limits.
- The scroll row in the table in `apps/desktop/README.md` says at least one of them must be non-zero.
