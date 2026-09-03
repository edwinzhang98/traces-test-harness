// optional-pack.ts — the optional writing-protocol pack (the second delivery
// tier).
//
// This file does one thing: **append a block of text to the system prompt**. It
// blocks nothing, rewrites no tool result and never touches the environment — the
// single exception being trigger B, which appends one line to the tail of the
// context at run time (see below).
//
// ── Switch ─────────────────────────────────────────────────────────────────
//   `EW_GUARD_OPTIONAL_PACK` ("1" = on; **off by default**), exposed as
//   `optional_pack` in `[run.guards]` of config.toml. While off this file
//   registers no hook and writes nothing at all (not even optional-pack.log), so
//   it is byte-for-byte identical to the extension not being loaded.
//
// ── How it is assembled ────────────────────────────────────────────────────
//   `before_agent_start` returns a `systemPrompt`, which replaces this turn's
//   system prompt outright and chains across extensions; all this file does is
//   `event.systemPrompt + "\n\n" + pack`. The lines that belong to the task
//   prompt's own sections (`## Plan` and friends) are delivered the same way —
//   one assembly point, one switch.
//
// ── What is in the pack ────────────────────────────────────────────────────
//   7 always-on lines:
//     - scaffold text is not evidence                        → system prompt
//     - tag every number where you first state it            → system prompt
//     - batch plan, plus one `[unplanned]` line off-plan     → `## Plan`
//     - name two executable options and the deciding test    → `## Hypotheses`
//     - open the report with three sentences                 → `## Final report`
//     - three headed lists: verified / assumed / not looked at → `## Final report`
//     - close with known weaknesses, in three lines          → `## Final report`
//   3 lines under condition A (the brief states a numeric threshold / ratio /
//   budget gate):
//     - a gate ledger (registration only, no blocking sentence)
//     - write the criterion before the evidence arrives, and say so if you change it
//     - two written lines before any threshold decision
//   1 line under condition B (an action returns document bodies, or observations
//   run longer than a screen):
//     - triage each observation once: keep the citation, do not copy the body
//
// ── Trigger signals ────────────────────────────────────────────────────────
//   The brief comes from the hub: `globalThis.__EW_HARNESS_HUB__.getBrief()`,
//   published by ew-env.ts and fetched lazily — nobody asks, no subprocess.
//   **This file knows no task**; it runs regular expressions.
//   Trigger A: the brief (with the action signature lines removed) matches one of
//           five groups: percent / threshold / budget / limit / cap-phrase.
//           **Why the signature lines are removed first**: an upper bound inside a
//           signature such as `sample_rows(split, n<=20)`, or the word "limit"
//           inside an action name such as `declare_limitation(issue)`, is not a
//           threshold the brief declares. Without that step all five practice
//           briefs match, the conditional block becomes permanent, and the
//           riskiest line in the pack ends up in every episode.
//   Trigger B: (1) the brief states that some action returns a body
//           (`-> its source code` and the like) — condition B then goes straight
//           into the system prompt; (2) otherwise, at run time, when some
//           `tool_result` exceeds 4000 characters, the `context` hook appends one
//           copy at the tail (the system prompt is fixed by then). The two paths
//           are mutually exclusive: globally there is **exactly one** copy.
//
// ── Cache-prefix discipline ────────────────────────────────────────────────
//   Apart from that single tail injection under trigger B, the history is not
//   touched. The insertion point recorded is the **toolCallId of the result that
//   fired the trigger** (which was the last message at that moment, so it was a
//   tail append), and every later `context` inserts after that same anchor — the
//   position does not drift and the prefix breaks only once. Only if the anchor is
//   no longer in the history (compacted away, replaced) does it fall back to the
//   tail. Any stale copy found in the history is reclaimed, so there is always
//   exactly one.
//
// ── Evidence ───────────────────────────────────────────────────────────────
//   `optional-pack.log` in the episode directory: the switch state, the size of
//   the brief, which regular expressions matched (with the matched text), which
//   blocks were appended, the full appended text, the run-time injection, and the
//   counts from the first context rewrite.
//
// ── The one thing it needs from ew-env.ts ──────────────────────────────────
//   `getBrief()` on the hub: on first call it runs `python3 ew_act.py brief` once
//   (a free command: no action recorded, nothing in the trajectory, nothing
//   charged) and caches the result. No caller, no subprocess, so a run without
//   this extension is byte-for-byte unaffected.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────── switch (read once at load time) ───────────────────────────

function flagOn(name: string, dflt = "0"): boolean {
  const raw = process.env[name];
  const v = raw === undefined ? dflt : raw;
  return !(v === "" || v === "0" || v === "off" || v === "false");
}

const ON = flagOn("EW_GUARD_OPTIONAL_PACK", "0");

/** The run-time threshold for trigger B: a tool result whose visible body exceeds
 *  this many characters counts as "longer than a screen". */
const LONG_OBSERVATION_CHARS = 4000;

const LOG_FILE = "optional-pack.log";
const HUB_KEY = "__EW_HARNESS_HUB__";
const B_TYPE = "ew-optional-B";
const NOTE = "[HARNESS NOTE — from your own scaffold, not the environment] ";

// ─────────────────────────── the text the model sees ───────────────────────────
// The source concatenates strings to keep the lines readable; **every line it
// assembles is byte-identical to the reviewed wording**, which the test suite
// checks in the other direction.

const ALWAYS_ON = [
  "### Append to the system prompt — always on",
  "7. **Scaffold text is not evidence.** Anything marked `[HARNESS NOTE]` comes from " +
    "your own scaffold, not from the environment; a number it gives you exists only once " +
    "you have restated it in your own visible text and named the action it came from.",
  "8. **Tag every number where you first state it** — `[verified #N]` an observation said " +
    "it, `[derived #N,#M]` you computed it and show the arithmetic, `[assumed]` nothing " +
    "you did measured it.",
  "",
  "### Task prompt · `## Plan` — always on",
  "- **Batch plan.** At the start of each exploration stage, list every item you still " +
    "need, merge them into the fewest actions that cover the list, and say how many that " +
    "is. If you take an action that was not on the list, write one `[unplanned]` line " +
    "saying what changed.",
  "",
  "### Task prompt · `## Hypotheses` — always on",
  "- When the choice is between courses of action rather than between explanations, name " +
    "two you could actually execute, write the one condition that decides between them, " +
    "and take the action that tests that condition before you write the Verdict.",
  "",
  "### Task prompt · `## Final report` — always on",
  "- Open with three sentences: what you were asked for, the one trade-off you made and " +
    "why, the result with its limits.",
  "- Then three headed lists — **Verified** (each line carrying its `[action #N]`), " +
    "**Assumed, not verified** (what you assumed, why you did not test it, how the " +
    "conclusion changes if it is wrong), **Not looked at**.",
  "- Close with **Known weaknesses**: the quantity you did not measure that most affects " +
    "the answer, the bias you cannot rule out and which way it points, and what you would " +
    "buy first with one more unit of budget.",
].join("\n");

const COND_A = [
  "### Threshold-gate discipline",
  // The gate ledger registers, it does not prescribe a decision, and it contains
  // no blocking sentence. It is the highest-risk line in the pack: if the pack as
  // a whole ever measures negative, suspect this one first.
  "- **Gate ledger, written in `## Plan` and restated in the pre-submission audit.** One " +
    "row per stated threshold: quantity | threshold and direction | the action that " +
    "measures it | what you have measured so far | measured / partly / not measured. A row " +
    'you can only mark "not measured" is a limitation to declare, not a reason to drop the ' +
    "option.",
  // Fix the criterion up front and say so if you change it — deliberately with no
  // default supplied, since supplying one would make it a preference rather than a
  // discipline.
  "- **Write the criterion before the evidence arrives.** Say now what you will do if an " +
    "estimate lands close to a threshold, if the budget will not cover another " +
    "measurement, and if a new observation contradicts something you had settled; if you " +
    "later decide by a different criterion, say so in writing and why.",
  // The written comparison only; the "so measure rather than gamble" conclusion
  // sentence was deliberately dropped.
  "- **Before any decision that turns on a threshold, write two lines:** the distance " +
    "between your estimate and the threshold set against the width of your uncertainty, " +
    "and the cost of one more measurement as a share of the budget you have left. Write " +
    "both even if you then decide to act without measuring again.",
].join("\n");

// Triage: "keep the citation, do not copy the body" — it never says "discard".
const COND_B_LINE =
  "- **Triage each observation once:** working detail you will not reuse stays out of " +
  "your notes; anything a later decision rests on gets restated with its `[action #N]`; " +
  "full text stays in the log and is re-read by action rather than copied forward.";

const COND_B = [
  "### Long observations",
  COND_B_LINE,
].join("\n");

/** The copy pinned to the tail of the context when the trigger only fires at run
 *  time (the system prompt is already fixed by then, so it has to go via `context`). */
const COND_B_TAIL =
  `${NOTE}One more line of your writing protocol, added now that observations are ` +
  "running longer than a screen:\n" +
  COND_B_LINE;

/** Exposed so the test suite can compare the assembled text against the reviewed
 *  wording. */
export const PACK_BLOCKS = {
  always: ALWAYS_ON,
  condA: COND_A,
  condB: COND_B,
  tail: COND_B_TAIL,
  longObservationChars: LONG_OBSERVATION_CHARS,
};

// ─────────────────────────── trigger signals (pure regex; no task knowledge) ───────────────────────────

/** An action signature line in the brief: `name(args) -> what it returns   [cost]`. */
const SIG_LINE_RE = /^\s*[a-z_][a-z0-9_]*\(/;

interface Pattern {
  name: string;
  re: RegExp;
}

/**
 * Trigger A: the brief declares a numeric threshold / ratio / budget gate.
 *
 * The exact reading (it is written into optional-pack.log, so judge it by this):
 *   * `limit` is matched on a word boundary, so it does **not** match
 *     `declare_limitation` / `limitation` / `limited` — those are an action name
 *     and an adjective, not a threshold the brief declares.
 *   * The action signature lines are removed before matching, so an upper bound
 *     like `n<=20` does not count (see the file header for why).
 */
const TRIGGER_A_PATTERNS: Pattern[] = [
  { name: "percent", re: /\d+\s*%/ },
  { name: "threshold", re: /\bthresholds?\b/i },
  { name: "budget", re: /\bbudgets?\b/i },
  { name: "limit", re: /\blimits?\b/i },
  { name: "cap-phrase", re: /at most|no more than|≤|<=/i },
];

/**
 * Trigger B via the brief: some action's return value is described as a **body**.
 *
 * Only return descriptions (after `->`) are considered, and "contents" is
 * deliberately not accepted ("a sample of its contents" is a listing, not a body):
 * the 4000-character run-time check is the backstop, so this path can afford to be
 * conservative.
 */
const TRIGGER_B_PATTERNS: Pattern[] = [
  {
    name: "returns-document-body",
    re: /->[^\n]*\b(?:source code|full text|raw text|document text|document body|the text of|body|bodies|transcript|excerpt|passage|article)\b/i,
  },
];

function withoutSignatureLines(brief: string): string {
  return brief
    .split("\n")
    .filter((l) => !SIG_LINE_RE.test(l))
    .join("\n");
}

/** The names that matched, with the matched text (the text goes into the log, so
 *  a false positive can be judged after the fact). */
function scan(text: string, patterns: Pattern[]): Array<{ name: string; hit: string }> {
  const out: Array<{ name: string; hit: string }> = [];
  for (const p of patterns) {
    const m = p.re.exec(text);
    if (m) out.push({ name: p.name, hit: m[0].slice(0, 60) });
  }
  return out;
}

export function triggerA(brief: string): Array<{ name: string; hit: string }> {
  return scan(withoutSignatureLines(brief || ""), TRIGGER_A_PATTERNS);
}

export function triggerBFromBrief(brief: string): Array<{ name: string; hit: string }> {
  return scan(brief || "", TRIGGER_B_PATTERNS);
}

// ─────────────────────────── episode directory and evidence ───────────────────────────

function runDir(ctx?: ExtensionContext): string {
  const c = ctx && typeof ctx.cwd === "string" ? ctx.cwd : "";
  return c || process.cwd();
}

function note(dir: string, msg: string): void {
  try {
    appendFileSync(join(dir, LOG_FILE), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never take down an episode */
  }
}

function errText(e: unknown): string {
  const any = e as { message?: unknown };
  return String(any?.message || e).slice(0, 500);
}

function briefFromHub(dir: string): string {
  try {
    const g = globalThis as unknown as Record<string, { getBrief?: () => string }>;
    const h = g[HUB_KEY];
    if (!h || typeof h.getBrief !== "function") {
      note(dir, "hub has no getBrief(): the conditional blocks cannot be evaluated, " +
        "shipping the always-on block only");
      return "";
    }
    return String(h.getBrief() || "");
  } catch (e) {
    note(dir, `getBrief() failed: ${errText(e)}`);
    return "";
  }
}

// ─────────────────────────── messages (the minimum structural surface) ───────────────────────────

interface MsgLike {
  role?: string;
  customType?: string;
  toolCallId?: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  const blocks = (content || []) as Array<{ type?: string; text?: string }>;
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

// ─────────────────────────── extension entry point ───────────────────────────

/** The brief path already put condition B into the system prompt → no run-time
 *  injection (globally exactly one copy). */
let bInSystemPrompt = false;
/** Whether the run-time trigger has fired. */
let bInjected = false;
/** The insertion anchor: the toolCallId of the result that fired the trigger
 *  (which was the last message at that moment). */
let bAnchorId = "";
let loggedContext = false;

export default function (pi: ExtensionAPI) {
  // Off = this file hooks nothing and writes nothing. Byte-for-byte identical to
  // not loading it.
  if (!ON) return;

  // 1. The one assembly point: append the pack to this turn's system prompt.
  pi.on("before_agent_start", (event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      const base = (event as { systemPrompt?: unknown }).systemPrompt;
      if (typeof base !== "string") {
        // With no system prompt in hand, return **nothing**: returning `pack`
        // itself would replace the entire system prompt with just this pack
        // (`before_agent_start` replaces outright), which is worse than not
        // loading the extension at all.
        note(dir, `before_agent_start gave no systemPrompt (${typeof base}); pack NOT ` +
          "appended this turn — refusing to replace the whole system prompt with the pack");
        return undefined;
      }
      const brief = briefFromHub(dir);
      const a = triggerA(brief);
      const b = triggerBFromBrief(brief);
      const blocks = [ALWAYS_ON];
      if (a.length) blocks.push(COND_A);
      if (b.length) {
        blocks.push(COND_B);
        bInSystemPrompt = true;
      }
      const pack = blocks.join("\n\n");
      note(
        dir,
        "before_agent_start: pack ON; " +
          `brief ${brief.length} chars; ` +
          `trigger A ${a.length ? "FIRED" : "no"} [${a.map((h) => `${h.name}:${h.hit}`).join(", ")}]; ` +
          `trigger B (brief) ${b.length ? "FIRED" : "no"} [${b.map((h) => `${h.name}:${h.hit}`).join(", ")}]; ` +
          `blocks = always-on${a.length ? " + conditional-A" : ""}${b.length ? " + conditional-B" : ""}; ` +
          `appended ${pack.length} chars to a ${base.length}-char system prompt`,
      );
      note(dir, `appended text follows >>>\n${pack}\n<<< end of appended text`);
      return { systemPrompt: `${base}\n\n${pack}` };
    } catch (e) {
      note(dir, `before_agent_start hook failed: ${errText(e)}`);
    }
    return undefined;
  });

  // 2. The run-time half of trigger B: some tool result runs longer than a screen.
  //    Observation only; not one character is changed.
  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      if (bInSystemPrompt || bInjected) return undefined;
      const text = textOf((event as { content?: unknown }).content);
      if (text.length <= LONG_OBSERVATION_CHARS) return undefined;
      bInjected = true;
      bAnchorId = String((event as { toolCallId?: string }).toolCallId || "");
      const d = (event as { details?: { ew?: { kind?: unknown; name?: unknown } } }).details;
      const ew = d && typeof d === "object" ? d.ew : undefined;
      note(
        dir,
        `trigger B (runtime) FIRED: tool result ${text.length} chars > ${LONG_OBSERVATION_CHARS} ` +
          `(toolCallId=${bAnchorId || "?"} kind=${String(ew?.kind ?? "?")} ` +
          `name=${String(ew?.name ?? "?")}); the conditional-B line will be pinned right ` +
          "after this result",
      );
    } catch (e) {
      note(dir, `tool_result hook failed: ${errText(e)}`);
    }
    return undefined; // observation only
  });

  // 3. Put that one line into the context: exactly one copy, pinned after the
  //    anchor (which was the tail at the moment it fired).
  pi.on("context", (event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      if (!bInjected) return undefined; // not fired: nothing is changed
      const msgs = (event as { messages: MsgLike[] }).messages;
      const out: unknown[] = [];
      let dropped = 0;
      let placed = false;
      for (const m of msgs) {
        if (m && m.role === "custom" && m.customType === B_TYPE) {
          dropped += 1; // reclaim the stale copy; only the one appended below survives
          continue;
        }
        out.push(m);
        if (!placed && bAnchorId && m && m.role === "toolResult" && m.toolCallId === bAnchorId) {
          out.push(makeBMessage());
          placed = true;
        }
      }
      if (!placed) out.push(makeBMessage()); // anchor not in the history → fall back to the tail
      if (!loggedContext) {
        loggedContext = true;
        note(
          dir,
          `first rewritten context: 1 conditional-B line inserted ` +
            `${placed ? `right after [${bAnchorId}]` : "at the tail (anchor not found)"}, ` +
            `${dropped} stale copies reclaimed, ${msgs.length} → ${out.length} messages`,
        );
      }
      return { messages: out as never };
    } catch (e) {
      note(dir, `context hook failed: ${errText(e)}`);
    }
    return undefined;
  });
}

function makeBMessage(): Record<string, unknown> {
  return {
    role: "custom",
    customType: B_TYPE,
    content: COND_B_TAIL,
    display: false,
    timestamp: Date.now(),
  };
}
