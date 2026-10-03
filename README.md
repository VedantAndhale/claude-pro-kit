# claude-pro-kit

Make the $20 Claude Pro plan last longer in Claude Code.

Five small [mods](https://code.claude.com/docs/en/plugins/mods/overview) that show you exactly where your usage goes and cut the waste. The mods themselves make no model calls and add nothing to the system prompt: every figure on screen is one Claude Code already reports, or a time the mod measured.

| Mod | What it does | Where |
| --- | --- | --- |
| **tool-diet** | Loads tools you have not used lately on demand instead of with every request | Everywhere |
| **context-xray** | `/xray` opens the exact breakdown of what fills your context window | Everywhere |
| **pro-hud** | Live meters above the prompt for your 5-hour session, your week and the context window, plus a per-turn receipt of tokens in, cached and out | Claude desktop app |
| **output-diet** | Trims long shell output before Claude reads it, keeping the head, the tail and the error lines; the untrimmed text is saved to a file Claude can open without a permission prompt | Everywhere |
| **reread-guard** | Skips Claude re-reading a file it already read when the file has not changed; a deliberate retry still goes through | Everywhere |

![pro-hud's band updating live while Claude works](docs/pro-hud-live.gif)

- With **tool-diet**, every request in a fresh session was **15,954 tokens smaller (−36%)**: 43,859 → 27,905, as the API reported. [Details](#tool-diet).
- In the [benchmark](#benchmark), a debugging task cost **33% less** with output-diet and reread-guard on, averaged over three runs each.

## Install

In Claude Code:

```
/plugin marketplace add VedantAndhale/claude-pro-kit
/plugin install tool-diet@claude-pro-kit
/plugin install context-xray@claude-pro-kit
/plugin install pro-hud@claude-pro-kit
/plugin install output-diet@claude-pro-kit
/plugin install reread-guard@claude-pro-kit
```

To get fixes and new mods as they ship, turn on auto-update once: in a terminal, run `claude`, then `/plugin` → **Marketplaces** → `claude-pro-kit` → **Enable auto-update**. It is off by default for marketplaces you add yourself, and the desktop app has no toggle for it; `/plugin marketplace update claude-pro-kit` refreshes by hand from anywhere.

Install any one on its own; they do not depend on each other. Mods are not sandboxed, so read the code before installing: each mod is a single file under `plugins/<name>/hooks/`.

## tool-diet

Every tool listed in front sends its whole description and schema with every request. A deferred tool is listed by name only, and Claude loads it through ToolSearch when it needs it; Claude Code already does this for most MCP tools. tool-diet does it for the rest of the tools you are not using: anything outside the core set (Bash, PowerShell, Read, Edit, Write, Glob, Grep, Agent, Skill, ToolSearch, TodoWrite, AskUserQuestion) that you have not used in your last five sessions.

Measured with one prompt, "Reply with just OK.", in a fresh session, as the API reported each request:

| | Prompt tokens per request |
| --- | ---: |
| Without tool-diet | 43,859 |
| With tool-diet | 27,905 |
| **Change** | **−15,954 (−36%)** |

On that setup, the largest tool moved was `Artifact`, whose description alone is 19,870 characters. What moves depends on your tools and your habits; `/xray` shows yours.

- The first time a deferred tool is used in a session costs one extra step, a ToolSearch call. After that it stays loaded for the session.
- Using a tool keeps it loaded for your next five sessions, so the set follows what you actually use.
- The choice is made once per tool per session, so the prompt cache is never disturbed mid-session. Changes apply from the next session.
- `/tool-diet` lists what is on demand this session, grouped by where each tool comes from; `/tool-diet keep <tool>` always loads one, `unkeep` undoes it, and `/tool-diet off|on` switches it. Answers are toasts, so they add nothing to the conversation. The status line keeps the count: `38 tools on demand`.

![The /tool-diet toast: 38 tools on demand, grouped by source](docs/tool-diet-toast.png)

## context-xray

![The /xray pane: what is sent with every request, what loads on demand, memory files and listings](docs/context-xray.png)

`/xray` opens a pane with the exact breakdown `/context` computes: what is sent with every request (system prompt, tools, MCP tools, memory files, skills, messages), what is loaded on demand, which MCP tools load every time, and each memory file's size. It measures when the pane opens and when you press Refresh (or `r`), never in the background, because the exact count sends one token-count request per tool and memory file.

## pro-hud

The recording at the top of this page is the band. In text:

```
Session    ━━━━━━━━━━━━━━──────   69%  resets in 32m
Week       ━━━━━━━━━━━━━━━─────   74%  resets in 4d 17h
Context    ━━━━━━━━────────────   44%  436,034 tokens
This turn  1m 35s · 1 tool · 0 files edited · 436,034 in · 431,260 cached · 580 out
```

On a wide window the three meters sit side by side on one row; on a narrow one each figure on the turn line wraps whole rather than being cut off.

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
- The status line keeps a running count: `3 trimmed · 41,200 chars saved`.
- The untrimmed text is written to disk first; if the write fails, nothing is trimmed.
- It goes in the session's own `tool-results` folder, beside the transcript, where Claude Code keeps the outputs it saves itself, so Claude can open it without a permission prompt. When that folder cannot be found, it goes under `~/.claude/output-diet/` (or `CLAUDE_CONFIG_DIR`).
- Claude Code itself already cuts the middle out of very long shell output (past roughly 10,000 characters) before any mod sees it, and for a failing command no uncut copy is kept. output-diet works on what is left: the saved file holds everything Claude would have read, and an error line Claude Code cut is not in it.

## reread-guard

When Claude asks to `Read` the same range of the same file again in the same conversation, and the file's size and modification time have not changed, the read is skipped and Claude is told to use the copy it has. Any edit, a different range, or a subagent (which has its own context) reads freely. Claude Code can clear old tool results from context, so retrying the identical read straight after a skip always goes through. The record resets on `/compact` and `/clear`.

What Claude is told in place of the repeat read, kept to one line because the model reads it:

```
api.ts unchanged since you read it; use that copy. If it's gone from context, retry the same Read.
```

The status line counts them: `2 re-reads skipped`.

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

Installed copies update only when a plugin's version changes, so bump `version` in its `plugin.json` (and its entry in `.claude-plugin/marketplace.json`) with every change you ship.

## License

MIT
