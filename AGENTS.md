# AGENTS.md

## Cursor Cloud specific instructions

This repo is one product ("MongieCRM" — an AI sales/CRM assistant) made of cooperating parts:

- `server/` — primary Node.js/Express API + LangChain/LangGraph agent. Runs on `:8787`.
- `web-ux/` — thin Express UI server that serves `web-ux/public/` and proxies `/api/*` to the API. Runs on `:8790`.
- `Code.js` / `appsscript-backend/` — Google Apps Script bridge (deployed separately via `clasp`; not run locally).
- `api/` — Vercel serverless wrappers around `server/`.

Node 20+ (VM has Node 22). The update script runs `npm install`; the root `postinstall` installs `server/` and `web-ux/` too.

### Run / lint / test (see `README.md` and `server/package.json` for canonical commands)
- Start both services: `npm run dev:local` (root) — starts API `:8787` + Web UX `:8790`, loading the shared root `.env`.
- Tests: `cd server && npm test` (`node --test`). Syntax check: `cd server && npm run check`.

### Required config (non-obvious)
- You MUST create a root `.env` (copy `.env.example`). Without it dotenv loads nothing; servers still boot but DB/agent calls fail. `.env` is gitignored.
- For a local MongoDB (no Atlas), set `MONGO_USE_ATLAS_SEARCH=false`. It defaults to `true`, and local `mongod` has no `$search`, so CRM list/search endpoints fail otherwise.
- External services are remote/secret: **MongoDB** (`MONGO_URI`), **Azure OpenAI** (`AZURE_API_KEY`,`AZURE_ENDPOINT`) for the chat agent, **Google OAuth** (`GOOGLE_CLIENT_ID`) for browser login, **Google Apps Script** (`GAS_WEB_APP_URL`,`NODE_TO_GAS_SECRET`) for Workspace tools. The `/api/chat` agent does not work without Azure OpenAI.

### Auth gotchas (for testing endpoints without Google OAuth)
- Machine auth (`Authorization: Bearer $NODE_API_KEY`) only passes if `NODE_API_KEY` is non-empty.
- CRM read endpoints (`/api/accounts`, `/api/contacts`, ...) require a `userId`: from an end-user JWT, or `?userId=<id>` when using machine auth. Mutation endpoints (e.g. `DELETE /api/contacts/:id`) use the JWT's `userId` and ignore `?userId`, so they need a real end-user JWT.
- `JWT_SIGNING_SECRET` defaults to `dev-insecure-jwt-secret-change-me` locally. You can mint a dev end-user JWT (HS256, `iss=mcp-node-api`, `aud=mongiecrm-app`, `sub=<userId>`) to exercise authed endpoints without Google.
- The web UI redirects unauthenticated users to `/login` (Google). To open the UI without OAuth, inject `localStorage.webUxAuthToken` (the JWT) and `localStorage.webUxAuthUser` (`{"userId":"...","email":"...","name":"..."}`), then load `/`.
- CRM records are owner-scoped by `ownerUserId`; seeded test data must use an `ownerUserId` matching your test user or it won't be visible.
