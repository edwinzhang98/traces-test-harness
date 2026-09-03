// phases.ts — the strong form of phase gating.
//
// The weak form (`EW_GUARD_PHASES=1`, implemented in guards.ts) only gates *when*
// you may submit: irreversible actions are held during EXPLORE, the episode moves
// to DECIDE on a budget fraction or on an explicit `ew_phase_done`, and a handoff
// summary is printed at the switch.
//
// The strong form (this file, `EW_GUARD_PHASES_RESET=1`) does three more things at
// the moment of the switch:
//   1. **Context reset.** From DECIDE on, the tool result of every **charged**
//      action taken during EXPLORE is replaced by a one-line placeholder
//      `[action #N <name> — archived; call ew_recall N to retrieve]`. The model's
//      own writing, and every tool CALL (arguments included), are left intact — so
//      action numbers and citations still hold. The free commands
//      (brief / actions / status) are not touched: the brief *is* the task, and
//      replacing it would delete the question from the context.
//   2. **The handoff summary is pinned at the end.** `before_agent_start` injects
//      a message with `customType: "ew-handoff"` (for multi-turn/interactive use),
//      and the `context` hook reclaims every stale copy in the history each turn
//      and re-appends one **after the newest message** — so there is exactly one
//      copy at any time and its insertion point is always the tail, which keeps
//      the prefix cache from being invalidated by it.
//      Note: the runner drives batches with a single `-p` prompt, where
//      `before_agent_start` fires once per episode (before the switch), so the
//      tail injection in `context` is what actually does the work; both hooks are
//      registered so interactive use behaves correctly too.
//   3. **A free `ew_recall(n)` tool** that retrieves an archived observation
//      verbatim.
//
// Cache-prefix discipline: the reset happens exactly once — the archived set is
// frozen at the switch and written into `phase.json`, and every later `context`
// applies the same substitution over that same set, so the rewritten history is
// byte-identical from then on. Nothing produced during DECIDE is ever archived.
// The history therefore breaks once, at the switch, and is stable afterwards.
//
// The interface to guards.ts (the only coupling): when guards produces the handoff
// summary it notifies this file once through the hub callback
// `hub().onPhaseHandoff(dir, text, phase)`. Without this file loaded that field is
// undefined and the call site is an optional chain — the text the model sees is
// byte-for-byte unchanged. Fallback: if the callback never arrives (an older
// guards.ts), `context`/`tool_result` notice the switch themselves by reading the
// phase field of `.guard_state.json`, and log that the summary was reconstructed.
//
// What it writes (all in the episode directory, all four written by **this** file,
// and none of them produced while the switch is off):
//   observations.jsonl  one line per charged action: {n, name, params, memoHit, callId, text}
//                       — written by this file's own `tool_result` hook rather than
//                       by ew-env: it is chained after guards, so what it sees is
//                       exactly the text the model saw (numbering and notices
//                       already applied), which is what ew_recall must return.
//                       ew-env.ts therefore needs no change at all.
//   handoff.md          the pinned text, byte-identical to what is injected.
//   phase.json          {reset_done, ts, entered_by, archived:[{id,n,name}], n_actions}
//   phases.log          diagnostics and evidence. The stable lines (all carrying an
//                       ISO timestamp) are:
//                         context reset at explore→decide (…): N action results archived
//                         first rewritten context: R/N archived results replaced, …
//                         recall #N hit, C chars   /   recall #N miss, 0 chars
//                         memo hit after reset: replayed #N verbatim, C chars
//                       The last two are the two channels through which archived
//                       material flows back — recall is what the model asks for,
//                       a memo hit is what it gets for free by repeating an
//                       idempotent action — and both have to be counted.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ─────────────────────────── switches (read once at load time) ───────────────────────────

function flagOn(name: string, dflt = "1"): boolean {
  const raw = process.env[name];
  const v = raw === undefined ? dflt : raw;
  return !(v === "" || v === "0" || v === "off" || v === "false");
}

const PHASES = flagOn("EW_GUARD_PHASES", "0");
const RESET = flagOn("EW_GUARD_PHASES_RESET", "0");

// ─────────────────────────── the text the model sees ───────────────────────────

const NOTE = "[HARNESS NOTE — from your own scaffold, not the environment] ";

/** The archive placeholder (an entire tool result is replaced by this one line). */
function placeholderText(n: number, name: string): string {
  return `[action #${n} ${name} — archived; call ew_recall ${n} to retrieve]`;
}

/**
 * The head of the pinned briefing (followed by the guards handoff text and the
 * fact table).
 *
 * Both scope statements are deliberately limited to "**before** the handoff", and
 * it says so explicitly for what came after: the summary is re-attached after the
 * newest message, so the model reads it only after reading the new DECIDE-phase
 * observations, and nothing recorded after the freeze is archived or tabulated.
 * When parallel tool calls straddle the switch, those observations are plainly
 * still in the context in full — a head claiming otherwise would be false.
 * It also avoids claiming this is the only copy: the guards handoff text is also
 * inlined, permanently, in the tool result that triggered the switch.
 */
const HANDOFF_HEAD =
  `${NOTE}DECIDE-PHASE BRIEFING — this block is pinned: your scaffold re-attaches it at\n` +
  "the end of your context on every turn, so from here on it is always the last thing you\n" +
  "read. The explore-phase observations are no longer in the transcript: the reply to every\n" +
  "charged action taken BEFORE this handoff has been replaced by a one-line placeholder.\n" +
  "Actions you have taken since the handoff are untouched — their replies are still in the\n" +
  "transcript above, in full. Your own writing and every tool call you made are untouched\n" +
  "too, so [action #N] citations still point at the same actions, and the free replies\n" +
  "(brief / actions / status) are untouched as well.\n" +
  'To read any archived observation back, verbatim and free: ew_recall {"n": <number>}.';

/** The fact table's header. */
const FACTS_HEAD =
  "  facts recorded during EXPLORE — numbers exactly as the environment printed them:";

/**
 * The fact table's footer. Its scope is limited to the archived set, and the
 * action-number span is printed so the model can reconcile it itself: actions
 * taken after the switch are neither in the table nor archived, and their text is
 * still in the context.
 */
function factsTail(rows: ObsRow[]): string {
  let span = "";
  if (rows.length) {
    const ns = rows.map((r) => r.n);
    const lo = Math.min(...ns);
    const hi = Math.max(...ns);
    span = lo === hi ? ` (#${lo})` : ` (#${lo}–#${hi})`;
  }
  return (
    `  This table covers the actions archived at the handoff${span}; nothing before the\n` +
    "  handoff was measured beyond it. Actions taken after the handoff are not in the table\n" +
    "  — their observations are still in the transcript above. The table is a summary, not a\n" +
    "  substitute for the record: recall the full observation before you make one of these\n" +
    "  numbers load-bearing."
  );
}

/** The stand-in head used on the fallback path (no callback from guards). */
const HANDOFF_FALLBACK =
  `${NOTE}PHASE HANDOFF — you are now in the DECIDE phase. 'submit' is available again;\n` +
  "every other mechanism (the one-shot submit gate included) is unchanged.";

const RECALL_USAGE =
  'usage: ew_recall {"n": <action number>}\n' +
  "  Prints the observation recorded for [action #N] exactly as it first arrived. Free:\n" +
  "  nothing is forwarded, nothing is charged, nothing is recorded as an action.";

// ─────────────────────────── episode directory and files ───────────────────────────

const OBS_FILE = "observations.jsonl";
const PHASE_FILE = "phase.json";
const HANDOFF_FILE = "handoff.md";
const LOG_FILE = "phases.log";
const GUARD_STATE = ".guard_state.json";
const HANDOFF_TYPE = "ew-handoff";

interface ObsRow {
  /** The action number (for a memo hit, the number of the action replayed) */
  n: number;
  name: string;
  params: Record<string, unknown>;
  /** The action number a memo hit replayed, otherwise null */
  memoHit: number | null;
  /** pi's toolCallId: how the `context` hook recognises the result to archive */
  callId: string;
  /** The text the model saw at the time (after guards processed it) */
  text: string;
}

interface ArchivedRow {
  id: string;
  n: number;
  name: string;
}

interface PhaseFile {
  reset_done: boolean;
  ts: number;
  entered_by: string;
  /** The frozen archive set: only charged actions recorded before the switch */
  archived: ArchivedRow[];
  n_actions: number;
  /** Whether the summary came from guards or was reconstructed */
  handoff_source: "guards" | "fallback";
}

let obsMem: ObsRow[] | null = null;
let phaseMem: PhaseFile | null = null;
let handoffMem: string | null = null;
/** Evidence: count the first real context rewrite after the reset (a mechanism
 *  change has to report its real trigger count). */
let loggedRewrite = false;
/** Report an empty pinned body once, not every turn. */
let loggedEmptyPin = false;

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
  const any = e as { stderr?: unknown; message?: unknown };
  return String(any?.stderr || any?.message || e).slice(0, 500);
}

function readIf(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  } catch {
    return null;
  }
}

/** Observation records: memory first, refilled from disk (same episode
 *  directory) if the process restarts. */
function observations(dir: string): ObsRow[] {
  if (obsMem) return obsMem;
  const rows: ObsRow[] = [];
  const raw = readIf(join(dir, OBS_FILE));
  if (raw) {
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line) as ObsRow);
      } catch (e) {
        note(dir, `observations line unreadable: ${errText(e)}`);
      }
    }
  }
  obsMem = rows;
  return rows;
}

function recordObservation(dir: string, row: ObsRow): void {
  observations(dir).push(row);
  try {
    appendFileSync(join(dir, OBS_FILE), `${JSON.stringify(row)}\n`);
  } catch (e) {
    note(dir, `observations write failed: ${errText(e)}`);
  }
}

/** Phase state: memory first, restored from phase.json after a process restart —
 *  that is what guarantees "the reset happens exactly once". */
function phase(dir: string): PhaseFile | null {
  if (phaseMem) return phaseMem;
  const raw = readIf(join(dir, PHASE_FILE));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as PhaseFile;
    if (d && typeof d === "object" && d.reset_done) {
      phaseMem = d;
      return phaseMem;
    }
  } catch (e) {
    note(dir, `phase.json unreadable: ${errText(e)}`);
  }
  return null;
}

/**
 * The pinned body. When it cannot be read this returns "" and the callers append
 * **nothing** — pi turns a custom message into a user message, and an empty user
 * message is rejected outright by some providers. An empty result is not cached
 * either, so a write that lagged by a moment is not recorded as empty forever.
 */
function handoffText(dir: string): string {
  if (handoffMem) return handoffMem;
  const t = readIf(join(dir, HANDOFF_FILE)) ?? "";
  if (t) handoffMem = t;
  return t;
}

/** Report an empty body once. */
function noteEmptyPin(dir: string): void {
  if (loggedEmptyPin) return;
  loggedEmptyPin = true;
  note(dir, "pinned handoff text is empty (handoff.md unreadable) — nothing pinned this turn");
}

// ─────────────────────────── a JSON scanner that keeps literals verbatim ───────────────────────────
//
// The fact table has to quote key numbers **exactly** as printed. Re-serialising a
// value that went through JSON.parse rewrites float formatting (`1e-05` → `0.00001`,
// `1.0` → `1`), so this scans the original text itself and carries every scalar
// along as the literal that appeared there. The scanner understands JSON only;
// on any shape it does not recognise it gives up (returns null) and the caller
// falls back to leaving that observation out of the table.

interface RawNode {
  kind: "object" | "array" | "string" | "number" | "literal";
  raw: string;
  entries?: Array<[string, RawNode]>;
  items?: RawNode[];
}

const WS = " \t\n\r";

function skipWs(s: string, i: number): number {
  while (i < s.length && WS.includes(s[i])) i += 1;
  return i;
}

/** i points at the opening quote; returns the index after the closing quote
 *  (escapes skipped per the JSON rules). */
function endOfString(s: string, i: number): number {
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    j += 1;
  }
  return -1;
}

function scanValue(s: string, i0: number, depth = 0): { node: RawNode; i: number } | null {
  if (depth > 12) return null;
  const i = skipWs(s, i0);
  if (i >= s.length) return null;
  const c = s[i];
  if (c === '"') {
    const j = endOfString(s, i);
    if (j < 0) return null;
    return { node: { kind: "string", raw: s.slice(i, j) }, i: j };
  }
  if (c === "{") {
    const entries: Array<[string, RawNode]> = [];
    let k = skipWs(s, i + 1);
    if (s[k] === "}") return { node: { kind: "object", raw: s.slice(i, k + 1), entries }, i: k + 1 };
    while (k < s.length) {
      if (s[k] !== '"') return null;
      const ke = endOfString(s, k);
      if (ke < 0) return null;
      let key: string;
      try {
        key = JSON.parse(s.slice(k, ke)) as string;
      } catch {
        return null;
      }
      k = skipWs(s, ke);
      if (s[k] !== ":") return null;
      const v = scanValue(s, k + 1, depth + 1);
      if (!v) return null;
      entries.push([key, v.node]);
      k = skipWs(s, v.i);
      if (s[k] === ",") {
        k = skipWs(s, k + 1);
        continue;
      }
      if (s[k] === "}") return { node: { kind: "object", raw: s.slice(i, k + 1), entries }, i: k + 1 };
      return null;
    }
    return null;
  }
  if (c === "[") {
    const items: RawNode[] = [];
    let k = skipWs(s, i + 1);
    if (s[k] === "]") return { node: { kind: "array", raw: s.slice(i, k + 1), items }, i: k + 1 };
    while (k < s.length) {
      const v = scanValue(s, k, depth + 1);
      if (!v) return null;
      items.push(v.node);
      k = skipWs(s, v.i);
      if (s[k] === ",") {
        k = skipWs(s, k + 1);
        continue;
      }
      if (s[k] === "]") return { node: { kind: "array", raw: s.slice(i, k + 1), items }, i: k + 1 };
      return null;
    }
    return null;
  }
  let j = i;
  while (j < s.length && !",}]".includes(s[j]) && !WS.includes(s[j])) j += 1;
  const raw = s.slice(i, j);
  if (!raw) return null;
  return { node: { kind: /^-?\d/.test(raw) ? "number" : "literal", raw }, i: j };
}

/** Cut the environment envelope (the first complete JSON object) out of the text
 *  the model saw. */
function scanEnvelope(text: string): RawNode | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  const r = scanValue(text, start);
  return r && r.node.kind === "object" ? r.node : null;
}

function entryOf(node: RawNode, key: string): RawNode | null {
  for (const [k, v] of node.entries || []) if (k === key) return v;
  return null;
}

function unquote(raw: string): string {
  try {
    return JSON.parse(raw) as string;
  } catch {
    return raw;
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

const MAX_BITS = 10;

/**
 * Flatten an observation into `path=literal` fragments.
 *
 * Short scalars (booleans, strings up to 40 characters) are kept as well as
 * numbers: on several of these tasks the load-bearing facts are not numeric at
 * all — a judgement comes back as 'high'/'spam', a fetch as a content hash and a
 * crawlable flag — and a numbers-only fact table would be empty there. Long
 * arrays (fifty document ids, say) are reduced to their length, which is exactly
 * the noise the reset is meant to clear.
 */
function factBits(node: RawNode, path: string, out: string[], depth = 0): void {
  if (out.length >= MAX_BITS) return;
  if (node.kind === "object") {
    if (depth >= 3) {
      out.push(`${path}={…}`);
      return;
    }
    for (const [k, v] of node.entries || []) {
      factBits(v, path ? `${path}.${k}` : k, out, depth + 1);
      if (out.length >= MAX_BITS) return;
    }
    return;
  }
  if (node.kind === "array") {
    const items = node.items || [];
    if (!items.length) {
      out.push(`${path}=[]`);
      return;
    }
    // Short all-scalar arrays are listed as they are (`arms=[drug, placebo]` is
    // more use than `arms=[2 items]`); long ones keep only a count.
    const scalar = items.every((it) => it.kind !== "object" && it.kind !== "array");
    if (scalar && items.length <= 6) {
      const body = items
        .map((it) => (it.kind === "string" ? clip(unquote(it.raw).replace(/\s+/g, " ").trim(), 24) : it.raw))
        .join(", ");
      if (body.length <= 60) {
        out.push(`${path}=[${body}]`);
        return;
      }
    }
    if (items.length <= 2 && items.some((it) => it.kind === "object")) {
      items.forEach((it, k) => factBits(it, `${path}[${k}]`, out, depth + 1));
      return;
    }
    out.push(`${path}=[${items.length} items]`);
    return;
  }
  if (node.kind === "string") {
    // Collapse newlines and runs of spaces before clipping: alignment whitespace
    // in source-code-like observations would otherwise eat the whole 40-character
    // allowance before any content appears.
    out.push(`${path}=${clip(unquote(node.raw).replace(/\s+/g, " ").trim(), 40)}`);
    return;
  }
  out.push(`${path}=${node.raw}`);
}

/** Parameters in compact form: `sample_source(source=src_00, n=50)`. */
function paramsText(params: Record<string, unknown> | undefined): string {
  const p = params && typeof params === "object" ? params : {};
  const keys = Object.keys(p);
  if (!keys.length) return "";
  const bits = keys.slice(0, 4).map((k) => {
    const v = (p as Record<string, unknown>)[k];
    const s = typeof v === "string" ? v : JSON.stringify(v) ?? String(v);
    return `${k}=${clip(String(s), 32)}`;
  });
  if (keys.length > 4) bits.push("…");
  return `(${bits.join(", ")})`;
}

/** One row of the fact table. */
function factLine(row: ObsRow): string {
  const head = `    #${row.n} ${row.name}${paramsText(row.params)}`;
  if (row.memoHit !== null) return `${head} → (cache replay of #${row.memoHit}; nothing charged)`;
  const env = scanEnvelope(row.text);
  if (!env) return `${head} → (observation not parsed; ew_recall ${row.n} for the record)`;
  const status = entryOf(env, "status");
  const obs = entryOf(env, "observation");
  if (status && unquote(status.raw) !== "ok") {
    const msg = obs ? clip(obs.raw.replace(/\s+/g, " "), 120) : "(no message)";
    return `${head} → ERROR ${msg}`;
  }
  if (!obs) return `${head} → (empty observation)`;
  const bits: string[] = [];
  factBits(obs, "", bits);
  if (!bits.length) return `${head} → (no scalar facts)`;
  const body = bits.join(", ") + (bits.length >= MAX_BITS ? ", …" : "");
  return `${head} → ${clip(body, 240)}`;
}

/**
 * Row limit for the fact table. One row per charged action before the freeze, up
 * to ~450 characters each, and the whole table goes through the model every turn.
 * The practice tasks produce 9–14 rows, but an enlarged instance scales the budget
 * and the row count with it, so cap it at 40 and report the rest as a count and a
 * number range — they can still be retrieved with ew_recall.
 */
const MAX_FACT_ROWS = 40;

function factsTable(rows: ObsRow[]): string {
  if (!rows.length) return `${FACTS_HEAD}\n    (no charged action was taken)\n${factsTail(rows)}`;
  const lines = rows.slice(0, MAX_FACT_ROWS).map(factLine);
  const rest = rows.slice(MAX_FACT_ROWS);
  if (rest.length) {
    const ns = rest.map((r) => r.n);
    lines.push(
      `    +${rest.length} more actions (#${Math.min(...ns)}–#${Math.max(...ns)}) ` +
        "— ew_recall them by number",
    );
  }
  return `${FACTS_HEAD}\n${lines.join("\n")}\n${factsTail(rows)}`;
}

// ─────────────────────────── the switch: a one-off reset ───────────────────────────

interface GuardPhase {
  phase?: string;
  entered_by?: string;
  measured?: string[];
  unmeasured?: string[];
}

function guardPhase(dir: string): GuardPhase | null {
  const raw = readIf(join(dir, GUARD_STATE));
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { phase?: GuardPhase | null };
    return d && typeof d === "object" && d.phase && d.phase.phase === "decide" ? d.phase : null;
  } catch (e) {
    note(dir, `.guard_state.json unreadable: ${errText(e)}`);
    return null;
  }
}

/** The fallback summary (no callback from guards): the head plus the model's own
 *  two lists. */
function fallbackHandoff(p: GuardPhase): string {
  const out = [HANDOFF_FALLBACK, `  entered by:    ${p.entered_by ?? "(unknown)"}`];
  const measured = p.measured || [];
  const unmeasured = p.unmeasured || [];
  if (measured.length || unmeasured.length) {
    out.push("  measured (your own list):");
    out.push(...(measured.length ? measured : ["(none given)"]).map((s) => `    - ${s}`));
    out.push("  knowingly unmeasured (your own list):");
    out.push(...(unmeasured.length ? unmeasured : ["(none given)"]).map((s) => `    - ${s}`));
  }
  return out.join("\n");
}

/**
 * Once per episode: freeze the archive set and write handoff.md / phase.json.
 * An empty `guardsText` means this is the fallback path.
 */
function doReset(dir: string, guardsText: string | null, enteredBy: string): void {
  if (phase(dir)) return; // already reset (including a restore from phase.json after a restart)
  const rows = observations(dir);
  const gp = guardPhase(dir);
  const head = guardsText && guardsText.trim()
    ? guardsText
    : fallbackHandoff(gp || { entered_by: enteredBy });
  const text = `${HANDOFF_HEAD}\n\n${head}\n\n${factsTable(rows)}\n`;
  const p: PhaseFile = {
    reset_done: true,
    ts: Math.round(Date.now() / 10) / 100,
    entered_by: gp?.entered_by || enteredBy,
    archived: rows.map((r) => ({ id: r.callId, n: r.n, name: r.name })),
    n_actions: rows.length,
    handoff_source: guardsText && guardsText.trim() ? "guards" : "fallback",
  };
  phaseMem = p;
  handoffMem = text;
  try {
    writeFileSync(join(dir, HANDOFF_FILE), text);
  } catch (e) {
    note(dir, `handoff.md write failed: ${errText(e)}`);
  }
  try {
    writeFileSync(join(dir, PHASE_FILE), JSON.stringify(p, null, 2));
  } catch (e) {
    note(dir, `phase.json write failed: ${errText(e)}`);
  }
  note(
    dir,
    `context reset at explore→decide (entered_by=${p.entered_by}, source=${p.handoff_source}): ` +
      `${p.archived.length} action results archived`,
  );
}

/** Fallback detection: no callback from guards, but the state file already says decide. */
function checkTransition(dir: string): void {
  if (phase(dir)) return;
  const gp = guardPhase(dir);
  if (!gp) return;
  note(dir, "transition detected from .guard_state.json (no handoff callback arrived)");
  doReset(dir, null, gp.entered_by || "unknown");
}

// ─────────────────────────── messages (the minimum structural surface) ───────────────────────────

interface MsgLike {
  role?: string;
  customType?: string;
  toolCallId?: string;
  content?: unknown;
}

function textOf(content: unknown): string {
  const blocks = (content || []) as Array<{ type?: string; text?: string }>;
  if (typeof content === "string") return content;
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

// ─────────────────────────── extension entry point ───────────────────────────

const recallParams = Type.Object({
  n: Type.Number({
    description: "The action number to retrieve, as printed in [action #N].",
  }),
});

export default function (pi: ExtensionAPI) {
  // Off = this file registers nothing at all: no tool, no hook, no touching the
  // hub. Byte-for-byte identical to not loading the extension (and equally so
  // when the phase gate itself is off, since then there is no switch to speak of).
  if (!RESET || !PHASES) return;

  // 1. Be notified at the moment guards produces the handoff summary (at most
  //    once per episode).
  const g = globalThis as unknown as Record<string, Record<string, unknown>>;
  if (!g.__EW_HARNESS_HUB__) g.__EW_HARNESS_HUB__ = {};
  g.__EW_HARNESS_HUB__.onPhaseHandoff = (
    dir: string,
    text: string,
    p: { entered_by?: string },
  ) => {
    try {
      doReset(dir || process.cwd(), text, p?.entered_by || "unknown");
    } catch (e) {
      note(dir || process.cwd(), `handoff callback failed: ${errText(e)}`);
    }
  };

  // Load order is not asserted anywhere by pi: it chains `tool_result` handlers in
  // the order of the extensions list, and this file must come **after** guards.ts
  // so that what it records is the text the model saw ([action #N] header,
  // notices included). Getting it wrong raises no error — it would just make
  // ew_recall quietly return a different version of the text. guards registers
  // hub().guards in its own factory, so finding it here means it loaded first.
  // Leave a trace; do not change behaviour.
  if (!g.__EW_HARNESS_HUB__.guards) {
    note(
      process.cwd(),
      "load order warning: guards.ts had not registered on the hub when phases.ts loaded " +
        "— phases.ts must be listed AFTER extensions/guards.ts, otherwise the archived text " +
        "is the pre-guards version and ew_recall returns text the model never saw",
    );
  }

  // 2. Record one line per charged action, holding the **text the model sees**
  //    (this handler is chained after guards, so it sees the final text with the
  //    numbering and notices already applied).
  pi.on("tool_result", (event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      const d = (event as { details?: { ew?: Record<string, unknown> } }).details;
      const ew = d && typeof d === "object" ? d.ew : undefined;
      if (!ew || typeof ew !== "object") return undefined;
      if (ew.kind !== "act") return undefined;
      const memoHit = typeof ew.memoHit === "number" ? ew.memoHit : null;
      const n = typeof ew.n === "number" && ew.n > 0 ? ew.n : memoHit;
      if (typeof n !== "number" || n <= 0) {
        note(dir, `act result without a usable action number: ${JSON.stringify(ew).slice(0, 200)}`);
        return undefined;
      }
      // The phase state **before** the switch: the evidence line below asks
      // "did this hit happen after the freeze", so it must be read before
      // checkTransition runs.
      const before = phase(dir);
      const text = textOf((event as { content?: unknown }).content);
      recordObservation(dir, {
        n,
        name: typeof ew.name === "string" ? ew.name : "",
        params: (ew.params as Record<string, unknown>) || {},
        memoHit,
        callId: String((event as { toolCallId?: string }).toolCallId || ""),
        text,
      });
      // A memo hit is the second, **invisible** return channel: the model repeats
      // an idempotent action with the same parameters, guards replays the whole
      // recorded text into the context, and that result's callId is not in the
      // frozen archive set — so an archived observation has come back for free and
      // without a trace. ew_recall calls are counted, so this has to be too.
      // Pure logging; not one character of what the model sees changes.
      if (before && memoHit !== null && before.archived.some((r) => r.n === memoHit)) {
        note(
          dir,
          `memo hit after reset: replayed #${memoHit} verbatim, ${text.length} chars ` +
            "(an archived observation came back to context without ew_recall)",
        );
      }
      checkTransition(dir);
    } catch (e) {
      note(dir, `tool_result hook failed: ${errText(e)}`);
    }
    return undefined; // record only; nothing is rewritten
  });

  // 3. Context reset + pinned summary. Before the switch the history is untouched.
  pi.on("context", (event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      checkTransition(dir);
      const p = phase(dir);
      if (!p) return undefined;
      const byId = new Map(p.archived.map((r) => [r.id, r]));
      const out: unknown[] = [];
      let replaced = 0;
      let reclaimed = 0;
      let before = 0;
      let after = 0;
      for (const m of (event as { messages: MsgLike[] }).messages) {
        before += textOf(m.content).length;
        if (m && m.role === "custom" && m.customType === HANDOFF_TYPE) {
          reclaimed += 1; // reclaim the stale copy (only the tail copy below survives)
          continue;
        }
        if (m && m.role === "toolResult" && m.toolCallId && byId.has(m.toolCallId)) {
          const r = byId.get(m.toolCallId)!;
          const text = placeholderText(r.n, r.name);
          after += text.length;
          replaced += 1;
          out.push({ ...m, content: [{ type: "text", text }] });
          continue;
        }
        after += textOf(m.content).length;
        out.push(m);
      }
      const pinned = handoffText(dir);
      if (!loggedRewrite) {
        loggedRewrite = true;
        const pin = pinned.length;
        note(
          dir,
          `first rewritten context: ${replaced}/${p.archived.length} archived results ` +
            `replaced, ${reclaimed} stale handoff copies reclaimed, ` +
            `${before} → ${after + pin} chars (pinned summary ${pin})`,
        );
      }
      // No body means nothing is appended: better a turn without the summary than
      // an empty user message at the tail.
      if (pinned) {
        out.push({
          role: "custom",
          customType: HANDOFF_TYPE,
          content: pinned,
          display: false,
          timestamp: Date.now(),
        });
      } else {
        noteEmptyPin(dir);
      }
      return { messages: out as never };
    } catch (e) {
      note(dir, `context hook failed: ${errText(e)}`);
    }
    return undefined;
  });

  // 4. Multi-turn / interactive use: inject the summary as a persistent message at
  //    the start of a new turn (`context` reclaims the stale copies, so only the
  //    tail copy ever reaches the model).
  //    Under a single `-p` prompt this hook fires once per episode, before the
  //    switch, and returns nothing.
  pi.on("before_agent_start", (_event, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      if (!phase(dir)) return undefined;
      const pinned = handoffText(dir);
      if (!pinned) {                       // empty: inject nothing
        noteEmptyPin(dir);
        return undefined;
      }
      return {
        message: { customType: HANDOFF_TYPE, content: pinned, display: false },
      } as never;
    } catch (e) {
      note(dir, `before_agent_start hook failed: ${errText(e)}`);
    }
    return undefined;
  });

  // 5. The free tool: retrieve an archived observation verbatim.
  pi.registerTool({
    name: "ew_recall",
    label: "Recall archived observation",
    description:
      "Free, local, and never forwarded to the environment: prints the observation " +
      "recorded for [action #N] exactly as it first arrived. Use it when an archived " +
      "explore-phase observation — shown in your context as " +
      "'[action #N <name> — archived]' — is load-bearing for what you are about to " +
      "write. Nothing is charged and nothing is recorded as an action.",
    parameters: recallParams,
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const dir = runDir(ctx);
      const want = Number((p as { n?: unknown }).n);
      const rows = observations(dir);
      // recall is the main channel through which archived material returns, and
      // its count is one of the numbers this mechanism must report. Reading it out
      // of pi-session/*.jsonl per episode does not scale, so the three outcomes
      // (bad-arg / miss / hit) are logged here with the action number and the
      // number of characters retrieved; note() adds the timestamp.
      // Pure logging; not one character of what the model sees changes.
      if (!Number.isFinite(want) || want <= 0) {
        note(dir, "recall bad-arg, 0 chars");
        return {
          content: [{ type: "text" as const, text: `recall: 'n' must be an action number.\n${RECALL_USAGE}\n` }],
          details: { ew: { kind: "free", command: "recall" } },
        };
      }
      const row = rows.find((r) => r.n === want);
      if (!row) {
        note(dir, `recall #${want} miss, 0 chars`);
        const have = rows.map((r) => r.n).join(", ") || "(none)";
        return {
          content: [
            {
              type: "text" as const,
              text:
                `${NOTE}RECALL: no observation is recorded for [action #${want}]. ` +
                `Recorded action numbers: ${have}.\n`,
            },
          ],
          details: { ew: { kind: "free", command: "recall" } },
        };
      }
      note(dir, `recall #${row.n} hit, ${row.text.length} chars`);
      const head =
        `${NOTE}RECALL of [action #${row.n}] ${row.name}${paramsText(row.params)} — ` +
        "the observation exactly as it first arrived. Nothing was forwarded and nothing " +
        "was charged.";
      return {
        content: [{ type: "text" as const, text: `${head}\n${row.text}` }],
        details: { ew: { kind: "free", command: "recall", n: row.n } },
      };
    },
  });
}
