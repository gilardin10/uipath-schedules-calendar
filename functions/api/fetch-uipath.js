/**
 * Cloudflare Pages Function — server-side UiPath Orchestrator proxy.
 *
 * Route: POST /api/fetch-uipath
 *
 * Actions (sent in JSON body):
 *   pkceExchange  Exchange PKCE auth code for access token (no prior token needed)
 *   getToken      Exchange client_credentials for bearer token (no prior token needed)
 *   listOrgs      List UiPath Cloud organizations (needs Authorization header)
 *   schedules | jobs | folders | machines | releaseTags
 *                 Standard Orchestrator OData calls (needs Authorization header + orchestratorUrl)
 *
 * Security: tokens are never logged.
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
  // ── 1. Parse body first — some actions need no prior token ────────────────
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'Request body must be valid JSON' }, 400); }

  const {
    action, orchestratorUrl, folder, releaseName,
    clientId, clientSecret, code, verifier, redirectUri,
  } = body;

  if (!action) return json({ ok: false, error: 'Missing required field: action' }, 400);

  // ── 2. PKCE authorization-code exchange (no prior token required) ─────────
  if (action === 'pkceExchange') {
    if (!code || !verifier || !clientId || !redirectUri) {
      return json({ ok: false, error: 'pkceExchange requires code, verifier, clientId, redirectUri' }, 400);
    }
    let tokenRes;
    try {
      tokenRes = await fetch('https://cloud.uipath.com/identity_/connect/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type:    'authorization_code',
          client_id:     clientId,
          code,
          redirect_uri:  redirectUri,
          code_verifier: verifier,
        }).toString(),
      });
    } catch (err) {
      return json({ ok: false, error: `Network error reaching identity server: ${err.message}` }, 502);
    }
    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return json({ ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }
    let td;
    try { td = await tokenRes.json(); }
    catch { return json({ ok: false, error: 'Identity server returned a non-JSON response' }, 502); }
    if (!td.access_token) return json({ ok: false, error: 'No access_token in identity server response' }, 502);
    return json({ ok: true, value: td.access_token });
  }

  // ── 3. getToken: OAuth2 client_credentials (no prior token required) ──────
  if (action === 'getToken') {
    if (!orchestratorUrl || !clientId || !clientSecret) {
      return json({ ok: false, error: 'getToken requires orchestratorUrl, clientId, clientSecret' }, 400);
    }
    
  let tokenUrl;
  try {
      const parsed = new URL(orchestratorUrl);
      if (parsed.hostname.endsWith('uipath.com')) {
          // Extract the Org Name from: https://cloud.uipath.com/ORG_NAME/TENANT_NAME/
          const pathParts = parsed.pathname.split('/').filter(p => p);
          const orgName = pathParts[0]; 
          
          // If we found an Org Name, use the Org-specific Identity endpoint
          tokenUrl = orgName 
              ? `https://cloud.uipath.com/${orgName}/identity_/connect/token`
              : 'https://cloud.uipath.com/identity_/connect/token';
      } else {
          tokenUrl = `${parsed.origin}/identity/connect/token`;
      }
  } catch {
      return json({ ok: false, error: 'Invalid orchestratorUrl' }, 400);
  }

    const formBody = new URLSearchParams({ 
      grant_type: 'client_credentials', 
      client_id: clientId, 
      client_secret: clientSecret,
      // Use specific scopes instead of OR.Default
      scope: 'OR.Folders.Read OR.Execution.Read OR.Machines.Read OR.Users.Read OR.Queues.Read OR.Assets.Read'    
    });

    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formBody.toString(),
      });
    } catch (err) {
      return json({ ok: false, error: `Network error reaching identity server: ${err.message}` }, 502);
    }
    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return json({ ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }
    let td;
    try { td = await tokenRes.json(); }
    catch { return json({ ok: false, error: 'Identity server returned a non-JSON response' }, 502); }
    if (!td.access_token) return json({ ok: false, error: 'No access_token in identity server response' }, 502);
    return json({ ok: true, value: td.access_token });
  }

  // ── 4. All remaining actions require a valid Authorization header ─────────
  const authHeader = request.headers.get('Authorization') || '';
  const pat = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!pat) return json({ ok: false, error: 'Missing Authorization header' }, 401);

  // ── 5. listOrgs: UiPath Cloud account/org discovery ───────────────────────
  if (action === 'listOrgs') {
    let res;
    try {
      res = await fetch('https://cloud.uipath.com/api/account', {
        headers: { 'Authorization': `Bearer ${pat}` },
      });
    } catch (err) {
      return json({ ok: false, error: `Network error: ${err.message}` }, 502);
    }
    if (!res.ok) {
      let detail = '';
      try { const t = await res.text(); detail = t ? ` — ${t.slice(0, 200)}` : ''; } catch (_) {}
      return json({ ok: false, error: `Accounts API returned HTTP ${res.status}${detail}` });
    }
    let data;
    try { data = await res.json(); }
    catch { return json({ ok: false, error: 'Accounts API returned a non-JSON response' }, 502); }
    return json({ ok: true, value: data.accounts || data.value || [] });
  }

  // ── 6. OData actions require orchestratorUrl ──────────────────────────────
  if (!orchestratorUrl) {
    return json({ ok: false, error: 'Missing required field: orchestratorUrl' }, 400);
  }
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
    odataParams = { '$select': 'Id,Name,Type,NonProductionSlots', '$top': '200' };
  } else if (action === 'releaseTags') {
    odataPath   = '/odata/Releases';
    odataParams = { '$select': 'Id,Name,Tags', '$top': '500' };
  } else {
    return json({ ok: false, error: `Unknown action: ${action}` }, 400);
  }

  const qs = Object.entries(odataParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const upstreamUrl = `${base}${odataPath}?${qs}`;

  const upstreamHeaders = { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' };
  if (folder && action !== 'folders') upstreamHeaders['X-UIPATH-OrganizationUnitId'] = String(folder);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (err) {
    return json({ ok: false, error: `Network error reaching Orchestrator: ${err.message}` }, 502);
  }

  if (!upstreamRes.ok) {
    const { status } = upstreamRes;
    let detail = '';
    try { const t = await upstreamRes.text(); detail = t ? ` — ${t.slice(0, 200)}` : ''; } catch (_) {}
    let error;
    if (status === 401)      error = '401: Token expired or invalid. Re-authenticate.';
    else if (status === 403) error = `403: Forbidden — Error: ${detail}`;
    else if (status === 400) error = `400: Bad Request — verify Orchestrator URL, tenant, and folder ID.${detail}`;
    else                     error = `HTTP ${status} from Orchestrator${detail}`;
    return json({ ok: false, error, status });
  }

  let data;
  try { data = await upstreamRes.json(); }
  catch { return json({ ok: false, error: 'Orchestrator returned a non-JSON response' }, 502); }
  return json({ ok: true, value: data.value || [] });
}
