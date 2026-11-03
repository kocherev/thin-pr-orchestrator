# Redirect to the public web address, not the address the server sees

The Linear callback route and `proxy.ts` build their redirects from `request.url`. The web image binds to `0.0.0.0` (`HOSTNAME` in its Dockerfile), and in that setup the URL Next gives the handler can carry that host. The browser is then sent to `http://0.0.0.0:3000/settings?linear=connected` after connecting Linear, or to `http://0.0.0.0:3000/sign-in` when signed out, and neither loads. `BETTER_AUTH_URL` is already the one setting that says where users reach the app.

Done when:
- The redirects in the Linear callback route and in `proxy.ts` use `BETTER_AUTH_URL` as their base when it is set, and `request.url` when it is not.
- A trailing slash in `BETTER_AUTH_URL` does not break the path.
- A request with a session cookie still passes through unchanged.
