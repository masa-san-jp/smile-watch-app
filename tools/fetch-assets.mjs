// オフラインで動かすための一式を vendor/ に取ってくる。
//
//   npm run fetch-assets
//
// 取ってくるのは MediaPipe の ESM バンドル・WASM・顔ランドマークモデルと、Web フォント。
// 合計 20MB 強あるためリポジトリには入れていない。取得後は smile-watch.html が
// vendor/manifest.json を見つけて自動的にそちらを使い、外部との通信はなくなる。

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.join(here, "..", "vendor");

// MediaPipe 本体は devDependency から複写する。CDN を叩くよりも、テストが使うものと
// 確実に同じ版になる。モデルとフォントだけはパッケージに含まれないので取得する。
const PKG = path.join(here, "..", "node_modules", "@mediapipe", "tasks-vision");
const MODEL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const FONTS_CSS = "https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700&family=Zen+Kaku+Gothic+New:wght@400;500&family=M+PLUS+1+Code:wght@200;400&display=swap";

// woff2 を返してもらうために、それを解する UA を名乗る
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const COPY = [
  "vision_bundle.mjs",
  "wasm/vision_wasm_internal.js",
  "wasm/vision_wasm_internal.wasm",
  // SIMD が使えない環境向け。FilesetResolver がどちらを読むか決める
  "wasm/vision_wasm_nosimd_internal.js",
  "wasm/vision_wasm_nosimd_internal.wasm"
];

let total = 0;

async function get(url, headers = {}){
  const res = await fetch(url, { headers:{ "user-agent":UA, ...headers } });
  if(!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`);
  return res;
}

async function save(relative, data){
  const target = path.join(vendor, relative);
  await fs.mkdir(path.dirname(target), { recursive:true });
  await fs.writeFile(target, data);
  total += data.length;
  console.log(`  ${relative.padEnd(38)} ${(data.length / 1048576).toFixed(2)} MB`);
}

async function fetchFile(url, relative){
  const res = await get(url);
  await save(relative, Buffer.from(await res.arrayBuffer()));
}

// CSS の中の url(...) を落として、参照をローカルへ書き換える
async function fetchFonts(){
  const css = await (await get(FONTS_CSS)).text();
  const urls = [...new Set([...css.matchAll(/url\((https:\/\/[^)]+)\)/g)].map(m => m[1]))];
  let rewritten = css;
  let index = 0;
  for(const url of urls){
    const ext = path.extname(new URL(url).pathname) || ".woff2";
    const name = `fonts/${String(++index).padStart(2, "0")}${ext}`;
    await fetchFile(url, name);
    // fonts.css から見た相対パス。name がそのまま使える
    rewritten = rewritten.split(url).join(name);
  }
  await save("fonts.css", Buffer.from(rewritten, "utf8"));
  return urls.length;
}

async function copyFromPackage(){
  try{
    await fs.access(PKG);
  }catch{
    throw new Error("node_modules/@mediapipe/tasks-vision がありません。先に npm install を実行してください");
  }
  for(const relative of COPY) await save(relative, await fs.readFile(path.join(PKG, relative)));
}

async function main(){
  console.log("MediaPipe を複写します\n");
  await copyFromPackage();

  console.log("\nモデルを取得します\n");
  await fetchFile(MODEL, "face_landmarker.task");

  console.log("\nフォントを取得します\n");
  const fonts = await fetchFonts();

  await save("manifest.json", Buffer.from(JSON.stringify({
    source:"npm @mediapipe/tasks-vision@0.10.14 / mediapipe-models / Google Fonts",
    fetchedAt:new Date().toISOString(),
    bundle:"vendor/vision_bundle.mjs",
    wasm:"vendor/wasm",
    model:"vendor/face_landmarker.task",
    fonts:`vendor/fonts.css (${fonts} ファイル)`
  }, null, 2), "utf8"));

  console.log(`\n完了。合計 ${(total / 1048576).toFixed(1)} MB を vendor/ に置きました。`);
  console.log("以後 smile-watch.html は外部と通信しません。");
}

main().catch(err => {
  console.error(`\n取得に失敗しました: ${err.message}`);
  console.error("vendor/ は中途半端な状態かもしれません。消してからやり直してください。");
  process.exit(1);
});
