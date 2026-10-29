# carpool-egypt (work in progress)

Backend foundation for an Egyptian intercity carpooling marketplace (BlaBlaCar-style cost sharing).
**Status: backend core only.** There is no web frontend, worker, payment, messaging, review or document-verification
code yet. See [`docs/status.md`](docs/status.md) for the exact list of what is and is not done, and
[`docs/architecture.md`](docs/architecture.md) for design and diagrams.

## What works (and is covered by automated tests)
- Registration, e-mail verification, login, rotating refresh tokens with reuse detection, logout, password reset/change
- Permission-based RBAC enforced server-side on every protected route, immediate suspension/session revocation, audit log
- Driver application and manual review, vehicles, trip publishing with validation and overlap protection
- Route-aware search (city or PostGIS proximity), per-segment seat inventory
- Booking engine: instant/approval modes, idempotency keys, cancellation, expiry sweep, trip cancellation, concurrency-safe

## Requirements
Node 22+, PostgreSQL 16 with **PostGIS** and **citext** extensions. (`docker-compose.yml` provides a matching DB.)

## Local setup
```bash
npm install
# 1. Database (either docker compose, or your own Postgres)
export POSTGRES_PASSWORD=choose-a-password && docker compose up -d db
# Own Postgres instead? As a superuser run once per database:
#   CREATE EXTENSION postgis; CREATE EXTENSION citext;

# 2. Configure
cp .env.example apps/api/.env      # then edit DATABASE_URL and set a >=32-char JWT_ACCESS_SECRET

# 3. Schema + reference data
npm run migrate
npm run seed -w apps/api -- --dev   # cities; --dev also switches ON publishing/booking flags (local only)

# 4. First staff account (password supplied via environment, never stored in the repo)
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='at-least-12-chars' npm run create-admin -w apps/api

# 5. Run
npm run build && npm run start -w apps/api     # http://localhost:4000/health , API under /api/v1
```
Operational flags are **OFF by default** in migrations (`trip_publishing_enabled`, `booking_enabled`, `payments_enabled`)
so nothing legally sensitive is live until an administrator enables it via `PUT /api/v1/admin/settings/:key`.

## Checks
```bash
npm run lint && npm run typecheck && npm run build
# Tests need a reachable Postgres+PostGIS test DB (it is WIPED of app tables on each run):
export TEST_DATABASE_URL=postgres://user:pass@localhost:5432/carpool_test   # extensions pre-installed
npm test                 # 82 tests: unit + DB integration + concurrency + HTTP e2e
npm run test:unit        # DB-free subset
```
## API quick reference
`POST /auth/register|login|refresh|logout|verify-email|password-reset|password-reset/confirm|change-password` ·
`GET|PATCH /me` · `POST /drivers/apply` · `POST /vehicles` · `GET /trips/search` · `POST /trips` · `GET|PATCH /trips/:id` ·
`POST /trips/:id/cancel` · `POST /trips/:id/bookings` (needs `Idempotency-Key`) · `GET /me/bookings` · `GET /bookings/:id` ·
`POST /bookings/:id/confirm|reject|cancel` · `GET /admin/users|audit-logs|settings` · `POST /admin/users/:id/suspend|reinstate|roles` ·
`POST /admin/drivers/:userId/approve|reject` · `POST /admin/vehicles/:id/approve|reject`. All under `/api/v1`.
No OpenAPI/Swagger document exists yet.

## Legal notice
Technical controls here do not make the service legally compliant. Egyptian transport licensing (Law 87/2018), personal data
protection (Law 151/2020), payments and tax requirements have **not** been researched or satisfied in this repository.

## Web frontend (added)
A responsive Arabic RTL web UI is now included in `apps/web/` (plain HTML/CSS/JS, no frontend build step). It includes:
- Landing page and responsive mobile layout
- Search trips against `GET /api/v1/trips/search`
- Registration/login and session refresh against the existing auth API
- Booking requests, passenger booking list, and driver trip list
- Driver application, vehicle registration, and a two-city trip publishing form
- A public cities endpoint at `GET /api/v1/cities` for seeded Egyptian cities

The frontend does not fabricate trip results. Search results stay empty when the database has no published trips. Booking and publishing may be rejected while the backend's default operational flags are OFF; this is intentional.

### Run the frontend on Windows
1. Install Node.js 22 or newer.
2. Open PowerShell in the project folder (`carpool-egypt`).
3. Run `npm run web:start`.
4. Open `http://localhost:3000`.

The homepage shell can load without the API, but live cities, login, search, bookings and publishing require the API and database to be configured.

### Connect to the API
- Default API URL: `http://localhost:4000/api/v1`.
- To use another API URL, edit `apps/web/config.js` and set `window.CARPOOL_API_BASE` to the public API base URL ending in `/api/v1`.
- Set `CORS_ORIGINS=http://localhost:3000` in `apps/api/.env` for local development.
- Use HTTPS for production, set the exact frontend origin in `CORS_ORIGINS`, and never commit real `.env` secrets.

### Current limitations — read before launch
- This is a working development foundation, not a production-ready public transport marketplace.
- The API requires PostgreSQL 16 with `postgis` and `citext`; no Docker is required if a suitable local or managed PostgreSQL database is provided.
- Email verification/reset flows require a real mail delivery setup; identity/license document upload and verification are not implemented.
- Payment processing, chat, reviews, refunds, support tickets, route-time estimates, and a full admin web console are not implemented.
- City coordinates are approximate city-centre points; the first trip form uses a simple three-hour arrival offset, not a real route planner.
- The admin must explicitly enable the trip-publishing and booking settings after appropriate legal and operational checks. Do not enable payments until a real provider and compliance review exist.
- A dependency install timed out in the build environment; frontend JavaScript syntax was checked, but the NestJS TypeScript build and database integration tests have not been verified after these changes.
