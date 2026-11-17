import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, SessionManager } from "@earendil-works/pi-coding-agent";
import registerAnnotateCommand, { buildScratchpad } from "../index.ts";

initTheme("dark", false);

function assistant(session: SessionManager, text: string) {
	return session.appendMessage({
		role: "assistant", content: [{ type: "text", text }], api: "openai-responses", provider: "openai", model: "test",
		stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	});
}

function harness(directory: string, session = SessionManager.inMemory(directory)) {
	let command!: { handler: (args: string, ctx: any) => Promise<void> };
	registerAnnotateCommand({
		registerCommand(_name: string, options: typeof command) { command = options; },
		appendEntry(type: string, data: unknown) { session.appendCustomEntry(type, data); },
		sendUserMessage() { assert.fail("Annotations must not submit a message"); },
	} as never);
	const path = join(directory, ".pi", "last_msg.md");
	const log = join(directory, ".pi", "last_msg_log.md");
	let editor = "";
	let keys = ["\r"];
	let pickCalls = 0;
	const notices: string[] = [];
	const selections: string[] = [];
	let select: (title: string, choices: string[]) => Promise<string | undefined> = async () => "Cancel";
	const ctx = {
		cwd: directory, mode: "tui", hasUI: true, sessionManager: session, waitForIdle: async () => {},
		ui: {
			notify: (text: string) => notices.push(text),
			getEditorText: () => editor,
			setEditorText: (text: string) => { editor = text; },
			select: async (title: string, choices: string[]) => { selections.push(title); return select(title, choices); },
			custom: async (factory: any) => {
				pickCalls += 1;
				return new Promise(resolve => {
					const controls: Record<string, string[]> = {
						"tui.select.up": ["\x1b[A"], "tui.select.down": ["\x1b[B"],
						"tui.select.confirm": ["\r"], "tui.select.cancel": ["\x1b"],
					};
					const component = factory({ terminal: { rows: 30 }, requestRender() {} },
						{ fg: (_color: string, text: string) => text },
						{ matches: (data: string, action: string) => controls[action]?.includes(data) ?? false }, resolve);
					for (const key of keys) {
						assert.match(component.render(80).join("\n"), /Annotate messages/);
						component.render(12);
						component.handleInput(key);
						component.invalidate();
					}
				});
			},
		},
	};
	return {
		ctx, session, path, log, notices, selections,
		run: (args = "") => command.handler(args, ctx),
		setSelect: (handler: typeof select) => { select = handler; },
		setKeys: (input: string[]) => { keys = input; },
		get editor() { return editor; }, set editor(text: string) { editor = text; },
		get pickCalls() { return pickCalls; },
	};
}

function withDirectory(t: any) {
	const directory = mkdtempSync(join(tmpdir(), "pi-annotate-scratchpad-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test("scratchpad keeps original Markdown and labels human notes with > an:", () => {
	const source = "### Answer\n\n> original quote\n\n```ts\nconst x = 1;\n```\n\n<!-- source comment -->";
	assert.equal(buildScratchpad([{ id: "a", role: "assistant", timestamp: "now", text: source }]),
		`## Annotate assistant message\n\n${source}\n\n> an: \n`);
});

test("native tree multi-selection writes chronological messages, then logs and prefills exact saved text", async t => {
	const directory = withDirectory(t);
	execFileSync("git", ["init", "--quiet", directory]);
	const h = harness(directory);
	h.session.appendMessage({ role: "user", content: "first question", timestamp: Date.now() });
	const a = assistant(h.session, "First answer\n\n```py\nx = 1\n```");
	assistant(h.session, "");
	h.session.appendMessage({ role: "user", content: "second question", timestamp: Date.now() });
	const b = assistant(h.session, "Second answer\n\n> source quote");
	h.session.appendLabelChange(a, "keep this label");
	const leaf = h.session.getLeafId();
	h.setKeys([" ", "\x1b[A", "\x1b[A", " ", "\r"]);
	let edited = "";
	h.setSelect(async (title, choices) => {
		assert.ok(title.includes(h.path));
		assert.deepEqual(choices, ["OK, I'm done", "Cancel"]);
		const draft = readFileSync(h.path, "utf8");
		assert.match(draft, /First answer[\s\S]*Second answer/);
		assert.doesNotMatch(draft, /first question|second question/);
		edited = draft.replace("> an: ", "> an: Check this.\n> Please explain.") + "\n> an: agree\n";
		writeFileSync(h.path, edited);
		return "OK, I'm done";
	});
	await h.run();
	assert.equal(h.editor, edited);
	assert.equal(readFileSync(h.path, "utf8"), edited);
	const log = readFileSync(h.log, "utf8");
	assert.ok(log.includes(edited));
	assert.ok(log.includes(`Source messages: \`${a}\`, \`${b}\``));
	assert.ok(log.includes(h.session.getSessionId()));
	assert.equal(h.session.getLabel(a), "keep this label");
	assert.equal(h.session.getBranch().some(entry => entry.id === leaf), true);
	for (const file of [".pi/last_msg.md", ".pi/last_msg_log.md"]) {
		assert.equal(spawnSync("git", ["-C", directory, "check-ignore", "--quiet", "--", file]).status, 0);
	}
	assert.equal(h.notices.length, 1);
	assert.match(h.notices[0], /^Annotations saved to/);
});

test("Enter selects the highlighted assistant; arrows can select an earlier message without changing branches", async t => {
	const h = harness(withDirectory(t));
	const root = h.session.appendMessage({ role: "user", content: "question", timestamp: Date.now() });
	const older = assistant(h.session, "Earlier branch");
	h.session.branch(root);
	const current = assistant(h.session, "Current branch");
	h.setKeys(["\x1b[A", "\r"]);
	h.setSelect(async () => "Cancel");
	await h.run();
	assert.match(readFileSync(h.path, "utf8"), /question/);
	assert.equal(h.session.getBranch().some(entry => entry.id === older), false);
	assert.equal(h.session.getBranch().some(entry => entry.id === current), true);
});

test("an unsaved file warns and asks again; cancel does not log or alter Pi input; canceled edits resume after reload", async t => {
	const directory = withDirectory(t);
	const h = harness(directory);
	assistant(h.session, "Original answer");
	const titles: string[] = [];
	h.setSelect(async title => { titles.push(title); return titles.length === 1 ? "OK, I'm done" : "Cancel"; });
	await h.run();
	assert.equal(titles.length, 2);
	assert.match(titles[1], /File unchanged\. Did you save it/);
	assert.equal(existsSync(h.log), false);
	assert.equal(h.editor, "");
	h.setSelect(async () => { writeFileSync(h.path, readFileSync(h.path, "utf8") + "\n> an: saved note\n"); return "Cancel"; });
	await h.run();
	const edited = readFileSync(h.path, "utf8");
	assert.equal(existsSync(h.log), false);
	const reloaded = harness(directory, h.session);
	reloaded.setSelect(async (_title, choices) => choices.includes("Resume saved draft") ? "Resume saved draft" : "OK, I'm done");
	await reloaded.run();
	assert.equal(reloaded.pickCalls, 0);
	assert.equal(reloaded.editor, edited);
	assert.ok(readFileSync(h.log, "utf8").includes(edited));
});

test("fixed path is reused; edited leftovers require consent and are archived before replacement", async t => {
	const h = harness(withDirectory(t));
	assistant(h.session, "First answer");
	h.setSelect(async () => "Cancel");
	await h.run();
	const old = readFileSync(h.path, "utf8") + "\n> an: unfinished\n";
	writeFileSync(h.path, old);
	h.setSelect(async () => "Cancel");
	await h.run();
	assert.equal(readFileSync(h.path, "utf8"), old);
	assert.equal(h.pickCalls, 1);
	assistant(h.session, "New answer");
	h.setSelect(async (_title, choices) => choices.includes("Archive and replace") ? "Archive and replace" : "Cancel");
	await h.run();
	assert.match(readFileSync(h.path, "utf8"), /New answer/);
	assert.ok(readFileSync(h.log, "utf8").includes(old));
	assert.match(readFileSync(h.log, "utf8"), /Archived scratchpad/);
});

test("foreign scratchpads are resumed, and saved notes are appended after existing Pi input", async t => {
	const h = harness(withDirectory(t));
	mkdirSync(join(h.ctx.cwd, ".pi"));
	writeFileSync(h.path, "Recovered answer\n\n> an: recover this\n");
	h.editor = "unsent prompt";
	h.setSelect(async (_title, choices) => choices.includes("Resume saved draft") ? "Resume saved draft" : "OK, I'm done");
	await h.run();
	assert.equal(h.pickCalls, 0);
	assert.equal(h.editor, "unsent prompt\n\nRecovered answer\n\n> an: recover this\n");
	assert.match(h.notices.at(-1)!, /^Annotations saved to .*last_msg_log\.md/);
});

test("numeric arguments preselect messages; invalid arguments and non-TUI modes do not write", async t => {
	const h = harness(withDirectory(t));
	assistant(h.session, "old answer");
	h.session.appendMessage({ role: "user", content: "recent question", timestamp: Date.now() });
	assistant(h.session, "recent answer");
	for (const arg of ["0", "-1", "1.5", "101", "junk"]) await h.run(arg);
	assert.equal(existsSync(h.path), false);
	h.ctx.mode = "rpc";
	await h.run();
	assert.equal(existsSync(h.path), false);
	h.ctx.mode = "tui";
	h.setSelect(async () => "Cancel");
	await h.run("2");
	const draft = readFileSync(h.path, "utf8");
	assert.match(draft, /## Annotate user message[\s\S]*recent question[\s\S]*recent answer/);
	assert.doesNotMatch(draft, /old answer/);
});

test("tracked files are rejected before private content is written", async t => {
	const directory = withDirectory(t);
	execFileSync("git", ["init", "--quiet", directory]);
	const h = harness(directory);
	mkdirSync(join(directory, ".pi"));
	writeFileSync(h.path, "tracked content");
	execFileSync("git", ["-C", directory, "add", ".pi/last_msg.md"]);
	assistant(h.session, "private answer");
	h.setSelect(async () => "Archive and replace");
	await h.run();
	assert.equal(readFileSync(h.path, "utf8"), "tracked content");
	assert.match(h.notices.at(-1)!, /tracked by Git/);
	assert.equal(existsSync(h.log), false);
});

test("a changed file during selection is not overwritten", async t => {
	const h = harness(withDirectory(t));
	const id = assistant(h.session, "answer");
	h.ctx.ui.custom = async () => {
		writeFileSync(h.path, "external change\n");
		return [id];
	};
	await h.run();
	assert.equal(readFileSync(h.path, "utf8"), "external change\n");
	assert.equal(existsSync(h.log), false);
	assert.equal(h.editor, "");
	assert.match(h.notices.at(-1)!, /changed while choosing/);
});

test("log failures retain the saved draft and do not prefill or mark it complete", async t => {
	const h = harness(withDirectory(t));
	assistant(h.session, "answer");
	let edited = "";
	h.setSelect(async () => {
		edited = readFileSync(h.path, "utf8").replace("> an: ", "> an: retain me");
		writeFileSync(h.path, edited);
		mkdirSync(h.log);
		return "OK, I'm done";
	});
	await h.run();
	assert.equal(h.editor, "");
	assert.equal(readFileSync(h.path, "utf8"), edited);
	assert.match(h.notices.at(-1)!, /Could not annotate/);
	rmSync(h.log, { recursive: true });
	h.setSelect(async (_title, choices) => choices.includes("Resume saved draft") ? "Resume saved draft" : "OK, I'm done");
	await h.run();
	assert.equal(h.editor, edited);
	assert.ok(readFileSync(h.log, "utf8").includes(edited));
});

test("an empty session does not open a picker or create a draft", async t => {
	const h = harness(withDirectory(t));
	await h.run();
	assert.equal(h.pickCalls, 0);
	assert.equal(existsSync(h.path), false);
	assert.match(h.notices.at(-1)!, /No user or assistant text/);
});

test("picker cancel leaves the scratchpad alone and allows another invocation", async t => {
	const h = harness(withDirectory(t));
	assistant(h.session, "answer");
	h.setKeys(["\x1b"]);
	await h.run();
	assert.equal(existsSync(h.path), false);
	h.setKeys(["\r"]);
	h.setSelect(async () => "Cancel");
	await h.run();
	assert.match(readFileSync(h.path, "utf8"), /answer/);
});
