#!/usr/bin/env python3
"""Run a batch of episodes, collecting each episode's artifacts and run metadata
under one batch directory.

Configuration is declarative: one run = one TOML (config.toml ships the default
configuration):

    python3 run_experiment.py                                   # config.toml, 5 tasks x 3 seeds
    python3 run_experiment.py --tasks corpus_dedup --seeds 0    # one episode
    python3 run_experiment.py --config other.toml --label trial # another config file

Command-line arguments override the matching keys in the config file.

Output layout:
    batches/<label>/<task>-s<seed>-r<rep>/   <- one episode: trajectory/result/pi-session
    batches/<label>/runs.jsonl               <- one line per episode: exit code,
                                                wall time, score, submitted or not
    batches/<label>/batch.json               <- full config snapshot for the batch

Extension pack switches: the `[run.guards]` table maps to the EW_GUARD_*
environment variables read by extensions/guards.ts, extensions/phases.ts and
extensions/optional-pack.ts. Every switch is injected explicitly as "1"/"0" into
each episode (so a stray EW_GUARD_* left in the shell cannot change a run
silently) and is written verbatim into batch.json. The config file is
authoritative; keys missing from the table fall back to the extensions' own
defaults: gate, dup_warning, repair_note, budget_notes, action_numbers, cache,
cache_safe and shape on; phases, phases_reset and optional_pack off. (The
shipped config.toml turns optional_pack on.) The optional `explore_frac` maps to
EW_GUARD_PHASES_EXPLORE_FRAC (default 0.5) and only matters when phases is on.

`phases_reset` is the strong form of phase gating (extensions/phases.ts). Turning
it on takes four things at once: `phases = true`, "extensions/phases.ts" in the
`extensions` list, and both `ew_recall` and `ew_phase_done` in the `tools`
whitelist. Miss any one of them and the batch still runs and still scores, while
batch.json records `phases_reset: true` and the episodes actually ran without the
reset — so check_phases_coupling() refuses to start such a batch.

Stress instances: `[run] scale = "clinical_signal=10,corpus_dedup=5:words=28"`
(or --scale) is injected verbatim as EW_SCALE; empty/absent = no scaling. When
the adapter has a scale.py next to it, it is copied into each episode directory
too. Scaled task names (`<task>_x<k>`) must be listed explicitly in `tasks`
("all" only expands the five original tasks) and are checked against what the
spec actually registers before anything is spent.
"""
import argparse
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import time
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
ALL_TASKS = ["verify_solutions", "corpus_dedup", "corpus_procurement",
             "treatment_response", "clinical_signal"]
# Scaled task names: `<original task>_x<k>`, registered by `[run] scale`
# (see adapters/traces/scale.py).
SCALED_TASK_RE = re.compile(r"^[a-z_]+_x\d+$")

# Extension pack switch -> environment variable. Each is read once, at load time,
# by the extension that owns it.
GUARD_FLAGS = {"gate": "EW_GUARD_GATE", "dup_warning": "EW_GUARD_DUP",
               "repair_note": "EW_GUARD_REPAIR", "budget_notes": "EW_GUARD_BUDGET",
               "action_numbers": "EW_GUARD_NUM", "cache": "EW_GUARD_CACHE",
               "cache_safe": "EW_GUARD_CACHE_SAFE", "shape": "EW_GUARD_SHAPE",
               "phases": "EW_GUARD_PHASES",
               # The strong form of phase gating (extensions/phases.ts): context
               # reset at the phase boundary + a pinned briefing + the free
               # ew_recall tool. Off by default; see check_phases_coupling.
               "phases_reset": "EW_GUARD_PHASES_RESET",
               # The writing-protocol pack (extensions/optional-pack.ts): extra
               # task-side text appended to the system prompt. Off in this table,
               # on in the shipped config.toml, which wins.
               "optional_pack": "EW_GUARD_OPTIONAL_PACK"}
# Defaults used for keys absent from [run.guards]; identical to the defaults
# compiled into the extensions themselves (eight rules on; the phase gate, its
# strong form and the writing-protocol pack off). The config file is
# authoritative: whatever [run.guards] states overrides these.
GUARD_DEFAULTS = {k: (k not in ("phases", "phases_reset", "optional_pack"))
                  for k in GUARD_FLAGS}
GUARD_FRAC_VAR = "EW_GUARD_PHASES_EXPLORE_FRAC"
GUARD_FRAC_DEFAULT = 0.5


def load_dotenv():
    """Load KEY=VALUE pairs from a .env file next to this script, if present, so
    credentials can live in a gitignored file instead of the shell environment.
    Blank lines and # comments are skipped; surrounding whitespace and one pair
    of matching quotes are stripped. Variables already exported in the real
    environment always win and are never overwritten."""
    path = os.path.join(HERE, ".env")
    if not os.path.isfile(path):
        return
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip()
            if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                value = value[1:-1]
            if key and key not in os.environ:
                os.environ[key] = value


# Applied at import time, before anything reads a credential from the environment.
load_dotenv()


def resolve_pi():
    """Locate the pi executable, in priority order:
    1. $PI_BIN, if set (explicit override);
    2. the repository-local node_modules/.bin/pi installed by `npm install`;
    3. plain "pi", resolved from PATH (e.g. a global install)."""
    override = os.environ.get("PI_BIN")
    if override:
        return override
    local = os.path.join(HERE, "node_modules", ".bin", "pi")
    if os.path.isfile(local) and os.access(local, os.X_OK):
        return local
    return "pi"


def load_config(path):
    with open(path, "rb") as fh:
        return tomllib.load(fh)


def guards_cfg(raw):
    """[run.guards] -> {switch: bool}; missing keys filled from GUARD_DEFAULTS.

    Unknown keys are a hard error rather than a silent no-op: a misspelt switch
    that quietly does nothing is worse than a run that refuses to start."""
    tbl = raw.get("guards", {}) or {}
    unknown = sorted(set(tbl) - set(GUARD_FLAGS) - {"explore_frac"})
    if unknown:
        sys.exit(f"unknown switch(es) in [run.guards]: {', '.join(unknown)}; "
                 f"available: {', '.join(sorted(GUARD_FLAGS))}, explore_frac")
    return {k: bool(tbl.get(k, GUARD_DEFAULTS[k])) for k in GUARD_FLAGS}


def guards_env(cfg):
    """The EW_GUARD_* variables to inject into the episode. All written
    explicitly as "1"/"0" so inherited variables of the same name cannot win."""
    g = cfg.get("guards") or GUARD_DEFAULTS
    env = {var: ("1" if g.get(key, GUARD_DEFAULTS[key]) else "0")
           for key, var in GUARD_FLAGS.items()}
    env[GUARD_FRAC_VAR] = str(cfg.get("guards_explore_frac", GUARD_FRAC_DEFAULT))
    return env


def check_phases_coupling(cfg):
    """Refuse to start a batch whose `phases_reset = true` is not backed by the
    other three settings it needs.

    The strong form is only actually in effect when all four hold:
      1. guards.phases = true            -- without the phase gate there is no
                                            explore -> decide switch, so the reset
                                            can never happen;
      2. extensions contains phases.ts   -- without it there is no context hook and
                                            nothing is reset;
      3. tools contains ew_recall        -- otherwise archived observations cannot
                                            be retrieved;
      4. tools contains ew_phase_done    -- otherwise the model cannot hand over
                                            by itself.
    Miss one and the batch runs anyway and produces a score, while batch.json
    plainly records `phases_reset: true` -- a snapshot that contradicts what ran.
    Checked before anything is spent; no effect at all on any other configuration."""
    if not cfg["guards"].get("phases_reset"):
        return
    bad = []
    if not cfg["guards"].get("phases"):
        bad.append("[run.guards] phases = true (the phase gate; without it there is "
                   "no explore -> decide switch)")
    if not any(os.path.basename(e) == "phases.ts" for e in cfg["extensions"]):
        bad.append('[run] extensions must list "extensions/phases.ts" (the strong '
                   "form's implementation)")
    tools = [t.strip() for t in (cfg["tools"] or "").split(",") if t.strip()]
    for t in ("ew_recall", "ew_phase_done"):
        if t not in tools:
            bad.append(f'[run] tools must whitelist "{t}"'
                       + (" (or archived observations cannot be retrieved)"
                          if t == "ew_recall"
                          else " (or the model cannot hand over by itself)"))
    if bad:
        sys.exit("[run.guards] phases_reset = true, but this configuration is "
                 "incomplete: the episodes would run without the context reset "
                 "while batch.json claims otherwise.\n"
                 + "\n".join(f"  - missing {b}" for b in bad)
                 + "\nSee README.md, \"Configuration\".")


def scale_registers(scale_spec, bridge_path):
    """Which scaled task names `[run] scale` registers.

    The source of truth is the scale.py sitting next to the adapter: parse_spec
    only parses the spec string and does not import the task package, so calling
    it from this process is safe. No scale.py next to the adapter (an adapter
    with no stress-instance support) returns None and the caller falls back to
    checking the shape of the name only."""
    if not scale_spec:
        return set()
    path = os.path.join(os.path.dirname(os.path.join(HERE, bridge_path)), "scale.py")
    if not os.path.exists(path):
        return None
    try:
        spec = importlib.util.spec_from_file_location("_ew_scale_probe", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return {f"{t}_x{k}" for t, (k, _opts) in mod.parse_spec(scale_spec).items()}
    except ValueError as e:                 # a malformed spec: fail now, not mid-run
        sys.exit(f"[run] scale failed to parse: {e}")
    except Exception:                       # cannot probe: fall back to the shape check
        return None


def check_tasks(tasks, scale_spec, bridge_path):
    """Task-name gate. Original tasks always pass; a `<task>_x<k>` name passes
    only when `[run] scale` is non-empty and actually registers it. Catching a
    typo here costs nothing; catching it after an episode starts costs an
    episode."""
    registers = scale_registers(scale_spec, bridge_path)
    bad = []
    for t in tasks:
        if t in ALL_TASKS:
            continue
        if SCALED_TASK_RE.match(t) and scale_spec and (
                registers is None or t in registers):
            continue
        bad.append(t)
    if bad:
        hint = (f"scale registers: {', '.join(sorted(registers)) or '(none)'}"
                if registers else
                ("[run] scale is empty — scaled task names need a scale spec"
                 if not scale_spec else "no scale.py found; only the name shape was checked"))
        sys.exit(f"unknown task name(s): {', '.join(bad)}. "
                 f"Original tasks: {', '.join(ALL_TASKS)}; {hint}")
    return tasks


def one_run(task, seed, rep, cfg, batch_dir):
    name = f"{task}-s{seed}-r{rep}"
    run_dir = os.path.join(batch_dir, name)
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
    os.makedirs(run_dir)
    bridge = os.path.join(HERE, cfg.get("bridge_path") or "adapters/traces/ew_act.py")
    shutil.copy(bridge, os.path.join(run_dir, "ew_act.py"))
    # Stress instances: if the adapter ships a scale.py next to it, copy that in
    # too, so the episode directory stays self-contained (what ran is what was
    # stored). An adapter without one simply runs unscaled.
    sibling = os.path.join(os.path.dirname(bridge), "scale.py")
    if os.path.exists(sibling):
        shutil.copy(sibling, os.path.join(run_dir, "scale.py"))

    # Isolation: load nothing from the local machine's personal configuration
    # beyond what is declared here. -nc/-ns/-ne disable context-file/skill/extension
    # discovery; -np disables prompt template discovery; --no-themes disables themes;
    # -na locks project trust to no; --offline blocks start-up network activity
    # (package installs/refreshes, tool downloads); --append-system-prompt ""
    # disables APPEND_SYSTEM.md auto-discovery (that channel is not affected by
    # --system-prompt).
    cmd = [resolve_pi(), "--provider", cfg["provider"], "--model", cfg["model"],
           "--session-dir", "./pi-session",
           "-ne", "-ns", "-nc", "-np", "--no-themes", "-na", "--offline",
           "--append-system-prompt", ""]
    if cfg["thinking"]:
        cmd += ["--thinking", cfg["thinking"]]
    if cfg["system_prompt"]:
        cmd += ["--system-prompt", open(os.path.join(HERE, cfg["system_prompt"])).read()]
    # Extensions: copy each file into the episode directory and load that archived
    # copy, so what ran is exactly what was stored. Load order is the order of the
    # list in the config.
    for ext in cfg["extensions"]:
        dst = os.path.join(run_dir, os.path.basename(ext))
        shutil.copy(os.path.join(HERE, ext), dst)
        cmd += ["-e", os.path.abspath(dst)]
    if cfg["tools"]:
        cmd += ["--tools", cfg["tools"]]
    cmd += ["-p", open(os.path.join(HERE, cfg["task_prompt"])).read()]

    # EW_SCALE and EW_DEADLINE are injected explicitly (empty string when unset),
    # so a leftover EW_SCALE in the shell cannot silently scale the next batch.
    env = dict(os.environ, EW_TASK=task, EW_SEED=str(seed), EW_RUN=".",
               EW_DEADLINE=str(cfg["deadline"] or ""),
               EW_SCALE=str(cfg.get("scale") or ""))
    # Extension pack switches: explicit, overriding anything inherited.
    env.update(guards_env(cfg))
    # pi keeps its provider/model configuration (models.json) and its logins in an
    # "agent directory", by default ~/.pi/agent — global user state. Point it at the
    # repo-local pi-agent/ instead, unless the caller already chose one, so nothing
    # outside this repository is consulted. Custom endpoints/relays go in
    # pi-agent/models.json; login-based providers need PI_CODING_AGENT_DIR set to the
    # directory holding that login (see README "Model access").
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(HERE, "pi-agent")
    os.makedirs(agent_dir, exist_ok=True)
    env["PI_CODING_AGENT_DIR"] = agent_dir

    t0 = time.time()
    timed_out = False
    try:
        # stdin must be /dev/null: in non-interactive mode pi appends standard input
        # to the opening message, so inheriting a pipe that never closes hangs forever.
        p = subprocess.run(cmd, cwd=run_dir, env=env, timeout=cfg["timeout"],
                           capture_output=True, text=True, stdin=subprocess.DEVNULL)
        code, stdout, stderr = p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired as e:
        timed_out = True
        code = -1
        stdout = (e.stdout or b"").decode(errors="replace") if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = (e.stderr or b"").decode(errors="replace") if isinstance(e.stderr, bytes) else (e.stderr or "")
    wall = round(time.time() - t0, 1)

    with open(os.path.join(run_dir, "pi-stdout.log"), "w") as fh:
        fh.write(stdout + ("\n--- stderr ---\n" + stderr if stderr else ""))

    rp = os.path.join(run_dir, "result.json")
    result = json.load(open(rp)) if os.path.exists(rp) else None
    tp = os.path.join(run_dir, "trajectory.jsonl")
    rows = [json.loads(l) for l in open(tp)] if os.path.exists(tp) else []

    row = {
        "task": task, "seed": seed, "rep": rep, "dir": name,
        "provider": cfg["provider"], "model": cfg["model"],
        "exit_code": code, "timed_out": timed_out, "wall_seconds": wall,
        "submitted": result is not None,
        "score": (result or {}).get("score"),
        "gate_passed": (result or {}).get("gate_passed"),
        "n_actions": len(rows),
        "n_errors": sum(1 for r in rows if r.get("status") != "ok"),
    }
    with open(os.path.join(batch_dir, "runs.jsonl"), "a") as fh:
        fh.write(json.dumps(row, ensure_ascii=False) + "\n")

    mark = "OK " if row["submitted"] else ("timeout" if timed_out else "not submitted")
    print(f"  {mark} {name:38} score={row['score']}  {row['n_actions']} steps "
          f"({row['n_errors']} errors)  {wall}s  exit={code}", flush=True)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.toml",
                    help="configuration TOML (default config.toml); command-line "
                         "arguments override its matching keys")
    ap.add_argument("--label", help="batch name; defaults to run.label from the config, "
                                    "or the config file name")
    ap.add_argument("--tasks", help="comma-separated, or all")
    ap.add_argument("--seeds", help="comma-separated")
    ap.add_argument("--repeat", type=int, help="repetitions per task/seed combination")
    ap.add_argument("--provider")
    ap.add_argument("--model")
    ap.add_argument("--thinking")
    ap.add_argument("--prompt", help="task prompt file (path relative to this repository)")
    ap.add_argument("--system-prompt", help="system prompt file; empty = pi default")
    ap.add_argument("--timeout", type=int, help="wall-clock limit per episode (seconds)")
    ap.add_argument("--deadline", type=int,
                    help="time budget announced to the agent (seconds); 0 = disabled")
    ap.add_argument("--scale", help="stress-instance spec (EW_SCALE), e.g. "
                                    "clinical_signal=10,corpus_dedup=5:words=28; empty = off")
    args = ap.parse_args()

    raw = load_config(args.config)["run"] if args.config else {}
    prompts = raw.get("prompts", {})
    guards = raw.get("guards", {}) or {}

    cfg = {
        "provider": args.provider or raw.get("provider", "openai"),
        "model": args.model or raw.get("model", "gpt-5.5"),
        "thinking": args.thinking if args.thinking is not None else raw.get("thinking", "medium"),
        "task_prompt": args.prompt or prompts.get("task", "prompts/task-tool-v1.md"),
        "system_prompt": args.system_prompt if args.system_prompt is not None
                         else prompts.get("system", ""),
        "timeout": args.timeout or raw.get("timeout", 1200),
        "deadline": args.deadline if args.deadline is not None else raw.get("deadline", 0),
        # Extension pack switches, snapshotted into batch.json for the record.
        "guards": guards_cfg(raw),
        "guards_explore_frac": float(guards.get("explore_frac", GUARD_FRAC_DEFAULT)),
        # The adapter to use. Whatever it is called, it is copied into the episode
        # directory as ew_act.py (the name the extension pack invokes).
        "bridge_path": raw.get("bridge_path", "adapters/traces/ew_act.py"),
        "extensions": list(raw.get("extensions", [])),
        "tools": raw.get("tools", ""),
        "scale": args.scale if args.scale is not None else raw.get("scale", ""),
    }
    label = args.label or raw.get("label") or (
        os.path.splitext(os.path.basename(args.config))[0] if args.config else None)
    if not label:
        sys.exit("need --label, or run.label in the config file")
    tasks_v = args.tasks or raw.get("tasks", "all")
    tasks = ALL_TASKS if tasks_v == "all" else (
        tasks_v.split(",") if isinstance(tasks_v, str) else list(tasks_v))
    # "all" expands to the original tasks only — scaled names must be listed.
    check_tasks(tasks, cfg["scale"], cfg["bridge_path"])
    # The strong phase form needs four settings together; catch a half-configured
    # batch before the batch directory exists, let alone an episode.
    check_phases_coupling(cfg)
    seeds_v = args.seeds or raw.get("seeds", [0])
    seeds = [int(s) for s in (seeds_v.split(",") if isinstance(seeds_v, str) else seeds_v)]
    repeat = args.repeat or raw.get("repeat", 1)

    batch_dir = os.path.join(HERE, "batches", label)
    os.makedirs(batch_dir, exist_ok=True)

    try:
        hv = subprocess.run(["git", "describe", "--tags", "--always", "--dirty"],
                            cwd=HERE, capture_output=True, text=True).stdout.strip()
    except Exception:
        hv = "unknown"
    meta = {"label": label, "config_file": args.config, "harness_version": hv,
            **{k: v for k, v in cfg.items()},
            "tasks": tasks, "seeds": seeds, "repeat": repeat,
            "started": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(os.path.join(batch_dir, "batch.json"), "w") as fh:
        json.dump(meta, fh, ensure_ascii=False, indent=2)

    total = len(tasks) * len(seeds) * repeat
    guards_on = sorted(k for k, v in cfg["guards"].items() if v)
    guards_off = sorted(k for k, v in cfg["guards"].items() if not v)
    scale_line = f"  stress instances (EW_SCALE): {cfg['scale']}\n" if cfg["scale"] else ""
    print(f"batch {label}: {cfg['model']} x {len(tasks)} tasks x {len(seeds)} seeds "
          f"x {repeat} reps = {total} episodes\n"
          f"  extension pack: on={','.join(guards_on) or '(none)'} "
          f"off={','.join(guards_off) or '(none)'}\n"
          f"{scale_line}",
          flush=True)

    rows = []
    for task in tasks:
        for seed in seeds:
            for rep in range(repeat):
                rows.append(one_run(task, seed, rep, cfg, batch_dir))

    ok = sum(1 for r in rows if r["submitted"])
    print(f"\nfinished {len(rows)} episodes: {ok} submitted, {len(rows)-ok} did not. "
          f"index: batches/{label}/runs.jsonl")


if __name__ == "__main__":
    main()
