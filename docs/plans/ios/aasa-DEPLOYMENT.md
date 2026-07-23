# AASA file — deployment instructions for the web team

> **Intended reader:** the person/team who controls the web servers behind `forta.chat` and `www.forta.chat`.
>
> **Goal:** host an Apple App Site Association (AASA) JSON file at the well-known path on both hostnames. iOS uses it to decide whether `https://forta.chat/invite/...` and `https://forta.chat/join/...` should open the Forta Chat app instead of Safari.
>
> **What you need from the iOS team before deploying:** the actual Apple Team ID (10-char, e.g. `ABCD12EFGH`) — they will supply it in the cover note.

---

## What this file is

Apple's [Universal Links docs](https://developer.apple.com/documentation/xcode/supporting-associated-domains) require a JSON file at a fixed path:

```
https://<host>/.well-known/apple-app-site-association
```

When iOS decides whether to open a URL in Safari or in our app, it (silently, in the background, on app install) downloads this file and checks the `applinks.details` list. If it sees `<TEAM_ID>.com.forta.chat` paired with the path component, the URL opens the app directly.

If the file is missing, malformed, or served with the wrong headers, iOS opens the URL in Safari and we lose the deep-link UX.

---

## File contents

The template lives in `docs/plans/ios/aasa-template.json` in the Forta Chat repo:

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.com.forta.chat"],
        "components": [
          {
            "/": "/invite/*",
            "comment": "Invite links — open in app"
          },
          {
            "/": "/join/*",
            "comment": "Direct join links — open in app"
          }
        ]
      }
    ]
  }
}
```

**Before deploying:** replace `<TEAM_ID>` with the actual 10-character Apple Team ID supplied by the iOS team. The `comment` fields are allowed by Apple and are documentary; keep them.

---

## Deployment

### 1. Hosts

Deploy the same content to **both** hosts:

- `https://forta.chat/.well-known/apple-app-site-association`
- `https://www.forta.chat/.well-known/apple-app-site-association`

If one of these hostnames is a 301 redirect to the other, **the redirect breaks AASA** — Apple does not follow redirects for this file. Both hosts must serve their own copy directly.

### 2. Path

The path is exactly `.well-known/apple-app-site-association` — note:

- **No `.json` extension.** Apple's spec uses an extensionless filename.
- **Lower-case.** `Apple-App-Site-Association` will not be found by iOS.
- **`/.well-known/`** is the standard reserved well-known path (RFC 8615).

### 3. HTTP requirements

| Requirement | Value | Why |
|---|---|---|
| Protocol | HTTPS only | Apple ignores HTTP. |
| TLS cert | Valid, not self-signed | Apple's `swcd` daemon verifies. |
| Status code | `200 OK` | No redirects, no 304-only. |
| `Content-Type` | `application/json` | If served as `text/html` Apple ignores it. |
| Body | The JSON exactly as given (after `<TEAM_ID>` substitution) | Pretty-printed or minified — both are fine; just valid JSON. |
| Encoding | UTF-8 | No BOM. |

### 4. Web-server config snippets

#### Nginx

```nginx
location = /.well-known/apple-app-site-association {
    types { } default_type application/json;
    add_header Cache-Control "public, max-age=300" always;
    try_files /apple-app-site-association.json =404;
}
```

(Keep the actual file inside the document root as `apple-app-site-association.json` and let nginx remap the `Content-Type`. Or store it without the extension and use `default_type` directly.)

#### Apache (`.htaccess` in DocumentRoot)

```apache
<Files "apple-app-site-association">
    ForceType application/json
</Files>
```

#### Cloudflare Pages / Workers

Use a Worker route `^/.well-known/apple-app-site-association$` that returns the JSON with `Content-Type: application/json`. **Disable HTML/JS Auto-Minify and Rocket Loader for `/.well-known/*`** — they can rewrite or strip the file.

### 5. Cache-Control

A short cache (5–10 minutes) is fine. iOS itself caches the AASA aggressively *per device install* — once the app has been installed and Apple's `swcd` has fetched the AASA, changes only propagate after app reinstall on a given device. For active staging, expect to delete + reinstall TestFlight builds when the AASA changes.

---

## Verification

### From any machine

```bash
curl -I https://forta.chat/.well-known/apple-app-site-association
curl -I https://www.forta.chat/.well-known/apple-app-site-association
```

Required in the response:

```
HTTP/2 200
content-type: application/json
```

No `Location:` header (no redirect). No `WWW-Authenticate` header (no auth).

```bash
curl https://forta.chat/.well-known/apple-app-site-association | python -m json.tool
```

Must round-trip as valid JSON (`json.tool` will fail on syntax errors).

### From a Mac (canonical Apple test)

```bash
sudo swcutil dl -d forta.chat
sudo swcutil dl -d www.forta.chat
```

Expected output excerpt:

```
Entry:
  Domain: forta.chat
  User Approval: unspecified
  Site/Fmwk Approval: approved
  Flags:
  AppID: <TEAM_ID>.com.forta.chat
  Patterns:
    /invite/*
    /join/*
```

If `swcutil` shows `error: Could not parse server response` or `Could not validate server response with cert chain` — the file is malformed, served with the wrong content type, or behind a redirect.

### Online validator (third-party, useful for sanity)

<https://branch.io/resources/aasa-validator/> — paste `forta.chat` and run.

---

## Cover note (copy-paste; substitute `<your-name>` and `<TEAM_ID>`)

> Hi web team,
>
> The iOS port of Forta Chat needs an Apple App Site Association (AASA) file deployed at:
>
>   • `https://forta.chat/.well-known/apple-app-site-association`
>   • `https://www.forta.chat/.well-known/apple-app-site-association`
>
> Both hosts must serve the same content directly (**no redirects**) over HTTPS with `Content-Type: application/json`.
>
> The exact file content is in `docs/plans/ios/aasa-template.json` in the repo. Before deploying please replace the `<TEAM_ID>` placeholder with `<TEAM_ID>` (our actual Apple Team ID).
>
> Full deployment notes (config snippets for nginx / Apache / Cloudflare, verification commands) are in `docs/plans/ios/aasa-DEPLOYMENT.md`.
>
> Once deployed I will verify with:
>
>   • `curl -I https://forta.chat/.well-known/apple-app-site-association` → 200 + `application/json`, no redirect.
>   • `swcutil dl -d forta.chat` → reports the AASA as parsed.
>
> If you hit any of the common gotchas (Cloudflare minify rewriting the file, default `text/html` content type, 301 redirect from apex to www) — let me know and I'll point you at the fix.
>
> Thanks,
> <your-name>

---

## Common failure modes (call these out if the verification step below fails)

| Symptom | Cause | Fix |
|---|---|---|
| `curl -I` shows `Content-Type: text/html` | Web server defaults extensionless files to `text/html`. | Add the `Content-Type` rule from §4 above. |
| `curl -I` shows `301 Moved Permanently` to `www.` | Apex → www redirect catches the AASA path too. | Exclude `/.well-known/apple-app-site-association` from the redirect, or serve the file from both hosts directly. |
| File renders with extra `<html>` wrapping | Cloudflare HTML Rocket Loader / Auto-Minify is mangling it. | Add a Page Rule to bypass for `/.well-known/*`. |
| `swcutil` reports `Could not validate response` but `curl` shows 200 | TLS cert chain missing intermediate; or `Content-Type` is `application/octet-stream` etc. | Fix cert chain (`testssl.sh`); fix content type. |
| iOS app opens Safari instead of the app even after deployment | Per-device AASA cache: install happened *before* the AASA was live. | Uninstall + reinstall the app on the device. (Not a server-side bug.) |
| Universal Links work for `forta.chat` but not `www.forta.chat` | Only one of the two hosts has the AASA. | Deploy to both. |

---

## Out of scope here

- Smart App Banners (the Safari-injected "Open in App" bar) — that is a `<meta name="apple-itunes-app" content="app-id=<APP_STORE_ID>">` tag in the website HTML, not an AASA concern. Will be handed over separately when `<APP_STORE_ID>` is known.
- `webcredentials` (password autofill) — not v1.
- Other path components (e.g. `/u/...`, `/m/...`) — only `/invite/*` and `/join/*` are deep-linked in v1. Adding more requires a coordinated AASA update + JS-side `parse-invite-url.ts` change.
