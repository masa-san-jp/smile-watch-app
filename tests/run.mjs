// 笑顔ウォッチの回帰テスト。
//
//   node tests/run.mjs
//
// MediaPipe をスタブに差し替えたページを Chromium で動かし、覚醒スコアの算出・基準の
// 取り直し・記録の蓄積と書き出しを通しで確認する。詳しくは tests/README.md を参照。

import fs from "fs";
import { chromium } from "playwright";
import { serve, WARMUP_MS, WINDOW_MS, COLUMN_MS, RETENTION_DAYS, COOLDOWN_MS } from "./harness.mjs";

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

  // 励ましカードは 1.7 秒ほどで自動的に消えるため、出た瞬間の見た目を控えておく
  await page.evaluate(() => {
    window.__cards = [];
    const card = document.getElementById("cheer");
    new MutationObserver(() => {
      if(card.hidden) return;
      window.__cards.push({
        tag: document.getElementById("cheerTag").textContent,
        wake: card.classList.contains("wake")
      });
    }).observe(card, { attributes:true, attributeFilter:["hidden", "class"] });
  });

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
  // カードは一定時間で自動的に消える。表示されている瞬間を狙って調べると取りこぼすので、
  // 出たものは observer に控えておき（見た目の確認用）、回数と間隔はイベント履歴で見る。
  const shown = () => page.evaluate(() => window.__cards.slice());
  const cheers = () => hook(() =>
    window.__test.allEvents().then(list => list.filter(e => e.type === "cheer")));

  async function untilCheers(count, timeoutMs){
    const deadline = Date.now() + timeoutMs;
    for(;;){
      const list = await cheers();
      if(list.length >= count) return list;
      if(Date.now() > deadline) throw new Error(`励ましが ${count} 件に届きませんでした（${list.length} 件）`);
      await wait(200);
    }
  }

  const [firstCheer] = await untilCheers(1, 40_000);
  check("眠気が続くと覚醒の励ましが出る", firstCheer.kind === "wake", firstCheer.kind);
  const firstCard = (await shown())[0];
  check("覚醒カードの見た目が切り替わる",
    firstCard?.tag === "覚醒" && firstCard?.wake === true, JSON.stringify(firstCard));

  await setScenario(SAD);          // 目は覚めているが無表情
  // 2 件目が出るまで待ち、1 件目との間隔でクールダウンを見る。
  // 「一定時間待って出ていないこと」で見ると、待ち始めた時点でクールダウンが
  // どこまで進んでいるかに結果が左右されてしまう。
  const pair = await untilCheers(2, 90_000);
  const gap = pair[1].epochMs - pair[0].epochMs;
  check("次の励ましまでクールダウンぶん間隔が空く", gap >= COOLDOWN_MS - 500, `${gap}ms（下限 ${COOLDOWN_MS}ms）`);
  check("クールダウン明けに笑顔の励ましが出る", pair[1].kind === "smile", pair[1].kind);

  // ここで眠気に戻すと、無表情はすでに継続しているので両方が成立した状態になる。
  // 次にどちらが出るかが、そのまま優先順位の答えになる。
  // 1 件目では笑顔側がまだ継続時間に達しておらず、同着になっていない。
  await setScenario(DROWSY);
  const three = await untilCheers(3, 90_000);
  check("両方が同時に成立していたら覚醒を優先する", three[2].kind === "wake", three[2].kind);
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
    (await hook(() => window.__test.allEvents()
      .then(list => list.filter(e => e.type === "baseline" && e.manual).length))) === 1);

  await setScenario(ALERT);
  await wait(WINDOW_MS);

  /* ===== 5. 保存 ===== */
  section("5. 保存");
  check("この環境で記録を保存できる", await hook(() => window.__test.dbAvailable()));

  // 待ち行列の読み取りと flush の開始を同じ同期ターンで行う。別々の evaluate にすると
  // その間の計測ティックで行が増え、何件が書き込まれたのか合わなくなる。
  // 書き込み中も計測は続くので、終わった時点の待ち行列が 0 とは限らない。
  const flushed = await hook(async () => {
    const before = { pending:window.__test.pending(), stored:window.__test.stored().rows };
    await window.__test.flush();
    return { before, after:{ pending:window.__test.pending(), stored:window.__test.stored().rows } };
  });
  check("書き込み待ちの行がまとめて保存される",
    flushed.before.pending > 0 &&
    flushed.after.stored === flushed.before.stored + flushed.before.pending &&
    flushed.after.pending < flushed.before.pending,
    JSON.stringify(flushed));

  check("件数の表示に期間が入る", /\d+ 件（\d+\/\d+/.test(await text("#logCount")), await text("#logCount"));

  // 再読み込みしても残るか。データが貯まらないと意味がないので、ここが本題
  const beforeReload = await hook(() => ({ rows:window.__test.stored().rows, session:window.__test.session() }));
  await page.reload();
  await page.waitForFunction(() => window.__test && window.__test.total() > 0, null, { timeout:20_000 });
  const afterReload = await hook(() => ({ rows:window.__test.stored().rows, session:window.__test.session() }));
  check("再読み込みしても記録が残る", afterReload.rows === beforeReload.rows,
    `${beforeReload.rows} → ${afterReload.rows}`);
  check("セッション番号が再読み込みをまたいで続く", afterReload.session === beforeReload.session,
    `${beforeReload.session} → ${afterReload.session}`);

  // 保存期間より古い行は起動時に捨てられる
  const seeded = await hook(days => window.__test.seedOld(days, 5), RETENTION_DAYS + 5);
  const withOld = await hook(() => window.__test.stored().rows);
  check("古い行を仕込めた", seeded === 5 && withOld === afterReload.rows + 5, `${withOld}`);
  await page.reload();
  await page.waitForFunction(() => window.__test && window.__test.total() > 0, null, { timeout:20_000 });
  check("保存期間より古い記録は起動時に捨てられる",
    (await hook(() => window.__test.stored().rows)) === afterReload.rows,
    `${withOld} → ${await hook(() => window.__test.stored().rows)}`);

  // 計測を再開して以降の検証に使うデータを足す
  await setScenario(ALERT);
  await page.selectOption("#duration", "30");
  await page.click("#toggleBtn");
  await page.waitForFunction(
    () => document.getElementById("statusText").textContent === "見守り中",
    null, { timeout:20_000 }
  );
  await wait(WARMUP_MS + WINDOW_MS);

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
  check("CSV の時刻が YYYY-MM-DD HH:MM:SS 形式",
    /^\d+,\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},/.test(lines[1]), lines[1]);

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
  check("再読み込み前に記録した行も書き出される",
    new Set(json.samples.map(s => s.session)).size >= 2,
    [...new Set(json.samples.map(s => s.session))].join(","));

  // 書き出す範囲。すべて今日のデータだと差が出ないので、2 日前の行を仕込んでから比べる
  const midnight = new Date(); midnight.setHours(0, 0, 0, 0);
  await hook(() => window.__test.seedOld(2, 3));
  const allJson = JSON.parse(await download("#jsonBtn"));
  const older = allJson.samples.filter(s => s.epochMs < midnight.getTime());
  check("「すべて」には前の日の記録も入る", older.length === 3, `${older.length} 件`);

  await page.selectOption("#exportRange", "today");
  const todayJson = JSON.parse(await download("#jsonBtn"));
  // 2 回の書き出しの間にも計測は進むので、件数の引き算では比べられない。
  // 「当日より前の行が 1 件も入っていない」ことを見る。
  const leaked = todayJson.samples.filter(s => s.epochMs < midnight.getTime());
  check("「今日」を選ぶと当日ぶんだけになる",
    todayJson.samples.length > 0 && leaked.length === 0,
    `${todayJson.samples.length} 件中、当日より前が ${leaked.length} 件`);
  check("書き出した範囲が JSON に残る", todayJson.range === "今日", todayJson.range);
  await page.selectOption("#exportRange", "all");

  /* ===== 7. 記録の消去とセッション境界 ===== */
  section("7. 記録の消去とセッション境界");
  await page.click("#clearBtn");
  await page.waitForFunction(() => window.__test.stored().rows === 0, null, { timeout:10_000 });
  check("消去すると保存済みの記録も消える",
    (await hook(() => window.__test.stored().rows)) === 0);
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

  /* ===== 10. 同梱アセットの選択 ===== */
  section("10. 同梱アセットの選択");
  check("同梱が無ければ CDN を使うと明示する",
    (await text("#note")).includes("CDN"), await text("#note"));

  // vendor/manifest.json があるように見せかけ、そちらを選ぶか確かめる
  await page.route("**/vendor/manifest.json", route => route.fulfill({
    status:200,
    contentType:"application/json",
    body:JSON.stringify({ bundle:"vendor/vision_bundle.mjs", wasm:"vendor/wasm", model:"vendor/face_landmarker.task" })
  }));
  // 一度読み込んだモデルは使い回すので、選び直させるにはページごと読み込み直す
  await page.reload();
  await setScenario(ALERT);
  await page.click("#toggleBtn");
  await page.waitForFunction(
    () => document.getElementById("statusText").textContent === "見守り中",
    null, { timeout:20_000 }
  );
  check("同梱があればそちらを使い、通信しないと明示する",
    (await text("#note")).includes("外部との通信はありません"), await text("#note"));
  await page.unroute("**/vendor/manifest.json");

  /* ===== 仕上げ ===== */
  section("11. 実行時エラー");
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
