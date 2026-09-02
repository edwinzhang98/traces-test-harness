#!/usr/bin/env python3
"""Run a batch of experiments, collecting each episode's artifacts and run
metadata under a single batch directory.

Configuration is declarative: one run = one TOML (config.toml ships the final
configuration):

    python3 run_experiment.py                                   # config.toml, 5 tasks x 3 seeds
    python3 run_experiment.py --tasks clinical_signal --seeds 0 # one episode
    python3 run_experiment.py --config other.toml --label trial # another config file

Command-line arguments override the matching keys in the config file.

Output layout:
    batches/<label>/<task>-s<seed>-r<rep>/   <- one episode: trajectory/result/pi-session
    batches/<label>/runs.jsonl               <- one line per episode: exit code,
                                                wall time, score, submitted or not
    batches/<label>/batch.json               <- full config snapshot for the batch
                                                (including the harness version)
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import tomllib

HERE = os.path.dirname(os.path.abspath(__file__))
ALL_TASKS = ["verify_solutions", "corpus_dedup", "corpus_procurement",
             "treatment_response", "clinical_signal"]

# Bridge flag name -> environment variable. All false = v0 behavior, all true = v1.
BRIDGE_FLAGS = {"gate": "EW_BRIDGE_GATE", "dup_warning": "EW_BRIDGE_DUP",
                "repair_note": "EW_BRIDGE_REPAIR", "budget_notes": "EW_BRIDGE_BUDGET",
                "action_numbers": "EW_BRIDGE_NUM", "cache": "EW_BRIDGE_CACHE"}


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


def one_run(task, seed, rep, cfg, batch_dir):
    name = f"{task}-s{seed}-r{rep}"
    run_dir = os.path.join(batch_dir, name)
    if os.path.exists(run_dir):
        shutil.rmtree(run_dir)
    os.makedirs(run_dir)
    shutil.copy(os.path.join(HERE, "bridge", "ew_act.py"), run_dir)

    # Experiment isolation (fixed after the 2026-08-31 audit): load nothing from the
    # local machine's personal configuration beyond what is declared explicitly here.
    # -nc/-ns/-ne disable context-file/skill/extension discovery; -np disables prompt
    # template discovery; --no-themes disables themes; -na locks project trust to no;
    # --offline blocks startup network activity (package installs/refreshes, tool
    # downloads); --append-system-prompt "" disables APPEND_SYSTEM.md auto-discovery
    # (that channel is not affected by --system-prompt).
    cmd = [resolve_pi(), "--provider", cfg["provider"], "--model", cfg["model"],
           "--session-dir", "./pi-session",
           "-ne", "-ns", "-nc", "-np", "--no-themes", "-na", "--offline",
           "--append-system-prompt", ""]
    if cfg["thinking"]:
        cmd += ["--thinking", cfg["thinking"]]
    if cfg["system_prompt"]:
        cmd += ["--system-prompt", open(os.path.join(HERE, cfg["system_prompt"])).read()]
    # Extensions (since v3): copy each extension file into the episode directory and
    # load that archived copy, so what ran is exactly what was stored.
    for ext in cfg["extensions"]:
        dst = os.path.join(run_dir, os.path.basename(ext))
        shutil.copy(os.path.join(HERE, ext), dst)
        cmd += ["-e", os.path.abspath(dst)]
    if cfg["tools"]:
        cmd += ["--tools", cfg["tools"]]
    cmd += ["-p", open(os.path.join(HERE, cfg["task_prompt"])).read()]

    env = dict(os.environ, EW_TASK=task, EW_SEED=str(seed), EW_RUN=".",
               EW_DEADLINE=str(cfg["deadline"] or ""))
    for key, var in BRIDGE_FLAGS.items():
        env[var] = "1" if cfg["bridge"].get(key) else "0"
    # pi keeps its provider/model configuration (models.json) in an "agent directory",
    # by default ~/.pi/agent — global user state. Point it at the repo-local pi-agent/
    # instead, unless the caller already chose one, so nothing outside this repository
    # is consulted. (Custom endpoints/relays go in pi-agent/models.json, see README.)
    agent_dir = os.environ.get("PI_CODING_AGENT_DIR") or os.path.join(HERE, "pi-agent")
    os.makedirs(agent_dir, exist_ok=True)
    env["PI_CODING_AGENT_DIR"] = agent_dir

    t0 = time.time()
    timed_out = False
    try:
        # stdin must be /dev/null: in non-interactive mode pi appends standard input
        # to the opening message, so inheriting a pipe that never closes hangs forever
        # (diagnosed during the 2026-08-31 v3 smoke test).
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

    mark = "✓" if row["submitted"] else ("⏱ timeout" if timed_out else "✗ not submitted")
    print(f"  {mark} {name:38} score={row['score']}  {row['n_actions']} steps "
          f"({row['n_errors']} errors)  {wall}s  exit={code}", flush=True)
    return row


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="config.toml", help="experiment config TOML (default config.toml); command-line arguments override its matching keys")
    ap.add_argument("--label", help="batch name; defaults to run.label from the config, or the config file name")
    ap.add_argument("--tasks", help="comma-separated, or all")
    ap.add_argument("--seeds", help="comma-separated")
    ap.add_argument("--repeat", type=int, help="repetitions per task/seed combination")
    ap.add_argument("--provider")
    ap.add_argument("--model")
    ap.add_argument("--thinking")
    ap.add_argument("--prompt", help="task prompt file (path relative to this repository)")
    ap.add_argument("--system-prompt", help="system prompt file; empty = pi default")
    ap.add_argument("--timeout", type=int, help="wall-clock limit per episode (seconds)")
    ap.add_argument("--deadline", type=int, help="time budget announced to the agent (seconds); 0 = disabled")
    args = ap.parse_args()

    raw = load_config(args.config)["run"] if args.config else {}
    prompts = raw.get("prompts", {})
    bridge = raw.get("bridge", {})

    cfg = {
        "provider": args.provider or raw.get("provider", "openai-codex"),
        "model": args.model or raw.get("model", "gpt-5.5"),
        "thinking": args.thinking if args.thinking is not None else raw.get("thinking", "medium"),
        "task_prompt": args.prompt or prompts.get("task", "prompts/task-v0.md"),
        "system_prompt": args.system_prompt if args.system_prompt is not None
                         else prompts.get("system", ""),
        "timeout": args.timeout or raw.get("timeout", 1200),
        "deadline": args.deadline if args.deadline is not None else raw.get("deadline", 0),
        "bridge": {k: bool(bridge.get(k, False)) for k in BRIDGE_FLAGS},
        "extensions": list(raw.get("extensions", [])),
        "tools": raw.get("tools", ""),
    }
    label = args.label or raw.get("label") or (
        os.path.splitext(os.path.basename(args.config))[0] if args.config else None)
    if not label:
        sys.exit("need --label, or run.label in the config file")
    tasks_v = args.tasks or raw.get("tasks", "all")
    tasks = ALL_TASKS if tasks_v == "all" else (
        tasks_v.split(",") if isinstance(tasks_v, str) else list(tasks_v))
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
    print(f"batch {label}: {cfg['model']} × {len(tasks)} tasks × {len(seeds)} seeds "
          f"× {repeat} reps = {total} episodes  bridge flags {cfg['bridge']}\n", flush=True)

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
