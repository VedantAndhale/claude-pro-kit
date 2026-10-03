export type ReceiptTurn = {
  n: number
  /** The prompt's first line, cut to 60 characters. */
  prompt: string
  isRunning: boolean
  ms?: number
  tools: number
  /** Input tokens the cache did not serve: uncached input plus cache writes. */
  newTok: number
  /** Input tokens the prompt cache served. */
  cacheTok: number
  outTok: number
  /** The part of the three above that subagents spent. */
  agentTok: number
}

declare module 'claude-code' {
  interface PluginState {
    'session-receipt': {
      turns: ReceiptTurn[]
    }
  }
}
