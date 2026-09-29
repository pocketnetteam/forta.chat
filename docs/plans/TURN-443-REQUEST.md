# TURN over TLS on port 443 — request to the homeserver admins

> **Intended reader:** the team that runs `matrix.pocketnet.app` (Synapse config and the TURN relay account).
>
> **Goal:** calls must connect on networks where only port 443 is open (corporate Wi-Fi, some mobile carriers,
> hotel networks). Today they cannot: the homeserver hands out TURN only on port 3478.

## What the homeserver returns today

Measured 2026-09-10 from a live call (`pc.getConfiguration().iceServers` in the web client; credentials dropped).
TURN comes from Synapse's `/_matrix/client/v3/voip/turnServer`:

```
turn:relay18.expressturn.com:3478?transport=udp
turn:relay2.expressturn.com:3478?transport=tcp
```

There is no `turns:` URI and nothing on 443. On a network that blocks everything except 443, neither URI is
reachable, no relay candidate is gathered, and a call between two NATed peers fails. The relay itself works: on an
open network a call already connected through it (`srflx/relay` pair).

## The ask

Add TURN over TLS on port 443 to the URIs Synapse returns, keeping the existing ones:

```yaml
# homeserver.yaml
turn_uris:
  - "turn:<relay-host>:3478?transport=udp"
  - "turn:<relay-host>:3478?transport=tcp"
  - "turns:<relay-host>:443?transport=tcp"   # new
```

Two ways to provide `<relay-host>:443`:

1. **ExpressTURN**, if the current plan offers TURN over TLS on 443 — then only the extra URI is needed, with the
   same credentials Synapse already hands out.
2. **Own coturn** on a host where 443 is free, with a certificate valid for its name:
   ```
   tls-listening-port=443
   cert=/etc/ssl/<host>/fullchain.pem
   pkey=/etc/ssl/<host>/privkey.pem
   use-auth-secret
   static-auth-secret=<same value as Synapse turn_shared_secret>
   realm=<host>
   ```
   and in Synapse `turn_shared_secret: <that value>` instead of static `turn_username` / `turn_password`.

The `turns:` URI must name a host whose TLS certificate matches — browsers and the Android WebRTC stack reject a
mismatched certificate silently, and the call just gets no relay candidate.

## How we will check

1. `curl -H "Authorization: Bearer <token>" https://matrix.pocketnet.app/_matrix/client/v3/voip/turnServer` lists a
   `turns:…:443?transport=tcp` URI.
2. A call from a network with only 443 open (the app's call report shows `ICE result` with a `relay` pair) —
   step 3 of «Факты ICE и Tor в отчёте о звонке» in `docs/manual-verification.md`.

No client change is needed: Forta passes whatever `/voip/turnServer` returns to the peer connection.
