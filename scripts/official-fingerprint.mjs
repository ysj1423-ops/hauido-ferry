// 공식 발표 내용만 뽑아 지문을 만든다 (바뀌었을 때만 바로 올리기 위해)
import fs from "node:fs";
try {
  const d = JSON.parse(fs.readFileSync(new URL("../docs/data/latest.json", import.meta.url)));
  const sig = d.days.flatMap(x => x.sailings.filter(s => s.official && !s.via).map(s => `${x.date}${s.time}${s.vessel}${s.official.status}${s.official.reason}${s.official.progress}`)).join("|") + "|" + (d.tomorrowIssued?.updated || "");
  let h = 0; for (const c of sig) h = (h * 31 + c.charCodeAt(0)) | 0;
  console.log(h);
} catch { console.log("none"); }
