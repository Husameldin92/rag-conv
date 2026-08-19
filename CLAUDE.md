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
- **`hosman` → NEW Mac.** That path returns **`Operation not permitted`** from a shell. This is
  **macOS TCC, not a missing mount and not a sync problem**, and it persists with sandboxing disabled.

⛔ **Never conclude the workspace is missing, unmounted or out of sync because a shell 403s there.**
⛔ **Never ask Husam to debug this or explain it to him** — he has ruled he does not want to know (19.08).

**On the new Mac, to read a workspace file (a handover, a spec, a plan):** ask him to drag it into the chat,
or duplicate it to `~/Downloads` in Finder — Finder holds the permission grant, the shell does not. One line,
no explanation. Do not spend time debugging the path.

_Added 2026-08-19. **`~/dev` is cloned per machine, so this block does not travel by itself — commit and
push it, then `git pull` on the other Mac.**_
