// 진단용: mtis 여객선 정보 페이지 구조 확인
const u = "https://mtis.komsa.or.kr/traffic/ferryInfo";
try {
  const r = await fetch(u); const t = await r.text();
  console.log("== status", r.status, t.length);
  const txt = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  console.log("TEXT", txt.slice(0, 1500));
  console.log("SCRIPTS", [...t.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).join(" "));
  console.log("APIHINTS", [...new Set([...t.matchAll(/["'](\/[a-zA-Z0-9_\/.-]*(?:ajax|api|json|list|select|search)[a-zA-Z0-9_\/.-]*)["']/gi)].map(m => m[1]))].slice(0, 40).join(" "));
  const i = t.search(/천사|상태서리|ferry/i); console.log("SNIP", t.slice(Math.max(0, i - 300), i + 1500).replace(/\s+/g, " "));
} catch (e) { console.log("ERR", e.message); }
