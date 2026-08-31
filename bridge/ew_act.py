#!/usr/bin/env python3
"""Action client: pi shell commands <-> Executable World task objects. (harness-v1)

The Executable World spec requires that every effect on the world go through an
action client; this file is that layer.

One CLI call = one action. The environment is deterministic (same task + seed
always generates the same instance), so episode state is reconstructed on every
call by replaying the actions recorded in actions.jsonl. trajectory.jsonl is
rewritten in full on each replay, so it is always the complete trajectory.

    python3 ew_act.py brief                       # task brief (free)
    python3 ew_act.py actions                     # action list with costs (free)
    python3 ew_act.py act <name> ['{"k": "v"}']   # take one action (charged)
    python3 ew_act.py status                      # progress + budget (free)

Config via environment: EW_TASK (default clinical_signal), EW_SEED (default 0),
EW_RUN (run directory, default '.').

Added in harness-v1 (relative to harness-v0):
  * Every action reply carries an [action #N] number, giving the model a citable
    step index so each figure in the final report can be traced to its source.
  * Error note: when the environment returns an error, prompt the model to write a
    diagnosis (what failed, root cause, what to change, how to confirm) before
    retrying.
  * Duplicate-action note: flag an exactly identical (action, params) pair that was
    already taken. The call is still forwarded and still charged — v1 only warns,
    it does not block.
  * Budget notes: warn once each time any budget drops below 50% and 20% of its
    first observed value.
  * Submission gate (one-shot): the first submit is not forwarded and requires the
    pre-submission audit first; the second is forwarded unconditionally. Set
    EW_NO_SUBMIT_GATE=1 to disable.
  These notes appear only in the command-line output shown to the model. They are
  never written to the environment trajectory (trajectory.jsonl), so they do not
  appear in the material graders read.
"""
import fcntl
import json
import os
import sys
import time

def _find_examples_repo():
    """Locate the official executable-world-examples practice package.
    Resolution order: the EW_EXAMPLES_REPO environment variable > a clone under
    vendor/, searching upward from this file > a sibling clone at any level above.
    If none is found, print explicit installation instructions."""
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
            sys.exit("Cannot find the executable-world-examples package. Either git "
                     "clone https://github.com/ApodexAI/executable-world-examples "
                     "next to this repository, or point the EW_EXAMPLES_REPO "
                     "environment variable at it.")
        d = parent


REPO = _find_examples_repo()
sys.path.insert(0, REPO)
from ew_examples import Episode, load_task  # noqa: E402

TASK = os.environ.get("EW_TASK", "clinical_signal")
SEED = int(os.environ.get("EW_SEED", "0"))
RUN = os.environ.get("EW_RUN", ".")
# Time-limit notes: EW_DEADLINE is the total seconds allowed for this episode
# (unset = no notes).
DEADLINE = float(os.environ.get("EW_DEADLINE", "0") or 0)


def _flag_on(name, default="1"):
    return os.environ.get(name, default) not in ("", "0", "off", "false")

# Bridge feature flags (harness versions differ by configuration, not by swapping
# code): all off = v0 behavior, all on = v1 behavior. The runner injects these from
# [run.bridge] in configs/*.toml.
GATE = _flag_on("EW_BRIDGE_GATE") and not _flag_on("EW_NO_SUBMIT_GATE", "0")
DUP_WARN = _flag_on("EW_BRIDGE_DUP")
REPAIR_NOTE = _flag_on("EW_BRIDGE_REPAIR")
BUDGET_NOTES = _flag_on("EW_BRIDGE_BUDGET")
ACTION_NUM = _flag_on("EW_BRIDGE_NUM")
# Cache (added in harness-v2): an exactly identical query action is not forwarded to
# the environment and is not charged; the previously recorded full observation is
# returned instead. This is safe because the environment is deterministic — for a
# given task and seed, queries are pure reads and have been verified byte-identical.
# State-changing actions are never cached. Off by default (v0/v1 behavior unaffected).
CACHE_ON = _flag_on("EW_BRIDGE_CACHE", "0")
NEVER_CACHE = {"submit", "declare_limitation"}


def _cache_path():
    return os.path.join(RUN, "bridge-cache.jsonl")


def _cache_lookup(key):
    if not os.path.exists(_cache_path()):
        return None
    for line in open(_cache_path()):
        row = json.loads(line)
        if row["key"] == key:
            return row
    return None


def _cache_store(key, n, reply):
    with open(_cache_path(), "a") as fh:
        fh.write(json.dumps({"key": key, "n": n, "reply": reply}, ensure_ascii=False) + "\n")

NOTE = "[HARNESS NOTE — from your own scaffold, not the environment] "


def started_at():
    p = os.path.join(RUN, ".ew_started")
    if not os.path.exists(p):
        os.makedirs(RUN, exist_ok=True)
        with open(p, "w") as fh:
            fh.write(str(time.time()))
    return float(open(p).read().strip())


def harness_notice():
    """Time-budget note (harness-layer annotation, never enters the trajectory)."""
    if not DEADLINE:
        return None
    left = DEADLINE - (time.time() - started_at())
    if left <= 0:
        return (NOTE + "TIME REMAINING: the episode wall clock is EXHAUSTED. "
                "Submit immediately with whatever you can currently support. "
                "An unsubmitted episode is graded on what it left behind.")
    frac = left / DEADLINE
    if frac <= 0.15:
        return (NOTE + f"TIME REMAINING: only {left:.0f}s of {DEADLINE:.0f}s remain. "
                "STOP GATHERING AND SUBMIT NOW with your best supported answer.")
    if frac <= 0.35:
        return (NOTE + f"TIME REMAINING: {left:.0f}s of {DEADLINE:.0f}s remain "
                "(under 35%). Begin converging: decide what you can already "
                "support, and leave enough time to submit.")
    return None


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


def _flags():
    """On-disk record of which one-shot notes have already been emitted."""
    p = os.path.join(RUN, ".ew_flags")
    return json.load(open(p)) if os.path.exists(p) else {}


def _set_flag(key):
    p = os.path.join(RUN, ".ew_flags")
    d = _flags()
    d[key] = True
    with open(p, "w") as fh:
        json.dump(d, fh)


def budget_notes(reply):
    """Warn once each time any budget drops below 50% and 20% of its first value."""
    cur = reply.get("budget_remaining") or {}
    if not isinstance(cur, dict) or not cur:
        return []
    p0 = os.path.join(RUN, ".ew_budget0")
    if not os.path.exists(p0):
        with open(p0, "w") as fh:
            json.dump(cur, fh)
        return []
    ref = json.load(open(p0))
    notes, flags = [], _flags()
    for kind, v0 in ref.items():
        v = cur.get(kind)
        if not isinstance(v0, (int, float)) or not isinstance(v, (int, float)) or v0 <= 0:
            continue
        frac = v / v0
        if frac <= 0.2 and not flags.get(f"budget_low:{kind}"):
            _set_flag(f"budget_low:{kind}")
            notes.append(NOTE + f"BUDGET: '{kind}' is down to {v} (below 20% of the "
                         f"{v0} you started with). Write a budget line now, converge on "
                         "what you can already support, and keep enough for a clean submit.")
        elif frac <= 0.5 and not flags.get(f"budget_half:{kind}"):
            _set_flag(f"budget_half:{kind}")
            notes.append(NOTE + f"BUDGET: '{kind}' has crossed half spent ({v} of {v0} "
                         "at first check remains). Good moment for a written budget line: "
                         "spent on what, remaining reserved for what.")
    return notes


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
        prior = recorded_actions()
        notes = []

        # Submission gate: the first submit is not forwarded and requires a written
        # self-audit first. The second one is forwarded unconditionally.
        if name == "submit" and GATE and not _flags().get("submit_gate"):
            _set_flag("submit_gate")
            print(NOTE + "SUBMISSION INTERCEPTED by your own scaffold. The environment "
                  "has NOT received it and nothing was charged. Before it is forwarded:\n"
                  "  1. Write your `## Pre-submission audit` — all four questions, in text.\n"
                  "  2. If the task provides an action for declaring limitations, declare\n"
                  "     every limitation the audit surfaced (it is normally free).\n"
                  "  3. Then call submit again — the next submit WILL be forwarded\n"
                  "     unconditionally, with exactly the params you give it.")
            return

        # Cache hit: not forwarded, not charged; return the recorded full observation
        # (with the remaining budget refreshed to the current live values).
        cache_key = name + " " + json.dumps(params, sort_keys=True)
        if CACHE_ON and name not in NEVER_CACHE:
            hit = _cache_lookup(cache_key)
            if hit is not None:
                _, ep = replay()
                reply = dict(hit["reply"])
                reply["cost_charged"] = 0
                reply["budget_remaining"] = ep.budget.snapshot()
                print(NOTE + f"Identical query already taken as [action #{hit['n']}]. "
                      "Returning its recorded observation; nothing was charged.")
                print(json.dumps(reply, indent=2, ensure_ascii=False))
                note = harness_notice()
                if note:
                    print("\n" + note)
                return

        # Duplicate-action note (still forwarded, still charged — it only stops
        # paying twice for the same observation from happening silently).
        if DUP_WARN:
            key = json.dumps(params, sort_keys=True)
            for i, row in enumerate(prior):
                if row["action"] == name and json.dumps(row["params"], sort_keys=True) == key:
                    notes.append(NOTE + f"You already took this exact action as [action #{i+1}] "
                                 "— its observation is in your context. This call was still "
                                 "forwarded and charged.")
                    break

        _, ep = replay()
        reply = ep.act(name, params)
        os.makedirs(RUN, exist_ok=True)
        with open(os.path.join(RUN, "actions.jsonl"), "a") as fh:
            fh.write(json.dumps({"action": name, "params": params}) + "\n")
        if CACHE_ON and name not in NEVER_CACHE:
            _cache_store(cache_key, len(prior) + 1, reply)
        if ACTION_NUM:
            print(f"[action #{len(prior) + 1}]")
        print(json.dumps(reply, indent=2, ensure_ascii=False))

        # Error note: diagnose first, then retry.
        if REPAIR_NOTE and reply.get("status") == "error":
            notes.append(NOTE + "That reply is an error. Before retrying, write a "
                         "`## Repair` note: what happened, the root cause you believe, "
                         "what you will change, and how you will confirm the fix worked. "
                         "Blind retries read as guessing.")

        if BUDGET_NOTES:
            notes.extend(budget_notes(reply))
        note = harness_notice()
        if note:
            notes.append(note)
        for n in notes:
            print("\n" + n)

        if ep.done and ep.result is not None:
            with open(os.path.join(RUN, "result.json"), "w") as fh:
                json.dump(ep.result, fh, indent=2, ensure_ascii=False)
            print("\n[episode finished — result.json written]")
    elif cmd == "status":
        _, ep = replay()
        print(json.dumps({
            "task": TASK, "seed": SEED,
            "actions_taken": len(ep.trajectory),
            "budget_remaining": ep.budget.snapshot(),
            "done": ep.done, "result": ep.result,
        }, indent=2, ensure_ascii=False))
        note = harness_notice()
        if note:
            print("\n" + note)
    else:
        print(f"unknown command {cmd!r}; use brief|actions|act|status", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
