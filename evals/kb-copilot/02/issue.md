# Limit how many handoffs the agent can propose per session

`POST /internal/escalations` stores a new proposal every time the agent calls it. Nothing stops a confused or manipulated agent from putting dozens of tickets in front of the user in one session, and each one is a card the user has to read and dismiss. A session should only ever carry a few.

Done when:
- A session (one room) accepts at most 3 proposals. The fourth call answers HTTP 429 with a short plain `detail`, and stores nothing.
- The count is per room, counts proposals in any status (a dismissed proposal still uses its slot), and does not affect other sessions.
- The limit is a named constant, and the 429 is listed in the route's documented responses. If the OpenAPI document changes, regenerate it with `pnpm openapi`.
