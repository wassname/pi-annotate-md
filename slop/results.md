# Editable extension setup

## 2026-11-17 follow-up: done dialog, unchanged-file warning, cleanup

- Dialog now reads "Now open <path> in your editor. Add your notes, then save the file. Do not close this dialog until you are done." with choices "OK, I'm done" / "Cancel".
- An unchanged or empty file shows "⚠ File unchanged. Did you save it in your editor?" and asks again; nothing is logged.
- Saved notes are appended after existing Pi input with one blank line between, not refused. Notice: "Annotations saved to <log path>".
- Removed the old template parser/exporter: `src/core.ts`, `scripts/export-supervision.mjs`, their tests, the `bin` entry, and tracked slop logs (kept on disk). Tests: 26 pass (`slop/annotation-verification.log`). Code + tests 935 lines; repo diff +116 −888.
- README rewritten with an ASCII mock-up of the four steps.

-- PI/Claude

## File-based annotation scratchpad

Implemented `/annotate` as a read-only multi-message picker using Pi's native tree rows. Enter uses the highlighted message when nothing is checked; Space toggles multiple messages. `/annotate N` preselects the last N messages on the current branch. Picking never navigates the session or edits its labels.

The fixed `.pi/last_msg.md` file keeps normal Markdown, headed `## Annotate assistant message` (or user), with `> an:` prompts. The person opens this path once in their own editor. On OK, Pi reads the saved file, appends its exact text to `.pi/last_msg_log.md`, and fills Pi's input without sending it. No clipboard, editor launch, watcher, or annotation parser is involved.

Canceled edited drafts can be resumed after reload or archived before replacement. Empty, unchanged, and already-logged contents are not pasted. Nonempty Pi input is preserved. Private files receive ignore rules; already-tracked files are rejected before writing. The scratchpad is shared per working directory: concurrent annotation interactions across sessions are not supported.

Verification:
- `npm run check`: `tests 36`, `pass 36`, `fail 0` in `slop/annotation-verification.log`. Tests drive the actual native tree component and real SessionManager with a simulated UI, then inspect disk files, input text, labels, and Git's ignore decisions. Failure cases include a draft changed during selection and an unwritable log.
- An isolated, offline installed Pi runtime loaded `index.ts`; RPC `get_commands` returned `success: true` and registered `annotate` and `annotate-settings`. The captured response is in `slop/annotation-host-load.log`. I deliberately stopped that child runtime after the response (SIGTERM / 143). Its unrelated warning was `No models match pattern "anthropic-2/claude-opus-5-5"`; no model request was made.
- `git diff --check` passed. Existing auto-recording and old journal-export tests still pass. The new scratchpad log is plain Markdown, not the old exporter's encoded journal format.
- Not yet verified by a person in their running Pi/editor. Use `/reload`, then `/annotate`. The README changes are an uncommitted draft for review.

-- PI/gpt-6.1-sol

## Saved entry format

Auto-saved messages contain only a timestamp, readable extension/session attribution, and the quoted input:

```md
## 2026-09-01T00:02:00.000Z · User message

Saved by pi-annotated-journal · session `session-1`

> first line
> second line
> third line
```

No encoded metadata or wrapper comments are added. Comments inside the submitted message remain part of its quote. Existing journals are unchanged. `/reload` loads the updated writer in a running session.

Verification: `npm run check` in `slop/readable-journal-verification.log`: `tests 23`, `pass 23`, `fail 0`. The input-handler test checks readable session attribution and absence of added comments; the writer test checks exact output with blank lines, nested quotes, and a source comment. The existing annotation exporter test also passes.

-- PI/OpenAI

- One checkout: `/home/code/dev/pi-ext/pi-annotated-journal` (resolves to `/workspace/pi-ext/pi-annotated-journal`). Pi's package settings already load this local directory.
- The former `~/.pi/agent/git/github.com/wassname/pi-annotated-journal` checkout is now only a symlink to that directory. Both commit histories, lockfile changes, and task state were preserved.
- Edit `index.ts`, then `/reload`. No build or npm reinstall is needed.
- The first long message asks to enable recording for this session. Accepting records that message too. The answer survives reload; new sessions and forks start off.

Verification: `slop/verification.log` contains the typecheck and test output: `tests 15`, `pass 15`, `fail 0`. The user also reported: “it owrked”.

## Optional Git ignore rule

Enabling recording asks whether to add the journal to the repository's `.gitignore`. `Ignore journal` is selected first; Enter confirms and Esc changes no ignore rules. This also works through `/annotate-settings auto on` for an already-enabled session. Already ignored journals, paths outside the repository, and sessions without a UI do not prompt. Tracked files are not removed from Git.

Saving and ignore choices show an info notification with a change or undo instruction. Saving choices remain in `pi-annotate-settings` entries; ignore choices, including cancellation, are saved as `pi-annotate-gitignore` entries with the session ID and affected paths. Pi timestamps both kinds of session entry.

Verification: `slop/gitignore-verification.log` contains `tests 23`, `pass 23`, `fail 0`. Regression cases cover acceptance, refusal, cancellation, existing ignore rules, outside paths, headless mode, and symlinked working directories. They also check the default option, info receipts, and persisted choice records. Git itself confirms that the escaped rule ignores the exact journal filename, not similarly named files.

## Separate scheduler reload error

User reported `coordination.runInBackground is not a function` from the scheduler inside `pi-goals`.

Observed: the installed coordination module exports `runInBackground`. A fresh isolated Pi process loaded the same scheduler successfully and registered its commands, without using or changing the user's task store. The installed Pi reports version 1.1.0; the user's stack refers to bundled files that are no longer present in this installation.

Inference: an old running runtime or cached module is a likely cause. Full restart and resume is the next recovery test; recovery in the user's running session is not yet verified. No scheduler code or saved tasks were changed.

-- PI/OpenAI
