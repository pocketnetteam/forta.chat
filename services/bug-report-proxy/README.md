# Bug-report proxy

The app sends bug reports to this proxy. The proxy holds the GitHub token and creates the issues.
Before it, every build carried a GitHub token with write access, and anyone could take it from the bundle (audit S10-06).

## What it does

| Request | Body | Answer |
|---|---|---|
| `POST /v1/reports` | `{ title, body, reporter?, screenshots? }` | `201 { number, url, manageKey, screenshotsFailed, uploadError? }` |
| `POST /v1/reports/{n}/state` | `{ state: "open" \| "closed", comment?, manageKey }` | `200 { ok: true }` |

- The proxy stores each screenshot in the repository under `bug-screenshots/` and links it in the issue.
- It accepts only JPEG and PNG screenshots, at most 5, each up to 2 MB.
- `manageKey` is an HMAC of the issue number. The app gets it once, when it creates the issue. Only that device can close or reopen the issue.
- `reporter` is the SHA-256 hash of the reporter address that the app computes. Anyone with the public address list can compute it. The proxy writes a keyed hash of it into the issue, so the marker does not reveal the reporter.
- The proxy removes `@mentions` and reporter markers from the text that the app sends.
- The app removes Matrix IDs, Bastyon addresses, media links, e-mail and IP addresses before it sends the text (`src/shared/lib/bug-report/scrub-pii.ts`).
- Rate limits: 10 reports per IP in 10 minutes, 300 reports per hour in total, 30 state changes per IP in an hour. The proxy counts in memory, per Worker isolate or Node process. Add a host rate-limit rule for real protection.

## Settings

| Name | Kind | Meaning |
|---|---|---|
| `GITHUB_TOKEN` | secret | Fine-grained token for one repository: Issues read and write, Contents read and write |
| `PROXY_SECRET` | secret | Random string, 32 characters or more. A new value invalidates the manage keys and the reporter markers |
| `GITHUB_REPO` | variable | `owner/name` of the repository for the reports |
| `PUBLIC_ISSUE_LINKS` | variable | `true` returns issue links to the app. Keep `false` for a private repository |

## Deploy on Cloudflare Workers

1. Create the GitHub token: Settings → Developer settings → Fine-grained tokens. Select the reports repository only.
2. Set `GITHUB_REPO` in `wrangler.toml`.
3. Run `npx wrangler login`.
4. Run `npx wrangler secret put GITHUB_TOKEN` in this directory.
5. Run `openssl rand -hex 32 | npx wrangler secret put PROXY_SECRET`.
6. Run `npx wrangler deploy`. Note the Worker URL, or attach a domain such as `bugs.forta.chat`.
7. Add a rate-limiting rule for the route in the Cloudflare dashboard.

## Deploy on a Node host

1. Install Node 22.18 or newer. It runs TypeScript without a build step.
2. Set the four settings as environment variables. Set `PORT` too, default `8787`.
3. Run `node src/node.ts`.
4. Put a TLS reverse proxy in front. Set `TRUST_PROXY=1`, so the rate limit sees the client IP from `X-Forwarded-For`.

## Connect the app

1. In the GitHub repository of the app, add the Actions variable `BUG_REPORT_ENDPOINT` with the proxy URL. The workflows pass it to the build as `VITE_BUG_REPORT_ENDPOINT`.
2. For a local build, put `VITE_BUG_REPORT_ENDPOINT=<proxy URL>` into `.env`.
3. Release the app.
4. Revoke the old token, the secret `VITE_BUG_REPORT_TOKEN`. Every build before the proxy contains it in plain text. After revocation, those builds cannot send reports.

## Move the reports to a private repository

1. Create the private repository.
2. Give the token access to it.
3. Set `GITHUB_REPO` to it and keep `PUBLIC_ISSUE_LINKS = "false"`.
4. Screenshots link to `https://github.com/<repo>/blob/<branch>/<path>?raw=true`. They render for people with access to the repository.
5. `scripts/triage-call-reports.mjs` reads the public repository without a token. For a private one, it needs a token.

## Tests

`npx vitest run services/bug-report-proxy` from the root of the app.
`npx tsc -p services/bug-report-proxy` checks the types.
