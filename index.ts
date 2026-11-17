import { TreeSelectorComponent, type ExtensionAPI, type ExtensionCommandContext, type SessionEntry, type SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
type ConversationMessage = { id: string; role: "user" | "assistant"; text: string };

const DRAFT_FILE = "last_msg.md";
const LOG_FILE = "last_msg_log.md";
const STATE_TYPE = "pi-annotate-scratchpad";

interface ScratchpadState {
	sessionId: string;
	path: string;
	text: string;
	messageIds: string[];
}

export function buildScratchpad(messages: ConversationMessage[]): string {
	return messages.map(message =>
		`## Annotate ${message.role} message\n\n${message.text}\n\n> an: \n`,
	).join("\n---\n\n");
}

function conversationMessage(entry: SessionEntry): ConversationMessage | undefined {
	if (entry.type !== "message") return;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return;
	const text = typeof message.content === "string" ? message.content : message.content
		.flatMap(part => part.type === "text" ? [part.text] : part.type === "image" ? ["[image omitted]"] : [])
		.join("\n\n");
	if (!text.trim()) return;
	return { id: entry.id, role: message.role, text };
}

function scratchpadState(ctx: ExtensionCommandContext, path: string): ScratchpadState | undefined {
	for (const entry of ctx.sessionManager.getEntries().reverse()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const state = entry.data as ScratchpadState;
		if (state.sessionId === ctx.sessionManager.getSessionId() && state.path === path) return state;
	}
}

function prepareFiles(cwd: string): void {
	const directory = resolve(cwd, ".pi");
	const tracked = spawnSync("git", ["-C", cwd, "ls-files", "--", `.pi/${DRAFT_FILE}`, `.pi/${LOG_FILE}`], { encoding: "utf8" });
	if (tracked.error) throw tracked.error;
	if (tracked.status !== 0 && !(tracked.status === 128 && tracked.stderr.includes("not a git repository"))) throw new Error(tracked.stderr);
	if (tracked.stdout.trim()) throw new Error(`Annotation files are tracked by Git. Untrack them first: git rm --cached -- ${tracked.stdout.trim().split("\n").join(" ")}`);
	mkdirSync(directory, { recursive: true });
	const ignorePath = resolve(directory, ".gitignore");
	const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, "utf8") : "";
	const missing = [DRAFT_FILE, LOG_FILE].map(name => `/${name}`).filter(rule => !ignore.split(/\r?\n/).includes(rule));
	if (missing.length) appendFileSync(ignorePath, `${ignore && !ignore.endsWith("\n") ? "\n" : ""}${missing.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
}

function logScratchpad(ctx: ExtensionCommandContext, text: string, messageIds: string[], archived = false): void {
	const path = resolve(ctx.cwd, ".pi", LOG_FILE);
	if (!existsSync(path)) writeFileSync(path, "# Annotation log\n\n", { encoding: "utf8", mode: 0o600 });
	const sources = messageIds.length ? `Source messages: ${messageIds.map(id => `\`${id}\``).join(", ")}\n\n` : "";
	appendFileSync(path,
		`## ${new Date().toISOString()} · ${archived ? "Archived scratchpad" : "Annotation"}\n\n` +
		`Saved by pi-annotated-journal · session \`${ctx.sessionManager.getSessionId()}\`\n\n` +
		sources + text + (text.endsWith("\n") ? "\n" : "\n\n"), "utf8");
}

async function pickMessages(ctx: ExtensionCommandContext, messages: ConversationMessage[], preselected: string[]): Promise<ConversationMessage[] | undefined> {
	const available = new Set(messages.map(message => message.id));
	const selected = new Set(preselected);
	const branch = ctx.sessionManager.getBranch().filter(entry => available.has(entry.id));
	const focus = [...branch].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant")?.id ?? branch.at(-1)?.id ?? messages.at(-1)!.id;
	const parents = new Map<string, string | null>();
	const nodes = new Map<string, SessionTreeNode>();
	const roots: SessionTreeNode[] = [];
	const labels = new Map<string, string>();
	for (const entry of ctx.sessionManager.getEntries()) {
		const parentId = entry.parentId === null ? null : parents.get(entry.parentId) ?? null;
		parents.set(entry.id, available.has(entry.id) ? entry.id : parentId);
		if (!available.has(entry.id)) continue;
		const label = ctx.sessionManager.getLabel(entry.id);
		labels.set(entry.id, label ? ` ${label}` : "");
		const node = { entry: { ...entry, parentId }, children: [], label: `[${selected.has(entry.id) ? "x" : " "}]${labels.get(entry.id)}` };
		nodes.set(entry.id, node);
		if (parentId === null) roots.push(node);
		else nodes.get(parentId)!.children.push(node);
	}
	const ids = await ctx.ui.custom<string[] | undefined>((tui, theme, keybindings, done) => {
		const tree = new TreeSelectorComponent(roots, branch.at(-1)?.id ?? null, tui.terminal.rows,
			id => done(selected.size ? [...selected] : [id]), () => done(undefined), undefined, focus, "all");
		const list = tree.getTreeList();
		list.onLabelEdit = undefined;
		list.onCopy = undefined;
		return {
			render(width: number) {
				const title = `Annotate messages (${selected.size} selected)`;
				const hint = "Space: toggle | Enter: use selection or highlighted message | Esc: cancel";
				return [theme.fg("accent", title.slice(0, width)), ...list.render(width),
					theme.fg("dim", hint.slice(0, width))];
			},
			invalidate() { list.invalidate(); },
			handleInput(data: string) {
				if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
				else if (keybindings.matches(data, "tui.select.confirm")) {
					const id = list.getSelectedNode()?.entry.id;
					if (id) done(selected.size ? [...selected] : [id]);
				} else if (data === " ") {
					const id = list.getSelectedNode()?.entry.id;
					if (id) {
						if (selected.has(id)) selected.delete(id);
						else selected.add(id);
						list.updateNodeLabel(id, `[${selected.has(id) ? "x" : " "}]${labels.get(id)}`);
					}
				} else {
					const navigation = ["tui.select.up", "tui.select.down", "tui.select.pageUp", "tui.select.pageDown", "app.tree.foldOrUp", "app.tree.unfoldOrDown"] as const;
					if (navigation.some(key => keybindings.matches(data, key))) list.handleInput(data);
				}
				tui.requestRender();
			},
		};
	});
	return ids && messages.filter(message => ids.includes(message.id));
}

export default function registerAnnotateCommand(pi: ExtensionAPI): void {
	let active = false;
	pi.registerCommand("annotate", {
		description: "Choose messages to annotate in .pi/last_msg.md, then paste the saved draft into Pi",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/annotate requires interactive TUI mode.", "warning");
				return;
			}
			if (active) {
				ctx.ui.notify("An annotation is already open. Finish or cancel it first.", "warning");
				return;
			}
			const count = args.trim() ? Number(args.trim()) : 0;
			if (args.trim() && (!/^\d+$/.test(args.trim()) || !Number.isSafeInteger(count) || count < 1 || count > 100)) {
				ctx.ui.notify("Usage: /annotate [N]. N preselects the last 1-100 messages.", "warning");
				return;
			}
			active = true;
			try {
				await ctx.waitForIdle();
				const path = resolve(ctx.cwd, ".pi", DRAFT_FILE);
				let state = scratchpadState(ctx, path);
				const previous = existsSync(path) ? readFileSync(path, "utf8") : undefined;
				const pending = previous !== undefined && previous !== state?.text;
				let resume = false;
				if (pending) {
					const choice = await ctx.ui.select(`Saved annotation draft: ${path}`, ["Resume saved draft", "Archive and replace", "Cancel"]);
					if (!choice || choice === "Cancel") return;
					resume = choice === "Resume saved draft";
				}
				prepareFiles(ctx.cwd);
				if (!resume) {
					const messages = ctx.sessionManager.getEntries().flatMap(entry => {
						const message = conversationMessage(entry);
						return message ? [message] : [];
					});
					if (!messages.length) {
						ctx.ui.notify("No user or assistant text found in this session.", "warning");
						return;
					}
					const branchIds = new Set(ctx.sessionManager.getBranch().map(entry => entry.id));
					const preselected = count ? messages.filter(message => branchIds.has(message.id)).slice(-count).map(message => message.id) : [];
					const selected = await pickMessages(ctx, messages, preselected);
					if (!selected?.length) return;
					if ((existsSync(path) ? readFileSync(path, "utf8") : undefined) !== previous) throw new Error("Scratchpad changed while choosing messages. Run /annotate again to resume it.");
					if (pending && previous!.trim()) logScratchpad(ctx, previous!, state?.messageIds ?? [], true);
					state = { sessionId: ctx.sessionManager.getSessionId(), path, text: buildScratchpad(selected), messageIds: selected.map(message => message.id) };
					writeFileSync(path, state.text, { encoding: "utf8", mode: 0o600 });
					pi.appendEntry(STATE_TYPE, state);
				}
				let warning = "";
				let edited: string;
				while (true) {
					const choice = await ctx.ui.select(
						`${warning}Now open ${path} in your editor.\nAdd your notes, then save the file.\nDo not close this dialog until you are done.`,
						["OK, I'm done", "Cancel"],
					);
					if (choice !== "OK, I'm done") return;
					edited = readFileSync(path, "utf8");
					if (edited.trim() && edited !== state?.text) break;
					warning = edited.trim() ? "⚠ File unchanged. Did you save it in your editor?\n" : "⚠ File is empty.\n";
				}
				prepareFiles(ctx.cwd);
				logScratchpad(ctx, edited, state?.messageIds ?? []);
				pi.appendEntry(STATE_TYPE, { sessionId: ctx.sessionManager.getSessionId(), path, text: edited, messageIds: state?.messageIds ?? [] } satisfies ScratchpadState);
				ctx.ui.setEditorText([ctx.ui.getEditorText().trimEnd(), edited].filter(Boolean).join("\n\n"));
				ctx.ui.notify(`Annotations saved to ${resolve(ctx.cwd, ".pi", LOG_FILE)}\nAdded to your input. Press Enter to send.`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not annotate: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				active = false;
			}
		},
	});
}
