# UiPath Job Schedules

A calendar-based visualizer for UiPath Orchestrator process schedules. View projected job run times across month, week, 3-day, and day views; filter by process, machine, and folder; and share or bookmark any view via URL.

---

## Features

### Calendar Views
- **Month view** — overview of scheduled runs per day
- **Week / 3-day / Day views** — time-grid showing exact run windows with colored event pills per process

### Schedule Projection
- Projects future occurrences from Quartz/standard CRON expressions up to 365 days ahead
- Respects each schedule's own timezone; all events are displayed in the user-selected display timezone
- Duration estimated from the median of the last 10 successful job runs (configurable fallback default)

### Folder Discovery
- Automatically discovers all accessible Orchestrator folders for the authenticated tenant
- Fetches schedules from every folder in parallel and deduplicates by schedule ID

### Filters (sidebar)
- **Processes** — show/hide individual schedules by name
- **Machines** — filter by the assigned robot machine
- **Folders** — filter by Orchestrator folder

### URL-based Persistence
All active filters, calendar view, projection window, and display timezone are encoded in the page URL as query parameters. Copying the URL and opening it later (or sharing it with a colleague) restores the exact same view:

| Parameter | Description |
|-----------|-------------|
| `hp` | Comma-separated hidden process IDs |
| `hm` | Comma-separated hidden machine names |
| `hf` | Comma-separated hidden folder IDs |
| `view` | Calendar view: `month` \| `week` \| `3day` \| `day` |
| `days` | Projection window in days (default 30) |
| `tz` | Display timezone (IANA, e.g. `America/New_York`) |

### Dark / Light mode
Apollo-themed dark mode by default; toggle to light via the settings popover.

### Gap Warnings
Events on the same machine that have less than 5 minutes between the projected end of one run and the start of the next are flagged with a ⚠ icon.

---

## Requirements

- A UiPath Orchestrator tenant (Cloud or on-premises)
- A Personal Access Token (PAT) with scopes: `OR.Execution`, `OR.Monitoring`, `OR.Jobs`
- [Node.js](https://nodejs.org/) and [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) for local development

---

## Local Development

```bash
# Install Wrangler (if not already installed)
npm install -g wrangler

# Start the local dev server (serves static assets + Cloudflare Pages Functions)
wrangler pages dev . --compatibility-flag=nodejs_compat
```

The app will be available at `http://localhost:8788` (or the port shown in the terminal).

> **Note:** The browser app calls `/api/fetch-uipath` — a Cloudflare Pages Function in `functions/api/fetch-uipath.js`. Wrangler emulates this locally, so no separate backend is needed.

---

## Connection Setup

1. Open the app and click **Connect** in the header.
2. Fill in:
   - **Orchestrator URL** — base URL, e.g. `https://cloud.uipath.com/myorg`
   - **Tenant** — tenant name, e.g. `Default`
   - **API Prefix** — `/orchestrator_` for UiPath Cloud; leave empty for on-premises
   - **Bearer Token** — your PAT (stored in `sessionStorage`, never sent to third parties)
3. Click **Load Schedules**.

---

## Deployment to Cloudflare Pages

1. Push this repository to GitHub.
2. In the [Cloudflare Dashboard](https://dash.cloudflare.com/), create a new **Pages** project and connect it to the repository.
3. No build command is needed — set the output directory to `.` (repository root).
4. Cloudflare automatically picks up the `functions/` directory for Pages Functions.

---

## Project Structure

```
├── index.html                  # Single-page app shell (Tailwind CDN, React 18 UMD)
├── app.js                      # All React components and application logic
├── styles.css                  # Apollo dark-mode design tokens and component styles
├── functions/
│   └── api/
│       └── fetch-uipath.js     # Cloudflare Pages Function — Orchestrator proxy
├── wrangler.jsonc              # Wrangler configuration
└── _headers                    # Cloudflare Pages response headers
```
