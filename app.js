(() => {
  'use strict';

  const STORAGE_KEY = 'interrail-helper-v1';
  const FILE_FORMAT = 'interrail-helper';
  const FILE_VERSION = 1;

  const DEFAULT_PACKING = [
    'Passport / ID', 'Interrail pass (Rail Planner app)', 'Phone charger & power bank',
    'Travel adapter', 'Padlock for hostel lockers', 'Travel towel', 'Reusable water bottle',
    'Earplugs & eye mask', 'Snacks for long journeys', 'Bank card + some cash',
    'European Health Insurance Card / travel insurance', 'Flip-flops for showers',
  ];

  const emptyState = () => ({
    trip: {
      name: '', startDate: '', endDate: '', travellers: 1, currency: 'EUR',
      passType: '', travelDaysAllowed: '', passCost: '', notes: '',
    },
    plan: { startDate: '', stops: [] },
    journeys: [],
    stays: [],
    packing: [],
  });

  let state = load();

  // ---------- helpers ----------
  const $ = (sel) => document.querySelector(sel);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v === '' || v == null || isNaN(+v) ? 0 : +v);

  function money(n) {
    const cur = (state.trip.currency || 'EUR').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 2 }).format(n);
    } catch {
      return `${n.toFixed(2)} ${cur}`;
    }
  }

  function fmtDate(iso, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d) ? iso : d.toLocaleDateString(undefined, opts);
  }

  function daysBetween(a, b) {
    if (!a || !b) return null;
    const ms = new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00');
    return isNaN(ms) ? null : Math.round(ms / 86400000);
  }

  function duration(dep, arr) {
    if (!dep || !arr) return null;
    const [dh, dm] = dep.split(':').map(Number);
    const [ah, am] = arr.split(':').map(Number);
    let mins = ah * 60 + am - (dh * 60 + dm);
    let overnight = false;
    if (mins < 0) { mins += 1440; overnight = true; }
    return { text: `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`, overnight };
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- persistence ----------
  function normalise(data) {
    const base = emptyState();
    if (!data || typeof data !== 'object') return base;
    return {
      trip: { ...base.trip, ...(data.trip || {}) },
      plan: {
        startDate: (data.plan && data.plan.startDate) || '',
        stops: data.plan && Array.isArray(data.plan.stops)
          ? data.plan.stops.map((s) => ({ id: uid(), days: 1, ...s, geo: s.geo === 'pending' ? undefined : s.geo }))
          : [],
      },
      journeys: Array.isArray(data.journeys) ? data.journeys.map((j) => ({ id: uid(), ...j })) : [],
      stays: Array.isArray(data.stays) ? data.stays.map((s) => ({ id: uid(), ...s })) : [],
      packing: Array.isArray(data.packing) ? data.packing.map((p) => ({ id: uid(), done: false, ...p })) : [],
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? normalise(JSON.parse(raw)) : emptyState();
    } catch {
      return emptyState();
    }
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      $('#saveStatus').textContent = 'Saved in browser ✓';
    } catch {
      $('#saveStatus').textContent = 'Not saved in browser – use Export';
    }
    render();
  }

  function exportFile() {
    const payload = { format: FILE_FORMAT, version: FILE_VERSION, exportedAt: new Date().toISOString(), ...state };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const slug = (state.trip.name || 'interrail-trip').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'interrail-trip';
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('Plan exported');
  }

  function importFile(file) {
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(reader.result);
      } catch {
        toast('That file isn’t valid JSON');
        return;
      }
      if (data.format !== FILE_FORMAT) {
        toast('That doesn’t look like an Interrail Helper save file');
        return;
      }
      const hasData = state.journeys.length || state.stays.length || state.packing.length || state.trip.name;
      if (hasData && !confirm('Importing will replace your current plan. Continue?')) return;
      state = normalise(data);
      save();
      fillTripForm();
      geocodeMissing();
      toast(`Imported “${state.trip.name || file.name}”`);
    };
    reader.readAsText(file);
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    try { localStorage.setItem(STORAGE_KEY + '-tab', name); } catch { /* ignore */ }
    if (location.hash !== '#' + name) history.replaceState(null, '', '#' + name);
    if (name === 'planner') renderMap();
  }

  // ---------- derived ----------
  const sortedJourneys = () =>
    [...state.journeys].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999') || (a.dep || '').localeCompare(b.dep || ''));

  function travelDaysUsed() {
    return new Set(state.journeys.filter((j) => j.passDay && j.date).map((j) => j.date)).size;
  }

  // ---------- render ----------
  function render() {
    renderHeader();
    renderOverview();
    renderPlanner();
    renderTrains();
    renderStays();
    renderPacking();
  }

  function renderHeader() {
    const t = state.trip;
    $('#tripTitle').textContent = t.name || 'Interrail Helper';
    const bits = [];
    if (t.startDate) bits.push(`${fmtDate(t.startDate)}${t.endDate ? ' – ' + fmtDate(t.endDate) : ''}`);
    if (t.passType) bits.push(t.passType);
    $('#tripSubtitle').textContent = bits.join(' · ') || 'Plan your trip, save it to a file';
    document.title = t.name ? `${t.name} · Interrail Helper` : 'Interrail Helper';
  }

  function stat(value, label, cls = '') {
    return `<div class="stat ${cls}"><div class="value">${esc(value)}</div><div class="label">${esc(label)}</div></div>`;
  }

  function renderOverview() {
    const t = state.trip;
    const nights = daysBetween(t.startDate, t.endDate);
    const allowed = num(t.travelDaysAllowed);
    const used = travelDaysUsed();
    const resCost = state.journeys.reduce((s, j) => s + num(j.resCost), 0);
    const stayCost = state.stays.reduce((s, x) => s + num(x.cost), 0);
    const total = num(t.passCost) + resCost + stayCost;
    const cities = new Set(state.journeys.flatMap((j) => [j.from, j.to]).filter(Boolean));
    const packed = state.packing.filter((p) => p.done).length;

    $('#overviewStats').innerHTML = [
      stat(nights != null && nights >= 0 ? nights + 1 : '–', 'trip days'),
      stat(allowed ? `${used} / ${allowed}` : used, 'pass travel days used', allowed && used > allowed ? 'warn' : ''),
      stat(state.journeys.length, 'train journeys'),
      stat(cities.size, 'places'),
      stat(money(total), 'planned spend'),
      stat(state.packing.length ? `${packed}/${state.packing.length}` : '–', 'packed'),
    ].join('');

    const stops = [];
    sortedJourneys().forEach((j) => {
      if (stops[stops.length - 1] !== j.from) stops.push(j.from);
      stops.push(j.to);
    });
    $('#routeLine').innerHTML = stops.length
      ? stops.map((c) => `<span class="city">${esc(c)}</span>`).join('<span class="arrow">→</span>')
      : '<span class="muted">Add train journeys to see your route here.</span>';
  }

  function resPill(j) {
    switch (j.resStatus) {
      case 'booked': return `<span class="pill ok">Reservation booked</span>`;
      case 'todo': return `<span class="pill warn">Reservation needed</span>`;
      case 'optional': return `<span class="pill">Reservation optional</span>`;
      default: return '';
    }
  }

  function renderTrains() {
    const js = sortedJourneys();
    const allowed = num(state.trip.travelDaysAllowed);
    const used = travelDaysUsed();
    const todo = js.filter((j) => j.resStatus === 'todo').length;
    const resCost = js.reduce((s, j) => s + num(j.resCost), 0);
    const totalMins = js.reduce((s, j) => {
      const d = duration(j.dep, j.arr);
      if (!d) return s;
      const [h, m] = d.text.match(/\d+/g).map(Number);
      return s + h * 60 + m;
    }, 0);

    $('#trainStats').innerHTML = [
      stat(js.length, 'journeys'),
      stat(allowed ? `${used} / ${allowed}` : used, 'pass travel days used', allowed && used > allowed ? 'warn' : allowed ? 'ok' : ''),
      stat(todo, 'reservations to book', todo ? 'warn' : 'ok'),
      stat(money(resCost), 'reservation costs'),
      stat(`${Math.floor(totalMins / 60)}h ${totalMins % 60}m`, 'time on trains'),
    ].join('');

    if (!js.length) {
      $('#journeyList').innerHTML = `<div class="empty"><div class="big">🛤️</div><p>No journeys yet.</p><p>Click <strong>+ Add journey</strong> to plan your first train.</p></div>`;
      return;
    }

    const groups = new Map();
    js.forEach((j) => {
      const k = j.date || '';
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(j);
    });

    let html = '';
    groups.forEach((list, date) => {
      const dayNo = state.trip.startDate && date ? daysBetween(state.trip.startDate, date) + 1 : null;
      const passDay = list.some((j) => j.passDay);
      html += `<div class="day-group"><h3 class="day-head">${date ? esc(fmtDate(date, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) : 'No date'}
        ${dayNo && dayNo > 0 ? `<span class="muted">Day ${dayNo}</span>` : ''}
        ${passDay ? '<span class="pill accent">Pass day</span>' : ''}</h3>`;
      list.forEach((j) => {
        const d = duration(j.dep, j.arr);
        const meta = [
          j.train ? `<span class="pill">${esc(j.train)}</span>` : '',
          j.operator ? `<span class="pill">${esc(j.operator)}</span>` : '',
          resPill(j),
          num(j.resCost) ? `<span class="pill">${esc(money(num(j.resCost)))}</span>` : '',
          j.seat ? `<span class="pill">💺 ${esc(j.seat)}</span>` : '',
        ].join('');
        html += `<button type="button" class="ticket" data-journey="${esc(j.id)}">
          <div class="ticket-route">
            <div class="stn"><div class="time">${esc(j.dep || '--:--')}</div><div class="place">${esc(j.from)}</div></div>
            <div class="mid">${d ? esc(d.text) : ''}<div class="line"></div>${d && d.overnight ? 'overnight' : ''}</div>
            <div class="stn right"><div class="time">${esc(j.arr || '--:--')}${d && d.overnight ? '<sup>+1</sup>' : ''}</div><div class="place">${esc(j.to)}</div></div>
          </div>
          <div class="ticket-meta">${meta}</div>
          ${j.notes ? `<div class="ticket-notes">${esc(j.notes)}</div>` : ''}
        </button>`;
      });
      html += '</div>';
    });
    $('#journeyList').innerHTML = html;
  }

  function renderStays() {
    const stays = [...state.stays].sort((a, b) => (a.checkIn || '9999').localeCompare(b.checkIn || '9999'));
    if (!stays.length) {
      $('#stayList').innerHTML = `<div class="empty"><div class="big">🛏️</div><p>No stays yet.</p><p>Add hostels, hotels or friends’ sofas.</p></div>`;
      return;
    }
    $('#stayList').innerHTML = stays.map((s) => {
      const n = daysBetween(s.checkIn, s.checkOut);
      return `<button type="button" class="ticket stay" data-stay="${esc(s.id)}">
        <div>
          <div class="title">${esc(s.city)}${s.name ? ' · ' + esc(s.name) : ''}</div>
          <div class="muted">${s.checkIn ? esc(fmtDate(s.checkIn)) : '?'} → ${s.checkOut ? esc(fmtDate(s.checkOut)) : '?'}${n > 0 ? ` · ${n} night${n > 1 ? 's' : ''}` : ''}</div>
          ${s.address ? `<div class="muted">${esc(s.address)}</div>` : ''}
        </div>
        <div class="ticket-meta">
          ${s.booked ? '<span class="pill ok">Booked</span>' : '<span class="pill warn">Not booked</span>'}
          ${num(s.cost) ? `<span class="pill">${esc(money(num(s.cost)))}</span>` : ''}
        </div>
        ${s.notes ? `<div class="ticket-notes">${esc(s.notes)}</div>` : ''}
      </button>`;
    }).join('');
  }

  function renderPacking() {
    const done = state.packing.filter((p) => p.done).length;
    $('#packingCount').textContent = state.packing.length ? `${done} of ${state.packing.length} packed` : '';
    $('#packingList').innerHTML = state.packing.map((p) => `
      <li class="${p.done ? 'done' : ''}">
        <input type="checkbox" data-pack-toggle="${esc(p.id)}" ${p.done ? 'checked' : ''} aria-label="Packed">
        <span>${esc(p.text)}</span>
        <button type="button" class="remove" data-pack-remove="${esc(p.id)}" aria-label="Remove">×</button>
      </li>`).join('');
  }

  // ---------- planner ----------
  const hue = (i) => Math.round((i * 137.508 + 210) % 360);

  function addDays(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Each stop: arrive on `arrive`, leave on `depart` (= next stop's arrival, a travel day).
  function schedule() {
    const { startDate, stops } = state.plan;
    if (!startDate) return null;
    let offset = 0;
    const legs = stops.map((s, i) => {
      const days = Math.max(1, Math.round(num(s.days)) || 1);
      const leg = { stop: s, index: i, arrive: addDays(startDate, offset), depart: addDays(startDate, offset + days), days };
      offset += days;
      return leg;
    });
    return { legs, start: startDate, end: addDays(startDate, offset), total: offset };
  }

  function stopLabel(s) {
    return s.country ? `${s.city}, ${s.country}` : s.city;
  }

  function renderPlanner() {
    const sched = schedule();
    const stops = state.plan.stops;
    $('#planStart').value = state.plan.startDate || '';

    $('#stopList').innerHTML = stops.map((s, i) => {
      const leg = sched && sched.legs[i];
      const where = s.geo === 'missing' ? '<span class="sub warn">Location not found – not shown on map</span>'
        : s.geo === 'error' ? '<span class="sub warn">Couldn’t look up location</span>'
        : s.lat == null ? '<span class="sub">Finding on map…</span>' : '';
      const dates = leg ? `<span class="sub">${esc(fmtDate(leg.arrive))} → ${esc(fmtDate(leg.depart))}</span>` : '';
      return `<li style="--h:${hue(i)}">
        <span class="stop-num">${i + 1}</span>
        <div class="stop-name"><div class="city">${esc(stopLabel(s))}</div>${dates}${dates && where ? '<br>' : ''}${where}</div>
        <input type="number" min="1" value="${esc(s.days)}" data-stop-days="${esc(s.id)}" aria-label="Days in ${esc(s.city)}" title="Days (nights)">
        <div class="stop-btns">
          <button type="button" class="icon-btn" data-stop-move="-1" data-id="${esc(s.id)}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">▲</button>
          <button type="button" class="icon-btn" data-stop-move="1" data-id="${esc(s.id)}" ${i === stops.length - 1 ? 'disabled' : ''} aria-label="Move down">▼</button>
          <button type="button" class="icon-btn" data-stop-remove="${esc(s.id)}" aria-label="Remove">×</button>
        </div>
      </li>`;
    }).join('') || '<li class="muted" style="display:block">Add the cities you want to visit, in order.</li>';

    if (!stops.length) $('#planSummary').textContent = '';
    else if (!sched) $('#planSummary').innerHTML = `<strong>${stops.length}</strong> stops · pick a start date to build your calendar.`;
    else $('#planSummary').innerHTML = `<strong>${stops.length}</strong> stops · <strong>${sched.total}</strong> nights · ${esc(fmtDate(sched.start))} → <strong>${esc(fmtDate(sched.end))}</strong> · <strong>${Math.max(0, stops.length - 1)}</strong> train travel days between cities`;

    renderCalendar(sched);
    if ($('#panel-planner').classList.contains('active')) renderMap();
  }

  function renderCalendar(sched) {
    const el = $('#calendar');
    if (!sched || !sched.legs.length) {
      el.innerHTML = `<div class="empty"><div class="big">📅</div><p>Add a start date and some cities to see your calendar.</p></div>`;
      return;
    }
    const byDate = new Map();
    sched.legs.forEach((leg) => {
      for (let d = leg.arrive; d < leg.depart; d = addDays(d, 1)) byDate.set(d, { leg });
    });
    // Travel days: arrival day of every stop after the first
    sched.legs.slice(1).forEach((leg) => byDate.set(leg.arrive, { leg, from: sched.legs[leg.index - 1] }));
    const last = sched.legs[sched.legs.length - 1];
    byDate.set(sched.end, { leg: last, leaving: true });

    const months = [];
    let cursor = sched.start.slice(0, 7) + '-01';
    const endMonth = sched.end.slice(0, 7);
    while (cursor.slice(0, 7) <= endMonth) {
      months.push(cursor);
      const d = new Date(cursor + 'T00:00:00Z');
      d.setUTCMonth(d.getUTCMonth() + 1);
      cursor = d.toISOString().slice(0, 10);
    }

    const dows = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const html = months.map((m) => {
      const first = new Date(m + 'T00:00:00Z');
      const lead = (first.getUTCDay() + 6) % 7;
      const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
      let cells = dows.map((d) => `<div class="dow">${d}</div>`).join('');
      cells += '<div class="day blank"></div>'.repeat(lead);
      for (let n = 1; n <= daysInMonth; n++) {
        const iso = m.slice(0, 8) + String(n).padStart(2, '0');
        const info = byDate.get(iso);
        if (!info) { cells += `<div class="day"><span class="n">${n}</span></div>`; continue; }
        const h = hue(info.leg.index);
        if (info.from) {
          const title = `${info.from.stop.city} → ${info.leg.stop.city}`;
          cells += `<div class="day travel" style="--h:${hue(info.from.index)};--h2:${h}" title="${esc(title)}"><span class="n">${n}</span><span class="c">→ ${esc(info.leg.stop.city)}</span></div>`;
        } else if (info.leaving) {
          cells += `<div class="day travel" style="--h:${h};--h2:${h}" title="Leave ${esc(info.leg.stop.city)}"><span class="n">${n}</span><span class="c">Leave ${esc(info.leg.stop.city)}</span></div>`;
        } else {
          cells += `<div class="day in" style="--h:${h}" title="${esc(stopLabel(info.leg.stop))}"><span class="n">${n}</span><span class="c">${esc(info.leg.stop.city)}</span></div>`;
        }
      }
      const name = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
      return `<div class="month"><h3>${esc(name)}</h3><div class="cal">${cells}</div></div>`;
    }).join('');

    const legend = sched.legs.map((l) =>
      `<span style="--h:${hue(l.index)}"><i></i>${esc(l.stop.city)} · ${esc(fmtDate(l.arrive, { day: 'numeric', month: 'short' }))}–${esc(fmtDate(l.depart, { day: 'numeric', month: 'short' }))} (${l.days} night${l.days > 1 ? 's' : ''})</span>`
    ).join('');
    el.innerHTML = `<div class="months">${html}</div><div class="legend">${legend}</div>`;
  }

  // Map (Leaflet + OpenStreetMap)
  let map = null;
  let mapLayer = null;
  function renderMap() {
    if (typeof L === 'undefined') {
      $('#map').innerHTML = '<div class="empty" style="margin:16px">Map couldn’t load – check your connection.</div>';
      return;
    }
    if (!map) {
      map = L.map('map', { scrollWheelZoom: false }).setView([50, 10], 4);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 18,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      }).addTo(map);
      mapLayer = L.layerGroup().addTo(map);
    }
    map.invalidateSize();
    mapLayer.clearLayers();
    const sched = schedule();
    const pts = [];
    state.plan.stops.forEach((s, i) => {
      if (s.lat == null || s.lon == null) return;
      const ll = [s.lat, s.lon];
      pts.push(ll);
      const leg = sched && sched.legs[i];
      const icon = L.divIcon({ className: '', html: `<div class="map-pin" style="--h:${hue(i)}">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
      L.marker(ll, { icon, title: s.city })
        .bindPopup(`<strong>${esc(stopLabel(s))}</strong><br>${s.days} night${s.days > 1 ? 's' : ''}${leg ? `<br>${esc(fmtDate(leg.arrive))} → ${esc(fmtDate(leg.depart))}` : ''}`)
        .addTo(mapLayer);
    });
    if (pts.length > 1) L.polyline(pts, { color: '#1f4e8c', weight: 3, dashArray: '6 6', opacity: .8 }).addTo(mapLayer);
    if (pts.length === 1) map.setView(pts[0], 6);
    else if (pts.length > 1) map.fitBounds(pts, { padding: [40, 40] });
  }

  // Geocoding via OpenStreetMap Nominatim (max 1 request/second)
  let geoQueue = Promise.resolve();
  const pendingGeo = new Set();
  function geocode(stopId) {
    if (pendingGeo.has(stopId)) return;
    pendingGeo.add(stopId);
    geoQueue = geoQueue.then(async () => {
      const s = state.plan.stops.find((x) => x.id === stopId);
      if (!s) { pendingGeo.delete(stopId); return; }
      try {
        const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&featureType=settlement&q=' + encodeURIComponent(stopLabel(s));
        const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
        const data = await res.json();
        if (data[0]) { s.lat = +data[0].lat; s.lon = +data[0].lon; s.geo = 'ok'; } else s.geo = 'missing';
      } catch {
        s.geo = 'error';
      }
      pendingGeo.delete(stopId);
      save();
      await new Promise((r) => setTimeout(r, 1100));
    });
  }
  function geocodeMissing() {
    state.plan.stops.filter((s) => s.lat == null && s.geo !== 'missing').forEach((s) => geocode(s.id));
  }

  $('#planStart').addEventListener('change', (e) => { state.plan.startDate = e.target.value; save(); });

  $('#stopForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const city = f.city.value.trim();
    if (!city) return;
    const stop = { id: uid(), city, country: f.country.value.trim(), days: Math.max(1, Math.round(num(f.days.value)) || 1) };
    state.plan.stops.push(stop);
    if (!state.plan.startDate && state.trip.startDate) state.plan.startDate = state.trip.startDate;
    f.city.value = '';
    f.city.focus();
    save();
    geocode(stop.id);
  });

  $('#stopList').addEventListener('change', (e) => {
    const id = e.target.dataset.stopDays;
    const s = state.plan.stops.find((x) => x.id === id);
    if (s) { s.days = Math.max(1, Math.round(num(e.target.value)) || 1); save(); }
  });

  $('#stopList').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const stops = state.plan.stops;
    if (btn.dataset.stopRemove) {
      state.plan.stops = stops.filter((s) => s.id !== btn.dataset.stopRemove);
      save();
    } else if (btn.dataset.stopMove) {
      const i = stops.findIndex((s) => s.id === btn.dataset.id);
      const j = i + Number(btn.dataset.stopMove);
      if (i < 0 || j < 0 || j >= stops.length) return;
      [stops[i], stops[j]] = [stops[j], stops[i]];
      save();
    }
  });

  $('#applyDatesBtn').addEventListener('click', () => {
    const sched = schedule();
    if (!sched || !sched.legs.length) { toast('Add a start date and at least one city first'); return; }
    state.trip.startDate = sched.start;
    state.trip.endDate = sched.end;
    fillTripForm();
    save();
    toast(`Trip dates set to ${fmtDate(sched.start)} – ${fmtDate(sched.end)}`);
  });

  $('#makeJourneysBtn').addEventListener('click', () => {
    const sched = schedule();
    if (!sched || sched.legs.length < 2) { toast('Add a start date and at least two cities first'); return; }
    const key = (j) => `${(j.from || '').toLowerCase()}|${(j.to || '').toLowerCase()}|${j.date}`;
    const have = new Set(state.journeys.map(key));
    let added = 0;
    sched.legs.slice(1).forEach((leg) => {
      const j = { id: uid(), from: sched.legs[leg.index - 1].stop.city, to: leg.stop.city, date: leg.arrive, passDay: true, resStatus: 'none' };
      if (have.has(key(j))) return;
      state.journeys.push(j);
      added++;
    });
    save();
    toast(added ? `Added ${added} journey${added > 1 ? 's' : ''} to Train Journeys` : 'Those journeys are already in Train Journeys');
  });

  // ---------- trip form ----------
  function fillTripForm() {
    const f = $('#tripForm');
    Object.entries(state.trip).forEach(([k, v]) => { if (f.elements[k]) f.elements[k].value = v ?? ''; });
  }

  $('#tripForm').addEventListener('input', (e) => {
    const el = e.target;
    if (!el.name) return;
    state.trip[el.name] = el.value;
    if (el.name === 'passType') {
      const m = el.value.match(/(\d+) days in/);
      if (m && !state.trip.travelDaysAllowed) {
        state.trip.travelDaysAllowed = m[1];
        $('#tripForm').elements.travelDaysAllowed.value = m[1];
      }
    }
    save();
  });

  // ---------- generic dialog editing ----------
  function setupEditor({ dialog, form, title, deleteBtn, collection, label, defaults }) {
    let editingId = null;
    const dlg = $(dialog);
    const frm = $(form);

    function open(id) {
      editingId = id || null;
      const item = id ? state[collection].find((x) => x.id === id) : defaults();
      frm.reset();
      Array.from(frm.elements).forEach((el) => {
        if (!el.name) return;
        if (el.type === 'checkbox') el.checked = !!item[el.name];
        else el.value = item[el.name] ?? '';
      });
      $(title).textContent = id ? `Edit ${label}` : `Add ${label}`;
      $(deleteBtn).hidden = !id;
      dlg.showModal();
    }

    frm.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = {};
      Array.from(frm.elements).forEach((el) => {
        if (!el.name) return;
        data[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
      });
      if (editingId) {
        const i = state[collection].findIndex((x) => x.id === editingId);
        state[collection][i] = { ...state[collection][i], ...data };
      } else {
        state[collection].push({ id: uid(), ...data });
      }
      dlg.close();
      save();
      toast(`${label[0].toUpperCase() + label.slice(1)} saved`);
    });

    $(deleteBtn).addEventListener('click', () => {
      if (!editingId || !confirm(`Delete this ${label}?`)) return;
      state[collection] = state[collection].filter((x) => x.id !== editingId);
      dlg.close();
      save();
    });

    dlg.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => dlg.close()));
    return open;
  }

  const openJourney = setupEditor({
    dialog: '#journeyDialog', form: '#journeyForm', title: '#journeyDialogTitle',
    deleteBtn: '#deleteJourneyBtn', collection: 'journeys', label: 'journey',
    defaults: () => {
      const last = sortedJourneys().at(-1);
      return { from: last ? last.to : '', date: last ? last.date : state.trip.startDate, passDay: true, resStatus: 'none' };
    },
  });

  const openStay = setupEditor({
    dialog: '#stayDialog', form: '#stayForm', title: '#stayDialogTitle',
    deleteBtn: '#deleteStayBtn', collection: 'stays', label: 'stay',
    defaults: () => {
      const lastJ = sortedJourneys().at(-1);
      return { city: lastJ ? lastJ.to : '', checkIn: lastJ ? lastJ.date : state.trip.startDate };
    },
  });

  $('#addJourneyBtn').addEventListener('click', () => openJourney());
  $('#addStayBtn').addEventListener('click', () => openStay());
  $('#journeyList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-journey]');
    if (t) openJourney(t.dataset.journey);
  });
  $('#stayList').addEventListener('click', (e) => {
    const t = e.target.closest('[data-stay]');
    if (t) openStay(t.dataset.stay);
  });

  // ---------- packing ----------
  $('#packingForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = e.target.elements.text;
    const text = input.value.trim();
    if (!text) return;
    state.packing.push({ id: uid(), text, done: false });
    input.value = '';
    save();
  });
  $('#packingList').addEventListener('change', (e) => {
    const id = e.target.dataset.packToggle;
    const item = state.packing.find((p) => p.id === id);
    if (item) { item.done = e.target.checked; save(); }
  });
  $('#packingList').addEventListener('click', (e) => {
    const id = e.target.dataset.packRemove;
    if (!id) return;
    state.packing = state.packing.filter((p) => p.id !== id);
    save();
  });
  $('#packingDefaultsBtn').addEventListener('click', () => {
    const have = new Set(state.packing.map((p) => p.text.toLowerCase()));
    const add = DEFAULT_PACKING.filter((t) => !have.has(t.toLowerCase()));
    add.forEach((text) => state.packing.push({ id: uid(), text, done: false }));
    save();
    toast(add.length ? `Added ${add.length} items` : 'You already have them all');
  });

  // ---------- file actions ----------
  $('#exportBtn').addEventListener('click', exportFile);
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importFile(file);
    e.target.value = '';
  });
  $('#resetBtn').addEventListener('click', () => {
    if (!confirm('Clear everything and start a new plan? Export first if you want to keep this one.')) return;
    state = emptyState();
    save();
    fillTripForm();
  });

  // ---------- init ----------
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
  const tabs = ['overview', 'planner', 'trains', 'stays', 'packing'];
  let initial = location.hash.slice(1);
  if (!tabs.includes(initial)) {
    try { initial = localStorage.getItem(STORAGE_KEY + '-tab'); } catch { initial = null; }
  }
  showTab(tabs.includes(initial) ? initial : 'trains');
  fillTripForm();
  render();
  geocodeMissing();
})();
