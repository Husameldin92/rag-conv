# Discovery API Client

Node scripts that call the Concord **Discovery** GraphQL API (`discovery` = 3K chunker path, `discoveryTest` = 1.5K path). Used for batch runs, 1.5K vs 3K comparisons, and LLM answer exports.

**Config:** `.env` — `GRAPHQL_ENDPOINT`, `AUTH_TOKEN` (optional).

**Questions:** `fixtures/questions.json` (used by batch scripts).

**Outputs:** `reports/` (JSON/CSV with timestamps).

**Renames (for clarity):** `compare.js` → `compare-discovery-vs-discoveryTest.js` · `quick-test.js` → `compare-llm-single-question.js` · `compare-pocs-and-llm.js` → `compare-chunk-csvs-and-llm.js` · `compare-one-question-pocs.js` → `analyze-multi-run-one-question.js`. Old `npm` names `quick-test`, `compare-pocs-and-llm`, `compare-one-question` still work as aliases.

---

## Script catalog (what to run when)

### Core — batch API runs

| npm script | File | Purpose |
|------------|------|---------|
| `npm start` / `npm run discoveryTest` | `src/index.js` | Runs **every question** in `fixtures/questions.json` with **`discoveryTest`**, writes `discoveryTest-report-{timestamp}.json` + `.csv`. |
| `npm run discovery` | `src/index.js` | Same as above but **`discovery`** (3K). |

**When to use:** Refresh full POC lists / scores after pipeline changes. Incremental saves after each question.

---

### Compare latest batch reports

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare` | `src/compare-discovery-vs-discoveryTest.js` | Loads the **latest** `discovery-report-*.csv` and **latest** `discoveryTest-report-*.csv`, compares POC IDs per question, writes `comparison-report-*.csv`. |

**When to use:** After you have run both `npm run discovery` and `npm run discoveryTest` (or two batches you want to diff).

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare-discoveryTest` | `src/compare-discoveryTest-runs.js` | Compares the **two most recent** `discoveryTest-report-*.json` files (genres, timings, zero-result questions, POC counts). |

**When to use:** Regression / “did this deploy change discoveryTest behaviour?”

---

### Single question — LLM answers

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare-llm-single-question` | `src/compare-llm-single-question.js` | Default question in file, or: `node src/compare-llm-single-question.js "Your question"`. Calls **`discovery`** and **`discoveryTest`**, reads **stream URLs**, saves both LLM answers to `reports/compare-llm-single-question-answers-{timestamp}.csv`. |
| `npm run quick-test` | *(alias)* | Same as `compare-llm-single-question`. |

**When to use:** Quick side-by-side answer quality check without chunk CSVs.

| npm script | File | Purpose |
|------------|------|---------|
| `npm run run-one-question` | `src/run-one-question.js` | **CLI:** `node src/run-one-question.js "Your question"` — no CSV input. Fetches POC rows + scores for both APIs, writes POC comparison CSV + LLM answers under `reports/compare-1.5k-vs-3k/`. |

**When to use:** Same idea as above but **POC-level scores** from the API (not chunk exports).

---

### 1.5K vs 3K — chunk CSVs + LLM

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare-chunk-csvs-and-llm` | `src/compare-chunk-csvs-and-llm.js` | **Args:** `1.5k.csv` `3k.csv` `[question]`. Parses **chunk** rows (`chunk_id`, `poc_id`, `score`), builds chunk alignment CSV, then fetches **LLM** answers for that question. |
| `npm run compare-pocs-and-llm` | *(alias)* | Same script (old name). |

**When to use:** You already exported chunk-level CSVs from the chunker for the same question; want chunk diff + answer diff in one go.

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare-two-csvs` | `src/compare-two-poc-csvs.js` | **Args:** two POC/score CSVs (1.5K vs 3K). Prints overlap, only-in-one, vector score ranges, score diffs; optional answer `.txt` files to cross-check **cited POCs** in answers. Writes a small CSV under `reports/`. |

**When to use:** Two POC-level exports (not necessarily full chunk dumps); focus on set/score diff + optional citation check.

---

### Multi-run / non-determinism experiments

| npm script | File | Purpose |
|------------|------|---------|
| `npm run run-multi-api-test` | `src/run-multi-api-test.js` | Runs **`discoveryTest`** over the **10 fixed questions** multiple times, writes `reports/multi-run-{timestamp}/` with per-run JSON. Intended to compare vector scores across repeats. |

| npm script | File | Purpose |
|------------|------|---------|
| `npm run analyze-multi-run-one-question` | `src/analyze-multi-run-one-question.js` | Reads a **`multi-run-*`** folder, builds a CSV comparing POC scores across runs for **one hardcoded question** (edit `QUESTION` in file). |
| `npm run compare-one-question` | *(alias)* | Same script (old name). |

**When to use:** After `run-multi-api-test`; analysing stability of retrieval scores for a single question.

---

### One-off / historical (edit paths before use)

| npm script | File | Purpose |
|------------|------|---------|
| `npm run compare-10-pocs` | `src/compare-10-questions-pocs.js` | Compares a **fixed old** `3k-discoveryTest-report-*.json` to the **latest** `discoveryTest-report-*.json` (excluding `3k-` prefix) for **10 hardcoded questions** — POC IDs and genres side by side. **Contains hardcoded report filename** — update or duplicate for new baselines. |

**When to use:** Migration / embedding comparison snapshots, not routine QA.

---

## Outputs (typical filenames)

- `reports/discovery-report-{timestamp}.json` / `.csv`
- `reports/discoveryTest-report-{timestamp}.json` / `.csv`
- `reports/comparison-report-{timestamp}.csv` (from `compare`)
- `reports/compare-llm-single-question-answers-{timestamp}.csv` (from `compare-llm-single-question` / `quick-test`)
- `reports/compare-1.5k-vs-3k/` — chunk + LLM comparisons from `compare-chunk-csvs-and-llm` / `run-one-question`
- `reports/multi-run-{timestamp}/` — from `run-multi-api-test`

---

## Notes

- Delays between API calls vary by script (often 3–5s) to reduce rate limits.
- `compare-chunk-csvs-and-llm`’s GraphQL query for LLM **does not request `score`** on results (chunks come from your CSVs).
- For a **minimal** workflow: `npm run discoveryTest` → inspect CSV; optionally `npm run discovery` → `npm run compare`.
