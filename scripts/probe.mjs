// 진단용: KOMSA 홈페이지가 GitHub 서버에서 열리는지 확인 (일반 요청 1회씩)
const urls = {
  tomorrow: "https://komsa.or.kr/prog/tmmrwSailing/kor/sub03_0207/list.do?searchJbcd=F",
  current: "https://komsa.or.kr/prog/pssgCurState/kor/sub03_0202/list.do?jbcd=F",
  confirmed: "https://komsa.or.kr/prog/crtfctSailing/kor/sub03_0206/list.do?searchJbcd=F&searchIlja=2026-11-06",
};
for (const [k, u] of Object.entries(urls)) {
  try {
    const r = await fetch(u); const t = await r.text();
    const body = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const i = body.search(/천사|퍼스트엔젤/);
    console.log("==", k, r.status, t.length, i >= 0 ? body.slice(Math.max(0, i - 300), i + 900) : body.slice(0, 300));
    if (k !== "current") { const m = t.match(/<table[\s\S]*?<\/table>/); if (m) console.log("TABLEHTML", m[0].slice(0, 1500).replace(/\s+/g, " ")); }
  } catch (e) { console.log("==", k, "ERR", e.message); }
}
