// 笑顔ウォッチの回帰テスト。
//
//   node tests/run.mjs
//
// MediaPipe をスタブに差し替えたページを Chromium で動かし、覚醒スコアの算出・基準の
// 取り直し・記録の蓄積と書き出しを通しで確認する。詳しくは tests/README.md を参照。

import fs from "fs";
import { chromium } from "playwright";
import { serve, WARMUP_MS, WINDOW_MS, COLUMN_MS } from "./harness.mjs";

const PORT = 8123;

/* ---------- シナリオ ---------- */
const ALERT  = { face:true, open:0.95, jitter:0.02, asym:0.015, blinkEvery:33, blinkLen:1, smile:45 };
const DROWSY = { face:true, open:0.60, jitter:0.22, asym:0.140, blinkEvery:11, blinkLen:4, smile:4  };
const SAD    = { face:true, open:0.95, jitter:0.02, asym:0.015, blinkEvery:33, blinkLen:1, smile:3  };
const ABSENT = { face:false };

/* ---------- 結果 ---------- */
let passed = 0;
const failures = [];

function check(label, condition, detail){
  if(condition){
    passed++;
    console.log(`  [32m✓[0m ${label}`);
  }else{
    failures.push(label);
    console.log(`  [31m✗[0m ${label}${detail === undefined ? "" : `  — ${detail}`}`);
  }
}

function section(title){ console.log(`\n${title}`); }

/* ---------- 本体 ---------- */
const server = await serve(PORT);
const browser = await chromium.launch({
  args:["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
});
const context = await browser.newContext({ permissions:["camera"], acceptDownloads:true });
const page = await context.newPage();

const pageErrors = [];
page.on("pageerror", e => pageErrors.push(e.message));
page.on("console", m => {
  const text = m.text();
  if(m.type() === "error" && !text.includes("favicon") && !text.includes("404")) pageErrors.push(text);
});
page.on("dialog", d => d.accept());

const wait   = ms => page.waitForTimeout(ms);
const setScenario = s => page.evaluate(o => { window.__scenario = o; }, s);
const text   = sel => page.textContent(sel);
const num    = async sel => Number(await text(sel));
const hook   = (fn, ...args) => page.evaluate(fn, ...args);
const cardVisible = () => page.evaluate(() => !document.getElementById("cheer").hidden);
const hideCard    = () => page.evaluate(() => { document.getElementById("cheer").hidden = true; });

async function download(selector){
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click(selector)]);
  return fs.readFileSync(await dl.path(), "utf8");
}

try{
  await page.goto(`http://localhost:${PORT}/`);
  await page.selectOption("#duration", "30");
  await setScenario(ALERT);
  await page.click("#toggleBtn");
  await page.waitForFunction(
    () => document.getElementById("statusText").textContent === "見守り中",
    null, { timeout:20_000 }
  );

  /* ===== 1. 覚醒指標 ===== */
  section("1. 覚醒指標");
  await wait(WARMUP_MS + WINDOW_MS);

  const awake = {
    wake: await num("#wakeValue"),
    perclos: await text("#perclosOut"),
    fluct: await text("#fluctOut"),
    asym: await text("#asymOut")
  };
  check("覚醒時のスコアが 90 以上", awake.wake >= 90, `実測 ${awake.wake}`);
  check("PERCLOS / ゆらぎ / 左右差 に数値が出る",
    !/^--/.test(awake.perclos) && !/^--/.test(awake.fluct) && !/^--/.test(awake.asym),
    JSON.stringify(awake));
  check("ウォームアップ後に基準が自動で取られる",
    !(await text("#fluctBase")).includes("--"), await text("#fluctBase"));

  await setScenario(DROWSY);
  await wait(WINDOW_MS + 1_500);
  const drowsy = {
    wake: await num("#wakeValue"),
    perclos: parseFloat(await text("#perclosOut")),
    fluct: parseFloat(await text("#fluctOut")),
    asym: parseFloat(await text("#asymOut"))
  };
  check("眠気シナリオでスコアが 45 未満に落ちる", drowsy.wake < 45, `実測 ${drowsy.wake}`);
  check("PERCLOS が覚醒時より上がる", drowsy.perclos > parseFloat(awake.perclos),
    `${awake.perclos} → ${drowsy.perclos}%`);
  check("開瞼ゆらぎが覚醒時より上がる", drowsy.fluct > parseFloat(awake.fluct),
    `${awake.fluct} → ${drowsy.fluct}`);
  check("左右差が覚醒時より上がる", drowsy.asym > parseFloat(awake.asym),
    `${awake.asym} → ${drowsy.asym}`);

  /* ===== 2. 励ましの優先順位とクールダウン ===== */
  section("2. 励ましの優先順位とクールダウン");
  // 眠気と無表情が同時に成立している。眠気が優先されるはず
  await page.waitForFunction(() => !document.getElementById("cheer").hidden,
    null, { timeout:20_000 }).catch(() => {});
  const tag = await text("#cheerTag");
  check("眠気と無表情が重なったら覚醒を優先する", tag === "覚醒", `タグ=${tag}`);
  check("覚醒カードの見た目が切り替わる",
    await page.evaluate(() => document.getElementById("cheer").classList.contains("wake")));

  await hideCard();
  await setScenario(SAD);          // 目は覚めているが無表情
  await wait(COLUMN_MS * 60);
  check("クールダウン中は次の励ましを出さない", !(await cardVisible()));

  await page.waitForFunction(() => !document.getElementById("cheer").hidden,
    null, { timeout:60_000 }).catch(() => {});
  check("クールダウン明けに笑顔の励ましが出る", (await text("#cheerTag")) === "笑顔",
    `タグ=${await text("#cheerTag")}`);
  await hideCard();

  /* ===== 3. 不在と復帰 ===== */
  section("3. 不在と復帰");
  await setScenario(ABSENT);
  await wait(COLUMN_MS * 20);
  check("顔を見失うと一時停止になる",
    (await text("#statusText")).includes("一時停止"), await text("#statusText"));

  await setScenario(ALERT);
  await wait(WINDOW_MS + 1_500);
  check("復帰すると覚醒スコアが戻る", (await num("#wakeValue")) >= 90, await text("#wakeValue"));

  /* ===== 4. 再キャリブレーション ===== */
  section("4. 再キャリブレーション");
  await setScenario(DROWSY);
  // 覚醒スコアがしきい値を割り、継続時間の計測が始まるまで待つ
  await page.waitForFunction(() => window.__test.lowSinceWake() !== null,
    null, { timeout:30_000 });
  const beforeCal = await num("#wakeValue");

  // クリックと同じ同期ターンの中で前後を見る。次の計測ティックまで待つと、判定側が
  // 「スコアがしきい値を超えた」として lowSince.wake を消してしまい、calibrate() が
  // リセットしているのかどうかを区別できなくなる。
  const reset = await hook(() => {
    const before = window.__test.lowSinceWake();
    document.getElementById("calibrateBtn").click();
    return { before, after: window.__test.lowSinceWake() };
  });
  check("継続時間の計測が始まっている", reset.before !== null);
  check("基準の取り直しで覚醒の継続計測がリセットされる", reset.after === null,
    `${reset.before} → ${reset.after}`);

  await wait(COLUMN_MS * 2);
  check("いまの状態を基準にするとスコアが戻る", (await num("#wakeValue")) >= 90,
    `${beforeCal} → ${await text("#wakeValue")}`);
  check("取り直した基準が画面に反映される",
    !(await text("#fluctBase")).includes("--"), await text("#fluctBase"));
  check("基準の取得がイベントとして残る",
    (await hook(() => window.__test.events().filter(e => e.type === "baseline" && e.manual))).length === 1);

  await setScenario(ALERT);
  await wait(WINDOW_MS);

  /* ===== 5. 未書き出しの検知 ===== */
  section("5. 未書き出しの検知");
  check("記録がたまると未書き出しになる", await hook(() => window.__test.isDirty()));

  // クリックと同じ同期ターンの中で見る。await を挟むと rAF が回り、正当に 1 行増えてしまう
  check("CSV を書き出すと解消する",
    await hook(() => { document.getElementById("csvBtn").click(); return !window.__test.isDirty(); }));
  await wait(COLUMN_MS * 2);
  check("書き出した後に行が増えると再び未書き出しになる", await hook(() => window.__test.isDirty()));

  check("JSON を書き出すと解消する",
    await hook(() => { document.getElementById("jsonBtn").click(); return !window.__test.isDirty(); }));

  // 行数の変わらないイベントだけでも検知できるか。
  // 書き出し→行数の記録→イベント追加→判定 をすべて同じ同期ターンで行う。
  // 間に await を挟むと計測ティックが行を足してしまい、何を検知したのか分からなくなる。
  const eventOnly = await hook(() => {
    document.getElementById("jsonBtn").click();        // いったん解消させる
    const rows = window.__test.rowCount();
    document.getElementById("calibrateBtn").click();   // 行を増やさずイベントだけ足す
    return { dirty:window.__test.isDirty(), rowsUnchanged:window.__test.rowCount() === rows, rows };
  });
  check("イベントだけが増えた場合も検知する",
    eventOnly.dirty && eventOnly.rowsUnchanged, JSON.stringify(eventOnly));

  // 上限に達すると古い行が捨てられ、件数が動かなくなる
  await hook(() => { document.getElementById("jsonBtn").click(); });
  const capped = await hook(() => window.__test.fillToMaxRows());
  await hook(() => { document.getElementById("jsonBtn").click(); });
  await wait(COLUMN_MS * 3);
  check("記録上限に達した後も、件数が動かないまま検知する",
    (await hook(() => window.__test.isDirty())) &&
    (await hook(() => window.__test.rowCount())) === capped,
    `上限 ${capped} 行`);

  /* ===== 6. CSV / JSON の書き出し ===== */
  section("6. CSV / JSON の書き出し");
  const csv = await download("#csvBtn");
  check("CSV が UTF-8 BOM で始まる", csv.charCodeAt(0) === 0xFEFF);
  const lines = csv.replace(/^﻿/, "").trimEnd().split("\r\n");
  check("CSV が CRLF 区切り", csv.includes("\r\n"));
  check("CSV の見出しが期待どおり",
    lines[0] === "セッション,記録時刻,経過秒,顔検出,笑顔スコア,笑顔スコア_1分平均,覚醒スコア,PERCLOS,開瞼ゆらぎ,左右差,平均開瞼度",
    lines[0]);
  const widths = new Set(lines.map(l => l.split(",").length));
  check("CSV の全行が 11 列", widths.size === 1 && widths.has(11), [...widths].join("/"));
  const dataRows = lines.slice(1).filter(l => !l.startsWith("0,"));   // 上限埋め用のダミーを除く
  check("CSV の時刻が YYYY-MM-DD HH:MM:SS 形式",
    /^\d+,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},/.test(dataRows[0]), dataRows[0]);

  const json = JSON.parse(await download("#jsonBtn"));
  check("JSON に必要なキーが揃っている",
    ["app","version","exportedAt","settings","fields","events","samples"].every(k => k in json),
    Object.keys(json).join(","));
  check("JSON に設定値と基準が入る",
    json.settings.smileThreshold === 20 && json.settings.wakeThreshold === 45 &&
    json.settings.baseline !== null);
  check("JSON に列の説明が入る", Object.keys(json.fields).length === 11);
  check("JSON にイベント履歴が入る",
    json.events.some(e => e.type === "start") &&
    json.events.some(e => e.type === "baseline") &&
    json.events.some(e => e.type === "cheer"),
    json.events.map(e => e.type).join(","));
  check("覚醒カードと笑顔カードの両方が記録されている",
    ["wake","smile"].every(k => json.events.some(e => e.type === "cheer" && e.kind === k)));
  const scored = json.samples.filter(s => s.wake !== null);
  check("JSON の覚醒スコアが 0–100 の範囲",
    scored.length > 0 && scored.every(s => s.wake >= 0 && s.wake <= 100));
  check("JSON に映像・画像が含まれない", !JSON.stringify(json).includes("data:image"));

  /* ===== 7. 記録の消去とセッション境界 ===== */
  section("7. 記録の消去とセッション境界");
  check("見守り中に消去しても未書き出しは解消される",
    await hook(() => { document.getElementById("clearBtn").click(); return !window.__test.isDirty(); }));
  await wait(COLUMN_MS * 10);
  const afterClear = JSON.parse(await download("#jsonBtn"));
  const clearStart = afterClear.events.filter(e => e.type === "start" && e.afterClear);
  check("消去後に開始イベントが入り直す", clearStart.length === 1,
    afterClear.events.map(e => e.type).join(","));
  const sessionsAfterClear = new Set(afterClear.samples.map(s => s.session));
  const startsAfterClear = new Set(afterClear.events.filter(e => e.type === "start").map(e => e.session));
  check("全セッションに対応する開始イベントがある",
    [...sessionsAfterClear].every(s => startsAfterClear.has(s)),
    `行=${[...sessionsAfterClear]} 開始=${[...startsAfterClear]}`);

  /* ===== 8. 停止と再開 ===== */
  section("8. 停止と再開");
  await page.click("#toggleBtn");
  await wait(COLUMN_MS * 3);
  check("停止するとスコアの表示が戻る",
    (await text("#wakeValue")) === "--" && (await text("#smileValue")) === "--");

  await page.click("#toggleBtn");
  await page.waitForFunction(
    () => document.getElementById("statusText").textContent === "見守り中",
    null, { timeout:20_000 }
  );
  await wait(COLUMN_MS * 12);
  const twoSessions = JSON.parse(await download("#jsonBtn"));
  check("再開するとセッション番号が分かれる",
    new Set(twoSessions.samples.map(s => s.session)).size === 2,
    [...new Set(twoSessions.samples.map(s => s.session))].join(","));
  check("停止がイベントとして残る", twoSessions.events.some(e => e.type === "stop"));

  /* ===== 9. 文面 ===== */
  section("9. 文面");
  const wakeMessages = await hook(() => window.__test.wakeMessages());
  check("覚醒メッセージが 8 種類ある", wakeMessages.length === 8);
  check("効果を断定する文面が残っていない",
    !wakeMessages.some(m => /より効く|引きます|効果があります/.test(m)),
    wakeMessages.filter(m => /より効く|引きます|効果があります/.test(m)).join(" / "));

  /* ===== 仕上げ ===== */
  section("10. 実行時エラー");
  check("JavaScript エラーが出ていない", pageErrors.length === 0, pageErrors.join(" / "));

}finally{
  await browser.close();
  server.close();
}

console.log(`\n${passed} 件成功 / ${failures.length} 件失敗`);
if(failures.length){
  console.log("失敗:\n  " + failures.join("\n  "));
  process.exit(1);
}
