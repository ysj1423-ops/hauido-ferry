// 하의도 배편 자료 수집 + 예측 (GitHub Actions에서 30분마다 실행)
// 실행: DATA_GO_KR_KEY=... node scripts/collect.mjs
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DATA = path.join(ROOT, "docs", "data");
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const KEY = (process.env.DATA_GO_KR_KEY || "").trim();
const NTFY = (process.env.NTFY_TOPIC || "").trim();
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

// ---------- 1. KOMSA 여객선 운항상태 (공공데이터포털) ----------
const VESSEL_BY_NAME = Object.fromEntries(CFG.vessels.map(v => [v.name, v.id]));
function classify(s = "") {
  s = s.replace(/\s/g, "");
  if (/통제|결항|취소/.test(s)) return "cancelled";
  if (/비운/.test(s)) return "nonoperating";
  if (/정상|운항|완료|출항|도착|입항|지연|운항중|출발/.test(s)) return "operated";
  return "unknown";
}
const fmtTime = t => { t = String(t || "").replace(/[^0-9]/g, "").padStart(4, "0"); return t.slice(0, 2) + ":" + t.slice(2, 4); };

let dateParamStyle = readJSON("actuals.json", {}).dateParamStyle || null;
async function komsaDay(date) {
  const styles = dateParamStyle ? [dateParamStyle] : ["compact", "dash"];
  let out = [], raw = [];
  for (const style of styles) {
    out = []; raw = [];
    for (const v of CFG.vessels) {
      const base = "https://apis.data.go.kr/B554035/ferry-route-info-v4/get-ferry-route-info-v4";
      const q = new URLSearchParams({ pageNo: "1", numOfRows: "300", dataType: "JSON", rlvtYmd: style === "compact" ? compact(date) : date, psnshpNm: v.name });
      const keyPart = KEY.includes("%") ? "serviceKey=" + KEY : "serviceKey=" + encodeURIComponent(KEY);
      const j = await get(`${base}?${keyPart}&${q}`);
      const resp = j.response || j;
      const code = resp?.header?.resultCode;
      if (code && !["00", "0", "0000", "200", "INFO-000"].includes(String(code)) && String(code) !== "03") {
        throw new Error(`API ${code} ${resp.header.resultMsg || ""}`);
      }
      let items = resp?.body?.items?.item ?? resp?.body?.items ?? [];
      if (!Array.isArray(items)) items = items ? [items] : [];
      for (const it of items) {
        raw.push(it);
        const name = it.psnshp_nm || v.name;
        const routeTxt = [it.lcns_seawy_nm, it.nvg_seawy_nm, it.portcl_nm].join(" ");
        if (!VESSEL_BY_NAME[name] && !CFG.routeKeywords.some(k => routeTxt.includes(k))) continue;
        out.push({
          date, time: fmtTime(it.sail_tm), vessel: name, vesselId: VESSEL_BY_NAME[name] || name,
          port: it.portcl_nm || "", direction: it.nvg_drc_nm || "", route: it.nvg_seawy_nm || it.lcns_seawy_nm || "",
          status: it.nvg_stts_nm || "", outcome: classify(it.nvg_stts_nm), changedAt: it.nvg_stts_chg_dt || null,
        });
      }
      await sleep(250);
    }
    if (out.length || dateParamStyle) { if (!dateParamStyle && out.length) dateParamStyle = style; break; }
  }
  // 같은 배·시각이 기항지별로 여러 줄이면 첫 줄(가장 이른 기항지)만
  const seen = new Map();
  for (const r of out) { const k = r.vesselId + "|" + r.time; if (!seen.has(k)) seen.set(k, r); else if (r.outcome === "cancelled") seen.get(k).outcome = "cancelled"; }
  return { rows: [...seen.values()].sort((a, b) => a.time.localeCompare(b.time)), raw };
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
  const w = await get(`https://api.open-meteo.com/v1/forecast?latitude=${P.lat}&longitude=${P.lon}&hourly=wind_speed_10m,wind_gusts_10m,visibility&models=${models.join(",")}&wind_speed_unit=ms&timezone=Asia%2FSeoul&forecast_days=8`);
  const m = await get(`https://marine-api.open-meteo.com/v1/marine?latitude=${P.lat}&longitude=${P.lon}&hourly=wave_height&timezone=Asia%2FSeoul&forecast_days=8&cell_selection=sea`);
  const idx = new Map(m.hourly.time.map((t, i) => [t, m.hourly.wave_height[i]]));
  const out = {};
  for (const mod of models) {
    const sfx = k => w.hourly[`${k}_${mod}`] ?? (mod === "best_match" ? w.hourly[k] : null);
    const ws = sfx("wind_speed_10m"); if (!ws) continue;
    const gs = sfx("wind_gusts_10m"), vs = sfx("visibility");
    const best_vs = w.hourly.visibility_best_match || w.hourly.visibility;
    out[mod] = {};
    w.hourly.time.forEach((t, i) => { out[mod][t] = { wind: ws[i], gust: gs?.[i], vis: (vs?.[i] ?? best_vs?.[i]), wave: idx.get(t) }; });
  }
  return out;
}
async function omHistory(start, end) {
  const w = await get(`https://historical-forecast-api.open-meteo.com/v1/forecast?latitude=${P.lat}&longitude=${P.lon}&hourly=wind_speed_10m,wind_gusts_10m,visibility&wind_speed_unit=ms&timezone=Asia%2FSeoul&start_date=${start}&end_date=${end}`);
  const m = await get(`https://marine-api.open-meteo.com/v1/marine?latitude=${P.lat}&longitude=${P.lon}&hourly=wave_height&timezone=Asia%2FSeoul&start_date=${start}&end_date=${end}&cell_selection=sea`);
  const idx = new Map(m.hourly.time.map((t, i) => [t, m.hourly.wave_height[i]]));
  const out = {};
  w.hourly.time.forEach((t, i) => { out[t] = { wind: w.hourly.wind_speed_10m[i], gust: w.hourly.wind_gusts_10m[i], vis: w.hourly.visibility[i], wave: idx.get(t) }; });
  return out;
}
// 출항 1시간 전 ~ 2시간 후 구간의 가장 나쁜 값
function omFeat(hourly, date, time) {
  if (!hourly) return null;
  const h0 = +time.slice(0, 2); let wind = null, gust = null, wave = null, vis = null;
  for (let h = h0 - 1; h <= h0 + 2; h++) {
    const d = h < 0 ? addDays(date, -1) : h > 23 ? addDays(date, 1) : date;
    const hh = ((h % 24) + 24) % 24;
    const x = hourly[`${d}T${String(hh).padStart(2, "0")}:00`]; if (!x) continue;
    if (x.wind != null) wind = Math.max(wind ?? -1, x.wind);
    if (x.gust != null) gust = Math.max(gust ?? -1, x.gust);
    if (x.wave != null) wave = Math.max(wave ?? -1, x.wave);
    if (x.vis != null) vis = Math.min(vis ?? 1e9, x.vis);
  }
  return wind == null ? null : { wind, gust, wave, vis };
}

// ---------- 4. 모델: 로지스틱 회귀 (배별 절편 + 공통 기울기) ----------
const visLog = v => v == null ? null : Math.log10(Math.max(v, 50) / 1000);
const FEATS = {
  full: ["wind", "gust", "wave", "visLog", "kmaWind", "kmaWave"],
  om: ["wind", "gust", "wave", "visLog"],
};
const FEAT_KO = { wind: "모델 풍속", gust: "모델 돌풍", wave: "모델 파고", visLog: "시정", kmaWind: "기상청 풍속", kmaWave: "기상청 파고" };
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
  const d = X[0].length; let w = new Array(d).fill(0);
  const lam = 0.02, lr = 0.3, n = X.length;
  for (let it = 0; it < 1500; it++) {
    const g = new Array(d).fill(0);
    for (let i = 0; i < n; i++) { const p = sig(dot(w, X[i])); const e = p - Y[i]; for (let j = 0; j < d; j++) g[j] += e * X[i][j]; }
    for (let j = 0; j < d; j++) w[j] -= lr * (g[j] / n + (j < names.length ? lam * w[j] : 0));
  }
  return { names, vessels, stats, w };
}
const sig = z => 1 / (1 + Math.exp(-z));
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
  const debug = {};

  // 1) 운항 실적/상태
  if (!KEY) sources.push({ key: "komsa", name: "KOMSA 운항상태 API", ok: false, error: "인증키(DATA_GO_KR_KEY) 미설정" });
  else await source("komsa", "KOMSA 운항상태 API", async () => {
    const recent = [addDays(TODAY, -2), addDays(TODAY, -1), TODAY, addDays(TODAY, 1), addDays(TODAY, 2)];
    const missing = [];
    for (let i = 3; i <= CFG.historyDays; i++) { const d = addDays(TODAY, -i); if (!act.done[d]) missing.push(d); }
    const todo = [...recent, ...missing.slice(0, CFG.backfillPerRun)];
    for (const d of todo) {
      const { rows, raw } = await komsaDay(d);
      if (raw.length && !debug.sample) debug.sample = raw.slice(0, 5);
      for (const r of rows) {
        const id = `${r.date}|${r.vesselId}|${r.time}`;
        const old = act.rows[id];
        act.rows[id] = { ...r, firstSeen: old?.firstSeen || new Date().toISOString() };
      }
      if (d < addDays(TODAY, -1)) act.done[d] = new Date().toISOString();
    }
    act.dateParamStyle = dateParamStyle;
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

  // 4) 학습 자료 만들기
  const train = [];
  for (const r of actRows) {
    if (r.date >= TODAY || !["cancelled", "operated"].includes(r.outcome)) continue;
    const f = omFeat(omHist, r.date, r.time); if (!f) continue;
    const k = kmaFor(kmaArc[compact(addDays(r.date, -1)) + "1700"] || [], r.date, +r.time.slice(0, 2));
    train.push({ date: r.date, time: r.time, vesselId: r.vesselId, port: r.port, y: r.outcome === "cancelled" ? 1 : 0,
      wind: f.wind, gust: f.gust, wave: f.wave, vis: f.vis, visLog: visLog(f.vis), kmaWind: k?.windMax ?? null, kmaWave: k?.waveMax ?? null });
  }
  train.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const positives = train.filter(r => r.y).length;
  const enough = positives >= 8 && train.length >= 200;

  // 시간순 검증: 앞 70% 날짜로 학습, 뒤 30%로 평가
  let validation = null, models = {};
  if (enough) {
    const ds = [...new Set(train.map(r => r.date))];
    const cut = ds[Math.floor(ds.length * 0.7)];
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

  // 배별 실적 요약
  const vesselStats = CFG.vessels.map(v => {
    const rs = actRows.filter(r => r.vesselId === v.id && r.date < TODAY);
    return { vesselId: v.id, vessel: v.name, total: rs.length, operated: rs.filter(r => r.outcome === "operated").length,
      cancelled: rs.filter(r => r.outcome === "cancelled").length, nonoperating: rs.filter(r => r.outcome === "nonoperating").length,
      days: new Set(rs.map(r => r.date)).size };
  });

  // 5) 앞으로 7일 배편 목록
  const days = [];
  for (let i = 0; i < 7; i++) days.push(addDays(TODAY, i));
  function scheduleFor(date) {
    const official = actRows.filter(r => r.date === date);
    if (official.length) return { basis: "official", list: official };
    for (let w = 1; w <= 4; w++) {
      const d = addDays(date, -7 * w);
      const past = actRows.filter(r => r.date === d && r.outcome !== "nonoperating");
      if (past.length) return { basis: `${d} 같은 요일 실적`, list: past.map(r => ({ ...r, status: "", outcome: "planned", date })) };
    }
    return { basis: "기본 시간표", list: CFG.fallbackSchedule.sailings.map(s => ({ ...s, date, vesselId: VESSEL_BY_NAME[s.vessel] || s.vessel, status: "", outcome: "planned" })) };
  }
  const MODEL_NAMES = { best_match: "종합", ecmwf_ifs025: "유럽", kma_seamless: "한국", gfs_seamless: "미국" };
  const out = [];
  for (const date of days) {
    const sch = scheduleFor(date);
    const sailings = sch.list.map(s => {
      const hour = +s.time.slice(0, 2);
      const k = kmaNow ? kmaFor(kmaNow.periods, date, hour) : null;
      const feats = {}, probs = {};
      if (omNow) for (const [mod, hourly] of Object.entries(omNow)) {
        const f = omFeat(hourly, date, s.time); if (!f) continue;
        feats[mod] = f;
        const r = { vesselId: s.vesselId, ...f, visLog: visLog(f.vis), kmaWind: k?.windMax ?? null, kmaWave: k?.waveMax ?? null };
        probs[mod] = enough ? predict(k ? models.full : models.om, r) : ruleProb(r);
      }
      const main = feats.best_match || Object.values(feats)[0] || null;
      const pv = Object.values(probs).filter(p => p != null);
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
        time: s.time, vessel: s.vessel, vesselId: s.vesselId, port: s.port, direction: s.direction || "", route: s.route,
        official: s.outcome !== "planned" ? { status: s.status, outcome: s.outcome, changedAt: s.changedAt || null } : null,
        p: p == null ? null : rd(p, 3), pRange: pv.length > 1 ? [rd(Math.min(...pv), 3), rd(Math.max(...pv), 3)] : null,
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
  for (const d of prev?.days || []) for (const s of d.sailings) if (s.official) prevMap.set(`${d.date}|${s.vesselId}|${s.time}`, s.official.status);
  const changes = [];
  if (prevMap.size) for (const d of out) for (const s of d.sailings) {
    if (!s.official) continue;
    const before = prevMap.get(`${d.date}|${s.vesselId}|${s.time}`);
    if (before === s.official.status) continue;
    if (before === undefined && s.official.outcome === "operated" && d.date <= TODAY) continue; // 당일 정상 진행은 알리지 않음
    changes.push({ at: new Date().toISOString(), date: d.date, time: s.time, vessel: s.vessel, port: s.port, from: before ?? null, to: s.official.status, outcome: s.official.outcome });
  }
  const changeLog = [...changes, ...(prev?.changeLog || [])].slice(0, 40);
  if (NTFY && changes.length) {
    const body = changes.slice(0, 10).map(c => `${c.date.slice(5)} ${c.time} ${c.vessel}(${c.port}) ${c.from ? c.from + "→" : ""}${c.to}`).join("\n");
    await source("ntfy", "알림 보내기", async () => {
      const r = await fetch(`https://ntfy.sh/${encodeURIComponent(NTFY)}`, { method: "POST", body, headers: { Title: "Hauido ferry: official status", Tags: "ship" } });
      if (!r.ok) throw new Error("HTTP " + r.status);
    });
  }

  // 7) 저장
  writeJSON("actuals.json", act);
  writeJSON("kma-archive.json", kmaArc);
  if (debug.sample) writeJSON("debug-sample.json", debug);
  const latest = {
    generatedAt: new Date().toISOString(), today: TODAY,
    kmaIssued: kmaNow?.annc || null, kmaZone: CFG.kmaZone.name, point: CFG.point,
    days: out, changeLog, sources,
    model: {
      mode: enough ? "학습 모델" : "기본 규칙(학습 자료 부족)",
      trainRows: train.length, trainCancelled: positives, trainFrom: train[0]?.date || null, trainTo: train.at(-1)?.date || null,
      weights: enough ? Object.fromEntries(models.full.names.map((n, i) => [FEAT_KO[n], rd(models.full.w[i], 3)])) : null,
      validation,
    },
    vesselStats,
    historyCoverage: { daysCollected: Object.keys(act.done).length, target: CFG.historyDays },
  };
  writeJSON("latest.json", latest);
  log("done", { train: train.length, positives, enough, changes: changes.length, sources: sources.map(s => s.key + ":" + (s.ok ? "ok" : "fail")).join(" ") });
})().catch(e => { console.error(e); process.exit(1); });

function rd(v, n = 1) { if (v == null || !isFinite(v)) return null; const m = 10 ** n; return Math.round(v * m) / m; }
