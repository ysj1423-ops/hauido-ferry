// 진단용: API 요청 형식 확인 (인증키는 출력하지 않음)
const KEY = process.env.DATA_GO_KR_KEY.trim();
const base = "https://apis.data.go.kr/B554035/ferry-route-info-v4/get-ferry-route-info-v4";
const kst = new Date(Date.now() + 9 * 3600e3);
const d = n => new Date(kst.getTime() - n * 86400e3).toISOString().slice(0, 10);
const keyPart = KEY.includes("%") ? "serviceKey=" + KEY : "serviceKey=" + encodeURIComponent(KEY);
for (const date of [d(0), d(1), d(30)]) for (const fmt of ["compact", "dash"]) for (const name of ["", "천사1호"]) {
  const q = new URLSearchParams({ pageNo: "1", numOfRows: "5", dataType: "JSON", rlvtYmd: fmt === "compact" ? date.replaceAll("-", "") : date });
  if (name) q.set("psnshpNm", name);
  try {
    const t = await (await fetch(`${base}?${keyPart}&${q}`)).text();
    let j; try { j = JSON.parse(t); } catch { console.log(date, fmt, name, "NOT JSON", t.slice(0, 200)); continue; }
    const r = j.response || j;
    console.log(date, fmt, name || "(배 이름 없음)", r.header?.resultCode, r.header?.resultMsg, "total", r.body?.totalCount);
    const it = r.body?.items?.item ?? r.body?.items; if (it && (!Array.isArray(it) || it.length)) console.log(JSON.stringify(Array.isArray(it) ? it.slice(0, 2) : it).slice(0, 900));
  } catch (e) { console.log(date, fmt, name, "ERR", e.message); }
}
