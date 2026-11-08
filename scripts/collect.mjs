// 하의도 배편 자료 수집 + 예측 (GitHub Actions에서 30분마다 실행)
// 실행: node scripts/collect.mjs  (선택: NTFY_TOPIC=주제 → 공식 발표 변화 알림)
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "docs", "data");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const NTFY = (process.env.NTFY_TOPIC || "").trim();
const KEY = (process.env.DATA_GO_KR_KEY || "").trim();
fs.mkdirSync(DATA, { recursive: true });

const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFileSync(path.join(DATA, f), JSON.stringify(v, null, f === "latest.json" ? 0 : 0));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sources = [];
const log = (...a) => console.log(...a);

// ---------- 시간(KST) ----------
const nowKst = () => new Date(Date.now() + 9 * 3600e3);
const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => ymd(new Date(Date.parse(s + "T00:00:00Z") + n * 86400e3));
const TODAY = ymd(nowKst());
const compact = s => s.replaceAll("-", "");

async function get(url, { tries = 4, json = true } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const t = await r.text();
      return json ? JSON.parse(t) : t;
    } catch (e) { last = e; await sleep(1500 * (i + 1)); }
  }
  throw last;
}
async function source(key, name, fn) {
  const t0 = Date.now();
  try { const v = await fn(); sources.push({ key, name, ok: true, ms: Date.now() - t0 }); return v; }
  catch (e) { sources.push({ key, name, ok: false, error: String(e.message || e).slice(0, 200) }); log("FAIL", key, e.message); return null; }
}

// ---------- 1. KOMSA 공식 운항 정보 (한국해양교통안전공단 홈페이지, 목포운항관리센터 F) ----------
// - 확정 운항실적(날짜별): 정상/통제/비운 + 사유  → 학습 정답
// - 당일 운항현황: 정상/통제/비운 + 출항여부(출항전/운항중/완료)
// - 다음 날 운항예보(매일 17시경): 운항/결항/검토/대기·지연/비운항 + 사유
const ROUTES = CFG.routes; // 면허항로명
const vid = name => (CFG.vessels.find(v => v.name === name)?.id) || name;
function classify(s = "") {
  s = s.replace(/\s/g, "");
  if (/통제|결항/.test(s)) return "cancelled";
  if (/비운/.test(s)) return "nonoperating";
  if (/검토|대기|지연/.test(s)) return "pending";
  if (/정상|운항|증선|증회/.test(s)) return "operated";
  return "unknown";
}
const fmtTime = t => { t = String(t || "").replace(/[^0-9]/g, "").padStart(4, "0"); return t.slice(0, 2) + ":" + t.slice(2, 4); };
const cellsOf = html => [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m =>
  [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(c => c[1].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim())).filter(c => c.length >= 6);
async function komsaPage(url) { await sleep(800); return get(url, { json: false, tries: 3 }); }

async function komsaConfirmed(date) {
  const h = await komsaPage(`https://komsa.or.kr/prog/crtfctSailing/kor/sub03_0206/list.do?searchJbcd=F&searchIlja=${date}`);
  if (!/crtfctNaviTable/.test(h)) throw new Error("확정 운항실적 표 없음");
  // [출항시간, 항로명, 여객선명, 출항지, 편도/왕복, 운항구분, 사유, ...]
  return cellsOf(h).filter(c => ROUTES.includes(c[1])).map(c => ({
    date, time: fmtTime(c[0]), route: c[1], vessel: c[2], vesselId: vid(c[2]), port: c[3], trip: c[4], status: c[5], reason: c[6] || "", outcome: classify(c[5]) }));
}
async function komsaToday() {
  const h = await komsaPage("https://komsa.or.kr/prog/pssgCurState/kor/sub03_0202/list.do?jbcd=F");
  // [출항시각, 여객선명, 운항항로명, 운항방향, 출항지, 항로구분, 운항구분, 사유, 출항여부, 면허항로]
  const rows = cellsOf(h).filter(c => c.length >= 10 && ROUTES.includes(c[9]));
  const m = /기준시간\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(h.replace(/<[^>]+>/g, " "));
  const date = m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : TODAY;
  return { date, rows: rows.map(c => ({ date, time: fmtTime(c[0]), vessel: c[1], vesselId: vid(c[1]), detail: c[2], direction: c[3], port: c[4], trip: c[5], route: c[9],
    status: c[6], reason: c[7] || "", progress: c[8] || "", outcome: classify(c[6]) })) };
}
async function komsaTomorrow() {
  const h = await komsaPage("https://komsa.or.kr/prog/tmmrwSailing/kor/sub03_0207/list.do?searchJbcd=F");
  const t = h.replace(/<[^>]+>/g, " ");
  const m = /적용일\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(t);
  if (!m) return { date: null, updated: null, rows: [] }; // 발표 전
  const date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  const up = /최종 업데이트 시간\s*:\s*([0-9:]+)/.exec(t)?.[1] || null;
  // [출항시간, 출항지명, 항로명, 여객선명, 운항구분, 사유] — 같은 표가 화면에 두 번 나와 중복 제거
  const seen = new Set(), rows = [];
  for (const c of cellsOf(h)) {
    if (!ROUTES.includes(c[2])) continue;
    const k = c[0] + c[3]; if (seen.has(k)) continue; seen.add(k);
    rows.push({ date, time: fmtTime(c[0]), port: c[1], route: c[2], vessel: c[3], vesselId: vid(c[3]), status: c[4], reason: c[5] || "", outcome: classify(c[4]) });
  }
  return { date, updated: up, rows };
}

// ---------- 1-2. 왕복 배의 섬 출발 시각 (공공데이터포털 운항상태 API: 실제 움직임 기록) ----------
const RT = CFG.roundTrip;
const toMin = t => +t.slice(0, 2) * 60 + +t.slice(3, 5);
const toHM = m => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
// 하루치 운항 기록을 배편(출항시각)별 사건 목록으로: [{st, port, at}]
async function apiEvents(date, vessel) {
  const q = new URLSearchParams({ pageNo: "1", numOfRows: "1000", dataType: "JSON", rlvtYmd: compact(date), psnshpNm: vessel });
  const keyPart = KEY.includes("%") ? "serviceKey=" + KEY : "serviceKey=" + encodeURIComponent(KEY);
  const j = await get(`https://apis.data.go.kr/B554035/ferry-route-info-v4/get-ferry-route-info-v4?${keyPart}&${q}`);
  const r = j.response || j; let it = r.body?.items?.item ?? r.body?.items ?? []; if (!Array.isArray(it)) it = it ? [it] : [];
  const trips = {};
  for (const x of it) {
    if (!x.nvg_stts_chg_dt) continue;
    const via = fmtTime(x.sail_tm);
    (trips[via] ||= { dir: x.nvg_drc_nm || "", events: [] }).events.push({ st: x.nvg_stts_nm, port: x.portcl_nm || "", at: x.nvg_stts_chg_dt.slice(11, 16), ts: x.nvg_stts_chg_dt });
  }
  for (const t of Object.values(trips)) t.events.sort((a, b) => a.ts.localeCompare(b.ts));
  return trips;
}
// 배편 기록 → 들른 항구 순서와 각 항구 도착·출항 시각
function stopsOf(trip) {
  const stops = [];
  for (const e of trip.events) {
    if (!e.port) continue;
    let s = stops.at(-1);
    if (!s || s.port !== e.port) { s = { port: e.port, arr: null, dep: null }; stops.push(s); }
    if (/입항|도착|완료/.test(e.st) && !s.arr) s.arr = e.at;
    if (/출항/.test(e.st) && !s.dep) s.dep = e.at;
  }
  return stops;
}
const median = a => { if (!a.length) return null; a = [...a].sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; };
async function movementInfo(prevRt) {
  const vessels = [...new Set([...CFG.vessels.map(v => v.name), ...RT.vessels])];
  if (!KEY) return { offsets: prevRt?.offsets || RT.defaultOffsetMin, basis: prevRt?.basis || "기본값", patterns: prevRt?.patterns || {}, today: {}, live: {} };
  let { offsets, basis, patterns } = prevRt || {};
  if (!prevRt || prevRt.computedOn !== TODAY || !patterns) {
    const samples = {}, pat = {};
    for (let i = 1; i <= 7; i++) for (const v of vessels) {
      const trips = await apiEvents(addDays(TODAY, -i), v);
      for (const [via, t] of Object.entries(trips)) {
        const stops = stopsOf(t);
        const key = `${v}|${via}`;
        (pat[key] ||= { dir: t.dir, runs: [] }).runs.push(stops);
        if (RT.vessels.includes(v)) for (const s of stops) if (s.dep && s.port !== "목포") { const d = toMin(s.dep) - toMin(via); if (d > 0 && d < 240) (samples[s.port] ||= []).push(d); }
      }
      await sleep(150);
    }
    offsets = { ...RT.defaultOffsetMin };
    for (const [port, a] of Object.entries(samples)) if (a.length >= 3) offsets[port] = median(a);
    basis = `최근 7일 실제 운항기록 중앙값 (${Object.entries(samples).map(([p, a]) => p + " " + a.length + "회").join(", ") || "기록 없음"})`;
    // 평소 들르는 항구 순서(가장 많이 나온 순서)와 출항시각 대비 도착까지 걸리는 시간(중앙값)
    patterns = {};
    for (const [key, { dir, runs }] of Object.entries(pat)) {
      const seqCount = {};
      for (const r of runs) { const k = r.map(s => s.port).join(">"); seqCount[k] = (seqCount[k] || 0) + 1; }
      const best = Object.entries(seqCount).sort((a, b) => b[1] - a[1])[0][0].split(">");
      const via = key.split("|")[1];
      patterns[key] = { dir, stops: best.map(port => {
        const arr = [], dep = [];
        for (const r of runs) { const s = r.find(x => x.port === port); if (!s) continue;
          if (s.arr) arr.push((toMin(s.arr) - toMin(via) + 1440) % 1440); if (s.dep) dep.push((toMin(s.dep) - toMin(via) + 1440) % 1440); }
        return { port, arr: median(arr), dep: median(dep) };
      }) };
    }
  }
  // 오늘: 섬 출항 실제 시각(순환편용) + 배편별 현재 위치
  const today = {}, live = {};
  for (const v of vessels) {
    const trips = await apiEvents(TODAY, v);
    for (const [via, t] of Object.entries(trips)) {
      const stops = stopsOf(t);
      for (const s of stops) if (s.dep) today[`${v}|${via}|${s.port}`] = s.dep;
      live[`${v}|${via}`] = position(t, stops, patterns[`${v}|${via}`], via);
    }
    await sleep(150);
  }
  return { offsets, basis, patterns, computedOn: TODAY, today, live };
}
// 현재 위치 문장 + 항구별 진행 상황(지난 곳은 실제 시각, 남은 곳은 예상 시각)
function position(trip, stops, pat, via) {
  const last = trip.events.at(-1);
  const order = pat?.stops?.length ? pat.stops : stops.map(s => ({ port: s.port }));
  // 지연: 마지막 실제 기록과 평소 시각의 차이
  let delay = 0;
  if (pat) for (const s of stops) { const p = pat.stops.find(x => x.port === s.port); const a = s.dep || s.arr; const pm = s.dep ? p?.dep : p?.arr;
    if (p && a && pm != null) delay = (toMin(a) - toMin(via) + 1440) % 1440 - pm; }
  const seen = new Set(stops.map(s => s.port));
  const done = last && /완료/.test(last.st);
  const chain = order.map(o => {
    const s = stops.find(x => x.port === o.port);
    if (s) return { port: o.port, at: s.dep || s.arr, passed: !!s.dep || (done && s.port === last.port), here: !s.dep && !(done && s.port === last.port) };
    const eta = o.arr != null ? toHM((toMin(via) + o.arr + Math.max(0, delay) + 1440) % 1440) : null;
    return { port: o.port, eta, passed: false, here: false };
  });
  for (const s of stops) if (!order.find(o => o.port === s.port)) chain.push({ port: s.port, at: s.dep || s.arr, passed: !!s.dep, here: !s.dep });
  const next = chain.find(c => !seen.has(c.port));
  let text;
  if (!last) text = "출항 전";
  else if (done) text = `${last.port} 도착 완료`;
  else if (/기항지도착/.test(last.st)) text = `${last.port}에 정박 중`;
  else if (/입항/.test(last.st)) text = `${last.port} 들어가는 중`;
  else if (/미수신/.test(last.st)) text = `위치 신호 없음 (마지막: ${stops.at(-1)?.port || "-"})`;
  else text = `${stops.at(-1)?.port || "출발지"} → ${next?.port || "다음 항구"} 가는 중`;
  return { text, at: last?.at || null, state: !last ? "before" : done ? "done" : "moving", delay: Math.round(delay), chain };
}
// 목포 출발 왕복편 → 섬 출발편 추가 (공식 상태는 원래 배편을 따름)
function expandRoundTrips(list, date, rt, isToday) {
  const rtVessels = new Set(RT.vessels);
  const extra = [];
  for (const s of list) {
    const stops = RT.routes[s.route];
    if (!stops || s.port !== "목포" || !rtVessels.has(s.vessel)) continue;
    if (s.trip && !/왕복|순환/.test(s.trip)) continue;
    if (s.official?.outcome === "nonoperating") continue;
    for (const port of stops) {
      const actual = isToday ? rt.today[`${s.vessel}|${s.time}|${port}`] : null;
      const off = rt.offsets[port] ?? RT.defaultOffsetMin[port];
      extra.push({ ...s, port, time: actual || toHM(toMin(s.time) + off), approx: !actual, via: s.time,
        official: s.official ? { ...s.official, progress: actual ? `${actual} 출항` : (s.official.progress === "완료" ? "완료" : ""), kind: s.official.kind } : null });
    }
  }
  return [...list, ...extra].sort((a, b) => a.time.localeCompare(b.time));
}

// ---------- 2. 기상청 해상예보 (단기, 전남중부서해앞바다) ----------
function parseKma(data) {
  return (data || []).map(d => {
    const m = /(\d{4})\.(\d{2})\.(\d{2})\s*(오전|오후|종일)?/.exec(d.annc_nm || "");
    return m ? { date: `${m[1]}-${m[2]}-${m[3]}`, part: m[4] || "종일", windMin: d.ws_min_val, windMax: d.ws_max_val,
      waveMin: d.wh_min_val, waveMax: d.wh_max_val, sky: d.sky_sts_nm, dir: [d.wd_01_cmps_rose, d.wd_02_cmps_rose].filter(Boolean).join("→") } : null;
  }).filter(Boolean);
}
async function kmaIssue(annc) {
  const j = await get(`https://marine.kma.go.kr/mmis_marine_api/v1/kma/fct/sea/sterm/detail?annc_time=${annc}&zone_id=${CFG.kmaZone.id}`);
  return parseKma(j.data);
}
async function kmaLatest() {
  // 최근 발표 3회분을 합쳐 씀(최신 발표 우선). 당일 오전 구간은 이전 발표에만 있기 때문.
  const k = nowKst(); const today = ymd(k);
  const cands = [];
  for (let d = 0; d < 2; d++) for (const h of ["1700", "1100", "0500"]) cands.push(compact(addDays(today, -d)) + h);
  const got = [];
  for (const a of cands) {
    const hh = +a.slice(8, 10), day = `${a.slice(0, 4)}-${a.slice(4, 6)}-${a.slice(6, 8)}`;
    if (day === today && hh > k.getUTCHours()) continue;
    const p = await kmaIssue(a);
    if (p.length) got.push({ annc: a, periods: p });
    if (got.length >= 3) break;
  }
  if (!got.length) throw new Error("최근 해상예보 없음");
  const merged = new Map();
  for (const g of got) for (const p of g.periods) { const key = p.date + p.part; if (!merged.has(key)) merged.set(key, { ...p, annc: g.annc }); }
  return { annc: got[0].annc, periods: [...merged.values()] };
}
const kmaFor = (periods, date, hour) => {
  const part = hour < 12 ? "오전" : "오후";
  return periods.find(p => p.date === date && p.part === part) || periods.find(p => p.date === date && p.part === "종일") || null;
};

// ---------- 3. Open-Meteo (모델 예보, 과거 예보 아카이브) ----------
const P = CFG.point;
async function omForecast() {
  const models = ["best_match", "ecmwf_ifs025", "kma_seamless", "gfs_seamless"];
  const w = await get(`https://api.open-meteo.com/v1/forecast?latitude=${P.lat}&longitude=${P.lon}&hourly=wind_speed_10m,wind_gusts_10m,visibility,temperature_2m,dew_point_2m,relative_humidity_2m,cloud_cover_low&models=${models.join(",")}&wind_speed_unit=ms&timezone=Asia%2FSeoul&forecast_days=8`);
  const m = await get(`https://marine-api.open-meteo.com/v1/marine?latitude=${P.lat}&longitude=${P.lon}&hourly=wave_height,sea_surface_temperature&timezone=Asia%2FSeoul&forecast_days=8&cell_selection=sea`);
  const idx = new Map(m.hourly.time.map((t, i) => [t, m.hourly.wave_height[i]]));
  const sst = new Map(m.hourly.time.map((t, i) => [t, m.hourly.sea_surface_temperature?.[i]]));
  const B = k => w.hourly[`${k}_best_match`] ?? w.hourly[k];
  const out = {};
  for (const mod of models) {
    const sfx = k => w.hourly[`${k}_${mod}`] ?? (mod === "best_match" ? w.hourly[k] : null);
    const ws = sfx("wind_speed_10m"); if (!ws) continue;
    const gs = sfx("wind_gusts_10m"), vs = sfx("visibility");
    const best_vs = w.hourly.visibility_best_match || w.hourly.visibility;
    out[mod] = {};
    const fogVal = (k, i) => sfx(k)?.[i] ?? B(k)?.[i];
    w.hourly.time.forEach((t, i) => { out[mod][t] = { wind: ws[i], gust: gs?.[i], vis: (vs?.[i] ?? best_vs?.[i]), wave: idx.get(t),
      temp: fogVal("temperature_2m", i), dew: fogVal("dew_point_2m", i), rh: fogVal("relative_humidity_2m", i), cloudLow: fogVal("cloud_cover_low", i), sst: sst.get(t) }; });
  }
  return out;
}
async function omHistory(start, end) {
  const w = await get(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${P.lat}&longitude=${P.lon}&hourly=wind_speed_10m,wind_gusts_10m,visibility,temperature_2m,dew_point_2m,relative_humidity_2m,cloud_cover_low&wind_speed_unit=ms&timezone=Asia%2FSeoul&start_date=${start}&end_date=${end}`);
  const m = await get(`https://marine-api.open-meteo.com/v1/marine?latitude=${P.lat}&longitude=${P.lon}&hourly=wave_height,sea_surface_temperature&timezone=Asia%2FSeoul&start_date=${start}&end_date=${end}&cell_selection=sea`);
  const idx = new Map(m.hourly.time.map((t, i) => [t, m.hourly.wave_height[i]]));
  const sst = new Map(m.hourly.time.map((t, i) => [t, m.hourly.sea_surface_temperature?.[i]]));
  const out = {}, H = w.hourly;
  H.time.forEach((t, i) => { out[t] = { wind: H.wind_speed_10m[i], gust: H.wind_gusts_10m[i], vis: H.visibility[i], wave: idx.get(t),
    temp: H.temperature_2m[i], dew: H.dew_point_2m[i], rh: H.relative_humidity_2m[i], cloudLow: H.cloud_cover_low[i], sst: sst.get(t) }; });
  return out;
}
// 출항 1시간 전 ~ 2시간 후 구간의 가장 나쁜 값
function omFeat(hourly, date, time) {
  if (!hourly) return null;
  const at = h => { const d = h < 0 ? addDays(date, -1) : h > 23 ? addDays(date, 1) : date; const hh = ((h % 24) + 24) % 24; return hourly[`${d}T${String(hh).padStart(2, "0")}:00`]; };
  const h0 = +time.slice(0, 2); let wind = null, gust = null, wave = null, vis = null;
  for (let h = h0 - 1; h <= h0 + 2; h++) {
    const x = at(h); if (!x) continue;
    if (x.wind != null) wind = Math.max(wind ?? -1, x.wind);
    if (x.gust != null) gust = Math.max(gust ?? -1, x.gust);
    if (x.wave != null) wave = Math.max(wave ?? -1, x.wave);
    if (x.vis != null) vis = Math.min(vis ?? 1e9, x.vis);
  }
  if (wind == null) return null;
  // 안개 요인: 출항 3시간 전 ~ 2시간 후
  let dewDep = null, rh = null, airSea = null, cl = [], wl = [];
  for (let h = h0 - 3; h <= h0 + 2; h++) {
    const x = at(h); if (!x) continue;
    if (x.temp != null && x.dew != null) dewDep = Math.min(dewDep ?? 99, x.temp - x.dew);
    if (x.rh != null) rh = Math.max(rh ?? 0, x.rh);
    if (x.temp != null && x.sst != null) airSea = Math.max(airSea ?? -99, x.temp - x.sst);
    if (x.cloudLow != null) cl.push(x.cloudLow);
    if (x.wind != null) wl.push(x.wind);
  }
  const avg = a => a.length ? a.reduce((p, c) => p + c, 0) / a.length : null;
  const doy = (Date.parse(date + "T00:00:00Z") - Date.parse(date.slice(0, 4) + "-01-01T00:00:00Z")) / 864e5;
  return { wind, gust, wave, vis, dewDep, rh, airSea, cloudLow: avg(cl), windMean: avg(wl),
    season: Math.cos(2 * Math.PI * (doy - 191) / 365), morning: h0 < 9 ? 1 : 0 };
}

// ---------- 4. 모델: 로지스틱 회귀 (배별 절편 + 공통 기울기) ----------
const visLog = v => v == null ? null : Math.log10(Math.max(v, 50) / 1000);
const FEATS = {
  full: ["wind", "gust", "wave", "visLog", "kmaWind", "kmaWave", "windEx", "gustEx", "kmaRough"],
  om: ["wind", "gust", "wave", "visLog", "windEx", "gustEx"],
  fog: ["visLog", "dewDep", "rh", "airSea", "cloudLow", "windMean", "season", "morning"],
};
// 문턱 효과: 일정 세기를 넘는 만큼만 커지는 값, 기상청 예보가 주의보 수준인지
const addEx = r => Object.assign(r, { windEx: r.wind == null ? null : Math.max(0, r.wind - 9), gustEx: r.gust == null ? null : Math.max(0, r.gust - 13),
  kmaRough: r.kmaWind == null ? null : ((r.kmaWind >= 13 || (r.kmaWave ?? 0) >= 2.5) ? 1 : 0) });
const isFog = r => /시계|안개|시정/.test(r.reason || "");
function fogRule(r) { // 안개 학습 자료가 부족할 때만
  if (r.vis != null && r.vis < 1000) return 0.5;
  if (r.dewDep != null && r.dewDep < 1 && (r.windMean ?? 9) < 5) return 0.15;
  return 0.02;
}
const FEAT_KO = { windEx: "강풍 초과분", gustEx: "돌풍 초과분", kmaRough: "기상청 주의보 수준", dewDep: "이슬점 차", rh: "습도", airSea: "기온-수온 차", cloudLow: "낮은 구름", windMean: "평균 풍속", season: "계절(여름)", morning: "아침 시간", wind: "모델 풍속", gust: "모델 돌풍", wave: "모델 파고", visLog: "시정", kmaWind: "기상청 풍속", kmaWave: "기상청 파고" };
function featVec(r, names, stats, vessels) {
  const x = names.map((n, i) => r[n] == null ? 0 : (r[n] - stats.mean[i]) / stats.sd[i]);
  for (const v of vessels) x.push(r.vesselId === v ? 1 : 0);
  return x;
}
function fitLogit(rows, names) {
  const vessels = [...new Set(rows.map(r => r.vesselId))];
  const mean = names.map(n => { const v = rows.map(r => r[n]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0; });
  const sd = names.map((n, i) => { const v = rows.map(r => r[n]).filter(x => x != null); const s = Math.sqrt(v.reduce((a, b) => a + (b - mean[i]) ** 2, 0) / Math.max(1, v.length)); return s || 1; });
  const stats = { mean, sd };
  const X = rows.map(r => featVec(r, names, stats, vessels)), Y = rows.map(r => r.y);
  // 뉴턴법(IRLS) + 약한 L2 규제
  const d = X[0].length, n = X.length, lam = +(process.env.LAMBDA ?? 1);
  let w = new Array(d).fill(0);
  for (let it = 0; it < 30; it++) {
    const H = Array.from({ length: d }, () => new Array(d).fill(0)), g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) {
      const p = sig(dot(w, X[i])), q = Math.max(p * (1 - p), 1e-6), e = Y[i] - p, x = X[i];
      for (let a = 0; a < d; a++) { if (!x[a]) continue; g[a] += e * x[a]; const qa = q * x[a]; for (let b = 0; b < d; b++) if (x[b]) H[a][b] += qa * x[b]; }
    }
    for (let a = 0; a < d; a++) { H[a][a] += lam + 1e-6; g[a] -= lam * w[a]; }
    const step = solve(H, g); let mx = 0;
    for (let a = 0; a < d; a++) { w[a] += step[a]; mx = Math.max(mx, Math.abs(step[a])); }
    if (mx < 1e-6) break;
  }
  return { names, vessels, stats, w };
}
const sig = z => 1 / (1 + Math.exp(-z));
function solve(A, b) { // 가우스 소거
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const v = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / v; if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / (r[i] || 1e-12));
}
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
function predict(model, r) {
  if (!model) return null;
  if (!model.vessels.includes(r.vesselId)) return null;
  return sig(dot(model.w, featVec(r, model.names, model.stats, model.vessels)));
}
function ruleProb(r) { // 자료가 부족할 때만: 풍랑주의보 기준(14 m/s, 3 m) 근처
  const w = r.kmaWind ?? r.wind, h = r.kmaWave ?? r.wave;
  if (w == null && h == null) return null;
  if ((w ?? 0) >= 14 || (h ?? 0) >= 3) return 0.8;
  if ((w ?? 0) >= 11 || (h ?? 0) >= 2) return 0.35;
  return 0.05;
}
function evaluate(rows, pfn) {
  let n = 0, pos = 0, brier = 0, hit = 0, miss = 0, fa = 0, base = 0;
  for (const r of rows) { const p = pfn(r); if (p == null) continue; n++; pos += r.y; brier += (p - r.y) ** 2; if (p >= 0.5 && r.y) hit++; else if (p < 0.5 && r.y) miss++; else if (p >= 0.5 && !r.y) fa++; }
  return n ? { n, cancellations: pos, brier: +(brier / n).toFixed(4), hit, miss, falseAlarm: fa } : null;
}

// ---------- 메인 ----------
(async () => {
  const prev = readJSON("latest.json", null);
  const act = readJSON("actuals.json", { rows: {}, done: {} });
  const kmaArc = readJSON("kma-archive.json", {});

  // 1) KOMSA 공식: 당일 현황, 다음 날 예보, 확정 실적(최근 + 과거 채우기)
  if (act.schema !== 2) { act.rows = {}; act.done = {}; act.schema = 2; }
  const live = { today: null, tomorrow: null };
  live.today = await source("komsaToday", "KOMSA 당일 운항현황", komsaToday);
  live.tomorrow = await source("komsaTomorrow", "KOMSA 다음 날 운항예보", komsaTomorrow);
  const rt = (await source("roundTrip", "배 위치·섬 출발 시각(실제 운항기록)", () => movementInfo(prev?.roundTrip))) || { offsets: RT.defaultOffsetMin, basis: "기본값", today: {} };
  await source("komsaConfirmed", "KOMSA 확정 운항실적", async () => {
    const missing = [];
    for (let i = 3; i <= CFG.historyDays; i++) { const d = addDays(TODAY, -i); if (!act.done[d]) missing.push(d); }
    const backfill = process.env.BACKFILL === "0" ? 0 : CFG.backfillPerRun;
    for (const d of [addDays(TODAY, -1), addDays(TODAY, -2), ...missing.slice(0, backfill)]) {
      const rows = await komsaConfirmed(d);
      for (const k of Object.keys(act.rows)) if (k.startsWith(d + "|")) delete act.rows[k];
      for (const r of rows) act.rows[`${r.date}|${r.time}|${r.vessel}|${r.port}`] = r;
      if (d < addDays(TODAY, -2)) act.done[d] = rows.length;
    }
  });

  // 2) 기상청 해상예보: 최신 + 과거 발표분(학습용, 전날 17시 발표)
  const kmaNow = await source("kma", "기상청 단기 해상예보", kmaLatest);
  await source("kmaArchive", "기상청 해상예보 과거 발표분", async () => {
    const dates = [...new Set(Object.values(act.rows).map(r => r.date))].filter(d => d < TODAY).sort().reverse();
    let n = 0;
    for (const d of dates) {
      const a = compact(addDays(d, -1)) + "1700";
      if (kmaArc[a]) continue;
      kmaArc[a] = await kmaIssue(a); n++;
      if (n >= CFG.kmaBackfillPerRun) break;
      await sleep(200);
    }
  });

  // 3) 모델 예보
  const omNow = await source("om", "Open-Meteo 7일 예보(4개 모델)", omForecast);
  const actRows = Object.values(act.rows);
  const histDates = actRows.map(r => r.date).filter(d => d < TODAY).sort();
  let omHist = null;
  if (histDates.length) omHist = await source("omHist", "Open-Meteo 과거 예보 아카이브", () => omHistory(addDays(histDates[0], -1), addDays(TODAY, -1)));

  // 4) 학습 자료 만들기: 바람·파도 결항과 안개(시계제한) 결항을 따로 학습
  for (const r of actRows) if (r.status) r.outcome = classify(r.status);
  const all = [];
  for (const r of actRows) {
    if (r.date >= TODAY || !["cancelled", "operated"].includes(r.outcome)) continue;
    const f = omFeat(omHist, r.date, r.time); if (!f) continue;
    const k = kmaFor(kmaArc[compact(addDays(r.date, -1)) + "1700"] || [], r.date, +r.time.slice(0, 2));
    all.push({ date: r.date, time: r.time, vesselId: r.vesselId, port: r.port, reason: r.reason, cancelled: r.outcome === "cancelled",
      ...f, visLog: visLog(f.vis), kmaWind: k?.windMax ?? null, kmaWave: k?.waveMax ?? null });
    addEx(all.at(-1));
  }
  all.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  // 바람·파도 모델: 안개 결항은 빼고 학습
  const train = all.filter(r => !(r.cancelled && isFog(r))).map(r => ({ ...r, y: r.cancelled ? 1 : 0 }));
  // 안개 모델: 바람·파도 결항은 빼고 학습 (배와 무관하게 공통)
  const trainFog = all.filter(r => !(r.cancelled && !isFog(r))).map(r => ({ ...r, vesselId: "all", y: r.cancelled ? 1 : 0 }));
  const positives = train.filter(r => r.y).length, fogPositives = trainFog.filter(r => r.y).length;
  const enough = positives >= 8 && train.length >= 200;
  const enoughFog = fogPositives >= 10 && trainFog.length >= 300;

  // 시간순 검증: 앞 70% 날짜로 학습, 뒤 30%로 평가
  let validation = null, fogValidation = null, models = {};
  const ds = [...new Set(all.map(r => r.date))];
  const cut = ds[Math.floor(ds.length * 0.7)];
  if (enough) {
    const tr = train.filter(r => r.date < cut), te = train.filter(r => r.date >= cut);
    if (tr.filter(r => r.y).length >= 5 && te.length) {
      const mFull = fitLogit(tr, FEATS.full), mOm = fitLogit(tr, FEATS.om);
      const baseRate = tr.reduce((s, r) => s + r.y, 0) / tr.length;
      validation = {
        trainFrom: tr[0].date, trainTo: tr.at(-1).date, testFrom: te[0].date, testTo: te.at(-1).date,
        full: evaluate(te, r => predict(mFull, r)),
        omOnly: evaluate(te, r => predict(mOm, r)),
        kmaRule: evaluate(te.filter(r => r.kmaWind != null), ruleProb),
        baseRate: evaluate(te, () => baseRate),
      };
    }
    models.full = fitLogit(train, FEATS.full);
    models.om = fitLogit(train, FEATS.om);
  }
  if (enoughFog) {
    const tr = trainFog.filter(r => r.date < cut), te = trainFog.filter(r => r.date >= cut);
    if (tr.filter(r => r.y).length >= 5 && te.length) {
      const mFog = fitLogit(tr, FEATS.fog);
      const baseRate = tr.reduce((s, r) => s + r.y, 0) / tr.length;
      fogValidation = { trainFrom: tr[0].date, trainTo: tr.at(-1).date, testFrom: te[0].date, testTo: te.at(-1).date,
        model: evaluate(te, r => predict(mFog, r)), visRule: evaluate(te, fogRule), baseRate: evaluate(te, () => baseRate) };
    }
    models.fog = fitLogit(trainFog, FEATS.fog);
  }

  // 배별 실적 요약
  const vesselStats = [...new Set(actRows.map(r => r.vessel))].map(name => {
    const rs = actRows.filter(r => r.vessel === name && r.date < TODAY);
    const reasons = {}; for (const r of rs) if (r.outcome === "cancelled") reasons[r.reason || "기타"] = (reasons[r.reason || "기타"] || 0) + 1;
    return { vessel: name, total: rs.length, operated: rs.filter(r => r.outcome === "operated").length,
      cancelled: rs.filter(r => r.outcome === "cancelled").length, nonoperating: rs.filter(r => r.outcome === "nonoperating").length,
      from: rs.map(r => r.date).sort()[0] || null, reasons };
  }).sort((a, b) => b.total - a.total);

  // 5) 앞으로 7일 배편 목록
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(TODAY, i));
  function scheduleFor(date) {
    const L = live.today?.date === date ? live.today : live.tomorrow?.date === date ? live.tomorrow : null;
    if (L && L.rows.length) return { basis: L === live.today ? "KOMSA 당일 운항현황" : `KOMSA 다음 날 운항예보${live.tomorrow.updated ? " (" + live.tomorrow.updated + " 발표)" : ""}`,
      list: L.rows.map(r => ({ ...r, official: { status: r.status, outcome: r.outcome, reason: r.reason || "", progress: r.progress || "", kind: L === live.today ? "today" : "tomorrow" } })) };
    for (let w = 1; w <= 4; w++) {
      const d = addDays(date, -7 * w);
      const past = actRows.filter(r => r.date === d && r.outcome !== "nonoperating");
      if (past.length) return { basis: `${d} 같은 요일 시간표`, list: past.map(r => ({ ...r, date, official: null })) };
    }
    return { basis: "기본 시간표", list: CFG.fallbackSchedule.sailings.map(s => ({ ...s, date, vesselId: vid(s.vessel), official: null })) };
  }
  const MODEL_NAMES = { best_match: "종합", ecmwf_ifs025: "유럽", kma_seamless: "한국", gfs_seamless: "미국" };
  const out = [];
  for (const date of days) {
    const sch = scheduleFor(date);
    sch.list = expandRoundTrips(sch.list, date, rt, date === live.today?.date);
    const sailings = sch.list.map(s => {
      const hour = +s.time.slice(0, 2);
      const k = kmaNow ? kmaFor(kmaNow.periods, date, hour) : null;
      const feats = {}, probs = {}, windProbs = {};
      let fogP = null, fogF = null;
      if (omNow) {
        const fb = omFeat(omNow.best_match || Object.values(omNow)[0], date, s.time);
        if (fb) { fogF = fb; const r = { ...fb, vesselId: "all", visLog: visLog(fb.vis) }; fogP = enoughFog ? predict(models.fog, r) : fogRule(r); }
        for (const [mod, hourly] of Object.entries(omNow)) {
          const f = omFeat(hourly, date, s.time); if (!f) continue;
          feats[mod] = f;
          const r = addEx({ vesselId: s.vesselId, ...f, visLog: visLog(f.vis), kmaWind: k?.windMax ?? null, kmaWave: k?.waveMax ?? null });
          const pw = enough ? predict(k ? models.full : models.om, r) : ruleProb(r);
          windProbs[mod] = pw;
          probs[mod] = pw == null ? null : 1 - (1 - pw) * (1 - (fogP ?? 0));
        }
      }
      const main = feats.best_match || Object.values(feats)[0] || null;
      const pv = Object.values(probs).filter(p => p != null);
      const pWind = windProbs.best_match ?? null;
      const p = probs.best_match ?? (pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : (k ? ruleProb({ kmaWind: k.windMax, kmaWave: k.waveMax }) : null));
      // 비슷한 과거 배편
      let similar = [];
      if (main && train.length) {
        const sc = { wind: 4, wave: 0.6, kmaWave: 1, kmaWind: 4, visLog: 0.5 };
        const q = { ...main, visLog: visLog(main.vis), kmaWind: k?.windMax ?? null, kmaWave: k?.waveMax ?? null };
        similar = train.filter(r => r.vesselId === s.vesselId).map(r => {
          let d = 0, n = 0; for (const [f, s2] of Object.entries(sc)) { if (q[f] == null || r[f] == null) continue; d += ((q[f] - r[f]) / s2) ** 2; n++; }
          return { r, d: n ? Math.sqrt(d / n) : 99 };
        }).sort((a, b) => a.d - b.d).slice(0, 8).map(({ r }) => ({ date: r.date, time: r.time, y: r.y, wind: rd(r.wind), wave: rd(r.wave), kmaWind: r.kmaWind, kmaWave: r.kmaWave }));
      }
      return {
        time: s.time, vessel: s.vessel, vesselId: s.vesselId, port: s.port, out: s.port === "목포", route: s.route, approx: !!s.approx, via: s.via || null,
        official: s.official,
        live: date === TODAY ? (rt.live?.[`${s.vessel}|${s.via || s.time}`] || null) : null,
        p: p == null ? null : rd(p, 3), pWind: rd(pWind, 3), pFog: rd(fogP, 3),
        fog: fogF ? { visKm: fogF.vis == null ? null : rd(fogF.vis / 1000), dewDep: rd(fogF.dewDep), rh: rd(fogF.rh, 0), airSea: rd(fogF.airSea), cloudLow: rd(fogF.cloudLow, 0), wind: rd(fogF.windMean) } : null,
        pRange: pv.length > 1 ? [rd(Math.min(...pv), 3), rd(Math.max(...pv), 3)] : null,
        byModel: Object.fromEntries(Object.entries(probs).map(([m, v]) => [MODEL_NAMES[m] || m, v == null ? null : rd(v, 3)])),
        weather: main ? { wind: rd(main.wind), gust: rd(main.gust), wave: rd(main.wave), visKm: main.vis == null ? null : rd(main.vis / 1000) } : null,
        kma: k ? { wind: `${k.windMin}~${k.windMax}`, wave: `${k.waveMin}~${k.waveMax}`, sky: k.sky, part: k.part } : null,
        similar,
      };
    });
    out.push({ date, scheduleBasis: sch.basis, sailings });
  }

  // 6) 공식 발표 변화 감지 + 알림
  const prevMap = new Map();
  for (const d of prev?.days || []) for (const s of d.sailings) if (s.official && !s.via) prevMap.set(`${d.date}|${s.vessel}|${s.time}|${s.port}`, s.official.status);
  const changes = [];
  if (prev) for (const d of out) for (const s of d.sailings) {
    if (!s.official || s.via) continue;
    const before = prevMap.get(`${d.date}|${s.vessel}|${s.time}|${s.port}`);
    if (before === s.official.status) continue;
    if (before === undefined && s.official.kind === "today") continue; // 날짜가 넘어가며 생긴 당일 목록은 제외
    changes.push({ at: new Date().toISOString(), date: d.date, time: s.time, vessel: s.vessel, port: s.port, from: before ?? null, to: s.official.status, reason: s.official.reason, outcome: s.official.outcome });
  }
  const changeLog = [...changes, ...(prev?.changeLog || [])].slice(0, 60);
  if (NTFY && changes.length) {
    const byDate = {};
    for (const c of changes) (byDate[c.date] ||= []).push(c);
    const lines = Object.entries(byDate).map(([d, cs]) => {
      const bad = cs.filter(c => c.outcome !== "operated");
      return `${d.slice(5).replace("-", "/")}: ` + (bad.length ? bad.map(c => `${c.time} ${c.vessel}(${c.port}) ${c.to}${c.reason ? "-" + c.reason : ""}`).join(", ") : `${cs.length}편 ${cs[0].to}`);
    });
    await source("ntfy", "휴대폰 알림", async () => {
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, { method: "POST", body: lines.join("\n"), headers: { Title: "Hauido ferry", Tags: "ship" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
    });
  }

  // 7) 저장
  writeJSON("actuals.json", act);
  writeJSON("kma-archive.json", kmaArc);
  const latest = {
    generatedAt: new Date().toISOString(), today: TODAY,
    kmaIssued: kmaNow?.annc || null, kmaZone: CFG.kmaZone.name, point: CFG.point,
    days: out, changeLog, sources,
    model: {
      mode: enough ? "학습 모델" : "기본 규칙(학습 자료 부족)",
      trainRows: train.length, trainCancelled: positives, trainFrom: train[0]?.date || null, trainTo: train.at(-1)?.date || null,
      weights: enough ? Object.fromEntries(models.full.names.map((n, i) => [FEAT_KO[n], rd(models.full.w[i], 3)])) : null,
      validation,
      fog: { mode: enoughFog ? "학습 모델" : "기본 규칙(학습 자료 부족)", trainRows: trainFog.length, trainCancelled: fogPositives,
        weights: enoughFog ? Object.fromEntries(models.fog.names.map((n, i) => [FEAT_KO[n] || n, rd(models.fog.w[i], 3)])) : null, validation: fogValidation },
    },
    vesselStats,
    historyCoverage: { daysCollected: Object.keys(act.done).length, target: CFG.historyDays },
    roundTrip: { offsets: rt.offsets, basis: rt.basis, computedOn: rt.computedOn || null, patterns: rt.patterns || {} },
    tomorrowIssued: live.tomorrow ? { date: live.tomorrow.date, updated: live.tomorrow.updated } : null,
  };
  writeJSON("latest.json", latest);
  log("done", { train: train.length, positives, enough, changes: changes.length, sources: sources.map(s => s.key + ":" + (s.ok ? "ok" : "fail")).join(" ") });
})().catch(e => { console.error(e); process.exit(1); });

function rd(v, n = 1) { if (v == null || !isFinite(v)) return null; const m = 10 ** n; return Math.round(v * m) / m; }
