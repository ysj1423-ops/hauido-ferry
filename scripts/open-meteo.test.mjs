import test from "node:test";
import assert from "node:assert/strict";
import { createOpenMeteo, retryAfterMs } from "./open-meteo.mjs";

const DAY = 86400000, T0 = Date.parse("2026-11-10T00:00:00Z");
const endpoint = "https://api.open-meteo.com/v1/forecast";
const add = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * DAY).toISOString().slice(0, 10);
function payload(url) {
  const u = new URL(url), marine = u.hostname.startsWith("marine");
  const h = { time: [] };
  const fields = marine ? ["wave_height", "sea_surface_temperature"]
    : ["wind_speed_10m", "wind_gusts_10m", "visibility", "temperature_2m", "dew_point_2m", "relative_humidity_2m", "cloud_cover_low"];
  fields.forEach(k => h[k] = []);
  const start = u.searchParams.get("start_date") || "2026-11-10";
  const end = u.searchParams.get("end_date") || start;
  for (let d = start; d <= end; d = add(d, 1)) for (let hour = 0; hour < 24; hour++) {
    h.time.push(`${d}T${String(hour).padStart(2, "0")}:00`);
    fields.forEach((k, j) => h[k].push(j + 1 + hour / 100));
  }
  return { hourly: h };
}
const response = (status, body = {}, retryAfter) => ({ ok: status >= 200 && status < 300, status,
  headers: new Headers(retryAfter ? { "retry-after": retryAfter } : {}), json: async () => body });
function harness() {
  const files = {}, calls = [], sleeps = [];
  let clock = T0, behavior = url => response(200, payload(url));
  const make = (point = { lat: 34.7, lon: 126.2 }) => createOpenMeteo({ point,
    readJSON: (f, fallback) => structuredClone(files[f] ?? fallback),
    writeJSON: (f, value) => files[f] = structuredClone(value), now: () => clock,
    random: () => 0, sleep: async ms => sleeps.push(ms),
    fetchImpl: async url => { calls.push(url); return behavior(url); } });
  return { files, calls, sleeps, make, advance: ms => clock += ms, behave: fn => behavior = fn };
}
test("cold fill, persistent cache hit, next-day increment and recent refresh", async () => {
  const h = harness();
  const first = await h.make().history("2026-11-01", "2026-11-09");
  assert.equal(first.status.ok, true);
  assert.equal(h.calls.length, 2);
  assert.equal(first.status.cachedHours, 216);
  const second = await h.make().history("2026-11-01", "2026-11-09");
  assert.deepEqual(second.hourly, first.hourly);
  assert.equal(h.calls.length, 2);
  h.advance(DAY);
  await h.make().history("2026-11-01", "2026-11-10");
  assert.equal(h.calls.length, 4);
  for (const url of h.calls.slice(2)) {
    const u = new URL(url);
    assert.equal(u.searchParams.get("start_date"), "2026-11-08");
    assert.equal(u.searchParams.get("end_date"), "2026-11-10");
  }
});
test("new date alone is fetched when older dates are not due", async () => {
  const h = harness();
  await h.make().history("2026-11-01", "2026-11-08");
  h.advance(30 * 60000);
  await h.make().history("2026-11-01", "2026-11-09");
  for (const url of h.calls.slice(2)) assert.equal(new URL(url).searchParams.get("start_date"), "2026-11-09");
});
test("older backfill is detected and range repairs are limited to 14 days/two ranges", async () => {
  const h = harness();
  await h.make().history("2026-11-01", "2026-11-09");
  const r = await h.make().history("2026-09-01", "2026-11-09");
  assert.equal(h.calls.length, 6);
  for (const range of r.status.requestedRanges)
    assert.ok((Date.parse(range.end) - Date.parse(range.start)) / DAY + 1 <= 14);
  assert.ok(r.status.missingDays.weather > 0);
  assert.ok(r.hourly["2026-11-09T00:00"]);
});
test("changed point invalidates cache", async () => {
  const h = harness();
  await h.make().history("2026-11-01", "2026-11-09");
  await h.make({ lat: 34.8, lon: 126.2 }).history("2026-11-01", "2026-11-09");
  assert.equal(h.calls.length, 4);
});
test("weather success survives marine failure and is not downloaded again", async () => {
  const h = harness();
  h.behave(url => url.includes("marine-api") ? response(400) : response(200, payload(url)));
  const first = await h.make().history("2026-11-01", "2026-11-09");
  assert.equal(first.status.ok, false);
  assert.equal(first.status.missingDays.marine, 9);
  assert.equal(h.calls.length, 2); // 400 is never retried.
  const second = await h.make().history("2026-11-01", "2026-11-09");
  assert.equal(h.calls.length, 2); // Persistent failure cooldown.
  assert.deepEqual(second.hourly, first.hourly);
  h.advance(3600000);
  h.behave(url => response(200, payload(url)));
  assert.equal((await h.make().history("2026-11-01", "2026-11-09")).status.ok, true);
  assert.equal(h.calls.length, 3);
});
test("refresh outage keeps all cached training hours and marks failure", async () => {
  const h = harness();
  const old = await h.make().history("2026-11-01", "2026-11-09");
  h.advance(DAY);
  h.behave(() => response(503));
  const r = await h.make().history("2026-11-01", "2026-11-09");
  assert.deepEqual(r.hourly, old.hourly);
  assert.equal(r.status.ok, false);
  assert.equal(h.calls.length, 8);
  assert.deepEqual(h.sleeps, [1000, 2000, 1000, 2000]);
});
test("429 honors Retry-After and persists host cooldown across jobs", async () => {
  const h = harness();
  h.behave(() => response(429, { reason: "Daily API request limit exceeded" }, "7200"));
  const om = h.make();
  await assert.rejects(om.get(endpoint), /Daily API request limit exceeded/);
  assert.equal(om.stats.events[0].reason, "Daily API request limit exceeded");
  await assert.rejects(h.make().get(endpoint), /cooldown/);
  h.advance(3600000);
  await assert.rejects(h.make().get(endpoint), /cooldown/);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
  h.advance(3600000);
  h.behave(() => response(200));
  await h.make().get(endpoint);
  assert.equal(h.calls.length, 2);
});
test("HTTP-date Retry-After, short 503 hint, long hint deferral", async () => {
  assert.equal(retryAfterMs("Tue, 10 Nov 2026 02:00:00 GMT", T0), 7200000);
  assert.equal(retryAfterMs("garbage", T0), 0);
  const h = harness(); let n = 0;
  h.behave(() => ++n === 1 ? response(503, {}, "5") : response(200));
  await h.make().get(endpoint);
  assert.deepEqual(h.sleeps, [5000]);
  h.behave(() => response(503, {}, "120"));
  await assert.rejects(h.make().get(endpoint), /deferred/);
  await assert.rejects(h.make().get(endpoint), /cooldown/);
  assert.equal(h.calls.length, 3);
});
test("network errors/timeouts retry at most 3 times, then stop across jobs", async () => {
  const h = harness();
  h.behave(() => { throw new Error("TimeoutError"); });
  await assert.rejects(h.make().get(endpoint), /TimeoutError/);
  await assert.rejects(h.make().get(endpoint), /cooldown/);
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.sleeps, [1000, 2000]);
});
test("short outage can recover on the second attempt", async () => {
  const h = harness(); let n = 0;
  h.behave(() => ++n < 2 ? response(502) : response(200, { recovered: true }));
  assert.deepEqual(await h.make().get(endpoint), { recovered: true });
  assert.equal(h.calls.length, 2);
});
test("API error objects and malformed JSON", async () => {
  const h = harness();
  h.behave(() => response(200, { error: true, reason: "invalid model" }));
  await assert.rejects(h.make().get(endpoint), /invalid model/);
  assert.equal(h.calls.length, 1);
  h.behave(() => ({ ...response(200), json: async () => { throw new SyntaxError("invalid JSON"); } }));
  await assert.rejects(h.make().get(endpoint), /invalid JSON/);
  assert.equal(h.calls.length, 4);
});
test("short or all-null days are not complete and retry after 6 hours", async () => {
  for (const mode of ["short", "null"]) {
    const h = harness();
    h.behave(url => {
      const body = payload(url);
      if (mode === "short") for (const arr of Object.values(body.hourly)) arr.pop();
      else for (const [k, arr] of Object.entries(body.hourly)) if (k !== "time") arr.fill(null);
      return response(200, body);
    });
    assert.equal((await h.make().history("2026-11-09", "2026-11-09")).status.ok, false);
    await h.make().history("2026-11-09", "2026-11-09");
    assert.equal(h.calls.length, 2);
    h.advance(6 * 3600000);
    h.behave(url => response(200, payload(url)));
    assert.equal((await h.make().history("2026-11-09", "2026-11-09")).status.ok, true);
    assert.equal(h.calls.length, 4);
  }
});
test("malformed arrays cannot replace good cached data", async () => {
  const h = harness();
  const old = await h.make().history("2026-11-09", "2026-11-09");
  h.advance(DAY);
  h.behave(url => { const body = payload(url); Object.values(body.hourly)[1].pop(); return response(200, body); });
  const r = await h.make().history("2026-11-09", "2026-11-09");
  assert.equal(r.status.ok, false);
  assert.deepEqual(r.hourly, old.hourly);
});
test("null refresh cannot erase already valid values", async () => {
  const h = harness();
  const old = await h.make().history("2026-11-09", "2026-11-09");
  h.advance(DAY);
  h.behave(url => {
    const body = payload(url);
    for (const [k, arr] of Object.entries(body.hourly)) if (k !== "time") arr.fill(null);
    return response(200, body);
  });
  const refreshed = await h.make().history("2026-11-09", "2026-11-09");
  assert.deepEqual(refreshed.hourly, old.hourly);
  assert.equal(refreshed.status.ok, false);
});
test("forecast remains uncached: every normal run sends current requests", async () => {
  const h = harness();
  for (let run = 0; run < 2; run++) {
    const om = h.make();
    await om.get(endpoint);
    await om.get("https://marine-api.open-meteo.com/v1/marine");
  }
  assert.equal(h.calls.length, 4);
});
test("shared marine host cooldown prevents history requests after forecast 429", async () => {
  const h = harness();
  h.behave(url => url.includes("marine-api") ? response(429) : response(200, payload(url)));
  const om = h.make();
  await assert.rejects(om.get("https://marine-api.open-meteo.com/v1/marine"), /429/);
  const r = await om.history("2026-11-09", "2026-11-09");
  assert.equal(r.status.ok, false);
  assert.equal(h.calls.length, 2); // One marine forecast, one historical weather; no repeated marine request.
});
