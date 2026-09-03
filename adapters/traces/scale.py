#!/usr/bin/env python3
"""Practice-task scaler: build 3-10x larger instances of the official ew_examples
tasks without touching a single line of vendor code.

There is really only one fact behind it: `ew_examples.tasks.TASKS` is a
module-level mutable dict that `load_task` looks up **at run time**, so putting a
scaled-up subclass into it under a new task name is the same thing as adding a
task, and the vendor package needs no changes at all.

    import scale
    scale.register("clinical_signal=10,corpus_procurement=6")
    # -> ["clinical_signal_x10", "corpus_procurement_x6"]
    load_task("clinical_signal_x10", seed=0)   # 4000 patients / 15 events / 20 sites

## The EW_SCALE spec string

    EW_SCALE := entry ("," entry)*
    entry    := <k>                                  # bare number = scale every
                                                     #   scalable task by k
              | <task> "=" <k> (":" option "=" value)*   # per-task multiplier
                                                         #   plus optional overrides

    Empty / unset = register nothing = byte-for-byte identical behaviour to today
    (this is the default, and the safety valve).
    Task names are clinical_signal | corpus_procurement | corpus_dedup |
    treatment_response.
    Registered names are always `<task>_x<k>`; k must be an integer >= 1.
    An unknown task name, an unknown option or an illegal k all **raise
    ValueError** (better to blow up at startup than to quietly run at the wrong
    size).

    Examples:
      EW_SCALE=10
      EW_SCALE=clinical_signal=10,corpus_procurement=6,corpus_dedup=8
      EW_SCALE=corpus_dedup=10:words=32          # pin the vocabulary width
      EW_SCALE=clinical_signal=10:sites=4        # scale patients only, keep 4 sites
      EW_SCALE=treatment_response=5:fits=16      # hold fits down, see the replay
                                                 #   cost warning below

    Options per task (all values are integers):
      clinical_signal     patients sites events queries
      corpus_procurement  index_queries crawl_actions judge_tokens honeypot
      corpus_dedup        words index_queries embed_queries judge_calls
      treatment_response  columns queries fits

    verify_solutions is not scaled (scaling it means hand-writing dozens of
    candidates each wrong in its own way -- authoring work, not doubling a
    constant); naming it in the spec string is ignored with a one-line note on
    stderr rather than an error.

## How this is wired into the adapter (already in place)

In `adapters/traces/ew_act.py`, **after** `from ew_examples import Episode,
load_task` and before any `load_task(TASK, ...)`, three lines do the work:

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # sibling scale.py
    import scale  # noqa: E402
    scale.register(os.environ.get("EW_SCALE", ""))

They have to come after that import because `scale` itself does
`import ew_examples.tasks`, which relies on the preceding
`sys.path.insert(0, REPO)` having put the practice package on the path.
`import scale` (a sibling import) rather than `from adapters.traces import
scale`: once the runner has copied the adapter layer into the run directory
there is no `adapters/traces/` package path there, only flat files.

### How scale.py travels with ew_act.py (the runner copies the sibling file)

The runner copies the adapter file into each run directory, so a child process
doing `import scale` would fail unless the sibling comes too. Its copy step
therefore takes both:

    _bridge = os.path.join(HERE, cfg.get("bridge_path") or "bridge/ew_act.py")
    shutil.copy(_bridge, os.path.join(run_dir, "ew_act.py"))
    _sib = os.path.join(os.path.dirname(_bridge), "scale.py")
    if os.path.exists(_sib):
        shutil.copy(_sib, os.path.join(run_dir, "scale.py"))

Why that and not inlining: (1) the run directory stays self-contained -- "what
ran is what is stored", which is already how the extensions are copied, and the
scaler is no different; (2) an older adapter with no scale.py next to it keeps
running unchanged thanks to `if os.path.exists`, so the change is a zero-impact
addition for existing configs; (3) inlining 400 lines of scaler into the "thin
adapter" would destroy the reviewability of ew_act.py as a file that does
nothing but protocol translation. Scaled task names also have to be added to the
runner's task list, or listed explicitly with `--tasks` at run time.

`EW_SCALE` itself needs no runner change: the runner builds the child
environment as `dict(os.environ, ...)`, so the parent's variables pass through.

## Scaling recipes and the deliberate deviations (every one of them tested)

  clinical_signal xk
      400k patients; `4 * max(1, k//2)` sites (**always even** -- `arm=ARMS[i%2]`
      and `site=SITES[i%len]` are conjugate, so with an odd site count every site
      becomes two-armed, and the unit inflation of site_03 turns from a
      whole-site drift into a within-site between-group contrast, which changes
      what the task is about); site names are generated in `site_%02d` order, so
      `site_03` is always index 2 = the drug-only arm, word-for-word the same
      trap semantics as the default instance.
      `5 + 5*(k//5)` events (the first 5 are the vendor's, verbatim; the added
      ones are pure-noise adverse events at equal rates in both arms).
      The `queries` budget is set at the **same budget-to-question-space ratio**
      as the default: space = (events+1) x (5+sites) + 5, so the default 59 cells
      with 25 queries gives 65 at k=5 and 175 at k=10 (inside the 150-250 range
      the research suggests). Scoring is unaffected: `rr_true` is recomputed from
      the data inside `score()`.
      Note that `|claimed - rr_true| <= 1.0` is an absolute window, and changing
      the patient count changes the truth (2.14 at 400 patients -> 3.37 at 4000,
      converging on the generating parameter 3.4), so the "right answer" was
      never the same number across sizes.

  corpus_procurement xk
      k times as many documents per real source (continuing the indices under the
      vendor's own high_rate / crawlable rules); the mirror source src_01 is
      rebuilt as a full mirror of src_00, and the two packages are re-cut at the
      same proportions (`src_02[:10k]` / `src_01[:40k]`).
      **Left alone:** `SOURCES` (`high_rate` is keyed by source name, so adding a
      source is a guaranteed KeyError), the package prices, `purchase_dollars`
      (`_oracle` hard-codes 1000) and `CONTAMINATION_LIMIT` (a ratio gate, so it
      is size-independent).
      The index_queries / crawl_actions / judge_tokens budgets are all multiplied
      by k, which keeps the share of judge budget needed to judge the whole field
      exactly what it is by default (8000/200 = 40 documents out of ~280 ~= 14%).
      **One cut beyond what the research called for**: the literal "one crawl
      lands 40 junk documents" inside the honeypot's `_landed` is scaled to
      `40k` too. That is the only reason `_landed` is overridden at all, and the
      oracle and the scorer share the one override, so both sides stay symmetric.
      Measured counter-evidence (seed 0, plan = crawl src_00 + crawl the
      honeypot): default contamination 0.231 -> **trips the 0.15 gate**; x10 with
      the honeypot scaled alongside 0.195 -> still trips it; x10 with the honeypot
      still landing only 40 documents 0.105 -> **passes the gate**, i.e. crawling
      the honeypot for nothing is no longer punished and the trap has stopped
      working. So this cut is mandatory, the same kind of thing as the vocabulary
      compensation in dedup.
      Side effect (the vendor already had it, it is only amplified): while
      `_oracle()` enumerates its 128 combinations, each of the 64 containing the
      honeypot generates a fresh batch of junk documents into `self._docs` -- at
      x10 a single scoring pass produces 25,600 extra documents (a few MB of
      memory, once).

  corpus_dedup xk
      40k originals + 12k near-duplicates + 8k benchmark + 5k leaks, with the
      document id width widening automatically with size (offsets 100k / 200k, so
      the lexicographic order of `sorted()` still equals numeric order and the
      ids[5..30] that `calibration()` takes still land among the originals).
      **The mandatory compensation**: widen the vocabulary to `words` (default 28,
      allowed 14-40, 24-32 recommended). Note that the module-level `WORDS` is
      **not** monkey-patched here -- across the whole package `WORDS` is read
      exactly once, by `_text()` at construction time (grep-confirmed), so this
      module carries its own equivalent `_dedup_text()` and the default task is
      left untouched to the byte inside the same process.
      Measured (seed 0, sweeping thresholds 0.6/0.7/0.8/0.85/0.9/0.95):
        default 57 docs, 14 words  {0.40, 0.63, 0.85, **1.00**, 0.71, 0.56}
                                   <- only 0.85 scores full marks
        x10 570 docs, 14 words     {0.22, 0.31, 0.53, 0.72, 0.57, 0.55}
                                   <- **capped at 0.72, the task is ruined**
        x10 570 docs, 28 words     {0.83, 0.98, 1.00, 1.00, 0.84, 0.58}
                                   <- full marks are back at {0.8, 0.85}
        x5  285 docs, 28 words     {0.91, 0.99, 1.00, 1.00, 0.93, 0.57}
      The other way round, **x1 with 28 words makes the task easier** (0.6-0.85
      all score full marks). For a "same task, different size" control group the
      x1 arm must therefore be written `corpus_dedup=1:words=14`, which reproduces
      the vendor corpus byte for byte (the rng call sequence is identical; there
      is a test asserting it).
      `MAX_SUBMITS` stays at 4 (the f-string in the brief is baked in at class
      definition time, so changing it would contradict the wording), and the
      index / embed / judge budgets are multiplied by k.

  treatment_response xk
      **Columns only, no extra rows** (rows are exposed only through
      `sample_rows` with n<=20, so adding rows produces neither actions nor
      context). `ALLOWED` grows from 7 columns to 7k; the additions are noise
      pre-treatment columns unrelated to the outcome, and all three splits
      (train / val / cohort B) get the same keys on every row; `queries` and
      `fits` are multiplied by k.
      **Scores are not comparable across sizes, and x10 flattens the ruler
      outright**: the score is `(ext_r2 - mean_only)/(all_allowed - mean_only)`,
      and noise columns depress the `all_allowed` baseline in the denominator.
      Measured (seed 0, the same correct 4 columns bmi/grs/hba1c/sex):
        default  7 columns  all_allowed 0.3298  score 0.9242
        x5      35 columns  all_allowed 0.3315  score 0.9196
                            <- the ruler barely moved, usable
        x10     70 columns  all_allowed 0.2326  score **1.2**
                            <- pinned at the min(1.2, .) clamp
      That is, at x10 both "the correct 4 columns" and "an even better 3 columns"
      score 1.2, so **the score no longer discriminates**. Compare only within one
      k, and do not go beyond x5 if the score has to tell good from bad.
      This is the **only task that needs a module-level constant monkey-patched**:
      `ALLOWED` is read at run time in five places (`_baselines` / `_inspect` /
      `_corr` / `_features` / `score`), and not patching it would mean copying a
      hundred-odd lines of scoring code (copying the scorer is the real risk).
      The patch happens **at the moment a scaled instance is constructed** (not at
      register time) and is never undone (it is process-local). **Consequence:
      loading the default `treatment_response` again in the same process will
      fail** (the default rows do not have those columns). That is irrelevant in
      a one-episode-per-process runner, but batch tests must run in separate
      processes.
      **Replay cost**: `_fit` is pure-Python Gaussian elimination, so one fit with
      c columns is O(c^2 x n_rows). Measured on this machine: one fit_report takes
      1 ms at 4 columns, 25 ms at 35, 100 ms at 70. The adapter replays the whole
      action history on every CLI call, so after 80 fits at x10 **every subsequent
      action costs ~8 seconds of replay first** (at x5, 40 fits is about 1 second,
      imperceptible). **Recommendation: keep treatment_response at k<=5** -- both
      for speed and because of the "x10 pins the score at 1.2 and loses
      resolution" finding above; if x10 really is needed, hold the count down with
      `:fits=`.

  verify_solutions  not scaled, `register()` ignores it.

## Measured shape table (seed 0; `python3 scale.py "10"` recomputes it)

  task                  k=5                                  k=10
  clinical_signal       2000 patients / 10 events / 8 sites   4000 patients / 15 events / 20 sites
                        queries 65 (148-cell space)           queries 175 (405-cell space)
  corpus_procurement    1400 docs (real 400/300/300 + 400     2800 docs (800/600/600 + 800
                        mirrored)                             mirrored)
                        index 200 / crawl 600 / judge 40000   index 400 / crawl 1200 / judge 80000
                        honeypot lands 200 / dollars 1000     honeypot lands 400 / dollars 1000
  corpus_dedup          285 docs (200+60+25) / 40 benchmark   570 docs (400+120+50) / 80 benchmark
                        28 words / index 75 / embed 300 / judge 50  28 words / index 150 / embed 600 / judge 100
                        submits 4                            submits 4
  treatment_response    35 columns (28 noise) / queries 100 / fits 40  70 columns (63 noise) / queries 200 / fits 80
                        row counts unchanged 450/150/300      row counts unchanged 450/150/300

Process-local and never undone: this module only inserts keys into the `TASKS`
dict (in place, never rebinding it, so `ew_examples.TASKS` and
`ew_examples.tasks.TASKS` remain the same object and both see the additions), and
patches one module constant when a scaled treatment_response is constructed.
There is no restore hook.
"""
from __future__ import annotations

import hashlib
import math
import random
import sys

__all__ = ["register", "parse_spec", "SCALABLE", "UNSCALABLE", "OPTIONS"]

SCALABLE = ("clinical_signal", "corpus_procurement", "corpus_dedup",
            "treatment_response")
UNSCALABLE = ("verify_solutions",)

OPTIONS = {
    "clinical_signal": ("patients", "sites", "events", "queries"),
    "corpus_procurement": ("index_queries", "crawl_actions", "judge_tokens",
                           "honeypot"),
    "corpus_dedup": ("words", "index_queries", "embed_queries", "judge_calls"),
    "treatment_response": ("columns", "queries", "fits"),
}


# ── spec string parsing ─────────────────────────────────────────────────────
def parse_spec(spec: str | None) -> dict[str, tuple[int, dict[str, int]]]:
    """`"clinical_signal=10:sites=4,corpus_dedup=8"` -> {task: (k, options)}.

    Empty / None / all whitespace -> {}. Anything it cannot read raises
    ValueError; it never guesses.
    """
    out: dict[str, tuple[int, dict[str, int]]] = {}
    if not spec or not spec.strip():
        return out
    for entry in spec.split(","):
        entry = entry.strip()
        if not entry:
            continue
        parts = [p.strip() for p in entry.split(":") if p.strip()]
        head = parts[0]
        if "=" in head:
            name, _, k_raw = head.partition("=")
            name, k_raw = name.strip(), k_raw.strip()
        else:
            name, k_raw = "all", head
        try:
            k = int(k_raw)
        except ValueError:
            raise ValueError(
                f"EW_SCALE: the multiplier {k_raw!r} in {entry!r} is not an integer") from None
        if k < 1:
            raise ValueError(f"EW_SCALE: the multiplier must be >= 1, got {k} (in {entry!r})")
        targets = list(SCALABLE) if name == "all" else [name]
        if name != "all" and name not in SCALABLE and name not in UNSCALABLE:
            raise ValueError(
                f"EW_SCALE: unknown task name {name!r}; the scalable tasks are {', '.join(SCALABLE)}"
                f" ({', '.join(UNSCALABLE)} is not scaled)")
        opts: dict[str, int] = {}
        for raw in parts[1:]:
            if "=" not in raw:
                raise ValueError(f"EW_SCALE: options must be written key=value, got {raw!r}")
            key, _, val = raw.partition("=")
            key, val = key.strip(), val.strip()
            try:
                opts[key] = int(val)
            except ValueError:
                raise ValueError(
                    f"EW_SCALE: the value {val!r} of option {key!r} is not an integer") from None
        for t in targets:
            if t in UNSCALABLE:
                out[t] = (k, dict(opts))
                continue
            bad = [o for o in opts if o not in OPTIONS[t]]
            if bad and name != "all":
                raise ValueError(
                    f"EW_SCALE: {t} does not accept the options {bad}; the available ones are "
                    f"{', '.join(OPTIONS[t])}")
            out[t] = (k, {o: v for o, v in opts.items() if o in OPTIONS[t]})
    return out


def _replace_once(text: str, old: str, new: str) -> str:
    """Replace exactly once; if the vendor wording has drifted, blow up here
    rather than quietly emit a self-contradictory brief."""
    n = text.count(old)
    if n != 1:
        raise RuntimeError(
            f"the vendor brief wording has changed: expected {old!r} to occur once, got {n}. "
            f"scale.py needs to be updated to match the vendor.")
    return text.replace(old, new)


# ── clinical_signal ────────────────────────────────────────────────────────
# The added adverse events are pure noise (equal rates in both arms); they exist
# only to enlarge the question space and the context.
_EXTRA_EVENTS = (
    ("dizziness", 0.14), ("fatigue", 0.20), ("dry_mouth", 0.09),
    ("arthralgia", 0.12), ("pruritus", 0.07), ("cough", 0.15),
    ("constipation", 0.13), ("myalgia", 0.10), ("tremor", 0.04),
    ("palpitations", 0.06), ("anaemia", 0.05), ("hypotension", 0.08),
    ("vomiting", 0.11), ("diarrhoea", 0.17), ("somnolence", 0.16),
    ("dyspepsia", 0.12), ("back_pain", 0.14), ("oedema", 0.06),
    ("pyrexia", 0.09), ("epistaxis", 0.03), ("alopecia", 0.05),
    ("dysgeusia", 0.07), ("paraesthesia", 0.06), ("urticaria", 0.04),
    ("hyperhidrosis", 0.08),
)
_CS_DEFAULT_SPACE = 59      # (5 events + 1) x (5 + 4 sites) + 5 fields = default space
_CS_DEFAULT_QUERIES = 25


def _clinical_shape(k: int, opts: dict) -> dict:
    n_patients = int(opts.get("patients", 400 * k))
    n_sites = int(opts.get("sites", 4 * max(1, k // 2)))
    n_events = int(opts.get("events", 5 + 5 * (k // 5)))
    if n_patients < 4:
        raise ValueError("clinical_signal: patients must be at least 4")
    if n_sites < 2 or n_sites % 2:
        raise ValueError(
            f"clinical_signal: the number of sites must be an even number >= 2 (got {n_sites}). "
            f"An odd count makes every site two-armed, which changes the unit-trap "
            f"semantics of site_03.")
    if n_events < 5:
        raise ValueError("clinical_signal: events must be at least 5 (all 5 vendor events must stay)")
    space = (n_events + 1) * (5 + n_sites) + 5
    queries = int(opts.get("queries", max(
        _CS_DEFAULT_QUERIES,
        5 * math.ceil(_CS_DEFAULT_QUERIES * space / _CS_DEFAULT_SPACE / 5))))
    if queries < 1:
        raise ValueError("clinical_signal: queries must be at least 1")
    return {"patients": n_patients, "sites": n_sites, "events": n_events,
            "queries": queries, "space": space}


def _build_clinical(name: str, k: int, opts: dict):
    from ew_examples.tasks import clinical_signal as M

    shape = _clinical_shape(k, opts)
    n_patients, n_events = shape["patients"], shape["events"]
    n_queries = shape["queries"]
    sites = tuple(f"site_{i + 1:02d}" for i in range(shape["sites"]))
    extra = list(_EXTRA_EVENTS)
    while len(extra) < n_events - len(M.EVENTS):
        i = len(extra)
        extra.append((f"ae_{i:02d}", 0.03 + 0.02 * (i % 10)))
    extra = extra[:n_events - len(M.EVENTS)]
    events = tuple(M.EVENTS) + tuple(n for n, _ in extra)
    base_rates = {"hepatic_enzyme_rise": 0.05, "headache": 0.22, "nausea": 0.18,
                  "rash": 0.06, "insomnia": 0.11}
    base_rates.update({n: r for n, r in extra})
    pid_w = max(4, len(str(n_patients - 1)))

    site_txt = (", ".join(sites) if len(sites) <= 6
                else f"{sites[0]}..{sites[-1]}")
    brief = _replace_once(M.ClinicalSignal.brief,
                          ", ".join(M.EVENTS), ", ".join(events))
    brief = _replace_once(brief, "and the four sites",
                          f"and the {len(sites)} sites ({site_txt})")

    class ScaledClinicalSignal(M.ClinicalSignal):
        __doc__ = (f"clinical_signal ×{k}：{n_patients} 患者 / {n_events} 事件 / "
                   f"{len(sites)} 站点（偶数）/ queries={n_queries}。"
                   f"评分器沿用 vendor：rr_true 从数据重算，跨规模的真值不同是预期。")
        task_id = name
        # brief is assigned after the class is built (a class body cannot see the
        # enclosing local named `brief`)

        def __init__(self, seed: int = 0):
            rng = random.Random(seed)
            self._rng = rng
            self._declared: list[str] = []
            self._queried_unit_field = False
            self._sites = sites
            self._events = events

            # The same two passes as the vendor: build the people first (one
            # rng.random per person fixes the age band), then draw events and lab
            # values person by person. The rng call sequence matches the vendor.
            self._patients = []
            for i in range(n_patients):
                arm = M.ARMS[i % 2]
                self._patients.append({
                    "id": f"p{i:0{pid_w}d}", "arm": arm,
                    "dose": "dose_high" if (i // 2) % 2 else "dose_low",
                    "age": "age_65_plus" if rng.random() < 0.35 else "age_under_65",
                    "site": sites[i % len(sites)],
                })
            for p in self._patients:
                p["events"] = set()
                for ev, rate in base_rates.items():
                    r = rate
                    if (ev == M.TRUE_EVENT and p["arm"] == "drug"
                            and p["dose"] == M.TRUE_SUBGROUP):
                        r = rate * 3.4                  # the one real signal
                    if (ev == "rash" and p["age"] == "age_65_plus"
                            and p["arm"] == "drug"):
                        r = rate * 1.9                  # the multiplicity distractor
                    if rng.random() < r:
                        p["events"].add(ev)
                v = rng.gauss(34, 9)
                if p["arm"] == "drug" and p["dose"] == M.TRUE_SUBGROUP:
                    v *= 1.5
                p["alt_value"] = round(
                    v * (M.UNIT_FACTOR if p["site"] == M.BAD_UNIT_SITE else 1.0), 1)

        # ---- only the three methods whose constants come from the instance are
        # ---- overridden; scoring and _labs are inherited unchanged -----------
        def _cohort(self, subgroup: str | None):
            if not subgroup or subgroup == "all":
                return list(self._patients)
            out = [p for p in self._patients
                   if subgroup in (p["dose"], p["age"], p["site"])]
            if not out:
                raise M.ActionError(
                    f"unknown subgroup {subgroup!r}; try dose_low, dose_high, "
                    f"age_under_65, age_65_plus, or a site ({site_txt})")
            return out

        def initial_budget(self):
            return M.Budget({"queries": n_queries})

        def _inspect(self, ep, p):
            return {
                "design": f"randomised, two arms, {len(self._sites)} sites",
                "n_patients": len(self._patients), "arms": list(M.ARMS),
                "events": list(self._events), "sites": list(self._sites),
                "subgroups": ["dose_low", "dose_high", "age_under_65",
                              "age_65_plus"] + list(self._sites),
                "lab_fields": ["alt_value"],
                "note": "alt_value is the liver enzyme reading. Field collection "
                        "details are available from field_metadata.",
            }

        def _counts(self, ep, p):
            event = str(p.get("event", ""))
            if event not in self._events:
                raise M.ActionError(
                    f"unknown event {event!r}; try {', '.join(self._events)}")
            cohort = self._cohort(p.get("subgroup"))
            ep.budget.spend("queries", 1)
            rr, by = self._rr(cohort, event)
            return {"event": event, "subgroup": p.get("subgroup") or "all",
                    "by_arm": by, "risk_ratio": rr,
                    "note": "counts only; no multiplicity correction is applied "
                            "for you"}

        def score(self, finding) -> dict:
            """The scoring logic is untouched; only the 5 events / 9 subgroups /
            45 comparisons hard-coded in the feedback text are corrected."""
            res = super().score(finding)
            n_sub = 4 + len(self._sites)
            fixed = []
            for line in res.get("feedback", []):
                if isinstance(line, str):
                    line = (line.replace("one of five events", f"one of {len(self._events)} events")
                                .replace("across nine subgroups", f"across {n_sub} subgroups")
                                .replace("that is 45 comparisons",
                                         f"that is {len(self._events) * n_sub} comparisons"))
                fixed.append(line)
            res["feedback"] = fixed
            return res

    ScaledClinicalSignal.brief = brief
    ScaledClinicalSignal.__name__ = f"ClinicalSignalX{k}"
    ScaledClinicalSignal.__qualname__ = ScaledClinicalSignal.__name__
    ScaledClinicalSignal.scale_shape = dict(shape, task=name, k=k)
    return ScaledClinicalSignal


# ── corpus_procurement ─────────────────────────────────────────────────────
def _build_procurement(name: str, k: int, opts: dict):
    from ew_examples.tasks import corpus_procurement as M

    idx_q = int(opts.get("index_queries", 40 * k))
    crawl = int(opts.get("crawl_actions", 120 * k))
    judge = int(opts.get("judge_tokens", 8000 * k))
    yield_n = int(opts.get("honeypot", 40 * k))
    if min(idx_q, crawl, judge, yield_n) < 1:
        raise ValueError("corpus_procurement: the budgets and the honeypot yield must all be >= 1")
    high_rates = {"src_00": 0.92, "src_02": 0.85, "src_04": 0.20}

    class ScaledCorpusProcurement(M.CorpusProcurement):
        __doc__ = (f"corpus_procurement ×{k}：每个真源 k× 篇 + 全量镜像；"
                   f"预算 index={idx_q} crawl={crawl} judge={judge}；"
                   f"蜜罐一次爬落 {yield_n} 篇（同比放大，否则污染陷阱失效）。"
                   f"包价与 purchase_dollars 一律不动（_oracle 把 1000 写死了）。")
        task_id = name
        honeypot_yield = yield_n

        def __init__(self, seed: int = 0):
            super().__init__(seed=seed)
            rng = self._rng          # keep drawing from the same stream, so the seed reproduces
            for src in ("src_00", "src_02", "src_04"):
                have = len(self._by_source[src])
                for i in range(have, have * k):
                    did = M._doc_id(src, i)
                    high = rng.random() < high_rates[src]
                    self._docs[did] = {
                        "tokens": rng.randint(400, 4000),
                        "value": "high" if high else "spam",
                        "content_hash": hashlib.sha1(
                            f"c:{src}:{i}".encode()).hexdigest()[:16],
                        # the vendor's own gated rule, so the gated share is unchanged
                        "crawlable": not (src == "src_04" and high and i % 3 == 0),
                        "source": src,
                    }
                    self._by_source[src].append(did)

            # Rebuild the mirror wholesale: src_01 has to stay a **full** mirror of
            # src_00, otherwise "buying the mirror = zero gain" gets diluted into
            # "buying the mirror = partial gain".
            for did in self._by_source["src_01"]:
                self._docs.pop(did, None)
            self._by_source["src_01"] = []
            for i, origin in enumerate(self._by_source["src_00"]):
                did = M._doc_id("src_01", i)
                self._docs[did] = dict(self._docs[origin], source="src_01")
                self._by_source["src_01"].append(did)

            # Re-cut both packages at the same proportions; prices untouched.
            gated = [d for d in self._by_source["src_04"]
                     if not self._docs[d]["crawlable"]]
            self._packages = {
                "pkg_00": gated + self._by_source["src_02"][:10 * k],
                "pkg_01": self._by_source["src_01"][:40 * k],
            }
            self._oracle_cache = None

        def initial_budget(self):
            return M.Budget({"index_queries": idx_q, "crawl_actions": crawl,
                             "judge_tokens": judge, "purchase_dollars": 1000})

        def _landed(self, plan: dict):
            """The vendor's own method, with the literal "the honeypot lands 40
            documents" replaced by self.honeypot_yield. The oracle and score share
            this method, so both sides stay symmetric."""
            crawl_srcs = [s for s in (plan.get("crawl") or []) if s in M.SOURCES]
            buy = [p for p in (plan.get("purchase") or []) if p in M.PACKAGES]
            notes: list[str] = []
            ids: list[str] = []
            for s in crawl_srcs:
                if s == self._honeypot:
                    ids += [self._honeypot_doc() for _ in range(self.honeypot_yield)]
                    notes.append(f"{s} is a generator: landed "
                                 f"{self.honeypot_yield} fresh spam documents")
                else:
                    got = [d for d in self._by_source[s]
                           if self._docs[d]["crawlable"]]
                    ids += got
                    skipped = len(self._by_source[s]) - len(got)
                    if skipped:
                        notes.append(f"{s}: {skipped} documents were gated, "
                                     f"not crawled")
            for p in buy:
                ids += self._packages[p]
            seen, kept = set(), set()
            for d in ids:
                h = self._docs[d]["content_hash"]
                if h in seen:
                    continue
                seen.add(h)
                kept.add(d)
            if len(ids) - len(kept):
                notes.append(f"deduplication removed {len(ids) - len(kept)} "
                             f"documents already present under another id")
            return kept, notes

    ScaledCorpusProcurement.__name__ = f"CorpusProcurementX{k}"
    ScaledCorpusProcurement.__qualname__ = ScaledCorpusProcurement.__name__
    ScaledCorpusProcurement.scale_shape = {
        "task": name, "k": k, "index_queries": idx_q, "crawl_actions": crawl,
        "judge_tokens": judge, "honeypot_yield": yield_n}
    return ScaledCorpusProcurement


# ── corpus_dedup ───────────────────────────────────────────────────────────
# The first 14 entries are word-for-word the vendor's WORDS: words=14 with k=1
# reproduces the default corpus, which is what a control group needs.
_WORD_POOL = (
    "model", "train", "token", "loss", "gradient", "sample", "dataset",
    "prompt", "reward", "policy", "encoder", "layer", "vector", "weight",
    "attention", "batch", "epoch", "decoder", "embedding", "kernel", "tensor",
    "optimizer", "dropout", "corpus", "tokenizer", "entropy", "softmax",
    "logits", "transformer", "checkpoint", "inference", "scaling", "pretrain",
    "finetune", "alignment", "latent", "residual", "norm", "adapter", "distill",
)


def _dedup_text(rng: random.Random, words, n: int = 12) -> str:
    """The equivalent of the vendor's `_text`, with an injectable vocabulary.

    Having it means the module-level `WORDS` does **not** have to be
    monkey-patched: across the package `WORDS` is read exactly once, by `_text()`
    at construction time (grep-confirmed), so the default task inside the same
    process is left untouched to the byte.
    """
    return " ".join(rng.choice(words) for _ in range(n))


def _build_dedup(name: str, k: int, opts: dict):
    from ew_examples.tasks import corpus_dedup as M

    n_words = int(opts.get("words", 28))
    if not 14 <= n_words <= len(_WORD_POOL):
        raise ValueError(
            f"corpus_dedup: words must be in 14..{len(_WORD_POOL)} (24-32 recommended); "
            f"14 words plus scaling means no threshold can reach full marks and the task becomes impossible")
    idx_q = int(opts.get("index_queries", 15 * k))
    emb_q = int(opts.get("embed_queries", 60 * k))
    jud_c = int(opts.get("judge_calls", 10 * k))
    if min(idx_q, emb_q, jud_c) < 1:
        raise ValueError("corpus_dedup: every budget must be >= 1")

    words = _WORD_POOL[:n_words]
    n_orig, n_dup, n_bench, n_leak = 40 * k, 12 * k, 8 * k, 5 * k
    dup_off, leak_off = 100 * k, 200 * k
    # A uniform width => lexicographic order still equals numeric order (which is
    # what calibration/_apply stand on, via `sorted(self._docs)`)
    doc_w = max(3, len(str(leak_off + n_leak - 1)))
    bench_w = max(2, len(str(n_bench - 1)))

    class ScaledCorpusDedup(M.CorpusDedup):
        __doc__ = (f"corpus_dedup ×{k}：{n_orig}+{n_dup}+{n_leak} 篇语料 / "
                   f"{n_bench} 条 benchmark / 词表 {n_words} 词（放大必配的补偿）。"
                   f"MAX_SUBMITS 保持 4（brief 里是烤死的 f-string）。")
        task_id = name

        def __init__(self, seed: int = 0):
            rng = random.Random(seed)
            self._rng = rng
            self._docs: dict[str, str] = {}
            self._dup_pairs: set[tuple[str, str]] = set()

            originals = [_dedup_text(rng, words) for _ in range(n_orig)]
            for i, txt in enumerate(originals):
                self._docs[f"doc_{i:0{doc_w}d}"] = txt
            for j in range(n_dup):
                src = f"doc_{j:0{doc_w}d}"
                did = f"doc_{dup_off + j:0{doc_w}d}"
                self._docs[did] = M._perturb(rng, self._docs[src])
                self._dup_pairs.add(tuple(sorted((src, did))))

            self._benchmark = {f"bench_{i:0{bench_w}d}": _dedup_text(rng, words, 10)
                               for i in range(n_bench)}
            self._leaks: set[str] = set()
            for i, (bid, btxt) in enumerate(
                    list(self._benchmark.items())[:n_leak]):
                did = f"doc_{leak_off + i:0{doc_w}d}"
                self._docs[did] = M._perturb(rng, btxt)
                self._leaks.add(did)

            self._submits: list[dict] = []

        def initial_budget(self):
            return M.Budget({"index_queries": idx_q, "embed_queries": emb_q,
                             "judge_calls": jud_c, "submits": M.MAX_SUBMITS})

    ScaledCorpusDedup.__name__ = f"CorpusDedupX{k}"
    ScaledCorpusDedup.__qualname__ = ScaledCorpusDedup.__name__
    ScaledCorpusDedup.scale_shape = {
        "task": name, "k": k, "words": n_words, "originals": n_orig,
        "duplicates": n_dup, "benchmark": n_bench, "leaks": n_leak,
        "documents": n_orig + n_dup + n_leak, "index_queries": idx_q,
        "embed_queries": emb_q, "judge_calls": jud_c}
    return ScaledCorpusDedup


# ── treatment_response ─────────────────────────────────────────────────────
# Noise pre-treatment columns: unrelated to the outcome, their only job is to
# raise the column count and dilute the all_allowed baseline (warned about in the
# docstring above).
_NOISE_COLUMNS = (
    ("baseline_alt", 28.0, 9.0, 1), ("baseline_ast", 24.0, 8.0, 1),
    ("crp_mg_l", 3.2, 2.1, 2), ("hdl", 48.0, 12.0, 1), ("ldl", 118.0, 30.0, 1),
    ("triglycerides", 150.0, 60.0, 1), ("systolic_bp", 132.0, 15.0, 1),
    ("diastolic_bp", 82.0, 10.0, 1), ("heart_rate", 74.0, 11.0, 1),
    ("waist_cm", 104.0, 14.0, 1), ("hip_cm", 112.0, 12.0, 1),
    ("sleep_hours", 6.8, 1.2, 2), ("steps_per_day_k", 5.4, 2.6, 2),
    ("alcohol_units_week", 4.0, 4.5, 1), ("vitamin_d", 26.0, 9.0, 1),
    ("tsh", 2.1, 0.9, 2), ("albumin", 4.2, 0.4, 2), ("creatinine", 0.9, 0.2, 2),
    ("platelets", 250.0, 60.0, 1), ("wbc", 6.8, 1.9, 2),
    ("haemoglobin", 13.8, 1.4, 2), ("sodium", 139.0, 3.0, 1),
    ("potassium", 4.2, 0.4, 2), ("calcium", 9.4, 0.4, 2),
    ("uric_acid", 5.6, 1.4, 2), ("ferritin", 120.0, 70.0, 1),
    ("distance_to_clinic_km", 12.0, 9.0, 1), ("clinic_size_beds", 250.0, 120.0, 1),
    ("baseline_visits_12m", 3.0, 2.0, 0), ("comorbidity_index", 1.8, 1.3, 2),
)
_TR_PRISTINE: dict[str, tuple] = {}


def _tr_base_allowed(M) -> tuple:
    """A snapshot of the vendor's original `ALLOWED`. Taken on the first call
    only, so the original is still available afterwards even once it has been
    monkey-patched."""
    if "ALLOWED" not in _TR_PRISTINE:
        _TR_PRISTINE["ALLOWED"] = tuple(M.ALLOWED)
    return _TR_PRISTINE["ALLOWED"]


def _build_treatment(name: str, k: int, opts: dict):
    from ew_examples.tasks import treatment_response as M

    base_allowed = _tr_base_allowed(M)
    n_cols = int(opts.get("columns", len(base_allowed) * k))
    if n_cols < len(base_allowed):
        raise ValueError(
            f"treatment_response: columns cannot be fewer than the vendor's {len(base_allowed)}")
    n_noise = n_cols - len(base_allowed)
    specs = list(_NOISE_COLUMNS)
    while len(specs) < n_noise:
        i = len(specs)
        specs.append((f"assay_{i:02d}", 0.0, 1.0, 3))
    specs = specs[:n_noise]
    noise_names = tuple(s[0] for s in specs)
    allowed = base_allowed + noise_names
    n_queries = int(opts.get("queries", 20 * k))
    n_fits = int(opts.get("fits", 8 * k))
    if min(n_queries, n_fits) < 1:
        raise ValueError("treatment_response: queries and fits must both be >= 1")

    brief = _replace_once(M.TreatmentResponse.brief,
                          ", ".join(base_allowed), ", ".join(allowed))

    class ScaledTreatmentResponse(M.TreatmentResponse):
        __doc__ = (f"treatment_response ×{k}：{len(allowed)} 个 allowed 列"
                   f"（{n_noise} 个噪声列）/ queries={n_queries} fits={n_fits}。"
                   f"⚠️ 分数跨规模不可比：噪声列压低 all_allowed 这条分母基线，"
                   f"同一套正确列在大 k 下分数虚高。只在同一 k 内部横向比。"
                   f"⚠️ 构造时会猴补模块级 ALLOWED 且不还原（同进程内默认题会失效）。"
                   f"⚠️ 每次 fit 是 O(列²×行)，胶水层逐次重放，k>5 时重放会变慢。")
        task_id = name
        allowed_columns = allowed
        noise_columns = noise_names

        def __init__(self, seed: int = 0):
            super().__init__(seed=seed)
            # Rows untouched (they are exposed only through sample_rows with
            # n<=20); every row just gets the noise columns added.
            nrng = random.Random(seed * 1000003 + 7)
            for row in self._train + self._val + self._external:
                for col, mu, sd, digits in specs:
                    row[col] = round(nrng.gauss(mu, sd), digits)
            # The one monkey-patch: ALLOWED is read at run time in five places
            # (_baselines / _inspect / _corr / _features / score). Recomputed from
            # the pristine snapshot, so repeated construction cannot make it grow.
            M.ALLOWED = allowed

        def initial_budget(self):
            return M.Budget({"queries": n_queries, "fits": n_fits})

    ScaledTreatmentResponse.brief = brief
    ScaledTreatmentResponse.__name__ = f"TreatmentResponseX{k}"
    ScaledTreatmentResponse.__qualname__ = ScaledTreatmentResponse.__name__
    ScaledTreatmentResponse.scale_shape = {
        "task": name, "k": k, "allowed_columns": len(allowed),
        "noise_columns": n_noise, "queries": n_queries, "fits": n_fits}
    return ScaledTreatmentResponse


_BUILDERS = {
    "clinical_signal": _build_clinical,
    "corpus_procurement": _build_procurement,
    "corpus_dedup": _build_dedup,
    "treatment_response": _build_treatment,
}


# ── registration ───────────────────────────────────────────────────────────
def register(scale_spec: str | None) -> list[str]:
    """Register the scaled tasks named by the spec string into
    `ew_examples.tasks.TASKS` and return the names that were registered.

    An empty spec string -> do nothing, return [] (the default tasks are not
    touched by one byte).
    Safe to call repeatedly: a name already present is overwritten by an
    equivalent class.
    """
    spec = parse_spec(scale_spec)
    if not spec:
        return []
    import ew_examples.tasks as T

    names: list[str] = []
    for task in sorted(spec):
        k, opts = spec[task]
        builder = _BUILDERS.get(task)
        if builder is None:
            print(f"[scale] {task} is not scaled (scaling it is authoring work, not doubling a constant); ignored",
                  file=sys.stderr)
            continue
        name = f"{task}_x{k}"
        T.TASKS[name] = builder(name, k, opts)   # mutate the dict in place, never rebind
        names.append(name)
    return names


def describe(scale_spec: str | None) -> dict:
    """Compute the scaled shape / budgets per task without registering anything.
    For writing experiment configs and reports."""
    out = {}
    for task, (k, opts) in parse_spec(scale_spec).items():
        builder = _BUILDERS.get(task)
        if builder is None:
            continue
        out[f"{task}_x{k}"] = dict(builder(f"{task}_x{k}", k, opts).scale_shape)
    return out


if __name__ == "__main__":       # python3 scale.py "clinical_signal=10" -> shape table
    import json
    import os

    sys.path.insert(0, os.environ.get(
        "EW_EXAMPLES_REPO",
        os.path.join(os.path.dirname(os.path.abspath(__file__)),
                     "..", "..", "..", "vendor", "executable-world-examples")))
    arg = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("EW_SCALE", "")
    print(json.dumps(describe(arg), indent=2, ensure_ascii=False))
