# Traces Test Harness

A solver harness for the [TRACES](https://traces.apodex.com) Executable World tasks.
pi 0.84.3 runs unmodified as an npm dependency; everything added here is a pi
extension pack, two prompt files, one config file and one environment adapter. The
pack supplies a parameter-shape guard, a one-shot gate before irreversible actions,
an idempotent memo, action numbering with budget and time notices, and a writing
protocol; the adapter only translates protocol (brief, action, result, trajectory,
one metadata declaration). Validated end to end with `gpt-5.5` via provider `openai`
(API key) or `openai-codex` (login), on the five practice tasks and held-out seeds.

## Quickstart

Prerequisites: Node ≥ 22.19 (required by the pinned pi) and Python ≥ 3.11. The
Python side is standard library only; the one dependency is pi, pinned in
`package-lock.json`.

```bash
git clone <this repository> && cd traces-test-harness
./setup.sh                     # checks Node/Python, installs the pinned pi into ./node_modules,
                               # clones the practice environments into ./vendor (gitignored)
cp .env.example .env           # then put your key in it:  OPENAI_API_KEY=sk-...
python3 run_experiment.py --tasks corpus_dedup --seeds 0   # one episode
python3 run_experiment.py                                  # the full grid: 5 tasks x 3 seeds
# practice tasks: verify_solutions corpus_dedup corpus_procurement treatment_response clinical_signal
# --tasks takes a comma-separated list or "all"; --seeds takes a comma-separated list
```

Results land in `batches/<label>/` (`label` from `config.toml`, or `--label`): `batch.json`
snapshots the configuration including every switch, `runs.jsonl` holds one line per
episode, and each episode gets a self-contained `<task>-s<seed>-r<rep>/` directory — the
exact adapter and extension copies that ran, `trajectory.jsonl`, `actions.jsonl` (what was
forwarded, in order: the source of the `[action #N]` citations), `result.json` if it
submitted, the `pi-session/` record, `pi-stdout.log` and the pack's own state and logs. A
`runs.jsonl` line carries `task`, `seed`, `rep`, `dir`, `provider`, `model`, `exit_code`,
`timed_out`, `wall_seconds`, `submitted` (whether `result.json` exists), `score`,
`gate_passed`, `n_actions` (trajectory rows) and `n_errors` (rows whose status is not
`ok`). `gate_passed` is the *environment's* own hard gate for the tasks that have one and
`null` otherwise — unrelated to the pack's submission gate.

This repository is also a pi package: `package.json` carries a `pi` manifest listing the
four extensions in load order, so `pi install ./` loads the pack into your own pi. Loaded
that way the extensions still need the adapter reachable as `ew_act.py` in the working
directory, and the `EW_*` environment the runner otherwise sets.

## Model access

The model is reached only through pi's provider layer — swap it without touching any code.

- **API key** (what ships): `config.toml` has `provider = "openai"`, `model = "gpt-5.5"`,
  so put `OPENAI_API_KEY` in `.env` or in the environment and you are done;
  `provider = "anthropic"` with `ANTHROPIC_API_KEY` is the same. Shell variables win.
- **Login** (`openai-codex`, and pi's other login providers): set
  `provider = "openai-codex"`. There is no key — pi keeps the login in its *agent
  directory*, which the runner points at the repo-local `pi-agent/`. Either log in once with
  that directory (`PI_CODING_AGENT_DIR=$PWD/pi-agent node_modules/.bin/pi`, then pi's login
  flow), or point `PI_CODING_AGENT_DIR` at the directory holding it (`~/.pi/agent`).
- **Relay** (any OpenAI/Anthropic-compatible endpoint): pi reads custom providers from a
  `models.json` in that same agent directory. Only three values come from the host's run
  plan — relay address, credential variable name, API convention.

  ```jsonc
  // pi-agent/models.json
  { "providers": { "traces-relay": {
      "baseUrl": "https://relay.example/v1",   // the relay address
      "api": "openai-completions",             // or openai-responses / anthropic-messages
      "apiKey": "$TRACES_EPISODE_TOKEN",       // an env var, read per request, never cached
      "models": [ { "id": "<the model id the relay serves>", "name": "Relay model",
        "reasoning": false, "contextWindow": 128000, "maxTokens": 32000,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } } ] } } }
  ```

  Then set `provider = "traces-relay"`, `model = "<that id>"` in `config.toml`, and
  export `TRACES_EPISODE_TOKEN` before running.

The runner always launches pi fully isolated: no user-level context files, skills,
extensions, prompt templates or start-up network operations (`-nc -ns -ne -np
--no-themes -na --offline`, empty append-prompt, stdin closed), and a
repository-local agent directory. Nothing outside this repository influences the model.

## Repository layout

```
package.json         pi pinned at 0.84.3; `pi.extensions` manifest; peerDependencies
config.toml          the shipped configuration (one file = one run)
run_experiment.py    batch runner: reads config.toml, runs task x seed episodes, archives everything
extensions/
  ew-env.ts          registers the environment as a native pi tool; declares action metadata
  guards.ts          the rule pack — every rule, every switch (environment-agnostic)
  phases.ts          the strong form of the phase mechanism (off by default)
  optional-pack.ts   the writing-protocol pack (on by default)
prompts/
  system-v1.md       audited-solver identity (the visible text is the record)
  task-tool-v1.md    working protocol: plan / hypotheses / verdicts / repair notes / budget lines / audit
adapters/traces/
  ew_act.py          the adapter (frozen): brief / actions / act / status / meta
  scale.py           optional stress-instance generator for the practice tasks
setup.sh             toolchain check, pinned pi install, practice environments into ./vendor
.env.example         credentials and paths, copied to .env (gitignored)
```

## Configuration

Everything is in `config.toml` under `[run]`:

| Key | Meaning |
| --- | --- |
| `label` | batch name; results go to `batches/<label>/` |
| `provider`, `model`, `thinking` | passed to pi |
| `tasks`, `seeds`, `repeat` | the grid to run |
| `timeout` | wall-clock limit per episode, in seconds |
| `deadline` | time budget announced to the agent; `0` = no time notices. Set, it adds a notice at 35% and 15% of the wall clock left, and one when it is gone |
| `bridge_path` | the adapter; copied into each episode directory as `ew_act.py` |
| `extensions`, `tools` | the extension files, in load order; the tool whitelist handed to pi (the model sees nothing else) |
| `scale` | stress-instance spec; empty = off. It generates enlarged practice instances named `<task>_x<k>`, which must then be listed in `tasks` — see `adapters/traces/scale.py` |
| `[run.prompts]`, `[run.guards]` | the `system` and `task` prompt files; the switch table below |

Every switch lives in `[run.guards]`. The runner injects each one explicitly as `1`/`0`
into every episode (a stray variable in a shell cannot change a run) and writes the whole
table into `batches/<label>/batch.json`.

| Switch | Env var | Ships | Rule |
| --- | --- | --- | --- |
| `shape` | `EW_GUARD_SHAPE` | on | holds, at no cost, an action whose top-level parameter names do not match the signature the brief itself declares |
| `gate` | `EW_GUARD_GATE` | on | intercepts the first call to an irreversible action and asks for the pre-submission audit; the second call is forwarded unchanged |
| `cache` | `EW_GUARD_CACHE` | on | an idempotent action repeated with identical parameters is answered from the episode's own record; nothing is charged |
| `cache_safe` | `EW_GUARD_CACHE_SAFE` | on | labels that replay as the scaffold's own record, and never memoises a sampling action |
| `action_numbers` | `EW_GUARD_NUM` | on | prefixes every forwarded result with `[action #N]`, the number recorded in `actions.jsonl` — the citation handle the prompts require |
| `dup_warning` | `EW_GUARD_DUP` | on | notes when an identical action is forwarded and charged a second time, naming the earlier number |
| `repair_note` | `EW_GUARD_REPAIR` | on | after an `error` reply, asks for a written repair note before the retry |
| `budget_notes` | `EW_GUARD_BUDGET` | on | one notice per budget dimension at half, and again at a fifth, of what was first seen |
| `optional_pack` | `EW_GUARD_OPTIONAL_PACK` | on | appends the writing protocol to the system prompt: citation discipline, a batched plan, two competing options, headed verified / assumed / unexamined lists, and a gate ledger when the brief states a threshold |
| `phases` | `EW_GUARD_PHASES` | off | phase gate: irreversible actions are held during EXPLORE; DECIDE opens on budget, on the clock, or when the model calls `ew_phase_done` |
| `phases_reset` | `EW_GUARD_PHASES_RESET` | off | strong form: at the handoff, earlier observations are archived behind `ew_recall` and a briefing is pinned. Needs `phases`, `extensions/phases.ts` and both tools whitelisted; the runner refuses a half-configured batch |
| `explore_frac` | `EW_GUARD_PHASES_EXPLORE_FRAC` | 0.5 | the phase gate's budget threshold; read only when `phases` is on |

A switch that is off makes its extension a byte-for-byte no-op: no hook registered, no file
written, not one character added to what the model sees. Every line the pack *does* add is
prefixed `[HARNESS NOTE — from your own scaffold, not the environment]`, so a scaffold rule
cannot be mistaken for evidence about the world. For exact wording, firing conditions and
files written, read `extensions/guards.ts` (the eight core rules and the phase gate),
`extensions/phases.ts` and `extensions/optional-pack.ts`. Command-line flags override the
matching config keys: `--tasks`, `--seeds`, `--repeat`, `--provider`, `--model`,
`--thinking`, `--prompt`, `--system-prompt`, `--timeout`, `--deadline`, `--scale`,
`--label`, `--config`.

## Route C integration

The Route C deliverable is a network-isolated container image taking the brief and the
action client from the environment host at start-up and reaching the model only through the
host's metered relay. This repository is the harness that image wraps; three seams are
already isolated for it:

- **Action client** — every world effect flows through the adapter, whose backend is the
  local practice package (`load_task` / `Episode`, used in `replay()`). Swapping in a
  host-supplied client changes that one function: no change to the model-facing tool
  surface, none to the rule pack.
- **Relay** — see "Model access": one `models.json` entry in the repo-local agent directory,
  plus two lines in `config.toml`.
- **Offline** — pi is launched with `--offline` and every dependency is pinned
  (`package-lock.json`; practice package vendored by `setup.sh`), so the image builds with
  no run-time downloads.

## Adapting to another environment

The rule pack knows nothing about TRACES or any particular task; it works against any adapter
meeting three requirements, and that is the whole porting surface. `guards.ts` needs no
change; the environment-specific half is `extensions/ew-env.ts`, which registers the tool,
invokes the adapter and fetches `meta` once at start-up.

1. **Tool input shape.** `{command: "act" | <free command>, name?: string, params?: object}`.
   Only calls with `command === "act"` are guarded.
2. **Result details.** Each tool result carries a `details.ew` record: `{kind: "act" |
   "free", command, name?, params?, forwarded?, memoHit?, n?}`. `n` must be the real recorded
   action number (≥ 1); an adapter that cannot determine it must fail the call rather than
   guess — a wrong number poisons every citation after it.
3. **A one-time metadata declaration.** A `meta` command returning, for every action the
   environment offers, facts only — no policy:

   ```jsonc
   {"actions": {"<name>": {
     "cost": 1, "doc": "...",
     "params": ["strategy"],          // top-level parameter names, parsed from the
     "signature": "submit(strategy)", //   signature line the brief itself publishes
     "irreversible": true,            // ends the episode / cannot be undone
     "idempotent": false              // same params always mean the same answer
   }}}
   ```

`irreversible` is what the one-shot gate and the phase gate hold, `idempotent` is what the
memo replays, `params` / `signature` are what the shape guard compares against. The reference
implementation (about 200 lines, standard library only) is `adapters/traces/ew_act.py`.

## Integrity

The adapter is frozen: it changes for protocol bugs, never for behaviour — anything that
changes the text the model sees belongs in the extension pack. Each file below carries the
hash of the exact copy that was validated.

| File | Lines | sha256 |
| --- | --- | --- |
| `adapters/traces/ew_act.py` | 217 | `d74b261e9a2c0cf46f895e8067f7202c2c361bd77fcef135f923272b1fa8552c` |
| `adapters/traces/scale.py` | 846 | `f7ce6d980e947ad8fb11a338678410f4491862416177aa78d6ee2c00ea4e0a74` |
| `extensions/ew-env.ts` | 419 | `8615a501d2aafd54a0213a7ce8b2169dacdbf487148de672cc4201264aa1c2fe` |
| `extensions/guards.ts` | 1199 | `fbc346099de1a29a499a6eb705df80a5eccd79c9fdeca09f3ee0743cf0fa8dcd` |
| `extensions/phases.ts` | 873 | `e0a67abaa5756671b675d03eec5bb4a0474a08eac1d9fae6af27224c6bc2a3ea` |
| `extensions/optional-pack.ts` | 445 | `1ca470969cb01de20f8971ce8d77d227cffb79f977f0d72cfb73f1d66ccede5c` |

Verify with `shasum -a 256 adapters/traces/*.py extensions/*.ts`.

## License

MIT — see [LICENSE](LICENSE).
