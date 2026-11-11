// 진단용(1회): Open-Meteo 과거 예보(선행일별) 자료가 모델별로 얼마나 오래 있는지 확인
const base = "https://previous-runs-api.open-meteo.com/v1/forecast?latitude=34.70&longitude=126.20&wind_speed_unit=ms&timezone=Asia%2FSeoul";
const vars = [1, 3, 5, 7].map(d => `wind_speed_10m_previous_day${d}`).join(",");
for (const m of ["best_match", "ecmwf_ifs025", "gfs_seamless", "kma_seamless", "icon_seamless", "jma_seamless"]) {
  for (const [s, e] of [["2024-11-01", "2024-11-03"], ["2025-06-01", "2025-06-03"], ["2026-11-01", "2026-11-03"]]) {
    try {
      const r = await fetch(`${base}&hourly=${vars}&models=${m}&start_date=${s}&end_date=${e}`); const j = await r.json();
      const h = j.hourly || {}; const cnt = Object.fromEntries(Object.entries(h).filter(([k]) => k !== "time").map(([k, v]) => [k.replace("wind_speed_10m_previous_", "").replace("_" + m, ""), v.filter(x => x != null).length]));
      console.log("RES", m, s, r.status, j.reason || "", JSON.stringify(cnt));
    } catch (e) { console.log("RES", m, s, "ERR", e.message); }
    await new Promise(r => setTimeout(r, 300));
  }
}
