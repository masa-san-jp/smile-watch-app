// MediaPipe Tasks Vision の FaceLandmarker を差し替えるテスト用スタブ。
//
// 本物はカメラ映像から blendshape を推定するが、テストでは「どんな顔が写っているか」を
// こちらから決めたい。window.__scenario に置いた値からブレンドシェイプを組み立てて返す。
//
// scenario の形:
//   { face:false }                                    顔を検出できない状態
//   { face:true, open, jitter, asym,
//     blinkEvery, blinkLen, smile }                   顔を検出できる状態
//
//   open        平常時の開瞼度 0..1（1=全開）
//   jitter      開瞼度のゆらぎ幅。眠いほど大きくする
//   asym        左右の開瞼度の差。眠いほど大きくする
//   blinkEvery  何フレームおきにまばたきするか
//   blinkLen    まばたき 1 回あたりのフレーム数。眠いほど長くする
//   smile       笑顔スコア 0..100

export class FilesetResolver {
  static async forVisionTasks(){ return {}; }
}

export class FaceLandmarker {
  static async createFromOptions(){ return new FaceLandmarker(); }

  detectForVideo(){
    const s = window.__scenario;
    if(!s || s.face === false) return { faceBlendshapes: [] };

    const n = window.__frame = (window.__frame || 0) + 1;
    const blinking = (n % s.blinkEvery) < s.blinkLen;
    // 乱数を使うと再現しないので、周期の異なる 2 つの正弦波でゆらぎを作る
    const wobble = (Math.sin(n * 1.7) * 0.5 + Math.sin(n * 0.31) * 0.5) * s.jitter;
    const open = blinking ? 0.03 : clamp(s.open + wobble);
    const left  = clamp(open + s.asym / 2);
    const right = clamp(open - s.asym / 2);

    return { faceBlendshapes: [{ categories: [
      { categoryName:"mouthSmileLeft",  score: s.smile / 100 },
      { categoryName:"mouthSmileRight", score: s.smile / 100 },
      // アプリ側は 1 - eyeBlink で開瞼度を作るので、ここでは逆に入れる
      { categoryName:"eyeBlinkLeft",    score: 1 - left },
      { categoryName:"eyeBlinkRight",   score: 1 - right }
    ]}]};
  }
}

function clamp(v){ return v < 0 ? 0 : v > 1 ? 1 : v; }
