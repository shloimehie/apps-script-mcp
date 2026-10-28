// Small helpers for Google OAuth and the Apps Script / Drive REST APIs.

export const GOOGLE_SCOPES = [
	"openid",
	"email",
	"https://www.googleapis.com/auth/script.projects",
	"https://www.googleapis.com/auth/script.deployments",
	"https://www.googleapis.com/auth/script.processes",
	"https://www.googleapis.com/auth/drive.metadata.readonly",
];

export const SCRIPT_API = "https://script.googleapis.com/v1";

export interface GoogleTokens {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	error?: string;
	error_description?: string;
}

export function googleAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	state: string;
	codeChallenge: string;
}): string {
	const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
	u.searchParams.set("client_id", opts.clientId);
	u.searchParams.set("redirect_uri", opts.redirectUri);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", GOOGLE_SCOPES.join(" "));
	u.searchParams.set("state", opts.state);
	u.searchParams.set("access_type", "offline"); // we need a refresh token
	u.searchParams.set("prompt", "consent"); // always return a refresh token
	u.searchParams.set("include_granted_scopes", "true");
	u.searchParams.set("code_challenge", opts.codeChallenge);
	u.searchParams.set("code_challenge_method", "S256");
	return u.toString();
}

export async function s256(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

export async function exchangeCode(opts: {
	code: string;
	verifier: string;
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}): Promise<GoogleTokens> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			code: opts.code,
			code_verifier: opts.verifier,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			redirect_uri: opts.redirectUri,
			grant_type: "authorization_code",
		}),
	});
	return (await res.json()) as GoogleTokens;
}

export async function refreshAccessToken(opts: {
	refreshToken: string;
	clientId: string;
	clientSecret: string;
}): Promise<GoogleTokens> {
	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			refresh_token: opts.refreshToken,
			client_id: opts.clientId,
			client_secret: opts.clientSecret,
			grant_type: "refresh_token",
		}),
	});
	return (await res.json()) as GoogleTokens;
}

export async function fetchUserEmail(accessToken: string): Promise<{ email: string; verified: boolean }> {
	const res = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!res.ok) throw new Error(`Could not read your Google account (${res.status}).`);
	const info = (await res.json()) as { email?: string; email_verified?: boolean };
	return { email: (info.email || "").toLowerCase(), verified: !!info.email_verified };
}

/** Turns a Google API error into a message that says what to do about it. */
export function explainGoogleError(status: number, body: string): string {
	let message = body;
	try {
		const parsed = JSON.parse(body);
		message = parsed?.error?.message || body;
	} catch {
		/* keep raw body */
	}
	if (/Apps Script API|has not enabled|usersettings/i.test(message)) {
		return (
			"The Apps Script API is switched off for this Google account. Turn it on at " +
			"https://script.google.com/home/usersettings (Google Apps Script API → On), wait a minute, and try again."
		);
	}
	if (/has not been used in project|is disabled/i.test(message)) {
		return `The Google Cloud project behind this connector doesn't have this API enabled yet. Google says: ${message}`;
	}
	if (status === 404) return `Not found. Check the Script ID (Project Settings → IDs in the script editor). Google says: ${message}`;
	if (status === 403) return `Google refused access (403). The signed-in account may not be an editor of this script. Google says: ${message}`;
	return `Google API error ${status}: ${message}`;
}

// ---------- Apps Script file helpers ----------

export type FileType = "SERVER_JS" | "HTML" | "JSON";

export interface ScriptFile {
	name: string;
	type: FileType;
	source: string;
	lastModifyUser?: unknown;
	createTime?: string;
	updateTime?: string;
	functionSet?: unknown;
}

export function displayName(f: { name: string; type: FileType }): string {
	if (f.type === "HTML") return `${f.name}.html`;
	if (f.type === "JSON") return `${f.name}.json`;
	return `${f.name}.gs`;
}

/** Splits "Code.gs" / "Index.html" / "appsscript.json" into a bare name and a type. */
export function parseFileName(input: string): { name: string; type?: FileType } {
	const trimmed = input.trim();
	const m = trimmed.match(/^(.*)\.(gs|js|html|htm|json)$/i);
	if (!m) return { name: trimmed };
	const ext = m[2].toLowerCase();
	const type: FileType = ext === "html" || ext === "htm" ? "HTML" : ext === "json" ? "JSON" : "SERVER_JS";
	return { name: m[1], type };
}

/** Finds a file by the name the user gave, tolerating extensions and letter case. */
export function findFile(files: ScriptFile[], input: string): ScriptFile {
	const { name, type } = parseFileName(input);
	const exact = files.filter((f) => f.name === name && (!type || f.type === type));
	if (exact.length === 1) return exact[0];
	const loose = files.filter((f) => f.name.toLowerCase() === name.toLowerCase() && (!type || f.type === type));
	if (loose.length === 1) return loose[0];
	const list = files.map(displayName).join(", ");
	if (exact.length + loose.length > 1) {
		throw new Error(`"${input}" matches more than one file. Add the extension (.gs or .html). Files: ${list}`);
	}
	throw new Error(`No file called "${input}" in this project. Files: ${list}`);
}

/** Only the fields updateContent accepts. */
export function toWritable(files: ScriptFile[]) {
	return files.map((f) => ({ name: f.name, type: f.type, source: f.source }));
}

export function countLines(s: string): number {
	return s.length === 0 ? 0 : s.split("\n").length;
}
