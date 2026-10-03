export type XrayRow = { name: string; tokens: number }

export type XraySnapshot = {
  /** When it was measured, ms since the epoch. */
  at: number
  model: string
  totalTokens: number
  maxTokens: number
  percentage: number
  /** In-use categories, largest first. */
  used: XrayRow[]
  /** Categories listed behind ToolSearch, loaded on demand. */
  deferred: XrayRow[]
  free: number
  buffer: number
  /** MCP tools whose schemas load on every request, largest first. */
  mcpLoaded: (XrayRow & { server: string })[]
  mcpDeferredCount: number
  memoryFiles: (XrayRow & { type: string })[]
  skills?: { tokens: number; included: number; total: number }
  commands?: { tokens: number; included: number; total: number }
  agents: XrayRow[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-xray': {
      snapshot: XraySnapshot | null
      isMeasuring: boolean
      error: string | null
    }
  }
}
