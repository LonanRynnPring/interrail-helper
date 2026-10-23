// Train suggestions from Transitous (https://transitous.org), a free, community-run
// European journey planner. Requests are made only when the user asks for them.
(() => {
  'use strict';

  const API = 'https://api.transitous.org/api/v5/plan';
  // Rail plus local transport so cross-city transfers (e.g. Paris Nord → Gare de Lyon) work; no coaches/flights.
  const MODES = 'HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_FAST_RAIL,REGIONAL_RAIL,RAIL,SUBURBAN,SUBWAY,TRAM,BUS,FERRY';
  const CITY_RADIUS_KM = 12;
  const cache = new Map();

  function distKm(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  const isoDate = (d) => d.toISOString().slice(0, 10);

  // A near-future date (where timetables exist) on the same weekday as `target`.
  function typicalDate(target) {
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() + 7);
    if (target) {
      const want = new Date(target + 'T00:00:00Z').getUTCDay();
      while (d.getUTCDay() !== want) d.setUTCDate(d.getUTCDate() + 1);
    }
    return isoDate(d);
  }

  function trainName(leg) {
    let n = leg.displayName || leg.routeShortName || leg.routeLongName || leg.mode;
    const inner = n.match(/\(([^)]+)\)/);
    if (inner) n = inner[1];
    return n.replace(/^([a-z]{1,4})(?=[\s\d])/i, (s) => s.toUpperCase()).trim();
  }

  const OPERATORS = [
    [/OEBB|ÖBB/i, 'ÖBB'], [/CESKE DRAHY|ČESKÉ DRÁHY/i, 'ČD'], [/^DB |DB FERNVERKEHR|DB REGIO/i, 'DB'],
    [/SNCF/i, 'SNCF'], [/^NS\b|NS INTERNATIONAL/i, 'NS'], [/EUROSTAR/i, 'Eurostar'], [/TRENITALIA/i, 'Trenitalia'],
    [/RENFE/i, 'Renfe'], [/SBB|CFF|FFS/i, 'SBB'], [/PKP/i, 'PKP Intercity'], [/MÁV|MAV/i, 'MÁV'],
    [/NMBS|SNCB/i, 'SNCB'], [/DSB/i, 'DSB'], [/\bSJ\b/i, 'SJ'], [/VY\b|NSB/i, 'Vy'], [/ZSSK/i, 'ZSSK'],
    [/REGIOJET/i, 'RegioJet'], [/LEO EXPRESS/i, 'Leo Express'], [/ITALO|NTV/i, 'Italo'], [/FLIX/i, 'FlixTrain'],
  ];
  function operatorName(agency) {
    if (!agency) return '';
    for (const [re, name] of OPERATORS) if (re.test(agency)) return name;
    return agency.length > 24 ? agency.slice(0, 22) + '…' : agency;
  }

  // Rough Interrail reservation guide – not authoritative.
  function reservation(leg, name) {
    const s = `${name} ${leg.agencyName || ''}`.toUpperCase();
    if (/REGIOJET|LEO EXPRESS|FLIX|ITALO|\bNTV\b|WESTBAHN|OUIGO|AVLO|IRYO|ARENAWAYS/.test(s)) return 'notcovered';
    if (leg.mode === 'NIGHT_RAIL' || /NIGHTJET|EUROSTAR|TGV|INOUI|LYRIA|FRECCIA|SNABBT|X ?2000/.test(s)) return 'required';
    if (/^(EST|FR|FA|FB|AVE|ALVIA|AVANT|EIC|EIP|EN|NJ|ICN|SC|TLK)\b/.test(name.toUpperCase())) return 'required';
    if (/PKP/.test(s) && /^(IC|TLK|EIC|EIP)\b/i.test(name)) return 'required';
    if (/TRENITALIA/.test(s) && /^IC/i.test(name)) return 'required';
    if (/RENFE/.test(s) && (leg.mode === 'HIGHSPEED_RAIL' || leg.mode === 'LONG_DISTANCE')) return 'required';
    if (leg.mode === 'HIGHSPEED_RAIL' || leg.mode === 'LONG_DISTANCE') return 'optional';
    return 'none';
  }

  // Strip local legs at either end (walks, metro, RER…) so we show the "real" trains between cities.
  function simplify(it, from, to) {
    let legs = it.legs.filter((l) => l.mode !== 'WALK');
    while (legs.length > 1 && distKm(from, legs[0].to) < CITY_RADIUS_KM) legs = legs.slice(1);
    while (legs.length > 1 && distKm(to, legs[legs.length - 1].from) < CITY_RADIUS_KM) legs = legs.slice(0, -1);
    if (!legs.length) return null;
    const trains = legs.map((l) => {
      const name = trainName(l);
      return {
        name, mode: l.mode, operator: operatorName(l.agencyName), res: reservation(l, name),
        from: l.from.name, to: l.to.name, dep: l.startTime, arr: l.endTime, depTz: l.from.tz, arrTz: l.to.tz,
      };
    });
    const first = trains[0], last = trains[trains.length - 1];
    const res = trains.some((t) => t.res === 'required') ? 'required'
      : trains.some((t) => t.res === 'optional') ? 'optional' : 'none';
    return {
      dep: first.dep, arr: last.arr, depTz: first.depTz, arrTz: last.arrTz,
      fromStation: first.from, toStation: last.to,
      mins: Math.round((new Date(last.arr) - new Date(first.dep)) / 60000),
      changes: trains.length - 1, trains, res,
      notCovered: trains.some((t) => t.res === 'notcovered'),
      key: trains.map((t) => t.name).join('>') + '@' + first.dep,
    };
  }

  async function plan(from, to, date) {
    const url = `${API}?fromPlace=${from.lat},${from.lon}&toPlace=${to.lat},${to.lon}&time=${date}T02:00:00Z`
      + `&searchWindow=79200&numItineraries=12&maxPreTransitTime=1800&maxPostTransitTime=1800&transitModes=${MODES}`;
    if (cache.has(url)) return cache.get(url);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Train search failed (${res.status})`);
    const data = await res.json();
    const seen = new Map();
    (data.itineraries || []).forEach((it) => {
      const o = simplify(it, from, to);
      if (!o) return;
      const prev = seen.get(o.key);
      if (!prev || o.mins < prev.mins) seen.set(o.key, o);
    });
    const localDay = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso));
    let options = [...seen.values()].filter((o) => localDay(o.dep, o.depTz) === date);
    if (options.length) {
      const fastest = Math.min(...options.map((o) => o.mins));
      options = options.filter((o) => o.mins <= Math.max(fastest * 1.8, fastest + 180));
    }
    options.sort((a, b) => a.dep.localeCompare(b.dep));
    cache.set(url, options);
    return options;
  }

  /** Find trains between two {lat, lon} points. Falls back to a typical day when the date has no timetable yet. */
  async function search(from, to, date) {
    const today = isoDate(new Date());
    if (date && date >= today) {
      const options = await plan(from, to, date);
      if (options.length) return { options, searchedDate: date, typical: false };
    }
    const typical = typicalDate(date);
    return { options: await plan(from, to, typical), searchedDate: typical, typical: true };
  }

  function summary(options) {
    if (!options.length) return null;
    return {
      fastest: Math.min(...options.map((o) => o.mins)),
      direct: options.some((o) => o.changes === 0),
      count: options.length,
    };
  }

  function fmtTime(iso, tz) {
    return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz || undefined }).format(new Date(iso));
  }

  // +N days between departure and arrival, in their local time zones.
  function dayOffset(o) {
    const day = (iso, tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC' }).format(new Date(iso));
    return Math.round((new Date(day(o.arr, o.arrTz)) - new Date(day(o.dep, o.depTz))) / 86400000);
  }

  window.TrainSuggest = { search, summary, typicalDate, fmtTime, dayOffset };
})();
