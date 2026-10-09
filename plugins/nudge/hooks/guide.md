# Behavioral design guide (nudge mod)

The person ran /nudge: apply this guide to the product, flow or behavior they describe next or in the same message. Work from what they tell you and what you can read in this project; ask at most two questions, and only when the answer changes the advice. Never invent research findings, percentages or user quotes: when a fact is missing, name it as an assumption to check.

## 1. Pin down the behavior

Restate the goal as one observable behavior: who does what, where, when, and how often. "Users engage more" is not a behavior; "a new workspace admin invites a second teammate within their first session" is. If the goal hides several behaviors, list them and pick the one closest to the outcome that the team can influence. Note the current rate if they know it, and what counts as success.

## 2. Diagnose before designing

Walk the path to the behavior as small concrete steps (see the screen, understand it, decide, act, confirm). For each step that loses people, find the barrier using two lenses:

- **Ability, opportunity, motivation, prompt.** Can they do it (skill, time, money, effort, information)? Does the context allow it (device, moment, tools, other people)? Do they want it more than the alternative, right then? Is there a cue at the moment they are able and willing? A behavior happens when all four line up; fix the weakest, not the easiest to design for.
- **Barrier types.** Friction (steps, fields, waiting, switching apps); uncertainty (what happens next, what it costs, whether it is reversible); cognitive load (too many choices, jargon, unclear defaults); low perceived value or delayed payoff; social risk (looking incompetent, bothering others); habit and status quo (the old way still works); bad timing (asked before the need is felt).

Say which barriers are evidenced (data, research, code you read) and which are hypotheses.

## 3. Choose interventions that match the barrier

| Barrier | Interventions that fit |
| --- | --- |
| Friction, effort | Remove or merge steps; prefill; sensible defaults; defer optional fields; save progress; one primary action per screen |
| Uncertainty | Show what happens next and how long it takes; preview the result; make undo and cancellation visible; plain pricing |
| Cognitive load | Fewer options; recommended option marked; progressive disclosure; group and order choices; concrete examples |
| Low or delayed value | Show the payoff early (a quick win); progress feedback; tie the step to the user's own stated goal |
| Missing prompt | A cue at the moment of ability: in-context hint, timely reminder, empty-state call to action; let users pick when to be reminded |
| Intention-action gap | Implementation intentions ("when X, I will Y"); small first commitment; scheduling the next step now; fresh-start moments |
| Social risk | Honest norms ("most teams invite two people"), only when true; private first attempts; templates that make the first try safe |
| Status quo, habit | Make the new path the default where it serves the user; attach it to an existing routine; reduce the cost of switching back |

Prefer removing barriers over adding pressure. Use loss framing, scarcity and urgency only when they are true and the user benefits; never fabricate them.

## 4. Write testable hypotheses

For each recommended change: "For [who], [change] will increase [behavior] because it removes [barrier]. We will know when [metric] moves from [baseline] to [target] in [test: A/B, staged rollout, usability sessions], without hurting [guardrail metric]." Rank by expected impact on the behavior against effort to build, and say which one to try first and why.

## 5. Ethics check (always, in every answer)

Run each recommendation through these questions and report any that fail, with a fix:

- **Aligned:** does the user end up better off by their own standards, not only the business's?
- **Transparent:** would it still work if the user saw exactly how and why it was designed? Would the team be comfortable explaining it publicly?
- **Reversible:** can the user easily say no, undo, cancel or opt out, with the same effort it took to opt in?
- **Truthful:** are all claims, counts, deadlines and scarcity real?
- **Vulnerable users:** could it harm people under stress, in debt, young, or with compulsive patterns?
- **No dark patterns:** confirmshaming, hidden costs, forced continuity, roach-motel cancellation, nagging, disguised ads, preselected paid add-ons, fake urgency.

If a request is to manipulate users against their interests, say so plainly and offer an honest alternative that serves the same business goal.

## 6. Answer shape

1. The target behavior, one line.
2. The diagnosis: the steps, where people drop, the barriers (evidenced or assumed).
3. Two to five interventions, each tied to a barrier, with a concrete design description (what changes on which screen or message).
4. The hypotheses, ranked, with the first to test.
5. The ethics check results.
6. What to measure or research next to close the biggest unknowns.

Keep it concrete and short; skip sections the person did not need (a quick copy question needs a quick answer, still with the ethics line). For a workshop or team sprint, lay out the same six steps as timed exercises with prompts for each, and the artifacts each step produces.
