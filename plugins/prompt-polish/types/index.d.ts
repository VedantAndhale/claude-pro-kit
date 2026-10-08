export type PolishBand = {
  /** True while the prompt box holds more than whitespace. */
  hasDraft: boolean
  /** True while a Haiku call for Improve runs. */
  isBusy: boolean
  /** The draft as it was before the last Improve, until Undo or a submit. */
  original?: string
}

declare module 'claude-code' {
  interface PluginState {
    'prompt-polish': {
      band: PolishBand
    }
  }
}
