// ew-env.ts — the environment half of the extension pack: it registers the
// Executable World as a native pi tool.
//
// It does exactly three things, all of them specific to this environment:
//   1. translate a pi tool call into a command line for the thin adapter
//      adapters/traces/ew_act.py;
//   2. call the adapter's `meta` command once at start-up and hand the action
//      metadata (cost / doc / params / signature / irreversible / idempotent) to
//      the environment-agnostic rule pack in extensions/guards.ts. The same hub
//      also carries a **lazy `getBrief()`**: the task brief itself, for rule
//      packs that decide what to inject from features of the brief (currently
//      extensions/optional-pack.ts and its conditional blocks). Nothing spawns a
//      subprocess unless someone calls it, so a run that does not load that
//      extension is byte-for-byte unaffected;
//   3. execute the idempotent memo: the policy lives in guards.ts
//      (memoLookup / memoStore); on a hit this file returns the recorded
//      observation directly, with no subprocess and no contact with the world.
//
// Not one rule (numbering, notices, gates, parameter-shape checks, phase gate)
// lives here; they are all in extensions/guards.ts.
//
// Communication with guards.ts goes through a hub on globalThis: pi's extension
// loader uses jiti with `moduleCache: false` (dist/core/extensions/loader.js),
// so two extension files each become their own module and importing one from the
// other yields a second instance. Hence no relative import between them.
//
// Three invariants worth stating, because each one protects a whole episode:
//   * Metadata is mandatory. If neither the async nor the sync `meta` call
//     returns anything, the extension factory **throws**. pi then prints
//     `Failed to load extension …` and exits, so the tool is never registered and
//     the model cannot take a single step. That is much better than an episode
//     that scores normally while every metadata-driven guard is silently inert.
//   * Action numbers are real. The number is the line count of the actions.jsonl
//     that the adapter actually writes, resolved through `EW_RUN`. If it cannot
//     be counted, or counts 0, the call fails: 0 is not a valid action number and
//     passing it on would mis-number the whole episode.
//   * The episode directory is `process.cwd()` at load time (the runner starts pi
//     with cwd = the episode directory, so the two always agree), but the first
//     tool call re-checks it against `ctx.cwd` and, if they differ, logs it and
//     refetches the metadata from `ctx.cwd`.
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const run = promisify(execFile);
const ADAPTER = "ew_act.py"; // the runner copies whatever bridge_path points at under this name
const LOG_FILE = "ew-env.log";
const HUB_KEY = "__EW_HARNESS_HUB__";

/** The closing line the adapter prints after a successful submit (part of the
 *  protocol, not a notice). */
const FINISHED_LINE = "[episode finished — result.json written]";
const FINISHED_TAIL = `\n\n${FINISHED_LINE}\n`;

/** The phase-gate switch (read exactly as guards.ts reads EW_GUARD_PHASES): with
 *  the gate off, ew_phase_done is not registered at all. A tool that exists but
 *  does nothing is not free — a model will spend a turn trying it. */
const PHASES_ON = !["", "0", "off", "false"].includes(process.env.EW_GUARD_PHASES ?? "0");

interface ActionMeta {
  cost: number;
  doc: string;
  params: string[];
  signature: string;
  irreversible: boolean;
  idempotent: boolean;
}

interface GuardsApi {
  memoEnabled(name: string): boolean;
  memoLookup(dir: string, name: string, params: unknown): { n: number; text: string } | null;
  memoStore(dir: string, name: string, params: unknown, n: number, body: string): void;
  phaseDone(dir: string, measured: unknown, unmeasured: unknown): string;
  stripEscape(params: Record<string, unknown> | undefined): boolean;
}

interface EwHub {
  getMeta?: () => Record<string, ActionMeta> | null;
  /** The task brief, fetched lazily. For rule packs that decide what to inject
   *  from features of the brief; see where it is published below. */
  getBrief?: () => string;
  guards?: GuardsApi;
}

function hub(): EwHub {
  const g = globalThis as unknown as Record<string, EwHub>;
  if (!g[HUB_KEY]) g[HUB_KEY] = {};
  return g[HUB_KEY];
}

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
  return String(any?.stderr || any?.message || e).slice(0, 2000);
}

// ─────────────────────────── metadata (declared once) ───────────────────────────

let META: Record<string, ActionMeta> | null = null;
/** Cached task brief (null = nobody has asked yet; "" = asked and unavailable). */
let BRIEF: string | null = null;

function parseMeta(text: string): Record<string, ActionMeta> | null {
  try {
    const d = JSON.parse(text) as { actions?: Record<string, ActionMeta> };
    return d && typeof d === "object" && d.actions ? d.actions : null;
  } catch {
    return null;
  }
}

function loadMetaSync(dir: string): Record<string, ActionMeta> | null {
  try {
    const out = execFileSync("python3", [ADAPTER, "meta"], {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return parseMeta(String(out));
  } catch (e) {
    note(dir, `meta (sync) failed: ${errText(e)}`);
    return null;
  }
}

// ─────────────────────────── subprocesses and serialisation ───────────────────────────

/** pi executes several tool calls from one message in parallel by default;
 *  actions must be taken one at a time, which also makes "count actions.jsonl
 *  after the call returns" yield the right action number. */
let chain: Promise<unknown> = Promise.resolve();

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function adapter(dir: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("python3", [ADAPTER, ...args], {
      cwd: dir,
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout as string;
  } catch (e) {
    throw new Error(`ew adapter failed: ${errText(e)}`);
  }
}

/** The adapter writes actions.jsonl under `EW_RUN`, relative to its own cwd —
 *  which is the `dir` passed in here. Counting anywhere else would shift every
 *  action number in the episode. */
const EW_RUN = process.env.EW_RUN || ".";

function actionsFile(dir: string): string {
  return join(resolve(dir, EW_RUN), "actions.jsonl");
}

/**
 * The action number is the number of lines the adapter has written to
 * actions.jsonl.
 *
 * Unreadable, or still 0 after an act that was forwarded, is a hard failure: 0
 * would be written into `details.ew.n` and into the memo as if it were a real
 * action number, and every later citation would point at the wrong action. The
 * thrown message carries the environment's actual reply, so an observation that
 * has already been paid for is not swallowed by the error.
 */
function countActions(dir: string): number {
  const p = actionsFile(dir);
  try {
    if (!existsSync(p)) throw new Error(`${p} does not exist`);
    const n = readFileSync(p, "utf8").split("\n").filter((l) => l.trim().length > 0).length;
    if (n <= 0) throw new Error(`${p} records ${n} actions after a forwarded act`);
    return n;
  } catch (e) {
    note(dir, `action numbering failed: ${errText(e)}`);
    throw new Error(`ew action numbering failed: ${errText(e)}`);
  }
}

/** The memo stores the envelope body, without the closing submit line. */
function withoutFinished(stdout: string): string {
  return stdout.endsWith(FINISHED_TAIL)
    ? stdout.slice(0, stdout.length - FINISHED_TAIL.length + 1)
    : stdout;
}

// ─────────────────────────── tool declarations ───────────────────────────

const ewActParams = Type.Object({
  command: StringEnum(["brief", "actions", "act", "status"]),
  name: Type.Optional(Type.String({ description: "Action name. Required when command='act'." })),
  params: Type.Optional(
    Type.Any({ description: 'Parameter object for the action, e.g. {"event": "nausea"}.' }),
  ),
});

const phaseDoneParams = Type.Object({
  measured: Type.Array(Type.String(), {
    description: "The quantities you have actually measured this episode.",
  }),
  unmeasured: Type.Array(Type.String(), {
    description: "The ones you know you have NOT measured — the honest gaps.",
  }),
});

/** Where the metadata is currently fetched from: process.cwd() at load time,
 *  re-checked against ctx.cwd on the first tool call. */
let metaDir = "";

function metaOk(m: Record<string, ActionMeta> | null): boolean {
  return !!m && Object.keys(m).length > 0;
}

/** pi's session directory (ctx.cwd) could in principle differ from the
 *  process.cwd() seen at load time (under the runner they never do). If it does,
 *  log one line and refetch the metadata from ctx.cwd, which then wins. */
function syncMetaDir(dir: string): void {
  if (!dir || (metaDir && resolve(dir) === resolve(metaDir))) return;
  note(dir, `run dir differs from boot dir (boot=${metaDir} ctx=${dir}); refetching meta`);
  metaDir = dir;
  const fresh = loadMetaSync(dir);
  if (metaOk(fresh)) META = fresh;
  else note(dir, "meta refetch after run-dir change failed; keeping the boot-time metadata");
}

export default async function (pi: ExtensionAPI) {
  const bootDir = process.cwd();
  metaDir = bootDir;
  try {
    const { stdout } = await run("python3", [ADAPTER, "meta"], {
      cwd: bootDir,
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    META = parseMeta(stdout as string);
  } catch (e) {
    note(bootDir, `meta (async) failed: ${errText(e)}`);
  }
  // If the async call came back empty, retry synchronously; if that fails too,
  // do NOT register the tool — throw. Without metadata, GATE / SHAPE / PHASES and
  // the memo all become silent no-ops together, and an episode that scores while
  // every rule is inert is unfalsifiable. Better to fail loudly at start-up.
  if (!metaOk(META)) META = loadMetaSync(bootDir);
  if (!metaOk(META)) {
    const msg =
      `ew-env: could not obtain action metadata from \`python3 ${ADAPTER} meta\` in ` +
      `${bootDir}. Without it GATE / SHAPE / PHASES / the idempotent memo would all be ` +
      `silent no-ops, so the environment tool is NOT registered. See ${LOG_FILE} in the ` +
      "episode directory (check EW_EXAMPLES_REPO / EW_TASK / EW_SEED and that the adapter " +
      "was copied in).";
    note(bootDir, msg);
    throw new Error(msg);
  }
  if (resolve(bootDir, EW_RUN) !== resolve(bootDir)) {
    note(bootDir, `EW_RUN=${EW_RUN}: actions.jsonl will be counted in ` +
      `${resolve(bootDir, EW_RUN)}, not the episode dir`);
  }
  // The rule pack reads metadata only through this entry point. Load-time
  // checking already guarantees it is non-empty; the refetch here is a backstop.
  hub().getMeta = () => {
    if (!metaOk(META)) META = loadMetaSync(metaDir || bootDir);
    return META;
  };

  // Where the task brief is published. Its current consumer is the conditional
  // half of extensions/optional-pack.ts — "does the brief state a threshold" is
  // knowledge about the environment, so under the three-layer rule it has to come
  // from this layer. Fetched **lazily**: no caller, no subprocess, so a run
  // without that extension is byte-for-byte unaffected. `brief` is a free
  // command: it writes no action, enters no trajectory, and is not charged.
  hub().getBrief = () => {
    if (BRIEF !== null) return BRIEF;
    const dir = metaDir || bootDir;
    try {
      BRIEF = String(
        execFileSync("python3", [ADAPTER, "brief"], {
          cwd: dir,
          encoding: "utf8",
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch (e) {
      note(dir, `brief fetch failed: ${errText(e)}`);
      BRIEF = "";
    }
    return BRIEF;
  };

  pi.registerTool({
    name: "ew_act",
    label: "Executable World",
    description:
      "Your ONLY interface to the benchmark environment. " +
      "command='brief' prints the task brief (free). " +
      "command='actions' lists the available actions with their costs (free). " +
      "command='status' shows actions taken and remaining budget (free). " +
      "command='act' takes one charged action: set 'name' to the action name and " +
      "'params' to its parameter object (omit for actions without parameters). " +
      "Every act reply uses the envelope {protocol, status, cost_charged, " +
      "budget_remaining, observation}; a status:'error' reply is charged but " +
      "never fatal. Each acted reply is labelled [action #N] — cite these numbers " +
      "as evidence. One action per call; parallel calls are allowed.",
    parameters: ewActParams,
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const dir = runDir(ctx);
      syncMetaDir(dir);
      const command = p.command as string;
      if (command !== "act") {
        const stdout = await adapter(dir, [command]);
        return {
          content: [{ type: "text" as const, text: stdout }],
          details: { ew: { kind: "free", command } },
        };
      }
      const name = typeof p.name === "string" ? p.name : "";
      if (!name) throw new Error("command='act' requires 'name' (the action name).");
      const raw = p.params;
      const params: Record<string, unknown> =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>) }
          : {};
      // The escape-hatch key is never forwarded to the environment (the tool_call
      // hook normally strips it already; this is the backstop).
      hub().guards?.stripEscape(params);

      return withLock(async () => {
        const g = hub().guards;
        const hit = g ? g.memoLookup(dir, name, params) : null;
        if (hit) {
          return {
            content: [{ type: "text" as const, text: hit.text }],
            details: {
              ew: { kind: "act", command, name, params, forwarded: false, memoHit: hit.n, n: null },
            },
          };
        }
        const stdout = await adapter(dir, ["act", name, JSON.stringify(params)]);
        let n: number;
        try {
          n = countActions(dir);
        } catch (e) {
          // Numbering failed — but this call was already forwarded and already
          // charged, so carry the environment's reply into the error text rather
          // than losing an observation that has been paid for.
          throw new Error(
            `${errText(e)} — the action WAS forwarded and charged, but your scaffold ` +
              "cannot number this reply, so do not cite an action number for it. " +
              `The environment answered:\n${stdout}`,
          );
        }
        g?.memoStore(dir, name, params, n, withoutFinished(stdout));
        return {
          content: [{ type: "text" as const, text: stdout }],
          details: {
            ew: { kind: "act", command, name, params, forwarded: true, memoHit: null, n },
          },
        };
      });
    },
  });

  if (!PHASES_ON) return;

  pi.registerTool({
    name: "ew_phase_done",
    label: "Phase handoff",
    description:
      "Free, local, and never forwarded to the environment: ends the EXPLORE phase " +
      "and opens the DECIDE phase, where submit is available again. " +
      "'measured' = the quantities you have actually measured this episode; " +
      "'unmeasured' = the ones you know you have NOT measured. Both lists must hold " +
      "at least one non-empty string. Nothing is charged and nothing is recorded as " +
      "an action.",
    parameters: phaseDoneParams,
    async execute(_toolCallId, p, _signal, _onUpdate, ctx) {
      const dir = runDir(ctx);
      syncMetaDir(dir);
      const g = hub().guards;
      const text = g
        ? g.phaseDone(dir, p.measured, p.unmeasured)
        : "phase: the guard rule pack is not loaded; phase gating is not in effect.";
      return {
        // Trailing newline: the adapter prints this reply, so what the model sees
        // is the version with the newline.
        content: [{ type: "text" as const, text: `${text}\n` }],
        details: { ew: { kind: "free", command: "phase_done" } },
      };
    },
  });
}
