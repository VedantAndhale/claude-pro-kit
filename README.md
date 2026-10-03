# claude-pro-kit

Make the $20 Claude Pro plan last longer in Claude Code.

Three small [mods](https://code.claude.com/docs/en/plugins/mods/overview) that show you exactly where your usage goes and stop two common kinds of waste. The mods themselves make no model calls and add nothing to the system prompt: every figure on screen is one Claude Code already reports, or a time the mod measured.

| Mod | What it does | Where |
| --- | --- | --- |
| **pro-hud** | Live meters above the prompt for your 5-hour session, your week and the context window, plus a per-turn receipt of tokens in, cached and out | Claude desktop app |
| **output-diet** | Trims long shell output before Claude reads it, keeping the head, the tail and the error lines; the untrimmed text is saved to a file Claude can open without a permission prompt | Everywhere |
| **reread-guard** | Skips Claude re-reading a file it already read when the file has not changed; a deliberate retry still goes through | Everywhere |

![pro-hud's band updating live while Claude works](docs/pro-hud-live.gif)

In the [benchmark](#benchmark), the same task cost **33% less** with the mods on, averaged over three runs each.

## Install

In Claude Code:

```
/plugin marketplace add VedantAndhale/claude-pro-kit
/plugin install pro-hud@claude-pro-kit
/plugin install output-diet@claude-pro-kit
/plugin install reread-guard@claude-pro-kit
```

Install any one on its own; they do not depend on each other. Mods are not sandboxed, so read the code before installing: each mod is a single file under `plugins/<name>/hooks/`.

## pro-hud

```
Session ━━━━━──────  20%  3h 20m     Week ━━━━━━━───  66%  4d 19h     Context ━━━───────  24%  244,205 tokens
This turn 12s  ·  3 tools  ·  1 file edited  ·  612,040 in  ·  608,880 cached  ·  1,204 out
```

- **Session / Week**: the share of your plan's 5-hour and 7-day allowance used, and when each resets. Account-wide: every chat and device counts.
- **Context**: how full this conversation is. Every request resends it, so a fuller context spends your session faster; `/compact` when it climbs.
- **This turn / Last turn**: updates live while Claude works (per tool call and per model request), then shows the turn's final figures and how many points of your session it used.
- The spinner gains `· session 20%`, and finished tool calls draw as one line: status dot, tool, target, time.
- A toast when the session crosses 80% and 90%.

`/hud` shows what is on; `/hud all on|off`, or `/hud band|spinner|cards on|off`. The answer is a toast, so toggling adds nothing to the conversation. It draws in the desktop app only and leaves the terminal as it is.

## output-diet

When a `Bash` or `PowerShell` result runs past 120 lines or 8,000 characters, Claude reads:

```
[output-diet: 82/500 lines shown; all 500 in ~/.claude/projects/<project>/<session>/tool-results/output-diet-<call>.txt]

<first 30 lines>
… [lines 31–450 omitted; error/warning lines from them:]
   250│ ERROR: build failed in src/app.ts
   300│ Warning: deprecated API
…
<last 50 lines>
```

- You still see the output in the transcript as before; only Claude's copy is trimmed.
- The untrimmed text is written to disk first; if the write fails, nothing is trimmed.
- It goes in the session's own `tool-results` folder, beside the transcript, where Claude Code keeps the outputs it saves itself, so Claude can open it without a permission prompt. When that folder cannot be found, it goes under `~/.claude/output-diet/` (or `CLAUDE_CONFIG_DIR`).
- Claude Code itself already cuts the middle out of very long shell output (past roughly 10,000 characters) before any mod sees it, and for a failing command no uncut copy is kept. output-diet works on what is left: the saved file holds everything Claude would have read, and an error line Claude Code cut is not in it.

## reread-guard

When Claude asks to `Read` the same range of the same file again in the same conversation, and the file's size and modification time have not changed, the read is skipped and Claude is told to use the copy it has. Any edit, a different range, or a subagent (which has its own context) reads freely. Claude Code can clear old tool results from context, so retrying the identical read straight after a skip always goes through. The record resets on `/compact` and `/clear`.

## Benchmark

One task, three runs without the mods and three with, Claude Opus 5.5, as Claude Code reported each run:

| | Input tokens | Output tokens | Cost | Turns |
| --- | ---: | ---: | ---: | ---: |
| Without mods | 262,301 · 325,766 · 170,377 | 865 · 1,043 · 679 | $0.2137 · $0.3698 · $0.1890 | 8 · 8 · 6 |
| With mods | 237,823 · 196,700 · 234,067 | 1,302 · 1,084 · 1,152 | $0.1799 · $0.1636 · $0.1702 | 8 · 7 · 7 |
| **Mean change** | **−12%** (252,815 → 222,863) | +37% (862 → 1,179) | **−33%** ($0.2575 → $0.1713) | same (7.3) |

Every run with the mods cost less than every run without them, and every run fixed the bug. Claude wrote somewhat more with the mods on, and spent much less on context. Token counts vary a lot from run to run because Claude takes a different path each time, so read this as one task's result, not a promise. Cost is the API-equivalent figure `claude -p` reports; on a Pro plan it is a proxy for how fast the session meter moves. reread-guard had nothing to skip in this task, so the difference is output-diet's.

`bench/run.sh` runs one task twice through `claude -p`, without and then with the mods, each in a fresh copy of `bench/fixture`: run an 800-line test suite, find the one failure, fix it, re-run. It prints the tokens in, cached and out that Claude Code reports for each run. Both runs leave your user settings out, so the mods are the only difference. Each run spends plan usage.

```
bash bench/run.sh        # one run per side
bash bench/run.sh 3      # three per side
```

## Develop

Each mod is a plugin folder under `plugins/`. To run them from a checkout, list the folders in `CLAUDE_CODE_PLUGIN_DIRS` (`;` between paths on Windows, `:` elsewhere), in your shell or in the `env` block of `~/.claude/settings.json`, and restart Claude Code.

```
claude plugin validate plugins/pro-hud
claude plugin test plugins/pro-hud
```

## License

MIT
