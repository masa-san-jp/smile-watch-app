// tools/calibrate.mjs の検証。
//
//   node tests/calibrate.test.mjs
//
// 「答えの分かっている申告」を作り、そこから元の設定を取り戻せるかを見る。
// 実データが無い段階でこの道具を信用するには、これしか確かめようがない。

import { fit, scoreOf, correlation, bestThreshold, describe, CURRENT } from "../tools/calibrate.mjs";

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

// 実行のたびに同じ結果になるよう、乱数は自前で回す
function rng(seed){
  return () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE = { perclos:0.05, fluct:0.015, asym:0.015 };

/* いまの設定でちょうど体感どおりになる申告。変更を勧めてはいけない場合 */
function asIsReports(){
  return makeReports({ n:60, seed:7, spread:0.02 }).map(r => ({
    ...r,
    perclos: BASE.perclos + (1 - r.subjective / 100) * CURRENT.span.perclos,
    fluct:   BASE.fluct   + (1 - r.subjective / 100) * CURRENT.span.fluct,
    asym:    BASE.asym    + (1 - r.subjective / 100) * CURRENT.span.asym
  }));
}

/* 申告レベルに応じて指標を作る。眠いほど基準から離れる */
function makeReports({ n, seed, spread, noisyPerclos = false, hz = 5 }){
  const random = rng(seed);
  const levels = [0, 50, 100];
  const out = [];
  for(let i = 0; i < n; i++){
    const subjective = levels[i % 3];
    const away = (100 - subjective) / 100;          // 眠いほど 1 に近い
    const jitter = () => (random() - 0.5) * spread;
    out.push({
      type:"report",
      subjective,
      wake:0,
      hz,
      baseline:{ ...BASE },
      // 眠いほど大きく離れる。noisyPerclos のときは PERCLOS だけ無関係に振る
      perclos: BASE.perclos + (noisyPerclos ? random() * 0.30 : away * 0.30 + jitter()),
      fluct:   BASE.fluct   + away * 0.12 + jitter() * 0.4,
      asym:    BASE.asym    + away * 0.10 + jitter() * 0.4
    });
  }
  return out;
}

console.log("\ntools/calibrate.mjs");

/* ---------- スコアの再現 ---------- */
const flat = { perclos:BASE.perclos, fluct:BASE.fluct, asym:BASE.asym, baseline:{ ...BASE } };
check("基準どおりならスコアは 100", scoreOf(flat, CURRENT.span, CURRENT.weight) === 100);

const far = { perclos:1, fluct:1, asym:1, baseline:{ ...BASE } };
check("大きく離れればスコアは 0", scoreOf(far, CURRENT.span, CURRENT.weight) === 0);

check("指標が欠けていればスコアを出さない",
  scoreOf({ baseline:{ ...BASE } }, CURRENT.span, CURRENT.weight) === null);

check("片方が一定なら相関は出さない", correlation([1, 2, 3], [5, 5, 5]) === null);

/* ---------- 件数が足りないとき ---------- */
const few = fit(makeReports({ n:6, seed:1, spread:0.02 }));
check("件数が少ないうちは提案しない", few.enough === false && few.best === null,
  JSON.stringify({ usable:few.usable, enough:few.enough }));
check("それでも現状の相関と内訳は出す",
  typeof few.current === "number" && Object.keys(few.perLevel).length === 3);
check("提案しない理由を文章で伝える",
  describe(few).includes("まだ提案しません"));

/* ---------- 素直なデータ ---------- */
const clean = fit(makeReports({ n:60, seed:2, spread:0.02 }));
check("十分な件数なら提案する", clean.enough === true && clean.best !== null);
check("体感とよく揃う設定を見つける", clean.best.correlation > 0.9, `${clean.best?.correlation?.toFixed(3)}`);
check("いまの設定より悪くはならない", clean.best.correlation >= clean.current,
  `${clean.current?.toFixed(3)} → ${clean.best?.correlation?.toFixed(3)}`);
check("重みの合計は 1",
  Math.abs(Object.values(clean.best.weight).reduce((a, b) => a + b, 0) - 1) < 1e-6,
  JSON.stringify(clean.best.weight));
check("しきい値の提案も出す",
  clean.threshold !== null && clean.threshold.value > 0 && clean.threshold.value < 100,
  JSON.stringify(clean.threshold));

/* ---------- 効かない指標を見分けられるか ---------- */
const noisy = fit(makeReports({ n:60, seed:3, spread:0.02, noisyPerclos:true }));
check("効いていない指標は相関が低いと分かる",
  Math.abs(noisy.perIndicator.perclos) < 0.4 &&
  Math.abs(noisy.perIndicator.fluct) > 0.7,
  JSON.stringify({ perclos:noisy.perIndicator.perclos?.toFixed(2), fluct:noisy.perIndicator.fluct?.toFixed(2) }));
check("効いていない指標の重みを下げる",
  noisy.best.weight.perclos < CURRENT.weight.perclos,
  JSON.stringify(noisy.best.weight));

/* ---------- 粗いサンプリングは混ぜない ---------- */
const mixed = [
  ...makeReports({ n:30, seed:4, spread:0.02, hz:5 }),
  ...makeReports({ n:30, seed:5, spread:0.02, hz:1 })   // 裏に回っていたぶん
];
const filtered = fit(mixed);
check("サンプリングが粗い申告は除く", filtered.usable === 30 && filtered.dropped === 30,
  JSON.stringify({ usable:filtered.usable, dropped:filtered.dropped }));

/* ---------- しきい値 ---------- */
// きれいに分かれるデータでは、同じ成績のしきい値が幅を持って並ぶ。端ではなく真ん中を採る
const separable = [
  ...Array.from({ length:6 }, () => ({ subjective:0,   baseline:{ ...BASE }, perclos:1, fluct:1, asym:1 })),
  ...Array.from({ length:6 }, () => ({ subjective:100, baseline:{ ...BASE }, ...BASE }))
];
const mid = bestThreshold(separable, CURRENT.span, CURRENT.weight);
check("分離できるときは、同点のしきい値の真ん中を採る",
  mid.value > 40 && mid.value < 60 && mid.sensitivity === 1 && mid.falseAlarm === 0,
  JSON.stringify(mid));

// 「変えなくてよい」と言うときは、しきい値も今の設定で出す
const noChange = fit(asIsReports());
check("設定を変えないなら、しきい値も今の設定で出す",
  noChange.adopt === false &&
  noChange.threshold.value === bestThreshold(
    asIsReports().filter(r => r.hz >= 2.5), CURRENT.span, CURRENT.weight).value,
  JSON.stringify({ adopt:noChange.adopt, threshold:noChange.threshold?.value }));


const oneSided = makeReports({ n:9, seed:6, spread:0.02 }).map(r => ({ ...r, subjective:50 }));
check("「眠い」が無ければしきい値は出さない",
  bestThreshold(oneSided, CURRENT.span, CURRENT.weight) === null);

check("いまの設定で足りていれば、そう伝える",
  describe(fit(asIsReports())).includes("変えるほどの差は出ませんでした"),
  describe(fit(asIsReports())).split("\n").filter(l => l.includes("相関は")).join(""));

console.log(`\n${passed} 件成功 / ${failures.length} 件失敗`);
if(failures.length){
  console.log("失敗:\n  " + failures.join("\n  "));
  process.exit(1);
}
