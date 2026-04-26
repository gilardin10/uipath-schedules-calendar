/**
 * Cloudflare Pages Function — server-side UiPath Orchestrator proxy.
 *
 * Route: POST /api/fetch-uipath
 *
 * The browser sends the user's PAT in the Authorization header so it
 * never travels to third-party CORS proxies.  All Orchestrator requests
 * are made here, server-side, where CORS is irrelevant.
 *
 * Request body (JSON):
 *   action          "schedules" | "jobs"
 *   orchestratorUrl Base URL, e.g. "https://cloud.uipath.com/org"
 *   tenant          Tenant name, e.g. "Default"
 *   folder          Folder / Org-Unit ID (optional)
 *   apiPrefix       "/orchestrator_" for Cloud, "" for on-prem
 *   releaseName     Required only when action === "jobs"
 *
 * Response (JSON):
 *   { ok: true,  value: [...] }   — success
 *   { ok: false, error: "...", status: 4xx }  — failure
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

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request }) {
  // ── 1. Extract PAT ───────────────────────────────────────────────────────
  const authHeader = request.headers.get('Authorization') || '';
  const pat = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!pat) return json({ ok: false, error: 'Missing Authorization header' }, 401);

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Request body must be valid JSON' }, 400); }

  const { action, orchestratorUrl, tenant, folder, apiPrefix, releaseName } = body;

  if (!orchestratorUrl || !tenant || !action) {
    return json({
      ok: false,
      error: 'Missing required fields: orchestratorUrl, tenant, action',
    }, 400);
  }

  // ── 3. Build upstream URL ────────────────────────────────────────────────
  const base   = orchestratorUrl.replace(/\/$/, '');
  const prefix = (apiPrefix || '').replace(/\/$/, '');

  let odataPath, odataParams;

  if (action === 'schedules') {
    odataPath   = '/odata/ProcessSchedules';
    odataParams = {
      '$select': 'Id,Name,StartProcessCron,TimeZoneId,Enabled,ReleaseId,ReleaseName',
      '$filter': 'Enabled eq true',
      '$top':    '500',
    };
  } else if (action === 'jobs') {
    if (!releaseName) return json({ ok: false, error: 'releaseName required for jobs action' }, 400);
    // Escape single-quotes for OData string literals
    const safe  = releaseName.replace(/'/g, "''");
    odataPath   = '/odata/Jobs';
    odataParams = {
      '$filter':  `ReleaseName eq '${safe}'`,
      '$select':  'Id,StartTime,EndTime,State',
      '$orderby': 'StartTime desc',
      '$top':     '10',
    };
  } else {
    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  // OData query strings must NOT encode '$' — URLSearchParams would break them
  const qs = Object.entries(odataParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');

  const upstreamUrl = `${base}/${tenant}${prefix}${odataPath}?${qs}`;

  // ── 4. Call Orchestrator ─────────────────────────────────────────────────
  const upstreamHeaders = {
    'Authorization': `Bearer ${pat}`,
    'Content-Type':  'application/json',
  };
  if (folder) upstreamHeaders['X-UIPATH-OrganizationUnitId'] = String(folder);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (err) {
    return json({ ok: false, error: `Network error reaching Orchestrator: ${err.message}` }, 502);
  }

  // ── 5. Map upstream errors ────────────────────────────────────────────────
  if (!upstreamRes.ok) {
    const { status } = upstreamRes;
    let error;
    if (status === 401) {
      error = '401: Token expired or invalid. Re-enter your Bearer Token.';
    } else if (status === 403) {
      error = '403: Forbidden — check PAT scopes (OR.Execution, OR.Monitoring, OR.Jobs) and folder access.';
    } else if (status === 400) {
      error = '400: Bad Request — verify Orchestrator URL, tenant name, API prefix, and folder ID.';
    } else {
      error = `HTTP ${status} from Orchestrator`;
    }
    return json({ ok: false, error, status }, status);
  }

  // ── 6. Return data ───────────────────────────────────────────────────────
  let data;
  try { data = await upstreamRes.json(); }
  catch { return json({ ok: false, error: 'Orchestrator returned a non-JSON response' }, 502); }

  return json({ ok: true, value: data.value || [] });
}
