# Apps Script connector (MCP)

A private connector that lets Claude read and edit Google Apps Script projects directly: read files, search code, make find/replace edits, create files, roll back, deploy web apps and check recent runs.

Runs on Cloudflare Workers. You sign in with Google; only accounts listed in `ALLOWED_EMAILS` (in `wrangler.jsonc`) can connect.

## Tools

| Tool | What it does |
|---|---|
| `list_projects` | Standalone scripts in Drive (bound scripts need their Script ID) |
| `get_project` | Title, parent file, files and line counts |
| `read_file` | Source of one file, optionally a line range |
| `search_code` | Find text across all files |
| `edit_file` | Exact find/replace edits — all-or-nothing |
| `write_file` | Create a file or replace a whole file |
| `rename_file`, `delete_file` | — |
| `create_project` | New standalone or Sheet/Doc-bound project |
| `list_snapshots`, `restore_snapshot` | Undo points saved before every change (kept 90 days) |
| `list_deployments`, `list_versions`, `deploy` | Publish a new version to an existing web app (same URL) |
| `list_executions` | Recent runs and failures |

## Setup

### 1. Google Cloud
1. In console.cloud.google.com create a project (e.g. "Apps Script Connector").
2. APIs & Services → Library: enable **Apps Script API** and **Google Drive API**.
3. Google Auth Platform → Branding/Audience: User type **Internal** (Workspace accounts only — no Google review needed).
4. Data access: add scopes `script.projects`, `script.deployments`, `script.processes`, `drive.metadata.readonly`.
5. Clients → Create client → **Web application**. Authorised redirect URI:
   `https://apps-script-mcp.sss0583202887.workers.dev/callback`
6. Copy the Client ID and Client secret.

Also turn on the Apps Script API for your user at https://script.google.com/home/usersettings.

### 2. Cloudflare
1. Storage & Databases → KV → create namespace `apps-script-mcp-kv`; paste its ID into `wrangler.jsonc` (`OAUTH_KV`).
2. Workers & Pages → Create → Import a repository → this repo. Deploy.
3. Worker → Settings → Variables and Secrets: add secrets `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### 3. Claude
Settings → Connectors → Add custom connector → URL:
`https://apps-script-mcp.sss0583202887.workers.dev/mcp`

## Notes
- Saved code is live immediately for triggers, menus and editor runs. A deployed web app only changes after `deploy`.
- Reload any open script editor tab after Claude changes a script, or saving there overwrites the change.
- Running functions isn't supported: Google only allows that for scripts linked to the same Cloud project.
