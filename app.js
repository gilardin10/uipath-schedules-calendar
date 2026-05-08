// UiPath Job Schedules – Apollo Dark Mode
// React 18 + Babel standalone + cron-parser + Lucide

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── Palette for process color-coding (cycles) ───────────────────────────────
// Each entry: [accent, textLight] — accent for borders/bg tint, textLight for readable text on white
const PALETTE_PAIRS = [
  ['#D94F04','#B84200'], ['#0080B8','#006A99'], ['#6248C8','#5038B0'], ['#1A9E6E','#14845B'], ['#CC9200','#A87800'],
  ['#C94070','#A83460'], ['#0BAAAA','#089090'], ['#D07830','#B06428'], ['#7A6CC8','#6458B0'], ['#2EB88C','#1E9E76'],
  ['#C06080','#A04868'], ['#4A90CC','#3878B0'], ['#C8A830','#A89028'], ['#5840B0','#4830A0'], ['#1A9E80','#14846C'],
];

function colorForIndex(i) { return PALETTE_PAIRS[i % PALETTE_PAIRS.length][0]; }
function textColorForIndex(i) { return PALETTE_PAIRS[i % PALETTE_PAIRS.length][1]; }

// ─── localStorage / sessionStorage helpers ────────────────────────────────────
const LS_KEYS = {
  orchestratorUrl: 'usp_orch_url',
  theme:       'usp_theme',
  uiTz:        'usp_ui_tz',
  durMin:      'usp_dur_min',
  authMode:    'usp_auth_mode',
  pkceClientId:'usp_pkce_cid',
  onPremClientId:'usp_op_cid',
  hiddenProcs:    'usp_hidden_procs',
  hiddenMachines: 'usp_hidden_machines',
  hiddenFolders:  'usp_hidden_folders',
  hiddenTags:     'usp_hidden_tags',
  hiddenRobots:   'usp_hidden_robots',
};
const SS_KEY               = 'usp_token';
const SS_KEY_PKCE_VERIFIER = 'usp_pkce_cv';
const SS_KEY_PKCE_STATE    = 'usp_pkce_state';

function validateTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  catch (_) { return null; }
}

function loadHiddenSet(lsKey) {
  try { const v = localStorage.getItem(lsKey); return v ? new Set(JSON.parse(v)) : new Set(); }
  catch { return new Set(); }
}

// Median duration cache: { [scheduleId]: { ms, at } }
const MEDIAN_CACHE_KEY = 'usp_medians';
const MEDIAN_TTL_MS    = 6 * 60 * 60 * 1000; // 6 hours
function loadMedianCache() {
  try { return JSON.parse(localStorage.getItem(MEDIAN_CACHE_KEY) || '{}'); } catch { return {}; }
}
function saveMedianCache(cache) {
  try {
    const json = JSON.stringify(cache);
    if (json.length > 1_000_000) {
      // Prune to 500 most recent entries
      const sorted = Object.entries(cache).sort((a, b) => b[1].at - a[1].at);
      cache = Object.fromEntries(sorted.slice(0, 500));
    }
    localStorage.setItem(MEDIAN_CACHE_KEY, JSON.stringify(cache));
  } catch (_) {}
}

function loadConfig() {
  const stored       = localStorage.getItem(LS_KEYS.orchestratorUrl) || '';
  const authMode     = localStorage.getItem(LS_KEYS.authMode)     || 'pat';
  const pkceClientId = localStorage.getItem(LS_KEYS.pkceClientId) || '';
  const onPremClientId = localStorage.getItem(LS_KEYS.onPremClientId) || '';
  const token        = sessionStorage.getItem(SS_KEY)             || '';
  if (stored) {
    return { orchestratorUrl: stored, token, authMode, pkceClientId, onPremClientId };
  }
  // Migrate from old 3-field format
  const url    = localStorage.getItem('usp_url')    || '';
  const tenant = localStorage.getItem('usp_tenant') || 'Default';
  const prefix = localStorage.getItem('usp_prefix') ?? '/orchestrator_';
  if (url && tenant) {
    return { orchestratorUrl: `${url.replace(/\/$/, '')}/${tenant}${prefix}`, token, authMode, pkceClientId, onPremClientId };
  }
  return { orchestratorUrl: '', token: '', authMode: 'pat', pkceClientId: '', onPremClientId: '' };
}
function saveConfig({ orchestratorUrl, token, authMode, pkceClientId, onPremClientId }) {
  localStorage.setItem(LS_KEYS.orchestratorUrl, orchestratorUrl || '');
  localStorage.setItem(LS_KEYS.authMode, authMode || 'pat');
  if (pkceClientId !== undefined) localStorage.setItem(LS_KEYS.pkceClientId, pkceClientId);
  if (onPremClientId !== undefined) localStorage.setItem(LS_KEYS.onPremClientId, onPremClientId);
  sessionStorage.setItem(SS_KEY, token || '');
}

// ─── API helpers — calls our Cloudflare Pages Function proxy ─────────────────
async function proxyFetch(cfg, action, extra = {}) {
  const res = await fetch('/api/fetch-uipath', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      action,
      orchestratorUrl: cfg.orchestratorUrl,
      folder:          cfg.folder,
      ...extra,
    }),
  });

  // Handle 401 — token expired
  if (res.status === 401) {
    sessionStorage.removeItem(SS_KEY);
    throw new Error('Session expired — please re-authenticate via Connection.');
  }

  // Read as text first so we control the parse error message
  const text = await res.text();
  if (!text) {
    throw new Error(
      `Empty response from /api/fetch-uipath (HTTP ${res.status}). ` +
      `Ensure the Cloudflare Pages Function is deployed and the route is correct.`
    );
  }

  let data;
  try { data = JSON.parse(text); }
  catch {
    throw new Error(`Non-JSON response from proxy (HTTP ${res.status}): ${text.slice(0, 120)}`);
  }

  // Upstream 401 forwarded by proxy
  if (data.status === 401 || (res.status === 200 && data.error && /unauthorized|401/i.test(data.error))) {
    sessionStorage.removeItem(SS_KEY);
    throw new Error('Session expired — please re-authenticate via Connection.');
  }

  if (!data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.value;
}

async function fetchSchedules(cfg)                       { return proxyFetch(cfg, 'schedules'); }
async function fetchJobsForSchedule(cfg, releaseName)    { return proxyFetch(cfg, 'jobs', { releaseName }); }

// ─── PKCE helpers ─────────────────────────────────────────────────────────────
function genCodeVerifier() {
  const arr = new Uint8Array(96);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function genPkceState(prefix) {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return prefix + '_' + Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}
async function genCodeChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function startPkceFlow(clientId) {
  const verifier  = genCodeVerifier();
  const challenge = await genCodeChallenge(verifier);
  const state     = genPkceState('usp');
  sessionStorage.setItem(SS_KEY_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(SS_KEY_PKCE_STATE, state);
  localStorage.setItem(LS_KEYS.pkceClientId, clientId);
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const p = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    scope:                 'openid profile offline_access OR.Folders.Read OR.Execution.Read OR.Machines.Read OR.Jobs.Read',
    redirect_uri:          redirectUri,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });
  window.location.href = `https://cloud.uipath.com/identity_/connect/authorize?${p}`;
}

async function startOnPremPkceFlow(clientId, orchestratorUrl, tenant) {
  const verifier  = genCodeVerifier();
  const challenge = await genCodeChallenge(verifier);
  const state     = genPkceState('usp_onprem');
  sessionStorage.setItem(SS_KEY_PKCE_VERIFIER, verifier);
  sessionStorage.setItem(SS_KEY_PKCE_STATE, state);
  localStorage.setItem(LS_KEYS.onPremClientId, clientId);
  localStorage.setItem('usp_onprem_mode', '1');
  const origin = new URL(orchestratorUrl).origin;
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const p = new URLSearchParams({
    response_type:         'code',
    client_id:             clientId,
    scope:                 'openid profile offline_access',
    redirect_uri:          redirectUri,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });
  if (tenant) p.set('acr_values', `tenant:${tenant}`);
  window.location.href = `${origin}/identity/connect/authorize?${p}`;
}

async function onPremPkceExchangeCode(code, clientId, verifier, orchestratorUrl) {
  const origin = new URL(orchestratorUrl).origin;
  const tokenUrl = `${origin}/identity/connect/token`;
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const res = await fetch('/api/fetch-uipath', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'onPremPkceExchange', code, clientId, verifier, redirectUri, tokenUrl }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from proxy: ${text.slice(0, 120)}`); }
  if (!data.ok) throw new Error(data.error || 'On-prem PKCE exchange failed');
  return data.value;
}

async function pkceExchangeCode(code, clientId, verifier) {
  const redirectUri = `${window.location.origin}${window.location.pathname}`;
  const res = await fetch('/api/fetch-uipath', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'pkceExchange', code, clientId, verifier, redirectUri }),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`Non-JSON response from proxy: ${text.slice(0, 120)}`); }
  if (!data.ok) throw new Error(data.error || 'PKCE exchange failed');
  return data.value;
}

function medianDurationMs(jobs, fallbackMs = 5 * 60 * 1000) {
  const durations = jobs
    .filter(j => j.StartTime && j.EndTime && j.State === 'Successful')
    .map(j => new Date(j.EndTime) - new Date(j.StartTime))
    .filter(d => d > 0);
  if (!durations.length) return fallbackMs;
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
}

function parseInputArgs(raw) {
  if (!raw) return null;
  try {
    const str = typeof raw === 'string' ? raw : JSON.stringify(raw);
    if (str.length > 10000) return null; // cap at 10KB
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch { return null; }
}

// ─── Windows TZ name → IANA mapping ──────────────────────────────────────────
const WIN_TO_IANA = {
  'Dateline Standard Time':'Etc/GMT+12','UTC-11':'Etc/GMT+11',
  'Aleutian Standard Time':'America/Adak','Hawaiian Standard Time':'Pacific/Honolulu',
  'Marquesas Standard Time':'Pacific/Marquesas','Alaskan Standard Time':'America/Anchorage',
  'UTC-09':'Etc/GMT+9','Pacific Standard Time (Mexico)':'America/Santa_Isabel',
  'UTC-08':'Etc/GMT+8','Pacific Standard Time':'America/Los_Angeles',
  'US Mountain Standard Time':'America/Phoenix','Mountain Standard Time (Mexico)':'America/Chihuahua',
  'Mountain Standard Time':'America/Denver','Central America Standard Time':'America/Guatemala',
  'Central Standard Time':'America/Chicago','Easter Island Standard Time':'Pacific/Easter',
  'Central Standard Time (Mexico)':'America/Mexico_City','Canada Central Standard Time':'America/Regina',
  'SA Pacific Standard Time':'America/Bogota','Eastern Standard Time (Mexico)':'America/Cancun',
  'Eastern Standard Time':'America/New_York','Haiti Standard Time':'America/Port-au-Prince',
  'Cuba Standard Time':'America/Havana','US Eastern Standard Time':'America/Indianapolis',
  'Turks And Caicos Standard Time':'America/Grand_Turk','Paraguay Standard Time':'America/Asuncion',
  'Atlantic Standard Time':'America/Halifax','Venezuela Standard Time':'America/Caracas',
  'Central Brazilian Standard Time':'America/Cuiaba','SA Western Standard Time':'America/La_Paz',
  'Pacific SA Standard Time':'America/Santiago','Newfoundland Standard Time':'America/St_Johns',
  'Tocantins Standard Time':'America/Araguaina','E. South America Standard Time':'America/Sao_Paulo',
  'SA Eastern Standard Time':'America/Cayenne','Argentina Standard Time':'America/Buenos_Aires',
  'Greenland Standard Time':'America/Godthab','Montevideo Standard Time':'America/Montevideo',
  'Magallanes Standard Time':'America/Punta_Arenas','Saint Pierre Standard Time':'America/Miquelon',
  'Bahia Standard Time':'America/Bahia','UTC-02':'Etc/GMT+2','Azores Standard Time':'Atlantic/Azores',
  'Cape Verde Standard Time':'Atlantic/Cape_Verde','UTC':'UTC',
  'GMT Standard Time':'Europe/London','Greenwich Standard Time':'Atlantic/Reykjavik',
  'Sao Tome Standard Time':'Africa/Sao_Tome','Morocco Standard Time':'Africa/Casablanca',
  'W. Europe Standard Time':'Europe/Berlin','Central Europe Standard Time':'Europe/Budapest',
  'Romance Standard Time':'Europe/Paris','Central European Standard Time':'Europe/Warsaw',
  'W. Central Africa Standard Time':'Africa/Lagos','Jordan Standard Time':'Asia/Amman',
  'GTB Standard Time':'Europe/Bucharest','Middle East Standard Time':'Asia/Beirut',
  'Egypt Standard Time':'Africa/Cairo','E. Europe Standard Time':'Asia/Nicosia',
  'Syria Standard Time':'Asia/Damascus','West Bank Standard Time':'Asia/Hebron',
  'South Africa Standard Time':'Africa/Johannesburg','FLE Standard Time':'Europe/Kiev',
  'Israel Standard Time':'Asia/Jerusalem','Kaliningrad Standard Time':'Europe/Kaliningrad',
  'Sudan Standard Time':'Africa/Khartoum','Libya Standard Time':'Africa/Tripoli',
  'Namibia Standard Time':'Africa/Windhoek','Arabic Standard Time':'Asia/Baghdad',
  'Turkey Standard Time':'Europe/Istanbul','Arab Standard Time':'Asia/Riyadh',
  'Belarus Standard Time':'Europe/Minsk','Russian Standard Time':'Europe/Moscow',
  'E. Africa Standard Time':'Africa/Nairobi','Iran Standard Time':'Asia/Tehran',
  'Arabian Standard Time':'Asia/Dubai','Astrakhan Standard Time':'Europe/Astrakhan',
  'Azerbaijan Standard Time':'Asia/Baku','Russia Time Zone 3':'Europe/Samara',
  'Mauritius Standard Time':'Indian/Mauritius','Saratov Standard Time':'Europe/Saratov',
  'Georgian Standard Time':'Asia/Tbilisi','Volgograd Standard Time':'Europe/Volgograd',
  'Caucasus Standard Time':'Asia/Yerevan','Afghanistan Standard Time':'Asia/Kabul',
  'West Asia Standard Time':'Asia/Tashkent','Ekaterinburg Standard Time':'Asia/Yekaterinburg',
  'Pakistan Standard Time':'Asia/Karachi','Qyzylorda Standard Time':'Asia/Qyzylorda',
  'India Standard Time':'Asia/Calcutta','Sri Lanka Standard Time':'Asia/Colombo',
  'Nepal Standard Time':'Asia/Katmandu','Central Asia Standard Time':'Asia/Almaty',
  'Bangladesh Standard Time':'Asia/Dhaka','Omsk Standard Time':'Asia/Omsk',
  'Myanmar Standard Time':'Asia/Rangoon','SE Asia Standard Time':'Asia/Bangkok',
  'Altai Standard Time':'Asia/Barnaul','W. Mongolia Standard Time':'Asia/Hovd',
  'N. Central Asia Standard Time':'Asia/Novosibirsk','Tomsk Standard Time':'Asia/Tomsk',
  'China Standard Time':'Asia/Shanghai','North Asia Standard Time':'Asia/Krasnoyarsk',
  'Singapore Standard Time':'Asia/Singapore','W. Australia Standard Time':'Australia/Perth',
  'Taipei Standard Time':'Asia/Taipei','Ulaanbaatar Standard Time':'Asia/Ulaanbaatar',
  'North Asia East Standard Time':'Asia/Irkutsk','Japan Standard Time':'Asia/Tokyo',
  'Korea Standard Time':'Asia/Seoul','Transbaikal Standard Time':'Asia/Chita',
  'Tokyo Standard Time':'Asia/Tokyo','Yakutsk Standard Time':'Asia/Yakutsk',
  'Cen. Australia Standard Time':'Australia/Adelaide','AUS Central Standard Time':'Australia/Darwin',
  'E. Australia Standard Time':'Australia/Brisbane','AUS Eastern Standard Time':'Australia/Sydney',
  'West Pacific Standard Time':'Pacific/Port_Moresby','Tasmania Standard Time':'Australia/Hobart',
  'Vladivostok Standard Time':'Asia/Vladivostok','Lord Howe Standard Time':'Australia/Lord_Howe',
  'Bougainville Standard Time':'Pacific/Bougainville','Russia Time Zone 10':'Asia/Srednekolymsk',
  'Magadan Standard Time':'Asia/Magadan','Norfolk Standard Time':'Pacific/Norfolk',
  'Sakhalin Standard Time':'Asia/Sakhalin','Central Pacific Standard Time':'Pacific/Guadalcanal',
  'Russia Time Zone 11':'Asia/Kamchatka','New Zealand Standard Time':'Pacific/Auckland',
  'UTC+12':'Etc/GMT-12','Fiji Standard Time':'Pacific/Fiji',
  'Chatham Islands Standard Time':'Pacific/Chatham','UTC+13':'Etc/GMT-13',
  'Tonga Standard Time':'Pacific/Tongatapu','Samoa Standard Time':'Pacific/Apia',
  'Line Islands Standard Time':'Pacific/Kiritimati',
};

function toIanaTimezone(tz) {
  if (!tz) return null;
  if (WIN_TO_IANA[tz]) return WIN_TO_IANA[tz];
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; }
  catch (_) { console.warn('[USV] Unknown timezone:', tz); return null; }
}

function normalizeQuartzCron(expr) {
  if (!expr) return null;
  let parts = expr.trim().split(/\s+/);
  if (parts.length === 7) parts = parts.slice(0, 6); // strip year field
  if (parts.length < 5 || parts.length > 6) {
    console.warn('[USV] Unexpected cron field count', parts.length, ':', expr);
    return null;
  }
  parts = parts.map(p => p === '?' ? '*' : p);
  const joined = parts.join(' ');
  if (/[LW#]/.test(joined)) {
    console.warn('[USV] Unsupported Quartz modifier (L/W/#), skipping:', expr);
    return null;
  }
  return joined;
}

// ─── CRON → human-readable description ───────────────────────────────────────
function cronToHuman(cronExpr) {
  const norm = normalizeQuartzCron(cronExpr);
  if (!norm) return null;
  const parts = norm.split(' ');
  // Support 5-field (min hour dom month dow) or 6-field (sec min hour dom month dow)
  const [min, hour, dom, month, dow] = parts.length === 6 ? parts.slice(1) : parts;

  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function fmt12(h, m) {
    const hN = parseInt(h, 10), mN = parseInt(m, 10) || 0;
    return `${hN % 12 || 12}:${String(mN).padStart(2,'0')} ${hN >= 12 ? 'PM' : 'AM'}`;
  }
  const isFixed = s => /^\d+$/.test(s);
  const isStep  = s => /^\*\/\d+$/.test(s);

  // Every N minutes
  if (isStep(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(min.slice(2), 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }
  // Every N hours (at :00)
  if (min === '0' && isStep(hour) && dom === '*' && month === '*' && dow === '*') {
    const n = parseInt(hour.slice(2), 10);
    return `Every ${n} hour${n !== 1 ? 's' : ''}`;
  }
  // Hourly at :mm
  if (isFixed(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return min === '0' ? 'Every hour' : `Every hour at :${String(parseInt(min, 10)).padStart(2,'0')}`;
  }
  // Daily at time
  if (isFixed(min) && isFixed(hour) && dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${fmt12(hour, min)}`;
  }
  // Weekdays
  if (isFixed(min) && isFixed(hour) && dom === '*' && month === '*' && (dow === '1-5' || dow === 'MON-FRI')) {
    return `Weekdays at ${fmt12(hour, min)}`;
  }
  // Weekends
  if (isFixed(min) && isFixed(hour) && dom === '*' && month === '*' && (dow === '0,6' || dow === '6,0' || dow === 'SAT,SUN')) {
    return `Weekends at ${fmt12(hour, min)}`;
  }
  // Single day of week
  if (isFixed(min) && isFixed(hour) && dom === '*' && month === '*' && /^[0-6]$/.test(dow)) {
    return `Every ${DAYS[parseInt(dow, 10)]} at ${fmt12(hour, min)}`;
  }
  // Multiple days of week (comma list)
  if (isFixed(min) && isFixed(hour) && dom === '*' && month === '*' && /^\d+(?:,\d+)+$/.test(dow)) {
    const names = dow.split(',').map(d => DAYS[parseInt(d, 10)]).join(', ');
    return `${names} at ${fmt12(hour, min)}`;
  }
  // Monthly on specific day
  if (isFixed(min) && isFixed(hour) && isFixed(dom) && month === '*' && dow === '*') {
    return `Monthly on day ${dom} at ${fmt12(hour, min)}`;
  }
  return null;
}

// ─── CRON projection (uses Croner UMD global `Cron`) ─────────────────────────
function projectSchedule(cronExpr, tzId, days, medianMs, uiTimezone) {
  const results = [];
  const norm = normalizeQuartzCron(cronExpr);
  if (!norm) return results;
  try {
    if (typeof Cron === 'undefined') return results;
    // Start from beginning of today so all of today's schedules are shown
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const end = new Date(startOfDay.getTime() + days * 86400000);
    const opts = { startAt: startOfDay, stopAt: end };
    const ianaZone = toIanaTimezone(tzId) || toIanaTimezone(uiTimezone);
    if (ianaZone) opts.timezone = ianaZone;
    const job = Cron(norm, opts);
    const dates = job.nextRuns(2000, startOfDay);
    for (const start of dates) {
      if (start > end) break;
      results.push({ start, end: new Date(start.getTime() + medianMs) });
    }
  } catch (e) {
    console.warn('[USV] projectSchedule error:', e.message, '| cron:', cronExpr, '→', norm);
  }
  return results;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function fmtTime(d, tz) {
  const opts = { hour: '2-digit', minute: '2-digit' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleTimeString([], opts);
}
function fmtDate(d, tz) {
  const opts = { month: 'short', day: 'numeric' };
  if (tz) opts.timeZone = tz;
  return d.toLocaleDateString([], opts);
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s/60)}m`;
  return `${(s/3600).toFixed(1)}h`;
}
// Returns a stable string key "Y-M0-D" for a Date in the given IANA timezone (M0 = 0-indexed month)
function dayKey(d, tz) {
  if (!tz) return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const s = d.toLocaleDateString('sv-SE', { timeZone: tz }); // "YYYY-MM-DD"
  const [y, m, day] = s.split('-').map(Number);
  return `${y}-${m - 1}-${day}`;
}
function sameDay(a, b, tz) {
  return dayKey(a, tz) === dayKey(b, tz);
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addDays(d, n)   { return new Date(d.getTime() + n * 86400000); }

// Returns 0-100 percentage position within a 24-hour day for a given timestamp
function dayTimeToPct(d, tz) {
  try {
    const t = d.toLocaleTimeString('sv-SE', { timeZone: tz || undefined });
    const [h, m, s] = t.split(':').map(Number);
    return ((h * 3600 + m * 60 + (s || 0)) / 86400) * 100;
  } catch (_) {
    return ((d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400) * 100;
  }
}

// Returns % for the "now" line if today == refDay, else null
function nowDayPct(refDay, tz) {
  const today = new Date();
  if (!sameDay(today, refDay, tz)) return null;
  return dayTimeToPct(today, tz);
}

// Greedy lane assignment for Gantt rows (same algorithm as column layout but horizontal)
function computeTimelineLanes(events) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.occurrence.start - b.occurrence.start);
  const laneEnds = [];
  const assignments = sorted.map(ev => {
    let lane = laneEnds.findIndex(end => ev.occurrence.start >= end);
    if (lane === -1) lane = laneEnds.length;
    laneEnds[lane] = ev.occurrence.end;
    return lane;
  });
  // Per-event totalLanes = max lane among all overlapping events + 1
  return sorted.map((ev, i) => {
    const s = ev.occurrence.start.getTime(), e = ev.occurrence.end.getTime();
    let maxLane = assignments[i];
    for (let j = 0; j < sorted.length; j++) {
      const os = sorted[j].occurrence.start.getTime(), oe = sorted[j].occurrence.end.getTime();
      if (os < e && oe > s) maxLane = Math.max(maxLane, assignments[j]);
    }
    return { ev, lane: assignments[i], totalLanes: maxLane + 1 };
  });
}

// ─── Collapsible sidebar section ─────────────────────────────────────────────
function CollapsibleSection({ title, children, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useMemo(() => 'cs-' + title.replace(/\s+/g, '-').toLowerCase(), [title]);
  return (
    <div style={{ marginBottom: 2 }}>
      <button className="collapsible-btn" onClick={() => setOpen(o => !o)}
        aria-expanded={open} aria-controls={contentId}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="section-label" style={{ margin: 0 }}>{title}</span>
          {badge != null && (
            <span style={{ fontSize: 10, background: '#c4842044', color: '#c48420',
              borderRadius: 8, padding: '1px 6px', fontWeight: 700 }}>
              {badge}
            </span>
          )}
        </div>
        <svg className={`collapsible-chevron${open ? ' open' : ''}`}
          width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5">
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>
      {open && <div id={contentId} role="region" aria-label={title} style={{ paddingTop: 6, paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}

// ─── Event-column layout (greedy, avoids overlaps) ────────────────────────────
const MAX_COLS = 3; // max side-by-side columns before overflow
const MIN_EVENT_PX = 18; // must match the min height in rendering

function computeEventCols(events, hourH) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.occurrence.start - b.occurrence.start);
  const pxPerMs = (hourH || 80) / 3600000; // px per millisecond
  // Compute visual end: max of time-based end and start + minPx worth of time
  const visualEnd = (ev) => {
    const durPx = (ev.occurrence.end - ev.occurrence.start) * pxPerMs;
    if (durPx >= MIN_EVENT_PX) return ev.occurrence.end.getTime();
    // Event is too short visually — extend its "end" so the pill's min-height is accounted for
    return ev.occurrence.start.getTime() + (MIN_EVENT_PX / pxPerMs);
  };
  // Greedy column assignment using visual bounds
  const colVisualEnds = []; // track visual end per column in ms
  const assignments = sorted.map(ev => {
    const s = ev.occurrence.start.getTime();
    let col = colVisualEnds.findIndex(end => s >= end);
    if (col === -1) col = colVisualEnds.length;
    colVisualEnds[col] = visualEnd(ev);
    return col;
  });
  // Per-event totalCols = max col index among all events that visually overlap with it + 1
  const vEnds = sorted.map(visualEnd);
  return sorted.map((ev, i) => {
    const s = ev.occurrence.start.getTime();
    const ve = vEnds[i];
    let maxCol = assignments[i];
    for (let j = 0; j < sorted.length; j++) {
      const os = sorted[j].occurrence.start.getTime();
      const ove = vEnds[j];
      if (os < ve && ove > s) maxCol = Math.max(maxCol, assignments[j]);
    }
    const totalCols = maxCol + 1;
    const displayCols = Math.min(totalCols, MAX_COLS);
    const col = assignments[i];
    const isOverflow = col >= MAX_COLS;
    return { ev, col, totalCols, displayCols, isOverflow };
  });
}

// ─── Skeleton components ──────────────────────────────────────────────────────
function SkeletonLine({ w = '100%', h = 14 }) {
  return <div className="skeleton" style={{ width: w, height: h, marginBottom: 6 }} />;
}
function SkeletonCard() {
  return (
    <div style={{ background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 6, padding: 8 }}>
      <SkeletonLine w="60%" h={12} />
      <SkeletonLine w="90%" h={10} />
      <SkeletonLine w="75%" h={10} />
    </div>
  );
}
function CalendarSkeleton() {
  return (
    <div className="cal-grid" style={{ gap: 2 }}>
      {Array.from({ length: 35 }).map((_, i) => (
        <div key={i} style={{ minHeight: 90, background: 'var(--c-surface)', border: '1px solid var(--c-border)', borderRadius: 6, padding: 4 }}>
          <SkeletonLine w="30%" h={10} />
          {i % 3 === 0 && <SkeletonLine w="85%" h={16} />}
          {i % 5 === 0 && <SkeletonLine w="70%" h={16} />}
        </div>
      ))}
    </div>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function Tooltip({ event, pos, uiTimezone, machineTemplates }) {
  const ref = useRef(null);
  const [adj, setAdj] = useState(null);

  useEffect(() => {
    if (!ref.current || !pos) { setAdj(null); return; }
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    let left = pos.x + 12;
    let top  = pos.y + 12;
    if (left + rect.width > window.innerWidth - pad) left = pos.x - rect.width - 12;
    if (left < pad) left = pad;
    if (top + rect.height > window.innerHeight - pad) top = pos.y - rect.height - 12;
    if (top < pad) top = pad;
    setAdj({ left, top });
  }, [pos]);

  if (!event) return null;
  const { schedule, occurrence } = event;
  const dur = occurrence.end - occurrence.start;
  const humanCron = cronToHuman(schedule.cron);
  const argEntries = schedule.inputArgs ? Object.entries(schedule.inputArgs) : [];
  const slotCount = schedule.machine && machineTemplates ? machineTemplates[schedule.machine] : 0;
  return (
    <div ref={ref} className="tooltip" style={{ left: (adj || {}).left || pos.x + 12, top: (adj || {}).top || pos.y + 12 }}>
      <div className="tooltip-title">{schedule.name}</div>
      {event.gapWarning && (
        <div className="tooltip-row tooltip-warn">
          <span>⚠️ Next process starts before this one ends (same machine/robot)</span>
        </div>
      )}
      <div className="tooltip-row">
        <span className="tooltip-label">Start</span>
        <span className="tooltip-value">{fmtDate(occurrence.start, uiTimezone)} {fmtTime(occurrence.start, uiTimezone)}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Est. End</span>
        <span className="tooltip-value">{fmtTime(occurrence.end, uiTimezone)}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Duration</span>
        <span className="tooltip-value">{fmtDuration(dur)}</span>
      </div>
      {humanCron && (
        <div className="tooltip-row">
          <span className="tooltip-label">Runs</span>
          <span className="tooltip-value">{humanCron}</span>
        </div>
      )}
      {schedule.machine && (
        <div className="tooltip-row">
          <span className="tooltip-label">Machine</span>
          <span className="tooltip-value">
            {schedule.machine}
          </span>
        </div>
      )}
      {schedule.robotAccount && (
        <div className="tooltip-row">
          <span className="tooltip-label">Robot</span>
          <span className="tooltip-value">{schedule.robotAccount}</span>
        </div>
      )}
      {schedule.tags && schedule.tags.length > 0 && (
        <div className="tooltip-row">
          <span className="tooltip-label">Tags</span>
          <span className="tooltip-value">{schedule.tags.join(', ')}</span>
        </div>
      )}
      {argEntries.length > 0 && (
        <div className="tooltip-row" style={{ alignItems: 'flex-start' }}>
          <span className="tooltip-label">Args</span>
          <span className="tooltip-value tooltip-args">
            {argEntries.map(([k, v]) => (
              <span key={k} className="tooltip-arg">{k}: <em>{String(v)}</em></span>
            ))}
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Overflow popover ("+N more" badge detail card) ───────────────────────────
function OverflowPopover({ events, pos, uiTimezone, colorMap, textColorMap }) {
  const ref = useRef(null);
  const [adjusted, setAdjusted] = useState({ left: 0, top: 0 });

  useEffect(() => {
    if (!ref.current || !pos) return;
    const rect = ref.current.getBoundingClientRect();
    const pad = 8;
    let left = pos.x + 12;
    let top  = pos.y + 12;
    // Clamp right edge
    if (left + rect.width > window.innerWidth - pad) {
      left = pos.x - rect.width - 12;
    }
    // Clamp left edge
    if (left < pad) left = pad;
    // Clamp bottom edge
    if (top + rect.height > window.innerHeight - pad) {
      top = pos.y - rect.height - 12;
    }
    // Clamp top edge
    if (top < pad) top = pad;
    setAdjusted({ left, top });
  }, [pos]);

  if (!events || !events.length || !pos) return null;
  return (
    <div ref={ref} className="tooltip overflow-popover"
      style={{ left: adjusted.left || pos.x + 12, top: adjusted.top || pos.y + 12, pointerEvents: 'none' }}>
      <div className="tooltip-title" style={{ fontSize: 11, marginBottom: 4 }}>
        +{events.length} more process{events.length > 1 ? 'es' : ''}
      </div>
      {events.map((ev, i) => {
        const { schedule, occurrence } = ev;
        const dur = occurrence.end - occurrence.start;
        const color = colorMap[schedule.id] || 'var(--c-muted)';
        const tColor = textColorMap?.[schedule.id] || color;
        return (
          <div key={i} className="overflow-item" style={{ borderLeftColor: color }}>
            <div className="overflow-item-name" style={{ color: tColor }}>{schedule.name}</div>
            <div className="overflow-item-details">
              <span>{fmtTime(occurrence.start, uiTimezone)} – {fmtTime(occurrence.end, uiTimezone)}</span>
              <span className="overflow-item-dur">{fmtDuration(dur)}</span>
            </div>
            {(schedule.machine || schedule.robotAccount) && (
              <div className="overflow-item-details" style={{ opacity: 0.7 }}>
                {schedule.machine && <span>🖥 {schedule.machine}</span>}
                {schedule.robotAccount && <span>🤖 {schedule.robotAccount}</span>}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
function Toast({ error, onClose }) {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(onClose, 8000);
    return () => clearTimeout(timer);
  }, [error, onClose]);
  if (!error) return null;
  return (
    <div className="toast-container">
      <div className="toast toast-error">
        <svg className="toast-icon" width="15" height="15" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/>
          <line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <div className="toast-body">
          <div className="toast-title">Request Failed</div>
          <div className="toast-message">{error}</div>
        </div>
        <button className="toast-close" onClick={onClose} title="Dismiss">×</button>
        <div className="toast-progress" />
      </div>
    </div>
  );
}

// ─── Event chip ───────────────────────────────────────────────────────────────
const EventChip = React.memo(function EventChip({ event, color, textColor, onHover, onLeave, uiTimezone, compact }) {
  const handleMouse = useCallback(e => onHover(event, { x: e.clientX, y: e.clientY }), [event, onHover]);
  return (
    <button
      className="event-chip"
      style={{
        background: color + '18', color: textColor || color, borderLeft: `3px solid ${color}`,
        ...(compact ? { flex: 1, minWidth: 0 } : {}),
      }}
      onMouseEnter={handleMouse}
      onMouseMove={handleMouse}
      onMouseLeave={onLeave}
    >
      {event.gapWarning && <span className="gap-warn-icon" title="Next process overlaps on same machine/robot">⚠</span>}
      {fmtTime(event.occurrence.start, uiTimezone)} {event.schedule.name}
    </button>
  );
});

// ─── Calendar day cell ────────────────────────────────────────────────────────
const MAX_VISIBLE = 3;
function CalDay({ date, events, colorMap, textColorMap, isToday, isOtherMonth, onHover, onLeave, uiTimezone }) {
  const [expanded, setExpanded] = useState(false);
  const [ovPopover, setOvPopover] = useState(null);
  const visible = expanded ? events : events.slice(0, MAX_VISIBLE);
  const overflow = events.length - MAX_VISIBLE;

  // Group concurrent events into rows that share horizontal space
  const rows = useMemo(() => {
    if (!visible.length) return [];
    const result = [];
    let i = 0;
    while (i < visible.length) {
      // Find cluster of overlapping events
      const cluster = [visible[i]];
      let clusterEnd = visible[i].occurrence.end;
      let j = i + 1;
      while (j < visible.length && visible[j].occurrence.start < clusterEnd) {
        cluster.push(visible[j]);
        clusterEnd = Math.max(clusterEnd, visible[j].occurrence.end);
        j++;
      }
      result.push(cluster);
      i = j;
    }
    return result;
  }, [visible]);

  return (
    <div className={`cal-day${isToday ? ' today' : ''}${isOtherMonth ? ' other-month' : ''}`}>
      <div className="cal-day-num">{date.getDate()}</div>
      {rows.map((cluster, ri) => {
        if (cluster.length === 1) {
          return (
            <EventChip
              key={ri}
              event={cluster[0]}
              color={colorMap[cluster[0].schedule.id] || 'var(--c-muted)'}
              textColor={textColorMap?.[cluster[0].schedule.id]}
              onHover={onHover}
              onLeave={onLeave}
              uiTimezone={uiTimezone}
            />
          );
        }
        // Cap at 2 side-by-side, overflow rest
        const show = cluster.slice(0, 2);
        const extra = cluster.length - 2;
        return (
          <div key={ri} style={{ display: 'flex', gap: 1, marginBottom: 2, alignItems: 'center' }}>
            {show.map((ev, ci) => (
              <EventChip
                key={ci}
                event={ev}
                color={colorMap[ev.schedule.id] || 'var(--c-muted)'}
                textColor={textColorMap?.[ev.schedule.id]}
                onHover={onHover}
                onLeave={onLeave}
                uiTimezone={uiTimezone}
                compact
              />
            ))}
            {extra > 0 && (
              <span style={{ fontSize: 9, fontWeight: 700, color: 'var(--c-muted)', whiteSpace: 'nowrap', flexShrink: 0, cursor: 'default' }}
                onMouseEnter={e => setOvPopover({ events: cluster.slice(2), pos: { x: e.clientX, y: e.clientY } })}
                onMouseMove={e  => setOvPopover(prev => prev ? { ...prev, pos: { x: e.clientX, y: e.clientY } } : null)}
                onMouseLeave={() => setOvPopover(null)}>
                +{extra}
              </span>
            )}
          </div>
        );
      })}
      {!expanded && overflow > 0 && (
        <button className="more-events" onClick={() => setExpanded(true)}>
          +{overflow} more
        </button>
      )}
      {expanded && overflow > 0 && (
        <button className="more-events" onClick={() => setExpanded(false)}>
          show less
        </button>
      )}
      {ovPopover && (
        <OverflowPopover
          events={ovPopover.events}
          pos={ovPopover.pos}
          uiTimezone={uiTimezone}
          colorMap={colorMap}
          textColorMap={textColorMap}
        />
      )}
    </div>
  );
}

// ─── Calendar month view ──────────────────────────────────────────────────────
const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function CalendarMonth({ month, eventsByDay, colorMap, textColorMap, onHover, onLeave, uiTimezone }) {
  const today  = new Date();
  const first  = startOfMonth(month);
  const last   = endOfMonth(month);

  // Build grid: pad from Sunday
  const startPad = first.getDay();
  const cells = [];
  for (let i = 0; i < startPad; i++)
    cells.push(addDays(first, -(startPad - i)));
  for (let d = new Date(first); d <= last; d = addDays(d, 1))
    cells.push(new Date(d));
  while (cells.length % 7 !== 0)
    cells.push(addDays(cells[cells.length - 1], 1));

  return (
    <div>
      {/* Weekday headers */}
      <div className="cal-grid" style={{ gap: 2, marginBottom: 4 }}>
        {WEEK_DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: 'var(--c-muted)', padding: '4px 0' }}>
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid" style={{ gap: 2 }}>
        {cells.map((date, i) => {
          const key = dayKey(date, uiTimezone);
          const events = eventsByDay[key] || [];
          return (
            <CalDay
              key={i}
              date={date}
              events={events}
              colorMap={colorMap}
              textColorMap={textColorMap}
              isToday={sameDay(date, today, uiTimezone)}
              isOtherMonth={date.getMonth() !== month.getMonth()}
              onHover={onHover}
              onLeave={onLeave}
              uiTimezone={uiTimezone}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── Time-grid view (week / 3-day / day) ─────────────────────────────────────
const HOUR_H_DEFAULT = 80; // px per hour row (default zoom)
const HOUR_H_MIN = 40;
const HOUR_H_MAX = 160;

function CalendarTimeGrid({ days, eventsByDay, colorMap, textColorMap, onHover, onLeave, uiTimezone, machineTemplates }) {
  const scrollRef = useRef(null);
  const today = new Date();
  const [hourH, setHourH] = useState(HOUR_H_DEFAULT);
  const [ovPopover, setOvPopover] = useState(null); // { events, pos }

  // Memoize column layout computation across all day columns
  const laidByDay = useMemo(() => {
    const out = {};
    days.forEach(date => {
      const key = dayKey(date, uiTimezone);
      const events = eventsByDay[key] || [];
      out[key] = computeEventCols(events, hourH);
    });
    return out;
  }, [days, eventsByDay, hourH, uiTimezone]);

  // Scroll to show 07:00 on first render
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * hourH;
  }, []);

  // Compute current time position in the display timezone
  function nowMinInTz() {
    try {
      const t = new Date().toLocaleTimeString('sv-SE', { timeZone: uiTimezone || undefined });
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    } catch (_) {
      return new Date().getHours() * 60 + new Date().getMinutes();
    }
  }

  // Compute start-of-day position for an event in the display timezone
  function eventStartMin(d) {
    try {
      const t = d.toLocaleTimeString('sv-SE', { timeZone: uiTimezone || undefined });
      const [h, m] = t.split(':').map(Number);
      return h * 60 + m;
    } catch (_) {
      return d.getHours() * 60 + d.getMinutes();
    }
  }

  return (
    <div className="tg-wrap">
      {/* ── Day headers ── */}
      <div className="tg-header">
        <div className="tg-gutter" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4, padding: '0 2px' }}>
          <button onClick={() => setHourH(h => Math.max(HOUR_H_MIN, h - 20))} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }} title="Zoom out">−</button>
          <button onClick={() => setHourH(h => Math.min(HOUR_H_MAX, h + 20))} style={{ background: 'none', border: 'none', color: 'var(--c-muted)', cursor: 'pointer', fontSize: 14, padding: 0, lineHeight: 1 }} title="Zoom in">+</button>
        </div>
        {days.map((date, i) => {
          const isToday = sameDay(date, today, uiTimezone);
          return (
            <div key={i} className="tg-day-hdr">
              <div className="tg-day-weekday">
                {date.toLocaleDateString('default', { weekday: 'short' })}
              </div>
              <div className={`tg-day-num${isToday ? ' today' : ''}`}>
                {date.getDate()}
              </div>
            </div>
          );
        })}
      </div>

      {/* ── Scrollable body ── */}
      <div className="tg-scroll" ref={scrollRef}>
        <div className="tg-body" style={{ height: 24 * hourH }}>

          {/* Time gutter */}
          <div className="tg-time-col" style={{ height: 24 * hourH }}>
            {Array.from({ length: 24 }, (_, h) => (
              h === 0 ? null : (
                <div key={h} className="tg-time-label" style={{ top: h * hourH }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              )
            ))}
          </div>

          {/* Day columns */}
          {days.map((date, di) => {
            const key     = dayKey(date, uiTimezone);
            const events  = eventsByDay[key] || [];
            const laid    = laidByDay[key] || [];
            const isToday = sameDay(date, today, uiTimezone);
            const nowMin  = isToday ? nowMinInTz() : null;

            return (
              <div key={di} className="tg-col"
                style={{ background: isToday ? 'var(--c-today-tint)' : 'transparent' }}>

                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="tg-hour-line" style={{ top: h * hourH }} />
                ))}
                {/* Half-hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={`h${h}`} className="tg-half-line" style={{ top: h * hourH + hourH / 2 }} />
                ))}

                {/* Current-time indicator */}
                {nowMin !== null && (
                  <div className="tg-now-line" style={{ top: (nowMin / 60) * hourH }}>
                    <div className="tg-now-dot" />
                  </div>
                )}

                {/* Events */}
                {(() => {
                  // Group overflow counts by time cluster for "+N more" badges
                  const overflowByCluster = {};
                  const visibleItems = [];
                  laid.forEach((item, i) => {
                    const { ev, col, displayCols, isOverflow } = item;
                    if (isOverflow) {
                      // Find the cluster start time for grouping overflow badges
                      const startMin = eventStartMin(ev.occurrence.start);
                      const clusterKey = Math.floor(startMin / 15) * 15; // 15-min bucket
                      if (!overflowByCluster[clusterKey]) overflowByCluster[clusterKey] = { count: 0, startMin, events: [] };
                      overflowByCluster[clusterKey].count++;
                      overflowByCluster[clusterKey].events.push(ev);
                    } else {
                      visibleItems.push({ ...item, idx: i });
                    }
                  });

                  return (
                    <React.Fragment>
                      {visibleItems.map(({ ev, col, displayCols, idx }) => {
                        const startMin  = eventStartMin(ev.occurrence.start);
                        const durMin    = Math.max((ev.occurrence.end - ev.occurrence.start) / 60000, 15);
                        const topPx     = (startMin / 60) * hourH;
                        const heightPx  = Math.max((durMin / 60) * hourH - 2, 18);
                        const color     = colorMap[ev.schedule.id] || 'var(--c-muted)';
                        const tColor    = textColorMap[ev.schedule.id] || color;
                        const pct       = 100 / displayCols;
                        return (
                          <div key={idx} className="tg-event"
                            style={{
                              top: topPx + 1, height: heightPx,
                              left: `${col * pct}%`,
                              width: `${pct}%`,
                              background: color + '18',
                              borderLeft: `3px solid ${color}`,
                              color: tColor,
                            }}
                            onMouseEnter={e => onHover(ev, { x: e.clientX, y: e.clientY })}
                            onMouseMove={e  => onHover(ev, { x: e.clientX, y: e.clientY })}
                            onMouseLeave={onLeave}>
                            {heightPx >= 28 && <div className="tg-event-time">{fmtTime(ev.occurrence.start, uiTimezone)}</div>}
                            <div className="tg-event-name">
                              {ev.gapWarning && <span className="gap-warn-icon" title="Next process overlaps on same machine/robot">⚠️</span>}
                              {ev.schedule.name}
                            </div>
                          </div>
                        );
                      })}
                      {Object.values(overflowByCluster).map((cluster, ci) => {
                        const topPx = (cluster.startMin / 60) * hourH;
                        return (
                          <div key={`ov-${ci}`} className="tg-overflow-badge"
                            style={{ top: topPx + 1 }}
                            onMouseEnter={e => setOvPopover({ events: cluster.events, pos: { x: e.clientX, y: e.clientY } })}
                            onMouseMove={e  => setOvPopover(prev => prev ? { ...prev, pos: { x: e.clientX, y: e.clientY } } : null)}
                            onMouseLeave={() => setOvPopover(null)}>
                            +{cluster.count}
                          </div>
                        );
                      })}
                    </React.Fragment>
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
      {ovPopover && (
        <OverflowPopover
          events={ovPopover.events}
          pos={ovPopover.pos}
          uiTimezone={uiTimezone}
          colorMap={colorMap}
          textColorMap={textColorMap}
        />
      )}
    </div>
  );
}

// ─── Gantt / Resource Timeline view ──────────────────────────────────────────
const LANE_H   = 32; // px per lane within a machine row
const TL_LABEL = 148; // px width of the sticky machine-name column

function CalendarTimeline({ days, eventsByDay, colorMap, textColorMap, uiTimezone, onHover, onLeave, machineTemplates }) {
  const [nowPcts, setNowPcts] = useState(() => days.map(d => nowDayPct(d, uiTimezone)));

  // Refresh now-line every minute
  useEffect(() => {
    const id = setInterval(
      () => setNowPcts(days.map(d => nowDayPct(d, uiTimezone))),
      60_000,
    );
    return () => clearInterval(id);
  }, [days, uiTimezone]);

  const N = days.length; // number of days visible (1 or 3)

  // Group events by machine across all visible days, keeping track of day index
  const byMachine = useMemo(() => {
    const map = {};
    days.forEach((date, di) => {
      const key = dayKey(date, uiTimezone);
      (eventsByDay[key] || []).forEach(ev => {
        const m = ev.schedule.machine || 'Unassigned';
        if (!map[m]) map[m] = [];
        map[m].push({ ...ev, _di: di });
      });
    });
    return map;
  }, [days, eventsByDay, uiTimezone]);

  const machineNames = Object.keys(byMachine).sort();

  // Lane assignments per machine
  const machineLayouts = useMemo(() => {
    const r = {};
    machineNames.forEach(m => { r[m] = computeTimelineLanes(byMachine[m]); });
    return r;
  }, [byMachine, machineNames]);

  // Convert occurrence time to left% in the multi-day strip
  function occToPct(occ, di) {
    const timePct = dayTimeToPct(occ.start, uiTimezone); // 0-100 within that day
    return (di * 100 + timePct) / N;
  }
  function durToPct(occ) {
    const ms = occ.end - occ.start;
    return Math.max((ms / (N * 86400000)) * 100, 0.3);
  }

  return (
    <div className="tl-wrap">
      {/* ── Timeline header: day labels + hour ticks ── */}
      <div className="tl-header">
        <div style={{ width: TL_LABEL, flexShrink: 0, borderRight: '1px solid var(--c-border)' }} />
        <div style={{ flex: 1, position: 'relative', height: 38 }}>
          {days.map((date, di) => {
            const isToday = sameDay(date, new Date(), uiTimezone);
            return (
              <React.Fragment key={di}>
                {/* Day label */}
                <div style={{
                  position: 'absolute',
                  left: `${(di / N) * 100}%`,
                  width: `${100 / N}%`,
                  top: 0, height: 18,
                  display: 'flex', alignItems: 'center', paddingLeft: 6,
                  fontSize: 11, fontWeight: 700,
                  color: isToday ? '#FA4616' : 'var(--c-muted)',
                  borderLeft: di > 0 ? '1px solid var(--c-border)' : 'none',
                }}>
                  {date.toLocaleDateString('default', { weekday: 'short', month: 'short', day: 'numeric' })}
                </div>
                {/* Hour ticks for this day */}
                {Array.from({ length: 24 }, (_, h) => (
                  h % 3 === 0 ? (
                    <div key={h} style={{
                      position: 'absolute',
                      left: `${(di / N + h / (N * 24)) * 100}%`,
                      top: 20,
                      transform: 'translateX(-50%)',
                      fontSize: 9, color: 'var(--c-muted)',
                      whiteSpace: 'nowrap', pointerEvents: 'none',
                    }}>
                      {String(h).padStart(2, '0')}
                    </div>
                  ) : null
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* ── Machine rows ── */}
      <div className="tl-body">
        {machineNames.length === 0 && (
          <div style={{ padding: '48px 24px', textAlign: 'center', color: 'var(--c-muted)', fontSize: 13 }}>
            No scheduled events in this period
          </div>
        )}
        {machineNames.map(machine => {
          const laid       = machineLayouts[machine] || [];
          const totalLanes = laid.length ? laid[0].totalLanes : 1;
          const rowH       = Math.max(LANE_H, totalLanes * LANE_H);
          const slotCount  = machineTemplates?.[machine] || 0;

          return (
            <div key={machine} className="tl-row" style={{ height: rowH }}>
              {/* Sticky machine label */}
              <div className="tl-row-label" style={{ width: TL_LABEL }}>
                <div className="tl-machine-name">{machine}</div>
                {slotCount > 1 && (
                  <div className="tl-machine-meta">Template · {slotCount} slots</div>
                )}
              </div>

              {/* Timeline strip */}
              <div className="tl-row-strip">
                {/* Hour grid lines */}
                {Array.from({ length: N * 24 + 1 }, (_, i) => (
                  <div key={i} className={i % 24 === 0 ? 'tl-day-line' : 'tl-hour-line'}
                    style={{ left: `${(i / (N * 24)) * 100}%` }} />
                ))}

                {/* "Now" vertical lines */}
                {days.map((_, di) => nowPcts[di] !== null && (
                  <div key={di} className="tl-now-vline"
                    style={{ left: `${(di / N + nowPcts[di] / (N * 100)) * 100}%` }}>
                    <div className="tl-now-dot" />
                  </div>
                ))}

                {/* Event bars */}
                {laid.map(({ ev, lane, totalLanes: tl }, i) => {
                  const laneH    = rowH / tl;
                  const leftPct  = occToPct(ev.occurrence, ev._di);
                  const wPct     = durToPct(ev.occurrence);
                  const color    = colorMap[ev.schedule.id] || 'var(--c-muted)';
                  const tColor   = textColorMap?.[ev.schedule.id] || color;
                  const isCollide = tl > 1;
                  return (
                    <div key={i}
                      className={`tl-bar${isCollide ? ' tl-collision' : ''}`}
                      style={{
                        left: `${leftPct}%`,
                        width: `${wPct}%`,
                        top: lane * laneH + 2,
                        height: laneH - 4,
                        background: color + '20',
                        borderColor: isCollide ? '#D94F04' : color,
                        color: tColor,
                      }}
                      onMouseEnter={e => onHover(ev, { x: e.clientX, y: e.clientY })}
                      onMouseMove={e  => onHover(ev, { x: e.clientX, y: e.clientY })}
                      onMouseLeave={onLeave}>
                      <span className="tl-bar-label">
                        {ev.gapWarning && <span className="gap-warn-icon">⚠</span>}
                        {fmtTime(ev.occurrence.start, uiTimezone)} {ev.schedule.name}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Sidebar multi-select filter ──────────────────────────────────────────────
function FilterList({ label, items, selected, onToggle, onSelectAll, onSelectNone, colorMap }) {
  const [search, setSearch] = useState('');
  const filtered = items.filter(it =>
    it.label.toLowerCase().includes(search.toLowerCase())
  );
  const allSelected = items.every(it => selected.has(it.id));

  return (
    <div style={{ marginBottom: 8 }}>
      {label && <div className="section-label">{label}</div>}
      <input
        type="text"
        placeholder="Search…"
        value={search}
        onChange={e => setSearch(e.target.value)}
        style={{ marginBottom: 6 }}
      />
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={onSelectAll || (() => items.forEach(it => !selected.has(it.id) && onToggle(it.id)))}>
          All
        </button>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={onSelectNone || (() => items.forEach(it => selected.has(it.id) && onToggle(it.id)))}>
          None
        </button>
      </div>
      <div style={{ maxHeight: 180, overflowY: 'auto' }}>
        {filtered.map(it => (
          <label key={it.id} style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 4, cursor: 'pointer', fontSize: 12 }}>
            <input type="checkbox" checked={selected.has(it.id)} onChange={() => onToggle(it.id)} />
            {colorMap && colorMap[it.id] && (
              <span className="legend-dot" style={{ background: colorMap[it.id] }} />
            )}
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{it.label}</span>
          </label>
        ))}
        {!filtered.length && <div style={{ color: 'var(--c-muted)', fontSize: 12 }}>No matches</div>}
      </div>
    </div>
  );
}

// ─── Token field with show/hide, paste, and status dot ───────────────────────
function TokenField({ value, onChange }) {
  const [show,   setShow]   = useState(false);
  const [pasted, setPasted] = useState(false);
  const hasToken = value.length > 0;
  const hint     = hasToken ? `…${value.slice(-6)}` : null;

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      const trimmed = text.trim();
      if (trimmed) {
        onChange(trimmed);
        setPasted(true);
        setTimeout(() => setPasted(false), 2000);
      }
    } catch (_) { /* clipboard permission denied – user pastes manually */ }
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
        {/* Live status dot */}
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: hasToken ? '#00C48C' : '#FA4616',
          boxShadow: hasToken ? '0 0 6px #00C48C88' : '0 0 6px #FA461688',
          transition: 'background .3s, box-shadow .3s',
        }} />
        <span style={{ fontSize: 12, color: 'var(--c-muted)', flex: 1 }}>
          Personal Access Token
          {' '}<span style={{ color: '#FA4616', fontSize: 10 }}>(session only)</span>
        </span>
        {/* Masked hint of current token */}
        {hint && (
          <span style={{ fontFamily: 'monospace', fontSize: 10, color: 'var(--c-muted)' }}>{hint}</span>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder="Paste your PAT here…"
          autoComplete="off"
          style={{ paddingRight: 58 }}
        />

        {/* Show / hide toggle */}
        <button type="button" onClick={() => setShow(s => !s)}
          title={show ? 'Hide token' : 'Show token'}
          style={{ position: 'absolute', right: 30, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', padding: '2px 4px',
            color: 'var(--c-muted)', cursor: 'pointer', lineHeight: 1 }}>
          {show ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
              <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
              <line x1="1" y1="1" x2="23" y2="23"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          )}
        </button>

        {/* Paste from clipboard */}
        <button type="button" onClick={handlePaste}
          title={pasted ? 'Pasted!' : 'Paste from clipboard'}
          style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', padding: '2px 4px',
            color: pasted ? '#00C48C' : 'var(--c-muted)', cursor: 'pointer',
            lineHeight: 1, transition: 'color .2s' }}>
          {pasted ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>
              <rect x="8" y="2" width="8" height="4" rx="1" ry="1"/>
            </svg>
          )}
        </button>
      </div>

      {!hasToken && (
        <div style={{ fontSize: 10, color: '#FA4616', marginTop: 3, lineHeight: 1.4 }}>
          Required — generate a PAT in UiPath Cloud → My Profile → Personal Access Tokens.
        </div>
      )}
    </div>
  );
}

// ─── Modal base ───────────────────────────────────────────────────────────────
// ─── Hint icon (fixed-position tooltip, never clipped by overflow) ────────────
function HintIcon({ text }) {
  const ref = useRef(null);
  const [tip, setTip] = useState(null);
  return (
    <span className="hint-wrap" ref={ref}
      onMouseEnter={() => {
        const r = ref.current?.getBoundingClientRect();
        if (r) setTip({ x: r.left + r.width / 2, y: r.top });
      }}
      onMouseLeave={() => setTip(null)}
    >
      <span className="hint-icon">?</span>
      {tip && (
        <div className="hint-tooltip" style={{ left: tip.x, top: tip.y }}>
          {text}
        </div>
      )}
    </span>
  );
}

// ─── Popover (anchored dropdown, no full-screen overlay) ──────────────────────
function Popover({ trigger, children, align = 'left' }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const toggle = useCallback(() => setOpen(v => !v), []);
  const close  = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    function onKey(e) {
      if (e.key === 'Escape') { setOpen(false); return; }
      // Focus trap: cycle Tab within popover
      if (e.key === 'Tab' && wrapRef.current) {
        const focusable = wrapRef.current.querySelectorAll(
          'button, input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault(); last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault(); first.focus();
        }
      }
    }
    function onDown(e) {
      if (!wrapRef.current?.contains(e.target)) setOpen(false);
    }
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      {trigger({ open, toggle, close })}
      {open && (
        <div className={`popover${align === 'right' ? ' popover-right' : ''}`}
          role="dialog" aria-modal="true">
          {typeof children === 'function' ? children({ close }) : children}
        </div>
      )}
    </div>
  );
}

// ─── Connection popover ───────────────────────────────────────────────────────
function ConnectionPopover({ cfg, onSave, loading, onClose }) {
  const [local, setLocal] = useState(cfg);
  const [pkceStarting, setPkceStarting] = useState(false);
  const [onPremConnecting, setOnPremConnecting] = useState(false);
  const [onPremError, setOnPremError] = useState('');
  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  const isPat    = local.authMode === 'pat'    || !local.authMode;
  const isPkce   = local.authMode === 'pkce';
  const isOnPrem = local.authMode === 'onprem';

  const canSave = local.orchestratorUrl && local.token;

  function handleSave() {
    saveConfig(local);
    onSave(local);
    onClose();
  }

  async function handlePkceConnect() {
    if (!local.pkceClientId) return;
    setPkceStarting(true);
    saveConfig({ ...local, authMode: 'pkce' }); // persist clientId before redirect
    try { await startPkceFlow(local.pkceClientId); }
    catch (e) { setPkceStarting(false); }
  }

  async function handleOnPremConnect() {
    if (!local.orchestratorUrl || !local.onPremClientId) return;
    setOnPremConnecting(true);
    setOnPremError('');
    saveConfig({ ...local, authMode: 'onprem' });
    try {
      await startOnPremPkceFlow(local.onPremClientId, local.orchestratorUrl, local.onPremTenant || '');
    } catch (e) {
      setOnPremError(e.message || String(e));
      setOnPremConnecting(false);
    }
  }

  const modeBtn = (mode, label) => (
    <button className="btn-ghost"
      style={{ flex: 1, justifyContent: 'center', background: local.authMode === mode ? 'var(--c-border)' : '' }}
      onClick={() => set('authMode', mode)}>{label}</button>
  );

  return (
    <>
      <div className="popover-header">Connection</div>
      <div className="popover-body">

        {/* Auth mode tabs */}
        <div className="modal-field">
          <div className="field-label">Authentication Method</div>
          <div style={{ display: 'flex', gap: 4 }}>
            {modeBtn('pat',  'PAT')}
            {modeBtn('pkce', 'UiPath OAuth')}
            {modeBtn('onprem', 'On-Prem OAuth')}
          </div>
        </div>

        {/* PAT mode */}
        {isPat && (
          <>
            <div className="modal-field">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
                Orchestrator URL
                <HintIcon text="Full URL including org, tenant, and API prefix e.g. https://cloud.uipath.com/org/tenant/orchestrator_" />
              </div>
              <input type="text" value={local.orchestratorUrl} onChange={e => set('orchestratorUrl', e.target.value)}
                placeholder="https://cloud.uipath.com/org/tenant/orchestrator_" />
              <div className="field-hint">Copy from your browser address bar up to <strong style={{ color: 'var(--c-blue)' }}>/orchestrator_</strong></div>
            </div>
            <div className="modal-field">
              <TokenField value={local.token} onChange={v => set('token', v)} />
            </div>
            <div className="field-hint">Token stored in sessionStorage only — cleared on tab close.</div>
          </>
        )}

        {/* PKCE mode */}
        {isPkce && (
          <>
            {cfg.token && (
              <div style={{ padding: '7px 10px', background: 'rgba(0,196,140,.08)',
                border: '1px solid rgba(0,196,140,.25)', borderRadius: 6, fontSize: 12, color: '#00C48C' }}>
                ✓ Authorized via UiPath OAuth
              </div>
            )}

            {/* Setup prerequisites */}
            <div style={{ background: 'rgba(0,174,239,.06)', border: '1px solid rgba(0,174,239,.2)',
              borderRadius: 6, padding: '9px 11px', fontSize: 11, color: 'var(--c-text)', lineHeight: 1.65 }}>
              <div style={{ fontWeight: 700, color: 'var(--c-blue)', marginBottom: 5 }}>
                Setup required (one time)
              </div>
              <div style={{ marginBottom: 4 }}>
                <strong>1.</strong> Go to <strong>UiPath Automation Cloud → Admin → External Applications → + Add Application</strong>
              </div>
              <div style={{ marginBottom: 4 }}>
                <strong>2.</strong> Set type to <strong>Non-confidential (Public)</strong>
              </div>
              <div style={{ marginBottom: 4 }}>
                <strong>3.</strong> Add Redirect URL — copy exactly:
              </div>
              <div style={{
                fontFamily: 'monospace', fontSize: 10, background: 'rgba(0,0,0,.25)',
                border: '1px solid var(--c-border)', borderRadius: 4,
                padding: '4px 7px', color: 'var(--c-blue)',
                wordBreak: 'break-all', marginBottom: 4, userSelect: 'all',
              }}>
                {`${window.location.origin}${window.location.pathname}`}
              </div>
              <div style={{ marginBottom: 0 }}>
                <strong>4.</strong> Add scopes: <code style={{ color: 'var(--c-blue)', fontSize: 10 }}>OR.Folders.Read OR.Execution.Read OR.Machines.Read OR.Jobs.Read</code>
              </div>
            </div>

            <div className="modal-field">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
                Orchestrator URL
                <HintIcon text="Full URL to your Orchestrator tenant, e.g. https://cloud.uipath.com/org/tenant/orchestrator_ — filled automatically after sign-in, or paste manually." />
              </div>
              <input type="text" value={local.orchestratorUrl || ''} onChange={e => set('orchestratorUrl', e.target.value)}
                placeholder="https://cloud.uipath.com/org/tenant/orchestrator_" />
              <div className="field-hint">Set automatically after sign-in, or paste your Orchestrator URL here.</div>
            </div>

            <div className="modal-field">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
                Client ID
                <HintIcon text="Copy the Client ID shown after saving the External Application in UiPath." />
              </div>
              <input type="text" value={local.pkceClientId || ''} onChange={e => set('pkceClientId', e.target.value)}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" autoComplete="off" />
            </div>

            <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }}
              onClick={handlePkceConnect}
              disabled={pkceStarting || !local.pkceClientId}>
              {pkceStarting ? 'Redirecting…' : '↗ Sign in with UiPath'}
            </button>
          </>
        )}

        {/* On-Prem OAuth mode */}
        {isOnPrem && (
          <>
            {local.token && (
              <div style={{ padding: '7px 10px', background: 'rgba(0,196,140,.08)',
                border: '1px solid rgba(0,196,140,.25)', borderRadius: 6, fontSize: 12, color: '#00C48C' }}>
                ✓ Authenticated via On-Prem OAuth
              </div>
            )}

            <div style={{ background: 'rgba(0,174,239,.06)', border: '1px solid rgba(0,174,239,.2)',
              borderRadius: 6, padding: '9px 11px', fontSize: 11, color: 'var(--c-text)', lineHeight: 1.65 }}>
              <div style={{ fontWeight: 700, color: 'var(--c-blue)', marginBottom: 5 }}>
                On-Prem Orchestrator (PKCE)
              </div>
              <div style={{ marginBottom: 4 }}>
                Authenticates via your on-prem Identity Server at <code style={{ fontSize: 10 }}>&lt;host&gt;/identity/connect/authorize</code>
              </div>
              <div style={{ marginBottom: 4 }}>
                Add this <strong>Redirect URL</strong> to your app registration:
              </div>
              <div style={{
                fontFamily: 'monospace', fontSize: 10, background: 'rgba(0,0,0,.25)',
                border: '1px solid var(--c-border)', borderRadius: 4,
                padding: '4px 7px', color: 'var(--c-blue)',
                wordBreak: 'break-all', marginBottom: 4, userSelect: 'all',
              }}>
                {`${window.location.origin}${window.location.pathname}`}
              </div>
            </div>

            <div className="modal-field">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
                Orchestrator URL
                <HintIcon text="Base URL of your on-prem Orchestrator e.g. https://orchestrator.yourcompany.com/orchestrator_" />
              </div>
              <input type="text" value={local.orchestratorUrl || ''} onChange={e => set('orchestratorUrl', e.target.value)}
                placeholder="https://orchestrator.yourcompany.com" />
            </div>

            <div className="modal-field">
              <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
                Tenant
                <HintIcon text="Only for multi-tenant on-prem. Leave empty for single-tenant setups." />
              </div>
              <input type="text" value={local.onPremTenant || ''} onChange={e => set('onPremTenant', e.target.value)}
                placeholder="(leave empty for single-tenant)" autoComplete="off" />
            </div>

            <div className="modal-field">
              <div className="field-label">Client ID</div>
              <input type="text" value={local.onPremClientId || ''} onChange={e => set('onPremClientId', e.target.value)}
                placeholder="Client ID from Identity Server" autoComplete="off" />
            </div>

            {onPremError && (
              <div style={{ padding: '7px 10px', background: 'rgba(250,70,22,.08)',
                border: '1px solid rgba(250,70,22,.25)', borderRadius: 6, fontSize: 11, color: '#FA4616' }}>
                {onPremError}
              </div>
            )}

            <button className="btn-primary" style={{ width: '100%', justifyContent: 'center' }}
              onClick={handleOnPremConnect}
              disabled={onPremConnecting || !local.orchestratorUrl || !local.onPremClientId}>
              {onPremConnecting ? 'Redirecting…' : '↗ Sign in with On-Prem'}
            </button>
          </>
        )}

      </div>
      {!isPkce && !isOnPrem && (
        <div className="popover-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleSave}
            disabled={loading || !canSave}
            style={{ flex: 1, justifyContent: 'center' }}>
            {loading ? 'Loading…' : 'Save & Fetch'}
          </button>
        </div>
      )}
      {(isPkce || isOnPrem) && local.token && (
        <div className="popover-footer">
          <button className="btn-ghost" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>
            Close
          </button>
        </div>
      )}
    </>
  );
}

// ─── Settings popover ─────────────────────────────────────────────────────────
function SettingsPopover({ projDays, onProjDays, defaultDurMin, onDurMin, theme, onTheme, uiTimezone, onTimezone, onClose }) {
  // Outlook-style curated timezone list — one city per offset, sorted west→east
  const OUTLOOK_TIMEZONES = useMemo(() => [
    { label: '(UTC-12:00) International Date Line West',  tz: 'Etc/GMT+12' },
    { label: '(UTC-11:00) Midway Island, Samoa',          tz: 'Pacific/Midway' },
    { label: '(UTC-10:00) Hawaii',                         tz: 'Pacific/Honolulu' },
    { label: '(UTC-09:00) Alaska',                         tz: 'America/Anchorage' },
    { label: '(UTC-08:00) Pacific Time (US & Canada)',     tz: 'America/Los_Angeles' },
    { label: '(UTC-07:00) Mountain Time (US & Canada)',    tz: 'America/Denver' },
    { label: '(UTC-07:00) Arizona',                        tz: 'America/Phoenix' },
    { label: '(UTC-06:00) Central Time (US & Canada)',     tz: 'America/Chicago' },
    { label: '(UTC-06:00) Mexico City',                    tz: 'America/Mexico_City' },
    { label: '(UTC-05:00) Eastern Time (US & Canada)',     tz: 'America/New_York' },
    { label: '(UTC-05:00) Bogota, Lima, Quito',            tz: 'America/Bogota' },
    { label: '(UTC-04:00) Atlantic Time (Canada)',         tz: 'America/Halifax' },
    { label: '(UTC-04:00) Santiago',                       tz: 'America/Santiago' },
    { label: '(UTC-03:30) Newfoundland',                   tz: 'America/St_Johns' },
    { label: '(UTC-03:00) Buenos Aires',                   tz: 'America/Argentina/Buenos_Aires' },
    { label: '(UTC-03:00) Brasilia',                       tz: 'America/Sao_Paulo' },
    { label: '(UTC-02:00) Mid-Atlantic',                   tz: 'Atlantic/South_Georgia' },
    { label: '(UTC-01:00) Azores',                         tz: 'Atlantic/Azores' },
    { label: '(UTC-01:00) Cape Verde Islands',             tz: 'Atlantic/Cape_Verde' },
    { label: '(UTC+00:00) London, Dublin, Lisbon',         tz: 'Europe/London' },
    { label: '(UTC+00:00) Reykjavik',                      tz: 'Atlantic/Reykjavik' },
    { label: '(UTC+01:00) Amsterdam, Berlin, Rome, Paris', tz: 'Europe/Berlin' },
    { label: '(UTC+01:00) Madrid, Barcelona',              tz: 'Europe/Madrid' },
    { label: '(UTC+01:00) West Central Africa',            tz: 'Africa/Lagos' },
    { label: '(UTC+02:00) Athens, Bucharest, Istanbul',    tz: 'Europe/Athens' },
    { label: '(UTC+02:00) Cairo',                          tz: 'Africa/Cairo' },
    { label: '(UTC+02:00) Helsinki, Kyiv',                 tz: 'Europe/Helsinki' },
    { label: '(UTC+02:00) Jerusalem',                      tz: 'Asia/Jerusalem' },
    { label: '(UTC+02:00) Johannesburg',                   tz: 'Africa/Johannesburg' },
    { label: '(UTC+03:00) Moscow, St. Petersburg',         tz: 'Europe/Moscow' },
    { label: '(UTC+03:00) Kuwait, Riyadh',                 tz: 'Asia/Riyadh' },
    { label: '(UTC+03:00) Nairobi',                        tz: 'Africa/Nairobi' },
    { label: '(UTC+03:30) Tehran',                         tz: 'Asia/Tehran' },
    { label: '(UTC+04:00) Abu Dhabi, Muscat, Dubai',       tz: 'Asia/Dubai' },
    { label: '(UTC+04:30) Kabul',                          tz: 'Asia/Kabul' },
    { label: '(UTC+05:00) Karachi, Tashkent',              tz: 'Asia/Karachi' },
    { label: '(UTC+05:30) Mumbai, Kolkata, New Delhi',     tz: 'Asia/Kolkata' },
    { label: '(UTC+05:45) Kathmandu',                      tz: 'Asia/Kathmandu' },
    { label: '(UTC+06:00) Dhaka, Almaty',                  tz: 'Asia/Dhaka' },
    { label: '(UTC+06:30) Yangon',                         tz: 'Asia/Yangon' },
    { label: '(UTC+07:00) Bangkok, Hanoi, Jakarta',        tz: 'Asia/Bangkok' },
    { label: '(UTC+08:00) Beijing, Hong Kong, Singapore',  tz: 'Asia/Shanghai' },
    { label: '(UTC+08:00) Perth',                          tz: 'Australia/Perth' },
    { label: '(UTC+08:00) Taipei',                         tz: 'Asia/Taipei' },
    { label: '(UTC+09:00) Tokyo, Osaka',                   tz: 'Asia/Tokyo' },
    { label: '(UTC+09:00) Seoul',                          tz: 'Asia/Seoul' },
    { label: '(UTC+09:30) Adelaide',                       tz: 'Australia/Adelaide' },
    { label: '(UTC+10:00) Sydney, Melbourne',              tz: 'Australia/Sydney' },
    { label: '(UTC+10:00) Guam, Port Moresby',             tz: 'Pacific/Guam' },
    { label: '(UTC+11:00) Solomon Islands',                tz: 'Pacific/Guadalcanal' },
    { label: '(UTC+12:00) Auckland, Wellington',           tz: 'Pacific/Auckland' },
    { label: '(UTC+12:00) Fiji',                           tz: 'Pacific/Fiji' },
    { label: '(UTC+13:00) Nuku\'alofa, Samoa',             tz: 'Pacific/Tongatapu' },
  ], []);

  const [tzSearch, setTzSearch] = useState('');
  const localTz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  // Ensure current uiTimezone is always in the list even if not in curated set
  const allOptions = useMemo(() => {
    const curated = OUTLOOK_TIMEZONES;
    const ids = new Set(curated.map(o => o.tz));
    const extras = [];
    if (uiTimezone && !ids.has(uiTimezone)) {
      extras.push({ label: `(Current) ${uiTimezone}`, tz: uiTimezone });
    }
    if (localTz && !ids.has(localTz) && localTz !== uiTimezone) {
      extras.push({ label: `(Local) ${localTz}`, tz: localTz });
    }
    return [...extras, ...curated];
  }, [OUTLOOK_TIMEZONES, uiTimezone, localTz]);

  const filtered = useMemo(() => {
    if (!tzSearch.trim()) return allOptions;
    const q = tzSearch.toLowerCase();
    return allOptions.filter(o => o.label.toLowerCase().includes(q) || o.tz.toLowerCase().includes(q));
  }, [tzSearch, allOptions]);
  return (
    <>
      <div className="popover-header">Settings</div>
      <div className="popover-body">
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Projection Period
            <HintIcon text="How many days ahead to compute scheduled run occurrences. Longer periods use more CPU." />
          </div>
          <select value={projDays} onChange={e => onProjDays(Number(e.target.value))}
            style={{ fontSize: 13 }}>
            {[7, 14, 30, 60, 90].map(d => (
              <option key={d} value={d} style={{ paddingLeft: 6, fontSize: 13 }}>{d} days</option>
            ))}
          </select>
        </div>
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Default Duration (min)
            <HintIcon text="Fallback event height used when no successful job history exists for a schedule." />
          </div>
          <input type="number" min="1" max="1440" value={defaultDurMin}
            onChange={e => onDurMin(Math.max(1, Number(e.target.value) || 5))}
            placeholder="5" />
        </div>
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Appearance
            <HintIcon text="Toggle between dark and light colour themes." />
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn-ghost"
              style={{ flex: 1, justifyContent: 'center',
                background: theme === 'dark' ? 'var(--c-border)' : '' }}
              onClick={() => onTheme('dark')}>Dark</button>
            <button className="btn-ghost"
              style={{ flex: 1, justifyContent: 'center',
                background: theme === 'light' ? 'var(--c-border)' : '' }}
              onClick={() => onTheme('light')}>Light</button>
          </div>
        </div>
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Display Timezone
            <HintIcon text="All event times are converted to this timezone." />
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input type="text" value={tzSearch}
              onChange={e => setTzSearch(e.target.value)}
              placeholder="🔍 Search city or timezone…"
              style={{ fontSize: 12, padding: '5px 8px' }} />
            <select value={uiTimezone}
              onChange={e => { onTimezone(e.target.value); setTzSearch(''); }}
              style={{ fontSize: 12 }}
              size={Math.min(filtered.length, 10)}>
              {filtered.map(o => (
                <option key={o.tz} value={o.tz}>
                  {o.label}{o.tz === localTz ? '  ★' : ''}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>
      <div className="popover-footer">
        <button className="btn-primary" onClick={onClose} style={{ flex: 1, justifyContent: 'center' }}>
          Done
        </button>
      </div>
    </>
  );
}

// ─── Legend ───────────────────────────────────────────────────────────────────
function Legend({ schedules, colorMap, selectedProcs, onToggle }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="section-label">Legend</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
        {schedules.map(s => (
          <label key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer', fontSize: 11 }}>
            <input type="checkbox" checked={selectedProcs.has(s.id)} onChange={() => onToggle(s.id)} />
            <span className="legend-dot" style={{ background: colorMap[s.id] }} />
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}
              title={s.name}>{s.name}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
function App() {
  const [cfg,              setCfg]              = useState(loadConfig);
  const [theme,            setTheme]            = useState(() => localStorage.getItem(LS_KEYS.theme) || 'dark');
  const [uiTimezone,       setUiTimezone]       = useState(() => {
    const localFallback = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const tzUrl = new URLSearchParams(window.location.search).get('tz');
    if (tzUrl) return validateTimezone(tzUrl) || localFallback;
    const stored = localStorage.getItem(LS_KEYS.uiTz);
    if (stored) return validateTimezone(stored) || localFallback;
    return localFallback;
  });
  const [defaultDurMin,    setDefaultDurMin]    = useState(() => Number(localStorage.getItem(LS_KEYS.durMin)) || 5);
  const [schedules,        setSchedules]        = useState([]);
  const [folders,          setFolders]          = useState([]);
  const [selectedFolders,  setSelectedFolders]  = useState(new Set());
  const [colorMap,         setColorMap]         = useState({});
  const [textColorMap,     setTextColorMap]     = useState({});
  const [selectedProcs,    setSelectedProcs]    = useState(new Set());
  const [projDays,         setProjDays]         = useState(() => {
    const d = parseInt(new URLSearchParams(window.location.search).get('days'), 10);
    return (d > 0 && d <= 365) ? d : 7;
  });
  const [loading,     setLoading]     = useState(false);
  const [loadingStep, setLoadingStep] = useState(''); // progress message during load
  const [projecting,  setProjecting]  = useState(false);
  const [error,       setError]       = useState(null);
  const [eventsByDay, setEventsByDay] = useState({});
  const [calView,     setCalView]     = useState(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    return ['month','week','3day','day','timeline'].includes(v) ? v : 'month';
  });
  // PKCE callback state
  const [pkceStatus,  setPkceStatus]  = useState(null); // null | 'exchanging' | 'error'
  const [pkceError,   setPkceError]   = useState('');
  const calViewRef = useRef('month');
  useEffect(() => { calViewRef.current = calView; }, [calView]);
  // Holds URL filter state captured at the start of each handleFetch call
  const pendingHiddenFiltersRef = useRef({ procs: new Set(), machines: new Set(), folders: new Set(), tags: new Set() });
  const [anchorDate,  setAnchorDate]  = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1);
  });
  const [tooltip,        setTooltip]        = useState({ event: null, pos: { x: 0, y: 0 } });
  const [sidebarOpen,    setSidebarOpen]    = useState(false); // mobile sidebar toggle
  const [machineTemplates, setMachineTemplates] = useState({}); // { machineName: slotCount }
  const [allTags,          setAllTags]          = useState([]); // sorted unique tag strings
  const [selectedTags,     setSelectedTags]     = useState(new Set());
  const [allRobots,        setAllRobots]        = useState([]); // sorted unique robot account names
  const [selectedRobots,   setSelectedRobots]   = useState(new Set());

  // Machines list derived from schedules
  const machines = useMemo(() => {
    const seen = new Set();
    const list = [];
    schedules.forEach(s => {
      const m = s.machine || 'Unassigned';
      if (!seen.has(m)) { seen.add(m); list.push({ id: m, label: m }); }
    });
    return list.sort((a, b) => a.label.localeCompare(b.label));
  }, [schedules]);

  const [selectedMachines, setSelectedMachines] = useState(new Set());

  useEffect(() => {
    if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(LS_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.uiTz, uiTimezone);
  }, [uiTimezone]);

  useEffect(() => {
    localStorage.setItem(LS_KEYS.durMin, String(defaultDurMin));
  }, [defaultDurMin]);

  useEffect(() => {
    const urlHidden = pendingHiddenFiltersRef.current.machines;
    const lsHidden  = loadHiddenSet(LS_KEYS.hiddenMachines);
    const hidden = urlHidden.size ? urlHidden : lsHidden;
    setSelectedMachines(new Set(machines.map(m => m.id).filter(id => !hidden.has(id))));
  }, [machines]);

  useEffect(() => {
    const lsHidden = loadHiddenSet(LS_KEYS.hiddenFolders);
    setSelectedFolders(new Set(folders.map(f => String(f.Id)).filter(id => !lsHidden.has(id))));
  }, [folders]);

  useEffect(() => {
    const urlHidden = pendingHiddenFiltersRef.current.tags;
    const lsHidden  = loadHiddenSet(LS_KEYS.hiddenTags);
    const hidden = urlHidden.size ? urlHidden : lsHidden;
    setSelectedTags(new Set(allTags.filter(t => !hidden.has(t))));
  }, [allTags]);

  useEffect(() => {
    const lsHidden = loadHiddenSet(LS_KEYS.hiddenRobots);
    setSelectedRobots(new Set(allRobots.filter(r => !lsHidden.has(r))));
  }, [allRobots]);

  // ── PKCE OAuth callback: detect ?code= on page load ──────────────────────
  useEffect(() => {
    const params   = new URLSearchParams(window.location.search);
    const code     = params.get('code');
    const state    = params.get('state');
    if (!code || !state) return;

    // Verify cryptographic state to prevent CSRF
    const savedState = sessionStorage.getItem(SS_KEY_PKCE_STATE);
    if (!savedState || state !== savedState) return;
    sessionStorage.removeItem(SS_KEY_PKCE_STATE);

    const isOnPrem = state.startsWith('usp_onprem_');

    const verifier = sessionStorage.getItem(SS_KEY_PKCE_VERIFIER);
    // Clean URL immediately so reloads don't re-trigger
    window.history.replaceState({}, '', window.location.pathname);
    sessionStorage.removeItem(SS_KEY_PKCE_VERIFIER);

    if (isOnPrem) {
      // On-prem PKCE callback
      const cid = localStorage.getItem(LS_KEYS.onPremClientId) || '';
      const savedUrl = localStorage.getItem(LS_KEYS.orchestratorUrl) || '';
      localStorage.removeItem('usp_onprem_mode');
      if (!verifier || !cid || !savedUrl) return;

      setPkceStatus('exchanging');
      setPkceError('');

      onPremPkceExchangeCode(code, cid, verifier, savedUrl)
        .then(token => {
          sessionStorage.setItem(SS_KEY, token);
          setCfg(c => ({ ...c, token, authMode: 'onprem', onPremClientId: cid, orchestratorUrl: savedUrl }));
          saveConfig({ ...loadConfig(), token, authMode: 'onprem', onPremClientId: cid });
          setPkceStatus(null);
        })
        .catch(err => {
          setPkceError(err.message || String(err));
          setPkceStatus('error');
        });
      return;
    }

    // Cloud PKCE callback
    const cid = localStorage.getItem(LS_KEYS.pkceClientId) || '';
    if (!verifier || !cid) return;

    setPkceStatus('exchanging');
    setPkceError('');

    pkceExchangeCode(code, cid, verifier)
      .then(token => {
        sessionStorage.setItem(SS_KEY, token);
        const savedUrl = localStorage.getItem(LS_KEYS.orchestratorUrl) || '';
        setCfg(c => ({ ...c, token, authMode: 'pkce', pkceClientId: cid, orchestratorUrl: savedUrl }));
        saveConfig({ ...loadConfig(), token, authMode: 'pkce', pkceClientId: cid });
        setPkceStatus(null);
      })
      .catch(err => {
        setPkceError(err.message || String(err));
        setPkceStatus('error');
      });
  }, []); // run once on mount

  // ── Fetch schedules + median durations ──────────────────────────────────────
  const handleFetch = useCallback(async (fetchCfg, forceRefresh = false) => {
    setLoading(true);
    setError(null);
    setSchedules([]);
    setFolders([]);
    setEventsByDay({});
    // Snapshot URL filter params at fetch start so effects can apply them consistently
    const _urlP = new URLSearchParams(window.location.search);
    pendingHiddenFiltersRef.current = {
      procs:    new Set((_urlP.get('hp') || '').split(',').filter(Boolean)),
      machines: new Set((_urlP.get('hm') || '').split(',').filter(Boolean)),
      folders:  new Set((_urlP.get('hf') || '').split(',').filter(Boolean)),
      tags:     new Set((_urlP.get('ht') || '').split(',').filter(Boolean)),
    };
    try {
      const token = fetchCfg.token || '';
      const activeCfg = { ...fetchCfg, token };

      // Step 1: discover all accessible folders
      setLoadingStep('Discovering folders…');
      let discoveredFolders = [];
      try {
        discoveredFolders = await proxyFetch({ ...activeCfg, folder: '' }, 'folders');
      } catch (e) {
        console.warn('[USV] Folder discovery failed, using root folder:', e.message);
        discoveredFolders = [{ Id: '', DisplayName: 'Default', FullyQualifiedName: 'Default' }];
      }
      if (!discoveredFolders.length) {
        discoveredFolders = [{ Id: '', DisplayName: 'Default', FullyQualifiedName: 'Default' }];
      }
      setFolders(discoveredFolders);

      // Step 2: fetch schedules from every folder in parallel
      setLoadingStep(`Fetching schedules from ${discoveredFolders.length} folder(s)…`);
      const allRaw = [];
      const seenIds = new Set();
      await Promise.allSettled(discoveredFolders.map(async folder => {
        try {
          const cfgF = { ...activeCfg, folder: String(folder.Id) };
          const rows = await fetchSchedules(cfgF);
          for (const s of rows) {
            if (!seenIds.has(s.Id)) {
              seenIds.add(s.Id);
              allRaw.push({ ...s, _folderId: String(folder.Id), _folderName: folder.DisplayName || folder.FullyQualifiedName });
            }
          }
        } catch (e) {
          console.warn('[USV] Schedule fetch failed for folder', folder.DisplayName, '—', e.message);
        }
      }));

      // Step 2b: fetch machine templates, release tags per folder (best-effort, in parallel)
      setLoadingStep('Loading machines & tags…');
      const machineMap = {}; // machineName → slotCount
      const releaseTagMap = {}; // releaseName → string[]
      const robotMap = {}; // robotId → { name, machineName, username }

      // Fetch robots at tenant level (FindAllAcrossFolders) — single call
      try {
        const robots = await proxyFetch(activeCfg, 'robotAccounts');
        for (const r of robots) {
          // Username is "pimco\\s_rpafin2" — extract just the account name
          const raw = r.Username || r.UserName || '';
          const username = raw.includes('\\') ? raw.split('\\').pop() : raw;
          if (r.Id && username) robotMap[r.Id] = { name: r.Name || username, machineName: r.MachineName || '', username };
        }
      } catch (_) { /* graceful */ }

      await Promise.allSettled(discoveredFolders.map(async f => {
        const cfgF = { ...activeCfg, folder: String(f.Id) };
        try {
          const machines = await proxyFetch(cfgF, 'machines');
          for (const m of machines) {
            const slots = m.NonProductionSlots || 0;
            const isTemplate = slots > 1 || (m.Type || '').toLowerCase().includes('template');
            if (isTemplate && m.Name) machineMap[m.Name] = slots || 2;
          }
        } catch (_) { /* graceful */ }
        try {
          const releases = await proxyFetch(cfgF, 'releaseTags');
          for (const r of releases) {
            if (!r.Name || !r.Tags?.length) continue;
            releaseTagMap[r.Name] = r.Tags.map(t => t.DisplayName || t.Name || String(t)).filter(Boolean);
          }
        } catch (_) { /* graceful */ }
      }));

      setMachineTemplates({ ...machineMap });

      // Build color map
      const cm = {};
      const tcm = {}; // text color map
      allRaw.forEach((s, i) => { cm[s.Id] = colorForIndex(i); tcm[s.Id] = textColorForIndex(i); });
      setColorMap(cm);
      setTextColorMap(tcm);
      // Restore persisted hidden procs (merged with any URL filters)
      const urlHiddenProcs = pendingHiddenFiltersRef.current.procs;
      const lsHiddenProcs  = loadHiddenSet(LS_KEYS.hiddenProcs);
      const hiddenProcs = urlHiddenProcs.size ? urlHiddenProcs : lsHiddenProcs;
      setSelectedProcs(new Set(allRaw.map(s => s.Id).filter(id => !hiddenProcs.has(id))));

      // Step 3: enrich each schedule with job history (uses cache when fresh)
      setLoadingStep(`Calculating durations for ${allRaw.length} schedule(s)…`);
      const enriched = [];
      const BATCH = 10;
      const fallbackMs = defaultDurMin * 60 * 1000;
      const medianCache = loadMedianCache();
      const now = Date.now();
      for (let i = 0; i < allRaw.length; i += BATCH) {
        const batch = allRaw.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async s => {
            let medianMs;
            const cached = medianCache[s.Id];
            if (!forceRefresh && cached && (now - cached.at < MEDIAN_TTL_MS)) {
              medianMs = cached.ms;
            } else {
              let jobs = [];
              try { jobs = await fetchJobsForSchedule({ ...activeCfg, folder: s._folderId }, s.ReleaseName || s.Name); }
              catch (e) { console.warn('[USV] Job history unavailable for', s.ReleaseName || s.Name, '—', e.message); }
              medianMs = medianDurationMs(jobs, fallbackMs);
              medianCache[s.Id] = { ms: medianMs, at: now };
            }
            const rawName = s.ReleaseName || s.Name;
            const rawArgs = s.InputArguments || null;
            // Extract machine and robot account from MachineRobots array
            let machine = null;
            let robotAccount = null;

            if (s.MachineRobots && s.MachineRobots.length > 0) {
              machine = s.MachineRobots.map(r => r.MachineName).filter(Boolean).join(', ') || null;
              // RobotUserName, or look up in robotMap by RobotId, or fallback to SessionName
              const users = s.MachineRobots.map(r => {
                if (r.RobotUserName) return r.RobotUserName;
                if (r.SessionName) return r.SessionName;
                if (r.RobotId && robotMap[r.RobotId]) return robotMap[r.RobotId].username || robotMap[r.RobotId].name;
                if (r.RobotId) return `Robot #${r.RobotId}`;
                return null;
              }).filter(Boolean);
              robotAccount = users.length ? [...new Set(users)].join(', ') : null;
            }
            return {
              id:             s.Id,
              name:           rawName,
              cron:           s.StartProcessCron,
              tz:             s.TimeZoneId,
              machine,
              robotAccount,
              inputArgs:      parseInputArgs(rawArgs),
              folderId:       s._folderId,
              folderName:     s._folderName,
              tags:           releaseTagMap[rawName] || [],
              medianMs,
            };
          })
        );
        results.forEach(r => { if (r.status === 'fulfilled') enriched.push(r.value); });
      }
      saveMedianCache(medianCache);

      // Collect all unique tags and robot accounts
      const tagSet = new Set();
      const robotSet = new Set();
      enriched.forEach(s => {
        s.tags.forEach(t => tagSet.add(t));
        if (s.robotAccount) robotSet.add(s.robotAccount);
      });
      setAllTags([...tagSet].sort());
      setAllRobots([...robotSet].sort());

      setSchedules(enriched);
      // Jump calendar to today in the current view after successful load
      const t = new Date();
      const cv = calViewRef.current;
      if (cv === 'week') {
        const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        d.setDate(d.getDate() - d.getDay());
        setAnchorDate(d);
      } else if (cv === 'day' || cv === '3day' || cv === 'timeline') {
        setAnchorDate(new Date(t.getFullYear(), t.getMonth(), t.getDate()));
      } else {
        setAnchorDate(new Date(t.getFullYear(), t.getMonth(), 1));
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
      setLoadingStep('');
    }
  }, [defaultDurMin]);

  // ── Auto-fetch on page load when credentials exist ──────────────────────────
  const hasFetchedRef = useRef(false);
  useEffect(() => {
    if (hasFetchedRef.current) return;
    if (cfg.orchestratorUrl && cfg.token) {
      hasFetchedRef.current = true;
      handleFetch(cfg);
    }
  }, [cfg, handleFetch]);

  // ── Project CRON events whenever schedules, filters, or projDays change ─────
  // ── Pre-compute ALL projections once (expensive CRON work, only re-runs when schedules/projDays/tz change) ──
  const allProjections = useMemo(() => {
    if (!schedules.length) return [];
    return schedules.map(s => {
      if (!s.cron) return { schedule: s, occurrences: [] };
      const occurrences = projectSchedule(s.cron, s.tz, projDays, s.medianMs, uiTimezone);
      return { schedule: s, occurrences };
    });
  }, [schedules, projDays, uiTimezone]);

  // ── Filter and build eventsByDay (cheap, runs on every filter toggle) ──
  useEffect(() => {
    if (!allProjections.length) { setEventsByDay({}); return; }
    setProjecting(true);

    const rafId = requestAnimationFrame(() => {
      const byDay = {};

      for (const { schedule: s, occurrences } of allProjections) {
        if (!selectedProcs.has(s.id)) continue;
        if (!selectedMachines.has(s.machine || 'Unassigned')) continue;
        if (selectedFolders.size > 0 && !selectedFolders.has(s.folderId || '')) continue;
        if (s.tags.length > 0 && !s.tags.every(t => selectedTags.has(t))) continue;
        if (s.robotAccount && !selectedRobots.has(s.robotAccount)) continue;

        for (const occ of occurrences) {
          const key = dayKey(occ.start, uiTimezone);
          if (!byDay[key]) byDay[key] = [];
          byDay[key].push({ schedule: s, occurrence: occ });
        }
      }

      // Sort events within each day by start time
      Object.values(byDay).forEach(arr =>
        arr.sort((a, b) => a.occurrence.start - b.occurrence.start)
      );

      // Overlap detection — warn when a process starts before the previous one ends on the same machine+robot
      const allEvents = Object.values(byDay).flat();
      const byMachineRobot = {};
      allEvents.forEach(ev => {
        const key = (ev.schedule.machine || 'Unassigned') + '|' + (ev.schedule.robotAccount || '');
        if (!byMachineRobot[key]) byMachineRobot[key] = [];
        byMachineRobot[key].push(ev);
      });
      Object.values(byMachineRobot).forEach(evts => {
        evts.sort((a, b) => a.occurrence.start - b.occurrence.start);
        for (let i = 0; i < evts.length - 1; i++) {
          // Next event starts before current event's estimated end
          if (evts[i + 1].occurrence.start < evts[i].occurrence.end) {
            evts[i].gapWarning = true;
          }
        }
      });

      setEventsByDay(byDay);
      setProjecting(false);
    });

    return () => cancelAnimationFrame(rafId);
  }, [allProjections, selectedProcs, selectedMachines, selectedFolders, selectedTags, selectedRobots, uiTimezone]);

  // ── Toggle helpers — persist hidden (unchecked) items ─────────────────────────
  function persistHidden(allIds, selectedSet, lsKey) {
    const hidden = allIds.filter(id => !selectedSet.has(id));
    localStorage.setItem(lsKey, hidden.length ? JSON.stringify(hidden) : '');
  }
  const toggleProc = id => setSelectedProcs(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id);
    persistHidden(procItems.map(i => i.id), n, LS_KEYS.hiddenProcs);
    return n;
  });
  const toggleMachine = id => setSelectedMachines(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id);
    persistHidden(machines.map(i => i.id), n, LS_KEYS.hiddenMachines);
    return n;
  });
  const toggleFolder = id => setSelectedFolders(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id);
    persistHidden(folderItems.map(i => i.id), n, LS_KEYS.hiddenFolders);
    return n;
  });
  const toggleTag = id => setSelectedTags(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id);
    persistHidden(tagItems.map(i => i.id), n, LS_KEYS.hiddenTags);
    return n;
  });
  const toggleRobot = id => setSelectedRobots(p => {
    const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id);
    persistHidden(robotItems.map(i => i.id), n, LS_KEYS.hiddenRobots);
    return n;
  });
  // Batch select all / none (more efficient than toggling each)
  const selectAllProcs = () => { setSelectedProcs(new Set(procItems.map(i => i.id))); localStorage.removeItem(LS_KEYS.hiddenProcs); };
  const selectNoneProcs = () => { setSelectedProcs(new Set()); localStorage.setItem(LS_KEYS.hiddenProcs, JSON.stringify(procItems.map(i => i.id))); };
  const selectAllMachines = () => { setSelectedMachines(new Set(machines.map(i => i.id))); localStorage.removeItem(LS_KEYS.hiddenMachines); };
  const selectNoneMachines = () => { setSelectedMachines(new Set()); localStorage.setItem(LS_KEYS.hiddenMachines, JSON.stringify(machines.map(i => i.id))); };
  const selectAllFolders = () => { setSelectedFolders(new Set(folderItems.map(i => i.id))); localStorage.removeItem(LS_KEYS.hiddenFolders); };
  const selectNoneFolders = () => { setSelectedFolders(new Set()); localStorage.setItem(LS_KEYS.hiddenFolders, JSON.stringify(folderItems.map(i => i.id))); };
  const selectAllTags = () => { setSelectedTags(new Set(tagItems.map(i => i.id))); localStorage.removeItem(LS_KEYS.hiddenTags); };
  const selectNoneTags = () => { setSelectedTags(new Set()); localStorage.setItem(LS_KEYS.hiddenTags, JSON.stringify(tagItems.map(i => i.id))); };
  const selectAllRobots = () => { setSelectedRobots(new Set(robotItems.map(i => i.id))); localStorage.removeItem(LS_KEYS.hiddenRobots); };
  const selectNoneRobots = () => { setSelectedRobots(new Set()); localStorage.setItem(LS_KEYS.hiddenRobots, JSON.stringify(robotItems.map(i => i.id))); };

  // ── Tooltip handlers ─────────────────────────────────────────────────────────
  const handleHover  = useCallback((event, pos) => setTooltip({ event, pos }), []);
  const handleLeave  = useCallback(() => setTooltip({ event: null, pos: { x: 0, y: 0 } }), []);

  const handleConnSave = useCallback((newCfg) => {
    setCfg(newCfg);
    handleFetch(newCfg);
  }, [handleFetch]);

  // ── View switching: always re-centre on today ─────────────────────────────────
  function switchView(v) {
    setCalView(v);
    const t = new Date();
    if (v === 'month') {
      setAnchorDate(new Date(t.getFullYear(), t.getMonth(), 1));
    } else if (v === 'week') {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      d.setDate(d.getDate() - d.getDay());
      setAnchorDate(d);
    } else {
      setAnchorDate(new Date(t.getFullYear(), t.getMonth(), t.getDate()));
    }
  }

  // ── Navigation (prev / next / today) ─────────────────────────────────────────
  function navigate(dir) {
    setAnchorDate(a => {
      if (calView === 'month') return new Date(a.getFullYear(), a.getMonth() + dir, 1);
      const n = calView === 'week' ? 7 : calView === '3day' ? 3 : 1;
      return addDays(a, n * dir);
    });
  }
  function goToday() {
    const t = new Date();
    if (calView === 'month') {
      setAnchorDate(new Date(t.getFullYear(), t.getMonth(), 1));
    } else if (calView === 'week') {
      const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
      d.setDate(d.getDate() - d.getDay());
      setAnchorDate(d);
    } else {
      setAnchorDate(new Date(t.getFullYear(), t.getMonth(), t.getDate()));
    }
  }

  // ── Keyboard shortcuts (←/→ navigate, Home = today) ─────────────────────────
  useEffect(() => {
    function handleKey(e) {
      // Don't capture when user is typing in an input/select/textarea
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft')  { e.preventDefault(); navigate(-1); }
      if (e.key === 'ArrowRight') { e.preventDefault(); navigate(1); }
      if (e.key === 'Home')       { e.preventDefault(); goToday(); }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  // ── Derive days array for time-grid and timeline views ───────────────────────
  const viewDays = useMemo(() => {
    if (calView === 'month') return [];
    const count = calView === 'week' ? 7 : calView === '3day' ? 3 : 1; // timeline + day both = 1
    return Array.from({ length: count }, (_, i) => addDays(anchorDate, i));
  }, [calView, anchorDate]);

  // ── Navigation label ──────────────────────────────────────────────────────────
  const navLabel = useMemo(() => {
    if (calView === 'month') {
      return anchorDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    }
    if (calView === 'day' || calView === 'timeline') {
      return anchorDate.toLocaleDateString('default', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    }
    const first = viewDays[0], last = viewDays[viewDays.length - 1];
    if (!first || !last) return '';
    const sameMonth = first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear();
    const start = first.toLocaleDateString('default', { month: 'short', day: 'numeric' });
    const end   = sameMonth
      ? `${last.getDate()}, ${last.getFullYear()}`
      : last.toLocaleDateString('default', { month: 'short', day: 'numeric', year: 'numeric' });
    return `${start} – ${end}`;
  }, [calView, anchorDate, viewDays]);

  // ── Stats ─────────────────────────────────────────────────────────────────────
  const totalEvents  = useMemo(() => Object.values(eventsByDay).reduce((s, a) => s + a.length, 0), [eventsByDay]);
  const windowEvents = useMemo(() => {
    if (calView === 'month') {
      const k = dayKey(anchorDate, uiTimezone);
      const prefix = k.slice(0, k.lastIndexOf('-') + 1); // "Y-M0-"
      return Object.entries(eventsByDay)
        .filter(([key]) => key.startsWith(prefix))
        .reduce((s, [, a]) => s + a.length, 0);
    }
    return viewDays.reduce((s, d) => s + (eventsByDay[dayKey(d, uiTimezone)] || []).length, 0);
  }, [eventsByDay, calView, anchorDate, viewDays, uiTimezone]);

  const procItems    = useMemo(() => schedules.map(s => ({ id: s.id, label: s.name })).sort((a, b) => a.label.localeCompare(b.label)), [schedules]);
  const folderItems  = useMemo(() => folders.map(f => ({ id: String(f.Id), label: f.DisplayName || f.FullyQualifiedName || String(f.Id) })).sort((a, b) => a.label.localeCompare(b.label)), [folders]);
  const tagItems     = useMemo(() => allTags.map(t => ({ id: t, label: t })).sort((a, b) => a.label.localeCompare(b.label)), [allTags]);
  const robotItems   = useMemo(() => allRobots.map(r => ({ id: r, label: r })).sort((a, b) => a.label.localeCompare(b.label)), [allRobots]);
  const showSkeleton = loading || projecting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

      {/* ── Header ── */}
      <header className="app-header" role="banner">
        {/* Mobile sidebar toggle */}
        {schedules.length > 0 && (
          <button className="sidebar-toggle" onClick={() => setSidebarOpen(o => !o)}
            aria-label="Toggle sidebar">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>
            </svg>
          </button>
        )}
        {/* Logo / title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <div style={{ width: 28, height: 28, borderRadius: 6, background: '#FA4616', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
              <line x1="16" y1="2" x2="16" y2="6"/>
              <line x1="8" y1="2" x2="8" y2="6"/>
              <line x1="3" y1="10" x2="21" y2="10"/>
              <line x1="8" y1="14" x2="8.01" y2="14"/>
              <line x1="12" y1="14" x2="12.01" y2="14"/>
              <line x1="16" y1="14" x2="16.01" y2="14"/>
              <line x1="8" y1="18" x2="8.01" y2="18"/>
              <line x1="12" y1="18" x2="12.01" y2="18"/>
              <line x1="16" y1="18" x2="16.01" y2="18"/>
            </svg>
          </div>
          <span style={{ fontWeight: 700, fontSize: 16, color: 'var(--c-text)', letterSpacing: '.02em' }}>
            UiPath Job Schedules
          </span>
        </div>

        {/* Connection popover */}
        <Popover align="left" trigger={({ open, toggle }) => (
          <button className="btn-ghost" onClick={toggle}
            style={{ display: 'flex', alignItems: 'center', gap: 6,
              background: open ? 'var(--c-border)' : '' }}>
            {(() => {
              const ok = !!cfg.token;
              return (
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: ok ? '#00C48C' : '#FA4616',
                  boxShadow: ok ? '0 0 5px #00C48C88' : '0 0 5px #FA461688',
                }} />
              );
            })()}
            Connection
          </button>
        )}>
          {({ close }) => (
            <ConnectionPopover cfg={cfg} onSave={handleConnSave} loading={loading} onClose={close} />
          )}
        </Popover>

        {/* Settings popover */}
        <Popover align="right" trigger={({ open, toggle }) => (
          <button className="theme-toggle" onClick={toggle} title="Settings"
            style={{ background: open ? 'var(--c-border)' : '' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
            </svg>
          </button>
        )}>
          {({ close }) => (
            <SettingsPopover
              projDays={projDays} onProjDays={setProjDays}
              defaultDurMin={defaultDurMin} onDurMin={setDefaultDurMin}
              theme={theme} onTheme={setTheme}
              uiTimezone={uiTimezone} onTimezone={setUiTimezone}
              onClose={close}
            />
          )}
        </Popover>

        {/* View switcher */}
        <div className="view-switcher">
          {[
            { key: 'month',    label: 'Month'    },
            { key: 'week',     label: 'Week'     },
            { key: '3day',     label: '3 Day'    },
            { key: 'day',      label: 'Day'      },
            { key: 'timeline', label: 'Timeline' },
          ].map(v => (
            <button key={v.key}
              className={`view-btn${calView === v.key ? ' active' : ''}`}
              aria-pressed={calView === v.key}
              aria-label={`${v.label} view`}
              onClick={() => switchView(v.key)}>
              {v.label}
            </button>
          ))}
        </div>

        {/* Stats */}
        {!loading && schedules.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--c-muted)', flexWrap: 'wrap' }}>
            <span><strong style={{ color: 'var(--c-blue)' }}>{schedules.length}</strong> schedules</span>
            <span><strong style={{ color: '#FA4616' }}>{totalEvents}</strong> projected</span>
            <span><strong style={{ color: 'var(--c-text)' }}>{windowEvents}</strong> in view</span>
          </div>
        )}

        {/* Refresh (fast, uses duration cache) + Full Refresh */}
        {schedules.length > 0 && (
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn-primary" onClick={() => handleFetch(cfg, false)} disabled={loading}
              title="Re-fetch schedules (uses cached job durations for speed)">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
              Refresh
            </button>
            <button className="btn-ghost" onClick={() => handleFetch(cfg, true)} disabled={loading}
              title="Full refresh — re-fetches job history for accurate durations" style={{ padding: '5px 8px' }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                <polyline points="23 4 23 10 17 10"/>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
              </svg>
            </button>
          </div>
        )}
      </header>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Sidebar — only visible when data is loaded or loading ── */}
        {(schedules.length > 0 || loading) && (
          <>
          <div className={`sidebar-backdrop${sidebarOpen ? ' visible' : ''}`}
            onClick={() => setSidebarOpen(false)} />
          <aside className={`sidebar${sidebarOpen ? ' open' : ''}`} role="complementary" aria-label="Filters">
            {schedules.length > 0 && (
              <>
                <CollapsibleSection title="Processes" badge={procItems.length} defaultOpen>
                  <FilterList
                    label=""
                    items={procItems}
                    selected={selectedProcs}
                    onToggle={toggleProc}
                    onSelectAll={selectAllProcs}
                    onSelectNone={selectNoneProcs}
                    colorMap={colorMap}
                  />
                </CollapsibleSection>
                {machines.length > 0 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Machines" badge={machines.length} defaultOpen={false}>
                      <FilterList
                        label=""
                        items={machines}
                        selected={selectedMachines}
                        onToggle={toggleMachine}
                        onSelectAll={selectAllMachines}
                        onSelectNone={selectNoneMachines}
                      />
                    </CollapsibleSection>
                  </>
                )}
                {folderItems.length > 1 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Folders" badge={folderItems.length} defaultOpen={false}>
                      <FilterList
                        label=""
                        items={folderItems}
                        selected={selectedFolders}
                        onToggle={toggleFolder}
                        onSelectAll={selectAllFolders}
                        onSelectNone={selectNoneFolders}
                      />
                    </CollapsibleSection>
                  </>
                )}
                {tagItems.length > 0 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Tags" badge={tagItems.length} defaultOpen={false}>
                      <div className="field-hint" style={{ marginBottom: 6 }}>Uncheck a tag to hide those jobs</div>
                      <FilterList
                        label=""
                        items={tagItems}
                        selected={selectedTags}
                        onToggle={toggleTag}
                        onSelectAll={selectAllTags}
                        onSelectNone={selectNoneTags}
                      />
                    </CollapsibleSection>
                  </>
                )}
                {robotItems.length > 0 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Robot Accounts" badge={robotItems.length} defaultOpen={false}>
                      <div className="field-hint" style={{ marginBottom: 6 }}>Filter by execution robot account</div>
                      <FilterList
                        label=""
                        items={robotItems}
                        selected={selectedRobots}
                        onToggle={toggleRobot}
                        onSelectAll={selectAllRobots}
                        onSelectNone={selectNoneRobots}
                      />
                    </CollapsibleSection>
                  </>
                )}
              </>
            )}

            {/* Skeleton sidebar items while loading */}
            {loading && (
              <>
                <div className="section-label" style={{ marginTop: 4 }}>Processes</div>
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <div className="skeleton" style={{ width: 14, height: 14, borderRadius: 3 }} />
                    <div className="skeleton" style={{ width: 10, height: 10, borderRadius: '50%' }} />
                    <div className="skeleton" style={{ flex: 1, height: 12 }} />
                  </div>
                ))}
              </>
            )}
          </aside>
          </>
        )}

        {/* ── Main content ── */}
        <main style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* Empty state */}
          {!loading && !error && schedules.length === 0 && pkceStatus !== 'exchanging' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16, color: 'var(--c-muted)' }}>
              {!cfg.token ? (
                <div style={{ padding: '20px 24px', background: 'rgba(250,70,22,.08)',
                  border: '1px solid rgba(250,70,22,.3)', borderRadius: 10, maxWidth: 420, textAlign: 'center' }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>🔒</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: '#FA4616', marginBottom: 8 }}>Not connected</div>
                  <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--c-text)' }}>
                    Click <strong>Connection</strong> in the header to authenticate with UiPath.
                    Supports <strong>PAT</strong> or <strong>UiPath OAuth (PKCE)</strong> for browser-based sign-in.
                  </div>
                </div>
              ) : (
                <>
                  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--c-border)" strokeWidth="1.5">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8"  y1="2" x2="8"  y2="6"/>
                    <line x1="3"  y1="10" x2="21" y2="10"/>
                  </svg>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: 'var(--c-text)' }}>No schedules loaded</div>
                    <div style={{ fontSize: 13 }}>Click <strong>Connection</strong> to sign in. Data loads automatically.</div>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#00C48C' }}>✓ Token configured</div>
                  </div>
                </>
              )}
            </div>
          )}
          {/* PKCE exchanging indicator */}
          {pkceStatus === 'exchanging' && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 14 }}>
              <div className="skeleton" style={{ width: 48, height: 48, borderRadius: '50%' }} />
              <div style={{ fontSize: 14, color: 'var(--c-muted)' }}>Exchanging authorization code…</div>
            </div>
          )}

          {/* Calendar nav bar */}
          {(schedules.length > 0 || showSkeleton) && (
            <div className="month-nav" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <button onClick={() => navigate(-1)} aria-label="Previous period">‹</button>
              <span style={{ fontWeight: 700, fontSize: 16, minWidth: 180, textAlign: 'center', color: 'var(--c-text)' }}>
                {showSkeleton
                  ? <span className="skeleton" style={{ display: 'inline-block', width: 160, height: 18 }} />
                  : navLabel}
              </span>
              <button onClick={() => navigate(1)} aria-label="Next period">›</button>
              <button className="btn-ghost" onClick={goToday} aria-label="Go to today">Today</button>
            </div>
          )}

          {/* Calendar grid / time-grid */}
          {showSkeleton && loadingStep && (
            <div style={{ textAlign: 'center', padding: '18px 0 8px', color: 'var(--c-muted)', fontSize: 13, fontWeight: 500, letterSpacing: '.01em' }}>
              {loadingStep}
            </div>
          )}
          {showSkeleton && calView === 'month' && <CalendarSkeleton />}
          {showSkeleton && calView !== 'month' && (
            <div style={{ display: 'flex', gap: 2 }}>
              {Array.from({ length: calView === 'week' ? 7 : calView === '3day' ? 3 : 1 }).map((_, i) => (
                <div key={i} style={{ flex: 1, minHeight: 400, background: 'var(--c-surface)',
                  border: '1px solid var(--c-border)', borderRadius: 4, padding: 8 }}>
                  <div className="skeleton" style={{ width: '40%', height: 12, marginBottom: 8 }} />
                  <div className="skeleton" style={{ width: '70%', height: 16, marginBottom: 6 }} />
                  <div className="skeleton" style={{ width: '55%', height: 16 }} />
                </div>
              ))}
            </div>
          )}

          {!showSkeleton && schedules.length > 0 && calView === 'month' && (
            <CalendarMonth
              month={anchorDate}
              eventsByDay={eventsByDay}
              colorMap={colorMap}
              textColorMap={textColorMap}
              onHover={handleHover}
              onLeave={handleLeave}
              uiTimezone={uiTimezone}
            />
          )}
          {!showSkeleton && schedules.length > 0 && calView !== 'month' && calView !== 'timeline' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)', minHeight: 400 }}>
              <CalendarTimeGrid
                days={viewDays}
                eventsByDay={eventsByDay}
                colorMap={colorMap}
                textColorMap={textColorMap}
                onHover={handleHover}
                onLeave={handleLeave}
                uiTimezone={uiTimezone}
                machineTemplates={machineTemplates}
              />
            </div>
          )}
          {!showSkeleton && schedules.length > 0 && calView === 'timeline' && (
            <div style={{ height: 'calc(100vh - 160px)', minHeight: 400, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
              <CalendarTimeline
                days={viewDays}
                eventsByDay={eventsByDay}
                colorMap={colorMap}
                textColorMap={textColorMap}
                onHover={handleHover}
                onLeave={handleLeave}
                uiTimezone={uiTimezone}
                machineTemplates={machineTemplates}
              />
            </div>
          )}
        </main>
      </div>

      {/* Tooltip portal */}
      <Tooltip event={tooltip.event} pos={tooltip.pos} uiTimezone={uiTimezone} machineTemplates={machineTemplates} />

      {/* Toast portal – fixed top-right */}
      <Toast error={error} onClose={() => setError(null)} />

      {/* PKCE error overlay */}
      {pkceStatus === 'error' && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(4,14,25,.88)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }}>
          <div style={{
            background: '#162536', border: '1px solid rgba(250,70,22,.4)',
            borderRadius: 12, padding: '28px 32px', width: 380,
            boxShadow: '0 4px 12px rgba(0,0,0,.5)',
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: '#FA4616', marginBottom: 8 }}>OAuth Error</div>
            <div style={{ fontSize: 12, color: 'var(--c-text)', marginBottom: 20, lineHeight: 1.6 }}>{pkceError}</div>
            <button className="btn-ghost" onClick={() => setPkceStatus(null)} style={{ width: '100%', justifyContent: 'center' }}>
              Dismiss
            </button>
          </div>
        </div>
      )}

    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
