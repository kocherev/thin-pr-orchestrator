# Return to the page the user asked for after signing in

A signed-out visit to `/products/abc` is redirected by `proxy.ts` to `/sign-in`, and after signing in the user always lands on `/`. They have to find the product again. This is most annoying with a link a teammate shared.

Done when:
- `proxy.ts` sends a signed-out visit to `/sign-in?next=<path and query of the page they asked for>`. For `/` itself it adds nothing, or `next=/`.
- After sign-in or sign-up, the form sends the user to `next` when it is a path on this site (a single leading `/`), and to `/` otherwise. An address such as `//evil.example` or `https://evil.example` is ignored.
- The link between the sign-in and sign-up forms keeps `next`.
