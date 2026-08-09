# Deploying the Tether backend

The backend is two services (SPEC §4):

1. **Signaling broker** — the Node/TypeScript rendezvous server (`apps/server`).
   Stateless, zero external deps, trivially horizontally scalable. Serves
   `wss://…/signal`, `GET /health`, and `GET /ice` (ICE config with ephemeral
   TURN credentials).
2. **TURN/STUN (coturn)** — relay of last resort for the ~5–15% of sessions that
   can't hole-punch. Needs a public IP and an open UDP relay-port range.

Clients need only the broker URL; they fetch STUN/TURN from `/ice`.

## Option A — single VM with docker compose (recommended)

Gets you TLS (`wss`) and TURN together. Requires a host with a public IP and a
domain pointed at it.

```bash
cp deploy/.env.example .env      # set BROKER_DOMAIN, TURN_DOMAIN, EXTERNAL_IP, TURN_SECRET
#   TURN_SECRET: openssl rand -hex 32
docker compose up -d
```

Open these on the host firewall / cloud security group:

| Port(s) | Proto | For |
|---|---|---|
| 80, 443 | TCP | Caddy (ACME + `wss` to the broker) |
| 3478 | UDP + TCP | TURN/STUN |
| 5349 | TCP | TURN over TLS (`turns:`) |
| 49160–49200 | UDP | TURN relay range (matches `turnserver.conf`) |

Verify:

```bash
curl https://$BROKER_DOMAIN/health         # {"ok":true,...}
curl https://$BROKER_DOMAIN/ice            # iceServers incl. time-limited TURN creds
```

Caddy terminates TLS and proxies the WebSocket, so clients use
`wss://$BROKER_DOMAIN/signal`.

## Option B — managed broker (Fly.io) + separate TURN VM

Fly is a clean host for the stateless broker but a poor fit for TURN (UDP relay
range). Deploy the broker with `deploy/fly.toml`, run coturn on a small VM, and
point the broker's `TURN_URIS`/`STUN_URIS` at that VM.

```bash
fly launch --no-deploy --copy-config --dockerfile Dockerfile
fly secrets set TURN_SECRET=$(openssl rand -hex 32)
fly deploy
```

## Security checklist

- **TLS everywhere.** Never ship `ws://` to clients — only `wss://` (Caddy) so
  the signaling channel isn't trivially MITM'd. (End-to-end Noise still protects
  session content, but pairing UX and relay metadata benefit from TLS.)
- **`TURN_SECRET`** is the single shared secret; keep it in `.env`/`fly secrets`,
  never in git. The broker and coturn must use the same value.
- **Gate `/ice`** behind the client's registration/session token before public
  launch (currently open) to stop anonymous TURN abuse.
- **Rotate `TURN_SECRET`** periodically; creds are already short-lived (`TURN_TTL`).
- coturn is configured to refuse relaying to RFC 1918 / loopback ranges.

## Scaling notes

- The broker keeps only in-memory presence (device id → connection). For
  multi-instance, add a shared pub/sub (e.g. Redis) so `relay`/`watch` route
  across instances, and put instances behind a sticky-less load balancer — the
  relay is connectionless per message. Single instance is fine for early use.
- coturn scales vertically first; add more TURN hosts and list several
  `TURN_URIS` when relay bandwidth becomes the bottleneck.
