// Persistent Open-Meteo transport state and incremental historical forecasts.
// All dates/keys below are local Asia/Seoul hours, matching collect.mjs.
const HOUR = 3600000, DAY = 24 * HOUR;
const WEATHER = {
  wind_speed_10m: "wind", wind_gusts_10m: "gust", visibility: "vis",
  temperature_2m: "temp", dew_point_2m: "dew", relative_humidity_2m: "rh", cloud_cover_low: "cloudLow",
};
const MARINE = { wave_height: "wave", sea_surface_temperature: "sst" };
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
const dates = (start, end) => {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
};
const validNumber = x => x === null || (typeof x === "number" && Number.isFinite(x));
const timeKey = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):00$/;
export function retryAfterMs(value, now) {
  if (!value) return 0;
  const seconds = Number(value);
  return Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : (Date.parse(value) - now) || 0);
}

export function createOpenMeteo({ point, readJSON, writeJSON, fetchImpl = globalThis.fetch,
  now = Date.now, sleep = ms => new Promise(r => setTimeout(r, ms)), random = Math.random }) {
  // Bump version when endpoints, default model selection, variables or units change.
  const key = JSON.stringify({ version: 1, lat: point.lat, lon: point.lon,
    timezone: "Asia/Seoul", wind_speed_unit: "ms", cell_selection: "sea",
    weather: Object.keys(WEATHER), marine: Object.keys(MARINE) });
  const loaded = readJSON("om-history.json", null);
  const cache = loaded?.key === key ? loaded : { key, streams: {} };
  cache.streams ||= {};
  const transport = readJSON("om-http-state.json", {}) || {};
  transport.hosts ||= {};
  const stats = { requests: 0, retries: 0, events: [] };
  const save = () => writeJSON("om-history.json", cache);
  function cooldown(host, ms, reason) {
    transport.hosts[host] = { until: now() + ms, reason };
    writeJSON("om-http-state.json", transport);
  }

  async function get(url) {
    const host = new URL(url).hostname;
    const gate = transport.hosts[host];
    if (gate?.until > now()) throw new Error(`Open-Meteo cooldown ${host} until ${new Date(gate.until).toISOString()} (${gate.reason})`);
    for (let attempt = 0; attempt < 3; attempt++) {
      let wait = 0;
      try {
        stats.requests++;
        const r = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
        stats.events.push({ host, status: r.status });
        if (!r.ok) {
          const hint = retryAfterMs(r.headers.get("retry-after"), now());
          let detail = "";
          try {
            const body = await r.json();
            if (typeof body?.reason === "string") detail = body.reason.slice(0, 160);
          } catch { /* A non-JSON error body must not turn HTTP 400 into a retry. */ }
          if (detail) stats.events.at(-1).reason = detail;
          if (hint) stats.events.at(-1).retryAfterMs = hint;
          const message = `Open-Meteo HTTP ${r.status} ${host}${detail ? ": " + detail : ""}`;
          // Preserve long server deadlines across Actions jobs; do not sleep for an hour.
          if (r.status === 429) {
            cooldown(host, Math.max(HOUR, hint), "HTTP 429");
            throw Object.assign(new Error(message), { terminal: true });
          }
          if (![408, 425].includes(r.status) && (r.status < 500 || r.status > 599))
            throw Object.assign(new Error(message), { terminal: true });
          if (hint > 60000) {
            cooldown(host, hint, `HTTP ${r.status}`);
            throw Object.assign(new Error(`Open-Meteo HTTP ${r.status}, deferred ${host}`), { terminal: true });
          }
          wait = hint;
          throw new Error(message);
        }
        const body = await r.json();
        if (body?.error) throw Object.assign(new Error(`Open-Meteo API error: ${body.reason || "unknown"}`), { terminal: true });
        return body;
      } catch (e) {
        if (e.terminal) throw e;
        if (attempt === 2) {
          cooldown(host, 15 * 60000, "transient failure after 3 attempts");
          throw e;
        }
        stats.retries++;
        await sleep(Math.max(wait, 1000 * 2 ** attempt + Math.floor(random() * 500)));
      }
    }
  }

  function parseHourly(body, fields, start, end) {
    const h = body?.hourly;
    if (!Array.isArray(h?.time) || !h.time.length) throw new Error("Open-Meteo empty hourly response");
    for (const field of Object.keys(fields))
      if (!Array.isArray(h[field]) || h[field].length !== h.time.length || !h[field].every(validNumber))
        throw new Error(`Open-Meteo invalid hourly array: ${field}`);
    const rows = {}, seen = new Set();
    h.time.forEach((t, i) => {
      if (typeof t !== "string" || !timeKey.test(t) || seen.has(t)) throw new Error("Open-Meteo invalid/duplicate hourly timestamp");
      seen.add(t);
      if (t.slice(0, 10) >= start && t.slice(0, 10) <= end)
        rows[t] = Object.fromEntries(Object.entries(fields).map(([field, name]) => [name, h[field][i]]));
    });
    if (!Object.keys(rows).length) throw new Error("Open-Meteo response outside requested dates");
    return rows;
  }
  function complete(entry, day, fields) {
    // Missing optional values remain null, as in the original implementation.
    const essential = fields === WEATHER ? "wind" : "wave";
    return Array.from({ length: 24 }, (_, h) => `${day}T${String(h).padStart(2, "0")}:00`).every(t => {
      const row = entry?.hours?.[t];
      return row && Object.values(fields).every(k => validNumber(row[k])) && Number.isFinite(row[essential]);
    });
  }
  function rangesFor(missing) {
    const ranges = [];
    for (const d of missing) {
      const last = ranges.at(-1);
      if (last && addDays(last[1], 1) === d && dates(last[0], d).length <= 14) last[1] = d;
      else ranges.push([d, d]);
    }
    return ranges;
  }

  async function history(start, end) {
    const wanted = dates(start, end), errors = [], requestedRanges = [];
    // Refresh recent days once a day for delayed/revised data. Older complete days are immutable.
    const recent = addDays(end, -2);
    const definitions = [
      ["weather", WEATHER, "https://historical-forecast-api.open-meteo.com/v1/forecast"],
      ["marine", MARINE, "https://marine-api.open-meteo.com/v1/marine"],
    ];
    for (const [name, fields, endpoint] of definitions) {
      const stream = cache.streams[name] ||= { initialized: false, days: {} };
      const missing = wanted.filter(d => !complete(stream.days[d], d, fields));
      const due = wanted.filter(d => {
        const entry = stream.days[d];
        if (entry?.nextCheckAt > now()) return false;
        return !complete(entry, d, fields) || (d >= recent && now() - (entry?.fetchedAt || 0) >= DAY);
      });
      // First run uses the SAME range/2 endpoints as the old collector, avoiding a partial training set.
      // Once populated, bound gap repair to two 14-day ranges per endpoint per run, newest first.
      const ranges = !stream.initialized && !(stream.notBefore > now()) ? [[start, end]]
        : rangesFor(due).reverse().slice(0, 2);
      if (stream.notBefore > now()) {
        if (missing.length || due.length) errors.push(`${name}: retry deferred until ${new Date(stream.notBefore).toISOString()}`);
        continue;
      }
      for (const [a, b] of ranges) {
        const url = new URL(endpoint);
        const params = { latitude: point.lat, longitude: point.lon, hourly: Object.keys(fields).join(","),
          timezone: "Asia/Seoul", start_date: a, end_date: b,
          ...(name === "weather" ? { wind_speed_unit: "ms" } : { cell_selection: "sea" }) };
        url.search = new URLSearchParams(params).toString();
        requestedRanges.push({ stream: name, start: a, end: b });
        try {
          const rows = parseHourly(await get(url.href), fields, a, b);
          let incomplete = 0;
          for (const day of dates(a, b)) {
            const entry = stream.days[day] ||= { hours: {} };
            const received = complete({ hours: rows }, day, fields);
            for (const [t, row] of Object.entries(rows)) {
              if (t.slice(0, 10) !== day) continue;
              // Null/partial responses cannot erase a previously valid value.
              const old = entry.hours[t] || {};
              entry.hours[t] = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? old[k] ?? null]));
            }
            if (received) entry.fetchedAt = now();
            else incomplete++;
            entry.nextCheckAt = now() + (received ? DAY : 6 * HOUR);
          }
          if (incomplete) errors.push(`${name}: ${incomplete} incomplete days in ${a}..${b}; kept cached values`);
          stream.initialized = true;
          stream.notBefore = 0;
          save(); // Persist each successful endpoint before attempting the other.
        } catch (e) {
          errors.push(`${name}: ${e.message}`);
          stream.notBefore = now() + HOUR;
          save();
          break;
        }
      }
    }
    const hourly = {};
    for (const d of wanted) for (const [t, row] of Object.entries(cache.streams.weather?.days[d]?.hours || {})) {
      const m = cache.streams.marine?.days[d]?.hours?.[t];
      hourly[t] = { ...row, wave: m?.wave ?? null, sst: m?.sst ?? null };
    }
    const missingDays = Object.fromEntries(definitions.map(([name, fields]) =>
      [name, wanted.filter(d => !complete(cache.streams[name]?.days[d], d, fields)).length]));
    return { hourly, status: { ok: !errors.length && !Object.values(missingDays).some(Boolean),
      missingDays, errors, requestedRanges, cachedHours: Object.keys(hourly).length } };
  }
  return { get, history, stats };
}
