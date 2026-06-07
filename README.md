# Mouse — Multiplayer Whiteboard Platformer

A browser-based multiplayer game best described as **a whiteboard app meets Transformice**: players share a canvas where anyone can draw platforms in real time, and everyone's mouse avatars can physically jump and run on whatever gets drawn. The world is shaped by its players as they play.

**Live:** the game is deployed and playable — a PartyKit room (server) on PartyKit's managed platform, with the client served separately via Cloudflare Workers Static Assets. (Live URLs are intentionally not published here — ask the maintainer for a link, or follow [Deploying](#deploying) below to stand up your own instance.)

## Stack

* **Client:** HTML5 Canvas + Matter.js, TypeScript, bundled and served by PartyKit
* **Networking:** [PartyKit](https://partykit.io) (`partysocket` client, `Party.Server` server class) — runs on Cloudflare's edge
* **Physics authority:** Server-authoritative — the PartyKit room runs Matter.js; clients send inputs and render state snapshots
* **Deployment:** PartyKit managed platform (server) + Cloudflare Workers Static Assets (client)

See [gdd_partykit.md](gdd_partykit.md) for the full design doc (message protocol, physics architecture, security model, room/lobby design) and [CLAUDE.md](CLAUDE.md) / [TODO.md](TODO.md) for build history and progress tracking.

## Project layout

* [prototype/index.html](prototype/index.html) — standalone single-player prototype (no build step; open directly in a browser). Validated the core physics loop before any networking was built.
* [server/](server/) — the PartyKit project. Contains both the room logic (`src/server.ts`) and the multiplayer client (`src/client.ts`), which PartyKit bundles together and serves from `public/`.

## Running locally

From inside `server/`:

```bash
npm install
npm run dev
```

This boots the PartyKit dev server at `http://127.0.0.1:1999`. Open it in a browser, pick a name/color/room, and play. Open it in a second tab (or share the room-code URL) to test multiplayer.

> **Windows note:** if `partykit dev` crashes on startup with an `Invalid URL` error, it's a known bug in `partykit@^0.0.110` — this project's `server/package.json` pins `^0.0.115`, which works. [server/dev.cmd](server/dev.cmd) is a wrapper that puts Node.js on `PATH` for environments where `npx`/`npm` aren't globally available.

## Deploying

The project has two independently deployed pieces — the **PartyKit server** (room logic, physics) and the **client** (static HTML/JS/Canvas) — hosted on separate origins and talking to each other over WSS. This is intentional: PartyKit's managed platform doesn't support custom domains, while Cloudflare Workers does, so the client gets the friendly domain and the server keeps its fixed `.partykit.dev` endpoint.

### 1. Deploy the PartyKit server

From inside `server/`:

```bash
npx partykit deploy
```

This authenticates via GitHub on first run, then publishes **both** the room logic *and* the bundled client (per `partykit.json`'s `serve: { path: "public", build: "src/client.ts" }`, which tells PartyKit to bundle `src/client.ts` into `public/dist/` and serve all of `public/` as static assets). The deployed subdomain is controlled by `partykit.json`'s `"name"` field — ours is `"mice"`, so the server lands at:

```
https://mice.[your-partykit-username].partykit.dev
```

Tail live logs with `npx partykit tail`.

### 2. Deploy the client via Cloudflare Workers Static Assets

**Prerequisites:** a Cloudflare account and the Wrangler CLI (`npm install -g wrangler` or just use `npx wrangler`), authenticated via `npx wrangler login`.

The client doesn't need its own build step — step 1 already produced a complete, deployable bundle in `server/public/` (with the PartyKit host baked into `dist/client.js` at build time, since `declare const PARTYKIT_HOST: string` in `client.ts` is a compile-time constant that PartyKit's bundler replaces with the literal `mice.[username].partykit.dev` string). [server/wrangler.toml](server/wrangler.toml) just points straight at it:

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

This publishes the Worker and its static assets to a generated URL like `mice.[your-account].workers.dev` — because the host is baked in, this client connects cross-origin (over WSS) straight to the PartyKit room regardless of where it's served from.

### 3. (Optional) Add a custom domain

In the Cloudflare dashboard: **Workers & Pages → mice → Settings → Domains & Routes → Add Custom Domain**. Enter your domain (e.g. `mice.yourdomain.com`). If that domain is already on Cloudflare DNS, the required DNS record and SSL certificate are provisioned automatically — no manual DNS editing needed.

The client will then be served from your custom domain while its WebSocket connection still goes to the `.partykit.dev` server. These are two separate origins, and that's expected and correct — see the GDD's [Deployment section](gdd_partykit.md#deployment-getting-live) for more on why.

### 4. (Optional) Automated deploys via GitHub Actions

* **PartyKit** — generate a deploy token, add it as a GitHub Actions secret, and run `npx partykit deploy` on every push to `main`.
* **Cloudflare Workers** — add a workflow that runs `npx wrangler deploy` on every push to `main`, authenticated via a `CLOUDFLARE_API_TOKEN` secret.

### Summary

| What | Where | URL |
|---|---|---|
| PartyKit server | PartyKit managed platform | `mice.[username].partykit.dev` |
| Client (static) | Cloudflare Workers (Static Assets) | `mice.[account].workers.dev` (custom domain optional) |
