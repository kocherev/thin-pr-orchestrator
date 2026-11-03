# Send the internal token from the MCP get_product tool

`get_product` in `services/mcp` calls `GET /products/{id}` with no credentials. The API only lets a service read a product with the `X-Internal-Token` header, so every call ends in the tool error `product config returned 401`. The README lists this as a known limit. The agent already sends `INTERNAL_API_TOKEN` in that header, and the MCP server should do the same, so the tool works as the README describes it.

Done when:
- `get_product` sends the `INTERNAL_API_TOKEN` environment variable as `X-Internal-Token`, and returns the product when the API accepts it.
- With a wrong token the tool still fails with a tool error, and the error text never contains the token.
- `services/mcp/README.md` lists `INTERNAL_API_TOKEN` in the variable table and in the connect example, and the "Known limit" section is gone. The comment in `.env.example` that says the MCP server does not read the token is corrected.
