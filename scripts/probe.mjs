// 진단용: KOMSA 표 구조와 과거 조회 범위 확인
const pages = {
  tomorrow: "https://komsa.or.kr/prog/tmmrwSailing/kor/sub03_0207/list.do?searchJbcd=F",
  current: "https://komsa.or.kr/prog/pssgCurState/kor/sub03_0202/list.do?jbcd=F",
  c20251107: "https://komsa.or.kr/prog/crtfctSailing/kor/sub03_0206/list.do?searchJbcd=F&searchIlja=2025-11-07",
  c20250115: "https://komsa.or.kr/prog/crtfctSailing/kor/sub03_0206/list.do?searchJbcd=F&searchIlja=2025-01-15",
  c20240115: "https://komsa.or.kr/prog/crtfctSailing/kor/sub03_0206/list.do?searchJbcd=F&searchIlja=2024-01-15",
};
for (const [k, u] of Object.entries(pages)) {
  const t = await (await fetch(u)).text();
  const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map(m => m[1]).filter(r => /천사[13]호|퍼스트엔젤|>\s*엔젤/.test(r));
  console.log("==", k, "matching rows", rows.length);
  for (const r of rows.slice(0, 2)) console.log("RAW", r.replace(/\s+/g, " ").slice(0, 700));
  for (const r of rows.slice(0, 20)) console.log("CELLS", JSON.stringify([...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map(m => m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim())));
  await new Promise(r => setTimeout(r, 1500));
}
