import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
	SCRIPT_API,
	type FileType,
	type ScriptFile,
	countLines,
	displayName,
	explainGoogleError,
	findFile,
	parseFileName,
	refreshAccessToken,
	toWritable,
} from "./google";

export interface Props extends Record<string, unknown> {
	email: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number; // ms since epoch
}

const SNAPSHOT_TTL_SECONDS = 60 * 60 * 24 * 90; // keep undo points for 90 days
const MAX_OUTPUT_CHARS = 90_000;

const INSTRUCTIONS = `Edits Google Apps Script projects directly.

How to work:
1. Find the project: list_projects for standalone scripts. Scripts attached to a Sheet/Doc/Form can't be listed by Google — ask the user for the Script ID (script editor → Project Settings → IDs).
2. Look before changing: get_project, then read_file or search_code.
3. Prefer edit_file with small find/replace edits over rewriting whole files. Use write_file for new files or full rewrites.
4. Every change saves an undo point first; restore_snapshot rolls back.
5. Saved code is live straight away for triggers, custom menus and functions run from the editor. A deployed web app or add-on only changes after deploy — ask the user before deploying.
6. After changing a script, remind the user to reload any open script editor tab, or saving there will overwrite your change.
7. Use list_executions to check whether runs or triggers are failing.`;

function text(t: string) {
	const out = t.length > MAX_OUTPUT_CHARS ? `${t.slice(0, MAX_OUTPUT_CHARS)}\n\n… (output cut at ${MAX_OUTPUT_CHARS} characters — read a smaller line range)` : t;
	return { content: [{ type: "text" as const, text: out }] };
}

function fail(e: unknown) {
	return { content: [{ type: "text" as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
}

/** Wraps a tool body so thrown errors come back as readable tool errors. */
function safe<A>(fn: (args: A) => Promise<ReturnType<typeof text>>) {
	return async (args: A) => {
		try {
			return await fn(args);
		} catch (e) {
			return fail(e);
		}
	};
}

const scriptId = z.string().min(10).describe("Script ID (script editor → Project Settings → IDs).");

export class AppsScriptMCP extends McpAgent<Env, Record<string, never>, Props> {
	server = new McpServer({ name: "Apps Script", version: "1.0.0" }, { instructions: INSTRUCTIONS });

	private token?: { value: string; expiresAt: number };

	// ---------- Google plumbing ----------

	private async accessToken(force = false): Promise<string> {
		const props = this.props!;
		if (!force) {
			if (this.token && this.token.expiresAt - Date.now() > 60_000) return this.token.value;
			if (!this.token && props.expiresAt - Date.now() > 60_000) {
				this.token = { value: props.accessToken, expiresAt: props.expiresAt };
				return props.accessToken;
			}
		}
		const fresh = await refreshAccessToken({
			refreshToken: props.refreshToken,
			clientId: this.env.GOOGLE_CLIENT_ID,
			clientSecret: this.env.GOOGLE_CLIENT_SECRET,
		});
		if (!fresh.access_token) {
			throw new Error(
				fresh.error === "invalid_grant"
					? "Google access has expired or was revoked. Disconnect and reconnect the Apps Script connector in Claude's settings."
					: `Couldn't refresh Google access: ${fresh.error_description || fresh.error || "unknown error"}`,
			);
		}
		this.token = { value: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000 };
		return fresh.access_token;
	}

	private async google<T = any>(url: string, init: RequestInit = {}): Promise<T> {
		const call = async (token: string) =>
			fetch(url, {
				...init,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
			});
		let res = await call(await this.accessToken());
		if (res.status === 401) res = await call(await this.accessToken(true));
		const body = await res.text();
		if (!res.ok) throw new Error(explainGoogleError(res.status, body));
		return (body ? JSON.parse(body) : {}) as T;
	}

	private async getFiles(id: string): Promise<ScriptFile[]> {
		const data = await this.google<{ files?: ScriptFile[] }>(`${SCRIPT_API}/projects/${id}/content`);
		return data.files || [];
	}

	private async takeSnapshot(id: string, files: ScriptFile[], note: string): Promise<string> {
		const snapId = new Date().toISOString();
		await this.env.OAUTH_KV.put(
			`snapshot:${id}:${snapId}`,
			JSON.stringify({ note, by: this.props!.email, files: toWritable(files) }),
			{ expirationTtl: SNAPSHOT_TTL_SECONDS, metadata: { note } },
		);
		return snapId;
	}

	/** Saves an undo point, then replaces the project's content. */
	private async saveFiles(id: string, before: ScriptFile[], after: ScriptFile[], note: string) {
		const snapId = await this.takeSnapshot(id, before, note);
		try {
			await this.google(`${SCRIPT_API}/projects/${id}/content`, {
				method: "PUT",
				body: JSON.stringify({ files: toWritable(after) }),
			});
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			throw new Error(`Nothing was changed — Google rejected the update. ${msg}`);
		}
		return snapId;
	}

	// ---------- tools ----------

	async init() {
		this.server.registerTool(
			"list_projects",
			{
				description:
					"List standalone Apps Script projects the user can access in Drive, newest first. Scripts bound to a Sheet/Doc/Form don't appear here; ask the user for their Script ID.",
				inputSchema: { search: z.string().optional().describe("Filter by words in the project name.") },
				annotations: { readOnlyHint: true },
			},
			safe(async ({ search }) => {
				let q = "mimeType='application/vnd.google-apps.script' and trashed=false";
				if (search) q += ` and name contains '${search.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
				const u = new URL("https://www.googleapis.com/drive/v3/files");
				u.searchParams.set("q", q);
				u.searchParams.set("orderBy", "modifiedTime desc");
				u.searchParams.set("pageSize", "50");
				u.searchParams.set("fields", "files(id,name,modifiedTime,owners(emailAddress))");
				u.searchParams.set("supportsAllDrives", "true");
				u.searchParams.set("includeItemsFromAllDrives", "true");
				const data = await this.google<{ files?: any[] }>(u.toString());
				const rows = (data.files || []).map(
					(f) => `${f.name} — ${f.id} (modified ${f.modifiedTime?.slice(0, 10)}, owner ${f.owners?.[0]?.emailAddress || "?"})`,
				);
				return text(rows.length ? rows.join("\n") : "No standalone scripts found. For a script attached to a Sheet/Doc, ask the user for its Script ID.");
			}),
		);

		this.server.registerTool(
			"get_project",
			{
				description: "Show a project's title, the file it's attached to, and its files with line counts.",
				inputSchema: { scriptId },
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id }) => {
				const [meta, files] = await Promise.all([this.google<any>(`${SCRIPT_API}/projects/${id}`), this.getFiles(id)]);
				const lines = [
					`Title: ${meta.title}`,
					`Script ID: ${id}`,
					meta.parentId ? `Attached to file: ${meta.parentId}` : "Standalone script",
					`Last updated: ${meta.updateTime}`,
					"",
					"Files:",
					...files.map((f) => `- ${displayName(f)} (${countLines(f.source)} lines)`),
				];
				return text(lines.join("\n"));
			}),
		);

		this.server.registerTool(
			"read_file",
			{
				description: "Read a file's source. For long files, pass a line range. Lines are numbered for reference only — never include the numbers in edits.",
				inputSchema: {
					scriptId,
					file: z.string().describe('File name, e.g. "Code.gs", "Index.html" or "appsscript.json".'),
					startLine: z.number().int().min(1).optional(),
					endLine: z.number().int().min(1).optional(),
				},
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id, file, startLine, endLine }) => {
				const f = findFile(await this.getFiles(id), file);
				const all = f.source.split("\n");
				const from = Math.max(1, startLine || 1);
				const to = Math.min(all.length, endLine || all.length);
				const width = String(to).length;
				const body = all
					.slice(from - 1, to)
					.map((l, i) => `${String(from + i).padStart(width)}| ${l}`)
					.join("\n");
				return text(`${displayName(f)} — lines ${from}-${to} of ${all.length}\n${body}`);
			}),
		);

		this.server.registerTool(
			"search_code",
			{
				description: "Search every file in a project for text (or a regular expression) and return matching lines with line numbers.",
				inputSchema: {
					scriptId,
					query: z.string().min(1),
					regex: z.boolean().optional().describe("Treat query as a regular expression."),
					caseSensitive: z.boolean().optional(),
				},
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id, query, regex, caseSensitive }) => {
				const files = await this.getFiles(id);
				const pattern = regex
					? new RegExp(query, caseSensitive ? "" : "i")
					: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
				const hits: string[] = [];
				for (const f of files) {
					f.source.split("\n").forEach((line, i) => {
						if (hits.length < 200 && pattern.test(line)) hits.push(`${displayName(f)}:${i + 1}: ${line.trim().slice(0, 200)}`);
					});
				}
				return text(hits.length ? hits.join("\n") + (hits.length === 200 ? "\n… (first 200 matches)" : "") : "No matches.");
			}),
		);

		this.server.registerTool(
			"edit_file",
			{
				description:
					"Change part of a file with exact find/replace edits, applied in order. Each `find` must appear exactly once (copy it exactly, with indentation, and include enough surrounding lines to be unique) unless replaceAll is true. Saves an undo point first. Nothing is saved if any edit fails.",
				inputSchema: {
					scriptId,
					file: z.string(),
					edits: z
						.array(
							z.object({
								find: z.string().min(1),
								replace: z.string(),
								replaceAll: z.boolean().optional(),
							}),
						)
						.min(1),
					note: z.string().optional().describe("Short description of the change, kept with the undo point."),
				},
				annotations: { destructiveHint: false },
			},
			safe(async ({ scriptId: id, file, edits, note }) => {
				const files = await this.getFiles(id);
				const target = findFile(files, file);
				let source = target.source;
				edits.forEach((e, i) => {
					const count = source.split(e.find).length - 1;
					if (count === 0) {
						throw new Error(`Edit ${i + 1}: the text to find isn't in ${displayName(target)} (it may have changed — read the file again). Nothing was saved.`);
					}
					if (count > 1 && !e.replaceAll) {
						throw new Error(`Edit ${i + 1}: the text appears ${count} times in ${displayName(target)}. Include more surrounding lines, or set replaceAll. Nothing was saved.`);
					}
					source = e.replaceAll ? source.split(e.find).join(e.replace) : source.replace(e.find, () => e.replace);
				});
				if (source === target.source) return text("No change — the file already matches.");
				const after = files.map((f) => (f === target ? { ...f, source } : f));
				const snap = await this.saveFiles(id, files, after, note || `edit ${displayName(target)}`);
				return text(
					`Saved ${edits.length} edit(s) to ${displayName(target)} (${countLines(target.source)} → ${countLines(source)} lines). Undo point: ${snap}.`,
				);
			}),
		);

		this.server.registerTool(
			"write_file",
			{
				description:
					"Create a new file, or replace a whole file's source. Use edit_file instead for small changes. Use .gs for script, .html for HTML, appsscript.json for the manifest.",
				inputSchema: {
					scriptId,
					file: z.string().describe('e.g. "Helpers.gs", "Sidebar.html", "appsscript.json"'),
					source: z.string(),
					note: z.string().optional(),
				},
			},
			safe(async ({ scriptId: id, file, source, note }) => {
				const files = await this.getFiles(id);
				const { name, type } = parseFileName(file);
				let existing: ScriptFile | undefined;
				try {
					existing = findFile(files, file);
				} catch {
					existing = undefined;
				}
				const newType: FileType = existing?.type || type || (name === "appsscript" ? "JSON" : "SERVER_JS");
				const after = existing
					? files.map((f) => (f === existing ? { ...f, source } : f))
					: [...files, { name, type: newType, source }];
				const label = displayName({ name: existing?.name || name, type: newType });
				const snap = await this.saveFiles(id, files, after, note || `${existing ? "rewrite" : "create"} ${label}`);
				return text(`${existing ? "Replaced" : "Created"} ${label} (${countLines(source)} lines). Undo point: ${snap}.`);
			}),
		);

		this.server.registerTool(
			"rename_file",
			{
				description: "Rename a file in a project. Saves an undo point first.",
				inputSchema: { scriptId, file: z.string(), newName: z.string().describe("New name, without extension.") },
			},
			safe(async ({ scriptId: id, file, newName }) => {
				const files = await this.getFiles(id);
				const target = findFile(files, file);
				const bare = parseFileName(newName).name;
				if (target.name === "appsscript") throw new Error("The manifest (appsscript.json) can't be renamed.");
				if (files.some((f) => f !== target && f.name === bare && f.type === target.type)) throw new Error(`A file called ${bare} already exists.`);
				const after = files.map((f) => (f === target ? { ...f, name: bare } : f));
				const snap = await this.saveFiles(id, files, after, `rename ${displayName(target)} → ${bare}`);
				return text(`Renamed ${displayName(target)} to ${displayName({ name: bare, type: target.type })}. Undo point: ${snap}.`);
			}),
		);

		this.server.registerTool(
			"delete_file",
			{
				description: "Delete a file from a project. Confirm with the user first. Saves an undo point first.",
				inputSchema: { scriptId, file: z.string() },
				annotations: { destructiveHint: true },
			},
			safe(async ({ scriptId: id, file }) => {
				const files = await this.getFiles(id);
				const target = findFile(files, file);
				if (target.name === "appsscript") throw new Error("The manifest (appsscript.json) can't be deleted.");
				const snap = await this.saveFiles(id, files, files.filter((f) => f !== target), `delete ${displayName(target)}`);
				return text(`Deleted ${displayName(target)}. Undo point: ${snap}.`);
			}),
		);

		this.server.registerTool(
			"create_project",
			{
				description: "Create a new Apps Script project — standalone, or attached to a Google Sheet/Doc/Form/Slides file by passing its file ID.",
				inputSchema: {
					title: z.string(),
					parentFileId: z.string().optional().describe("ID of the Sheet/Doc/Form/Slides to attach the script to (from its URL)."),
				},
			},
			safe(async ({ title, parentFileId }) => {
				const p = await this.google<any>(`${SCRIPT_API}/projects`, {
					method: "POST",
					body: JSON.stringify(parentFileId ? { title, parentId: parentFileId } : { title }),
				});
				return text(`Created "${p.title}". Script ID: ${p.scriptId}. Open: https://script.google.com/d/${p.scriptId}/edit`);
			}),
		);

		this.server.registerTool(
			"list_snapshots",
			{
				description: "List the undo points this connector saved before each change to a project, newest first.",
				inputSchema: { scriptId },
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id }) => {
				const list = await this.env.OAUTH_KV.list<{ note?: string }>({ prefix: `snapshot:${id}:` });
				const rows = list.keys
					.map((k) => ({ id: k.name.slice(`snapshot:${id}:`.length), note: k.metadata?.note || "" }))
					.sort((a, b) => b.id.localeCompare(a.id))
					.slice(0, 30)
					.map((s) => `${s.id} — before: ${s.note}`);
				return text(rows.length ? rows.join("\n") : "No undo points for this project yet.");
			}),
		);

		this.server.registerTool(
			"restore_snapshot",
			{
				description: "Roll a project back to an undo point from list_snapshots. The current state is saved as a new undo point first, so this can itself be undone.",
				inputSchema: { scriptId, snapshotId: z.string() },
			},
			safe(async ({ scriptId: id, snapshotId }) => {
				const raw = await this.env.OAUTH_KV.get(`snapshot:${id}:${snapshotId}`);
				if (!raw) throw new Error("That undo point doesn't exist (or has expired). Use list_snapshots.");
				const snap = JSON.parse(raw) as { files: ScriptFile[]; note: string };
				const current = await this.getFiles(id);
				const newSnap = await this.saveFiles(id, current, snap.files, `restore to ${snapshotId}`);
				return text(`Restored the project to how it was before "${snap.note}". The previous state is kept as undo point ${newSnap}.`);
			}),
		);

		this.server.registerTool(
			"list_deployments",
			{
				description: "List a project's deployments (web app, API executable, add-on) with the version each one serves.",
				inputSchema: { scriptId },
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id }) => {
				const data = await this.google<{ deployments?: any[] }>(`${SCRIPT_API}/projects/${id}/deployments`);
				const rows = (data.deployments || []).map((d) => {
					const v = d.deploymentConfig?.versionNumber;
					const web = d.entryPoints?.find((e: any) => e.entryPointType === "WEB_APP")?.webApp?.url;
					return `${d.deploymentId} — ${v ? `version ${v}` : "HEAD (latest code, test only)"} — ${d.deploymentConfig?.description || "no description"}${web ? ` — ${web}` : ""}`;
				});
				return text(rows.length ? rows.join("\n") : "No deployments.");
			}),
		);

		this.server.registerTool(
			"list_versions",
			{
				description: "List a project's saved versions.",
				inputSchema: { scriptId },
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id }) => {
				const data = await this.google<{ versions?: any[] }>(`${SCRIPT_API}/projects/${id}/versions?pageSize=50`);
				const rows = (data.versions || [])
					.sort((a, b) => b.versionNumber - a.versionNumber)
					.map((v) => `v${v.versionNumber} — ${v.createTime?.slice(0, 16).replace("T", " ")} — ${v.description || ""}`);
				return text(rows.length ? rows.join("\n") : "No versions yet.");
			}),
		);

		this.server.registerTool(
			"deploy",
			{
				description:
					"Publish the current code: creates a new version and points an existing deployment (e.g. the live web app, same URL) at it. Ask the user before calling. If the project has several deployments, pass deploymentId. Set createNew only to make a brand-new deployment (it gets a new URL).",
				inputSchema: {
					scriptId,
					description: z.string().describe("What changed, shown in the version history."),
					deploymentId: z.string().optional(),
					createNew: z.boolean().optional(),
				},
			},
			safe(async ({ scriptId: id, description, deploymentId, createNew }) => {
				const list = await this.google<{ deployments?: any[] }>(`${SCRIPT_API}/projects/${id}/deployments`);
				const versioned = (list.deployments || []).filter((d) => d.deploymentConfig?.versionNumber);
				let target: any;
				if (!createNew) {
					if (deploymentId) {
						target = versioned.find((d) => d.deploymentId === deploymentId);
						if (!target) throw new Error("That deployment ID isn't one of this project's versioned deployments. Use list_deployments.");
					} else if (versioned.length === 1) {
						target = versioned[0];
					} else if (versioned.length > 1) {
						throw new Error("This project has several deployments — say which one with deploymentId (see list_deployments). Nothing was published.");
					} else {
						throw new Error("This project has no deployment to update. Set createNew to make one (it gets a new URL). Nothing was published.");
					}
				}
				const version = await this.google<any>(`${SCRIPT_API}/projects/${id}/versions`, {
					method: "POST",
					body: JSON.stringify({ description }),
				});
				const config = { scriptId: id, versionNumber: version.versionNumber, manifestFileName: "appsscript", description };
				const dep = target
					? await this.google<any>(`${SCRIPT_API}/projects/${id}/deployments/${target.deploymentId}`, {
							method: "PUT",
							body: JSON.stringify({ deploymentConfig: config }),
						})
					: await this.google<any>(`${SCRIPT_API}/projects/${id}/deployments`, { method: "POST", body: JSON.stringify(config) });
				const web = dep.entryPoints?.find((e: any) => e.entryPointType === "WEB_APP")?.webApp?.url;
				return text(
					`Published version ${version.versionNumber} to deployment ${dep.deploymentId}${target ? " (same URL as before)" : " (new deployment)"}.${web ? ` Web app: ${web}` : ""}`,
				);
			}),
		);

		this.server.registerTool(
			"list_executions",
			{
				description: "Show recent runs of a project (manual, trigger, web app) with status and duration — use to check whether something is failing.",
				inputSchema: {
					scriptId,
					functionName: z.string().optional(),
					failedOnly: z.boolean().optional(),
					limit: z.number().int().min(1).max(100).optional(),
				},
				annotations: { readOnlyHint: true },
			},
			safe(async ({ scriptId: id, functionName, failedOnly, limit }) => {
				const u = new URL(`${SCRIPT_API}/processes:listScriptProcesses`);
				u.searchParams.set("scriptId", id);
				u.searchParams.set("pageSize", String(limit || 25));
				if (functionName) u.searchParams.set("scriptProcessFilter.functionName", functionName);
				if (failedOnly) {
					for (const s of ["FAILED", "TIMED_OUT"]) u.searchParams.append("scriptProcessFilter.statuses", s);
				}
				const data = await this.google<{ processes?: any[] }>(u.toString());
				const rows = (data.processes || []).map(
					(p) =>
						`${p.startTime?.slice(0, 19).replace("T", " ")} UTC — ${p.functionName || "?"} — ${p.processStatus} — ${p.processType} — ${p.duration || "?"}`,
				);
				return text(
					rows.length
						? `${rows.join("\n")}\n\n(Log messages aren't available through Google's API — see Executions in the script editor for details.)`
						: "No runs found.",
				);
			}),
		);
	}
}
