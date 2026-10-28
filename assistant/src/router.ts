// 0G Router (pc.0g.ai) client: OpenAI-compatible chat completions, called
// straight from the browser with the user's own API key. Requests are pinned
// to TEE providers (private trust mode).

export const ROUTER = 'https://router-api.0g.ai/v1'
export const MODEL = 'glm-5.3'
export const KEYS_URL = 'https://pc.0g.ai/dashboard/api-keys'
export const DEPOSIT_URL = 'https://pc.0g.ai/dashboard/overview'

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}
export type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
}

export class RouterError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
  }
}

function explain(status: number, code: string | undefined, message: string): string {
  if (status === 401 || status === 403) return 'The API key was refused. Check it, or create a new one at pc.0g.ai.'
  if (status === 402 || code === 'insufficient_balance') return 'Your 0G Private Computer balance is empty. Deposit 0G at pc.0g.ai, then ask again.'
  if (status === 429) return 'Too many requests right now — wait a moment and ask again.'
  if (code === 'no_provider_for_trust_mode') return 'No private (TEE) provider is serving the model right now. Try again in a few minutes.'
  if (status >= 500) return `The 0G Router had a problem (${status}). Try again in a moment.`
  return message || `Request failed (${status})`
}

/** fetch, with a network-level refusal (offline, or CORS: the Router only
 * answers allowlisted origins) turned into something a person can act on */
async function post(body: unknown, key: string, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(`${ROUTER}/chat/completions`, { method: 'POST', headers: headers(key), body: JSON.stringify(body), signal })
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new RouterError(
      `Couldn’t reach the 0G Router. Check your connection; if it persists, this site (${location.origin}) may not be allowed to call it directly.`,
      0
    )
  }
}

const headers = (key: string) => ({
  Authorization: `Bearer ${key}`,
  'Content-Type': 'application/json',
  'X-0G-Provider-Trust-Mode': 'private',
})

async function fail(r: Response): Promise<never> {
  let code: string | undefined
  let message = ''
  try {
    const j = await r.json()
    code = j.error?.code
    message = j.error?.message ?? ''
  } catch {
    // not JSON
  }
  throw new RouterError(explain(r.status, code, message), r.status, code)
}

export interface Price {
  /** 0G per token */
  prompt: number
  completion: number
  /** USD per token, when the Router lists it */
  promptUsd?: number
  completionUsd?: number
}

let price: Promise<Price | null> | null = null

/** the model's live price (public endpoint, no key needed) */
export function getPrice(): Promise<Price | null> {
  price ??= fetch(`${ROUTER}/models`)
    .then((r) => r.json())
    .then((j) => {
      const m = (j.data as { id: string; pricing?: Record<string, string>; pricing_usd?: Record<string, string> }[]).find((m) => m.id === MODEL)
      if (!m?.pricing) return null
      return {
        prompt: Number(m.pricing.prompt) / 1e18,
        completion: Number(m.pricing.completion) / 1e18,
        promptUsd: m.pricing_usd ? Number(m.pricing_usd.prompt) : undefined,
        completionUsd: m.pricing_usd ? Number(m.pricing_usd.completion) : undefined,
      }
    })
    .catch(() => (price = null))
  return price
}

/** one tiny request: is the key accepted and funded? */
export async function checkKey(key: string): Promise<void> {
  const r = await post({ model: MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }, key)
  if (!r.ok) await fail(r)
}

export interface Completion {
  message: Extract<Message, { role: 'assistant' }>
  usage: Usage | null
  finish: string | null
}

/**
 * One streamed completion. Text arrives through onText as it's generated;
 * tool calls are assembled from their deltas and returned at the end.
 */
export async function complete(
  key: string,
  body: { messages: Message[]; tools?: unknown[]; tool_choice?: 'auto' | 'none'; max_tokens?: number },
  onText: (delta: string) => void,
  onThinking: () => void,
  signal?: AbortSignal
): Promise<Completion> {
  const r = await post({ model: MODEL, stream: true, stream_options: { include_usage: true }, temperature: 0.3, ...body }, key, signal)
  if (!r.ok) await fail(r)
  if (!r.body) throw new RouterError('Empty response', r.status)

  let content = ''
  const calls: ToolCall[] = []
  const slot = new Map<number, number>()
  let usage: Usage | null = null
  let finish: string | null = null
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader()
  let buf = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += value
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') continue
      let j
      try {
        j = JSON.parse(data)
      } catch {
        continue
      }
      if (j.error) throw new RouterError(explain(500, j.error.code, j.error.message), 500, j.error.code)
      if (j.usage) usage = j.usage
      const choice = j.choices?.[0]
      if (!choice) continue
      if (choice.finish_reason) finish = choice.finish_reason
      const d = choice.delta ?? {}
      if (d.reasoning_content) onThinking()
      if (d.content) {
        content += d.content
        onText(d.content)
      }
      for (const tc of d.tool_calls ?? []) {
        // deltas carry an index; the first one for a call has its id and name.
        // GLM numbers parallel calls all as index 0, so a new id starts a new
        // call, and later id-less deltas belong to the latest call at that index.
        const idx = tc.index ?? 0
        let i = slot.get(idx)
        if (i === undefined || (tc.id && calls[i].id && calls[i].id !== tc.id)) {
          i = calls.length
          slot.set(idx, i)
        }
        calls[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) calls[i].id = tc.id
        if (tc.function?.name) calls[i].function.name += tc.function.name
        if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments
      }
    }
  }
  const toolCalls = calls.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }))
  return {
    message: { role: 'assistant', content: content || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    usage,
    finish,
  }
}
