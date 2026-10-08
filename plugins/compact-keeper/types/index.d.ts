declare module 'claude-code' {
  interface PluginState {
    'compact-keeper': {
      /** The note added at the last compaction, or null before the first. */
      lastNote: string | null
    }
  }
}
