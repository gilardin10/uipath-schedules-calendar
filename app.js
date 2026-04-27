// UiPath Job Schedules – Apollo Dark Mode
// React 18 + Babel standalone + cron-parser + Lucide

const { useState, useEffect, useRef, useCallback, useMemo } = React;

// ─── Palette for process color-coding (cycles) ───────────────────────────────
const PALETTE = [
  '#FA4616','#00AEEF','#7B61FF','#00C48C','#FFB800',
  '#FF6B9D','#00E5CC','#FF9F43','#A29BFE','#55EFC4',
  '#FD79A8','#74B9FF','#FDCB6E','#6C5CE7','#00B894',
];

function colorForIndex(i) { return PALETTE[i % PALETTE.length]; }

// ─── localStorage / sessionStorage helpers ────────────────────────────────────
const LS_KEYS = { url: 'usp_url', tenant: 'usp_tenant', folder: 'usp_folder', prefix: 'usp_prefix', theme: 'usp_theme', uiTz: 'usp_ui_tz', durMin: 'usp_dur_min' };
const SS_KEY  = 'usp_token';


function loadConfig() {
  const storedPrefix = localStorage.getItem(LS_KEYS.prefix);
  return {
    url:       localStorage.getItem(LS_KEYS.url)    || '',
    tenant:    localStorage.getItem(LS_KEYS.tenant) || 'Default',
    folder:    localStorage.getItem(LS_KEYS.folder) || '',
    apiPrefix: storedPrefix !== null ? storedPrefix : '/orchestrator_',
    token:     sessionStorage.getItem(SS_KEY)        || '',
  };
}
function saveConfig({ url, tenant, folder, apiPrefix, token }) {
  localStorage.setItem(LS_KEYS.url,    url);
  localStorage.setItem(LS_KEYS.tenant, tenant);
  localStorage.setItem(LS_KEYS.folder, folder);
  localStorage.setItem(LS_KEYS.prefix, apiPrefix);
  sessionStorage.setItem(SS_KEY, token);
}

// ─── API helpers — calls our Cloudflare Pages Function proxy ─────────────────
// The PAT is sent in the Authorization header to our own same-origin endpoint.
// Orchestrator is contacted server-side; no CORS proxy required.
async function proxyFetch(cfg, action, extra = {}) {
  const res = await fetch('/api/fetch-uipath', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      action,
      orchestratorUrl: cfg.url,
      tenant:          cfg.tenant,
      folder:          cfg.folder,
      apiPrefix:       cfg.apiPrefix,
      ...extra,
    }),
  });
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

  if (!data.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data.value;
}

async function fetchSchedules(cfg)                       { return proxyFetch(cfg, 'schedules'); }
async function fetchJobsForSchedule(cfg, releaseName)    { return proxyFetch(cfg, 'jobs', { releaseName }); }

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
    const now = new Date();
    const end = new Date(now.getTime() + days * 86400000);
    const opts = { startAt: now, stopAt: end };
    const ianaZone = toIanaTimezone(tzId) || toIanaTimezone(uiTimezone);
    if (ianaZone) opts.timezone = ianaZone;
    const job = Cron(norm, opts);
    const dates = job.nextRuns(2000, now);
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

// ─── Collapsible sidebar section ─────────────────────────────────────────────
function CollapsibleSection({ title, children, defaultOpen = true, badge }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ marginBottom: 2 }}>
      <button className="collapsible-btn" onClick={() => setOpen(o => !o)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span className="section-label" style={{ margin: 0 }}>{title}</span>
          {badge && (
            <span style={{ fontSize: 10, background: '#00C48C', color: '#040E19',
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
      {open && <div style={{ paddingTop: 6, paddingBottom: 4 }}>{children}</div>}
    </div>
  );
}

// ─── Event-column layout (greedy, avoids overlaps) ────────────────────────────
function computeEventCols(events) {
  if (!events.length) return [];
  const sorted = [...events].sort((a, b) => a.occurrence.start - b.occurrence.start);
  const colEnds = []; // track the end-time of the last event in each column
  const assignments = sorted.map(ev => {
    let col = colEnds.findIndex(end => ev.occurrence.start >= end);
    if (col === -1) col = colEnds.length;
    colEnds[col] = ev.occurrence.end;
    return col;
  });
  const totalCols = colEnds.length || 1;
  return sorted.map((ev, i) => ({ ev, col: assignments[i], totalCols }));
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
function Tooltip({ event, pos, uiTimezone }) {
  if (!event) return null;
  const { schedule, occurrence } = event;
  const dur = occurrence.end - occurrence.start;
  const humanCron = cronToHuman(schedule.cron);
  const argEntries = schedule.inputArgs ? Object.entries(schedule.inputArgs) : [];
  return (
    <div className="tooltip" style={{ left: pos.x + 12, top: pos.y + 12 }}>
      <div className="tooltip-title">{schedule.name}</div>
      {event.gapWarning && (
        <div className="tooltip-row tooltip-warn">
          <span>⚠ Less than 5 min before next job on this machine</span>
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
          <span className="tooltip-value">{schedule.machine}</span>
        </div>
      )}
      {schedule.serviceAccount && (
        <div className="tooltip-row">
          <span className="tooltip-label">Account</span>
          <span className="tooltip-value">{schedule.serviceAccount}</span>
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

// ─── Toast notification ───────────────────────────────────────────────────────
function Toast({ error, onClose }) {
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
      </div>
    </div>
  );
}

// ─── Event chip ───────────────────────────────────────────────────────────────
function EventChip({ event, color, onHover, onLeave, uiTimezone }) {
  return (
    <button
      className="event-chip"
      style={{ background: color + '33', color, borderLeft: `3px solid ${color}` }}
      onMouseEnter={e => onHover(event, { x: e.clientX, y: e.clientY })}
      onMouseMove={e => onHover(event,  { x: e.clientX, y: e.clientY })}
      onMouseLeave={onLeave}
    >
      {event.gapWarning && <span className="gap-warn-icon" title="Less than 5 min gap to next job">⚠</span>}
      {fmtTime(event.occurrence.start, uiTimezone)} {event.schedule.name}
    </button>
  );
}

// ─── Calendar day cell ────────────────────────────────────────────────────────
const MAX_VISIBLE = 3;
function CalDay({ date, events, colorMap, isToday, isOtherMonth, onHover, onLeave, uiTimezone }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? events : events.slice(0, MAX_VISIBLE);
  const overflow = events.length - MAX_VISIBLE;

  return (
    <div className={`cal-day${isToday ? ' today' : ''}${isOtherMonth ? ' other-month' : ''}`}>
      <div className="cal-day-num">{date.getDate()}</div>
      {visible.map((ev, i) => (
        <EventChip
          key={i}
          event={ev}
          color={colorMap[ev.schedule.id] || 'var(--c-muted)'}
          onHover={onHover}
          onLeave={onLeave}
          uiTimezone={uiTimezone}
        />
      ))}
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
    </div>
  );
}

// ─── Calendar month view ──────────────────────────────────────────────────────
const WEEK_DAYS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function CalendarMonth({ month, eventsByDay, colorMap, onHover, onLeave, uiTimezone }) {
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
const HOUR_H = 52; // px per hour row

function CalendarTimeGrid({ days, eventsByDay, colorMap, onHover, onLeave, uiTimezone }) {
  const scrollRef = useRef(null);
  const today = new Date();

  // Scroll to show 07:00 on first render
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 7 * HOUR_H;
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
        <div className="tg-gutter" />
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
        <div className="tg-body" style={{ height: 24 * HOUR_H }}>

          {/* Time gutter */}
          <div className="tg-time-col" style={{ height: 24 * HOUR_H }}>
            {Array.from({ length: 24 }, (_, h) => (
              h === 0 ? null : (
                <div key={h} className="tg-time-label" style={{ top: h * HOUR_H }}>
                  {String(h).padStart(2, '0')}:00
                </div>
              )
            ))}
          </div>

          {/* Day columns */}
          {days.map((date, di) => {
            const key     = dayKey(date, uiTimezone);
            const events  = eventsByDay[key] || [];
            const laid    = computeEventCols(events);
            const isToday = sameDay(date, today, uiTimezone);
            const nowMin  = isToday ? nowMinInTz() : null;

            return (
              <div key={di} className="tg-col"
                style={{ background: isToday ? 'var(--c-today-tint)' : 'transparent' }}>

                {/* Hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={h} className="tg-hour-line" style={{ top: h * HOUR_H }} />
                ))}
                {/* Half-hour lines */}
                {Array.from({ length: 24 }, (_, h) => (
                  <div key={`h${h}`} className="tg-half-line" style={{ top: h * HOUR_H + HOUR_H / 2 }} />
                ))}

                {/* Current-time indicator */}
                {nowMin !== null && (
                  <div className="tg-now-line" style={{ top: (nowMin / 60) * HOUR_H }}>
                    <div className="tg-now-dot" />
                  </div>
                )}

                {/* Events */}
                {laid.map(({ ev, col, totalCols }, i) => {
                  const startMin = eventStartMin(ev.occurrence.start);
                  const durMin   = Math.max((ev.occurrence.end - ev.occurrence.start) / 60000, 15);
                  const topPx    = (startMin / 60) * HOUR_H;
                  const heightPx = Math.max((durMin / 60) * HOUR_H - 2, 18);
                  const color    = colorMap[ev.schedule.id] || 'var(--c-muted)';
                  const pct      = 100 / totalCols;
                  return (
                    <div key={i} className="tg-event"
                      style={{
                        top: topPx + 1, height: heightPx,
                        left: `${col * pct}%`,
                        width: `${pct}%`,
                        background: color + '28',
                        borderLeft: `3px solid ${color}`,
                        color,
                      }}
                      onMouseEnter={e => onHover(ev, { x: e.clientX, y: e.clientY })}
                      onMouseMove={e  => onHover(ev, { x: e.clientX, y: e.clientY })}
                      onMouseLeave={onLeave}>
                      {heightPx >= 28 && <div className="tg-event-time">{fmtTime(ev.occurrence.start, uiTimezone)}</div>}
                      <div className="tg-event-name">
                        {ev.gapWarning && <span className="gap-warn-icon" title="Less than 5 min gap to next job">⚠</span>}
                        {ev.schedule.name}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── Sidebar multi-select filter ──────────────────────────────────────────────
function FilterList({ label, items, selected, onToggle, colorMap }) {
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
          onClick={() => items.forEach(it => !selected.has(it.id) && onToggle(it.id))}>
          All
        </button>
        <button className="btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }}
          onClick={() => items.forEach(it => selected.has(it.id) && onToggle(it.id))}>
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
    function onKey(e) { if (e.key === 'Escape') setOpen(false); }
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
        <div className={`popover${align === 'right' ? ' popover-right' : ''}`}>
          {typeof children === 'function' ? children({ close }) : children}
        </div>
      )}
    </div>
  );
}

// ─── Connection popover ───────────────────────────────────────────────────────
function ConnectionPopover({ cfg, onSave, loading, onClose }) {
  const [local, setLocal] = useState(cfg);
  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  const previewUrl = local.url && local.tenant
    ? `${local.url.replace(/\/$/, '')}/${local.tenant}${local.apiPrefix || ''}/odata/ProcessSchedules`
    : null;

  function handleSave() {
    saveConfig(local);
    onSave(local);
    onClose();
  }

  return (
    <>
      <div className="popover-header">Connection</div>
      <div className="popover-body">
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Orchestrator URL
            <HintIcon text="Base URL of your UiPath Cloud or on-prem instance, e.g. https://cloud.uipath.com/myorg" />
          </div>
          <input type="text" value={local.url} onChange={e => set('url', e.target.value)}
            placeholder="https://cloud.uipath.com/org" />
        </div>
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Tenant
            <HintIcon text="Orchestrator tenant name, visible in the URL after the org segment. Usually 'Default'." />
          </div>
          <input type="text" value={local.tenant} onChange={e => set('tenant', e.target.value)}
            placeholder="Default" />
        </div>
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            API Path Prefix
            <HintIcon text="Cloud Orchestrator: /orchestrator_  ·  On-prem: leave blank." />
          </div>
          <input type="text" value={local.apiPrefix} onChange={e => set('apiPrefix', e.target.value)}
            placeholder="/orchestrator_" />
          <div className="field-hint">
            <strong style={{ color: 'var(--c-blue)' }}>Cloud:</strong> /orchestrator_
            &nbsp;·&nbsp;
            <strong style={{ color: 'var(--c-blue)' }}>On-prem:</strong> leave blank
          </div>
        </div>
        {previewUrl && (
          <div className="url-preview">
            <div className="url-preview-label">URL Preview</div>
            <div className="url-preview-value">{previewUrl}</div>
          </div>
        )}
        <div className="modal-field">
          <TokenField value={local.token} onChange={v => set('token', v)} />
        </div>
        <div className="field-hint">
          URL &amp; Tenant saved to localStorage. Token in sessionStorage only — cleared on tab close.
          All API calls go through the server-side proxy; your PAT never leaves this domain.
        </div>
      </div>
      <div className="popover-footer">
        <button className="btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn-primary" onClick={handleSave}
          disabled={loading || !local.url || !local.token}
          style={{ flex: 1, justifyContent: 'center' }}>
          {loading ? 'Loading…' : 'Save & Fetch'}
        </button>
      </div>
    </>
  );
}

// ─── Settings popover ─────────────────────────────────────────────────────────
function SettingsPopover({ projDays, onProjDays, defaultDurMin, onDurMin, theme, onTheme, uiTimezone, onTimezone, onClose }) {
  const tzList = useMemo(() => {
    try { return Intl.supportedValuesOf('timeZone'); } catch (_) { return []; }
  }, []);
  return (
    <>
      <div className="popover-header">Settings</div>
      <div className="popover-body">
        <div className="modal-field">
          <div className="field-label" style={{ display: 'flex', alignItems: 'center' }}>
            Projection Period
            <HintIcon text="How many days ahead to compute scheduled run occurrences. Longer periods use more CPU." />
          </div>
          <select value={projDays} onChange={e => onProjDays(Number(e.target.value))}>
            {[7, 14, 30, 60].map(d => <option key={d} value={d}>{d} days</option>)}
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
            <HintIcon text="IANA timezone for your calendar display. All event times are converted to this zone. e.g. America/New_York" />
          </div>
          <input type="text" list="tz-datalist" value={uiTimezone}
            onChange={e => onTimezone(e.target.value)}
            placeholder="e.g. America/New_York" />
          {tzList.length > 0 && (
            <datalist id="tz-datalist">
              {tzList.map(tz => <option key={tz} value={tz} />)}
            </datalist>
          )}
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
    const tzUrl = new URLSearchParams(window.location.search).get('tz');
    if (tzUrl) return tzUrl;
    return localStorage.getItem(LS_KEYS.uiTz) || Intl.DateTimeFormat().resolvedOptions().timeZone;
  });
  const [defaultDurMin,    setDefaultDurMin]    = useState(() => Number(localStorage.getItem(LS_KEYS.durMin)) || 5);
  const [schedules,        setSchedules]        = useState([]);
  const [folders,          setFolders]          = useState([]);
  const [selectedFolders,  setSelectedFolders]  = useState(new Set());
  const [colorMap,         setColorMap]         = useState({});
  const [selectedProcs,    setSelectedProcs]    = useState(new Set());
  const [projDays,         setProjDays]         = useState(() => {
    const d = parseInt(new URLSearchParams(window.location.search).get('days'), 10);
    return (d > 0 && d <= 365) ? d : 30;
  });
  const [loading,     setLoading]     = useState(false);
  const [projecting,  setProjecting]  = useState(false);
  const [error,       setError]       = useState(null);
  const [eventsByDay, setEventsByDay] = useState({});
  const [calView,     setCalView]     = useState(() => {
    const v = new URLSearchParams(window.location.search).get('view');
    return ['month','week','3day','day'].includes(v) ? v : 'month';
  });
  const calViewRef = useRef('month');
  useEffect(() => { calViewRef.current = calView; }, [calView]);
  // Holds URL filter state captured at the start of each handleFetch call
  const pendingHiddenFiltersRef = useRef({ procs: new Set(), machines: new Set(), folders: new Set() });
  const [anchorDate,  setAnchorDate]  = useState(() => {
    const t = new Date();
    return new Date(t.getFullYear(), t.getMonth(), 1); // first of current month
  });
  const [tooltip,     setTooltip]     = useState({ event: null, pos: { x: 0, y: 0 } });

  // Machines list derived from schedules
  const machines = useMemo(() => {
    const seen = new Set();
    const list = [];
    schedules.forEach(s => {
      const m = s.machine || 'Unassigned';
      if (!seen.has(m)) { seen.add(m); list.push({ id: m, label: m }); }
    });
    return list;
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
    const hidden = pendingHiddenFiltersRef.current.machines;
    setSelectedMachines(new Set(machines.map(m => m.id).filter(id => !hidden.has(id))));
  }, [machines]);

  useEffect(() => {
    setSelectedFolders(new Set(folders.map(f => String(f.Id))));
  }, [folders]);

  // ── Fetch schedules + median durations ──────────────────────────────────────
  const handleFetch = useCallback(async (fetchCfg) => {
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
    };
    try {
      // Step 1: discover all accessible folders
      let discoveredFolders = [];
      try {
        discoveredFolders = await proxyFetch({ ...fetchCfg, folder: '' }, 'folders');
      } catch (e) {
        console.warn('[USV] Folder discovery failed, using root folder:', e.message);
        discoveredFolders = [{ Id: '', DisplayName: 'Default', FullyQualifiedName: 'Default' }];
      }
      if (!discoveredFolders.length) {
        discoveredFolders = [{ Id: '', DisplayName: 'Default', FullyQualifiedName: 'Default' }];
      }
      setFolders(discoveredFolders);

      // Step 2: fetch schedules from every folder in parallel
      const allRaw = [];
      const seenIds = new Set();
      await Promise.allSettled(discoveredFolders.map(async folder => {
        try {
          const cfgF = { ...fetchCfg, folder: String(folder.Id) };
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

      // Build color map
      const cm = {};
      allRaw.forEach((s, i) => { cm[s.Id] = colorForIndex(i); });
      setColorMap(cm);
      setSelectedProcs(new Set(allRaw.map(s => s.Id)));

      // Step 3: enrich each schedule with job history
      const enriched = [];
      const BATCH = 10;
      const fallbackMs = defaultDurMin * 60 * 1000;
      for (let i = 0; i < allRaw.length; i += BATCH) {
        const batch = allRaw.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async s => {
            let jobs = [];
            try { jobs = await fetchJobsForSchedule({ ...fetchCfg, folder: s._folderId }, s.ReleaseName || s.Name); }
            catch (e) { console.warn('[USV] Job history unavailable for', s.ReleaseName || s.Name, '—', e.message); }
            const rawArgs = s.InputArguments || jobs[0]?.InputArguments || null;
            return {
              id:             s.Id,
              name:           s.ReleaseName || s.Name,
              cron:           s.StartProcessCron,
              tz:             s.TimeZoneId,
              machine:        s.MachineRobotAssignment || null,
              serviceAccount: s.ServiceAccountDisplayName || null,
              inputArgs:      parseInputArgs(rawArgs),
              folderId:       s._folderId,
              folderName:     s._folderName,
              medianMs:       medianDurationMs(jobs, fallbackMs),
            };
          })
        );
        results.forEach(r => { if (r.status === 'fulfilled') enriched.push(r.value); });
      }

      setSchedules(enriched);
      // Jump calendar to today in the current view after successful load
      const t = new Date();
      const cv = calViewRef.current;
      if (cv === 'week') {
        const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
        d.setDate(d.getDate() - d.getDay());
        setAnchorDate(d);
      } else if (cv === 'day' || cv === '3day') {
        setAnchorDate(new Date(t.getFullYear(), t.getMonth(), t.getDate()));
      } else {
        setAnchorDate(new Date(t.getFullYear(), t.getMonth(), 1));
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [defaultDurMin]);

  // ── Project CRON events whenever schedules, filters, or projDays change ─────
  useEffect(() => {
    if (!schedules.length) return;
    setProjecting(true);

    // Defer to next tick to let skeleton render
    const tid = setTimeout(() => {
      const byDay = {};

      const filtered = schedules.filter(s =>
        selectedProcs.has(s.id) &&
        selectedMachines.has(s.machine || 'Unassigned') &&
        (selectedFolders.size === 0 || selectedFolders.has(s.folderId || ''))
      );

      filtered.forEach(s => {
        if (!s.cron) return;
        const occurrences = projectSchedule(s.cron, s.tz, projDays, s.medianMs, uiTimezone);
        occurrences.forEach(occ => {
          const key = dayKey(occ.start, uiTimezone);
          if (!byDay[key]) byDay[key] = [];
          byDay[key].push({ schedule: s, occurrence: occ });
        });
      });

      // Sort events within each day by start time
      Object.values(byDay).forEach(arr =>
        arr.sort((a, b) => a.occurrence.start - b.occurrence.start)
      );

      // Gap detection: flag events where the next run on the same machine starts < 5 min after this one ends
      const allEvents = Object.values(byDay).flat();
      const byMachine = {};
      allEvents.forEach(ev => {
        const m = ev.schedule.machine || 'Unassigned';
        if (!byMachine[m]) byMachine[m] = [];
        byMachine[m].push(ev);
      });
      const GAP_MS = 5 * 60 * 1000;
      Object.values(byMachine).forEach(evts => {
        evts.sort((a, b) => a.occurrence.start - b.occurrence.start);
        for (let i = 0; i < evts.length - 1; i++) {
          const gap = evts[i + 1].occurrence.start - evts[i].occurrence.end;
          if (gap >= 0 && gap < GAP_MS) evts[i].gapWarning = true;
        }
      });

      setEventsByDay(byDay);
      setProjecting(false);
    }, 20);

    return () => clearTimeout(tid);
  }, [schedules, selectedProcs, selectedMachines, selectedFolders, projDays, uiTimezone]);

  // ── Toggle helpers ───────────────────────────────────────────────────────────
  const toggleProc    = id => setSelectedProcs(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleMachine = id => setSelectedMachines(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleFolder  = id => setSelectedFolders(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

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
      const days = calView === 'week' ? 7 : calView === '3day' ? 3 : 1;
      return addDays(a, days * dir);
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

  // ── Derive days array for time-grid views ─────────────────────────────────────
  const viewDays = useMemo(() => {
    if (calView === 'month') return [];
    const count = calView === 'week' ? 7 : calView === '3day' ? 3 : 1;
    return Array.from({ length: count }, (_, i) => addDays(anchorDate, i));
  }, [calView, anchorDate]);

  // ── Navigation label ──────────────────────────────────────────────────────────
  const navLabel = useMemo(() => {
    if (calView === 'month') {
      return anchorDate.toLocaleString('default', { month: 'long', year: 'numeric' });
    }
    if (calView === 'day') {
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

  const procItems    = useMemo(() => schedules.map(s => ({ id: s.id, label: s.name })), [schedules]);
  const folderItems  = useMemo(() => folders.map(f => ({ id: String(f.Id), label: f.DisplayName || f.FullyQualifiedName || String(f.Id) })), [folders]);
  const showSkeleton = loading || projecting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

      {/* ── Header ── */}
      <header className="app-header">
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
            <span style={{
              width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
              background: cfg.token ? '#00C48C' : '#FA4616',
              boxShadow: cfg.token ? '0 0 5px #00C48C88' : '0 0 5px #FA461688',
            }} />
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
            { key: 'month', label: 'Month' },
            { key: 'week',  label: 'Week'  },
            { key: '3day',  label: '3 Day' },
            { key: 'day',   label: 'Day'   },
          ].map(v => (
            <button key={v.key}
              className={`view-btn${calView === v.key ? ' active' : ''}`}
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

        {/* Refresh */}
        {schedules.length > 0 && (
          <button className="btn-primary" onClick={() => handleFetch(cfg)} disabled={loading}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <polyline points="23 4 23 10 17 10"/>
              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
            </svg>
            Refresh
          </button>
        )}
      </header>

      {/* ── Body ── */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>

        {/* ── Sidebar — only visible when data is loaded or loading ── */}
        {(schedules.length > 0 || loading) && (
          <aside className="sidebar">
            {schedules.length > 0 && (
              <>
                <CollapsibleSection title="Processes" defaultOpen>
                  <FilterList
                    label=""
                    items={procItems}
                    selected={selectedProcs}
                    onToggle={toggleProc}
                    colorMap={colorMap}
                  />
                </CollapsibleSection>
                {machines.length > 0 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Machines" defaultOpen={false}>
                      <FilterList
                        label=""
                        items={machines}
                        selected={selectedMachines}
                        onToggle={toggleMachine}
                      />
                    </CollapsibleSection>
                  </>
                )}
                {folderItems.length > 1 && (
                  <>
                    <hr style={{ border: 'none', borderTop: '1px solid var(--c-border)', margin: '6px 0 10px' }} />
                    <CollapsibleSection title="Folders" defaultOpen={false}>
                      <FilterList
                        label=""
                        items={folderItems}
                        selected={selectedFolders}
                        onToggle={toggleFolder}
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
        )}

        {/* ── Main content ── */}
        <main style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* Empty state */}
          {!loading && !error && schedules.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16, color: 'var(--c-muted)' }}>
              {!cfg.token ? (
                // ── No token at all ──────────────────────────────────────────
                <>
                  <div style={{ padding: '20px 24px', background: 'rgba(250,70,22,.08)',
                    border: '1px solid rgba(250,70,22,.3)', borderRadius: 10, maxWidth: 400, textAlign: 'center' }}>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>🔑</div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#FA4616', marginBottom: 8 }}>
                      Personal Access Token required
                    </div>
                    <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--c-text)' }}>
                      Click the <strong>Connection</strong> button in the header, enter your
                      Orchestrator URL and PAT, then click{' '}
                      <strong>Save &amp; Fetch Schedules</strong>.
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--c-muted)', marginTop: 10 }}>
                      Generate a PAT: UiPath Cloud → My Profile → Personal Access Tokens → + New
                    </div>
                  </div>
                </>
              ) : (
                // ── Token present, no data yet ───────────────────────────────
                <>
                  <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="var(--c-border)" strokeWidth="1.5">
                    <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                    <line x1="16" y1="2" x2="16" y2="6"/>
                    <line x1="8"  y1="2" x2="8"  y2="6"/>
                    <line x1="3"  y1="10" x2="21" y2="10"/>
                  </svg>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: 'var(--c-text)' }}>
                      No schedules loaded
                    </div>
                    <div style={{ fontSize: 13 }}>
                      Click the <strong>Connection</strong> button in the header, then click{' '}
                      <strong>Save &amp; Fetch Schedules</strong>.
                    </div>
                    <div style={{ marginTop: 8, fontSize: 12, color: '#00C48C' }}>
                      ✓ Token is set
                    </div>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Calendar nav bar */}
          {(schedules.length > 0 || showSkeleton) && (
            <div className="month-nav" style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <button onClick={() => navigate(-1)}>‹</button>
              <span style={{ fontWeight: 700, fontSize: 16, minWidth: 180, textAlign: 'center', color: 'var(--c-text)' }}>
                {showSkeleton
                  ? <span className="skeleton" style={{ display: 'inline-block', width: 160, height: 18 }} />
                  : navLabel}
              </span>
              <button onClick={() => navigate(1)}>›</button>
              <button className="btn-ghost" onClick={goToday}>Today</button>
            </div>
          )}

          {/* Calendar grid / time-grid */}
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
              onHover={handleHover}
              onLeave={handleLeave}
              uiTimezone={uiTimezone}
            />
          )}
          {!showSkeleton && schedules.length > 0 && calView !== 'month' && (
            <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - 160px)', minHeight: 400 }}>
              <CalendarTimeGrid
                days={viewDays}
                eventsByDay={eventsByDay}
                colorMap={colorMap}
                onHover={handleHover}
                onLeave={handleLeave}
                uiTimezone={uiTimezone}
              />
            </div>
          )}
        </main>
      </div>

      {/* Tooltip portal */}
      <Tooltip event={tooltip.event} pos={tooltip.pos} uiTimezone={uiTimezone} />

      {/* Toast portal – fixed top-right */}
      <Toast error={error} onClose={() => setError(null)} />

    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
