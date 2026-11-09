// 진단용(1회): mtis 스크립트 파일에서 여객선 운항예보 자료 경로 찾기
const base = "https://mtis.komsa.or.kr";
const page = await (await fetch(base + "/traffic/ferryInfo")).text();
const srcs = [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]).filter(s => s.startsWith("/js/cmm") || /ferry/i.test(s));
console.log("SRCS", srcs.join(" "));
for (const s of srcs) {
  const t = await (await fetch(base + s)).text();
  const urls = new Set([...t.matchAll(/["'`](\/[a-zA-Z0-9_\/.-]*(?:ferry|Ferry|navi|Navi|sail|Sail|psnshp|tmrw|Tmrw|fcst|Fcst)[a-zA-Z0-9_\/.-]*)["'`]/g)].map(m => m[1]));
  if (urls.size) console.log("JS", s, [...urls].join(" "));
  for (const kw of ["내일의 운항예보", "tmrw", "Tmrw", "운항예보"]) { const i = t.indexOf(kw); if (i >= 0) console.log("CTX", s, kw, t.slice(Math.max(0, i - 300), i + 300).replace(/\s+/g, " ")); }
  await new Promise(r => setTimeout(r, 500));
}
