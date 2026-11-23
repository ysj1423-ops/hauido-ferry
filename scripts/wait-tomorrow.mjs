// 12시 직후: KOMSA 다음 날 운항예보 페이지만 30초마다 확인하다가, 내일 예보가 올라오면 바로 끝낸다(최대 12:05:30).
const URL_T = "https://komsa.or.kr/prog/tmmrwSailing/kor/sub03_0207/list.do?searchJbcd=F";
const kst = () => new Date(Date.now() + 9 * 3600e3);
const tomorrow = new Date(kst().getTime() + 864e5).toISOString().slice(0, 10).replaceAll("-", "");
const deadline = new Date(kst().toISOString().slice(0, 10) + "T12:05:30+09:00").getTime();
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 12:00:01까지 기다림
const start = new Date(kst().toISOString().slice(0, 10) + "T12:00:01+09:00").getTime();
if (Date.now() < start) await sleep(start - Date.now());
while (Date.now() < deadline) {
  try {
    const h = await (await fetch(URL_T, { signal: AbortSignal.timeout(20000) })).text();
    const m = /적용일\s*(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일/.exec(h.replace(/<[^>]+>/g, " "));
    const d = m ? `${m[1]}${m[2].padStart(2, "0")}${m[3].padStart(2, "0")}` : null;
    console.log(kst().toISOString().slice(11, 19), "적용일", d);
    if (d === tomorrow) { console.log("내일 운항예보 확인"); process.exit(0); }
  } catch (e) { console.log("확인 실패", e.message); }
  await sleep(30000);
}
console.log("12:05까지 내일 예보 없음 → 이후 12:10·12:20 확인에 맡김");
