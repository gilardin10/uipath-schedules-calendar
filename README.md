# UiPath Schedules Calendar

A calendar and timeline visualizer for UiPath Orchestrator process schedules.
Works with **UiPath Automation Cloud** and **on-premises Orchestrator**.

**Two ways to run it — same code, same features:**

| | Local (your machine) | Online (Cloudflare Pages) |
|---|---|---|
| Setup | `node server.js` | Push to GitHub → Cloudflare |
| On-prem Orchestrator | ✅ | ❌ (not reachable from cloud) |
| UiPath Cloud | ✅ | ✅ |
| Auth: PAT | ✅ | ✅ |
| Auth: UiPath OAuth (PKCE) | ✅ | ✅ |
| Auth: On-Prem OAuth (PKCE) | ✅ | ❌ |
| Share URL with team | ❌ (localhost only) | ✅ |

---

## Features

- **5 calendar views** — Month, Week, 3-Day, Day, Timeline (Gantt by machine)
- **Schedule projection** — computes future occurrences from Quartz/CRON expressions up to 365 days ahead
- **Timezone-aware** — each schedule runs in its own timezone; display in any timezone you choose
- **Job duration** — estimated from the median of the last 10 successful runs; configurable fallback
- **Folder discovery** — auto-detects all accessible Orchestrator folders and fetches from all in parallel
- **Filters** — hide/show by process, machine, folder, tag, or robot account; all filters persist in the URL
- **Robot accounts** — filter schedules by the execution robot account assigned to run them
- **Gap warnings** — ⚠ flag when the same machine has < 5 min between projected run end and next start
- **Timeline collisions** — pulsing border when two jobs on the same machine overlap
- **Dark / Light mode** — Apollo dark theme by default, toggle in Settings
- **Shareable URLs** — every filter, view, timezone, and projection window is encoded in the URL
- **Loading progress** — step-by-step status messages during initial data load

---

## Option A — Run Locally (recommended for on-prem)

### Requirements

- [Node.js 18 or newer](https://nodejs.org/) — check with `node --version`
- Network access to your Orchestrator from your machine (the browser does **not** need to reach it)

### Steps

```bash
# 1. Download or clone the repo
git clone https://github.com/gilardin10/uipath-schedules-calendar.git
cd uipath-schedules-calendar

# 2. Start the server (no npm install needed)
node server.js
```

Open **http://localhost:3000** in your browser.

Click **Connection** in the header, choose your auth method, and load schedules.

### Custom port

```bash
PORT=8080 node server.js
```

### On-prem Orchestrator with a self-signed certificate

If your Orchestrator uses a self-signed or internal CA certificate, Node.js will
reject the TLS connection by default. Disable the check for your local session:

```bash
# Windows (PowerShell)
$env:NODE_TLS_REJECT_UNAUTHORIZED=0; node server.js

# macOS / Linux
NODE_TLS_REJECT_UNAUTHORIZED=0 node server.js
```

> This only affects the server process talking to Orchestrator — it does not
> affect your browser's connection to `localhost`.

---

## Option B — Deploy Online (Cloudflare Pages)

Best for teams: deploy once, share the URL with colleagues.
Requires a UiPath Automation Cloud tenant (on-prem is not reachable from the internet).

### Steps

1. Fork or push this repository to GitHub.
2. Log in to [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Select your repository.
4. Set **Build command** to *(empty)* and **Build output directory** to `/` (the repo root).
5. Click **Save and Deploy**.

Cloudflare automatically picks up `functions/api/fetch-uipath.js` as a serverless
proxy — no separate backend needed.

From now on, every push to `main` redeploys automatically.

---

## Authentication

Open the **Connection** popover (top-right of the header).

### PAT — Personal Access Token

Works with **both Cloud and on-prem**. Simplest option.

1. In Orchestrator → **Preferences** (your profile icon) → **Personal Access Tokens** → **Add Token**.
2. Grant scopes: `OR.Folders`, `OR.Execution`, `OR.Monitoring`, `OR.Jobs`, `OR.Robots`.
3. Copy the token (shown only once).
4. In the app: select **PAT**, paste the token, and enter your Orchestrator URL:

| Orchestrator type | URL format |
|---|---|
| UiPath Cloud | `https://cloud.uipath.com/myorg/mytenant/orchestrator_` |
| On-premises | `https://orchestrator.company.com` |
| On-premises (subfolder) | `https://server.local/orchestrator` |

### UiPath OAuth — Browser sign-in (Cloud only)

Lets your team sign in with their UiPath / SSO credentials — no token to copy.
Requires a one-time setup in UiPath Automation Cloud:

1. Go to **Admin** → **External Applications** → **+ Add Application**.
2. Set **Application type** to **Non-confidential (Public)**.
3. Add **Redirect URL** — copy exactly from the app's setup box (it shows your current URL).
4. Add **User scopes**:
   `OR.Folders.Read`, `OR.Execution.Read`, `OR.Machines.Read`,
   `OR.Robots.Read`, `OR.Jobs.Read`
5. Save and copy the **Client ID**.
6. In the app: select **UiPath OAuth**, paste the Client ID, and click **Sign in with UiPath**.
7. After sign-in you are redirected back — paste your Orchestrator URL and click **Save & Fetch**.

### On-Prem OAuth — Browser sign-in (On-premises only)

For on-premises Orchestrator deployments with Identity Server. Uses the
authorization code flow with PKCE.

1. In your Orchestrator's **Identity Server** → register an application.
2. Set the Redirect URL to the URL shown in the app's "On-Prem OAuth" tab.
3. Note the **Client ID**.
4. In the app: select **On-Prem OAuth**, enter:
   - **Orchestrator URL** — e.g. `https://orchestrator.company.com`
   - **Tenant** — leave empty for single-tenant setups
   - **Client ID** — from step 3
5. Click **↗ Sign in with On-Prem** — you'll be redirected to your Identity Server login page.
6. After sign-in, the app exchanges the code for a token and loads your schedules.

> **Required scopes** for on-prem Identity Server app registration:
> `openid`, `profile`, `offline_access`
>
> The Bearer token from Identity Server provides access to Orchestrator OData
> endpoints based on the user's Orchestrator roles.

---

## Required API Scopes

| Scope | Used for |
|---|---|
| `OR.Folders.Read` | Discovering all accessible folders |
| `OR.Execution.Read` | Reading process schedules |
| `OR.Machines.Read` | Reading machine templates and assignments |
| `OR.Robots.Read` | Reading robot accounts for filtering |
| `OR.Jobs.Read` | Fetching job history for duration estimation |

---

## How It Works (Architecture)

```
Browser (app.js)
     │
     │  POST /api/fetch-uipath  (JSON body)
     ▼
Local: server.js          ← you run this
  or
Online: functions/api/fetch-uipath.js   ← Cloudflare runs this
     │
     │  HTTP request with Bearer token
     ▼
UiPath Orchestrator  (cloud.uipath.com  or  your on-prem server)
```

The proxy exists because browsers block direct cross-origin requests to
Orchestrator (CORS). The proxy runs on your machine (local) or Cloudflare's
network (online) — either way it can reach Orchestrator and return the data
to the browser.

**The front-end is identical for both modes.** `app.js`, `styles.css`, and
`index.html` do not change. Only the proxy changes:

| File | Used by |
|---|---|
| `server.js` | Local mode |
| `functions/api/fetch-uipath.js` | Cloudflare Pages |

Both proxy files implement the same API contract, so any change to the
application logic in `app.js` automatically works in both environments.

---

## Project Structure

```
├── index.html                       # App shell — loads React, Babel, and app.js
├── app.js                           # All React components and logic (no build step)
├── styles.css                       # Apollo dark-mode design tokens and styles
├── server.js                        # Local proxy server (Node.js, no dependencies)
├── functions/
│   └── api/
│       └── fetch-uipath.js          # Cloudflare Pages Function (same proxy, cloud)
├── _headers                         # Cloudflare Pages response headers
├── wrangler.jsonc                   # Wrangler config (optional local dev alternative)
└── README.md
```

---

## URL Parameters

All active state is encoded in the URL — copy it to share or bookmark any view.

| Parameter | Values | Description |
|---|---|---|
| `view` | `month` `week` `3day` `day` `timeline` | Active calendar view |
| `days` | integer | Projection window in days (default 7) |
| `tz` | IANA timezone | Display timezone (e.g. `America/New_York`) |
| `hp` | comma-separated names | Hidden processes |
| `hm` | comma-separated names | Hidden machines |
| `hf` | comma-separated IDs | Hidden folders |
| `ht` | comma-separated tags | Hidden tags |

---

## Troubleshooting

**`Network error reaching Orchestrator`**
- Verify the Orchestrator URL in the Connection popover has no trailing slash issues.
- For on-prem: confirm you can `curl https://your-server/odata/Folders` from the
  same machine where `node server.js` is running.
- Self-signed cert? Use `NODE_TLS_REJECT_UNAUTHORIZED=0 node server.js`.

**`401: Token expired or invalid`**
- Your PAT expired. Generate a new one in Orchestrator Preferences.

**`403: Forbidden`**
- Your token does not have the required scopes, or the folder is not accessible
  to the account that owns the token.

**OAuth redirect ends up on a blank page or wrong URL**
- The Redirect URL registered in the External Application must exactly match
  the URL shown in the app's setup box. For local use it will be
  `http://localhost:3000/` — register that exact string in UiPath Admin.

**`Cannot find the target partition (#218)`**
- This occurs with on-prem multi-tenant setups when the wrong tenant name is
  specified. For single-tenant deployments, leave the Tenant field empty.

**Port 3000 is already in use**
```bash
PORT=8080 node server.js
```
Then register `http://localhost:8080/` as the OAuth Redirect URL.
