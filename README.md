# AuditPilot API

Standalone Express API project, separated from the frontend in `D:\AuditPilot`.

## Local development

```powershell
Copy-Item ..\AuditPilot\.env.example .env
npm ci
npm run dev
```

The API listens on port 5002 by default and expects MongoDB at
`mongodb://localhost:27017/auditpilot`. Add a `.env` file in this directory to
override settings or configure integrations such as GitHub OAuth. Set
`APP_URL` to the frontend's origin (for example, `http://localhost:5000`) so
GitHub sign-in returns to the web app.

## Docker

```powershell
# Create .env from ..\AuditPilot\.env.example, then set PORT=8080,
# MONGODB_URI=mongodb://mongo:27017/auditpilot, JWT_SECRET, and ENCRYPTION_KEY.
docker compose up --build -d
```

The API is published on `http://localhost:8080`; MongoDB runs in its own container. Set `CLIENT_ORIGIN` to the frontend origin(s). For separate HTTPS sites, configure `COOKIE_SAMESITE=none`.

## Cloudflare Worker

The Worker allowlists the production frontend origin through `CLIENT_ORIGIN` in
`wrangler.jsonc`. Update that value if the frontend hostname changes, then
redeploy the Worker.
