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
// suggested, and the same files give the same groups. Kept categories grow
// (D38): with each group kept but one paper, the held-out paper rejoins it
// and nothing else joins.
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
// recalibrating: LINK=… GROW_FLOOR=… override the tuned values for a run
if (process.env.LINK) D.DISCOVER.link = Number(process.env.LINK)
if (process.env.GROW_FLOOR) C.GROW.floor = Number(process.env.GROW_FLOOR)

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
const peopleVecs = await Promise.all(D.PEOPLE.map((p) => embedPassage(p)))
const topicsOfFile = new Map(files.map((f) => [f.id, C.topicsOf(f, topicVecs)]))
const inCategory = (id) => topicsOfFile.get(id) ?? []
const sizeOf = (c) => [...topicsOfFile.values()].filter((ts) => ts.includes(c)).length

const t0 = performance.now()
const found = D.discover(files, inCategory, sizeOf)
const ms = performance.now() - t0
const named = await Promise.all(found.map(async (g) => ({ ...g, name: D.nameFrom(g, await Promise.all(g.candidates.map((c) => embedPassage(c))), peopleVecs) })))
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

// (CLIP, on learning vision from language, sits with the language-model papers)
check('each group is one broad subject (≥ 95% of the files grouped)', pure / grouped >= 0.95, `${pure}/${grouped}`)
check('most papers are in a group (≥ 75%)', papersGrouped / papers >= 0.75, `${papersGrouped}/${papers}`)
const agents = named.find((g) => g.top === 'agents')
check('the LLM agents papers are one group (Chinese one and Agora.pdf with them), named for agents',
  agents && agents.fileIds.length >= 6 && agents.fileIds.includes('大模型智能体记忆.pdf') && agents.fileIds.includes('Agora.pdf') && /agent|language model/i.test(agents.name),
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

if (process.env.SWEEP) {
  for (const [need, floor] of [[2, 0.35], [2, 0.37], [2, 0.38], [2, 0.4], [3, 0.3], [3, 0.35]]) {
    C.GROW.need = need
    C.GROW.floor = floor
    let r = 0, h = 0, w = []
    for (const g of found) for (const m of g.fileIds) {
      const user = { v: 1, own: [{ id: 'own:g', name: 'kept', grow: true }], pins: g.fileIds.filter((x) => x !== m).map((file) => ({ file, cat: 'own:g', in: true })), updatedAt: 0 }
      const j = C.growJoins(files.map((f) => ({ ...f, mime: 'text/plain' })), user)
      h++
      if (j.get(m)?.includes('own:g')) r++
      for (const [id, cs] of j) if (id !== m && cs.includes('own:g')) w.push(id)
    }
    console.log(`SWEEP need ${need} floor ${floor}: rejoined ${r}/${h}, wrong ${w.length} ${[...new Set(w)].join(' ')}`)
  }
  process.exit(0)
}
// ── kept categories grow by resemblance (D38): each group kept with one paper held out
let rejoined = 0
let held = 0
const wrongJoins = []
for (const g of found) {
  for (const m of g.fileIds) {
    const user = { v: 1, own: [{ id: 'own:g', name: 'kept', grow: true }], pins: g.fileIds.filter((x) => x !== m).map((file) => ({ file, cat: 'own:g', in: true })), updatedAt: 0 }
    const joins = C.growJoins(files.map((f) => ({ ...f, mime: 'text/plain' })), user)
    held++
    if (joins.get(m)?.includes('own:g')) rejoined++
    for (const [id, cs] of joins) if (id !== m && cs.includes('own:g')) wrongJoins.push(`${id}→[${g.fileIds[0]}]`)
  }
}
console.log(`grow: held out one at a time, ${rejoined}/${held} rejoined; wrong joins ${wrongJoins.length} (GROW ${JSON.stringify(C.GROW)})`)
check('a kept group grows: held-out papers rejoin it (≥ 80%)', rejoined / held >= 0.8, `${rejoined}/${held}`)
check('…and nothing else joins (other subjects’ papers, everyday files)', wrongJoins.length === 0, wrongJoins.slice(0, 6).join(' '))
const still = C.growJoins(files.map((f) => ({ ...f, mime: 'text/plain' })), { v: 1, own: [{ id: 'own:x', name: 'x' }], pins: found[0].fileIds.slice(1).map((file) => ({ file, cat: 'own:x', in: true })), updatedAt: 0 })
check('a category not kept from a suggestion doesn’t grow', still.size === 0)
const outPin = { v: 1, own: [{ id: 'own:g', name: 'kept', grow: true }], pins: [...agents.fileIds.slice(1).map((file) => ({ file, cat: 'own:g', in: true })), { file: agents.fileIds[0], cat: 'own:g', in: false }], updatedAt: 0 }
check('a file taken out of it doesn’t come back by resemblance', !C.growJoins(files.map((f) => ({ ...f, mime: 'text/plain' })), outPin).get(agents.fileIds[0])?.includes('own:g'))

// [subject, name, the file's opening as the index reads it]
const NOISY = [
  // as pdf.js gives a paper's first page: venue or permission lines, title, authors with spaced marks
  // (or nothing at all between them), affiliations, emails — the opening the index keeps
  ['agents', 'memskill.pdf', 'Published as a conference paper at ICLR 2024 MemSkill: Reusable Skills for LLM Agents Zeng Ming ∗ 1 , Xiang Li 2 , Chen Wei 1 1 Tsinghua University 2 Peking University {zengming, xli}@tsinghua.edu.cn Abstract Large language model agents struggle to retain skills across tasks. We introduce a memory of reusable skills for agents.'],
  ['agents', 'agentmem_camera_ready.pdf', 'Hierarchical Memory for Language Model Agents Xiang Li Zeng Ming Zhang Yu Peking University Tsinghua University xiang.li@pku.edu.cn Abstract Agents built on large language models forget what they learned. We give LLM agents a hierarchical memory and show gains on long-horizon agent tasks.'],
  ['agents', 'osdi23-final274.pdf', 'This paper is included in the Proceedings of the 17th USENIX Symposium on Operating Systems Design and Implementation. Serving LLM Agents at Scale Zeng Ming † Chen Wei † Xiang Li ‡ Wu Hao † † Tsinghua University ‡ Peking University Abstract Language model agents issue many tool calls per task; we serve LLM agents by batching agent tool calls.'],
  ['agents', "#274 - OSDI '23.pdf", "OSDI '23 Artifact #274: Agent Tool Use Benchmarks Chen Wei 1 , Zeng Ming 1 1 Tsinghua University This artifact evaluates language model agents on tool use. Agents call search and calculators; we report agent success rates."],
  ['agents', '2405.12345v2.pdf', 'arXiv:2405.12345v2 [cs.CL] 3 Jun 2024 Planning with LLM Agents Zhang Yu ∗ , Xiang Li ∗ , Zeng Ming Abstract We study how language model agents plan, act and revise plans; agents with reflection finish more interactive tasks.'],
  ['chain', 'dag-bft.pdf', 'Narrow: DAG-Based BFT Consensus Zeng Ming 1 , Wu Hao 2 , Chen Wei 1 1 Tsinghua University 2 Ant Group {zengming, wchen}@tsinghua.edu.cn Abstract—We present a Byzantine fault tolerant consensus protocol for blockchains that separates data dissemination from ordering.'],
  ['chain', 'da-sampling-sosp.pdf', 'Data Availability Sampling for Blockchain Light Clients Wu Hao Zeng Ming Chen Wei Ant Group Tsinghua University Abstract. Blockchain light clients cannot download full blocks; erasure-coded blocks and sampling let them check data availability.'],
  ['chain', 'storage-proofs-v3-final.pdf', 'Proofs of Storage for Decentralized Blockchain Storage Chen Wei ∗ , Wu Hao Tsinghua University wchen@tsinghua.edu.cn Abstract: Decentralized storage on a blockchain must verify providers keep the data; we design proofs of replication.'],
  ['chain', 'consensus-mev.pdf', 'Fair Ordering in Blockchain Consensus Zeng Ming Wu Hao Tsinghua University Ant Group Abstract—Validators reorder transactions for profit. We add order fairness to blockchain consensus and measure front-running.'],
  ['letters', 'letter-to-chen-1.txt', 'Dear Ms. Chen,\nThank you for the quote for the kitchen renovation. We would like the renovation to start in March; please confirm the cabinets and the tiles.\nBest regards,\nJohn Smith'],
  ['letters', 'letter-to-chen-2.txt', 'Dear Ms. Chen,\nAbout the kitchen renovation: the plumber found an old pipe behind the cabinets. Can the renovation schedule move by a week?\nBest regards,\nJohn Smith'],
  ['letters', 'letter-to-chen-3.txt', 'Dear Ms. Chen,\nThe renovation is done and the kitchen looks great. The final invoice for the renovation is attached; the tiles came out well.\nKind regards,\nJohn Smith'],
  ['code', 'Button.tsx', '/**\n * Copyright 2024 Google LLC\n * Licensed under the Apache License, Version 2.0\n */\nimport React from "react"\nexport function Button({ label, onClick }) { return <button className="btn" onClick={onClick}>{label}</button> }'],
  ['code', 'Dialog.tsx', '/**\n * Copyright 2024 Google LLC\n * Licensed under the Apache License, Version 2.0\n */\nimport React, { useState } from "react"\nexport function Dialog({ title, children }) { const [open, setOpen] = useState(false); return open ? <div role="dialog">{children}</div> : null }'],
  ['code', 'Menu.tsx', '/**\n * Copyright 2024 Google LLC\n * Licensed under the Apache License, Version 2.0\n */\nimport React, { useState } from "react"\nexport function Menu({ items }) { const [open, setOpen] = useState(false); return <ul role="menu">{items.map((i) => <li>{i}</li>)}</ul> }'],
  ['meetings', 'standup-mon.md', '# Standup, Monday\nAttendees: Ming Zeng, Xiang Li, Wei Chen, Hao Wu\nRoadmap: the Q3 roadmap slips a week; the release checklist needs owners. Roadmap review on Friday.'],
  ['meetings', 'standup-wed.md', '# Standup, Wednesday\nAttendees: Ming Zeng, Xiang Li, Wei Chen\nRoadmap: release checklist has owners now; roadmap risks are the migration and hiring. Release next Tuesday.'],
  ['meetings', 'standup-fri.md', '# Standup, Friday\nAttendees: Ming Zeng, Wei Chen, Hao Wu\nRoadmap review: Q3 roadmap agreed; release checklist done; the release ships Tuesday.'],
  ['zh', '区块链存储-会议版.pdf', '区块链去中心化存储的数据可用性证明\n张明¹, 李翔², 王伟¹\n¹清华大学 ²北京大学\n摘要:本文提出区块链去中心化存储中基于纠删码的数据可用性证明方法。'],
  ['zh', '区块链共识.pdf', '区块链共识协议的公平排序\n王伟, 张明, 李翔\n清华大学\n摘要:区块链验证者可以重排交易获利,本文为区块链共识协议加入公平排序。'],
  ['zh', '存储证明.pdf', '去中心化存储的复制证明\n李翔、张明、王伟\n清华大学\n摘要:区块链去中心化存储需要验证存储节点保存了数据,本文设计复制证明。'],
]
const PEOPLE_IN_NAMES = /\b(ming|zeng|xiang|li|wei|chen|hao|wu|yu|zhang|john|smith)\b|张明|李翔|王伟|清华|北京大学/

// ── names from files as they open (D39): papers with author lists, letters, code with license headers,
// meeting notes with attendees, Chinese papers with Chinese authors. No person, email, ID or boilerplate
// word becomes a name; each group is named for its subject, or not named at all.
{
  const nf = []
  let t = Date.now()
  for (const [subject, name, text] of NOISY) nf.push({ id: name, name, subject, uploadedAt: t--, search: await indexText(name, text) })
  const groups = D.discover(nf, () => [], () => 0)
  const rows = []
  for (const g of groups) {
    const vecs = await Promise.all(g.candidates.map((c) => embedPassage(c)))
    const subj = [...new Set(g.fileIds.map((id) => nf.find((f) => f.id === id).subject))]
    rows.push({ subj, name: D.nameFrom(g, vecs, peopleVecs), n: g.fileIds.length, fits: D.candidateFits(g, vecs, peopleVecs) })
  }
  for (const r of rows) console.log(`  [${r.subj.join('+')}] “${r.name}” (${r.n} files) — ${r.fits.slice(0, 8).map((x) => `${x.t} ${x.fit.toFixed(2)}/p${x.person.toFixed(2)}`).join(' | ')}`)
  const bad = rows.filter((r) => PEOPLE_IN_NAMES.test(r.name.toLowerCase()) || /\d|@|google|llc|licen|copyright|universit|osdi|final|camera|arxiv/i.test(r.name))
  check('files as they open: no person, email, ID or boilerplate word in any name', bad.length === 0, bad.map((r) => r.name).join(' / '))
  const named = (subj, re) => rows.find((r) => r.subj.includes(subj) && re.test(r.name))
  check('…the agents papers (shared authors) are named for agents', !!named('agents', /agent/i), rows.map((r) => r.name).join(' / '))
  check('…the blockchain papers for blockchain', !!named('chain', /blockchain|consensus|storage|chain/i))
  check('…the Chinese papers in Chinese', !!rows.find((r) => r.subj.includes('zh') && /\p{Script=Han}/u.test(r.name)) || !rows.some((r) => r.subj.includes('zh')))
}

// ── the same people, different subjects (D41): papers whose first page is mostly the same long author
// block (a permission notice, 8 authors with marks, affiliations, emails), as real first pages are.
// Embedded the old way (v1: the opening as read, ~600 characters) they group by who wrote them;
// embedded from what they're about (v2: title and abstract on), by subject.
{
  const { passageText, makeExcerpt } = await import(pathToFileURL(join(outDir, 'searchcore.mjs')))
  const BLOCK = 'Provided proper attribution is provided, Acme hereby grants permission to reproduce the tables and figures in this paper solely for use in journalistic or scholarly works.'
  const AUTH = 'Zeng Ming ∗ Acme Research zengming@acme.com Xiang Li ∗ Acme Research xli@acme.com Chen Wei † Acme Brain wchen@acme.com Wu Hao ‡ Tsinghua University wuhao@tsinghua.edu.cn Zhang Yu ∗ Acme Research Liu Yang † Acme Brain Sun Qi ‡ Peking University Zhou Lin ∗ Acme Research'
  const SAME = [
    ['agents', 'Reusable Skills for LLM Agents', 'Large language model agents struggle to retain skills across tasks. We give agents a memory of reusable skills and evaluate on agent benchmarks.'],
    ['agents', 'Planning with Language Model Agents', 'We study how language model agents plan, act and revise their plans; agents with reflection finish more interactive tasks.'],
    ['agents', 'Tool Use for LLM Agents', 'Agents built on large language models call tools such as search and calculators; we teach agents when to call which tool.'],
    ['vision', 'Diffusion Models for Image Synthesis', 'We generate high quality images with denoising diffusion models and report FID on image benchmarks.'],
    ['vision', 'Transformers for Image Recognition', 'A pure transformer applied to sequences of image patches matches convolutional networks on image classification.'],
    ['vision', 'Real-Time Object Detection', 'We detect objects in images in one pass from pixels to bounding boxes and class probabilities at 45 frames per second.'],
    ['chain', 'DAG-Based BFT Consensus', 'We present a Byzantine fault tolerant consensus protocol for blockchains that separates data dissemination from ordering.'],
    ['chain', 'Data Availability Sampling for Light Clients', 'Blockchain light clients check data availability by sampling erasure-coded blocks instead of downloading them.'],
    ['chain', 'Fair Ordering in Blockchain Consensus', 'Validators reorder blockchain transactions for profit; we add order fairness to consensus and measure front-running.'],
  ]
  const files1 = []
  const files2 = []
  let at = Date.now()
  for (const [subject, title, abstract] of SAME) {
    const name = title.toLowerCase().replace(/[^a-z]+/g, '-') + '.pdf'
    const raw = `${BLOCK} ${title} ${AUTH} Abstract ${abstract}`
    const old = { v: 1, t: makeExcerpt(raw), e: (await indexText(name, undefined)).e && undefined }
    old.e = (await (async () => { const { quantize } = await import(pathToFileURL(join(outDir, 'searchcore.mjs'))); return quantize(await embedPassage(passageText(name, undefined, raw))) })())
    files1.push({ id: name, name, subject, uploadedAt: at, search: old })
    files2.push({ id: name, name, subject, uploadedAt: at--, search: await indexText(name, raw, title) })
  }
  const purity = (groups, fs) => {
    let pure = 0, grouped = 0
    const mixed = []
    for (const g of groups) {
      const subj = new Map()
      for (const id of g.fileIds) { const s = fs.find((f) => f.id === id).subject; subj.set(s, (subj.get(s) ?? 0) + 1) }
      const top = Math.max(...subj.values())
      pure += top
      grouped += g.fileIds.length
      if (subj.size > 1) mixed.push([...subj].map(([s, k]) => `${k} ${s}`).join(' + '))
    }
    return { groups: groups.length, grouped, pure, mixed }
  }
  const before = purity(D.discover(files1, () => [], () => 0), files1)
  const after = purity(D.discover(files2, () => [], () => 0), files2)
  console.log(`  same people, 3 subjects × 3 papers — v1 (opening): ${JSON.stringify(before)}; v2 (title + abstract): ${JSON.stringify(after)}`)
  check('papers by the same people on different subjects are grouped by subject (v2), each group one subject',
    after.groups === 3 && after.grouped === 9 && after.mixed.length === 0, JSON.stringify({ before, after }))

  // a drive not indexed again yet (D42): v1 entries are held to the bar they were tuned at (0.35), not v2's
  const keys = (gs) => JSON.stringify(gs.map((g) => g.key).sort())
  const link = D.DISCOVER.link
  D.DISCOVER.link = link + 0.02
  const asTuned = D.discover(files1.map((f) => ({ ...f, search: { ...f.search, v: 2 } })), () => [], () => 0)
  D.DISCOVER.link = link
  check('v1 entries group as at their own bar (0.35), not looser', keys(D.discover(files1, () => [], () => 0)) === keys(asTuned))
}

console.log(failed ? `${failed} FAILED` : 'DISCOVER TEST PASSED ✓')
process.exitCode = failed ? 1 : 0
