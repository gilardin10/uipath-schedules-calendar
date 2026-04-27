/**
 * Cloudflare Pages Function — server-side UiPath Orchestrator proxy.
 *
 * Route: POST /api/fetch-uipath
 *
 * Request body (JSON):
 *   action          "schedules" | "jobs" | "folders" | "machines" | "releaseTags" | "getToken"
 *   orchestratorUrl Full Orchestrator base URL including tenant + API prefix, e.g.
 *                   "https://cloud.uipath.com/org/Default/orchestrator_"
 *   folder          Folder / Org-Unit ID (optional header value)
 *   releaseName     Required only when action === "jobs"
 *   clientId        Required only when action === "getToken"
 *   clientSecret    Required only when action === "getToken"
 *
 * Response (JSON):
 *   { ok: true,  value: [...] }   (or { ok: true, value: "<access_token>" } for getToken)
 *   { ok: false, error: "...", status: 4xx }
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request }) {
  // ── 1. Parse body first (getToken does not need a PAT) ───────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Request body must be valid JSON' }, 400); }

  const { action, orchestratorUrl, folder, releaseName, clientId, clientSecret } = body;

  if (!action) {
    return json({ ok: false, error: 'Missing required field: action' }, 400);
  }

  // ── 2. getToken: exchange OAuth2 client credentials for a bearer token ───────
  if (action === 'getToken') {
    if (!orchestratorUrl || !clientId || !clientSecret) {
      return json({ ok: false, error: 'getToken requires orchestratorUrl, clientId, clientSecret' }, 400);
    }

    // Derive identity server URL from the Orchestrator URL
    // Cloud: *.uipath.com → https://account.uipath.com/oauth/token
    // On-prem: https://my-server/... → https://my-server/identity/connect/token
    let tokenUrl;
    try {
      const parsed = new URL(orchestratorUrl);
      tokenUrl = parsed.hostname.endsWith('uipath.com')
        ? 'https://account.uipath.com/oauth/token'
        : `${parsed.origin}/identity/connect/token`;
    } catch {
      return json({ ok: false, error: 'Invalid orchestratorUrl' }, 400);
    }

    const formBody = new URLSearchParams({
      grant_type:    'client_credentials',
      client_id:     clientId,
      client_secret: clientSecret,
    });
    // UiPath Cloud requires scope; on-prem identity servers accept it but don't require it
    if (orchestratorUrl.includes('uipath.com')) {
      formBody.set('scope', 'OR.Default');
    }

    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    formBody.toString(),
      });
    } catch (err) {
      return json({ ok: false, error: `Network error reaching identity server: ${err.message}` }, 502);
    }

    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return json({ ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }

    let tokenData;
    try { tokenData = await tokenRes.json(); }
    catch { return json({ ok: false, error: 'Identity server returned a non-JSON response' }, 502); }

    if (!tokenData.access_token) {
      return json({ ok: false, error: 'No access_token in identity server response' }, 502);
    }

    return json({ ok: true, value: tokenData.access_token });
  }

  // ── 3. All other actions require a PAT in the Authorization header ───────────
  const authHeader = request.headers.get('Authorization') || '';
  const pat = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!pat) return json({ ok: false, error: 'Missing Authorization header' }, 401);

  if (!orchestratorUrl) {
    return json({ ok: false, error: 'Missing required field: orchestratorUrl' }, 400);
  }

  // ── 4. Build upstream URL ─────────────────────────────────────────────────────
  // orchestratorUrl already includes org/tenant/prefix, e.g.
  // https://cloud.uipath.com/myorg/Default/orchestrator_
  const base = orchestratorUrl.replace(/\/$/, '');

  let odataPath, odataParams;

  if (action === 'schedules') {
    odataPath   = '/odata/ProcessSchedules';
    odataParams = {
      '$select': 'Id,Name,StartProcessCron,TimeZoneId,Enabled,ReleaseId,ReleaseName,InputArguments',
      '$filter': 'Enabled eq true',
      '$top':    '500',
    };
  } else if (action === 'folders') {
    odataPath   = '/odata/Folders';
    odataParams = {
      '$select': 'Id,DisplayName,FullyQualifiedName',
      '$top':    '200',
    };
  } else if (action === 'jobs') {
    if (!releaseName) return json({ ok: false, error: 'releaseName required for jobs action' }, 400);
    const safe  = releaseName.replace(/'/g, "''");
    odataPath   = '/odata/Jobs';
    odataParams = {
      '$filter':  `ReleaseName eq '${safe}'`,
      '$select':  'Id,StartTime,EndTime,State,InputArguments',
      '$orderby': 'StartTime desc',
      '$top':     '10',
    };
  } else if (action === 'machines') {
    odataPath   = '/odata/Machines';
    odataParams = {
      '$select': 'Id,Name,Type,NonProductionSlots',
      '$top':    '200',
    };
  } else if (action === 'releaseTags') {
    odataPath   = '/odata/Releases';
    odataParams = {
      '$select': 'Id,Name,Tags',
      '$top':    '500',
    };
  } else {
    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  // OData query strings must NOT encode '$' — URLSearchParams would break them
  const qs = Object.entries(odataParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const upstreamUrl = `${base}${odataPath}?${qs}`;

  // ── 5. Call Orchestrator ──────────────────────────────────────────────────────
  const upstreamHeaders = {
    'Authorization': `Bearer ${pat}`,
    'Content-Type':  'application/json',
  };
  if (folder && action !== 'folders') upstreamHeaders['X-UIPATH-OrganizationUnitId'] = String(folder);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (err) {
    return json({ ok: false, error: `Network error reaching Orchestrator: ${err.message}` }, 502);
  }

  // ── 6. Map upstream errors ────────────────────────────────────────────────────
  // Always return HTTP 200 from our function so Cloudflare's edge never strips
  // the response body. The real Orchestrator status is embedded in the JSON.
  if (!upstreamRes.ok) {
    const { status } = upstreamRes;
    let detail = '';
    try { const t = await upstreamRes.text(); detail = t ? ` — ${t.slice(0, 200)}` : ''; } catch (_) {}
    let error;
    if (status === 401) {
      error = '401: Token expired or invalid. Re-enter your Bearer Token.';
    } else if (status === 403) {
      error = '403: Forbidden — check PAT scopes (OR.Execution, OR.Monitoring, OR.Jobs) and folder access.';
    } else if (status === 400) {
      error = `400: Bad Request — verify Orchestrator URL, tenant name, API prefix, and folder ID.${detail}`;
    } else {
      error = `HTTP ${status} from Orchestrator${detail}`;
    }
    return json({ ok: false, error, status });
  }

  // ── 7. Return data ────────────────────────────────────────────────────────────
  let data;
  try { data = await upstreamRes.json(); }
  catch { return json({ ok: false, error: 'Orchestrator returned a non-JSON response' }, 502); }

  return json({ ok: true, value: data.value || [] });
}
