// The agent loop: ask the model; run the tools it calls (every call of a
// round, in parallel); repeat until it answers. Earlier turns are kept as
// question + answer only — their tool results are dropped, since every round
// resends the whole conversation and pays for it again.
import { complete, type Message, type Usage } from './router'
import { TOOLS, runTool, describe } from './tools'
import { SYSTEM_PROMPT } from './prompt'

export interface Step {
  name: string
  label: string
  done: boolean
}
export interface TurnEvents {
  onStep: (steps: Step[]) => void
  onText: (text: string) => void
  onThinking: () => void
}
export interface TurnResult {
  answer: string
  usage: Usage
  rounds: number
}

const MAX_ROUNDS = 8
/** text sent along with tool calls counts as part of the answer from this
 *  length on; shorter is a preamble ("Let me check…") */
const KEEP_WITH_TOOLS = 200
/** previous question/answer pairs kept as context */
const MAX_HISTORY = 6
/** an answer saying it highlighted something on screen ("I've highlighted
 *  it for you") — only show_in_drive does that */
const CLAIMS_HIGHLIGHT = /\b(?:i['’]ve|i have|i)\s+(?:just\s+|also\s+)?(?:highlighted|pointed (?:at|to|out))\b|\bhighlighted (?:it|that|this|them) for you\b/i
const POINT_NOW =
  'You wrote that you highlighted something in the drive, but you did not call show_in_drive, so nothing was highlighted. Call show_in_drive now for that control. After it, reply with one short sentence at most; do not repeat your answer.'

export async function runTurn(
  key: string,
  history: { question: string; answer: string }[],
  question: string,
  ev: TurnEvents,
  signal?: AbortSignal
): Promise<TurnResult> {
  const messages: Message[] = [{ role: 'system', content: SYSTEM_PROMPT }]
  for (const h of history.slice(-MAX_HISTORY)) {
    messages.push({ role: 'user', content: h.question }, { role: 'assistant', content: h.answer })
  }
  messages.push({ role: 'user', content: question })

  const usage: Usage = { prompt_tokens: 0, completion_tokens: 0 }
  const steps: Step[] = []
  // GLM thinks in a separate channel, so text it sends with tool calls is
  // written for the user — often the whole answer, with a last call such as
  // show_in_drive and only a short follow-up after it. Keep it.
  let kept = ''
  // the model sometimes says it highlighted a control without calling
  // show_in_drive; it then gets one reminder to make the call
  let pointed = false
  let reminded = false
  const join = (a: string, b: string) => (a && b ? `${a}\n\n${b}` : a || b)
  for (let round = 1; ; round++) {
    // on the last round the model must answer with what it has
    const last = round === MAX_ROUNDS
    let text = ''
    const c = await complete(
      key,
      { messages, tools: TOOLS, tool_choice: last ? 'none' : 'auto', max_tokens: 2000 },
      (d) => {
        text += d
        ev.onText(join(kept, text))
      },
      ev.onThinking,
      signal
    )
    if (c.usage) {
      usage.prompt_tokens += c.usage.prompt_tokens
      usage.completion_tokens += c.usage.completion_tokens
    }
    const calls = c.message.tool_calls ?? []
    const content = (c.message.content ?? '').trim()
    if (!calls.length && !last && !pointed && !reminded && CLAIMS_HIGHLIGHT.test(content)) {
      reminded = true
      kept = join(kept, content)
      ev.onText(kept)
      messages.push({ role: 'assistant', content }, { role: 'user', content: POINT_NOW })
      continue
    }
    if (!calls.length || last) return { answer: join(kept, content), usage, rounds: round }
    if (calls.some((call) => call.function.name === 'show_in_drive')) pointed = true

    if (content.length >= KEEP_WITH_TOOLS) kept = join(kept, content)
    ev.onText(kept)
    messages.push(c.message)
    const parsed = calls.map((call) => {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        // leave empty: the tool reports what's missing
      }
      const step: Step = { name: call.function.name, label: describe(call.function.name, args), done: false }
      steps.push(step)
      return { call, args, step }
    })
    ev.onStep([...steps])
    const results = await Promise.all(
      parsed.map(async ({ call, args, step }) => {
        const content = await runTool(call.function.name, args)
        step.done = true
        ev.onStep([...steps])
        return { role: 'tool' as const, tool_call_id: call.id, content }
      })
    )
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError')
    messages.push(...results)
  }
}
