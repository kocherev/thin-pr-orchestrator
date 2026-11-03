# Let approve retry an escalation stuck in creating

Approve moves an escalation from `proposed` to `creating` before it calls Linear, and from `creating` to `created` after. If the API process dies in between, or the request is cancelled, the row stays `creating` for good. Every later approve answers 409 "the escalation is creating", dismiss refuses it too, and the user can never create that ticket. A comment in `escalations.py` already says a lease timeout is the fix if this happens.

Done when:
- A `creating` escalation that has not changed for a couple of minutes can be claimed by a new approve, which creates the issue and moves the row to `created`.
- A `creating` escalation that changed recently still counts as in progress (409, Linear not called), so a double click still creates one issue.
- Approving a stuck escalation twice in a row creates one Linear issue.
- The comment that asks for a lease is removed.
