// guards.ts — the rule pack. Every rule the model can feel lives here.
//
// This file knows nothing about TRACES and nothing about any particular task: it
// acts only on tools that declare action metadata. The metadata comes from the
// environment adapter layer (ew-env.ts calls the adapter's `meta` command) and
// has the shape
//   { actions: { <name>: { cost, doc, params: [...], signature, irreversible, idempotent } } }
// The rules read only those facts:
//   irreversible → what the one-shot gate (GATE) and the phase gate (PHASES) hold;
//   idempotent   → what the memo (CACHE) stores and replays;
//   params/signature → what the parameter-shape guard (SHAPE) compares against.
//
// Hooks used (pi 0.84.3):
//   tool_call   — after schema validation, before execution; may rewrite input,
//                 may return {block, reason}   (docs/extensions.md; types.d.ts)
//   tool_result — after execution, before the result enters the context;
//                 middleware-style rewriting of content   (same references)
//
// The model-facing strings are fixed text. Three of them name the interface, and
// those three had to change when the rules moved from a command-line adapter into
// a pi tool — everything else is unchanged:
//   1. SHAPE's escape hatch: a fourth argv `--as-is` → `"__as_is": true` in params
//   2. SHAPE's suggested rewrite: a shell command line → an `ew_act {…}` tool call
//   3. the phase handoff command: a subcommand → the `ew_phase_done {…}` tool
//
// State files all land in the episode directory:
//   .guard_state.json / guard-cache.jsonl / guard-shape.jsonl.
//
// ── The adapter contract (this is the whole "environment-agnostic" boundary; a
//    second adapter only has to satisfy these three points) ──
//   1. Tool input shape: `{command: "act" | <free command>, name?: string, params?: object}`
//      — only `command === "act"` is guarded (SHAPE / PHASES / GATE).
//   2. The tool result carries `details.ew` (see EwDetails below):
//      `{kind: "act"|"free", command, name?, params?, forwarded?, memoHit?, n?}`
//      — `n` must be the **real recorded action number** (≥ 1). If it cannot be
//        determined, the call must fail: a wrong number is worse than none,
//        because every later citation points at the wrong action.
//      — `memoHit` is the action number a memo hit replayed (`null`/absent = no hit).
//   3. Register `getMeta()` on the hub on globalThis, returning `{name: ActionMeta}`.
//      If the metadata cannot be obtained the episode **must fail loudly**
//      (ew-env throws from its factory), because GATE / SHAPE / PHASES and the
//      memo all hang off it. This file only takes evidence: on the first act it
//      logs a missing-metadata episode to guards.log and records `metaMissing` in
//      the state file.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

// ─────────────────────────── switches (read once at load time) ───────────────────────────

function flagOn(name: string, dflt = "1"): boolean {
  const raw = process.env[name];
  const v = raw === undefined ? dflt : raw;
  return !(v === "" || v === "0" || v === "off" || v === "false");
}

const GATE = flagOn("EW_GUARD_GATE");
const DUP_WARN = flagOn("EW_GUARD_DUP");
const REPAIR_NOTE = flagOn("EW_GUARD_REPAIR");
const BUDGET_NOTES = flagOn("EW_GUARD_BUDGET");
const ACTION_NUM = flagOn("EW_GUARD_NUM");
const CACHE_ON = flagOn("EW_GUARD_CACHE");
const CACHE_SAFE = flagOn("EW_GUARD_CACHE_SAFE");
const SHAPE = flagOn("EW_GUARD_SHAPE");
const PHASES = flagOn("EW_GUARD_PHASES", "0");
const DEADLINE = Number(process.env.EW_DEADLINE || 0) || 0;
const PHASES_EXPLORE_FRAC =
  Number(process.env.EW_GUARD_PHASES_EXPLORE_FRAC ||
    process.env.EW_BRIDGE_PHASES_EXPLORE_FRAC || "") || 0.5;

// ─────────────────────────── the text the model sees ───────────────────────────

const NOTE = "[HARNESS NOTE — from your own scaffold, not the environment] ";

/** Memo hit, with the sampling-safe wording (cache_safe on). */
const CACHE_SAFE_HIT =
  "CACHE REPLAY: your own scaffold is printing back the observation it recorded at " +
  "[action #{n}]. The environment was not called and nothing was charged.\n" +
  "This is scaffold-side de-duplication, NOT evidence about how the environment " +
  "answers a repeated call.\n" +
  "If you want a fresh draw or a next page, change a parameter — sampling actions are " +
  "never replayed, so those always reach the environment.";

/** Memo hit, plain wording (cache_safe off). */
const CACHE_PLAIN_HIT =
  "Identical query already taken as [action #{n}]. " +
  "Returning its recorded observation; nothing was charged.";

/** The one-shot gate in front of an irreversible action. */
const GATE_TEXT =
  "SUBMISSION INTERCEPTED by your own scaffold. The environment " +
  "has NOT received it and nothing was charged. Before it is forwarded:\n" +
  "  1. Write your `## Pre-submission audit` — all four questions, in text.\n" +
  "  2. If the task provides an action for declaring limitations, declare\n" +
  "     every limitation the audit surfaced (it is normally free).\n" +
  "  3. Then call submit again — the next submit WILL be forwarded\n" +
  "     unconditionally, with exactly the params you give it.";

/** Asked for after an error reply. */
const REPAIR_TEXT =
  "That reply is an error. Before retrying, write a " +
  "`## Repair` note: what happened, the root cause you believe, " +
  "what you will change, and how you will confirm the fix worked. " +
  "Blind retries read as guessing.";

/** SHAPE rule A: not one key the call sent is a declared parameter.
 *  Carries interface differences 1 and 2 described in the file header. */
const SHAPE_TEXT_A =
  "SHAPE: '{name}' was NOT forwarded and nothing was charged. This is a local check\n" +
  "by your own scaffold against the brief — not a message from the environment.\n" +
  "  the brief declares:  {line}\n" +
  "  you sent keys:       {keys}\n" +
  "  Not one of them is a parameter this action declares. An environment that does\n" +
  "  not find its parameter is free to fall back on a DEFAULT and answer normally —\n" +
  "  the call looks like it worked, but the result is the default's, not yours.\n" +
  "{fix}" +
  "  If the keys you sent really are what you mean, re-issue the same call with\n" +
  "  \"__as_is\": true inside params and it is forwarded unchanged.";

/** SHAPE rule B: a declared parameter was given an empty container.
 *  Carries interface difference 1 described in the file header. */
const SHAPE_TEXT_B =
  "SHAPE: '{name}' was NOT forwarded and nothing was charged. This is a local check\n" +
  "by your own scaffold against the brief — not a message from the environment.\n" +
  "  the brief declares:  {line}\n" +
  "  you sent:            {key} = {value}\n" +
  "  That is an empty container, which is not the same as no answer: the environment\n" +
  "  may accept it and grade the empty submission silently, at whatever an empty\n" +
  "  value scores. Fill '{key}' in with what you actually mean — or, if empty is\n" +
  "  genuinely intended, re-issue the same call with \"__as_is\": true inside params\n" +
  "  and it is forwarded unchanged.";

/** The phase gate holding an irreversible action during EXPLORE.
 *  Carries interface difference 3 described in the file header. */
const PHASE_HOLD =
  "PHASE GATE: 'submit' is not available in the EXPLORE phase. This call was NOT\n" +
  "forwarded, nothing was charged, nothing was recorded, and your one-shot submit\n" +
  "gate is untouched — re-issue exactly this submit once you are in DECIDE.\n" +
  "  phase:        explore\n" +
  "  budget used:  {used}\n" +
  "  Two ways into DECIDE:\n" +
  "    a. spend at least {frac} of any one budget dimension — the phase flips\n" +
  "       automatically on your next action;\n" +
  "    b. hand over yourself, right now, with this free tool call:\n" +
  "       ew_phase_done {\"measured\": [\"...\"], \"unmeasured\": [\"...\"]}\n" +
  "       measured = what you have actually measured; unmeasured = what you know\n" +
  "       you have not. Both lists must be non-empty.\n" +
  "  Budget you did not spend is not a saving — it is evidence you chose not to\n" +
  "  collect. Decide what the remaining budget could still change, then either\n" +
  "  spend it or hand over.";

/** How the DECIDE phase was entered, as printed in the handoff summary. */
const PHASE_ENTERED: Record<string, string> = {
  budget: "budget — at least {frac} of one budget dimension is spent",
  deadline: "deadline — under 15% of the wall clock remains",
  phase_done: "your own `ew_phase_done` handoff",
};

/** Emitted once when a budget dimension drops under 15% (phase gate on). */
const CONVERGE_TEXT =
  "CONVERGENCE MODE: '{kind}' is down to {v} of the {v0} first seen (under 15%). " +
  "Fill in the tables you already have and re-check them, then submit — this is not " +
  "the moment to open a new line of enquiry. Nothing is blocked.";

/** Usage text for the free handoff tool.
 *  Carries interface difference 3 described in the file header. */
const PHASE_USAGE =
  "usage: ew_phase_done {\"measured\": [\"...\"], \"unmeasured\": [\"...\"]}\n" +
  "  Ends the EXPLORE phase and opens the DECIDE phase, where submit is available\n" +
  "  again. Free: nothing is forwarded, nothing is charged, nothing is recorded as\n" +
  "  an action.\n" +
  "  measured    the quantities you have actually measured this episode\n" +
  "  unmeasured  the ones you know you have NOT measured — the honest gaps\n" +
  "  Both keys are required, and each must be a list holding at least one non-empty\n" +
  "  string.";

/** Adapter protocol: the closing line printed after a successful submit. Notices
 *  are inserted in front of it so it stays the last line. */
const FINISHED_LINE = "[episode finished — result.json written]";

// ─────────────────────────── number formatting (matching Python) ───────────────────────────

/** Python's `%g` (6 significant digits, trailing zeros removed). */
function fmtG(x: number): string {
  if (!isFinite(x)) return String(x);
  if (x === 0) return "0";
  const exp = Math.floor(Math.log10(Math.abs(x)));
  if (exp < -4 || exp >= 6) {
    const [mRaw, eRaw] = x.toExponential(5).split("e");
    let m = mRaw;
    if (m.includes(".")) m = m.replace(/0+$/, "").replace(/\.$/, "");
    const sign = eRaw.startsWith("-") ? "-" : "+";
    let digits = eRaw.replace(/^[+-]/, "");
    if (digits.length < 2) digits = `0${digits}`;
    return `${m}e${sign}${digits}`;
  }
  let s = x.toPrecision(6);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** Banker's rounding (round-half-to-even), which is what Python's `format` /
 *  `%.0f` do; JavaScript's Math.round rounds halves up. Only values landing
 *  exactly on .5 differ, and those do occur. */
function roundHalfEven(x: number): number {
  if (!isFinite(x)) return x;
  const fl = Math.floor(x);
  const diff = x - fl;
  if (diff > 0.5) return fl + 1;
  if (diff < 0.5) return fl;
  return fl % 2 === 0 ? fl : fl + 1;
}

/** Python's `{:.0%}`: multiply by 100, then fixed-point format with half-to-even. */
function fmtPct(f: number): string {
  return `${roundHalfEven(f * 100)}%`;
}

/** Python's `json.dumps(obj, sort_keys=True)` (the key for duplicate detection
 *  and for the memo). */
function sortedStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(sortedStringify).join(", ")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const body = keys
    .map((k) => `${JSON.stringify(k)}: ${sortedStringify((v as Record<string, unknown>)[k])}`)
    .join(", ");
  return `{${body}}`;
}

function fill(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ─────────────────────────── episode directory and state ───────────────────────────

const STATE_FILE = ".guard_state.json";
const CACHE_FILE = "guard-cache.jsonl";
const SHAPE_LOG = "guard-shape.jsonl";
const LOG_FILE = "guards.log";

export interface ActionMeta {
  cost: number;
  doc: string;
  params: string[];
  signature: string;
  irreversible: boolean;
  idempotent: boolean;
}

interface ActionRow {
  name: string;
  key: string;
  n: number;
}

export interface PhaseState {
  phase: "decide";
  entered_by: string;
  measured: string[];
  unmeasured: string[];
  ts: number;
}

interface GuardState {
  started: number;
  flags: Record<string, boolean | number>;
  budget0: Record<string, number> | null;
  budgetNow: Record<string, number> | null;
  actions: ActionRow[];
  phase: PhaseState | null;
  /** An automatic phase switch's handoff summary, waiting for the next tool
   *  result to carry it to the model */
  pendingHandoff: string | null;
  /** Evidence: was the metadata empty on the first act (null = not checked yet).
   *  true means GATE / SHAPE / PHASES / memo were all inert this episode, which
   *  has to be visible afterwards. */
  metaMissing: boolean | null;
}

function makeFresh(): GuardState {
  return {
    started: Date.now() / 1000,
    flags: {},
    budget0: null,
    budgetNow: null,
    actions: [],
    phase: null,
    pendingHandoff: null,
    metaMissing: null,
  };
}

let mem: GuardState | null = null;

function runDir(ctx?: ExtensionContext): string {
  const c = ctx && typeof ctx.cwd === "string" ? ctx.cwd : "";
  return c || process.cwd();
}

function note(dir: string, msg: string): void {
  try {
    appendFileSync(join(dir, LOG_FILE), `${new Date().toISOString()} ${msg}\n`);
  } catch {
    /* logging must never take down an episode either */
  }
}

function errText(e: unknown): string {
  const any = e as { stderr?: unknown; message?: unknown };
  return String(any?.stderr || any?.message || e).slice(0, 500);
}

function state(dir: string): GuardState {
  if (mem) return mem;
  try {
    const p = join(dir, STATE_FILE);
    if (existsSync(p)) {
      const disk = JSON.parse(readFileSync(p, "utf8"));
      mem = { ...makeFresh(), ...(disk && typeof disk === "object" ? disk : {}) };
      return mem;
    }
  } catch (e) {
    note(dir, `state read failed: ${errText(e)}`);
  }
  mem = makeFresh();
  save(dir, mem);
  return mem;
}

function save(dir: string, s: GuardState): void {
  try {
    writeFileSync(join(dir, STATE_FILE), JSON.stringify(s, null, 2));
  } catch (e) {
    note(dir, `state write failed: ${errText(e)}`);
  }
}

// ─────────────────────────── metadata (supplied by the adapter layer) ───────────────────────────

const HUB_KEY = "__EW_HARNESS_HUB__";

export interface EwHub {
  /** Registered by the adapter layer: returns {actionName: ActionMeta}, or null */
  getMeta?: () => Record<string, ActionMeta> | null;
  /** Registered by the rule pack: called by the adapter's execute function
   *  (memo / phase handoff) */
  guards?: GuardsApi;
  /** Registered by extensions/phases.ts (the strong form of phase gating): it is
   *  notified once, at the moment the handoff summary is produced, with that text
   *  verbatim. Without phases.ts loaded the field is undefined and the call site
   *  is an optional chain — the text the model sees is byte-for-byte the same as
   *  if this line did not exist. */
  onPhaseHandoff?: (dir: string, text: string, phase: PhaseState) => void;
}

export interface MemoHit {
  n: number;
  /** The body returned directly as the tool result (hit notice + replayed observation) */
  text: string;
}

export interface GuardsApi {
  /** Whether this action may enter the memo (idempotency is declared by the adapter) */
  memoEnabled(name: string): boolean;
  memoLookup(dir: string, name: string, params: unknown): MemoHit | null;
  memoStore(dir: string, name: string, params: unknown, n: number, body: string): void;
  /** The implementation behind the free ew_phase_done tool (with the phase gate
   *  off it just says so) */
  phaseDone(dir: string, measured: unknown, unmeasured: unknown): string;
  /** Strip the escape-hatch key out of params (it is never forwarded); returns
   *  whether the escape hatch was used */
  stripEscape(params: Record<string, unknown> | undefined): boolean;
}

export function hub(): EwHub {
  const g = globalThis as unknown as Record<string, EwHub>;
  if (!g[HUB_KEY]) g[HUB_KEY] = {};
  return g[HUB_KEY];
}

function meta(): Record<string, ActionMeta> {
  try {
    return hub().getMeta?.() || {};
  } catch {
    return {};
  }
}

function actionMeta(name: string): ActionMeta | null {
  const m = meta();
  return Object.prototype.hasOwnProperty.call(m, name) ? m[name] : null;
}

/**
 * Metadata evidence: check before every act that the metadata is still there.
 *
 * With the metadata empty, GATE (the submit gate), SHAPE (the parameter-shape
 * guard), PHASES (the phase gate) and the memo all silently become no-ops
 * together — the episode runs, a score comes out, and nothing in the record shows
 * that not one rule was in effect. The adapter layer (ew-env.ts) already refuses
 * to register the tool at all in that case; this is the second line of defence:
 * write the fact into guards.log and into `.guard_state.json` so a batch can be
 * audited afterwards.
 */
function auditMeta(dir: string): boolean {
  const missing = Object.keys(meta()).length === 0;
  const s = state(dir);
  const was = s.metaMissing;
  if (was === missing) return missing;
  s.metaMissing = missing;
  save(dir, s);
  if (missing) {
    note(
      dir,
      "META MISSING: getMeta() returned nothing — GATE / SHAPE / PHASES / memo are " +
        "all no-ops for this episode. Every guard that reads action metadata is blind.",
    );
  } else if (was === true) {
    // Only a genuine absence followed by a return counts as recovery. The initial
    // state is null, so on a healthy first action `null !== false` lands here —
    // that is the first recording, not a recovery, and must not be logged.
    note(dir, "meta recovered: action metadata is available again");
  }
  return missing;
}

// ─────────────────────────── time notices ───────────────────────────

function harnessNotice(dir: string): string | null {
  if (!DEADLINE) return null;
  const s = state(dir);
  const left = DEADLINE - (Date.now() / 1000 - s.started);
  if (left <= 0) {
    return (
      `${NOTE}TIME REMAINING: the episode wall clock is EXHAUSTED. ` +
      "Submit immediately with whatever you can currently support. " +
      "An unsubmitted episode is graded on what it left behind."
    );
  }
  const frac = left / DEADLINE;
  if (frac <= 0.15) {
    return (
      `${NOTE}TIME REMAINING: only ${Math.round(left)}s of ${Math.round(DEADLINE)}s remain. ` +
      "STOP GATHERING AND SUBMIT NOW with your best supported answer."
    );
  }
  if (frac <= 0.35) {
    return (
      `${NOTE}TIME REMAINING: ${Math.round(left)}s of ${Math.round(DEADLINE)}s remain ` +
      "(under 35%). Begin converging: decide what you can already " +
      "support, and leave enough time to submit."
    );
  }
  return null;
}

// ─────────────────────────── budget notices ───────────────────────────

function budgetNotes(dir: string, cur: Record<string, number> | null): string[] {
  if (!cur || typeof cur !== "object" || Object.keys(cur).length === 0) return [];
  const s = state(dir);
  if (!s.budget0) {
    s.budget0 = { ...cur };
    save(dir, s);
    return [];
  }
  const notes: string[] = [];
  for (const [kind, v0] of Object.entries(s.budget0)) {
    const v = cur[kind];
    if (typeof v0 !== "number" || typeof v !== "number" || v0 <= 0) continue;
    const frac = v / v0;
    if (frac <= 0.2 && !s.flags[`budget_low:${kind}`]) {
      s.flags[`budget_low:${kind}`] = true;
      save(dir, s);
      notes.push(
        `${NOTE}BUDGET: '${kind}' is down to ${v} (below 20% of the ` +
          `${v0} you started with). Write a budget line now, converge on ` +
          "what you can already support, and keep enough for a clean submit.",
      );
    } else if (frac <= 0.5 && !s.flags[`budget_half:${kind}`]) {
      s.flags[`budget_half:${kind}`] = true;
      save(dir, s);
      notes.push(
        `${NOTE}BUDGET: '${kind}' has crossed half spent (${v} of ${v0} ` +
          "at first check remains). Good moment for a written budget line: " +
          "spent on what, remaining reserved for what.",
      );
    }
  }
  return notes;
}

// ─────────────────────────── the phase gate ───────────────────────────

function budgetUsed(dir: string): Array<[string, number, number, number]> {
  const s = state(dir);
  const cur = s.budgetNow || {};
  const ref = s.budget0 || s.budgetNow || {};
  const out: Array<[string, number, number, number]> = [];
  for (const [kind, v0] of Object.entries(ref)) {
    const v = cur[kind];
    if (typeof v0 !== "number" || typeof v !== "number" || v0 <= 0) continue;
    out.push([kind, v0, v, Math.max(0, Math.min(1, (v0 - v) / v0))]);
  }
  return out;
}

function budgetUsedTxt(dir: string): string {
  const rows = budgetUsed(dir);
  if (!rows.length) return "(nothing spent yet)";
  return rows
    .map(([k, v0, v, f]) => `${k} ${fmtPct(f)} used (${fmtG(v)} of ${fmtG(v0)} left)`)
    .join(", ");
}

function phaseNow(dir: string): "explore" | "decide" {
  return state(dir).phase?.phase === "decide" ? "decide" : "explore";
}

function enterDecide(
  dir: string,
  enteredBy: string,
  measured: string[] = [],
  unmeasured: string[] = [],
): PhaseState {
  const s = state(dir);
  const d: PhaseState = {
    phase: "decide",
    entered_by: enteredBy,
    measured: [...measured],
    unmeasured: [...unmeasured],
    ts: Math.round(Date.now() / 10) / 100,
  };
  s.phase = d;
  save(dir, s);
  return d;
}

function phaseHandoff(dir: string, d: PhaseState): string {
  const enteredTpl = PHASE_ENTERED[d.entered_by] ?? String(d.entered_by);
  const entered = fill(enteredTpl, { frac: fmtPct(PHASES_EXPLORE_FRAC) });
  const rows = state(dir).actions;
  const out: string[] = [
    `${NOTE}PHASE HANDOFF — you are now in the DECIDE phase. 'submit' is ` +
      "available again;\nevery other mechanism (the one-shot submit gate " +
      "included) is unchanged.",
    `  entered by:    ${entered}`,
    `  actions taken: ${rows.length}`,
    `  budget:        ${budgetUsedTxt(dir)}`,
  ];
  if (d.measured.length || d.unmeasured.length) {
    out.push("  measured (your own list):");
    out.push(...(d.measured.length ? d.measured : ["(none given)"]).map((s2) => `    - ${s2}`));
    out.push("  knowingly unmeasured (your own list):");
    out.push(...(d.unmeasured.length ? d.unmeasured : ["(none given)"]).map((s2) => `    - ${s2}`));
  } else {
    out.push(
      "  measured / unmeasured: not stated — the phase flipped " +
        "automatically.\n    Write both lists now: what you actually " +
        "measured, and what you know you\n    did not.",
    );
  }
  out.push("  actions this episode (names only — no observations):");
  const names = rows.map((r, i) => `    [action #${i + 1}] ${r.name}`);
  out.push(...(names.length ? names : ["    (none)"]));
  out.push(
    "  Before you submit: does anything on the unmeasured list still change\n" +
      "  the answer, and can the remaining budget close it? If so, close it first —\n" +
      "  unmeasured mass counts at its worst plausible value, never at zero.",
  );
  const text = out.join("\n");
  // The only interface to the strong form: at the moment of the switch, hand the
  // summary to phases.ts verbatim. Without that extension loaded, onPhaseHandoff
  // is undefined and this is an optional chain that does nothing.
  try {
    hub().onPhaseHandoff?.(dir, text, d);
  } catch (e) {
    note(dir, `phase handoff hook failed: ${errText(e)}`);
  }
  return text;
}

function deadlineTight(dir: string): boolean {
  if (!DEADLINE) return false;
  const left = DEADLINE - (Date.now() / 1000 - state(dir).started);
  return left <= 0 || left / DEADLINE <= 0.15;
}

/** Automatic switch into DECIDE. Returns the handoff summary on the switch (at
 *  most once per episode), otherwise null. */
function phaseAutoCheck(dir: string): string | null {
  if (phaseNow(dir) === "decide") return null;
  if (budgetUsed(dir).some(([, , , f]) => f >= PHASES_EXPLORE_FRAC)) {
    return phaseHandoff(dir, enterDecide(dir, "budget"));
  }
  if (deadlineTight(dir)) {
    return phaseHandoff(dir, enterDecide(dir, "deadline"));
  }
  return null;
}

function convergenceNote(dir: string): string | null {
  const s = state(dir);
  if (s.flags.phase_converge) return null;
  for (const [kind, v0, v] of budgetUsed(dir)) {
    if (v < 0.15 * v0) {
      s.flags.phase_converge = true;
      save(dir, s);
      return NOTE + fill(CONVERGE_TEXT, { kind, v: fmtG(v), v0: fmtG(v0) });
    }
  }
  return null;
}

function phaseStatusLine(dir: string): string {
  const s = state(dir);
  if (phaseNow(dir) === "decide") {
    return `phase: decide (entered_by=${s.phase?.entered_by})`;
  }
  return (
    "phase: explore (entered_by=none; 'submit' is held until you enter decide " +
    `— spend >= ${roundHalfEven(PHASES_EXPLORE_FRAC * 100)}% of one budget dimension, ` +
    "or call `ew_phase_done`)"
  );
}

// ─────────────────────────── the parameter-shape guard ───────────────────────────

/** Key normalisation for comparison: lowercase, drop one trailing "s". */
function shapeKey(k: string): string {
  const s = String(k).trim().toLowerCase();
  return s.length > 1 && s.endsWith("s") ? s.slice(0, -1) : s;
}

/** guard-shape.jsonl uses **local** time, matching the adapter-side log it is
 *  cross-checked against; an ISO/UTC timestamp here would be off by a time zone. */
function localTs(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getFullYear(), 4)}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

function shapeLog(dir: string, name: string, keys: string[], sig: string[], rule: string): void {
  try {
    const ts = localTs();
    appendFileSync(
      join(dir, SHAPE_LOG),
      `${JSON.stringify({ ts, action: name, keys: [...keys].sort(), signature: [...sig].sort(), rule })}\n`,
    );
  } catch (e) {
    note(dir, `shape log failed: ${errText(e)}`);
  }
}

/** The suggested rewrite. Carries interface difference 2 from the file header:
 *  a tool call, not a shell command line. */
function shapeFix(name: string, params: Record<string, unknown>, sig: string[]): string {
  if (sig.length === 1) {
    const only = [...sig].sort()[0];
    const wrapped = sortedStringify({ [only]: params });
    return (
      "  suggested rewrite — your params wrapped under the declared parameter:\n" +
      `    ew_act {"command": "act", "name": "${name}", "params": ${wrapped}}\n`
    );
  }
  return (
    `  the parameters it declares are: ${[...sig].sort().join(", ")}` +
    ".\n  Re-send with your values under those names.\n"
  );
}

/** null = let it through; a string = hold it (that string is what goes back to the model). */
function shapeCheck(dir: string, name: string, params: Record<string, unknown>): string | null {
  if (!params || typeof params !== "object" || Array.isArray(params)) return null;
  const keys = Object.keys(params);
  if (!keys.length) return null;
  const m = actionMeta(name);
  const sig = m?.params ?? [];
  if (!sig.length) return null;
  const line = m?.signature ?? "";
  const declared = new Set(sig.map(shapeKey));
  const sent = keys.map(shapeKey);
  if (!sent.some((k) => declared.has(k))) {
    shapeLog(dir, name, keys, sig, "A");
    return (
      NOTE +
      fill(SHAPE_TEXT_A, {
        name,
        line,
        keys: keys.join(", "),
        fix: shapeFix(name, params, sig),
      })
    );
  }
  for (const k of keys) {
    const v = params[k];
    const empty =
      v === null ||
      v === undefined ||
      (Array.isArray(v) && v.length === 0) ||
      (typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length === 0);
    if (declared.has(shapeKey(k)) && empty) {
      shapeLog(dir, name, keys, sig, "B");
      return (
        NOTE +
        fill(SHAPE_TEXT_B, {
          name,
          line,
          key: k,
          value: JSON.stringify(v === undefined ? null : v),
        })
      );
    }
  }
  return null;
}

// ─────────────────────────── the idempotent memo ───────────────────────────

interface CacheRow {
  key: string;
  n: number;
  body: string;
}

function cacheLookup(dir: string, key: string): CacheRow | null {
  const p = join(dir, CACHE_FILE);
  if (!existsSync(p)) return null;
  try {
    for (const line of readFileSync(p, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as CacheRow;
      if (row.key === key) return row;
    }
  } catch (e) {
    note(dir, `cache read failed: ${errText(e)}`);
  }
  return null;
}

/**
 * Refresh a replayed envelope to "nothing charged + current balance".
 *
 * The environment is not called, so the two fields `cost_charged` and
 * `budget_remaining` are substituted directly in the original text — the
 * observation body is not touched by a single byte (re-serialising it would
 * rewrite Python's float formatting).
 */
function refreshEnvelope(raw: string, budget: Record<string, number> | null): string {
  const lines = raw.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^ {2}"cost_charged":/.test(line)) {
      out.push(`  "cost_charged": 0${line.trimEnd().endsWith(",") ? "," : ""}`);
      i += 1;
      continue;
    }
    if (budget && /^ {2}"budget_remaining": \{/.test(line)) {
      const oneLine = /^ {2}"budget_remaining": \{\},?$/.test(line);
      let j = i;
      if (!oneLine) {
        j = i + 1;
        while (j < lines.length && !/^ {2}\}/.test(lines[j])) j += 1;
      }
      const closer = lines[Math.min(j, lines.length - 1)] ?? "";
      const comma = closer.trimEnd().endsWith(",") ? "," : "";
      const body = JSON.stringify(budget, null, 2)
        .split("\n")
        .map((l, k) => (k === 0 ? l : `  ${l}`))
        .join("\n");
      out.push(`  "budget_remaining": ${body}${comma}`);
      i = j + 1;
      continue;
    }
    out.push(line);
    i += 1;
  }
  return out.join("\n");
}

function memoEnabled(name: string): boolean {
  if (!CACHE_ON) return false;
  return actionMeta(name)?.idempotent === true;
}

function memoKey(name: string, params: unknown): string {
  return `${name} ${sortedStringify(params ?? {})}`;
}

function memoLookup(dir: string, name: string, params: unknown): MemoHit | null {
  if (!memoEnabled(name)) return null;
  const hit = cacheLookup(dir, memoKey(name, params));
  if (!hit) return null;
  const s = state(dir);
  const tpl = CACHE_SAFE ? CACHE_SAFE_HIT : CACHE_PLAIN_HIT;
  const head = NOTE + fill(tpl, { n: String(hit.n) });
  const body = refreshEnvelope(hit.body, s.budgetNow);
  return { n: hit.n, text: `${head}\n${body}` };
}

function memoStore(dir: string, name: string, params: unknown, n: number, body: string): void {
  if (!memoEnabled(name)) return;
  try {
    appendFileSync(
      join(dir, CACHE_FILE),
      `${JSON.stringify({ key: memoKey(name, params), n, body })}\n`,
    );
  } catch (e) {
    note(dir, `cache write failed: ${errText(e)}`);
  }
}

// ─────────────────────────── the free ew_phase_done tool ───────────────────────────

function checkList(v: unknown, key: string): string[] {
  if (!Array.isArray(v) || v.length === 0 ||
      v.some((s) => typeof s !== "string" || !s.trim())) {
    throw new Error(`${key} must be a list of at least one non-empty string`);
  }
  return (v as string[]).map((s) => s.trim());
}

function phaseDone(dir: string, measured: unknown, unmeasured: unknown): string {
  if (!PHASES) {
    return `${NOTE}PHASE: phase gating is not enabled in this episode; 'submit' is ` +
      "available and nothing changed.";
  }
  let lists: { measured: string[]; unmeasured: string[] };
  try {
    lists = { measured: checkList(measured, "measured"),
              unmeasured: checkList(unmeasured, "unmeasured") };
  } catch (e) {
    return `phase: ${(e as Error).message}\n${PHASE_USAGE}`;
  }
  if (phaseNow(dir) === "decide") {
    return `${NOTE}PHASE: already in the DECIDE phase (entered_by=` +
      `${state(dir).phase?.entered_by}); 'submit' is available and nothing changed.`;
  }
  return phaseHandoff(dir, enterDecide(dir, "phase_done", lists.measured, lists.unmeasured));
}

// ─────────────────────────── reading a tool result ───────────────────────────

/** The execution record ew-env.ts attaches under details (the contract between
 *  the adapter layer and the rule pack). */
export interface EwDetails {
  kind: "act" | "free";
  command: string;
  name?: string;
  params?: Record<string, unknown>;
  forwarded?: boolean;
  memoHit?: number | null;
  n?: number | null;
}

function detailsOf(event: ToolResultEvent): EwDetails | null {
  const d = event.details as { ew?: EwDetails } | undefined;
  const ew = d && typeof d === "object" ? d.ew : undefined;
  return ew && typeof ew === "object" ? ew : null;
}

function textOf(event: ToolResultEvent): string {
  const blocks = (event.content || []) as Array<{ type: string; text?: string }>;
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text as string)
    .join("");
}

/**
 * The adapter can print **bare** `Infinity` / `-Infinity` / `NaN`: that is what
 * Python's `json.dumps(float('inf'))` produces, and a zero-arm subgroup in
 * adapters/traces/scale.py necessarily yields `"risk_ratio": Infinity`. Standard
 * JSON has no such words, so `JSON.parse` rejects the whole envelope → this
 * step's `budget_remaining` is lost → `budgetNow` stays at the previous step, the
 * budget/convergence notices are silently skipped, and the automatic phase switch
 * (which also reads budgetNow) is pushed later than it should be.
 *
 * The fix: substitute legal literals and parse again, and do it **only outside
 * strings** — using the same inStr/esc state machine as parseEnvelope below, so
 * an "Infinity" inside a string is never touched. `JSON.parse("1e999")` yields
 * Infinity, so no meaning is lost; NaN has no JSON counterpart and can only
 * degrade to null (the rules read only status and budget_remaining, neither of
 * which is ever NaN).
 *
 * The original text is not modified by a single byte: this produces a temporary
 * copy for JSON.parse only. What the model sees, what refreshEnvelope rewrites,
 * and what phases.ts reads for its fact table are all still the original.
 */
const RELAX_LITERALS: Array<[string, string]> = [
  ["-Infinity", "-1e999"],
  ["Infinity", "1e999"],
  ["NaN", "null"],
];

function relaxJsonLiterals(raw: string): string {
  let out = "";
  let inStr = false;
  let esc = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (inStr) {
      out += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      out += ch;
      i += 1;
      continue;
    }
    let hit = false;
    for (const [from, to] of RELAX_LITERALS) {
      if (!raw.startsWith(from, i)) continue;
      // Only a standalone literal counts: what follows must be JSON structure or
      // whitespace (or the end), so something like `Infinityish` is left alone.
      const after = raw[i + from.length] ?? "";
      if (after && !",}] \t\n\r".includes(after)) continue;
      out += to;
      i += from.length;
      hit = true;
      break;
    }
    if (hit) continue;
    out += ch;
    i += 1;
  }
  return out;
}

/** Log "the fallback parser was used" once per episode, not once per result. */
let loggedRelaxedParse = false;

/**
 * Extract the environment envelope (the first complete JSON object) from a tool
 * result. Returns null when there is none.
 * `dir` is used only to write one log line (omit it and nothing is logged); the
 * parse result does not depend on it.
 */
export function parseEnvelope(text: string, dir?: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const raw = text.slice(start, i + 1);
        try {
          return JSON.parse(raw) as Record<string, unknown>;
        } catch {
          // The bare Infinity/-Infinity/NaN retry. Still unparseable afterwards
          // means null, exactly as before.
          const relaxed = relaxJsonLiterals(raw);
          if (relaxed === raw) return null;
          try {
            const v = JSON.parse(relaxed) as Record<string, unknown>;
            if (dir && !loggedRelaxedParse) {
              loggedRelaxedParse = true;
              note(
                dir,
                "envelope parsed with the Infinity/NaN fallback (bare Infinity/-Infinity/NaN " +
                  "outside strings re-read as 1e999/-1e999/null; the text the model sees is " +
                  "untouched); later occurrences in this episode are not logged",
              );
            }
            return v;
          } catch {
            return null;
          }
        }
      }
    }
  }
  return null;
}

// ─────────────────────────── extension entry point ───────────────────────────

export default function (pi: ExtensionAPI) {
  hub().guards = {
    memoEnabled,
    memoLookup,
    memoStore,
    phaseDone,
    stripEscape(params) {
      if (!params || typeof params !== "object") return false;
      if (!Object.prototype.hasOwnProperty.call(params, "__as_is")) return false;
      const v = (params as Record<string, unknown>).__as_is;
      delete (params as Record<string, unknown>).__as_is;
      return v !== false && v !== null && v !== undefined && v !== 0 && v !== "";
    },
  };

  // 1. Before execution: SHAPE → PHASES → GATE. A hold is block + the text back.
  pi.on("tool_call", (event: ToolCallEvent, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      const input = event.input as Record<string, unknown>;
      if (!input || input.command !== "act") return;
      const name = typeof input.name === "string" ? input.name : "";
      if (!name) return;
      if (input.params !== undefined && (input.params === null || typeof input.params !== "object")) {
        return;
      }
      const params = (input.params as Record<string, unknown>) || {};
      // Check before every act that the metadata is there; record the first change.
      auditMeta(dir);
      // Escape hatch: `"__as_is": true` skips the shape check, and the key is
      // deleted before forwarding.
      const asIs = hub().guards!.stripEscape(params);
      const m = actionMeta(name);

      if (SHAPE && !asIs) {
        const held = shapeCheck(dir, name, params);
        if (held) return { block: true, reason: held };
      }

      // The handoff summary of an automatic phase switch belongs at the very top
      // of this call's output, so if this call is held it goes in front of the
      // hold text, and otherwise it is attached to the head of this call's result.
      let handoff: string | null = null;
      if (PHASES) {
        handoff = phaseAutoCheck(dir);
        if (phaseNow(dir) === "explore" && m?.irreversible) {
          const held =
            NOTE +
            fill(PHASE_HOLD, {
              used: budgetUsedTxt(dir),
              frac: fmtPct(PHASES_EXPLORE_FRAC),
            });
          return { block: true, reason: handoff ? `${handoff}\n${held}` : held };
        }
      }

      if (GATE && m?.irreversible) {
        const s = state(dir);
        if (!s.flags.submit_gate) {
          s.flags.submit_gate = true;
          save(dir, s);
          const held = NOTE + GATE_TEXT;
          return { block: true, reason: handoff ? `${handoff}\n${held}` : held };
        }
      }

      if (handoff) {
        const s = state(dir);
        s.pendingHandoff = handoff;
        save(dir, s);
      }
    } catch (e) {
      note(dir, `tool_call hook failed: ${errText(e)}`);
    }
    return undefined;
  });

  // 2. Before the result enters the context: numbering + duplicate/error/budget/
  //    convergence/time notices (all carrying the NOTE prefix).
  pi.on("tool_result", (event: ToolResultEvent, ctx: ExtensionContext) => {
    const dir = runDir(ctx);
    try {
      const ew = detailsOf(event);
      if (!ew) return; // not this adapter's tool (or a blocked call): pass through
      const s = state(dir);
      let body = textOf(event);
      // Notices are preceded by a blank line by default; lead=false attaches one
      // directly to the paragraph above.
      const notes: Array<{ text: string; lead: boolean }> = [];
      const push = (text: string, lead = true) => notes.push({ text, lead });

      // The closing submit line has to stay the last line: take it off first and
      // put it back at the end.
      let tail = "";
      const marker = `\n\n${FINISHED_LINE}\n`;
      if (body.endsWith(marker)) {
        body = body.slice(0, body.length - marker.length + 1);
        tail = `\n${FINISHED_LINE}\n`;
      }

      let head = "";
      if (s.pendingHandoff) {
        head = `${s.pendingHandoff}\n`;
        s.pendingHandoff = null;
        save(dir, s);
      }

      // A hit is decided by "is there an action number", not by truthiness:
      // `memoHit: 0` would otherwise fall through every branch (neither numbered
      // nor noticed), and 0 was never a legal action number in the first place.
      const memoHit = typeof ew.memoHit === "number" ? ew.memoHit : null;
      if (ew.kind === "act" && memoHit !== null) {
        // Memo hit: no numbering, and no duplicate/error/budget notice.
        if (memoHit <= 0) note(dir, `memo hit carries a non-positive action number: ${memoHit}`);
        const dl = harnessNotice(dir);
        if (dl) push(dl);
      } else if (ew.kind === "act" && ew.forwarded) {
        // `dir` is passed in so that "the Infinity/NaN fallback was used" leaves a
        // line in guards.log (once per episode) — a mechanism change has to report
        // its real trigger count.
        const reply = parseEnvelope(body, dir);
        // No envelope means budget notices / convergence / the phase gate all stop
        // for this step; leave at least one trace of it.
        if (!reply) note(dir, `envelope parse failed for '${ew.name}' (${body.length} chars)`);
        const budget = (reply?.budget_remaining as Record<string, number> | undefined) || null;
        const key = sortedStringify(ew.params ?? {});
        // n is always ≥ 1 from a healthy adapter; on a bad value fall back to the
        // in-memory count and leave a trace.
        let n: number;
        if (typeof ew.n === "number" && ew.n > 0) {
          n = ew.n;
        } else {
          n = s.actions.length + 1;
          note(dir, `forwarded act '${ew.name}' arrived without a usable action number ` +
            `(details.ew.n=${JSON.stringify(ew.n)}); falling back to in-memory count ${n}`);
        }

        // Duplicate-action notice, compared against the actions recorded *before*
        // this one. The number cited is the recorded action number s.actions[i].n
        // (authoritative, straight from actions.jsonl), not the array index — one
        // divergence and every later notice points at the wrong action.
        if (DUP_WARN) {
          for (let i = 0; i < s.actions.length; i++) {
            if (s.actions[i].name === ew.name && s.actions[i].key === key) {
              push(
                `${NOTE}You already took this exact action as [action #${s.actions[i].n}] ` +
                  "— its observation is in your context. This call was still " +
                  "forwarded and charged.",
              );
              break;
            }
          }
        }
        s.actions.push({ name: ew.name || "", key, n });
        if (budget && Object.keys(budget).length) {
          s.budgetNow = budget;
          // The reference point is the balance after the first charged action, and
          // it does not depend on the budget-notice switch: the phase gate must be
          // able to compute the spent fraction even with those notices off.
          if (!s.budget0) s.budget0 = { ...budget };
        }
        save(dir, s);

        if (REPAIR_NOTE && reply?.status === "error") push(NOTE + REPAIR_TEXT);
        if (BUDGET_NOTES) for (const bn of budgetNotes(dir, budget)) push(bn);
        if (PHASES) {
          const cn = convergenceNote(dir);
          if (cn) push(cn);
        }
        const dl = harnessNotice(dir);
        if (dl) push(dl);
        if (ACTION_NUM) head += `[action #${n}]\n`;
      } else if (ew.command === "status") {
        const dl = harnessNotice(dir);
        if (dl) push(dl);
        if (PHASES) {
          // In a status reply the handoff summary comes first (attached to the
          // paragraph above, no blank line), then the phase status line.
          const handoff = phaseAutoCheck(dir);
          if (handoff) push(handoff, false);
          push(phaseStatusLine(dir));
        }
      }

      const rendered = notes.map((t) => `${t.lead ? "\n" : ""}${t.text}\n`).join("");
      const text = head + body + rendered + tail;
      if (text === textOf(event)) return;
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      note(dir, `tool_result hook failed: ${errText(e)}`);
    }
    return undefined;
  });
}
