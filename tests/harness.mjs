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

export function buildPage(){
  let html = fs.readFileSync(appPath, "utf8");

  const swap = (from, to) => {
    if(!html.includes(from)) throw new Error(`置換元が見つかりません: ${from}`);
    html = html.replace(from, to);
  };

  swap(
    'import { FaceLandmarker, FilesetResolver } from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs";',
    'import { FaceLandmarker, FilesetResolver } from "./stub-vision.mjs";'
  );
  swap("const SAMPLE_MS   = 200;",      `const SAMPLE_MS   = ${SAMPLE_MS};`);
  swap("const WINDOW_MS   = 60_000;",   `const WINDOW_MS   = ${WINDOW_MS};`);
  swap("const WARMUP_MS   = 30_000;",   `const WARMUP_MS   = ${WARMUP_MS};`);
  swap("const ABSENT_MS   = 10_000;",   `const ABSENT_MS   = ${Math.round(10_000 / SPEED)};`);
  swap("const COOLDOWN_MS = 300_000;",  `const COOLDOWN_MS = ${Math.round(300_000 / SPEED)};`);
  swap("now - lastColumn >= 1000",      `now - lastColumn >= ${COLUMN_MS}`);
  swap("Number(durationInput.value) * 1000", `Number(durationInput.value) * ${DURATION_SCALE}`);
  swap("setTimeout(hideCheer, 20_000)", `setTimeout(hideCheer, ${Math.round(20_000 / SPEED)})`);

  // Web フォントは取りに行かせない
  html = html.replace(/<link href="https:\/\/fonts\.googleapis[^>]*>/, "");

  // テスト用フック。未書き出し判定の中身と、記録上限まで一気に埋める手段を外に出す。
  swap('window.addEventListener("beforeunload", (e) => {', [
    "window.__test = {",
    "  isDirty: () => Boolean((logRows.length || logEvents.length) && revision !== savedRevision),",
    "  fillToMaxRows(){",
    "    const filler = { session:0, epochMs:0, elapsed:0, face:false, smile:null, smileAvg:null,",
    "                     wake:null, perclos:null, fluct:null, asym:null, eyeOpen:null };",
    "    while(logRows.length < MAX_ROWS) logRows.push({ ...filler });",
    "    return logRows.length;",
    "  },",
    "  rowCount: () => logRows.length,",
    "  events: () => logEvents.map(e => ({ ...e })),",
    "  wakeMessages: () => MESSAGES.wake.slice(),",
    "  // 覚醒スコアがしきい値を下回り続けている開始時刻。基準の取り直しで null に戻るはず",
    "  lowSinceWake: () => lowSince.wake",
    "};",
    'window.addEventListener("beforeunload", (e) => {'
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
