# traces-pi-harness

A [pi](https://github.com/earendil-works/pi)-based solver harness for the
[TRACES benchmark](https://traces.apodex.com), built and iterated against the
official practice tasks in
[executable-world-examples](https://github.com/ApodexAI/executable-world-examples).

The unit under evaluation is the whole scaffold around the model: an audited-solver
system prompt, a written working protocol on the task side, and an action bridge
with guard rails (action numbering, duplicate-query cache, repair/budget notices,
a one-shot pre-submission gate). Pi itself is used unmodified (pinned CLI `0.84.3`);
everything is delivered through configuration, prompt files and a Python bridge.

Status: all five practice tasks run end to end, unattended, across seeds 0–2,
100% submission rate. This repository ships **one final configuration**
(`config.toml`), the best of five internally measured iterations.

## Quickstart

Prerequisites: Node ≥ 22 and Python ≥ 3.11.

```bash
git clone <this repo> && cd traces-pi-harness
./setup.sh                       # checks Node/Python, installs pinned pi locally, fetches practice envs
export OPENAI_API_KEY=sk-...     # see "Model access"
python3 run_experiment.py        # 5 tasks × 3 seeds
python3 run_experiment.py --tasks clinical_signal --seeds 0   # single episode
```

A full 5-task × 3-seed run takes roughly 30–40 minutes and a few dollars of API
usage; the single-episode command above is the cheap way to check the wiring.

Each episode directory under `batches/` archives the raw environment trajectory,
the full agent record, the exact bridge copy used, and a config snapshot.

## Model access

The model is reached exclusively through pi's provider layer — swap it without
touching any code:

- **Default**: `provider = "openai"` in `config.toml`; the key is read from the
  `OPENAI_API_KEY` environment variable at request time. The key can also be
  placed in a `.env` file at the repo root (gitignored); exported environment
  variables take precedence over it.
- **Anthropic models**: set `provider = "anthropic"`, `model = "claude-..."` and
  export `ANTHROPIC_API_KEY`.
- **Any OpenAI/Anthropic-compatible endpoint (e.g. an evaluation relay)**:
  copy `relay-prep/models.template.json` to the pi agent dir as `models.json` —
  it defines a provider with an arbitrary `baseUrl` whose credential is resolved
  from an environment variable per request (verified end to end against
  `relay-prep/fake_relay.py`, a loop-back relay you can run locally).

The runner always launches pi fully isolated: no user-level context files,
skills, extensions, prompt templates or startup network operations
(`-nc -ns -ne -np --no-themes -na --offline`, empty append-prompt, stdin closed).
Nothing outside this repository influences the model.

## Architecture

```
run_experiment.py       batch runner: reads config.toml, runs task × seed
                        episodes unattended, archives everything
  └─ pi 0.84.3 (unmodified)
       ├─ prompts/system.md   audited-solver identity (visible text is the record)
       ├─ prompts/task.md     working protocol: plan / competing hypotheses /
       │                      verdicts / repair notes / budget lines / statistical
       │                      discipline / pre-submission audit / step-cited report
       └─ bash
            └─ bridge/ew_act.py    the ONLY effect channel — translates model
                                   commands into environment actions and adds
                                   guard rails (numbering, duplicate-query cache,
                                   repair & budget notices, submission gate)
                 └─ executable-world-examples   (official practice envs, unmodified;
                                                 auto-located, or set EW_EXAMPLES_REPO)
```

## How this configuration was chosen

Five harness versions were built and measured under a frozen internal evaluation
(outcome score as primary metric, a TRACES-style six-capability process review as
a regression guardrail, plus efficiency accounting). The shipped configuration
corresponds to the best-performing version: prompts-level working protocol +
bridge-level guard rails. Later experimental iterations (a native structured tool
replacing bash, submission-review rounds, a per-call status ledger) improved
robustness metrics but not outcomes on the practice tasks, and are kept out of
this release. The evaluation pipeline itself is internal tooling and is not part
of this repository.

## Route C readiness

Two seams are intentionally isolated for the official interface:

- **Action client** — all world effects already flow through `bridge/ew_act.py`;
  its backend (the local practice package) is a ~20-line swap for a host-supplied
  action client, with no change to the model-facing surface.
- **Model relay** — see "Model access": pointing pi at a metered relay with a
  per-episode credential is a config entry, already verified against a local
  stand-in relay.

## License

MIT — see [LICENSE](LICENSE).
