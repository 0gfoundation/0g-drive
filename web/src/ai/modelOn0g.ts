// The search text model trimmed to English and Chinese, kept on 0G Storage.
//
// paraphrase-multilingual-MiniLM-L12-v2 with its vocabulary cut from
// 250,002 tokens (~100 languages) to the 116,049 that English, Latin-1
// accented names and Chinese can use (scripts/models/prune-text-model.py):
// the same tokens and embeddings for that text (check-pruned-model.mjs),
// a 67 MB model instead of 118 MB, a 4 MB tokenizer instead of 17 MB, and
// about a third less memory — the full model left phones and wallet apps'
// browsers out of memory. Uploaded with scripts/models/upload-model-to-0g.mjs;
// each file is pinned by root hash and checked against its SHA-256.
//
// transformers.js asks for it under a made-up Hugging Face id; netfetch
// serves those requests from 0G (through the page, which has the storage
// client) instead of the CDN. If 0G can't deliver it, the engine falls back
// to the full model from Hugging Face.
//
// Testnet storage for now; production needs the files on mainnet storage
// (re-run the upload script with NETWORK=mainnet and update this file).

export const SMALL_TEXT_MODEL = '0gdrive/minilm-en-zh'
export const FULL_TEXT_MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2'

export interface FileOn0g {
  root: string
  txSeq: number
  size: number
  sha256: string
}

export const TEXT_MODEL_ON_0G = {
  network: 'testnet' as const,
  /** the upload's transaction (0xba39d058b7bd03b2716e060bf09f50d80aaf641b6bf747c3b5eef93e6ccdcbf0) */
  files: {
    'config.json': { root: '0x7568bc1c86f8d46891429d16a524dfaf25f47dda2d2c803c1b1ba756e34022fe', txSeq: 157341, size: 672, sha256: '2516d41c13a0d11b9aadc2b7bc9c2cfa45f532fb1d1f8d8469256ce10f603e5d' },
    'tokenizer_config.json': { root: '0xa8648d3c8ca96f6f4d30ab0baf336fcb3def580148279d1b0f24713ca5247e90', txSeq: 157342, size: 495, sha256: '213e2fd4a5c51aaa7859702af07af138bec9497a88161520ea3256a4ccb67d29' },
    'special_tokens_map.json': { root: '0x5ccdf83940a66af7fdd74a154cd49161573e5f5740d24ba0fe706aaceff4a7ca', txSeq: 157343, size: 280, sha256: '06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f' },
    'tokenizer.json': { root: '0x8e2259acd0d282e004e04766b9835e13bfad5f230521d3fcb9c93701ac7a9b6f', txSeq: 157344, size: 4087479, sha256: 'c2a9bff9dd01d4e4e8c9e2f2498a5d14399bea818187355e39e76c1b1486e1c3' },
    'onnx/model_quantized.onnx': { root: '0x0341b7364977c8dd5a9d94ed28fda9aa854e25de449dd34bae2c83b12109acb5', txSeq: 157345, size: 66856734, sha256: '6935a26051645b298d0ec162eff06a33f5201cea8a8e4717d2cb428932ef384e' },
  } as Record<string, FileOn0g>,
}

const PATH = /\/0gdrive\/minilm-en-zh\/resolve\/[^/]+\/(.+)$/

/**
 * The 0G file behind a model URL transformers.js asks for: the file, null
 * for a file the model doesn't have (an optional one: answer 404 — the CDN
 * would say "repository not found"), undefined for any other model's URL.
 */
export function fileOn0g(url: URL): FileOn0g | null | undefined {
  const m = PATH.exec(url.pathname)
  return m ? (TEXT_MODEL_ON_0G.files[m[1]] ?? null) : undefined
}
