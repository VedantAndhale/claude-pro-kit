export type AnswerPart = { kind: 'md'; text: string } | { kind: 'svg'; svg: string; label: string }

export type AnswerPage = {
  id: string
  title: string
  subtitle?: string
  htmlPath: string
  at: number
  parts: AnswerPart[]
}

export type AnswerView = 'page' | 'list'

declare module 'claude-code' {
  interface PluginState {
    'answer-pane': {
      pages: AnswerPage[]
      currentId: string | null
      view: AnswerView
    }
  }
}
