# Google Auth + Audit Rollout Checklist

## Environment
- Set `GOOGLE_CLIENT_ID`, `JWT_SIGNING_SECRET`, `JWT_ISSUER`, `JWT_AUDIENCE`, and `JWT_EXPIRY_SECONDS`.
- Ensure all web clients use the approved Google OAuth client ID.
- Keep `NODE_API_KEY` only for machine-to-machine fallback paths.

## Pre-Prod Validation
- Run `npm test` in `server`.
- Validate `POST /api/auth/google/exchange` with a real Google ID token.
- Confirm authenticated `GET /api/chat/sessions` works without sending `userId` in query.
- Confirm unauthenticated requests return `401`.
- Verify writes through chat/tool flows include `createdBy` and `updatedBy`.

## Data Migration
- Dry run: `npm run migrate:audit:backfill`
- Execute: `npm run migrate:audit:backfill:execute`
- Spot-check updated documents across accounts, contacts, workloads, tasks, milestones, and initiatives.

## Staged Rollout
- Start in staging with a small internal user cohort.
- Monitor auth exchange failures and 401 rates.
- Monitor CRM writes for missing `createdBy`/`updatedBy`.
- Roll to production after 24h of stable auth + audit metrics.

## Rollback
- If auth exchange failures spike, temporarily route clients through machine auth (`NODE_API_KEY`) while investigating.
- Keep migration script idempotent; no rollback required for audit fields because fields are additive.
