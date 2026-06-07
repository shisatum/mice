# Multiplayer Whiteboard Platformer: PartyKit Implementation GDD (Draft)

## Concept

A browser-based multiplayer game best described as **a whiteboard app meets Transformice**: players share a canvas where anyone can draw platforms in real time, and everyone's mouse avatars can physically jump and run on whatever gets drawn. The core loop is collaborative chaos — the world is literally shaped by its players as they play.

This document is the PartyKit-specific implementation reference. For the broader architecture overview, see the master GDD.

---

## Why PartyKit

PartyKit is a deployment and hosting platform for globally distributed, stateful, on-demand web servers. It runs on Cloudflare's global edge network, putting servers within ~50ms of roughly 95% of the world's internet-connected population. Rooms are spun up on-demand — creating a new game session is as simple as using a new room ID. There is no server to provision, configure, or maintain, making it the right choice for getting multiplayer running quickly without DevOps overhead.

---

## Stack

* **Client:** HTML5 Canvas + Matter.js (physics rendering)
* **Networking:** PartyKit (`partysocket` client, `Party.Server` server class)
* **Physics Authority:** Server-authoritative — the PartyKit room runs Matter.js; clients send inputs and render state snapshots
* **Language:** TypeScript throughout (PartyKit supports it natively)
* **Deployment:** `partykit deploy` CLI; Node.js v17+ required for local development

---

## PartyKit Core Concepts (As They Apply Here)

### Rooms
Each active game session maps to one PartyKit room, identified by an arbitrary string ID (e.g. a short code or UUID). PartyKit guarantees that all connections with the same room ID are routed to the same server instance. Creating a new lobby is just using a new ID — no registration or provisioning required.

### Party.Server Lifecycle
The server class exposes four key hooks we will use:

* `onStart()` — called once when the room boots or wakes from hibernation. Use this to initialise physics world state and load any persisted platform data from storage.
* `onConnect(connection, context)` — called when a player joins. Send them the current world snapshot (all active platforms, all player positions) so they can catch up immediately.
* `onMessage(message, sender)` — called for every inbound message. This is where input processing, physics ticks, and draw-event handling live.
* `onClose(connection)` — called when a player disconnects. Remove their avatar from the simulation and broadcast the departure to remaining players.

### room.broadcast() vs connection.send()
* `this.room.broadcast(data)` — sends to all connected clients. Used for physics state updates and draw events.
* `this.room.broadcast(data, [sender.id])` — sends to everyone *except* the sender. Used for input echoes if needed.
* `connection.send(data)` — sends only to a specific client. Used in `onConnect` to deliver the world snapshot to the new joiner only.

### Storage API
`this.room.storage` is a persistent key-value store backed by Cloudflare Durable Objects storage. Use it to persist the list of drawn platforms so that a player joining mid-session or after a server hibernation event gets the correct world state. Store platforms under multiple keys (e.g. `platform:{id}`) rather than one large blob — this plays better with hibernation and the storage cache.

### Connection State
Each connection object supports `connection.setState()` for storing small per-connection metadata (max 2KB). Use this to tag each connection with the player's chosen username and avatar color, so the server can reference it without a separate lookup map.

### Connection Tags
Use `getConnectionTags()` to label connections by role if drawing permissions are role-based (e.g. tagging one connection as `"drawer"` and the rest as `"runners"`). You can then iterate `this.room.getConnections("drawer")` to target messages efficiently without waking hibernated sockets unnecessarily.

### Hibernation
PartyKit can hibernate inactive rooms to reduce memory usage. The 128MB per-room memory limit does not count active WebSocket connections under hibernation mode. For a physics game, hibernation is less relevant during active play (the server needs to be running the tick loop), but it matters for empty or between-round rooms. Key rule: **do not attach event handlers in `onConnect`** — they are lost on hibernation. Use the top-level `onMessage` and `onClose` handlers instead.

---

## Message Protocol

All messages are JSON. The server validates the shape of every inbound message before acting on it or rebroadcasting. Unknown or malformed messages are dropped silently.

### Client → Server

```json
{ "type": "input", "keys": { "left": false, "right": true, "jump": false } }
```
```json
{ "type": "draw", "points": [{ "x": 120, "y": 340 }, ...], "color": "#a3c4f3" }
```
```json
{ "type": "delete_platform", "id": "platform:abc123" }
```

### Server → Client

```json
{ "type": "snapshot", "players": [...], "platforms": [...], "tick": 4821 }
```
```json
{ "type": "player_joined", "id": "conn-guid", "username": "Mozzarella" }
```
```json
{ "type": "player_left", "id": "conn-guid" }
```
```json
{ "type": "platform_added", "id": "platform:abc123", "points": [...], "color": "#a3c4f3", "owner": "conn-guid" }
```
```json
{ "type": "platform_deleted", "id": "platform:abc123" }
```
```json
{ "type": "world_state", "players": [...], "platforms": [...] }
```
*(The `world_state` message type is sent exclusively via `connection.send()` to a new joiner on `onConnect`.)*

---

## Physics Architecture

### Server-Authoritative Model
The PartyKit room runs the Matter.js world. On each server tick (targeting ~20Hz), the server steps the simulation, then broadcasts a `snapshot` message containing every player's position and velocity. Clients render this state; they do not simulate physics independently.

### Server Tick Loop
PartyKit rooms run in a JavaScript environment that supports `setInterval`. The physics loop runs inside the room:

```ts
onStart() {
  this.engine = Matter.Engine.create();
  setInterval(() => this.tick(), 50); // 20Hz
}

tick() {
  Matter.Engine.update(this.engine, 50);
  this.room.broadcast(JSON.stringify({
    type: "snapshot",
    players: this.getPlayerStates(),
    tick: this.tickCount++
  }));
}
```

### Client-Side Dead Reckoning
Between received snapshots, clients extrapolate player positions using the last known velocity. This keeps movement feeling smooth at 20Hz server ticks. On snapshot receipt, clients reconcile their extrapolated state with the authoritative one — a small lerp prevents jarring snaps.

---

## Drawing Sync

1. Player finishes a stroke (mouse-up / touch-end).
2. Client simplifies the raw path using the **Ramer–Douglas–Peucker algorithm** to reduce point count.
3. Client sends a `draw` message with the simplified point array and a chosen color.
4. Server validates the message (see Security section), generates a unique platform ID, creates a Matter.js body from the path, and persists it via `this.room.storage.put("platform:" + id, platformData)`.
5. Server broadcasts a `platform_added` message to all clients.
6. Each client runs the same deterministic body-generation logic from the point array to render the platform cosmetically on their canvas.

Pixel art is purely cosmetic. Physics fidelity comes from the shared point array, not from syncing rendered pixels.

---

## Room & Lobby System

* Each lobby is a PartyKit room with a short shareable ID (e.g. a 6-character code).
* Room IDs are generated client-side and shared via URL (`?room=XYZABC`).
* PartyKit spins up the room instance on the first connection and tears it down after all players disconnect (subject to hibernation rules).
* Use `setAlarm` to schedule cleanup of storage after a room has been idle for a configurable period (e.g. 24 hours), preventing orphaned platform data from accumulating indefinitely.

---

## Recommended Build Order

1. **Single-player prototype** (Canvas + Matter.js in a Claude artifact): drawing → physics body → mouse avatar can jump on it. Validates the core fun before any networking.
2. **PartyKit project scaffold:** `npm create partykit@latest`. Wire up a minimal `Party.Server` with `onConnect` sending a welcome message.
3. **Server-authoritative physics loop:** room runs Matter.js tick, single client connects and renders snapshots.
4. **Player input pipeline:** client sends `input` messages, server applies forces to the player's body.
5. **Second player:** add avatar sync, `player_joined` / `player_left` messages, `world_state` on connect.
6. **Drawing sync:** full draw pipeline as described above, including storage persistence.
7. **Round and lobby logic:** win conditions, round reset, platform lifecycle (delete on reset, storage cleared).

---

## Game Design Considerations

* **Drawing permissions:** All players draw simultaneously, turn-based, or role-based (one drawer, rest run)? Role-based maps cleanly onto PartyKit connection tags.
* **Platform lifecycle:** Platforms should be deletable by their creator, or cleared on round reset. Use `this.room.storage.delete("platform:" + id)` and broadcast a `platform_deleted` message. Enforce a per-player cap on active bodies to prevent performance degradation.
* **Physics spam prevention:** Rate-limit `draw` events server-side (e.g. max one new body per player per second, max 10 active bodies per player). This is enforced in `onMessage` before the body is created.

---

## Security

### Schema Validation in onMessage
Every inbound message must be validated before processing or rebroadcasting. Drop anything that doesn't match the expected shape silently.

```ts
onMessage(message: string, sender: Party.Connection) {
  let data: unknown;
  try { data = JSON.parse(message); } catch { return; }

  if (!isValidMessage(data)) return; // strict type guard

  // only now process or broadcast
}
```

### Drawing Data: Numbers Only
Path points must be arrays of `{x, y}` pairs where each value is a finite number within canvas bounds. Reject strings, extra keys, `NaN`, `Infinity`, and out-of-bounds coordinates before the body is created or the message is rebroadcast.

### XSS via Usernames and Chat
* Usernames and any other user-supplied text must be escaped before rendering in any DOM element.
* Use `textContent` rather than `innerHTML` for all user-supplied strings in lobby and HUD UI.
* `ctx.fillText()` on the Canvas does not parse HTML and is safe, but the same string should still be length-capped and sanitized server-side before storage or broadcast.

### Room Isolation
PartyKit enforces room isolation by design — each room is a fully isolated Durable Object instance. `this.room.broadcast()` only reaches clients in the current room. There is no global broadcast mechanism to accidentally misuse.

### Rate Limiting
PartyKit provides a built-in rate limiting guide. Apply per-connection message rate limits inside `onMessage` to prevent flooding. The physics-spam mitigation (body caps) is a separate, game-logic-level limit on top of this.

### Production Checklist
* Connections are over **WSS** (TLS) by default on PartyKit's hosted platform — no extra configuration needed.
* Validate and sanitize all user text (names, colors) on the server before `storage.put()` or `broadcast()`.
* No `eval()` or dynamic code execution anywhere near user-supplied data.
* Use `onBeforeConnect` to reject connections that fail a token or origin check if the game requires authentication.

---

## Deployment: Getting Live

The project has two independently deployed pieces: the **PartyKit server** (room logic, physics) and the **client** (static HTML/JS/Canvas, bundled by PartyKit's own build step). They are hosted on separate origins and talk to each other over WSS — this is intentional: PartyKit's managed platform doesn't support custom domains, while Cloudflare Workers does, so the client gets the friendly domain and the server keeps its fixed `.partykit.dev` endpoint.

> **Cloudflare Workers with Static Assets** is the current recommended approach for static front-ends on Cloudflare — Pages was moved to maintenance mode in April 2025. Workers Static Assets is functionally equivalent for this use case and is the forward-looking choice.

**Currently live** on exactly this architecture — a `mice.[partykit-username].partykit.dev` server and a `mice.[cloudflare-account].workers.dev` client (live URLs intentionally not recorded in this doc; see CLAUDE.md). A custom domain for the client remains an optional follow-up — see Step 2 below — the game is fully playable without one.

---

### 1. Deploy the PartyKit Server

This project keeps the room logic and the client *together* in one PartyKit project (see "Where things live" — `server/src/server.ts` and `server/src/client.ts`), so there's a single project directory to deploy from. From inside `server/`:

```bash
npx partykit deploy
```

On first run this opens a browser to authenticate via GitHub. The deployed subdomain is controlled by `partykit.json`'s `"name"` field — it must be set to `"mice"` (the scaffolder's default of `"server"` would instead deploy to `server.[username].partykit.dev`, which doesn't match the GDD's expected pattern). With it correctly set, the server lands at:

```
https://mice.[your-partykit-username].partykit.dev
```

This single command publishes **both** the room logic *and* the bundled client in one step — `partykit.json`'s `serve: { path: "public", build: "src/client.ts" }` tells PartyKit to bundle `src/client.ts` into `public/dist/` (via its internal esbuild step) and serve all of `public/` as static assets alongside the room. There is no separate "build the client" command to run.

PartyKit does not natively support custom domains on its managed platform — the `.partykit.dev` URL is the fixed server endpoint, with its own per-subdomain TLS certificate provisioning (a freshly-named subdomain can take a couple of minutes to start responding — this is normal, not a failed deploy). The client connects to this URL directly; it does not need to be on the same domain.

To tail live logs after deployment:

```bash
npx partykit tail
```

---

### 2. Deploy the Client via Cloudflare Workers Static Assets

**Prerequisites:** a Cloudflare account and the Wrangler CLI, authenticated via `npx wrangler login` run in your own terminal — this caches OAuth credentials in your user profile, so subsequent `wrangler` commands (run as the same user) pick them up automatically. (Non-interactive environments need a `CLOUDFLARE_API_TOKEN` instead, but prefer the interactive login for a one-off deploy — it avoids ever having to handle a token directly.)

**The client needs no separate build step.** Step 1 already produced a complete, deployable bundle in `server/public/` — and that bundle already has the PartyKit host baked in: `declare const PARTYKIT_HOST: string` in `client.ts` is a *compile-time* constant that PartyKit's bundler replaces with the literal string `"mice.[your-partykit-username].partykit.dev"` when it builds `public/dist/client.js` (verifiable by grepping the built file for the literal hostname). So rather than standing up a redundant build pipeline, [server/wrangler.toml](server/wrangler.toml) points `[assets].directory` straight at the existing bundle:

```toml
name = "mice"
compatibility_date = "2025-01-01"

[assets]
directory = "./public"
```

Then, from inside `server/`:

```bash
npx wrangler deploy
```

This deploys the Worker and its static assets to a generated URL like `mice.[your-account].workers.dev`. Because the PartyKit host is baked into the bundle at build time, this client connects cross-origin (over WSS) straight to the PartyKit room *regardless of where it's served from* — no "point the client at the server" configuration step is needed; it's already correct by construction.

**Optional — add a custom domain:**
In the Cloudflare dashboard, go to **Workers & Pages → mice → Settings → Domains & Routes → Add Custom Domain**. Enter your domain (e.g. `mice.yourdomain.com`). If that domain is already on Cloudflare DNS, it auto-creates the required DNS record and provisions an SSL certificate automatically — no manual DNS editing needed.

The client would then be served from your custom domain while its WebSocket connection still goes to `.partykit.dev`. These are two separate origins, and that is expected and correct.

---

### 3. Automated Deploys (Optional but Recommended)

**PartyKit** — generate a deploy token and add it to GitHub Actions secrets, then add a workflow that runs `npx partykit deploy` on every push to `main`.

**Cloudflare Workers** — add a GitHub Actions workflow that runs `npx wrangler deploy` on every push to `main` (no build command needed — see above), using a `CLOUDFLARE_API_TOKEN` secret for authentication. Every push to `main` deploys a new production build.

---

### Summary

| What | Where | URL |
|---|---|---|
| PartyKit server | PartyKit managed platform | `mice.[partykit-username].partykit.dev` |
| Client (static) | Cloudflare Workers (Static Assets) | `mice.[cloudflare-account].workers.dev` (custom domain optional) |
