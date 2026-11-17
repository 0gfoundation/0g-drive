// Suggested categories (D37) calibration/regression test, on the real
// on-device text model: a sample like a research-paper drive (29 papers in
// six subjects — blockchain storage and data availability, consensus,
// cross-chain bridges, LLM agents, retrieval, vision; some in Chinese — and
// everyday files) indexed the way the app does (name + the start of the
// text → one embedding, the excerpt kept), grouped by web/src/ai/discover.ts
// and named. Checks: each group is one broad subject (blockchain counts as
// one: the small model doesn't separate its sub-areas), most papers are in
// a group, the agents and retrieval groups are found and named for what
// they are, a group the built-in topics already hold (travel) isn't
// suggested, and the same files give the same groups.
//
//   node scripts/test-discover.mjs
// The text model is the trimmed one users get, fetched once from 0G Storage
// (as test-search.mjs and test-categories.mjs do).
import { build } from 'esbuild'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { env } from '@huggingface/transformers'
import { createHash } from 'node:crypto'
import { downloadFile, getNetworkConfig } from '../core/dist/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'node_modules/.cache/test-discover')
mkdirSync(outDir, { recursive: true })
await build({
  entryPoints: ['engine', 'searchcore', 'categories', 'discover', 'modelOn0g'].map((m) => join(root, `web/src/ai/${m}.ts`)),
  bundle: true,
  format: 'esm',
  platform: 'node',
  outdir: outDir,
  outExtension: { '.js': '.mjs' },
  external: ['@huggingface/transformers'],
  logLevel: 'error',
})
const { SMALL_TEXT_MODEL, TEXT_MODEL_ON_0G } = await import(pathToFileURL(join(outDir, 'modelOn0g.mjs')))
const modelsDir = join(root, 'node_modules/.cache/test-search/models')
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
for (const [name, file] of Object.entries(TEXT_MODEL_ON_0G.files)) {
  const dest = join(modelsDir, SMALL_TEXT_MODEL, name)
  if (existsSync(dest) && sha256(readFileSync(dest)) === file.sha256) continue
  const { data } = await downloadFile([file.root], getNetworkConfig(TEXT_MODEL_ON_0G.network, 'turbo'), { txSeqs: [file.txSeq] })
  if (sha256(data) !== file.sha256) throw new Error(`${name} from 0G doesn't match its SHA-256`)
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, data)
}
env.localModelPath = modelsDir + '/'
env.allowLocalModels = true

const { indexText, embedPassage } = await import(pathToFileURL(join(outDir, 'engine.mjs')))
const C = await import(pathToFileURL(join(outDir, 'categories.mjs')))
const D = await import(pathToFileURL(join(outDir, 'discover.mjs')))

let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// [subject, name, the first page's text (title, abstract)]
const S = [
  ['da', 'das-light-clients.pdf', 'Data Availability Sampling for Light Clients. Abstract: Light clients cannot download full blocks. We show how erasure-coded blocks and random sampling let a light client verify data availability with high probability, and evaluate sampling overhead on a 512-node network.'],
  ['da', 'kzg-commitments-da.pdf', 'Efficient Data Availability with KZG Commitments. Abstract: We present a data availability layer that commits to block data with polynomial commitments, enabling sampling without fraud proofs. Our implementation reduces bandwidth for rollups by 40%.'],
  ['da', 'storage-proofs-erasure.pdf', 'Proofs of Storage over Erasure-Coded Data. Abstract: Decentralized storage networks must verify that providers keep the data they are paid for. We design proofs of replication over erasure-coded sectors and analyze their security and cost.'],
  ['da', 'incentive-storage-network.pdf', 'Incentive Design for Decentralized Storage Networks. Abstract: We model storage providers as rational agents and propose a payment and slashing scheme that keeps data durable. Simulations show the network retains 99.99% of files under churn.'],
  ['da', '0g-storage-log-layer.pdf', 'A Log-Structured Storage Layer for Decentralized AI Data. Abstract: We describe an append-only log layer with a key-value layer on top, mined by storage nodes via proof of random access, designed for large AI datasets.'],
  ['da', '去中心化存储数据可用性.pdf', '去中心化存储网络中的数据可用性证明。摘要:本文提出一种基于纠删码的数据可用性采样方法,轻节点只需下载少量数据即可验证区块数据可用,并在测试网络上评估了开销。'],
  ['consensus', 'hotstuff-variant.pdf', 'Pipelined BFT Consensus with Linear Communication. Abstract: We present a Byzantine fault tolerant consensus protocol in the HotStuff family that achieves linear view change and pipelined commits, and report throughput on 100 validators.'],
  ['consensus', 'dag-consensus.pdf', 'DAG-Based Consensus for High-Throughput Blockchains. Abstract: Building on Narwhal and Bullshark, we separate data dissemination from ordering, achieving 150k transactions per second with sub-second latency in a geo-distributed deployment.'],
  ['consensus', 'consensus-whitepaper.pdf', 'A Modular Consensus Protocol: Whitepaper. Abstract: This whitepaper describes the safety and liveness of our BFT consensus for a modular blockchain, validator staking, and slashing conditions.'],
  ['consensus', 'mev-ordering.pdf', 'Fair Transaction Ordering and MEV. Abstract: Validators can reorder transactions to extract value. We propose an order-fairness protocol for consensus and measure how it reduces front-running.'],
  ['consensus', 'Mind the Gap.pdf', 'Mind the Gap: Latency of Finality in Proof-of-Stake Blockchains. Abstract: We measure the gap between block inclusion and economic finality across Ethereum and Cosmos chains and discuss its impact on exchanges and bridges.'],
  ['bridge', 'DVN in LayerZero.pdf', 'Decentralized Verifier Networks in LayerZero. Abstract: Cross-chain messaging relies on verifiers. We analyze LayerZero DVNs, their security assumptions, and configurations that reduce the risk of forged messages between chains.'],
  ['bridge', 'bridge-hacks-survey.pdf', 'A Survey of Cross-Chain Bridge Attacks. Abstract: Bridges have lost billions to hacks. We classify 30 bridge exploits by root cause, from validator key compromise to message verification bugs, and derive design guidelines.'],
  ['bridge', 'light-client-bridges.pdf', 'Trust-Minimized Bridges with On-Chain Light Clients. Abstract: We verify the source chain consensus inside a smart contract on the destination chain using succinct proofs, removing the trusted relayer from cross-chain transfers.'],
  ['bridge', 'interchain-messaging.pdf', 'Interchain Message Passing at Scale. Abstract: We compare IBC, LayerZero and Wormhole for cross-chain messaging latency, cost and trust model, and propose a routing layer across bridges.'],
  ['agents', 'memskill.pdf', 'MemSkill: Reusable Skills for LLM Agents. Abstract: Large language model agents struggle to retain skills across tasks. We introduce a memory architecture that stores reusable skills and evaluate it on three agent benchmarks, improving success rates by 18%.'],
  ['agents', 'agent-memory-survey.pdf', 'Memory in LLM Agents: A Survey. Abstract: We survey how language model agents store and retrieve memory, from long context to retrieval-augmented memory and episodic stores, and outline open problems.'],
  ['agents', 'toolformer-style.pdf', 'Teaching Language Models to Use Tools. Abstract: We train a language model to decide when to call external tools such as search and calculators, improving accuracy on agent tasks without hurting language modeling.'],
  ['agents', 'react-planning.pdf', 'Reasoning and Acting with Language Models. Abstract: We interleave reasoning traces with actions so an LLM agent can plan, act in an environment and revise its plan, outperforming chain-of-thought on interactive tasks.'],
  ['agents', 'Agora.pdf', 'Agora: A Protocol for Communication Between LLM Agents. Abstract: Agents built on different language models need to talk. We propose a protocol where agents negotiate structured messages in natural language and evaluate it with 100 agents.'],
  ['agents', 'agent-benchmark.pdf', 'Benchmarking Web Agents. Abstract: We release a benchmark of 800 realistic web tasks for language model agents and find that the best agents complete fewer than half, mostly failing at long-horizon planning.'],
  ['agents', '大模型智能体记忆.pdf', '大语言模型智能体的长期记忆机制。摘要:本文研究智能体如何在多轮任务中存储和检索经验,提出分层记忆结构,在三个基准上提升了任务成功率。'],
  ['rag', 'rag-survey.pdf', 'Retrieval-Augmented Generation: A Survey. Abstract: We review methods that ground language model outputs in retrieved documents, covering retrievers, rerankers and evaluation of factuality.'],
  ['rag', 'dense-retrieval.pdf', 'Dense Passage Retrieval for Open-Domain QA. Abstract: We learn dense embeddings for questions and passages with a dual encoder and outperform BM25 on open-domain question answering benchmarks.'],
  ['rag', 'long-context-vs-rag.pdf', 'Long Context or Retrieval? Abstract: We compare feeding entire documents to long-context language models with retrieval-augmented generation on 12 tasks and find retrieval cheaper with similar accuracy.'],
  ['vision', 'diffusion-models.pdf', 'Denoising Diffusion Probabilistic Models. Abstract: We present high quality image synthesis using diffusion probabilistic models, trained by denoising, and report FID scores on CIFAR-10 and LSUN.'],
  ['vision', 'vit.pdf', 'An Image is Worth 16x16 Words: Transformers for Image Recognition. Abstract: We apply a pure transformer to sequences of image patches and match convolutional networks on ImageNet classification.'],
  ['vision', 'object-detection.pdf', 'Real-Time Object Detection. Abstract: We frame object detection as a single regression problem from image pixels to bounding boxes and class probabilities, running at 45 frames per second.'],
  ['vision', 'clip.pdf', 'Learning Transferable Visual Models From Natural Language Supervision. Abstract: We train image and text encoders contrastively on 400 million pairs and show zero-shot image classification across 30 datasets.'],
  // everyday files among the papers
  ['finance', 'invoice-2025-031.pdf', 'Invoice no. 2025-031. Bill to: Acme Ltd. Web design services, 24 hours at 85 EUR. Subtotal 2,040.00, VAT 469.20, total due 2,509.20 within 30 days.'],
  ['finance', 'bank-statement-sept.txt', 'Account statement September. Opening balance 4,210.55. Card payments, direct debits, salary credit 3,800.00. Closing balance 5,032.10.'],
  ['finance', 'electricity-bill.txt', 'Electricity bill, period August. Consumption 312 kWh. Amount due 96.40 EUR by direct debit on Sept 20.'],
  ['travel', 'trip-notes.txt', 'Itinerary: fly TAP to Lisbon on May 3. Hotel in Alfama for five nights. Day trip to Sintra and Cascais. Return flight May 8.'],
  ['travel', 'tokyo-hotel.txt', 'Reservation for 4 nights at Shinjuku Granbell Hotel, check-in Oct 12. Breakfast included. Free cancellation until Oct 5.'],
  ['travel', '日本旅行计划.txt', '日本七日游行程:第一天抵达东京,入住新宿酒店;第三天坐新干线去京都;第六天大阪购物,第七天回国。'],
  ['misc', 'carbonara.md', 'Spaghetti carbonara. Ingredients: 200g spaghetti, 100g guanciale, 2 eggs, pecorino romano, black pepper.'],
  ['misc', 'guitar-chords.txt', 'Am C G F progression, capo on 2nd fret, strumming pattern down down up up down up.'],
  ['misc', 'todo.txt', 'buy milk, call mom, fix the bike, water the plants'],
]

const BROAD = { da: 'blockchain', consensus: 'blockchain', bridge: 'blockchain' }
const broad = (s) => BROAD[s] ?? s
const subjectOf = new Map(S.map(([s, n]) => [n, s]))
const files = []
let at = Date.now()
for (const [, name, text] of S) files.push({ id: name, name, uploadedAt: at--, search: await indexText(name, text) })
const topicVecs = await Promise.all(C.topicPhrases().map((p) => embedPassage(p)))
const topicsOfFile = new Map(files.map((f) => [f.id, C.topicsOf(f, topicVecs)]))
const inCategory = (id) => topicsOfFile.get(id) ?? []
const sizeOf = (c) => [...topicsOfFile.values()].filter((ts) => ts.includes(c)).length

const t0 = performance.now()
const found = D.discover(files, inCategory, sizeOf)
const ms = performance.now() - t0
const named = await Promise.all(found.map(async (g) => ({ ...g, name: D.nameFrom(g, await Promise.all(g.candidates.map((c) => embedPassage(c)))) })))
let pure = 0
let grouped = 0
for (const g of named) {
  const subj = new Map()
  for (const id of g.fileIds) subj.set(broad(subjectOf.get(id)), (subj.get(broad(subjectOf.get(id))) ?? 0) + 1)
  const [top, k] = [...subj].sort((a, b) => b[1] - a[1])[0]
  pure += k
  grouped += g.fileIds.length
  g.top = top
  g.pure = k === g.fileIds.length
  console.log(`  “${g.name}” — ${g.fileIds.length} files, ${k} ${top}${g.pure ? '' : ` (also ${[...subj].filter(([s]) => s !== top).map(([s, x]) => `${x} ${s}`).join(', ')})`}`)
}
const papers = S.filter(([s]) => !['finance', 'travel', 'misc'].includes(s)).length
const papersGrouped = named.flatMap((g) => g.fileIds).filter((id) => !['finance', 'travel', 'misc'].includes(subjectOf.get(id))).length
console.log(`grouped in ${ms.toFixed(0)} ms; ${grouped} files in ${named.length} groups (DISCOVER ${JSON.stringify(D.DISCOVER)})`)

check('each group is one broad subject', named.every((g) => g.pure), `${pure}/${grouped}`)
check('most papers are in a group (≥ 75%)', papersGrouped / papers >= 0.75, `${papersGrouped}/${papers}`)
const agents = named.find((g) => g.top === 'agents')
check('the LLM agents papers are one group (Chinese one and Agora.pdf with them), named for agents',
  agents && agents.fileIds.length >= 6 && agents.fileIds.includes('大模型智能体记忆.pdf') && agents.fileIds.includes('Agora.pdf') && /agent/i.test(agents.name),
  agents ? `“${agents.name}”: ${agents.fileIds.length}` : 'none')
const rag = named.find((g) => g.top === 'rag')
check('the retrieval papers are a group, named for retrieval', rag && /retriev/i.test(rag.name), rag ? `“${rag.name}”` : 'none')
const chain = named.find((g) => g.top === 'blockchain')
check('the blockchain papers are a group (≥ 10)', chain && chain.fileIds.length >= 10, chain ? `“${chain.name}”: ${chain.fileIds.length}` : 'none')
check('a group the built-in topics hold (travel) isn’t suggested', !named.some((g) => g.top === 'travel'))
check('everyday files aren’t suggested with the papers', !named.some((g) => ['finance', 'misc'].includes(g.top)))
const again = D.discover([...files].reverse(), inCategory, sizeOf)
check('the same files give the same groups', JSON.stringify(again.map((g) => g.key).sort()) === JSON.stringify(found.map((g) => g.key).sort()))
check('photos and files known by name alone aren’t grouped',
  D.discover([...files.map((f) => ({ ...f, search: { ...f.search, t: undefined } }))], inCategory, sizeOf).length === 0)

// every paper in Research papers (a broad category): its groups are still suggested
const isPaper = (id) => !['finance', 'travel', 'misc'].includes(subjectOf.get(id))
const inResearch = D.discover(files, (id) => (isPaper(id) ? ['topic:research'] : inCategory(id)), (c) => (c === 'topic:research' ? papers : sizeOf(c)))
check('groups inside a broad category (all papers in Research papers) are still suggested', inResearch.length === found.length, `${inResearch.length} vs ${found.length}`)
// one of the groups made a category of the user's: it isn't suggested again
const kept = new Set(agents?.fileIds ?? [])
const afterKeep = D.discover(files, (id) => (kept.has(id) ? ['own:agents', ...inCategory(id)] : inCategory(id)), (c) => (c === 'own:agents' ? kept.size : sizeOf(c)))
check('a group kept as a category isn’t suggested again', afterKeep.length === found.length - 1 && !afterKeep.some((g) => g.key === agents?.key))

console.log(failed ? `${failed} FAILED` : 'DISCOVER TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
