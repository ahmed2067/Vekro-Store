# VEKRO STORE

Arabic RTL storefront starter built with Node.js, Express, and plain HTML/CSS/JS.

## Run locally

1. Install Node.js 20 or newer.
2. Run `npm install`.
3. Copy `.env.example` to `.env`.
4. Fill the server-side Safka environment values (see below).
5. Run `npm start` and open `http://localhost:3000`.

## Safka configuration

The public API uses the `api-safka-key` request header and its public endpoints live under `/api/v1/public`. Configure these server environment variables:

- `SAFKA_API_BASE_URL`: the API host shown in Safka's official docs/dashboard.
- `SAFKA_API_KEY`: secret key. Never commit it or expose it to browser code.
- `SAFKA_PRODUCTS_PATH`: exact product-list path from the API docs.
- `SAFKA_CREATE_ORDER_PATH`: exact order-creation path from the API docs.

The API adapter deliberately requires the exact endpoint paths to be configured. The product response normalization and order body in the starter are provisional; verify the exact response and payload schemas against Safka's current documentation before enabling live customer orders. Test with a sandbox/test account first. No real order has been placed by this repository setup.

Official docs: https://public-api-docs.safka-eg.com/

## Current scope

- Responsive Arabic storefront layout
- Product search and category filters
- Cart and checkout form
- Server-side Safka proxy (API key stays on the server)
- Health endpoint at `/api/health`

Customer accounts, persistent database, order tracking, and an admin dashboard are not implemented yet. They should be added with server-side authentication and a database before public launch.
