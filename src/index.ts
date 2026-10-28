import OAuthProvider, {
	AuthorizationError,
	CimdFetchError,
	authorizationErrorRedirect,
	type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { AppsScriptMCP, type Props } from "./mcp";
import { exchangeCode, fetchUserEmail, googleAuthorizeUrl, s256 } from "./google";

export { AppsScriptMCP };

type AuthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const esc = (s: string) =>
	s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, headers = new Headers(), status = 200) {
	headers.set("Content-Type", "text/html; charset=utf-8");
	const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 body{font-family:system-ui,-apple-system,sans-serif;background:#f4f5f7;color:#1d2433;margin:0;display:grid;place-items:center;min-height:100vh;padding:16px;box-sizing:border-box}
 .card{background:#fff;border-radius:14px;box-shadow:0 2px 14px rgba(0,0,0,.08);padding:28px;max-width:420px;width:100%}
 h1{font-size:20px;margin:0 0 12px} p{line-height:1.5;color:#4a5263}
 .row{display:flex;gap:10px;margin-top:20px} button{flex:1;padding:12px;border-radius:9px;border:0;font-size:15px;cursor:pointer}
 .ok{background:#1a73e8;color:#fff} .no{background:#e8eaef;color:#1d2433}
</style></head><body><div class="card"><h1>${esc(title)}</h1>${body}</div></body></html>`;
	return new Response(html, { status, headers });
}

function isAllowed(email: string, env: Env): boolean {
	const list = (env.ALLOWED_EMAILS || "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	if (list.length === 0) return false; // fail closed
	return list.some((rule) => (rule.startsWith("@") ? email.endsWith(rule) : email === rule));
}

function callbackUrl(env: Env) {
	return `${env.PUBLIC_URL.replace(/\/$/, "")}/callback`;
}

const authHandler = {
	async fetch(req: Request, env: AuthEnv): Promise<Response> {
		const url = new URL(req.url);
		const oauth = env.OAUTH_PROVIDER;
		try {
			// 1. Claude asks to connect → show our own approval page.
			if (url.pathname === "/authorize" && req.method === "GET") {
				const request = await oauth.parseAuthRequest(req);
				const details = await oauth.describeConsent(request);
				const consent = await oauth.beginConsent(request);
				return page(
					"Connect Apps Script?",
					`<p><strong>${esc(details.clientName || "An app")}</strong> wants to read and edit your Google Apps Script projects.</p>
<p>Access will be sent to <strong>${esc(details.redirectHost)}</strong>. Only continue if you just clicked Connect.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(consent.handle)}">
<div class="row"><button class="no" name="decision" value="deny">Cancel</button><button class="ok" name="decision" value="approve">Continue to Google</button></div></form>`,
					consent.headers,
				);
			}

			// 2. Approved → send the user to Google sign-in.
			if (url.pathname === "/authorize" && req.method === "POST") {
				const form = await req.formData();
				const handle = String(form.get("handle"));
				if (form.get("decision") !== "approve") {
					const denied = await oauth.denyConsent(req, handle);
					return new Response(null, { status: 302, headers: denied.headers });
				}
				const approved = await oauth.approveConsent(req, handle);
				const verifier = crypto.randomUUID() + crypto.randomUUID();
				const { state, headers } = await oauth.beginUpstream(approved.request, {
					data: { verifier },
					headers: approved.headers,
				});
				headers.set(
					"Location",
					googleAuthorizeUrl({
						clientId: env.GOOGLE_CLIENT_ID,
						redirectUri: callbackUrl(env),
						state,
						codeChallenge: await s256(verifier),
					}),
				);
				return new Response(null, { status: 302, headers });
			}

			// 3. Google sends the user back → check who they are and finish.
			if (url.pathname === "/callback") {
				const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
				const code = url.searchParams.get("code");
				if (url.searchParams.get("error") || !code) {
					headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
					return new Response(null, { status: 302, headers });
				}
				const tokens = await exchangeCode({
					code,
					verifier: data.verifier,
					clientId: env.GOOGLE_CLIENT_ID,
					clientSecret: env.GOOGLE_CLIENT_SECRET,
					redirectUri: callbackUrl(env),
				});
				if (!tokens.access_token) {
					return page("Google sign-in failed", `<p>${esc(tokens.error_description || tokens.error || "No access token returned.")}</p>`, headers, 400);
				}
				if (!tokens.refresh_token) {
					return page(
						"Google didn't return a refresh token",
						"<p>Remove this app at myaccount.google.com/permissions, then connect again.</p>",
						headers,
						400,
					);
				}
				const { email, verified } = await fetchUserEmail(tokens.access_token);
				if (!verified || !isAllowed(email, env)) {
					return page("Account not allowed", `<p>${esc(email || "This account")} isn't on this connector's allowed list.</p>`, headers, 403);
				}
				const props: Props = {
					email,
					accessToken: tokens.access_token,
					refreshToken: tokens.refresh_token,
					expiresAt: Date.now() + tokens.expires_in * 1000,
				};
				const { redirectTo } = await oauth.completeAuthorization({
					request,
					userId: encodeURIComponent(email),
					metadata: { email },
					scope: request.scope,
					props,
				});
				headers.set("Location", redirectTo);
				return new Response(null, { status: 302, headers });
			}

			if (url.pathname === "/") {
				return page("Apps Script connector", "<p>This is a private connector. Add <code>/mcp</code> to this address as a custom connector in Claude.</p>");
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
			if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
				const msg = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
				return page("Couldn't connect", `<p>${esc(msg)}</p><p>Go back to Claude and try connecting again.</p>`, new Headers(), 400);
			}
			throw error;
		}
	},
};

let provider: OAuthProvider<Env> | undefined;

export default {
	fetch(req: Request, env: Env, ctx: ExecutionContext) {
		provider ??= new OAuthProvider<Env>({
			apiRoute: "/mcp",
			apiHandler: AppsScriptMCP.serve("/mcp") as any,
			defaultHandler: authHandler as any,
			authorizeEndpoint: "/authorize",
			tokenEndpoint: "/token",
			clientRegistrationEndpoint: "/register",
			resourceMetadata: { resource: `${env.PUBLIC_URL.replace(/\/$/, "")}/mcp` },
			accessTokenTTL: 3600,
		});
		return provider.fetch(req, env, ctx);
	},
} satisfies ExportedHandler<Env>;
