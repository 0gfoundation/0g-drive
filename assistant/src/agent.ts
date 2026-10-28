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
/** previous question/answer pairs kept as context */
const MAX_HISTORY = 6

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
  let text = ''
  for (let round = 1; ; round++) {
    // on the last round the model must answer with what it has
    const last = round === MAX_ROUNDS
    text = ''
    const c = await complete(
      key,
      { messages, tools: TOOLS, tool_choice: last ? 'none' : 'auto', max_tokens: 2000 },
      (d) => {
        text += d
        ev.onText(text)
      },
      ev.onThinking,
      signal
    )
    if (c.usage) {
      usage.prompt_tokens += c.usage.prompt_tokens
      usage.completion_tokens += c.usage.completion_tokens
    }
    const calls = c.message.tool_calls ?? []
    if (!calls.length || last) return { answer: c.message.content ?? '', usage, rounds: round }

    // text before tool calls is the model thinking aloud: not the answer
    ev.onText('')
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
