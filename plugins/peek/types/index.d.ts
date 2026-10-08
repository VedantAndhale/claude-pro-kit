/** The pane's redraw counter: the clock reading of the latest change or tick. */
export type PeekTick = number

declare module 'claude-code' {
  interface PluginState {
    peek: {
      /** Bumped on every change and every second while the pane is open, so it redraws. */
      tick: PeekTick
    }
  }
}
