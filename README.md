# Briana Kelley Realty Dashboard

A small Node app that serves a client dashboard and pulls live data
from Notion. Designed to run as a single Sevalla Application (one
service does everything — no separate frontend host, no Vercel).

## How it's shaped

```
.
├── server.js                      # Express server + Notion proxy
├── package.json
├── .env.example                   # Copy to .env locally; set in Sevalla in prod
├── public/
│   └── clients/
│       └── briana/
│           └── index.html         # Dashboard view (replace with your full HTML)
└── INTEGRATE_EXISTING_HTML.md     # How to wire 05_Client_Dashboard_Briana.html
```

Routes:

- `GET /clients/briana/` — the dashboard HTML
- `GET /api/client-dashboard/briana` — assembled JSON, 5-min in-memory cache
- `GET /healthz` — health check (used by Sevalla)
- `GET /` — index of clients

## Local development

```bash
cp .env.example .env
# fill in NOTION_TOKEN and the IDs
npm install
npm start
# open http://localhost:3000/clients/briana/
```

The first request will take 1–3 seconds (cold Notion calls in parallel);
subsequent requests hit the in-memory cache and return in <50ms until
the 5-minute TTL expires.

## Deploying to Sevalla

You currently have this set up as a **static site** on Sevalla. Switch
it to an **Application** — that's what lets us run the Node proxy.

1. **Notion integration** (skip if already done):
   - https://www.notion.so/profile/integrations → New internal integration
   - Capability: Read content only
   - Copy the secret (starts with `secret_` or `ntn_`)
   - In Notion, share each of these with the integration (Connections menu):
     the Accelerate Retainer project page, Retainer Workbook Database,
     All Social Media Calendar, Master Calendar, Tasks Table, BrandScript page

2. **In Sevalla:**
   - Delete the existing static site for this repo (or leave it; it won't conflict).
   - Create a new **Application** pointed at the same GitHub repo.
   - Build strategy: **Buildpacks** (Nixpacks). Sevalla auto-detects Node via
     `package.json` — no Procfile needed.
   - Start command: leave blank (uses `npm start`).
   - Port: leave blank (Sevalla injects `PORT`; `server.js` honors it).

3. **Environment variables** (Sevalla → Application → Environment variables):

   | Key | Value |
   |---|---|
   | `NOTION_TOKEN` | the secret from step 1 |
   | `BRIANA_PROJECT_ID` | `2ed77ccd13c580bbace0d17bcdc62ecf` |
   | `BRIANA_CLIENT_ID` | `35677ccd13c580f9b84de178739bd91f` |
   | `BRIANA_BRANDSCRIPT_ID` | `35e77ccd13c58135818edfadb6e5a6d0` |
   | `RETAINER_WORKBOOK_DB_ID` | `34b77ccd13c5807fb2f9dc284c71a05f` |
   | `SOCIAL_MEDIA_CALENDAR_DB_ID` | (look up — see below) |
   | `MASTER_CALENDAR_DB_ID` | (look up — see below) |
   | `TASKS_DB_ID` | (look up — see below) |

   To find a database ID: open the database in Notion as a full page, copy
   the URL — the 32-character hex string before `?` is the ID. Example:
   `https://www.notion.so/workspace/My-DB-abc123def4567890abc123def4567890?v=...`
   → ID is `abc123def4567890abc123def4567890`.

4. **Deploy.** Sevalla rebuilds on every push to the default branch. The
   first deploy takes \~60s.

5. **Verify.**
   - Visit `https://<your-sevalla-domain>/healthz` → should return `{"ok":true}`.
   - Visit `https://<your-sevalla-domain>/api/client-dashboard/briana` → JSON.
   - Visit `https://<your-sevalla-domain>/clients/briana/` → the dashboard.

6. **Custom domain.** In Sevalla, add `letsbackflip.com` (or a subdomain
   like `dashboards.letsbackflip.com`) and follow their DNS instructions.
   Briana's URL becomes `<your-domain>/clients/briana/`.

## Monthly workflow

Unchanged from the implementation guide — Maria fills in a new Monthly
Report row in the Retainer Workbook each month. Within five minutes
(cache TTL), the dashboard reflects the new month.

## Adding a new client

1. Make their Notion project page, BrandScript, and first Monthly Report row.
2. Add their integration share (the integration must be able to read their pages).
3. Add a new entry to the `CLIENTS` map in `server.js`:

   ```js
   newslug: {
     projectId:     process.env.NEWCLIENT_PROJECT_ID,
     clientId:      process.env.NEWCLIENT_CLIENT_ID,
     brandscriptId: process.env.NEWCLIENT_BRANDSCRIPT_ID,
     workbookDbId:  process.env.RETAINER_WORKBOOK_DB_ID,      // shared
     socialCalDbId: process.env.SOCIAL_MEDIA_CALENDAR_DB_ID,  // shared
     masterCalDbId: process.env.MASTER_CALENDAR_DB_ID,        // shared
     tasksDbId:     process.env.TASKS_DB_ID,                  // shared
     displayName:   'New Client Realty',
     tagline:       'Their tagline.',
     retainer:      'Accelerate Retainer · Phase 1',
     teamLead:      'Ryan Freng (Creative Director)',
   },
   ```

4. Add their per-client env vars in Sevalla (`NEWCLIENT_PROJECT_ID`, etc.).
5. Drop a dashboard HTML at `public/clients/newslug/index.html`.
6. Push. Sevalla rebuilds. URL is `<your-domain>/clients/newslug/`.

## Troubleshooting

- **`/api/client-dashboard/briana` returns 500.** Check Sevalla logs.
  Common causes: `NOTION_TOKEN` missing or wrong, the integration hasn't
  been shared with one of the databases (you'll see "object_not_found"),
  or a property name in `server.js` doesn't match Notion (Notion is
  case-sensitive; "Project" vs "project" matter).
- **Dashboard loads but sections are empty.** The integration probably
  doesn't have access to that specific database/page. Open each
  database in Notion → `···` → Connections → confirm "Backflip Client
  Dashboard" (or whatever you named it) appears.
- **April data shows, May doesn't.** Maria hasn't created the May
  Monthly Report row yet, or `Type` isn't set to `Monthly Report`, or
  `Client` relation isn't set to Briana.
- **Recent Content is empty.** Posts must be logged in the All Social
  Media Calendar with the `🎉 Project` relation set to the project.
  Documented gap from the implementation guide; team needs to log
  every Backflip-driven post going forward.
