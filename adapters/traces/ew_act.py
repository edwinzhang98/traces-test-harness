#!/usr/bin/env python3
"""Environment adapter (thin): pi's native tools <-> Executable World task objects.

The adapter does exactly three things: **protocol translation, trajectory
recording, and a one-shot metadata declaration**. Every scaffolding rule --
action numbering, the error / duplicate / budget / time notes, the submission
gate, the idempotence memo, parameter-shape checking, the phase gate -- lives in
the pi extensions (`extensions/guards.ts`). This file does not print one word of
guidance.

    python3 ew_act.py brief                       # task brief (free)
    python3 ew_act.py actions                     # action list with costs (free)
    python3 ew_act.py act <name> ['{"k": "v"}']   # take one action (charged)
    python3 ew_act.py status                      # progress + budget (free)
    python3 ew_act.py meta                        # metadata declaration (JSON)

`meta` declares facts only, never policy: per action its cost / doc / params
(top-level parameter names, parsed from the signature the brief publishes) /
signature (that signature line verbatim) / irreversible (is it `submit`) /
idempotent (not submit or declare_limitation, and the name does not contain
sample|random|draw). What the rules make of those facts is the extensions'
business.

One CLI call = one action. The environment is deterministic (same task + seed
always generates the same instance), so episode state is reconstructed on every
call by replaying the actions recorded in actions.jsonl. trajectory.jsonl is
rewritten in full on each replay, so it is always the complete trajectory.

Config via environment: EW_TASK (default clinical_signal), EW_SEED (default 0),
EW_RUN (run directory, default '.'), EW_SCALE (scaled-task spec string, empty by
default = register no scaled task at all, byte-for-byte identical to the scaler
not existing; the grammar is documented at the top of the sibling file scale.py).
"""
import fcntl
import json
import os
import re
import sys


def _find_examples_repo():
    """Locate the official practice package executable-world-examples.
    Priority: the EW_EXAMPLES_REPO environment variable > a clone under vendor/
    walking up from this file > a clone sitting next to any of those directories.
    If none is found, print a clear installation hint."""
    env = os.environ.get("EW_EXAMPLES_REPO")
    if env:
        return env
    d = os.path.dirname(os.path.abspath(__file__))
    while True:
        for cand in (os.path.join(d, "vendor", "executable-world-examples"),
                     os.path.join(d, "executable-world-examples")):
            if os.path.isdir(os.path.join(cand, "ew_examples")):
                return cand
        parent = os.path.dirname(d)
        if parent == d:
            sys.exit("cannot find the practice package executable-world-examples. "
                     "git clone https://github.com/ApodexAI/executable-world-examples "
                     "next to this repository, or point EW_EXAMPLES_REPO at it.")
        d = parent


REPO = _find_examples_repo()
sys.path.insert(0, REPO)
from ew_examples import Episode, load_task  # noqa: E402

# Scaled practice tasks: register instances 3-10x larger into
# ew_examples.tasks.TASKS. This has to come after the import above, because
# scale itself imports ew_examples.tasks. Sibling import (not
# `from adapters.traces import scale`): the runner copies the adapter into the
# run directory, where there are only flat files.
# EW_SCALE empty / unset = register nothing = byte-for-byte identical to the
# scaler not existing (the default, and the safety valve).
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # sibling scale.py
import scale  # noqa: E402
scale.register(os.environ.get("EW_SCALE", ""))

TASK = os.environ.get("EW_TASK", "clinical_signal")
SEED = int(os.environ.get("EW_SEED", "0"))
RUN = os.environ.get("EW_RUN", ".")

# The closing line printed after submission. It is not a "note" but part of the
# protocol (it was there in v0); the extensions insert their notes before this
# constant so the layout order stays exactly what it was.
FINISHED_LINE = "[episode finished — result.json written]"

# The factual definitions used by the metadata declaration. Policy lives in the
# extensions; these are statements of fact only.
NEVER_IDEMPOTENT = {"submit", "declare_limitation"}
NEVER_IDEMPOTENT_SUBSTR = ("sample", "random", "draw")
IRREVERSIBLE = {"submit"}


def recorded_actions():
    path = os.path.join(RUN, "actions.jsonl")
    if not os.path.exists(path):
        return []
    with open(path) as fh:
        return [json.loads(line) for line in fh if line.strip()]


def replay():
    task = load_task(TASK, seed=SEED)
    ep = Episode(task, trajectory_path=os.path.join(RUN, "trajectory.jsonl"))
    for row in recorded_actions():
        ep.act(row["action"], row["params"])
    return task, ep


# ── metadata declaration ────────────────────────────────────────────────────
# Signature parsing is word-for-word what the earlier bridge did, so the guard
# rules see exactly the same set of parameter names they always have.
SHAPE_SIG_RE = re.compile(r"^\s*([a-z_]+)\(([^)]*)\)")


def _sig_ident(token):
    """One parameter token from a signature -> the parameter name. `n<=20` -> `n`,
    `subgroup=...` -> `subgroup`. Returns None when there is no identifier to
    take (e.g. `...`)."""
    m = re.match(r"[a-z_][a-z0-9_]*", token.strip())
    return m.group(0) if m else None


def brief_signatures(text):
    """Parse the brief text into action name -> set of top-level parameter names
    (the union over every line for a repeated action name).

    Only `name(args)` at the start of a line (after stripping indentation) is
    recognised, so an in-line mention such as `is_balanced(s)` in the prose is
    not picked up by mistake. A no-argument signature like `calibration()` gives
    the empty set = no check."""
    sig = {}
    for line in text.splitlines():
        m = SHAPE_SIG_RE.match(line)
        if not m:
            continue
        names = {n for n in (_sig_ident(t) for t in m.group(2).split(",")) if n}
        sig.setdefault(m.group(1), set()).update(names)
    return sig


def brief_signature_line(text, name):
    """The verbatim signature line for that action in the brief (first match)."""
    for line in text.splitlines():
        m = SHAPE_SIG_RE.match(line)
        if m and m.group(1) == name:
            return line.strip()
    return ""


def meta_cmd():
    task = load_task(TASK, seed=SEED)
    brief = task.brief
    sigs = brief_signatures(brief)
    actions = {}
    for name, spec in sorted(task.actions().items()):
        low = name.lower()
        actions[name] = {
            "cost": spec.cost,
            "doc": spec.doc,
            "params": sorted(sigs.get(name) or []),
            "signature": brief_signature_line(brief, name),
            "irreversible": name in IRREVERSIBLE,
            "idempotent": name not in NEVER_IDEMPOTENT and not any(
                w in low for w in NEVER_IDEMPOTENT_SUBSTR),
        }
    print(json.dumps({"task": TASK, "seed": SEED, "actions": actions},
                     indent=2, ensure_ascii=False))


def main():
    # pi executes multiple tool calls from one assistant message in parallel;
    # serialize whole invocations so concurrent replays cannot interleave.
    os.makedirs(RUN, exist_ok=True)
    lock = open(os.path.join(RUN, ".ew_lock"), "w")
    fcntl.flock(lock, fcntl.LOCK_EX)

    cmd = sys.argv[1] if len(sys.argv) > 1 else "brief"
    if cmd == "brief":
        print(load_task(TASK, seed=SEED).brief)
    elif cmd == "actions":
        for name, spec in sorted(load_task(TASK, seed=SEED).actions().items()):
            print(f"{name:20} cost {spec.cost}  {spec.doc}")
    elif cmd == "act":
        if len(sys.argv) < 3:
            print("usage: ew_act.py act <name> ['{...json params...}']", file=sys.stderr)
            sys.exit(2)
        name = sys.argv[2]
        params = json.loads(sys.argv[3]) if len(sys.argv) > 3 else {}
        _, ep = replay()
        reply = ep.act(name, params)
        os.makedirs(RUN, exist_ok=True)
        with open(os.path.join(RUN, "actions.jsonl"), "a") as fh:
            fh.write(json.dumps({"action": name, "params": params}) + "\n")
        print(json.dumps(reply, indent=2, ensure_ascii=False))
        if ep.done and ep.result is not None:
            with open(os.path.join(RUN, "result.json"), "w") as fh:
                json.dump(ep.result, fh, indent=2, ensure_ascii=False)
            print("\n" + FINISHED_LINE)
    elif cmd == "status":
        _, ep = replay()
        print(json.dumps({
            "task": TASK, "seed": SEED,
            "actions_taken": len(ep.trajectory),
            "budget_remaining": ep.budget.snapshot(),
            "done": ep.done, "result": ep.result,
        }, indent=2, ensure_ascii=False))
    elif cmd == "meta":
        meta_cmd()
    else:
        print(f"unknown command {cmd!r}; use brief|actions|act|status|meta",
              file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
