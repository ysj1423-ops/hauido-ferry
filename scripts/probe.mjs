// 진단용(1회): mtis 여객선 정보 화면이 오늘/내일 운항예보를 어디서 불러오는지 찾기
const base = "https://mtis.komsa.or.kr";
const t = await (await fetch(base + "/traffic/ferryInfo")).text();
const inline = [...t.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n");
const urls = new Set([...inline.matchAll(/["'`](\/[a-zA-Z0-9_\/.-]+?(?:\.do|\.json|Ajax|ajax|List|list|Info|info)[a-zA-Z0-9_\/.-]*)["'`]/g)].map(m => m[1]));
console.log("URLS", [...urls].join(" "));
for (const kw of ["내일", "tmrw", "tomorrow", "Tmrw", "운항예보", "fcst", "Fcst"]) {
  let i = -1, n = 0; while ((i = inline.indexOf(kw, i + 1)) >= 0 && n < 3) { console.log("CTX", kw, inline.slice(Math.max(0, i - 250), i + 250).replace(/\s+/g, " ")); n++; }
}
