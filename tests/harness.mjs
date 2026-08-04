// smile-watch.html をテストできる形に変換して、静的サーバーで配る。
//
// 変換は 3 つ。
//   1. MediaPipe の CDN import を stub-vision.mjs に差し替える
//   2. 時間の定数を SPEED 倍速にする（60 秒窓の検証を実時間で待たないため）
//   3. テストから内部状態を覗くフックを足す
//
// 2 は「1 窓あたりのサンプル数」を実機と同じ 300 に保つのが要点。サンプリング間隔だけを
// 詰めても requestAnimationFrame（約 16.7ms）より短くはできず、窓の中身が薄くなって
// 覚醒スコアが出なくなる。SAMPLE_MS と WINDOW_MS を同じ倍率で縮める。
//
// 置換元の文字列が見つからなければ即座に落とす。アプリ側を変更したらここも直す必要が
// あることに、テストが通らなくなることで気づける。

import fs from "fs";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(here, "..", "smile-watch.html");

export const SPEED = 12;                       // 12 倍速
export const SAMPLE_MS = 17;                   // rAF の周期を下回らない範囲で最小
export const WINDOW_MS = SAMPLE_MS * 300;      // 実機と同じ 1 窓 300 サンプル
export const COLUMN_MS = Math.round(1000 / SPEED);
export const WARMUP_MS = Math.round(30_000 / SPEED);
export const DURATION_SCALE = COLUMN_MS;       // 判定時間 30 秒 → 30 * COLUMN_MS
export const RETENTION_DAYS = 30;              // アプリ側の保存期間と合わせる
export const COOLDOWN_MS = Math.round(300_000 / SPEED);

export function buildPage(){
  let html = fs.readFileSync(appPath, "utf8");

  const swap = (from, to) => {
    if(!html.includes(from)) throw new Error(`置換元が見つかりません: ${from}`);
    html = html.replace(from, to);
  };

  swap(
    'await import(local ? url(local.bundle) : CDN.bundle)',
    'await import("./stub-vision.mjs")'
  );
  // フォントは取りに行かせない（テストを外部に依存させない）
  swap("loadFonts();", "/* テストではフォントを読み込まない */");
  swap("const SAMPLE_MS   = 200;",      `const SAMPLE_MS   = ${SAMPLE_MS};`);
  swap("const WINDOW_MS   = 60_000;",   `const WINDOW_MS   = ${WINDOW_MS};`);
  swap("const WARMUP_MS   = 30_000;",   `const WARMUP_MS   = ${WARMUP_MS};`);
  swap("const MIN_FACE_MS = 12_000;",   `const MIN_FACE_MS = ${Math.round(12_000 / SPEED)};`);
  swap("const ABSENT_MS   = 10_000;",   `const ABSENT_MS   = ${Math.round(10_000 / SPEED)};`);
  swap("const COOLDOWN_MS = 300_000;",  `const COOLDOWN_MS = ${COOLDOWN_MS};`);
  swap("now - lastColumn >= 1000",      `now - lastColumn >= ${COLUMN_MS}`);
  swap("Number(durationInput.value) * 1000", `Number(durationInput.value) * ${DURATION_SCALE}`);
  swap("setTimeout(hideCheer, 20_000)", `setTimeout(hideCheer, ${Math.round(20_000 / SPEED)})`);

  // テスト用フック。保存の状態と、古い記録を仕込む手段を外に出す。
  swap('window.addEventListener("pagehide"', [
    "window.__test = {",
    "  dbAvailable: () => Boolean(db),",
    "  pending: () => pendingRows.length,",
    "  stored: () => ({ ...stored }),",
    "  total: () => totalRows(),",
    "  session: () => sessionNo,",
    "  flush: () => flush(),",
    "  wakeMessages: () => MESSAGES.wake.slice(),",
    "  // 保存済みと書き込み待ちを合わせたイベント",
    "  allEvents: () => readSince('events', null).then(rows => rows.concat(pendingEvents)),",
    "  // 覚醒スコアがしきい値を下回り続けている開始時刻。基準の取り直しで null に戻るはず",
    "  lowSinceWake: () => lowSince.wake,",
    "  review: () => ({",
    "    day: charts.day.items.map(x => ({ ...x })),",
    "    hour: charts.hour.items.map(x => ({ ...x }))",
    "  }),",
    "  settings: () => ({ smile:smileThreshold.value, wake:wakeThreshold.value, duration:durationInput.value }),",
    "  wakeScoreFor: m => wakeScore(m),",
    "  usesPerclos: m => usesPerclos(m),",
    "  showCheer: kind => showCheer(kind, performance.now()),",
    "  report: level => report(level),",
    "  reports: () => readReports(),",
    "  correlation: (xs, ys) => correlation(xs, ys),",
    "  savedSettings: () => metaGet('settings', null),",
    "  describeAgreement: rows => describeAgreement(rows),",
    "  // 指定した日・時間帯に、値の入った行を仕込む。集計の確認に使う",
    "  seedAt(daysAgo, hour, count, wake, smile, face = true){",
    "    if(!db) return Promise.resolve(0);",
    "    const at = new Date(Date.now() - daysAgo * 86400000);",
    "    at.setHours(hour, 0, 0, 0);",
    "    const t = db.transaction(['samples'], 'readwrite');",
    "    for(let i = 0; i < count; i++){",
    "      t.objectStore('samples').add({ session:0, epochMs:at.getTime() + i * 1000, elapsed:i,",
    "        face, smile, smileAvg:smile, wake, perclos:0.05, fluct:0.02, asym:0.02, eyeOpen:0.9 });",
    "    }",
    "    return settled(t).then(() => refreshStored()).then(() => count);",
    "  },",
    "  // 保存期間より古い行を仕込む。起動時に捨てられることの確認に使う",
    "  seedOld(daysAgo, count){",
    "    if(!db) return Promise.resolve(0);",
    "    const when = Date.now() - daysAgo * 86400000;",
    "    const t = db.transaction(['samples','events'], 'readwrite');",
    "    for(let i = 0; i < count; i++){",
    "      t.objectStore('samples').add({ session:0, epochMs:when + i, elapsed:i, face:false,",
    "        smile:null, smileAvg:null, wake:null, perclos:null, fluct:null, asym:null, eyeOpen:null });",
    "    }",
    "    t.objectStore('events').add({ epochMs:when, type:'start', session:0 });",
    "    return settled(t).then(() => refreshStored()).then(() => { updateRecordUi(); return count; });",
    "  }",
    "};",
    'window.addEventListener("pagehide"'
  ].join("\n"));

  return html;
}

export async function serve(port){
  const page = buildPage();
  const stub = fs.readFileSync(path.join(here, "stub-vision.mjs"));

  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    if(url === "/" || url === "/index.html"){
      res.writeHead(200, { "content-type":"text/html; charset=utf-8" });
      return res.end(page);
    }
    if(url === "/stub-vision.mjs"){
      res.writeHead(200, { "content-type":"text/javascript; charset=utf-8" });
      return res.end(stub);
    }
    res.writeHead(404);
    res.end();
  });

  await new Promise(resolve => server.listen(port, resolve));
  return server;
}
