#!/usr/bin/env node
/**
 * Local server for UiPath Schedules Calendar.
 *
 * Serves the static front-end (index.html / app.js / styles.css) and
 * proxies POST /api/fetch-uipath to UiPath Orchestrator, bypassing the
 * browser's CORS restrictions.
 *
 * Requirements: Node.js 18+  (uses built-in fetch — no npm install needed)
 * Usage:        node server.js
 * Custom port:  PORT=8080 node server.js
 *
 * On-prem with self-signed TLS cert:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node server.js
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const DIR  = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

// ── Proxy — mirrors functions/api/fetch-uipath.js exactly ────────────────────

async function handleProxy(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'Request body must be valid JSON' });
  }

  const {
    action, orchestratorUrl, folder, releaseName,
    clientId, code, verifier, redirectUri, tokenUrl,
  } = body;

  if (!action) return sendJSON(res, 400, { ok: false, error: 'Missing required field: action' });

  // PKCE authorization-code → token exchange
  if (action === 'pkceExchange') {
    if (!code || !verifier || !clientId || !redirectUri)
      return sendJSON(res, 400, { ok: false, error: 'pkceExchange requires code, verifier, clientId, redirectUri' });

    let tokenRes;
    try {
      tokenRes = await fetch('https://cloud.uipath.com/identity_/connect/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId,
          code, redirect_uri: redirectUri, code_verifier: verifier,
        }).toString(),
      });
    } catch (err) {
      return sendJSON(res, 502, { ok: false, error: `Network error reaching identity server: ${err.message}` });
    }

    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return sendJSON(res, 502, { ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }
    let td;
    try { td = await tokenRes.json(); }
    catch { return sendJSON(res, 502, { ok: false, error: 'Identity server returned a non-JSON response' }); }
    if (!td.access_token)
      return sendJSON(res, 502, { ok: false, error: 'No access_token in identity server response' });
    return sendJSON(res, 200, { ok: true, value: td.access_token });
  }

  // On-prem OAuth: client_credentials → token exchange
  if (action === 'getToken') {
    const { clientId: cId, clientSecret, tenant } = body;
    if (!orchestratorUrl || !cId || !clientSecret)
      return sendJSON(res, 400, { ok: false, error: 'getToken requires orchestratorUrl, clientId, clientSecret' });

    let tokenUrl;
    try {
      const parsed = new URL(orchestratorUrl);
      tokenUrl = parsed.hostname.endsWith('uipath.com')
        ? 'https://cloud.uipath.com/identity_/connect/token'
        : `${parsed.origin}/identity/connect/token`;
    } catch {
      return sendJSON(res, 400, { ok: false, error: 'Invalid orchestratorUrl' });
    }

    const params = {
      grant_type: 'client_credentials',
      client_id: cId,
      client_secret: clientSecret,
      scope: 'OR.Folders.Read OR.Execution.Read OR.Machines.Read OR.Jobs.Read',
    };
    if (tenant) params.acr_values = `tenant:${tenant}`;

    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams(params).toString(),
      });
    } catch (err) {
      return sendJSON(res, 502, { ok: false, error: `Network error reaching identity server: ${err.message}` });
    }

    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return sendJSON(res, 502, { ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }
    let td;
    try { td = await tokenRes.json(); }
    catch { return sendJSON(res, 502, { ok: false, error: 'Identity server returned a non-JSON response' }); }
    if (!td.access_token)
      return sendJSON(res, 502, { ok: false, error: 'No access_token in identity server response' });
    return sendJSON(res, 200, { ok: true, value: td.access_token });
  }

  // On-prem PKCE: authorization-code → token exchange (custom token URL)
  if (action === 'onPremPkceExchange') {
    if (!code || !verifier || !clientId || !redirectUri || !tokenUrl)
      return sendJSON(res, 400, { ok: false, error: 'onPremPkceExchange requires code, verifier, clientId, redirectUri, tokenUrl' });

    let tokenRes;
    try {
      tokenRes = await fetch(tokenUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body:    new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId,
          code, redirect_uri: redirectUri, code_verifier: verifier,
        }).toString(),
      });
    } catch (err) {
      return sendJSON(res, 502, { ok: false, error: `Network error reaching on-prem identity server: ${err.message}` });
    }

    if (!tokenRes.ok) {
      let detail = '';
      try { const t = await tokenRes.text(); detail = t ? ` — ${t.slice(0, 300)}` : ''; } catch (_) {}
      return sendJSON(res, 502, { ok: false, error: `Token endpoint returned HTTP ${tokenRes.status}${detail}` });
    }
    let td;
    try { td = await tokenRes.json(); }
    catch { return sendJSON(res, 502, { ok: false, error: 'Identity server returned a non-JSON response' }); }
    if (!td.access_token)
      return sendJSON(res, 502, { ok: false, error: 'No access_token in identity server response' });
    return sendJSON(res, 200, { ok: true, value: td.access_token });
  }

  // All remaining actions require a Bearer token
  const authHeader = req.headers['authorization'] || '';
  const pat = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!pat) return sendJSON(res, 401, { ok: false, error: 'Missing Authorization header' });

  // OData actions require an orchestratorUrl
  if (!orchestratorUrl)
    return sendJSON(res, 400, { ok: false, error: 'Missing required field: orchestratorUrl' });

  const base = orchestratorUrl.replace(/\/$/, '');
  let odataPath, odataParams;

  if (action === 'schedules') {
    odataPath   = '/odata/ProcessSchedules';
    odataParams = {
      '$filter': 'Enabled eq true',
      '$top':    '500',
    };
  } else if (action === 'folders') {
    odataPath   = '/odata/Folders';
    odataParams = { '$select': 'Id,DisplayName,FullyQualifiedName', '$top': '200' };
  } else if (action === 'jobs') {
    if (!releaseName) return sendJSON(res, 400, { ok: false, error: 'releaseName required for jobs action' });
    if (!/^[\w\s\-\.@:()]+$/.test(releaseName))
      return sendJSON(res, 400, { ok: false, error: 'Invalid release name format' });
    const safe = releaseName.replace(/'/g, "''");
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
  } else if (action === 'robotAccounts') {
    odataPath   = '/odata/Robots/UiPath.Server.Configuration.OData.FindAllAcrossFolders';
    odataParams = { '$top': '500' };
  } else if (action === 'releaseTags') {
    odataPath   = '/odata/Releases';
    odataParams = { '$select': 'Id,Name,Tags', '$top': '500' };
  } else {
    return sendJSON(res, 400, { ok: false, error: `Unknown action: ${action}` });
  }

  const qs = Object.entries(odataParams)
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  const upstreamUrl = `${base}${odataPath}?${qs}`;

  const upstreamHeaders = { 'Authorization': `Bearer ${pat}`, 'Content-Type': 'application/json' };
  if (folder && action !== 'folders' && action !== 'robotAccounts') upstreamHeaders['X-UIPATH-OrganizationUnitId'] = String(folder);

  let upstreamRes;
  try {
    upstreamRes = await fetch(upstreamUrl, { headers: upstreamHeaders });
  } catch (err) {
    return sendJSON(res, 502, { ok: false, error: `Network error reaching Orchestrator: ${err.message}` });
  }

  if (!upstreamRes.ok) {
    const { status } = upstreamRes;
    let detail = '';
    try { const t = await upstreamRes.text(); detail = t ? ` — ${t.slice(0, 200)}` : ''; } catch (_) {}
    let error;
    if      (status === 401) error = '401: Token expired or invalid. Re-authenticate.';
    else if (status === 403) error = `403: Forbidden — ${detail}`;
    else if (status === 400) error = `400: Bad Request — verify Orchestrator URL and folder.${detail}`;
    else                     error = `HTTP ${status} from Orchestrator${detail}`;
    return sendJSON(res, 200, { ok: false, error, status });
  }

  let data;
  try { data = await upstreamRes.json(); }
  catch { return sendJSON(res, 502, { ok: false, error: 'Orchestrator returned a non-JSON response' }); }
  return sendJSON(res, 200, { ok: true, value: data.value || [] });
}

// ── Static file server ────────────────────────────────────────────────────────

function serveStatic(req, res) {
  const urlPath  = req.url.split('?')[0];
  const filePath = path.normalize(path.join(DIR, urlPath === '/' ? 'index.html' : urlPath));

  // Prevent directory traversal
  if (!filePath.startsWith(DIR + path.sep) && filePath !== path.join(DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext  = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // Unknown path → return index.html (handles OAuth redirect back to /?code=...)
      fs.readFile(path.join(DIR, 'index.html'), (err2, html) => {
        if (err2) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ── Main HTTP server ──────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/api/fetch-uipath') {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); res.end(); return; }
    if (req.method === 'POST') {
      try { await handleProxy(req, res); }
      catch (err) { sendJSON(res, 500, { ok: false, error: `Server error: ${err.message}` }); }
      return;
    }
    res.writeHead(405); res.end('Method not allowed');
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('  UiPath Schedules Calendar');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Open the URL above in your browser, then click Connection to authenticate.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});
