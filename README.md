# AutoVINReveal

Source snapshot of [autovinreveal.com](https://www.autovinreveal.com) — a vehicle history report platform I designed, built, deployed and operate solo.

A customer enters a VIN, pays, and gets a full vehicle history report back in seconds. It serves **1,500+ active users** and has processed roughly **$30K** in customer transactions.

> **About this repository.** This is the application source, published for reading rather than as a deployable checkout. The commit history is real and intact, but filtered: environment files, deployment scripts, CI configuration, vendored dependencies, and all runtime state and cached report data have been removed from every commit — customer vehicle reports are never published. Commit hashes therefore differ from the private original.

---

## Architecture

**Node.js + Express** single-service backend (`server.js`), fronted by Caddy on a Linux VPS under systemd.

### Payments
Stripe Checkout with webhook signature verification, **idempotent processing**, transaction-state tracking and partial-payment handling — so a retried or duplicated webhook can't double-charge a customer or issue a second paid report.

### Auth & data
Supabase for Postgres and authentication, with Google OAuth, protected routes and role separation between customer and admin surfaces. Schema covers users, orders, transactions, reports and service state, with row-level security policies enforcing access at the database rather than in application code.

### Report pipeline
Integrates multiple vehicle-data providers plus NHTSA, with **provider-switching and fallback logic** for when an upstream service changes shape or goes down — the failure mode that actually happens in production. A response cache cuts redundant external calls and keeps per-report cost down.

### Hardening
Helmet, CORS, per-route rate limiting, and a server-side split between what the browser is trusted with and what it isn't. The Supabase key shipped to the client is the anon key; every privileged operation is server-side.

### Frontend
Vanilla JS with Tailwind — no framework. Roughly 20 SEO landing pages (per-make VIN decoders, a payment calculator, free lookup tools) built as an acquisition funnel into the paid product.

### Browser extension
A Manifest V3 Chrome extension (`extension/`) that detects VINs on vehicle listing pages and links straight through to a report.

---

## Layout

| Path | Contents |
|---|---|
| `server.js` | API, routing, payments, provider integration, auth middleware |
| `public/` | Static frontend, landing pages, dashboard, admin surfaces |
| `extension/` | Manifest V3 Chrome extension |
| `src/tw.css` | Tailwind source |

## Stack

Node.js · Express · Supabase (Postgres, Auth, RLS) · Stripe · Tailwind · Nodemailer · Chrome Extensions MV3 · Linux · systemd · Caddy

---

Built and maintained by [Oyeniyi Oyetunji](https://github.com/niyi-lab).
