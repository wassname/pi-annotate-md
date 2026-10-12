import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
	buildAnnotationTemplate,
	buildUserMessageRecord,
	journalHeader,
	type ConversationMessage,
	type ConversationRole,
	type UserMessageRecordMetadata,
} from "./src/core.ts";

const DEFAULT_MESSAGE_COUNT = 6;
const MAX_MESSAGE_COUNT = 100;
const DEFAULT_JOURNAL_PATH = "docs/human_journal.md";

function parseCount(args: string): number | null {
	const value = args.trim();
	if (!value) return DEFAULT_MESSAGE_COUNT;
	if (!/^\d+$/.test(value)) return null;
	const count = Number(value);
	return Number.isSafeInteger(count) && count >= 1 && count <= MAX_MESSAGE_COUNT ? count : null;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content.trimEnd();
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object" || !("type" in part)) return "";
			if (part.type === "text" && "text" in part && typeof part.text === "string") return part.text;
			if (part.type === "image") return "[image omitted from annotation view]";
			return "";
		})
		.filter(Boolean)
		.join("\n\n")
		.trimEnd();
}

function conversationMessage(entry: SessionEntry): ConversationMessage | null {
	if (entry.type !== "message") return null;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return null;
	const text = textFromContent(message.content);
	if (!text.trim()) return null;
	return {
		id: entry.id,
		role: message.role as ConversationRole,
		timestamp: entry.timestamp,
		text,
	};
}

function recentConversation(ctx: ExtensionCommandContext, count: number): ConversationMessage[] {
	return ctx.sessionManager
		.getBranch()
		.map(conversationMessage)
		.filter((message): message is ConversationMessage => message !== null)
		.slice(-count);
}

function copyToClipboard(text: string, useOsc52: boolean): void {
	const errors: string[] = [];
	for (const [command, args] of [["pbcopy", []], ["wl-copy", []], ["xclip", ["-selection", "clipboard"]]] as Array<[string, string[]]>) {
		try {
			execFileSync(command, args, { input: text, stdio: ["pipe", "ignore", "pipe"] });
			return;
		} catch (error) {
			errors.push(`${command}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (useOsc52 && process.stdout.isTTY) {
		process.stdout.write(`\u001b]52;c;${Buffer.from(text).toString("base64")}\u0007`);
		return;
	}
	throw new Error(`No clipboard command succeeded. ${errors.join("; ")}`);
}

function journalPath(ctx: { cwd: string }): string {
	const configured = process.env.PI_ANNOTATE_JOURNAL?.trim() || DEFAULT_JOURNAL_PATH;
	return isAbsolute(configured) ? configured : resolve(ctx.cwd, configured);
}

function appendJournal(path: string, record: string): void {
	mkdirSync(dirname(path), { recursive: true });
	if (!existsSync(path)) {
		writeFileSync(path, journalHeader(), { encoding: "utf8", mode: 0o600 });
	}
	const existing = readFileSync(path, "utf8");
	const separator = existing.length === 0 || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
	appendFileSync(path, `${separator}${record}`, "utf8");
}

async function offerGitignore(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!ctx.hasUI) return;
	const root = spawnSync("git", ["-C", ctx.cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
	if (root.error) throw root.error;
	if (root.status === 128 && root.stderr.includes("not a git repository")) return;
	if (root.status !== 0) throw new Error(root.stderr);
	const path = journalPath(ctx);
	let ancestor = path;
	while (!existsSync(ancestor)) ancestor = dirname(ancestor);
	const canonicalPath = resolve(realpathSync(ancestor), relative(ancestor, path));
	const repoRoot = root.stdout.trim();
	const repoPath = relative(repoRoot, canonicalPath);
	if (repoPath === ".." || repoPath.startsWith("../") || isAbsolute(repoPath)) return;
	const ignored = spawnSync("git", ["-C", repoRoot, "check-ignore", "--quiet", "--", repoPath]);
	if (ignored.error) throw ignored.error;
	if (ignored.status === 0) {
		ctx.ui.notify(`Journal already ignored by Git: ${repoPath}.`, "info");
		return;
	}
	if (ignored.status !== 1) throw new Error(ignored.stderr.toString());
	const ignorePath = resolve(repoRoot, ".gitignore");
	const options = ["Ignore journal (default)", "Keep journal visible to Git"];
	const choice = await ctx.ui.select(
		`Add ${repoPath} to ${ignorePath}?\nAlready tracked files remain tracked. Esc leaves .gitignore unchanged.`,
		options,
	);
	if (choice === options[0]) {
		const existing = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
		const pattern = "/" + repoPath.replace(/[\\*?\[\] ]/g, "\\$&");
		appendFileSync(ignorePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${pattern}\n`, "utf8");
	}
	pi.appendEntry("pi-annotate-gitignore", {
		sessionId: ctx.sessionManager.getSessionId(),
		journalPath: path,
		gitignorePath: ignorePath,
		choice: choice ?? "cancelled",
	});
	ctx.ui.notify(choice === options[0]
		? `Journal added to .gitignore: ${repoPath}. To undo, remove its rule from ${ignorePath}.`
		: `Journal ${choice ? "kept visible to Git" : "ignore choice cancelled"}; .gitignore unchanged. Change: /annotate-settings auto on.`, "info");
}

interface AnnotateSettings {
	sessionId: string;
	autoAnnotate: boolean;
}

function annotateSettings(ctx: Pick<ExtensionContext, "sessionManager">): AnnotateSettings | undefined {
	const sessionId = ctx.sessionManager.getSessionId();
	for (const entry of ctx.sessionManager.getEntries().reverse()) {
		if (entry.type !== "custom" || entry.customType !== "pi-annotate-settings") continue;
		const settings = entry.data as AnnotateSettings;
		if (settings.sessionId === sessionId) return settings;
	}
	return undefined;
}

function autoAnnotateEnabled(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	return annotateSettings(ctx)?.autoAnnotate === true;
}

function notifyRecordingChoice(ctx: ExtensionContext, enabled: boolean): void {
	if (ctx.hasUI) ctx.ui.notify(`Auto-saving ${enabled ? "on" : "off"} (this session). Change: /annotate-settings auto ${enabled ? "off" : "on"}.`, "info");
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" };
		const unquotedLines = event.text.split(/\r?\n/).filter((line) => {
			const trimmed = line.trim();
			return trimmed.length > 0 && !trimmed.startsWith(">");
		});
		if (unquotedLines.length < 3) return { action: "continue" };
		if (!annotateSettings(ctx) && ctx.hasUI) {
			const accepted = await ctx.ui.confirm(
				"Automatically save long user messages?",
				`Save this message and future messages with at least 3 non-empty, non-quoted lines to ${journalPath(ctx)}? This applies only to this session. Change it with /annotate-settings.`,
			);
			pi.appendEntry("pi-annotate-settings", {
				sessionId: ctx.sessionManager.getSessionId(),
				autoAnnotate: accepted,
			} satisfies AnnotateSettings);
			notifyRecordingChoice(ctx, accepted);
			if (accepted) await offerGitignore(pi, ctx);
		}
		if (!autoAnnotateEnabled(ctx)) return { action: "continue" };
		const metadata: UserMessageRecordMetadata = {
			schema: 1,
			createdAt: new Date().toISOString(),
			sessionId: ctx.sessionManager.getSessionId(),
			sessionFile: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			source: event.source,
		};
		const path = journalPath(ctx);
		appendJournal(path, buildUserMessageRecord(metadata, event.text));
		if (ctx.hasUI) ctx.ui.notify(`long user message appended to ${path}`, "info");
		return { action: "continue" };
	});

	pi.registerCommand("annotate-settings", {
		description: "Configure automatic annotation for this session (off by default)",
		getArgumentCompletions: (prefix) => ["auto off", "auto on"]
			.filter((value) => value.startsWith(prefix))
			.map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const option = args.trim();
			let choice = option;
			if (!option) {
				if (!ctx.hasUI) return;
				const selected = await ctx.ui.select(
					`Auto-annotate long user messages: ${autoAnnotateEnabled(ctx) ? "on" : "off"} (this session)`,
					["auto off", "auto on"],
				);
				if (!selected) return;
				choice = selected;
			}
			if (choice !== "auto on" && choice !== "auto off") {
				ctx.ui.notify("Usage: /annotate-settings [auto on|off]", "warning");
				return;
			}
			try {
				pi.appendEntry("pi-annotate-settings", {
					sessionId: ctx.sessionManager.getSessionId(),
					autoAnnotate: choice === "auto on",
				} satisfies AnnotateSettings);
				notifyRecordingChoice(ctx, choice === "auto on");
				if (choice === "auto on") await offerGitignore(pi, ctx);
			} catch (error) {
				ctx.ui.notify(`Could not save annotation settings: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("annotate", {
		description: "Copy the last N user/assistant messages as Markdown quotes for annotation (default: 6)",
		handler: async (args, ctx) => {
			const count = parseCount(args);
			if (count === null) {
				ctx.ui.notify(`Usage: /annotate [N], /annotate-settings. N is 1-${MAX_MESSAGE_COUNT}.`, "warning");
				return;
			}

			await ctx.waitForIdle();
			const messages = recentConversation(ctx, count);
			if (messages.length === 0) {
				ctx.ui.notify("No user or assistant text found in the current branch.", "warning");
				return;
			}

			try {
				copyToClipboard(buildAnnotationTemplate(messages), ctx.mode === "tui");
				ctx.ui.notify("Copied to clipboard. Paste here or in an editor to annotate.", "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
}
