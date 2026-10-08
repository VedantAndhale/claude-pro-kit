export type AnswerKind = 'explain' | 'plan' | 'eli5'

export type AnswerBlock =
  | { type: 'md'; text: string }
  | { type: 'svg'; svg: string; label: string }
  | { type: 'code'; lang: string; text: string }
  | { type: 'callout'; tone: string; title: string; text: string }
  | { type: 'kv'; rows: [string, string][] }
  | { type: 'timeline'; rows: string[][] }
  | { type: 'tree'; rows: { depth: number; label: string; note?: string; hi: boolean }[] }
  | { type: 'limits'; rows: { label: string; value?: number; max?: number; unit: string; note: string }[] }
  | { type: 'decision'; n: number; question: string; options: string[]; fallback: number }

export type AnswerPanel = { id: string; title: string; meta?: string; blocks: AnswerBlock[] }

export type AnswerModel = {
  kind: AnswerKind
  title: string
  subtitle?: string
  lead: AnswerBlock[]
  panels: AnswerPanel[]
}

export type AnswerPage = AnswerModel & { id: string; htmlPath: string; at: number }

export type AnswerReply = { picks: Record<string, number>; struck: string[]; comments: Record<string, string> }

export type AnswerView = 'page' | 'list'

declare module 'claude-code' {
  interface PluginState {
    'answer-pane': {
      pages: AnswerPage[]
      currentId: string | null
      view: AnswerView
      replies: Record<string, AnswerReply>
    }
  }
}
