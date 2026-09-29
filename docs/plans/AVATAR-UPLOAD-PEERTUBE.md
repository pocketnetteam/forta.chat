# Avatar upload through PeerTube — findings and plan (2026-09-26)

## Why avatars fail

`src/shared/lib/upload-image.ts` POSTs the avatar (base64, form-encoded) to `https://pocketnet.app:8092/up`, the
legacy Pocketnet image server. It no longer answers from any network (checked 2026-09-21, direct and via Tor), so an
avatar change never completes. Branch `fix/avatar-upload-timeout` (b1f8751a) only adds a timeout and an error message.

The returned URL is used as-is: `UserEditForm.vue` → `authStore.editUserData({ image })` (Pocketnet `userInfo`
transaction) → `sync-profile-to-matrix.ts` re-uploads the image to Matrix as the member avatar.

## What Bastyon does (pocketnet.gui master)

`js/image-uploader.js` tries **peertube → up1 → imgur** in order. The PeerTube branch (`js/functions.js`, `ajax.run`
with `peertubeImage`):

1. Picks a host through the Pocketnet node API: `peertube/roys` (`type: 'upload'`), then `peertube/best`
   (`js/satolist.js`, `preparePeertubeServer`).
2. `GET {host}/api/v1/oauth-clients/local` → `client_id`, `client_secret`.
3. `POST {host}/api/v1/users/token` with `grant_type=password` and a **shared service account** hardcoded in
   `app.js` (`app.options.peertubeCreds`) — not the user's key.
4. `POST {host}/api/v1/images/upload?type=avatar`, multipart field `imagefile`, `Authorization: Bearer <token>`.
   The response's `data.url` is the image URL (prefixed with `https://` when it lacks a scheme).

`/api/v1/images/upload` is not stock PeerTube: it comes from Pocketnet's plugin on their `bastyon-video` instances.

## Plan for Forta (not started)

1. In `upload-image.ts`, add the PeerTube path above as the first backend and keep `up1` as the fallback.
2. Host discovery through the same node RPC calls Forta's Pocketnet API client already makes for other methods
   (`peertube/roys`, `peertube/best`), or a fixed host list the Pocketnet team names.
3. Downstream stays as is: the URL goes into `editUserData({ image })` and the Matrix re-sync.

## Needs the owner / the Pocketnet team

- Whether Forta may use Bastyon's shared PeerTube service account, or should get its own account/OAuth client.
  Using another app's credentials without their say-so is not something to ship on our own.
- Which hosts serve the image plugin today, and whether the route is stable.
