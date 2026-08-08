// 書き出した JSON の自己申告から、覚醒スコアの重みと幅を見直す。
//
//   node tools/calibrate.mjs smile-watch-20260810-093000.json [...]
//
// 覚醒スコアの SPAN と WEIGHT は、実際の眠気と対応づけずに置いた値でしかない。
// アプリの「いまの調子」で申告した記録には、そのときの生の指標と基準が入っているので、
// 「どの値なら体感といちばん揃うか」を総当たりで探せる。
//
// 出すのは提案までで、書き換えはしない。数が少ないうちは提案そのものが当てにならないため、
// 何件あるか・どれくらい改善するのかを添えて、採否は人が決められるようにする。

import fs from "fs";

/* アプリ側の現在値。smile-watch.html と揃える */
export const CURRENT = {
  span:   { perclos:0.35, fluct:0.14, asym:0.12 },
  weight: { perclos:0.5,  fluct:0.3,  asym:0.2  },
  wakeThreshold: 45
};

const KEYS = ["perclos", "fluct", "asym"];
const MIN_REPORTS = 12;      // これを下回るなら提案しない
const MIN_PER_LEVEL = 3;     // どの申告も最低これだけ欲しい
const LOW_RATE_HZ = 2.5;     // これ未満は PERCLOS が当てにならないので除く
const MIN_GAIN = 0.05;       // これ未満の改善なら、いまの設定のままにする

/* ---------- スコアの再現 ---------- */
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export function penalty(value, base, span){
  if(typeof value !== "number" || typeof base !== "number") return null;
  return clamp((value - base) / span, 0, 1);
}

export function scoreOf(report, span, weight){
  let total = 0, sum = 0;
  for(const key of KEYS){
    const p = penalty(report[key], report.baseline?.[key], span[key]);
    if(p === null) continue;
    total += weight[key] * p;
    sum   += weight[key];
  }
  if(sum === 0) return null;
  return 100 * (1 - total / sum);
}

export function correlation(xs, ys){
  const n = xs.length;
  if(n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for(let i = 0; i < n; i++){
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  const denom = Math.sqrt(sxx * syy);
  return denom === 0 ? null : sxy / denom;
}

function fitness(reports, span, weight){
  const scores = reports.map(r => scoreOf(r, span, weight));
  if(scores.some(s => s === null)) return null;
  return correlation(reports.map(r => r.subjective), scores);
}

/* ---------- 探索 ---------- */
function range(from, to, step){
  const out = [];
  for(let v = from; v <= to + 1e-9; v += step) out.push(Number(v.toFixed(4)));
  return out;
}

// 3 つの重みの組み合わせ。合計 1、いずれも 0 より大きい
function weightGrid(step){
  const out = [];
  for(let a = step; a < 1; a += step){
    for(let b = step; b < 1 - a + 1e-9; b += step){
      const c = 1 - a - b;
      if(c < step - 1e-9) continue;
      out.push({ perclos:Number(a.toFixed(3)), fluct:Number(b.toFixed(3)), asym:Number(c.toFixed(3)) });
    }
  }
  return out;
}

function search(reports, spans, weights){
  let best = null;
  for(const perclos of spans.perclos){
    for(const fluct of spans.fluct){
      for(const asym of spans.asym){
        const span = { perclos, fluct, asym };
        for(const weight of weights){
          const r = fitness(reports, span, weight);
          if(r === null) continue;
          if(!best || r > best.correlation) best = { span, weight, correlation:r };
        }
      }
    }
  }
  return best;
}

export function fit(reports){
  const usable = reports.filter(r =>
    typeof r.subjective === "number" &&
    r.baseline &&
    KEYS.every(k => typeof r[k] === "number" && typeof r.baseline[k] === "number") &&
    (typeof r.hz !== "number" || r.hz >= LOW_RATE_HZ)
  );

  const levels = new Map();
  for(const r of usable) levels.set(r.subjective, (levels.get(r.subjective) ?? 0) + 1);
  const thin = [...levels.values()].some(n => n < MIN_PER_LEVEL) || levels.size < 3;

  const result = {
    total: reports.length,
    usable: usable.length,
    dropped: reports.length - usable.length,
    perLevel: Object.fromEntries([...levels].sort((a, b) => a[0] - b[0])),
    enough: usable.length >= MIN_REPORTS && !thin,
    current: null,
    best: null,
    perIndicator: {},
    threshold: null,
    gain: null,
    adopt: false
  };
  if(!usable.length) return result;

  result.current = fitness(usable, CURRENT.span, CURRENT.weight);

  // どの指標が単独で効いているか。基準からの離れ方をそのまま使う
  for(const key of KEYS){
    result.perIndicator[key] = correlation(
      usable.map(r => r.subjective),
      usable.map(r => r[key] - r.baseline[key])
    );
  }
  if(!result.enough) return result;

  // 粗く探してから、その周りを細かく見る
  const coarse = search(usable, {
    perclos: range(0.15, 0.50, 0.05),
    fluct:   range(0.06, 0.20, 0.02),
    asym:    range(0.05, 0.18, 0.02)
  }, weightGrid(0.1));
  if(!coarse) return result;

  const around = (v, step, span) => range(Math.max(step, v - span), v + span, step);
  result.best = search(usable, {
    perclos: around(coarse.span.perclos, 0.01, 0.04),
    fluct:   around(coarse.span.fluct,   0.005, 0.02),
    asym:    around(coarse.span.asym,    0.005, 0.02)
  }, weightGrid(0.05)) ?? coarse;

  // 差が小さいときは「変えなくてよい」と言う。それならしきい値も今の設定で出さないと、
  // 採らない設定を前提にした助言になってしまう。
  result.gain = result.best.correlation - (result.current ?? 0);
  result.adopt = result.gain >= MIN_GAIN;
  const chosen = result.adopt
    ? { span:result.best.span, weight:result.best.weight }
    : { span:CURRENT.span,     weight:CURRENT.weight };
  result.threshold = bestThreshold(usable, chosen.span, chosen.weight);
  return result;
}

/* 「眠い」をいちばんよく切り分けるしきい値。感度と特異度の和が最大になる点 */
export function bestThreshold(reports, span, weight){
  const rows = reports.map(r => ({ sleepy:r.subjective === 0, score:scoreOf(r, span, weight) }))
    .filter(r => r.score !== null);
  const sleepy = rows.filter(r => r.sleepy).length;
  const awake  = rows.length - sleepy;
  if(!sleepy || !awake) return null;

  const scored = [];
  for(let t = 5; t <= 95; t++){
    const hit  = rows.filter(r => r.sleepy && r.score < t).length / sleepy;
    const miss = rows.filter(r => !r.sleepy && r.score < t).length / awake;
    scored.push({ value:t, sensitivity:hit, falseAlarm:miss, j:hit - miss });
  }

  // きれいに分かれていると、同じ成績のしきい値が幅を持って並ぶ。その端を選ぶと
  // 少しのばらつきで成績が崩れるので、真ん中を採る。
  const top = Math.max(...scored.map(s => s.j));
  const ties = scored.filter(s => s.j >= top - 1e-9);
  return ties[Math.floor((ties.length - 1) / 2)];
}

/* ---------- 入出力 ---------- */
export function readReports(paths){
  const out = [];
  for(const path of paths){
    const data = JSON.parse(fs.readFileSync(path, "utf8"));
    for(const e of data.events ?? []){
      if(e.type === "report" && typeof e.wake === "number") out.push(e);
    }
  }
  return out;
}

function pct(v){ return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`; }
function num(v){ return v === null || v === undefined ? "—" : v.toFixed(2); }

export function describe(result){
  const lines = [];
  const names = { perclos:"PERCLOS", fluct:"開瞼ゆらぎ", asym:"左右差" };
  const levelName = { 0:"眠い", 50:"ふつう", 100:"冴えてる" };

  lines.push(`申告 ${result.total} 件のうち ${result.usable} 件を使いました` +
    (result.dropped ? `（${result.dropped} 件は指標が欠けているか、サンプリングが粗すぎるため除外）` : "") + "。");
  lines.push("内訳: " + (Object.entries(result.perLevel).map(([k, n]) => `${levelName[k] ?? k} ${n}件`).join(" / ") || "なし"));
  lines.push("");

  if(!result.usable){
    lines.push("使える申告がありません。アプリの「いまの調子」を押してから書き出してください。");
    return lines.join("\n");
  }

  lines.push(`いまの設定での相関: ${num(result.current)}`);
  lines.push("指標ごとの相関（単独で体感とどれだけ揃うか）:");
  for(const key of KEYS) lines.push(`  ${names[key].padEnd(6)} ${num(result.perIndicator[key])}`);
  lines.push("");

  if(!result.enough){
    lines.push(`まだ提案しません。${MIN_REPORTS} 件以上、かつどの申告も ${MIN_PER_LEVEL} 件以上あると出します。`);
    return lines.join("\n");
  }

  lines.push(`探索の結果、相関は ${num(result.current)} → ${num(result.best.correlation)}（${result.gain >= 0 ? "+" : ""}${result.gain.toFixed(2)}）`);
  lines.push("");

  if(!result.adopt){
    lines.push("いまの設定から変えるほどの差は出ませんでした。そのままで良さそうです。");
  }else{
    lines.push("smile-watch.html の該当行を、次の値に差し替えると体感に近づきます。");
    lines.push("");
    lines.push(`const SPAN = { perclos:${result.best.span.perclos}, fluct:${result.best.span.fluct}, asym:${result.best.span.asym} };`);
    lines.push(`const WEIGHT = { perclos:${result.best.weight.perclos}, fluct:${result.best.weight.fluct}, asym:${result.best.weight.asym} };`);
  }

  if(result.threshold){
    lines.push("");
    const basis = result.adopt ? "上の新しい設定で" : `いまの設定（${CURRENT.wakeThreshold}）のままなら`;
    lines.push(`${basis}、覚醒しきい値は ${result.threshold.value} あたりが「眠い」をいちばんよく拾います。` +
      `眠いときに出る割合 ${pct(result.threshold.sensitivity)}、眠くないのに出る割合 ${pct(result.threshold.falseAlarm)}。`);
  }

  lines.push("");
  lines.push("注意: これは手元の申告に合わせ込んだ値です。申告が少ないうちは、たまたま合っただけの");
  lines.push("値を選んでいる可能性があります。しばらく使って件数が増えたら、もう一度かけてください。");
  return lines.join("\n");
}

/* ---------- CLI ---------- */
if(import.meta.url === `file://${process.argv[1]}`){
  const paths = process.argv.slice(2);
  if(!paths.length){
    console.error("使い方: node tools/calibrate.mjs <書き出した JSON> [...]");
    process.exit(1);
  }
  try{
    console.log(describe(fit(readReports(paths))));
  }catch(err){
    console.error(`読み込めませんでした: ${err.message}`);
    process.exit(1);
  }
}
