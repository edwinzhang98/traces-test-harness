# Traces Test Harness

A solver harness for the [TRACES benchmark](https://traces.apodex.com), built on
the open-source [pi](https://github.com/earendil-works/pi) coding agent (used
unmodified as the model-driving loop) and iterated against the official practice
tasks in
[executable-world-examples](https://github.com/ApodexAI/executable-world-examples).

The unit under evaluation is the whole scaffold around the model: an audited-solver
system prompt, a written working protocol on the task side, and an action bridge
with guard rails (action numbering, duplicate-query cache, repair/budget notices,
a one-shot pre-submission gate). Pi itself is used unmodified (pinned CLI `0.84.3`);
everything is delivered through configuration, prompt files and a Python bridge.

Status: all five practice tasks run end to end, unattended, across seeds 0–2,
100% submission rate. This repository ships **one configuration**
(`config.toml`). Last verified from a fresh clone on 2026-09-02: `./setup.sh` in
2–3 s, one `verify_solutions` episode in 62–71 s with score 1.0 (provider
`openai`, key from `.env`), and the relay recipe below end to end against the
loop-back relay.

## Quickstart

Prerequisites: Node ≥ 22.19 (required by the pinned pi) and Python ≥ 3.11.

```bash
git clone https://github.com/edwinzhang98/traces-test-harness.git && cd traces-test-harness
./setup.sh                       # checks Node/Python, installs pinned pi into ./node_modules,
                                 # clones the practice envs into ./vendor (gitignored, never modified)
cp .env.example .env             # then fill in OPENAI_API_KEY (or export it) — see "Model access"
python3 run_experiment.py --tasks verify_solutions --seeds 0   # smoke test: one episode, ~1–2 min
python3 run_experiment.py                                     # 5 tasks × 3 seeds
```

The five practice tasks are `verify_solutions`, `corpus_dedup`, `corpus_procurement`,
`treatment_response`, `clinical_signal` (`--tasks` takes a comma-separated list or
`all`; `--seeds` a comma-separated list). `--tasks` accepts any task id the
practice package registers, so additional practice tasks need no change here.
A full 5-task × 3-seed run takes roughly 30–40 minutes and a few dollars of API
usage. The Python side uses only the standard library (3.11+); the single
installed dependency is pi, pinned through `package-lock.json`.

Each episode directory under `batches/<label>/` archives the raw environment
trajectory (`trajectory.jsonl`), the full agent record (`pi-session/`), the exact
bridge copy used, the environment's `result.json`, and a config snapshot
(`batch.json`); `batches/<label>/runs.jsonl` has one line per episode (score,
steps, errors, wall time). In that index, `gate_passed` is the *environment's*
hard gate for tasks that have one and `null` otherwise — it is unrelated to the
bridge's pre-submission gate.

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
  pi reads custom providers from a `models.json` in its *agent directory*. The
  runner points that directory at the repo-local `pi-agent/` (it exports
  `PI_CODING_AGENT_DIR` unless you already set it), so nothing outside this
  repository is consulted. To use a relay:

  ```bash
  mkdir -p pi-agent && cp relay-prep/models.template.json pi-agent/models.json
  # edit pi-agent/models.json:  baseUrl = the relay address;
  #   apiKey = "$SOME_VAR" (an env var, read per request, never cached);
  #   api = openai-completions | openai-responses | anthropic-messages;
  #   models[].id = the model id the relay serves
  # then in config.toml:  provider = "traces-relay", model = "<that id>"
  export TRACES_EPISODE_TOKEN=...          # whatever variable name you declared above
  python3 run_experiment.py --tasks verify_solutions --seeds 0
  ```

  This path was verified end to end against `relay-prep/fake_relay.py`, a
  loop-back relay you can run locally (`python3 relay-prep/fake_relay.py 18081`
  logs every request's path, bearer token and model to `relay-prep/relay.log`).
  The three values that come from the host's run plan are the relay address, the
  credential variable name, and the API convention. If you instead rely on pi's
  own login-based providers, set `PI_CODING_AGENT_DIR` to your existing agent
  directory (default `~/.pi/agent`) before running.

The runner always launches pi fully isolated: no user-level context files,
skills, extensions, prompt templates or startup network operations
(`-nc -ns -ne -np --no-themes -na --offline`, empty append-prompt, stdin closed),
and a repo-local agent directory. Nothing outside this repository influences the
model.

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
                 └─ vendor/executable-world-examples   (official practice envs, unmodified;
                                                        auto-located, or set EW_EXAMPLES_REPO)
```

## Route C readiness

The official Route C deliverable is a network-isolated container image that takes
the task brief and action client from the environment host at start-up and reaches
the model only through the host's metered relay. This repository is the harness
that image will wrap; containerization follows the host's integration templates.
Two seams are already isolated for that step:

- **Action client** — all world effects already flow through `bridge/ew_act.py`.
  Its backend is the local practice package (`load_task` / `Episode` from
  `executable-world-examples`, used in `replay()`); swapping in a host-supplied
  action client is a change to that one function, with no change to the
  model-facing command surface.
- **Model relay** — see "Model access": pointing pi at a metered relay with a
  per-episode credential is a `models.json` entry inside the repo-local agent
  directory plus two lines in `config.toml`, already verified against a local
  stand-in relay.
- **Offline operation** — pi is launched with `--offline` and all dependencies
  are pinned (`package-lock.json`, practice package vendored by `setup.sh`), so
  the image can be built with no run-time downloads.

## License

MIT — see [LICENSE](LICENSE).
