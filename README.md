# VEKRO STORE

Arabic RTL storefront built with Node.js 20+ and Express.

## Current features
- Responsive storefront, product search, categories, cart and cash-on-delivery checkout.
- Server-side Safka API proxy. The API key must remain in server environment variables.
- The Safka public API authenticates with `api-safka-key`; public routes are under `/api/v1/public`.

## Run locally
1. Install Node.js 20+.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and set the values.
4. Run `npm start`.

## Required deployment settings
Set `SESSION_SECRET` (random, 32+ characters), `ADMIN_EMAIL`, `ADMIN_PASSWORD` (12+ characters), `NODE_ENV=production`, and `DATA_DIR` to persistent storage. Never commit `.env` or expose the Safka API key.

## Safka integration status
Set `SAFKA_API_BASE_URL`, `SAFKA_API_KEY`, and the exact `SAFKA_PRODUCTS_PATH` from the official API reference. Product import must be tested against your Safka account. The exact order-creation schema has not been verified, so the app must not submit live orders until that is confirmed.

Official docs: https://public-api-docs.safka-eg.com/

## Deployment
Pushing to GitHub does not itself publish a live website. A Node.js hosting service, environment variables, and persistent storage are required. The JSON-file prototype is not suitable for a high-volume production store; use a managed database before scaling.
