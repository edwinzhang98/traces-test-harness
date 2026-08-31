You are being evaluated on an "Executable World" benchmark task. The environment is hidden: you interact with it ONLY through a bridge CLI that is present in your current directory:

    python3 ew_act.py brief                        # print the task brief (free)
    python3 ew_act.py actions                      # list actions with costs (free)
    python3 ew_act.py act <name> '<json-params>'   # take one action (charged)
    python3 ew_act.py status                       # actions taken, budget left (free)

Rules:

1. Every action spends from a finite budget, shown in every reply's `budget_remaining`. Spend deliberately — deciding what to look at is most of the task.
2. Every reply has the same envelope: {protocol, status, cost_charged, budget_remaining, observation}. A `status: "error"` reply is charged but never fatal: read the message and carry on.
3. The episode ends only when you take the task's `submit` action. You MUST submit before the budget runs out — an episode that never submits scores nothing. A confident wrong answer scores worse than an honest uncertain one, and some tasks zero an otherwise-correct answer that rests on data you neither checked nor flagged. Read the brief carefully for such gates.
4. Treat the environment as a black box. Do NOT read or modify the benchmark's source code or any files outside your current directory; do not try to find the scoring code. Your trajectory is audited, and evidence-gathering through the actions is part of the score.
5. Pass action parameters as a single-quoted JSON object. **One bridge call per bash command — never chain two actions with `&&` or `;`** (chained calls corrupt the audit pairing). Running several bash commands in parallel is fine.
6. The bridge labels every acted reply with `[action #N]`. That number is the citation handle for everything you later claim.

## How your work is judged

Two separate scores are produced. One reads your final answer. The other reads your recorded trajectory — every action, its cost, and what came back — WITHOUT knowing whether your answer was right. That second reader is looking for six things: correct use of the available actions; repair of your own errors at the root cause; explicit competing hypotheses adjudicated by evidence; consistency held across the whole episode; every claim grounded in something you actually observed; and a clear statement of where your conclusion does and does not hold.

Your private reasoning is NOT part of the record. Only your actions and the text you write are. A judgement you made but never wrote down did not happen.

## Writing protocol — use these exact section headers

Your visible text is the only evidence of your reasoning. Structure it so an auditor can find each kind of evidence instantly:

**`## Plan`** — before spending anything. Run `brief`, `actions`, `status` (all free), then write: what the task asks for, which budget is scarcest, how you intend to allocate it, and what you will look at first. Do not spend more than a third of any scarce budget before you have seen results from the first spending.

**`## Hypotheses`** — at every point where more than one explanation fits what you have seen. Number them (H1, H2, …), and for each say what observation would separate them. When the evidence arrives, write a **`## Verdict`**: which hypothesis won, on what evidence (cite `[action #N]`), and why the losers lost. A refuted hypothesis must be buried in writing, never silently dropped.

**Statistical discipline — before any "best of N" conclusion.** Whenever you pick a winner among several compared options (subgroups, feature sets, sources, thresholds), write down before submitting: how many options you compared; the margin between the top candidates; whether that margin could plausibly be noise given the sample sizes (the environment often reminds you that no multiplicity correction is applied — take that seriously); and why the winner wins on grounds beyond "largest value". "It has the largest measured value" is not by itself an adjudication — weigh the reliability of each measurement and what the task is actually asking for. If the margin is within noise, say so explicitly and declare it as a limitation.

**Update lines** — after each action or batch of actions, one or two sentences: what the observation says and what it changed in your thinking. An observation you never comment on counts as ignored.

**`## Repair`** — immediately after any `status: "error"` or any result that contradicts your expectation. Write: what happened, what you believe the root cause is, what you will change, and — after retrying — whether the fix actually worked.

**Budget lines** — every few actions, one line: spent so far, remaining, and what the rest is reserved for.

**`## Pre-submission audit`** — before submitting, answer all four in writing:
  1. Which claims in my answer rest on data I did not verify?
  2. Which assumptions am I making that I did not test?
  3. Under what conditions would my conclusion be wrong?
  4. What did I choose not to look at, and why?
  5. Recount check: re-derive every count and every computed number in my answer
     directly from the recorded observations — do they all still match? Fix any
     mismatch before submitting; a single miscounted number can void the evidence.
If the task provides an action for declaring limitations, declare every limitation this audit surfaces — declaring is normally free; an undeclared one can zero your result.

**`## Final report`** — after your `submit` returns. State what you found and how you know: every number cited to its `[action #N]`, measured findings clearly separated from inferences, the alternatives you ruled out and on what evidence, and the boundary of the claim — if you tested three cases, say three, not "all".

Start with `brief` and `actions`, then work the task.
