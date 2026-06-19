# MCP Workspace (Node API + Apps Script + Web UX)

This repository contains a multi-part "MCP-style" assistant system:

- `server/`: primary Node.js API and agent orchestration layer
- `Code.js` + `appsscript-backend/`: Google Apps Script bridge/tool implementations
- `web-ux/`: separate Node/Express UX that proxies to the Node API

`PROJECT.md` is the deep technical reference for architecture, tool contracts, and behavior details.

## Prerequisites

- Node.js 20+ (recommended)
- npm
- Access to required external services (Azure OpenAI, Google Apps Script web app, MongoDB, optional ElevenLabs)

## Local Setup

### 1) Configure environment

From the repository root:

```bash
cp .env.example .env
```

Fill in required values in root `.env`:

- `NODE_API_KEY`
- `AZURE_API_KEY`
- `AZURE_ENDPOINT` (or Azure OpenAI endpoint values)
- `GAS_WEB_APP_URL`
- `NODE_TO_GAS_SECRET`
- `MONGO_URI`

### 2) Install dependencies

```bash
npm install
cd server && npm install
cd ../web-ux && npm install
```

### 3) Start backend + web UX together

```bash
npm run dev:local
```

- API URL: `http://localhost:8787`
- Web UX URL: `http://localhost:8790`

This command starts both services and loads values from the shared root `.env`.

## Tests

From `server/`:

```bash
npm test
```

## Vercel Deployment

### 1) Prepare project

From the repository root:

```bash
npm install
npm run sync:public
```

### 2) Configure Vercel environment variables

Set the values from root `.env` in the Vercel dashboard (Production and Preview as needed). At minimum for production:

- `NODE_ENV=production`
- `REQUIRE_NODE_API_KEY=true`
- `JWT_SIGNING_SECRET`
- `NODE_API_KEY`
- `GOOGLE_CLIENT_ID`
- `MONGO_URI`
- `AZURE_API_KEY`
- `AZURE_ENDPOINT`

If API and UI are deployed in the same Vercel project, leave `NODE_API_BASE_URL` unset or empty.

### 3) External service requirements

- Add your Vercel domain to Google OAuth **authorized JavaScript origins** for `GOOGLE_CLIENT_ID`.
- Add `https://<your-domain>/login` (and `http://localhost:<port>/login` for local dev) to **authorized redirect URIs**.
- Allow Vercel egress in MongoDB Atlas network access.
- Keep API keys and secrets only in Vercel environment variables.

### 4) Deploy

```bash
npm run dev:vercel
# or production deploy:
vercel deploy --prod
```

## Deploy / Publish Safety Checklist

Before pushing this repo to GitHub:

1. Confirm no secrets exist in committed files (`.env`, API keys, tokens, private keys).
2. Keep all runtime secrets in environment variables or Apps Script Script Properties.
3. Verify `.gitignore` includes:
   - `.env` and `.env.*` files
   - `node_modules/`
   - local IDE artifacts and logs
4. Review staged changes before commit:

```bash
git status
git diff --staged
```

5. If any secret was ever committed, rotate it before making the repository public.

## GitHub First Push (new repo)

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin <your-repo-url>
git push -u origin main
```

## Notes

- The Node API is the primary runtime surface.
- The web UX proxies API calls server-side and can inject `NODE_API_KEY` without exposing it to browser JavaScript.
- Apps Script should store deployment secrets in Script Properties, not source code.
