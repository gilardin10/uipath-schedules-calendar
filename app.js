// UiPath Schedule Visualizer – Apollo Dark Mode
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
const LS_KEYS = { url: 'usp_url', tenant: 'usp_tenant', folder: 'usp_folder' };
const SS_KEY  = 'usp_token';

function loadConfig() {
  return {
    url:    localStorage.getItem(LS_KEYS.url)    || '',
    tenant: localStorage.getItem(LS_KEYS.tenant) || 'Default',
    folder: localStorage.getItem(LS_KEYS.folder) || '',
    token:  sessionStorage.getItem(SS_KEY)        || '',
  };
}
function saveConfig({ url, tenant, folder, token }) {
  localStorage.setItem(LS_KEYS.url,    url);
  localStorage.setItem(LS_KEYS.tenant, tenant);
  localStorage.setItem(LS_KEYS.folder, folder);
  sessionStorage.setItem(SS_KEY, token);
}

// ─── UiPath API helpers ────────────────────────────────────────────────────────
async function apiFetch(cfg, path, params = {}) {
  const base   = cfg.url.replace(/\/$/, '');
  const qs     = new URLSearchParams(params).toString();
  const fullUrl = `${base}/${cfg.tenant}${path}${qs ? '?' + qs : ''}`;
  const headers = {
    'Authorization': `Bearer ${cfg.token}`,
    'Content-Type':  'application/json',
    'X-UIPATH-OrganizationUnitId': cfg.folder,
  };
  const res = await fetch(fullUrl, { headers });
  if (res.status === 401) throw new Error('401: Token expired or invalid. Please re-enter your Bearer Token.');
  if (!res.ok) throw new Error(`HTTP ${res.status} – ${res.statusText}`);
  return res.json();
}

async function fetchSchedules(cfg) {
  const data = await apiFetch(cfg, '/odata/ProcessSchedules', {
    '$select': 'Id,Name,StartProcessCron,TimeZoneId,Enabled,ReleaseId,ReleaseName,StartStrategy',
    '$filter': 'Enabled eq true',
    '$top': 500,
  });
  return (data.value || []);
}

async function fetchJobsForSchedule(cfg, releaseName) {
  const data = await apiFetch(cfg, '/odata/Jobs', {
    '$filter': `ReleaseName eq '${encodeURIComponent(releaseName).replace(/%27/g,"''")}'`,
    '$select': 'Id,StartTime,EndTime,State',
    '$orderby': 'StartTime desc',
    '$top': 10,
  });
  return (data.value || []);
}

function medianDurationMs(jobs) {
  const durations = jobs
    .filter(j => j.StartTime && j.EndTime && j.State === 'Successful')
    .map(j => new Date(j.EndTime) - new Date(j.StartTime))
    .filter(d => d > 0);
  if (!durations.length) return 5 * 60 * 1000; // default 5 min
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2
    ? durations[mid]
    : (durations[mid - 1] + durations[mid]) / 2;
}

// ─── CRON projection (uses Croner UMD global `Cron`) ─────────────────────────
function projectSchedule(cronExpr, tzId, days, medianMs) {
  const results = [];
  try {
    if (typeof Cron === 'undefined') return results;

    const now = new Date();
    const end = new Date(now.getTime() + days * 86400000);

    const opts = { startAt: now, stopAt: end };
    if (tzId) opts.timezone = tzId;

    const job = Cron(cronExpr, opts);

    // nextRuns(n, from) returns up to n Date objects starting after `from`
    // Use 2000 as hard cap then filter to window
    const dates = job.nextRuns(2000, now);
    for (const start of dates) {
      if (start > end) break;
      results.push({ start, end: new Date(start.getTime() + medianMs) });
    }
  } catch (_) {}
  return results;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────
function fmtTime(d) {
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(d) {
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.round(s/60)}m`;
  return `${(s/3600).toFixed(1)}h`;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth()    === b.getMonth()    &&
         a.getDate()     === b.getDate();
}
function startOfMonth(d) { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d)   { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }
function addDays(d, n)   { return new Date(d.getTime() + n * 86400000); }

// ─── Skeleton components ──────────────────────────────────────────────────────
function SkeletonLine({ w = '100%', h = 14 }) {
  return <div className="skeleton" style={{ width: w, height: h, marginBottom: 6 }} />;
}
function SkeletonCard() {
  return (
    <div style={{ background: '#0B1929', border: '1px solid #1A3050', borderRadius: 6, padding: 8 }}>
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
        <div key={i} style={{ minHeight: 90, background: '#0B1929', border: '1px solid #1A3050', borderRadius: 6, padding: 4 }}>
          <SkeletonLine w="30%" h={10} />
          {i % 3 === 0 && <SkeletonLine w="85%" h={16} />}
          {i % 5 === 0 && <SkeletonLine w="70%" h={16} />}
        </div>
      ))}
    </div>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────
function Tooltip({ event, pos }) {
  if (!event) return null;
  const { schedule, occurrence } = event;
  const dur = occurrence.end - occurrence.start;
  return (
    <div className="tooltip" style={{ left: pos.x + 12, top: pos.y + 12 }}>
      <div className="tooltip-title">{schedule.name}</div>
      <div className="tooltip-row">
        <span className="tooltip-label">Start</span>
        <span className="tooltip-value">{fmtDate(occurrence.start)} {fmtTime(occurrence.start)}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Est. End</span>
        <span className="tooltip-value">{fmtTime(occurrence.end)}</span>
      </div>
      <div className="tooltip-row">
        <span className="tooltip-label">Duration</span>
        <span className="tooltip-value">{fmtDuration(dur)}</span>
      </div>
      {schedule.machine && (
        <div className="tooltip-row">
          <span className="tooltip-label">Machine</span>
          <span className="tooltip-value">{schedule.machine}</span>
        </div>
      )}
      <div className="tooltip-row">
        <span className="tooltip-label">CRON</span>
        <span className="tooltip-value" style={{ fontFamily: 'monospace', fontSize: 11 }}>{schedule.cron}</span>
      </div>
      {schedule.tz && (
        <div className="tooltip-row">
          <span className="tooltip-label">Timezone</span>
          <span className="tooltip-value">{schedule.tz}</span>
        </div>
      )}
    </div>
  );
}

// ─── Event chip ───────────────────────────────────────────────────────────────
function EventChip({ event, color, onHover, onLeave }) {
  return (
    <button
      className="event-chip"
      style={{ background: color + '33', color, borderLeft: `3px solid ${color}` }}
      onMouseEnter={e => onHover(event, { x: e.clientX, y: e.clientY })}
      onMouseMove={e => onHover(event,  { x: e.clientX, y: e.clientY })}
      onMouseLeave={onLeave}
    >
      {fmtTime(event.occurrence.start)} {event.schedule.name}
    </button>
  );
}

// ─── Calendar day cell ────────────────────────────────────────────────────────
const MAX_VISIBLE = 3;
function CalDay({ date, events, colorMap, isToday, isOtherMonth, onHover, onLeave }) {
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
          color={colorMap[ev.schedule.id] || '#5A7A9A'}
          onHover={onHover}
          onLeave={onLeave}
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

function CalendarMonth({ month, eventsByDay, colorMap, onHover, onLeave }) {
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
          <div key={d} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: '#5A7A9A', padding: '4px 0' }}>
            {d}
          </div>
        ))}
      </div>
      <div className="cal-grid" style={{ gap: 2 }}>
        {cells.map((date, i) => {
          const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
          const events = eventsByDay[key] || [];
          return (
            <CalDay
              key={i}
              date={date}
              events={events}
              colorMap={colorMap}
              isToday={sameDay(date, today)}
              isOtherMonth={date.getMonth() !== month.getMonth()}
              onHover={onHover}
              onLeave={onLeave}
            />
          );
        })}
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
    <div style={{ marginBottom: 16 }}>
      <div className="section-label">{label}</div>
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
        {!filtered.length && <div style={{ color: '#5A7A9A', fontSize: 12 }}>No matches</div>}
      </div>
    </div>
  );
}

// ─── Config panel ─────────────────────────────────────────────────────────────
function ConfigPanel({ cfg, onChange, onFetch, loading, scheduleCount }) {
  const [local, setLocal] = useState(cfg);
  const set = (k, v) => setLocal(p => ({ ...p, [k]: v }));

  function handleFetch() {
    saveConfig(local);
    onChange(local);
    onFetch(local);
  }

  return (
    <div>
      <div className="section-label">Orchestrator Connection</div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#5A7A9A', marginBottom: 3 }}>Orchestrator URL</div>
        <input type="text" value={local.url} onChange={e => set('url', e.target.value)}
          placeholder="https://cloud.uipath.com/org" />
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#5A7A9A', marginBottom: 3 }}>Tenant</div>
        <input type="text" value={local.tenant} onChange={e => set('tenant', e.target.value)}
          placeholder="Default" />
      </div>

      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, color: '#5A7A9A', marginBottom: 3 }}>Folder ID</div>
        <input type="text" value={local.folder} onChange={e => set('folder', e.target.value)}
          placeholder="1234" />
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 12, color: '#5A7A9A', marginBottom: 3 }}>
          Bearer Token <span style={{ color: '#FA4616', fontSize: 10 }}>(session only)</span>
        </div>
        <input type="password" value={local.token} onChange={e => set('token', e.target.value)}
          placeholder="eyJ…" />
      </div>

      <button className="btn-primary" onClick={handleFetch} disabled={loading || !local.url || !local.token}
        style={{ width: '100%', justifyContent: 'center' }}>
        {loading ? 'Loading…' : scheduleCount != null ? `Reload (${scheduleCount})` : 'Fetch Schedules'}
      </button>

      <div style={{ marginTop: 10, fontSize: 11, color: '#5A7A9A', lineHeight: 1.5 }}>
        URL, Tenant &amp; Folder saved to localStorage.
        Token stored in sessionStorage (clears on tab close).
      </div>
    </div>
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
  const [cfg,         setCfg]         = useState(loadConfig);
  const [schedules,   setSchedules]   = useState([]);   // enriched schedule objects
  const [colorMap,    setColorMap]    = useState({});
  const [selectedProcs, setSelectedProcs] = useState(new Set());
  const [projDays,    setProjDays]    = useState(30);
  const [loading,     setLoading]     = useState(false);
  const [projecting,  setProjecting]  = useState(false);
  const [error,       setError]       = useState(null);
  const [eventsByDay, setEventsByDay] = useState({});
  const [currentMonth, setCurrentMonth] = useState(() => {
    const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), 1);
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
    setSelectedMachines(new Set(machines.map(m => m.id)));
  }, [machines]);

  // ── Fetch schedules + median durations ──────────────────────────────────────
  const handleFetch = useCallback(async (fetchCfg) => {
    setLoading(true);
    setError(null);
    setSchedules([]);
    setEventsByDay({});
    try {
      const raw = await fetchSchedules(fetchCfg);

      // Build color map
      const cm = {};
      raw.forEach((s, i) => { cm[s.Id] = colorForIndex(i); });
      setColorMap(cm);
      setSelectedProcs(new Set(raw.map(s => s.Id)));

      // Fetch job durations in parallel (batches of 10 to avoid flooding)
      const enriched = [];
      const BATCH = 10;
      for (let i = 0; i < raw.length; i += BATCH) {
        const batch = raw.slice(i, i + BATCH);
        const results = await Promise.allSettled(
          batch.map(async s => {
            const jobs = await fetchJobsForSchedule(fetchCfg, s.ReleaseName || s.Name);
            return {
              id:      s.Id,
              name:    s.ReleaseName || s.Name,
              cron:    s.StartProcessCron,
              tz:      s.TimeZoneId,
              machine: s.MachineRobotAssignment || null,
              medianMs: medianDurationMs(jobs),
            };
          })
        );
        results.forEach(r => { if (r.status === 'fulfilled') enriched.push(r.value); });
      }

      setSchedules(enriched);
    } catch (err) {
      const msg = err.message || String(err);
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('CORS')) {
        setError('CORS / Network error: The Orchestrator URL may not allow requests from this origin. Consider using a CORS proxy or the UiPath API Gateway.');
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  // ── Project CRON events whenever schedules, filters, or projDays change ─────
  useEffect(() => {
    if (!schedules.length) return;
    setProjecting(true);

    // Defer to next tick to let skeleton render
    const tid = setTimeout(() => {
      const byDay = {};

      const filtered = schedules.filter(s =>
        selectedProcs.has(s.id) &&
        selectedMachines.has(s.machine || 'Unassigned')
      );

      filtered.forEach(s => {
        if (!s.cron) return;
        const occurrences = projectSchedule(s.cron, s.tz, projDays, s.medianMs);
        occurrences.forEach(occ => {
          const d = occ.start;
          const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
          if (!byDay[key]) byDay[key] = [];
          byDay[key].push({ schedule: s, occurrence: occ });
        });
      });

      // Sort events within each day by start time
      Object.values(byDay).forEach(arr =>
        arr.sort((a, b) => a.occurrence.start - b.occurrence.start)
      );

      setEventsByDay(byDay);
      setProjecting(false);
    }, 20);

    return () => clearTimeout(tid);
  }, [schedules, selectedProcs, selectedMachines, projDays]);

  // ── Toggle helpers ───────────────────────────────────────────────────────────
  const toggleProc    = id => setSelectedProcs(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleMachine = id => setSelectedMachines(p => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // ── Tooltip handlers ─────────────────────────────────────────────────────────
  const handleHover  = useCallback((event, pos) => setTooltip({ event, pos }), []);
  const handleLeave  = useCallback(() => setTooltip({ event: null, pos: { x: 0, y: 0 } }), []);

  // ── Month navigation ─────────────────────────────────────────────────────────
  const prevMonth = () => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() - 1, 1));
  const nextMonth = () => setCurrentMonth(m => new Date(m.getFullYear(), m.getMonth() + 1, 1));
  const goToday   = () => { const t = new Date(); setCurrentMonth(new Date(t.getFullYear(), t.getMonth(), 1)); };

  // ── Stats ─────────────────────────────────────────────────────────────────
  const totalEvents = useMemo(() => Object.values(eventsByDay).reduce((s, a) => s + a.length, 0), [eventsByDay]);
  const monthKey    = `${currentMonth.getFullYear()}-${currentMonth.getMonth()}`;
  const monthEvents = useMemo(() =>
    Object.entries(eventsByDay)
      .filter(([k]) => k.startsWith(`${currentMonth.getFullYear()}-${currentMonth.getMonth()}-`))
      .reduce((s, [, a]) => s + a.length, 0),
  [eventsByDay, currentMonth]);

  const procItems = useMemo(() => schedules.map(s => ({ id: s.id, label: s.name })), [schedules]);

  const monthLabel = currentMonth.toLocaleString('default', { month: 'long', year: 'numeric' });

  const showSkeleton = loading || projecting;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>

      {/* ── Header ── */}
      <header className="app-header">
        {/* Logo / title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1 }}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="6" fill="#FA4616"/>
            <path d="M6 22 L14 6 L22 22" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            <path d="M9 17 H19" stroke="white" strokeWidth="2" strokeLinecap="round"/>
          </svg>
          <span style={{ fontWeight: 700, fontSize: 16, color: '#C8D8E8', letterSpacing: '.02em' }}>
            UiPath Schedule Visualizer
          </span>
        </div>

        {/* Projection days */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12, color: '#5A7A9A', whiteSpace: 'nowrap' }}>
            Projection:
          </span>
          <input
            type="range" min="1" max="365" value={projDays}
            onChange={e => setProjDays(Number(e.target.value))}
            style={{ width: 120 }}
          />
          <input
            type="number" min="1" max="365" value={projDays}
            onChange={e => setProjDays(Math.max(1, Math.min(365, Number(e.target.value))))}
            style={{ width: 60, textAlign: 'center' }}
          />
          <span style={{ fontSize: 12, color: '#5A7A9A' }}>days</span>
        </div>

        {/* Stats */}
        {!loading && schedules.length > 0 && (
          <div style={{ display: 'flex', gap: 16, fontSize: 12, color: '#5A7A9A', flexWrap: 'wrap' }}>
            <span><strong style={{ color: '#00AEEF' }}>{schedules.length}</strong> schedules</span>
            <span><strong style={{ color: '#FA4616' }}>{totalEvents}</strong> projected</span>
            <span><strong style={{ color: '#C8D8E8' }}>{monthEvents}</strong> this month</span>
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

        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <ConfigPanel
            cfg={cfg}
            onChange={setCfg}
            onFetch={handleFetch}
            loading={loading}
            scheduleCount={schedules.length || null}
          />

          {schedules.length > 0 && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid #1A3050', margin: '16px 0' }} />
              <FilterList
                label="Processes"
                items={procItems}
                selected={selectedProcs}
                onToggle={toggleProc}
                colorMap={colorMap}
              />
              {machines.length > 0 && (
                <>
                  <hr style={{ border: 'none', borderTop: '1px solid #1A3050', margin: '10px 0' }} />
                  <FilterList
                    label="Machines"
                    items={machines}
                    selected={selectedMachines}
                    onToggle={toggleMachine}
                  />
                </>
              )}
            </>
          )}

          {/* Skeleton sidebar items */}
          {loading && (
            <>
              <hr style={{ border: 'none', borderTop: '1px solid #1A3050', margin: '16px 0' }} />
              <div className="section-label">Processes</div>
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

        {/* ── Main content ── */}
        <main style={{ flex: 1, overflow: 'auto', padding: '16px 20px' }}>

          {/* Error banner */}
          {error && (
            <div className="error-banner" style={{ marginBottom: 16 }}>
              <strong>Error:</strong> {error}
              <button
                onClick={() => setError(null)}
                style={{ float: 'right', background: 'none', border: 'none', color: '#FA4616', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}>
                ×
              </button>
            </div>
          )}

          {/* Empty state */}
          {!loading && !error && schedules.length === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '60vh', gap: 16, color: '#5A7A9A' }}>
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="#1A3050" strokeWidth="1.5">
                <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                <line x1="16" y1="2" x2="16" y2="6"/>
                <line x1="8"  y1="2" x2="8"  y2="6"/>
                <line x1="3"  y1="10" x2="21" y2="10"/>
              </svg>
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6, color: '#C8D8E8' }}>No schedules loaded</div>
                <div style={{ fontSize: 13 }}>Configure your Orchestrator connection in the sidebar and click <strong>Fetch Schedules</strong>.</div>
              </div>
            </div>
          )}

          {/* Calendar header */}
          {(schedules.length > 0 || showSkeleton) && (
            <div className="month-nav" style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
              <button onClick={prevMonth}>‹</button>
              <span style={{ fontWeight: 700, fontSize: 18, minWidth: 180, textAlign: 'center', color: '#C8D8E8' }}>
                {showSkeleton ? <span className="skeleton" style={{ display: 'inline-block', width: 160, height: 20 }} /> : monthLabel}
              </span>
              <button onClick={nextMonth}>›</button>
              <button className="btn-ghost" onClick={goToday}>Today</button>
            </div>
          )}

          {/* Calendar grid */}
          {showSkeleton && <CalendarSkeleton />}
          {!showSkeleton && schedules.length > 0 && (
            <CalendarMonth
              month={currentMonth}
              eventsByDay={eventsByDay}
              colorMap={colorMap}
              onHover={handleHover}
              onLeave={handleLeave}
            />
          )}
        </main>
      </div>

      {/* Tooltip portal */}
      <Tooltip event={tooltip.event} pos={tooltip.pos} />
    </div>
  );
}

// ─── Mount ────────────────────────────────────────────────────────────────────
const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
