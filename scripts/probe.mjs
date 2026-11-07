// 진단용: 운항상태 코드 확인 (인증키는 출력하지 않음)
const KEY = process.env.DATA_GO_KR_KEY.trim();
const base = "https://apis.data.go.kr/B554035/ferry-route-info-v4/get-ferry-route-info-v4";
const keyPart = KEY.includes("%") ? "serviceKey=" + KEY : "serviceKey=" + encodeURIComponent(KEY);
const kst = new Date(Date.now() + 9 * 3600e3);
const d = n => new Date(kst.getTime() - n * 86400e3).toISOString().slice(0, 10).replaceAll("-", "");
const codes = new Map();
for (const date of ["20261106", "20261105", d(0), d(-1), d(-2)]) for (const name of ["천사1호", "천사3호", "퍼스트엔젤", "엔젤"]) {
  const q = new URLSearchParams({ pageNo: "1", numOfRows: "1000", dataType: "JSON", rlvtYmd: date, psnshpNm: name });
  const j = await (await fetch(`${base}?${keyPart}&${q}`)).json();
  const r = j.response || j; let it = r.body?.items?.item ?? r.body?.items ?? []; if (!Array.isArray(it)) it = [it];
  const by = new Map();
  for (const x of it) { codes.set(x.nvg_stts_cd + " " + x.nvg_stts_nm, (codes.get(x.nvg_stts_cd + " " + x.nvg_stts_nm) || 0) + 1);
    const k = x.sail_tm + "/" + x.nvg_drc_nm; if (!by.has(k)) by.set(k, []); by.get(k).push(`${x.nvg_stts_nm}@${x.portcl_nm ?? "-"}@${(x.nvg_stts_chg_dt || "").slice(11, 16)}`); }
  console.log(`== ${date} ${name} rows=${it.length} total=${r.body?.totalCount} code=${r.header?.resultCode}`);
  for (const [k, v] of [...by].sort((a, b) => +a[0].split("/")[0] - +b[0].split("/")[0])) console.log("  ", k, "|", v.join(" ; ").slice(0, 300));
}
console.log("CODES", JSON.stringify([...codes]));
