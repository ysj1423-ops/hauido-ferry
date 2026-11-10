// 휴대폰 알림(ntfy) 시험 발송. 주제 이름은 GitHub Secret(NTFY_TOPIC)에서만 읽는다.
const topic = (process.env.NTFY_TOPIC || "").trim();
if (!topic) { console.log("NTFY_TOPIC이 비어 있습니다"); process.exit(1); }
const r = await fetch("https://ntfy.sh/", { method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ topic, title: "하의도 배편 시험 알림", message: "알림 설정이 잘 되었습니다.\n앞으로 12시 다음 날 운항예보와 결항·비운항 변경을 이렇게 알려 드립니다.", tags: ["ship"], click: "https://ysj1423-ops.github.io/hauido-ferry/" }) });
console.log("발송 결과", r.status);
if (!r.ok) process.exit(1);
