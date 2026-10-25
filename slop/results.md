# Editable extension setup

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
