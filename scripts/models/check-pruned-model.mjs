// Checks a pruned text model (scripts/models/prune-text-model.py) against the
// original, in Node with transformers.js: English and Chinese text must split
// into the same tokens and get the same embeddings; other scripts are
// reported (they lose their tokens by design).
//
//   node scripts/models/check-pruned-model.mjs MODELS_DIR
// MODELS_DIR holds orig/ and small/ (each with tokenizer.json, config.json,
// onnx/model_quantized.onnx, …).
import { env, pipeline, AutoTokenizer } from '@huggingface/transformers'

const dir = process.argv[2]
env.localModelPath = dir.endsWith('/') ? dir : dir + '/'
env.allowRemoteModels = false

const same = [
  'Quarterly budget review: revenue, costs and the hiring plan for 2026.',
  'rental agreement for the apartment on 5th Avenue (signed 2025-03-14)',
  'beach holiday packing list.txt',
  '会议纪要：讨论了第三季度的预算和招聘计划。',
  '租房合同 —— 甲方与乙方于二〇二五年签订',
  'Meeting notes 会议纪要 Q3 预算 budget',
  'IMG_0042.JPG screenshot of the invoice #A-1093, total $1,250.00',
  'photo of a dog on the beach at sunset',
  'ｆｕｌｌｗｉｄｔｈ ＡＢＣ １２３！',
  'C++ / JavaScript / emails: alice@example.com, https://0g.ai/drive?x=1',
  'café crème brûlée, résumé of José Müller (naïve façade)',
]
const other = ['こんにちは世界', 'Привет мир', '안녕하세요', 'Łódź, Dvořák', 'emoji 🎉🚀']

const tokO = await AutoTokenizer.from_pretrained('orig')
const tokS = await AutoTokenizer.from_pretrained('small')
const embO = await pipeline('feature-extraction', 'orig', { dtype: 'q8' })
const embS = await pipeline('feature-extraction', 'small', { dtype: 'q8' })
const pieces = (tok, t) => tok.tokenize(t)
const cos = (a, b) => {
  let d = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return d / Math.sqrt(na * nb)
}
let failed = 0
for (const t of same) {
  const po = pieces(tokO, t), ps = pieces(tokS, t)
  const a = (await embO(t, { pooling: 'mean', normalize: true })).data
  const b = (await embS(t, { pooling: 'mean', normalize: true })).data
  const c = cos(a, b)
  const ok = JSON.stringify(po) === JSON.stringify(ps) && c > 0.99999
  if (!ok) failed++
  console.log(`${ok ? 'SAME' : 'DIFF'}  cos ${c.toFixed(6)}  ${po.length} tokens  ${t}`)
}
for (const t of other) {
  const a = (await embO(t, { pooling: 'mean', normalize: true })).data
  const b = (await embS(t, { pooling: 'mean', normalize: true })).data
  console.log(`other cos ${cos(a, b).toFixed(3)}  ${pieces(tokS, t).join(' ')}  ← ${t}`)
}
console.log(failed ? `${failed} English/Chinese texts differ` : `all ${same.length} English/Chinese texts: same tokens, same embeddings`)
process.exit(failed ? 1 : 0)
