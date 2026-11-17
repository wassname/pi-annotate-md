# @wassname2/pi-annotated-journal

<!-- Drafted by PI/OpenAI and PI/Claude. -->
Annotate Pi messages in your own editor, then send your notes back to Pi.

```bash
pi install npm:@wassname2/pi-annotated-journal
```

```text
/annotate       # choose messages to annotate
/annotate 10    # preselect the last 10 messages
```

## Workflow

**1. In Pi, choose messages.** ↑/↓ move, Space toggles, Enter confirms. With nothing toggled, Enter uses the highlighted message.

```text
┌ Annotate messages (2 selected) ─────────────────────────────┐
│   [ ] user: why does the loss plateau?                      │
│ → [x] assistant: The LR schedule decays too early…          │
│   [ ] user: try cosine instead                              │
│   [x] assistant: Cosine run finished; val loss 2.31…        │
│ Space: toggle | Enter: use selection | Esc: cancel          │
└─────────────────────────────────────────────────────────────┘
```

**2. Pi writes the scratchpad and waits.** Leave this dialog open.

```text
┌─────────────────────────────────────────────────────────────┐
│ Now open /repo/.pi/last_msg.md in your editor.              │
│ Add your notes, then save the file.                         │
│ Do not close this dialog until you are done.                │
│ → OK, I'm done                                              │
│   Cancel                                                    │
└─────────────────────────────────────────────────────────────┘
```

**3. In your editor, write after each `> an:` and save.** The original Markdown is kept.

```markdown
## Annotate assistant message

The LR schedule decays too early…

> an: why not warmup first?

---

## Annotate assistant message

Cosine run finished; val loss 2.31…

> an: compare against the step-decay run
```

**4. In Pi, choose "OK, I'm done".** Pi adds the saved file to your input (after any text already there) and does not send it. Press Enter to send.

```text
Annotations saved to /repo/.pi/last_msg_log.md
Added to your input. Press Enter to send.
```

If the file has not changed, Pi warns `File unchanged. Did you save it in your editor?` and asks again. Pi reads only the saved file, so unsaved editor changes are not included.

## Files

| File | Contents |
|---|---|
| `.pi/last_msg.md` | the scratchpad; the same path every time, so keep it open in your editor |
| `.pi/last_msg_log.md` | each confirmed scratchpad, with time, session and source message IDs |

The `.pi/` files are added to `.pi/.gitignore`. If one is already tracked by Git, `/annotate` stops and tells you how to untrack it.

Cancel keeps the scratchpad. Next time, `/annotate` offers to resume it, or to archive it to the log and start again. There is one scratchpad per working directory, so use one annotation at a time across sessions.

To also save your long user messages to a journal, see `pi-record-journal`. It leaves out `## Annotate … message` sections, which are already logged here.

## Development

```bash
npm ci --ignore-scripts
npm run check
```

For an editable install: `pi install /absolute/path/to/pi-annotated-journal`, then `/reload` after edits.
