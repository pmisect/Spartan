/* Spartan Race Tracker
 * A personal, static web app. All race data lives in this browser's localStorage.
 * Nothing is sent anywhere except: map tiles (OpenStreetMap) and optional town lookups (Nominatim).
 */
(() => {
  'use strict';

  // ---------- Constants ----------
  const STORE_KEY = 'spartanTracker.v1';
  const KM_PER_MI = 1.609344;
  const FT_PER_M = 3.28084;
  // Where "Send to GitHub" feedback goes (owner/repo). Set to '' to hide that option.
  const FEEDBACK_REPO = 'pmisect/Spartan';
  const TYPICAL_OBSTACLES = { Sprint: 20, Super: 25, Beast: 30, Ultra: 60, Stadion: 20 };
  const RACE_TYPES = ['Kids', 'Sprint', 'Super', 'Beast', 'Ultra', 'Stadion', 'Trail', 'Other'];
  const TRIFECTA = [
    { type: 'Sprint', spec: '5K · 20 obstacles' },
    { type: 'Super', spec: '10K · 25 obstacles' },
    { type: 'Beast', spec: '21K · 30 obstacles' },
  ];

  // ---------- State ----------
  const defaultState = () => ({
    version: 1,
    profile: { name: '', birthYear: null, home: null, goalRaces: null },
    settings: { unit: 'mi', theme: null },
    races: [],
    feedback: [],
  });

  let state = load();
  let events = { events: [] };
  const charts = {};
  let raceMap, findMap, raceLayers, findLayer;

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      return normalizeState(parsed);
    } catch (e) {
      return defaultState();
    }
  }
  function normalizeState(s) {
    const base = defaultState();
    if (!s || typeof s !== 'object') return base;
    return {
      version: 1,
      profile: Object.assign(base.profile, s.profile || {}),
      settings: Object.assign(base.settings, s.settings || {}),
      races: Array.isArray(s.races) ? s.races.filter(r => r && r.id && r.name && r.date) : [],
      feedback: Array.isArray(s.feedback) ? s.feedback.filter(f => f && f.id && f.text) : [],
    };
  }
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — browser storage is blocked or full.'); }
  }

  // ---------- Helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const num = (v) => (v === '' || v === null || v === undefined || isNaN(+v)) ? null : +v;
  const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d); };
  const fmtDate = (iso, opts = { month: 'short', day: 'numeric', year: 'numeric' }) => iso ? parseDate(iso).toLocaleDateString(undefined, opts) : 'Date TBD';
  const yearOf = (iso) => +iso.slice(0, 4);
  const shortMonth = (iso) => `${parseDate(iso).toLocaleDateString(undefined, { month: 'short' })} '${iso.slice(2, 4)}`;
  const isMi = () => state.settings.unit === 'mi';
  const distUnit = () => isMi() ? 'mi' : 'km';
  const elevUnit = () => isMi() ? 'ft' : 'm';
  const kmToDisp = (km) => km == null ? null : (isMi() ? km / KM_PER_MI : km);
  const dispToKm = (v) => v == null ? null : (isMi() ? v * KM_PER_MI : v);
  const mToDisp = (m) => m == null ? null : (isMi() ? m * FT_PER_M : m);
  const dispToM = (v) => v == null ? null : (isMi() ? v / FT_PER_M : v);
  const fmtDist = (km, digits = 1) => km == null ? '—' : `${kmToDisp(km).toFixed(digits)} ${distUnit()}`;

  function parseTime(str) {
    if (!str) return null;
    const parts = String(str).trim().split(':').map(Number);
    if (parts.some(isNaN)) return null;
    let s = 0;
    for (const p of parts) s = s * 60 + p;
    return s > 0 ? s : null;
  }
  function fmtTime(sec) {
    if (sec == null) return '—';
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
  }
  // seconds per display-unit
  function paceSec(r) {
    if (!r.timeSec || !r.distanceKm) return null;
    return r.timeSec / kmToDisp(r.distanceKm);
  }
  const fmtPace = (p) => p == null ? '—' : `${fmtTime(p)} /${distUnit()}`;
  // Share of finishers beaten (0–100)
  function percentile(place, total) {
    if (!place || !total || total < 2 || place > total) return null;
    return ((total - place) / (total - 1)) * 100;
  }
  const topPct = (place, total) => (place && total) ? Math.max(1, Math.ceil((place / total) * 100)) : null;

  function haversineMi(a, b) {
    const R = 3958.8, toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(b.lat - a.lat), dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function geocode(query) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&addressdetails=1&countrycodes=us,ca&q=${encodeURIComponent(query)}`;
    const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('lookup failed');
    const data = await res.json();
    if (!data.length) return null;
    const a = data[0].address || {};
    const town = a.city || a.town || a.village || a.hamlet || a.suburb || a.county || data[0].display_name.split(',')[0];
    const region = (a['ISO3166-2-lvl4'] || '').split('-')[1] || a.state || '';
    return { lat: +data[0].lat, lon: +data[0].lon, label: region ? `${town}, ${region}` : town };
  }

  const completed = () => state.races.filter(r => r.status === 'completed').sort((a, b) => a.date.localeCompare(b.date));
  const planned = () => state.races.filter(r => r.status === 'planned').sort((a, b) => a.date.localeCompare(b.date));

  // ---------- Theme & units ----------
  function applyTheme() {
    const t = state.settings.theme;
    if (t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
  }
  function renderThemeIcon() {
    const dark = currentThemeIsDark();
    $('#themeToggle').innerHTML = dark
      ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>'
      : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
    $('#themeToggle').setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
  }
  function currentThemeIsDark() {
    const t = state.settings.theme;
    if (t) return t === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  // ---------- Header ----------
  function renderHeader() {
    const p = state.profile;
    $('#athleteName').textContent = p.name || 'Athlete';
    const bits = [];
    if (p.birthYear) bits.push(`Age ${new Date().getFullYear() - p.birthYear}`);
    if (p.home?.label) bits.push(p.home.label.split(',')[0]);
    $('#athleteSub').textContent = bits.length ? bits.join(' · ') + ' · Aroo!' : 'Aroo! Log races, chase records, find the next one.';
    $('#unitToggle').textContent = distUnit();
    document.title = p.name ? `${p.name}'s Spartan Tracker` : 'Spartan Race Tracker';
  }

  // ---------- Dashboard ----------
  function renderDashboard() {
    const done = completed();
    const hasAny = state.races.length > 0;
    $('#emptyState').classList.toggle('hidden', hasAny);
    renderNextRace();
    renderKpis(done);
    renderTrifecta();
    renderPRs(done);
    renderBadges(done);
    // Charts measure their container, so only draw them while the dashboard is visible.
    if ($('#tab-dashboard').classList.contains('active')) renderCharts(done);
  }

  function renderNextRace() {
    const el = $('#nextRace');
    const t = todayISO();
    const dueResults = planned().filter(r => r.date < t);
    const next = planned().find(r => r.date >= t);
    if (!next && !dueResults.length) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    let html = '';
    if (next) {
      const days = Math.round((parseDate(next.date) - parseDate(t)) / 86400000);
      const raceDay = days === 0;
      html += `
      <div class="next-row ${raceDay ? 'race-day' : ''}">
        <div class="count">${raceDay ? '🔥' : days}<small>${raceDay ? 'today' : days === 1 ? 'day' : 'days'}</small></div>
        <div class="next-body">
          <div class="muted small">${raceDay ? 'RACE DAY — GOOD LUCK! AROO!' : 'NEXT RACE'}</div>
          <div><strong>${esc(next.name)}</strong> <span class="tag">${esc(next.type)}</span></div>
          <div class="small muted">${fmtDate(next.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}${next.location ? ' · ' + esc(next.location) : ''}</div>
        </div>
        ${raceDay ? `<button class="btn btn-primary" data-log-results="${esc(next.id)}">Log results</button>` : ''}
      </div>`;
    }
    for (const r of dueResults) {
      html += `
      <div class="next-row due">
        <div class="count">🏁<small>done?</small></div>
        <div class="next-body">
          <div class="muted small">HOW DID IT GO?</div>
          <div><strong>${esc(r.name)}</strong> <span class="tag">${esc(r.type)}</span></div>
          <div class="small muted">${fmtDate(r.date)} · add his time, placing and obstacles</div>
        </div>
        <button class="btn btn-primary" data-log-results="${esc(r.id)}">Log results</button>
      </div>`;
    }
    el.innerHTML = html;
  }

  function renderKpis(done) {
    const year = new Date().getFullYear();
    const thisYear = done.filter(r => yearOf(r.date) === year).length;
    const goal = state.profile.goalRaces;
    const totalKm = done.reduce((s, r) => s + (r.distanceKm || 0), 0);
    const withObs = done.filter(r => r.obstacles);
    const obsTotal = withObs.reduce((s, r) => s + r.obstacles, 0);
    const obsFailed = withObs.reduce((s, r) => s + (r.obstaclesFailed || 0), 0);
    const successRate = obsTotal ? ((obsTotal - obsFailed) / obsTotal) * 100 : null;
    const burpees = done.reduce((s, r) => s + (r.burpees || 0), 0);
    const ranked = done.map(r => ({ r, top: topPct(r.overallPlace, r.overallTotal) })).filter(x => x.top);
    const best = ranked.sort((a, b) => a.top - b.top)[0];
    const elev = done.reduce((s, r) => s + (r.elevationM || 0), 0);

    const tiles = [
      {
        label: 'Races finished', value: done.length,
        sub: goal ? `${thisYear} of ${goal} this year` : `${thisYear} in ${year}`,
        bar: goal ? Math.min(100, (thisYear / goal) * 100) : null,
      },
      { label: 'Distance covered', value: kmToDisp(totalKm).toFixed(1), sub: distUnit() + (elev ? ` · ${Math.round(mToDisp(elev)).toLocaleString()} ${elevUnit()} climbed` : '') },
      { label: 'Obstacles cleared', value: (obsTotal - obsFailed).toLocaleString(), sub: obsTotal ? `of ${obsTotal} attempted` : 'log obstacles per race' },
      { label: 'Obstacle success', value: successRate == null ? '—' : `${Math.round(successRate)}%`, sub: successRate == null ? 'no obstacle data yet' : `${obsFailed} failed`, bar: successRate },
      { label: 'Best finish', value: best ? `Top ${best.top}%` : '—', sub: best ? `${esc(best.r.name)}` : 'add place & finishers' },
      { label: 'Penalty burpees', value: burpees.toLocaleString(), sub: done.length ? `${(burpees / done.length).toFixed(0)} per race avg` : '' },
    ];
    $('#kpis').innerHTML = tiles.map(t => `
      <div class="kpi">
        <div class="label">${t.label}</div>
        <div class="value">${t.value}</div>
        <div class="sub">${t.sub}</div>
        ${t.bar != null ? `<div class="bar"><span style="width:${t.bar.toFixed(0)}%"></span></div>` : ''}
      </div>`).join('');
  }

  function trifectaYears() {
    const years = new Set(state.races.map(r => yearOf(r.date)));
    years.add(new Date().getFullYear());
    return Array.from(years).sort((a, b) => b - a);
  }

  function renderTrifecta() {
    const sel = $('#trifectaYear');
    const years = trifectaYears();
    const cur = +sel.value || new Date().getFullYear();
    sel.innerHTML = years.map(y => `<option ${y === cur ? 'selected' : ''}>${y}</option>`).join('');
    const year = +sel.value;
    const inYear = state.races.filter(r => yearOf(r.date) === year);
    let count = 0;
    const html = TRIFECTA.map(t => {
      const fin = inYear.find(r => r.type === t.type && r.status === 'completed');
      const plan = inYear.find(r => r.type === t.type && r.status === 'planned');
      if (fin) count++;
      return `<div class="tri ${fin ? 'done' : ''}">
        <div class="ring">${fin ? '✓' : t.type[0] + (t.type === 'Super' ? 'u' : '')}</div>
        <div class="name">${t.type}</div>
        <div class="meta">${fin ? esc(fmtDate(fin.date, { month: 'short', day: 'numeric' })) : plan ? 'Planned ' + esc(fmtDate(plan.date, { month: 'short', day: 'numeric' })) : t.spec}</div>
      </div>`;
    }).join('');
    const banner = count === 3 ? `<div class="tri-banner">🏆 ${year} TRIFECTA EARNED!</div>` :
      `<div class="tri-banner muted" style="color:var(--muted)">${count} of 3 complete</div>`;
    $('#trifecta').innerHTML = html + banner;
  }

  function prsByType(done) {
    const out = {};
    for (const r of done) {
      if (!r.timeSec) continue;
      const p = paceSec(r);
      const cur = out[r.type] || (out[r.type] = { fastest: null, pace: null, count: 0 });
      cur.count++;
      if (!cur.fastest || r.timeSec < cur.fastest.timeSec) cur.fastest = r;
      if (p != null && (!cur.pace || p < paceSec(cur.pace))) cur.pace = r;
    }
    return out;
  }

  function renderPRs(done) {
    const prs = prsByType(done);
    const types = RACE_TYPES.filter(t => prs[t]);
    if (!types.length) {
      $('#prs').innerHTML = '<p class="muted small">Finish times show up here once a race has a time logged.</p>';
      return;
    }
    $('#prs').innerHTML = `<ul class="pr-list">${types.map(t => {
      const pr = prs[t];
      return `<li>
        <div><strong>${t}</strong><div class="small muted">${esc(pr.fastest.name)} · ${fmtDate(pr.fastest.date, { month: 'short', year: 'numeric' })}</div></div>
        <div style="text-align:right"><div class="t">${fmtTime(pr.fastest.timeSec)}</div>
        <div class="small muted">${pr.pace ? 'best pace ' + fmtPace(paceSec(pr.pace)) : ''}</div></div>
      </li>`;
    }).join('')}</ul>
    <p class="muted small">Spartan courses vary by venue, so best pace is the fairest comparison.</p>`;
  }

  function badgeList(done) {
    const types = new Set(done.map(r => r.type));
    const byYear = {};
    for (const r of done) (byYear[yearOf(r.date)] ||= new Set()).add(r.type);
    const trifecta = Object.values(byYear).some(s => s.has('Sprint') && s.has('Super') && s.has('Beast'));
    const totalKm = done.reduce((s, r) => s + (r.distanceKm || 0), 0);
    const venues = new Set(done.map(r => (r.location || '').trim().toLowerCase()).filter(Boolean));
    const clean = done.some(r => r.obstacles && !r.obstaclesFailed && !r.burpees);
    const podium = done.some(r => r.agPlace && r.agPlace <= 3);
    const top10 = done.some(r => { const t = topPct(r.overallPlace, r.overallTotal); return t && t <= 10; });
    const top25 = done.some(r => { const t = topPct(r.overallPlace, r.overallTotal); return t && t <= 25; });
    const distGoal = isMi() ? 26.2 : 42.2;
    return [
      { ico: '🏁', n: 'First Finish', d: 'Complete a race', ok: done.length >= 1 },
      { ico: '🧒', n: 'Kid Spartan', d: 'Finish a Kids race', ok: types.has('Kids') },
      { ico: '⚡', n: 'Sprint', d: 'Finish a Sprint', ok: types.has('Sprint') },
      { ico: '💪', n: 'Super', d: 'Finish a Super', ok: types.has('Super') },
      { ico: '🐂', n: 'Beast', d: 'Finish a Beast', ok: types.has('Beast') },
      { ico: '🏆', n: 'Trifecta', d: 'Sprint + Super + Beast in one year', ok: trifecta },
      { ico: '🧼', n: 'Clean Run', d: 'Zero failed obstacles', ok: clean },
      { ico: '🔥', n: 'Top 25%', d: 'Finish top 25% overall', ok: top25 },
      { ico: '🚀', n: 'Top 10%', d: 'Finish top 10% overall', ok: top10 },
      { ico: '🥇', n: 'Podium', d: 'Top 3 in age group', ok: podium },
      { ico: '🗺️', n: 'Explorer', d: 'Race at 3 different places', ok: venues.size >= 3 },
      { ico: '🖐️', n: 'Five Down', d: 'Finish 5 races', ok: done.length >= 5 },
      { ico: '🔟', n: 'Ten Down', d: 'Finish 10 races', ok: done.length >= 10 },
      { ico: '🏃', n: 'Marathon Club', d: `${distGoal} ${distUnit()} total`, ok: kmToDisp(totalKm) >= distGoal },
    ];
  }

  function renderBadges(done) {
    const list = badgeList(done);
    $('#badges').innerHTML = list.map(b => `
      <div class="badge ${b.ok ? 'earned' : ''}" title="${esc(b.d)}">
        <div class="ico" aria-hidden="true">${b.ico}</div>
        <div class="bn">${b.n}</div>
        <div class="bd">${b.ok ? 'Earned' : esc(b.d)}</div>
      </div>`).join('');
  }

  // ---------- Charts ----------
  function chartTheme() {
    return {
      ink: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      grid: cssVar('--line'),
      surface: cssVar('--surface'),
      s1: cssVar('--series-1'),
      s2: cssVar('--series-2'),
      accent: cssVar('--accent'),
    };
  }
  function destroyChart(key) { if (charts[key]) { charts[key].destroy(); delete charts[key]; } }

  function baseOptions(th, yOpts = {}) {
    return {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { backgroundColor: '#151514', titleColor: '#fff', bodyColor: '#f0efec', padding: 10, displayColors: false, cornerRadius: 8 },
      },
      scales: {
        x: { grid: { display: false }, border: { color: th.grid }, ticks: { color: th.muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 6 } },
        y: Object.assign({ grid: { color: th.grid }, border: { display: false }, ticks: { color: th.muted, maxTicksLimit: 5 } }, yOpts),
      },
    };
  }

  function renderCharts(done) {
    if (typeof Chart === 'undefined') return;
    const th = chartTheme();
    Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;

    // Pace selector
    const paceSel = $('#paceType');
    const typesWithPace = RACE_TYPES.filter(t => done.some(r => r.type === t && paceSec(r) != null));
    const prev = paceSel.value;
    paceSel.innerHTML = `<option value="all">All types</option>` + typesWithPace.map(t => `<option ${t === prev ? 'selected' : ''}>${t}</option>`).join('');
    if (prev === 'all' || !typesWithPace.includes(prev)) paceSel.value = 'all';

    // Pace chart
    destroyChart('pace');
    const paceRaces = done.filter(r => paceSec(r) != null && (paceSel.value === 'all' || r.type === paceSel.value));
    $('#paceHint').textContent = paceRaces.length ? `Minutes per ${distUnit()}. Lower is faster.` : 'Log a finish time and distance to see pace.';
    charts.pace = new Chart($('#paceChart'), {
      type: 'line',
      data: {
        labels: paceRaces.map(r => shortMonth(r.date)),
        datasets: [{
          data: paceRaces.map(r => +(paceSec(r) / 60).toFixed(2)),
          borderColor: th.s1, backgroundColor: th.s1, borderWidth: 2, tension: 0,
          pointRadius: 4, pointHoverRadius: 6, pointBorderColor: th.surface, pointBorderWidth: 2,
        }],
      },
      options: Object.assign(baseOptions(th, {
        reverse: true,
        ticks: { color: th.muted, maxTicksLimit: 5, callback: (v) => fmtTime(v * 60) },
      }), {
        plugins: Object.assign(baseOptions(th).plugins, {
          tooltip: Object.assign(baseOptions(th).plugins.tooltip, {
            callbacks: {
              title: (items) => { const r = paceRaces[items[0].dataIndex]; return `${r.name} (${r.type})`; },
              label: (item) => { const r = paceRaces[item.dataIndex]; return [`Pace ${fmtPace(paceSec(r))}`, `Time ${fmtTime(r.timeSec)} · ${fmtDist(r.distanceKm)}`, fmtDate(r.date)]; },
            },
          }),
        }),
      }),
    });

    // Percentile chart
    destroyChart('pct');
    const pctRaces = done.filter(r => percentile(r.overallPlace, r.overallTotal) != null);
    charts.pct = new Chart($('#pctChart'), {
      type: 'line',
      data: {
        labels: pctRaces.map(r => shortMonth(r.date)),
        datasets: [{
          data: pctRaces.map(r => +percentile(r.overallPlace, r.overallTotal).toFixed(1)),
          borderColor: th.s2, backgroundColor: th.s2, borderWidth: 2, tension: 0,
          pointRadius: 4, pointHoverRadius: 6, pointBorderColor: th.surface, pointBorderWidth: 2,
        }],
      },
      options: Object.assign(baseOptions(th, { min: 0, max: 100, ticks: { color: th.muted, stepSize: 25, callback: (v) => v + '%' } }), {
        plugins: Object.assign(baseOptions(th).plugins, {
          tooltip: Object.assign(baseOptions(th).plugins.tooltip, {
            callbacks: {
              title: (items) => pctRaces[items[0].dataIndex].name,
              label: (item) => {
                const r = pctRaces[item.dataIndex];
                const lines = [`Beat ${Math.round(percentile(r.overallPlace, r.overallTotal))}% of finishers`, `Place ${r.overallPlace} of ${r.overallTotal}`];
                if (r.agPlace && r.agTotal) lines.push(`Age group ${r.agPlace} of ${r.agTotal}`);
                return lines;
              },
            },
          }),
        }),
      }),
    });

    // Obstacle chart
    destroyChart('obs');
    const counts = {};
    for (const r of done) for (const o of (r.failedList || [])) {
      const k = o.trim(); if (!k) continue;
      const key = Object.keys(counts).find(x => x.toLowerCase() === k.toLowerCase()) || k;
      counts[key] = (counts[key] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
    $('#obstacleEmpty').classList.toggle('hidden', top.length > 0);
    $('#obstacleChart').parentElement.classList.toggle('hidden', top.length === 0);
    if (top.length) {
      charts.obs = new Chart($('#obstacleChart'), {
        type: 'bar',
        data: {
          labels: top.map(t => t[0]),
          datasets: [{ data: top.map(t => t[1]), backgroundColor: th.accent, borderRadius: 4, borderSkipped: 'start', barThickness: 18 }],
        },
        options: Object.assign(baseOptions(th), {
          indexAxis: 'y',
          interaction: { mode: 'nearest', intersect: false, axis: 'y' },
          scales: {
            x: { beginAtZero: true, grid: { color: th.grid }, border: { display: false }, ticks: { color: th.muted, precision: 0 } },
            y: { grid: { display: false }, border: { color: th.grid }, ticks: { color: th.ink } },
          },
          plugins: Object.assign(baseOptions(th).plugins, {
            tooltip: Object.assign(baseOptions(th).plugins.tooltip, {
              callbacks: { label: (item) => `Failed ${item.raw} time${item.raw === 1 ? '' : 's'}` },
            }),
          }),
        }),
      });
    }
  }

  // ---------- Race table ----------
  function renderRaceTable() {
    const filter = $('#raceFilter').value;
    const prs = prsByType(completed());
    const prIds = new Set(Object.values(prs).map(p => p.pace?.id).filter(Boolean));
    const rows = state.races
      .filter(r => filter === 'all' || r.status === filter)
      .sort((a, b) => b.date.localeCompare(a.date));
    $('#raceTableEmpty').classList.toggle('hidden', rows.length > 0);
    $('#raceTable').classList.toggle('hidden', rows.length === 0);
    $('#raceTable tbody').innerHTML = rows.map(r => {
      const isPlanned = r.status === 'planned';
      const obs = r.obstacles ? `${r.obstacles - (r.obstaclesFailed || 0)}/${r.obstacles}` : '—';
      return `<tr class="${isPlanned ? 'planned' : ''}">
        <td>${fmtDate(r.date)}</td>
        <td><strong>${esc(r.name)}</strong>${r.location ? `<div class="small muted">${esc(r.location)}</div>` : ''}</td>
        <td><span class="tag">${esc(r.type)}</span> ${isPlanned ? '<span class="tag planned">Planned</span>' : ''} ${prIds.has(r.id) ? '<span class="tag pr">PR</span>' : ''}</td>
        <td class="num">${fmtDist(r.distanceKm)}</td>
        <td class="num">${fmtTime(r.timeSec)}</td>
        <td class="num">${fmtPace(paceSec(r))}</td>
        <td class="num">${r.overallPlace ? `${r.overallPlace}${r.overallTotal ? ' / ' + r.overallTotal : ''}` : '—'}</td>
        <td class="num">${r.agPlace ? `${r.agPlace}${r.agTotal ? ' / ' + r.agTotal : ''}` : '—'}</td>
        <td class="num">${obs}</td>
        <td><button class="btn btn-sm" data-edit="${esc(r.id)}">Edit</button></td>
      </tr>`;
    }).join('');
  }

  // ---------- Race dialog ----------
  const dlg = () => $('#raceDialog');
  function openRaceDialog(race = null, prefill = null) {
    const f = $('#raceForm');
    f.reset();
    $('#geocodeStatus').textContent = '';
    $$('.unit-label[data-unit="dist"]').forEach(e => e.textContent = `(${distUnit()})`);
    $$('.unit-label[data-unit="elev"]').forEach(e => e.textContent = `(${elevUnit()})`);
    const r = prefill || race || {};
    $('#raceDialogTitle').textContent = race ? 'Edit race' : 'Add race';
    $('#deleteRace').classList.toggle('hidden', !race);
    f.id.value = race?.id || '';
    f.querySelector(`input[name="status"][value="${r.status || 'completed'}"]`).checked = true;
    f.name.value = r.name || '';
    f.date.value = r.date || '';
    f.type.value = r.type || 'Sprint';
    f.heat.value = r.heat || 'Open';
    f.distance.value = r.distanceKm != null ? +kmToDisp(r.distanceKm).toFixed(2) : '';
    f.location.value = r.location || '';
    f.lat.value = r.lat ?? '';
    f.lon.value = r.lon ?? '';
    f.time.value = r.timeSec ? fmtTime(r.timeSec) : '';
    f.elevation.value = r.elevationM != null ? Math.round(mToDisp(r.elevationM)) : '';
    f.overallPlace.value = r.overallPlace ?? '';
    f.overallTotal.value = r.overallTotal ?? '';
    f.agPlace.value = r.agPlace ?? '';
    f.agTotal.value = r.agTotal ?? '';
    f.obstacles.value = r.obstacles ?? '';
    f.obstaclesFailed.value = r.obstaclesFailed ?? '';
    f.burpees.value = r.burpees ?? '';
    f.effort.value = r.effort ?? '';
    f.failedList.value = (r.failedList || []).join(', ');
    f.notes.value = r.notes || '';
    if (r.lat != null) $('#geocodeStatus').textContent = '📍 Location pinned on map';
    syncStatusFields();
    dlg().showModal();
  }
  function openLogResults(id) {
    const r = state.races.find(x => x.id === id);
    if (!r) return;
    delete $('#raceForm').dataset.eventId;
    const copy = Object.assign({}, r, { status: 'completed' });
    if (copy.obstacles == null && TYPICAL_OBSTACLES[r.type]) copy.obstacles = TYPICAL_OBSTACLES[r.type];
    openRaceDialog(r, copy);
    $('#raceDialogTitle').textContent = 'Log results';
  }
  function syncStatusFields() {
    const planned = $('#raceForm').querySelector('input[name="status"]:checked').value === 'planned';
    $('#resultsFields').classList.toggle('hidden', planned);
  }
  function readRaceForm() {
    const f = $('#raceForm');
    const status = f.querySelector('input[name="status"]:checked').value;
    const r = {
      id: f.id.value || uid(),
      status,
      name: f.name.value.trim(),
      date: f.date.value,
      type: f.type.value,
      heat: f.heat.value,
      distanceKm: dispToKm(num(f.distance.value)),
      location: f.location.value.trim(),
      lat: num(f.lat.value),
      lon: num(f.lon.value),
      notes: f.notes.value.trim(),
    };
    const existing = state.races.find(x => x.id === r.id);
    if (existing?.eventId) r.eventId = existing.eventId;
    if (f.dataset.eventId) r.eventId = f.dataset.eventId;
    if (status === 'completed') {
      Object.assign(r, {
        timeSec: parseTime(f.time.value),
        elevationM: dispToM(num(f.elevation.value)),
        overallPlace: num(f.overallPlace.value),
        overallTotal: num(f.overallTotal.value),
        agPlace: num(f.agPlace.value),
        agTotal: num(f.agTotal.value),
        obstacles: num(f.obstacles.value),
        obstaclesFailed: num(f.obstaclesFailed.value),
        burpees: num(f.burpees.value),
        effort: num(f.effort.value),
        failedList: f.failedList.value.split(',').map(s => s.trim()).filter(Boolean),
      });
    } else if (existing) {
      // keep any previously entered results if toggled back
      for (const k of ['timeSec', 'elevationM', 'overallPlace', 'overallTotal', 'agPlace', 'agTotal', 'obstacles', 'obstaclesFailed', 'burpees', 'effort', 'failedList']) {
        if (existing[k] != null) r[k] = existing[k];
      }
    }
    return r;
  }

  // ---------- Maps ----------
  function tileLayer() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
  }
  function pinIcon(kind) {
    const glyph = { completed: '★', planned: '⚑', schedule: '', home: '⌂' }[kind];
    const size = kind === 'schedule' ? 14 : 22;
    return L.divIcon({
      className: 'pin-icon',
      html: `<span class="pin pin-${kind}" style="width:${size}px;height:${size}px">${glyph}</span>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
    });
  }
  function eventPopup(ev) {
    const dist = state.profile.home ? ` · ${Math.round(haversineMi(state.profile.home, ev))} mi from home` : '';
    return `<b>${esc(ev.name)}</b><br>${ev.start ? fmtDate(ev.start, { month: 'short', day: 'numeric' }) + (ev.end && ev.end !== ev.start ? '–' + fmtDate(ev.end, { month: 'short', day: 'numeric', year: 'numeric' }) : ', ' + yearOf(ev.start)) : 'Date TBD'}<br>
      ${esc(ev.place)}, ${esc(ev.state)}${dist}<br>${esc(ev.types.join(' · '))}<br>
      <a href="${esc(ev.url || events.findRaceUrl)}" target="_blank" rel="noopener">Details on spartan.com ↗</a>`;
  }
  function racePopup(r) {
    const lines = [`<b>${esc(r.name)}</b>`, `${fmtDate(r.date)} · ${esc(r.type)}${r.status === 'planned' ? ' (planned)' : ''}`];
    if (r.location) lines.push(esc(r.location));
    if (r.timeSec) lines.push(`Time ${fmtTime(r.timeSec)} · ${fmtPace(paceSec(r))}`);
    if (r.overallPlace && r.overallTotal) lines.push(`Place ${r.overallPlace} of ${r.overallTotal}`);
    return lines.join('<br>');
  }

  function ensureRaceMap() {
    if (raceMap || typeof L === 'undefined') return;
    raceMap = L.map('raceMap', { scrollWheelZoom: false }).setView([39.5, -98.35], 4);
    tileLayer().addTo(raceMap);
    raceLayers = {
      completed: L.layerGroup().addTo(raceMap),
      planned: L.layerGroup().addTo(raceMap),
      schedule: L.layerGroup(),
      home: L.layerGroup().addTo(raceMap),
    };
    $$('#mapLegend input[data-layer]').forEach(cb => cb.addEventListener('change', () => {
      const layer = raceLayers[cb.dataset.layer];
      cb.checked ? layer.addTo(raceMap) : raceMap.removeLayer(layer);
    }));
  }

  function renderRaceMap(fit = true) {
    ensureRaceMap();
    if (!raceMap) return;
    Object.values(raceLayers).forEach(l => l.clearLayers());
    const pts = [];
    const done = completed().filter(r => r.lat != null);
    const plan = planned().filter(r => r.lat != null);
    for (const r of done) { L.marker([r.lat, r.lon], { icon: pinIcon('completed') }).bindPopup(racePopup(r)).addTo(raceLayers.completed); pts.push([r.lat, r.lon]); }
    for (const r of plan) { L.marker([r.lat, r.lon], { icon: pinIcon('planned') }).bindPopup(racePopup(r)).addTo(raceLayers.planned); pts.push([r.lat, r.lon]); }
    for (const ev of upcomingEvents()) L.marker([ev.lat, ev.lon], { icon: pinIcon('schedule') }).bindPopup(eventPopup(ev)).addTo(raceLayers.schedule);
    if (state.profile.home) {
      const h = state.profile.home;
      L.marker([h.lat, h.lon], { icon: pinIcon('home') }).bindPopup(`<b>Home</b><br>${esc(h.label)}`).addTo(raceLayers.home);
      pts.push([h.lat, h.lon]);
    }
    if (fit && pts.length) raceMap.fitBounds(pts, { padding: [40, 40], maxZoom: 8 });

    const allDone = completed();
    const noPin = allDone.length - done.length;
    const states = new Set(allDone.map(r => (r.location || '').split(',').pop().trim().toUpperCase()).filter(s => /^[A-Z]{2}$/.test(s)));
    let miles = 0;
    if (state.profile.home) for (const r of done) miles += haversineMi(state.profile.home, r);
    $('#mapStats').textContent = [
      `${allDone.length} race${allDone.length === 1 ? '' : 's'} finished`,
      states.size ? `${states.size} state${states.size === 1 ? '' : 's'}/province${states.size === 1 ? '' : 's'}` : null,
      miles ? `~${Math.round(miles).toLocaleString()} mi traveled from home (one way)` : null,
      noPin ? `${noPin} race${noPin === 1 ? '' : 's'} not on the map yet — edit and tap “Find on map”` : null,
    ].filter(Boolean).join(' · ');
  }

  // ---------- Find races ----------
  function upcomingEvents() {
    const t = todayISO();
    return (events.events || []).filter(e => !e.end || e.end >= t);
  }
  function eventDates(e) {
    if (!e.start) return 'Date TBD';
    if (!e.end || e.end === e.start) return fmtDate(e.start);
    const a = parseDate(e.start), b = parseDate(e.end);
    const sameMonth = a.getMonth() === b.getMonth();
    return `${fmtDate(e.start, { month: 'short', day: 'numeric' })}–${sameMonth ? b.getDate() : fmtDate(e.end, { month: 'short', day: 'numeric' })}, ${b.getFullYear()}`;
  }
  function filteredEvents() {
    const radius = +$('#findRadius').value;
    const type = $('#findType').value;
    const trifectaOnly = $('#findTrifecta').checked;
    const home = state.profile.home;
    let list = upcomingEvents().map(e => Object.assign({}, e, { miles: home ? haversineMi(home, e) : null }));
    if (home) list = list.filter(e => e.miles <= radius);
    if (type !== 'any') list = list.filter(e => e.types.includes(type));
    if (trifectaOnly) list = list.filter(e => ['Sprint', 'Super', 'Beast'].every(t => e.types.includes(t)));
    const sort = $('#findSort').value;
    list.sort((a, b) => {
      if (sort === 'distance' && home) return a.miles - b.miles;
      if (!a.start) return 1; if (!b.start) return -1;
      return a.start.localeCompare(b.start);
    });
    return list;
  }

  function ensureFindMap() {
    if (findMap || typeof L === 'undefined') return;
    findMap = L.map('findMap', { scrollWheelZoom: false }).setView([39.5, -98.35], 4);
    tileLayer().addTo(findMap);
    findLayer = L.layerGroup().addTo(findMap);
  }

  function renderFind() {
    const home = state.profile.home;
    $('#findHomeNote').innerHTML = home
      ? `Distances are straight-line from <strong>${esc(home.label.split(',')[0])}</strong>. Change home in <a href="#" data-goto="settings">Profile</a>.`
      : `Set your home town in <a href="#" data-goto="settings">Profile</a> to filter by distance.`;
    $('#findSource').textContent = events.lastChecked
      ? `Schedule from Spartan's published calendar, last checked ${fmtDate(events.lastChecked)}. ${events.note || ''}`
      : 'Could not load the event list.';
    const list = filteredEvents();
    const plannedIds = new Set(state.races.map(r => r.eventId).filter(Boolean));
    $('#findList').innerHTML = list.length ? list.map(e => `
      <div class="event ${plannedIds.has(e.id) ? 'added' : ''}" data-event="${esc(e.id)}">
        <div class="top"><span class="nm">${esc(e.name)}</span>
          <span class="dt">${eventDates(e)}</span></div>
        <div class="small muted">${esc(e.place)}, ${esc(e.state)}${e.miles != null ? ` · ${Math.round(e.miles).toLocaleString()} mi away` : ''}</div>
        <div class="types">${e.types.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
        <div class="actions">
          ${plannedIds.has(e.id) ? '<span class="tag planned">In his plan ✓</span>' : `<button class="btn btn-sm btn-primary" data-plan="${esc(e.id)}">+ Add to plan</button>`}
          <a class="btn btn-sm" href="${esc(e.url || events.findRaceUrl)}" target="_blank" rel="noopener">Register / details ↗</a>
        </div>
      </div>`).join('') : `<p class="muted">No events match. Try a bigger radius or a different race type, or check the official race finder.</p>`;

    ensureFindMap();
    if (!findMap) return;
    findLayer.clearLayers();
    const pts = [];
    for (const e of list) {
      const m = L.marker([e.lat, e.lon], { icon: pinIcon(plannedIds.has(e.id) ? 'planned' : 'schedule') }).bindPopup(eventPopup(e));
      m.eventId = e.id;
      m.addTo(findLayer);
      pts.push([e.lat, e.lon]);
    }
    if (home) { L.marker([home.lat, home.lon], { icon: pinIcon('home') }).bindPopup('<b>Home</b>').addTo(findLayer); pts.push([home.lat, home.lon]); }
    if (pts.length) findMap.fitBounds(pts, { padding: [30, 30], maxZoom: 8 });
  }

  function planFromEvent(id) {
    const e = (events.events || []).find(x => x.id === id);
    if (!e) return;
    const age = state.profile.birthYear ? new Date().getFullYear() - state.profile.birthYear : null;
    const preferred = (age != null && age < 14 && e.types.includes('Kids')) ? 'Kids'
      : ['Sprint', 'Super', 'Beast', 'Stadion', 'Trail', 'Ultra', 'Kids'].find(t => e.types.includes(t)) || 'Other';
    const distKm = { Sprint: 5, Super: 10, Beast: 21, Ultra: 50, Stadion: 5, Kids: 1.5 }[preferred] ?? null;
    const t = todayISO();
    // If the event weekend is underway, default to today.
    const date = (e.start && e.end && e.start < t && t <= e.end) ? t : (e.start || '');
    const base = e.name
      .replace(/ (OCR|Event|Trifecta) Weekend.*$/i, '')
      .replace(/ Event$/i, '')
      .replace(/ Spartan$/i, '');
    const name = new RegExp('\\b' + preferred + '\\b', 'i').test(base) ? base : `${base} ${preferred}`;
    $('#raceForm').dataset.eventId = id;
    openRaceDialog(null, {
      status: 'planned', name,
      date, type: preferred, location: `${e.place}, ${e.state}`, lat: e.lat, lon: e.lon, distanceKm: distKm,
      heat: preferred === 'Kids' ? 'Kids' : 'Open',
    });
  }

  // ---------- Feedback ----------
  function openFeedback() {
    const f = $('#feedbackForm');
    f.reset();
    f.elements.from.value = state.profile.name || '';
    $('#feedbackStatus').textContent = '';
    $('#fbGithub').classList.toggle('hidden', !FEEDBACK_REPO);
    $('#feedbackDialog').showModal();
    f.elements.text.focus();
  }
  function readFeedback() {
    const f = $('#feedbackForm').elements;
    const text = f.text.value.trim();
    if (!text) { $('#feedbackStatus').textContent = 'Type your idea first.'; f.text.focus(); return null; }
    const item = { id: uid(), date: todayISO(), kind: f.kind.value, from: f.from.value.trim(), text, sent: null };
    state.feedback.unshift(item);
    save(); renderFeedbackList();
    return item;
  }
  function githubIssueUrl(item) {
    const title = `${item.kind}: ${item.text.split('\n')[0].slice(0, 70)}`;
    const body = `${item.text}\n\n---\nFrom: ${item.from || 'Anonymous'}\nDate: ${item.date}\nSent from the Spartan Tracker feedback box.`;
    return `https://github.com/${FEEDBACK_REPO}/issues/new?labels=feedback&title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  }
  async function shareFeedback(item) {
    const text = `Spartan Tracker idea (${item.kind})\n${item.text}\n— ${item.from || 'Anonymous'}`;
    if (navigator.share) {
      try { await navigator.share({ title: 'Spartan Tracker idea', text }); return 'shared'; }
      catch (e) { if (e && e.name === 'AbortError') return 'cancelled'; }
    }
    try { await navigator.clipboard.writeText(text); return 'copied'; } catch (e) { return 'failed'; }
  }
  function renderFeedbackList() {
    const list = state.feedback || [];
    $('#feedbackCount').textContent = list.length ? `(${list.length})` : '';
    $('#feedbackList').innerHTML = list.length ? list.map(f => `
      <li>
        <div><span class="tag">${esc(f.kind)}</span> <span class="small muted">${fmtDate(f.date)}${f.from ? ' · ' + esc(f.from) : ''}${f.sent ? ' · sent' : ''}</span></div>
        <div class="fb-text">${esc(f.text)}</div>
        <button class="btn btn-sm" data-del-feedback="${esc(f.id)}">Remove</button>
      </li>`).join('') : '<li class="muted small">No suggestions yet. Tap “💡 Suggest a change” at the bottom of any page.</li>';
  }

  // ---------- Settings ----------
  function renderSettings() {
    const f = $('#profileForm');
    const p = state.profile;
    f.name.value = p.name || '';
    f.birthYear.value = p.birthYear || '';
    f.homeQuery.value = p.home?.query || '';
    f.goalRaces.value = p.goalRaces || '';
    $('#homeStatus').textContent = p.home ? `📍 Home set: ${p.home.label}` : 'Used to measure distance to races. Only stored in this browser.';
  }

  // ---------- Demo data ----------
  function demoRaces() {
    const y = new Date().getFullYear();
    const mk = (o) => Object.assign({ id: uid(), demo: true, heat: 'Age Group' }, o);
    return [
      mk({ status: 'completed', name: 'Tri-State Kids 2 Mile', date: `${y - 1}-05-04`, type: 'Kids', heat: 'Kids', distanceKm: 3.2, location: 'Vernon, NJ', lat: 41.20, lon: -74.48, timeSec: 1710, overallPlace: 41, overallTotal: 210, obstacles: 15, obstaclesFailed: 2, burpees: 0, failedList: ['Monkey Bars', 'Rope Climb'] }),
      mk({ status: 'completed', name: 'New England Sprint', date: `${y}-06-27`, type: 'Sprint', distanceKm: 5.6, location: 'Barre, MA', lat: 42.42, lon: -72.10, timeSec: 3720, elevationM: 210, overallPlace: 612, overallTotal: 2140, agPlace: 18, agTotal: 96, obstacles: 21, obstaclesFailed: 3, burpees: 90, failedList: ['Spear Throw', 'Multi-Rig', 'Rope Climb'] }),
      mk({ status: 'completed', name: 'Poconos Super', date: `${y}-07-11`, type: 'Super', distanceKm: 10.8, location: 'Palmerton, PA', lat: 40.81, lon: -75.51, timeSec: 7980, elevationM: 520, overallPlace: 488, overallTotal: 1650, agPlace: 12, agTotal: 71, obstacles: 26, obstaclesFailed: 2, burpees: 60, failedList: ['Spear Throw', 'Twister'] }),
      mk({ status: 'completed', name: 'Vermont Sprint', date: `${y}-09-19`, type: 'Sprint', distanceKm: 6.1, location: 'Killington, VT', lat: 43.62, lon: -72.80, timeSec: 3840, elevationM: 480, overallPlace: 301, overallTotal: 1420, agPlace: 7, agTotal: 64, obstacles: 22, obstaclesFailed: 1, burpees: 30, failedList: ['Spear Throw'] }),
      mk({ status: 'planned', name: 'Vermont Beast', date: `${y + 1}-09-18`, type: 'Beast', distanceKm: 21, location: 'Killington, VT', lat: 43.62, lon: -72.80 }),
    ];
  }

  // ---------- Render all ----------
  function renderAll() {
    renderHeader();
    renderDashboard();
    renderRaceTable();
    renderSettings();
    renderFeedbackList();
    if (raceMap) renderRaceMap(false);
    if (findMap) renderFind();
    const demo = state.races.some(r => r.demo);
    $('#loadDemo').textContent = demo ? 'Clear sample data' : 'Show sample data';
  }

  function showTab(name) {
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    $$('.panel').forEach(p => p.classList.toggle('active', p.id === `tab-${name}`));
    try { localStorage.setItem(STORE_KEY + '.tab', name); } catch (e) { /* ignore */ }
    if (name === 'dashboard') renderDashboard();
    if (name === 'map') { renderRaceMap(true); setTimeout(() => raceMap && raceMap.invalidateSize(), 50); }
    if (name === 'find') { renderFind(); setTimeout(() => findMap && findMap.invalidateSize(), 50); }
    window.scrollTo({ top: 0 });
  }

  // ---------- Events ----------
  function bind() {
    $$('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
    document.addEventListener('click', (e) => {
      const go = e.target.closest('[data-goto]');
      if (go) { e.preventDefault(); showTab(go.dataset.goto); return; }
      if (e.target.closest('[data-action="add-race"]')) { delete $('#raceForm').dataset.eventId; openRaceDialog(); return; }
      const edit = e.target.closest('[data-edit]');
      if (edit) { const r = state.races.find(x => x.id === edit.dataset.edit); if (r) { delete $('#raceForm').dataset.eventId; openRaceDialog(r); } return; }
      const logBtn = e.target.closest('[data-log-results]');
      if (logBtn) { openLogResults(logBtn.dataset.logResults); return; }
      if (e.target.closest('[data-action="feedback"]')) { openFeedback(); return; }
      const delFb = e.target.closest('[data-del-feedback]');
      if (delFb) { state.feedback = state.feedback.filter(f => f.id !== delFb.dataset.delFeedback); save(); renderFeedbackList(); return; }
      const plan = e.target.closest('[data-plan]');
      if (plan) { planFromEvent(plan.dataset.plan); return; }
      const ev = e.target.closest('.event');
      if (ev && !e.target.closest('a,button') && findMap) {
        findLayer.eachLayer(m => { if (m.eventId === ev.dataset.event) { findMap.setView(m.getLatLng(), 8); m.openPopup(); } });
      }
    });

    $('#unitToggle').addEventListener('click', () => {
      state.settings.unit = isMi() ? 'km' : 'mi'; save(); renderAll();
    });
    $('#themeToggle').addEventListener('click', () => {
      state.settings.theme = currentThemeIsDark() ? 'light' : 'dark'; save(); applyTheme(); renderDashboard(); renderThemeIcon();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { if (!state.settings.theme) { renderDashboard(); renderThemeIcon(); } });

    $('#trifectaYear').addEventListener('change', renderTrifecta);
    $('#paceType').addEventListener('change', () => renderCharts(completed()));
    $('#raceFilter').addEventListener('change', renderRaceTable);
    ['#findRadius', '#findType', '#findSort', '#findTrifecta'].forEach(s => $(s).addEventListener('change', renderFind));

    $('#loadDemo').addEventListener('click', () => {
      if (state.races.some(r => r.demo)) {
        state.races = state.races.filter(r => !r.demo); toast('Sample data cleared');
      } else {
        state.races.push(...demoRaces()); toast('Sample races added — clear them any time');
      }
      save(); renderAll();
    });

    // Race form
    $$('#raceForm input[name="status"]').forEach(i => i.addEventListener('change', syncStatusFields));
    $$('#raceDialog [data-close]').forEach(b => b.addEventListener('click', () => dlg().close()));
    $('#raceForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = $('#raceForm');
      if (!f.reportValidity()) return;
      const r = readRaceForm();
      if (r.timeSec == null && f.time.value && r.status === 'completed') { toast('Finish time should look like 1:05:30'); return; }
      const idx = state.races.findIndex(x => x.id === r.id);
      if (idx >= 0) state.races[idx] = r; else state.races.push(r);
      delete f.dataset.eventId;
      save(); dlg().close(); renderAll();
      toast(idx >= 0 ? 'Race updated' : (r.status === 'planned' ? 'Added to his plan' : 'Race logged — Aroo!'));
    });
    $('#deleteRace').addEventListener('click', () => {
      const id = $('#raceForm').id.value;
      const r = state.races.find(x => x.id === id);
      if (!r || !confirm(`Delete “${r.name}”?`)) return;
      state.races = state.races.filter(x => x.id !== id);
      save(); dlg().close(); renderAll(); toast('Race deleted');
    });
    $('#geocodeRace').addEventListener('click', async () => {
      const f = $('#raceForm');
      const q = f.location.value.trim();
      if (!q) { $('#geocodeStatus').textContent = 'Type a town and state first (e.g. Barre, MA).'; return; }
      $('#geocodeStatus').textContent = 'Looking up…';
      try {
        const g = await geocode(q);
        if (!g) { $('#geocodeStatus').textContent = 'Not found — try “Town, ST”.'; return; }
        f.lat.value = g.lat; f.lon.value = g.lon;
        $('#geocodeStatus').textContent = `📍 Pinned: ${g.label}`;
      } catch (err) { $('#geocodeStatus').textContent = 'Lookup failed — check your connection.'; }
    });
    $('#raceForm').location.addEventListener('input', () => {
      $('#raceForm').lat.value = ''; $('#raceForm').lon.value = '';
      $('#geocodeStatus').textContent = '';
    });

    // Profile
    $('#locateHome').addEventListener('click', async () => {
      const f = $('#profileForm');
      const q = f.homeQuery.value.trim();
      if (!q) { $('#homeStatus').textContent = 'Type a town or ZIP first.'; return; }
      $('#homeStatus').textContent = 'Looking up…';
      try {
        const g = await geocode(q);
        if (!g) { $('#homeStatus').textContent = 'Not found — try “Town, ST” or a ZIP code.'; return; }
        state.profile.home = Object.assign(g, { query: q });
        save(); renderAll(); toast('Home location saved');
      } catch (err) { $('#homeStatus').textContent = 'Lookup failed — check your connection.'; }
    });
    $('#profileForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const f = e.target;
      state.profile.name = f.name.value.trim();
      state.profile.birthYear = num(f.birthYear.value);
      state.profile.goalRaces = num(f.goalRaces.value);
      save(); renderAll(); toast('Profile saved');
    });

    // Feedback
    $$('#feedbackDialog [data-close]').forEach(b => b.addEventListener('click', () => $('#feedbackDialog').close()));
    $('#feedbackForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!readFeedback()) return;
      $('#feedbackDialog').close();
      toast('Thanks! Saved to the suggestion list');
    });
    $('#fbShare').addEventListener('click', async () => {
      const item = readFeedback();
      if (!item) return;
      const res = await shareFeedback(item);
      if (res === 'shared' || res === 'copied') { item.sent = res; save(); renderFeedbackList(); }
      $('#feedbackDialog').close();
      toast(res === 'shared' ? 'Sent — thanks!' : res === 'copied' ? 'Copied — paste it into a text or email' : 'Saved to the suggestion list');
    });
    $('#fbGithub').addEventListener('click', () => {
      const item = readFeedback();
      if (!item) return;
      item.sent = 'github'; save(); renderFeedbackList();
      window.open(githubIssueUrl(item), '_blank', 'noopener');
      $('#feedbackDialog').close();
      toast('Opened GitHub — tap “Submit new issue” there');
    });

    // Backup
    $('#exportData').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `spartan-tracker-backup-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      $('#backupStatus').textContent = `Backup downloaded (${state.races.length} races).`;
    });
    $('#importData').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const parsed = JSON.parse(await file.text());
        const next = normalizeState(parsed);
        if (!confirm(`Replace the data on this device with this backup (${next.races.length} races)?`)) return;
        state = next; save(); applyTheme(); renderAll();
        $('#backupStatus').textContent = `Restored ${next.races.length} races.`;
        toast('Backup restored');
      } catch (err) { $('#backupStatus').textContent = 'That file is not a valid tracker backup.'; }
    });
    $('#resetData').addEventListener('click', () => {
      if (!confirm('Erase all races and profile info on this device? This cannot be undone.')) return;
      state = defaultState(); save(); applyTheme(); renderAll(); toast('Data erased');
    });
  }

  // ---------- Init ----------
  async function init() {
    applyTheme();
    renderThemeIcon();
    bind();
    try {
      const res = await fetch('data/events.json', { cache: 'no-cache' });
      if (res.ok) events = await res.json();
    } catch (e) { /* offline or file:// — finder shows a note */ }
    $('#officialFinder').href = events.findRaceUrl || $('#officialFinder').href;
    renderAll();
    let tab = 'dashboard';
    try { tab = localStorage.getItem(STORE_KEY + '.tab') || 'dashboard'; } catch (e) { /* ignore */ }
    if (!$(`#tab-${tab}`)) tab = 'dashboard';
    showTab(tab);
  }

  init();
})();
