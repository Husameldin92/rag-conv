# rag-conv — working rules for Claude Code

Work-area project: RAG conversation / discovery API client work.

## 📁 Project docs live in Google Drive (not in this repo)

Code lives here (`~/dev/rag-conv`); **all project memory and handovers live in the Cowork workspace
on Google Drive** (moved 2026-07-24 — the repo used to sit inside the workspace):

```
~/Library/CloudStorage/GoogleDrive-hossamossman92@gmail.com/Meine Ablage/Claude-Homebase/02 Projects/Work/RAG/rag-conv/
```

**Read that folder first** (handover ▶ CURRENT TASK box + project overview) before starting work.

**At the end of a session**, append your handback to `[C] Handover — Claude Code to Cowork.md` in that
same Drive folder (commits, what changed, results, open items) so Cowork can sync the project memory.

## Notes
- `discovery-api-client/.env` holds credentials, is gitignored, and exists **only on this machine** —
  never commit it, don't delete it.


## ⛔ Start of session: SYNC FIRST, before you read or write anything

`~/dev` is cloned **per machine** and **nothing keeps the clones in sync** — work pushed from one Mac is
invisible on the other until someone pulls. On **19.08.2026 this cost three weeks**: this clone sat on a
31.07 commit while the 13.08 release work was already on `main`, and a build run was about to start on top
of it.

Run this first, every session, before anything else:

```
git fetch && git status
git pull --rebase --autostash
git log --oneline -3
```

⚠️ **A handover or project overview that records `HEAD = <sha>` describes the machine that wrote it, not the
one you are sitting at.** Treat every such line as a claim to verify, never as a fact.
⚠️ **A stale clone does not announce itself** — the code compiles, the tests pass, and the damage only
surfaces at `git push` or as work silently done twice.

## Which Mac am I on? Check before reading anything in Google Drive.

Run `whoami` at the start of the session:

- **`osmanhusam` → OLD Mac.** The Drive workspace reads normally at
  `~/Library/CloudStorage/GoogleDrive-hossamossman92@gmail.com/Meine Ablage/Claude-Homebase`.
- **`hosman` → NEW Mac.** ✅ **The Drive workspace reads normally here too, as of 2026-08-21.**

**RESOLVED 2026-08-21 — the old warning is kept only so nobody re-derives it.** Between 19.08 and 21.08
this path returned `Operation not permitted` from a shell on the new Mac; that was **macOS TCC**, and Full
Disk Access has since been granted. Verified 21.08 by reading a workspace file straight off the Drive path
with `sed`, no Finder copy involved — and re-confirmed 27.08.2026, when a Claude Code run on the new Mac
read its handover and build spec, and wrote its handback, directly from that path.

⛔ **Do not reintroduce the "ask Husam to drag the file into chat / duplicate it in Finder" workaround** —
it is no longer needed and costs a round-trip.
⛔ **Never ask Husam to debug TCC or explain it to him** — he has ruled he does not want to know (19.08).
That ruling stands even though the symptom is gone.

⚠️ If a shell ever 403s on that path again, Full Disk Access has been revoked (an OS update can do it) —
**it is never a missing mount and never a sync problem.** Say so in one line and use the Finder copy as a
fallback; do not spend the session debugging it.

_Added 2026-08-19, corrected 2026-08-21, re-confirmed 2026-08-27. **`~/dev` is cloned per machine, so this block does not travel by itself — commit and
push it, then `git pull` on the other Mac.**_
