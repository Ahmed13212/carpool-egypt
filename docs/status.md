# Status, limitations and remaining work

## Verified (executed; results from the final run)
`npm run lint` clean · `npm run typecheck` clean · `npm run build` OK · `npm audit --omit=dev`: 0 vulnerabilities (multer pinned to 2.5.0 via `overrides`) ·
`npm test`: **9 suites / 82 tests passed** against a real PostgreSQL 16 + PostGIS 3.4 instance · compiled server booted and smoke-tested over HTTP ·
`migrate` (idempotent re-run), `seed`, `create-admin` CLIs executed. Mutation check: removing the segment locks/capacity check makes 4 of 7 concurrency tests fail.

## Implemented
Auth/sessions, RBAC + audit log, driver/vehicle verification (manual review only), trips (create, limited edit, cancel, overlap guard), search (city + PostGIS radius, date/price/seat filters, sort, pagination), booking engine, admin APIs (users, roles, suspension, verification, audit, settings), health/readiness, security headers, JSON logging.

## Partially implemented
- Driver verification: status workflow exists but **no document upload/storage/review**; approval is a bare reviewer click.
- Notifications: none are sent; state changes are committed and audited but nothing is emitted. E-mail uses a dev adapter that does **not** deliver mail.
- Payments: only the `payments_enabled` flag and `awaiting_payment` status/expiry exist. No provider, payments tables, webhooks or refunds.
- Booking completion (`completed`/`no_show`) and trip lifecycle (`in_progress`/`completed`) transitions are defined but have no endpoints.

## Not implemented
Web frontend (Next.js, Arabic RTL, PWA) · worker/BullMQ/Redis · OpenAPI docs · payments/refunds/payouts/ledger · messaging · reviews/ratings · support tickets/incidents · document storage (S3) · MFA · phone verification · account deletion/consent records · routing-provider abstraction and route-compatibility scoring · admin dashboard analytics · Docker image verification · load tests · monitoring/error reporting · backup/restore docs · Arabic documentation · legal research.

## Known limitations / risks
- Rate limiter is in-process memory (per instance); needs Redis for multi-instance deployments.
- Registration returns 409 for an existing e-mail (account enumeration trade-off; reset flow does not enumerate).
- Booking-time cancellation has no fee/refund policy (no payments yet).
- `expireStale` must be scheduled by something; nothing calls it automatically yet.
- Suspending a driver does not cancel their trips/bookings.
- Search ignores driver rating and vehicle preferences (not implemented); geographic matching uses straight-line stop proximity, not road routing.
- `Dockerfile`, `docker-compose.yml` and `.github/workflows/ci.yml` were written but **not executed** (no Docker/CI available in the sandbox).
- Test DB is wiped of app tables on every run; never point `TEST_DATABASE_URL` at a real database.

## Needs credentials / approvals before launch
Mail provider (SES/SendGrid…), SMS provider, Paymob or other payment merchant approval, mapping/routing provider key, S3-compatible storage, hosting, error monitoring, and **legal review** (Law 87/2018 transport licensing, Law 151/2020 data protection, payments/tax, insurance).

## Suggested next steps
1. Worker + scheduler for `expireStale`; notification outbox. 2. Document upload (private S3, signed URLs) for verification. 3. OpenAPI. 4. Next.js web app (search → book → dashboards, Arabic RTL). 5. Payments sandbox adapter + webhooks. 6. Reviews, messaging, support. 7. Legal readiness research.
