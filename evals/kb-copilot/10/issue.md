# Add a Delete product button to the product page

The API has `DELETE /products/{id}`, which also removes the product's documents and indexed chunks, but the web app has no way to call it. A product made by mistake stays in the list for good.

Done when:
- The product page has a `Delete product` button. It asks once with `window.confirm`, naming the product, and does nothing when the user cancels.
- On confirm it calls `DELETE /products/{id}` and then returns to the product list (`router.push` or `router.replace` to `/`, plus a refresh so the list reloads).
- If the API refuses (for example 409 while documents are still indexing) or the request fails, the page stays where it is and shows the API's message in an alert.
