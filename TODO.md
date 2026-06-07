# Build Checklist

Chronological checklist mirroring the GDD's "Recommended Build Order" ([gdd_partykit.md](gdd_partykit.md)).

**How to use this file:**
- Check it at the start of every session to see where things stand.
- Check items off (`[x]`) as you complete them.
- Phases are expanded into sub-tasks only once you start them — expand the next phase's checkbox into concrete sub-tasks when you begin it, since detailed planning too far ahead tends to drift from reality.

---

## Phase 1 — Single-player prototype

> Canvas + Matter.js, no networking. Validates the core fun: drawing → physics body → mouse avatar can jump on it.

- [x] Set up `prototype/index.html` — single self-contained file, Matter.js via CDN (`matter-js@0.20.0`), no build step
- [x] Drawing capture: mousedown/mousemove/mouseup → freehand path as `{x, y}[]`
- [x] Path → physics body: chain of thin static rectangle segments along the drawn path
- [x] Avatar body: circle with locked rotation (`inertia: Infinity`) so it slides instead of rolling
- [x] Controls: arrow keys / WASD → horizontal velocity + one-shot jump velocity
- [x] Ground detection: `collisionStart`/`collisionEnd` → `groundContacts` counter → `grounded` flag (gates jumping)
- [x] Render loop: custom `requestAnimationFrame`, draw platforms from their point arrays + avatar as a circle (not `Matter.Render`)
- [x] Manually verify: draw platforms of various shapes, confirm avatar runs/jumps on them without falling through or infinite-air-jumping

> **Verified** (via automated browser testing — drawing simulated mouse paths, sampling physics state every frame): the avatar climbs hand-drawn slopes, stands on elevated drawn platforms, falls off edges, and jumps with a clean ~167px arc. `grounded` correctly gates jumping (no infinite air-jumps).
>
> **Bug found & fixed during verification:** the initial `isSupportingContact` check only tested whether the contact normal was vertical, not which side the platform was on — so bumping your head on a platform's underside mid-jump could be miscounted as "landing," refreshing the jump at the worst moment. Fixed by checking the normal's sign relative to which body is the player (Matter 0.20's SAT normal is not a simple "bodyA → bodyB" center-to-center vector — the correct sign convention was derived empirically and is documented inline in `isSupportingContact`).

## Phase 2 — PartyKit project scaffold

- [x] `npm create partykit@latest` — scaffolded TypeScript project into [server/](server/) (kept separate from [prototype/](prototype/) since the GDD deploys server and client independently; removed the nested `.git` it auto-created since the parent project isn't a repo yet)
- [x] Wire up a minimal `Party.Server` with `onConnect` sending a personalized welcome message (`Welcome to room "<roomId>", you are <connectionId>`) — see [server/src/server.ts](server/src/server.ts)
- [x] Run and verify locally: `npm run dev` (via `partykit dev --live`) starts a room on `http://127.0.0.1:1999`; a raw WebSocket test client connecting to `/parties/main/<room>` receives the welcome message correctly

> **Verified** by connecting a throwaway `ws` test client directly to the local dev server's room endpoint and confirming receipt of `Welcome to room "test-room-123", you are <connection-id>`.
>
> **Bug found & fixed during setup:** the scaffolder's pinned `partykit@^0.0.110` crashes on Windows at startup (`TypeError: Invalid URL` — `fileURLToPath` choking on a malformed `.\file:\D:\...\generated.js` path string, a Windows-path bug in that version's build step). Fixed by upgrading the project's `partykit` devDependency to `^0.0.115`, which starts cleanly.

## Phase 3 — Server-authoritative physics loop

- [x] Port a minimal physics setup (engine, gravity, static ground) into [server/src/server.ts](server/src/server.ts), running on a `setInterval` tick at ~20Hz
- [x] `onStart`: create the Matter.js engine/world + ground; `onConnect`: add a player body to the world (mirroring the prototype's circle avatar with locked rotation); `onClose`: remove it
- [x] Broadcast `snapshot` messages (`{ type: "snapshot", players: [{id,x,y,vx,vy}], tick }`) each tick via `this.room.broadcast`
- [x] Build a minimal client ([server/src/client.ts](server/src/client.ts) + canvas in `public/index.html`) that connects, receives snapshots, and renders player position(s) — no input/controls yet, purely observing server-driven movement

> **Verified** by sampling 120 snapshot broadcasts via a temporary `window.__debug` hook (same pattern as Phase 1): the player spawned at `y≈251.66` falling (`vy≈0.83`), and within ~30 ticks settled at `y≈844.36` with `vy=0` — exactly the calculated resting position on the ground (ground top at `y=860`, minus the player's 16px radius). 120 samples spanning ticks 2682–2801 confirmed a steady ~20Hz broadcast. Confirmed server-authoritative (not a static render) since the position genuinely changes tick-over-tick driven purely by the room's Matter.js simulation. Debug hook fully removed afterward (verified via Grep — 0 matches for `__debug|TEMP DEBUG`).
>
> **Bug found & fixed during setup:** the GDD's own example code calls `Matter.Engine.update(engine, 50)` directly at the 20Hz tick rate, but Matter.js warns that delta arguments above ~16.667ms risk instability/tunneling through thin bodies (which matters a lot once Phase 6 introduces thin drawn-platform segments). Fixed by sub-stepping the engine at a fixed ~60Hz internally (3 sub-steps of `1000/60`ms per 50ms tick) while still broadcasting snapshots at 20Hz — confirmed the warning no longer appears on a clean server run.
>
> Added a `server-dev` entry to [.claude/launch.json](.claude/launch.json) (backed by `server/dev.cmd`, since the Node.js install directory isn't on the preview tool's spawn `PATH` — the wrapper script prepends it) so the PartyKit dev server can be driven through the browser-preview tooling like the prototype.

## Phase 4 — Player input pipeline

- [x] Client sends `input` messages (`{ left, right, jump }`); server applies them to the player's body
- [x] Server tracks per-connection key state (`{ left, right, jump }`) and applies the same movement logic the prototype used (direct velocity, one-shot gated jump) to that connection's body each tick — see `applyInput` in [server/src/server.ts](server/src/server.ts)
- [x] Client adds keyboard capture (arrow keys / WASD, up/W/Space to jump) and sends `input` messages on change — render loop stays snapshot-driven (no client-side prediction yet); added an on-screen control hint
- [x] Manually verify: moving/jumping the local player is visible in the canvas, server-authoritatively, with correct ground-gating (reusing the prototype's empirically-derived `isSupportingContact` sign convention)

> **Verified** end-to-end via a temporary `window.__debug` hook sampling snapshot broadcasts while programmatically driving `setKey`:
> - **Horizontal movement**: resting `{x:800, vx:0}` → after holding right ~1s, `{x:1082.2, vx:4.26}` (accelerating toward `MOVE_SPEED=5` under `frictionAir`) → on release, `{x:1082.2, vx:0}`. Proves the full round trip: keypress → `input` message → server validation → per-connection key state → `applyInput` → `Matter.Body.setVelocity` → physics → broadcast → client render.
> - **Jump + mid-air gating**: grounded `{vy:0, y:844.36}` → jump impulse peaks at `vy≈-9.85` (≈ `-JUMP_SPEED=11` reduced by one tick of gravity/sub-stepping before the snapshot is taken) → rises and decelerates under gravity (`vy:-5.57` → `vy:-0.91` near apex) → a second jump press while still airborne produced **no** fresh `-11` impulse (correctly gated, continued its existing arc) → lands back at `{vy:0, y:844.36}`.
> - **Re-arming after landing**: immediately after landing, a fresh jump press peaked at `vy≈-9.85` again — identical to the first jump — proving `groundContacts`/`jumpHeld` correctly re-arm the one-shot jump once grounded again.
>
> Debug hook fully removed afterward (verified via Grep — 0 matches for `__debug|TEMP DEBUG`).
>
> **False alarm caught during verification:** an early test run showed the player frozen mid-test (`landed`/`secondJump`/`landedAgain` samples all identical, ticks barely advancing despite seconds of elapsed time). Root cause was the *test harness*, not the game: the `dbg.samples` ring buffer was capped at 400 entries and had filled up across back-to-back `preview_eval` runs, so `latestFor` kept returning the last-recorded (stale) sample instead of fresh data. Re-running with `dbg.samples.length = 0` resets between phases produced clean, consistent results — no bug in `applyInput`/ground-detection.

## Phase 5 — Second player / multiplayer sync

- [x] Broadcast `player_joined` / `player_left` messages when connections open/close
- [x] Send a `world_state` message to new joiners on `onConnect` (existing players' positions, ids, and any platforms placed so far) so they don't see a blank world
- [x] Confirm avatar sync across multiple simultaneous clients: open two browser sessions, move each independently, verify each sees the other's avatar moving server-authoritatively in real time
- [x] Manually verify: a third late-joining client receives `world_state` and immediately renders the other two players already in motion, with no flicker/teleport on join

> **Verified** end-to-end via a temporary `window.__debug` hook plus throwaway raw-`WebSocket` connections opened to the same room (mirrors the approach used to verify Phase 2's welcome message — simulates extra players without needing multiple browser windows):
> - **Identity**: each connection is assigned a placeholder cheese-themed username server-side ([server/src/server.ts](server/src/server.ts) `pickUsername`, e.g. `"Stilton"`, `"Mozzarella"`, `"Provolone"` — matches the GDD's own `"Mozzarella"` example) and stored in `PlayerState.username`. `player_joined` is broadcast to *everyone including the joiner* (not excluded), since `world_state` only describes pre-existing players — this is how a joiner learns its own assigned name.
> - **`world_state` on join**: a 2nd client joining received `world_state` with the 1st client's live position (already settled at `y:844.36`, resting on the ground). A 3rd client joining moments later received `world_state` listing *both* — including the 2nd client still mid-fall at `y:294.91` (not yet landed) — proving late joiners see everyone's **current live position**, not a stale or teleported one. No flicker on join.
> - **Roster sync**: the 1st client's roster correctly accumulated all three usernames as `player_joined` broadcasts arrived (`Stilton`, `Mozzarella`, `Provolone`), and correctly dropped an entry when that connection closed (`player_left` received, roster and the snapshot's `players` array both pruned it).
> - **Visual rendering**: [server/src/client.ts](server/src/client.ts) renders each avatar with its username label above it, and visually distinguishes the local player (green fill + `"(you)"` suffix) from others (yellow fill) — confirmed via screenshot showing three simultaneously-rendered, independently-moving avatars with labels.
>
> Debug hook fully removed afterward (verified via Grep — 0 matches for `__debug|TEMP DEBUG`).

## Phase 6 — Drawing sync

- [x] Client: drawing capture (mousedown/mousemove/mouseup → `{x,y}[]` path, scaled from CSS viewport coords into the fixed world buffer via `canvasPoint`) + Ramer-Douglas-Peucker simplification (`rdpSimplify`, `RDP_EPSILON=2`) + a small preset color palette UI, sent as `{ type: "draw", points, color }` on stroke completion
- [x] Server: validates `draw` messages per the GDD's "Numbers Only" security guidance (`isValidDraw`/`isValidPoint` — rejects non-finite numbers, out-of-bounds coordinates, extra keys, bad color format, too-few/too-many points), enforces physics-spam limits (`DRAW_COOLDOWN_MS=1000`, `MAX_PLATFORMS_PER_PLAYER=10`), builds deterministic chain-of-thin-rectangles bodies (`createPlatformBodies`, ported from the prototype's `pointsToBodies`), persists to `this.room.storage` under `platform:{id}` keys, and restores them in `onStart` (awaited before the first `onConnect`, per PartyKit's lifecycle guarantee) — see [server/src/server.ts](server/src/server.ts)
- [x] Server broadcasts `platform_added` to *everyone including the drawer* (`{ type: "platform_added", id, points, color, owner }`) — same "no special-cased local preview" pattern as Phase 5's `player_joined`; `world_state` now also includes existing platforms for late joiners
- [x] Client renders platforms by regenerating cosmetic geometry purely from synced point arrays (`drawPlatformPath`/`drawPlatforms`, stroked with `lineWidth=PLATFORM_THICKNESS`, round caps/joins — mirrors the prototype's `drawPlatform`), plus a live in-progress-stroke preview in the locally-selected color (`drawInProgressPath`) — see [server/src/client.ts](server/src/client.ts)
- [x] Manually verify: drawing creates a real collidable platform (avatar runs/jumps on it), syncs to other clients live and via `world_state` on join, persists across a server restart, and rejects invalid/spammy input

> **Verified** end-to-end via a temporary `window.__debug` hook, synthetic `MouseEvent` dispatch (to drive real drawing-capture code through `canvasPoint`'s CSS-to-world coordinate scaling), raw `draw`/`input` messages sent directly over the connection, and an extra raw-`WebSocket` client (same multi-client technique as Phase 5):
> - **Draw → collide → render**: a synthetic mouse-drawn stroke (21 captured points) was RDP-simplified to 8, sent as `draw`, and came back as `platform_added` with matching geometry. The avatar then walked under it, fell onto it, and **rested at `y≈779.36`** — exactly the calculated resting spot on the platform's surface (not the ground's `y≈844`), proving the server generated real, correctly-positioned collision bodies from the drawn points (not just cosmetic strokes). A subsequent jump produced a clean arc (peaking at `y≈613.89`, `vy≈0` near apex) landing back at the identical `y≈779.36` — no tunneling, no instability from the thin chained-rectangle geometry.
> - **Validation** (`isValidDraw`/`isValidPoint`): of 6 deliberately-bad messages sent back-to-back (an immediate second draw within the cooldown window, a CSS-name color `"red"`, a `NaN` coordinate, an out-of-bounds negative coordinate, an object with an extra `z` key, and a single-point array), **all 6 were silently rejected** — only the one valid draw was accepted (platform count went 3→4).
> - **Physics-spam limits**: sending 15 valid, uniquely-shaped draws at ~1.1s intervals (past the cooldown) capped this player's owned platform count at exactly **`MAX_PLATFORMS_PER_PLAYER=10`** — the remaining 5 were rejected.
> - **Multi-client sync**: a fresh raw-`WebSocket` connection received `world_state` listing all **13** existing platforms (matching the live count) immediately on join; a *different* connection's `draw` then arrived as `platform_added` on **both** that connection and the original client simultaneously — confirming the broadcast-to-everyone-including-the-drawer pattern and live `platforms` map updates.
> - **Storage persistence**: recorded all 14 platforms' ids/colors/owners/point-counts, fully restarted the PartyKit dev server (forcing the room to reload from `this.room.storage`), and reconnected — **all 14 came back byte-for-byte identical**, confirming `this.room.storage.put`/`.list({prefix:"platform:"})` round-trips correctly and `onStart`'s `await` genuinely blocks the first `onConnect` until restoration completes.
>
> Debug hook fully removed afterward (verified via Grep — 0 matches for `__debug|TEMP DEBUG`).
>
> **False alarm caught during verification:** a sampling loop's uncaught exception (player briefly missing from a snapshot) silently halted a `setInterval` mid-test without clearing its held `right`/`jump` input, so the avatar ran off the right edge of the (finite, `WORLD_WIDTH*2`-wide) ground into the void and free-fell indefinitely. Identical root cause to the Phase 4 false alarm (test-harness state, not a game bug) — recovered by reloading the page (`onClose` cleaned up the orphaned body) and re-ran with a try/caught interval.

## Phase 7 — Lobby logic

> **Round logic (win conditions, round reset, delete-on-reset platform lifecycle) is shelved for later** — the user wants to get a real lobby in place and deploy before coming back to it. The GDD originally bundled these as one phase; splitting them here.

- [x] Client: join screen shown before connecting — username input + avatar-color picker + room code (auto-generated short code, or `?room=XYZABC` from the URL if present); submitting updates the URL (shareable) and opens the `PartySocket` with the chosen room/identity
- [x] Client → Server: pass chosen username/color via `PartySocket`'s `query` option, read in `onConnect(conn, ctx)` from `ctx.request.url`'s search params
- [x] Server: validate/sanitize incoming username (length cap, safe charset, fallback to a placeholder cheese name if missing/invalid) and color (must match `COLOR_PATTERN`, fallback to a default) — replaces the placeholder `pickUsername` system; store both via `connection.setState()` per the GDD's "Connection State" guidance
- [x] Render each avatar in its own chosen color (instead of the fixed green/yellow scheme), keeping a clear "(you)" distinguishing marker
- [x] Manually verify: choosing a name/color and creating a room produces a shareable URL; opening that URL in another session joins the same room with independent identity; bad/missing/oversized usernames are sanitized server-side; XSS-unsafe strings can't break rendering (rendered via `textContent`/`fillText`, never `innerHTML`)

> **Verified** end-to-end via the join-screen UI (driven through `preview_fill`/`preview_click`/form submission) plus a temporary `window.__debug` hook and raw-`WebSocket` test clients (same multi-client technique as Phases 5–6):
> - **Join screen**: screenshot confirmed the overlay renders title "Mouse", tagline, a "Name" input (placeholder "Cheddar"), six avatar-color swatches (reusing `PALETTE_COLORS`), a "Room code" field pre-filled with an auto-generated 6-char code (e.g. `48AMDA`, drawn from `ROOM_CODE_CHARS` which excludes ambiguous `0/O/1/I/L`), a sharing hint, and a "Play" button.
> - **Submit → connect flow**: filling "Roquefort" + selecting the pink swatch (`#f6a5c0`) + submitting updated the URL to `http://localhost:1999/?room=48AMDA` (via `history.replaceState`), removed the overlay, and opened the room connection — confirmed via `__debug.roster()`/`latestPlayers()`/`connId()` showing the local player keyed by its own connection id with `{username:"Roquefort", color:"#f6a5c0"}`, exactly matching what was chosen in the UI (proving identity flowed `query` params → `sanitizeUsername`/`sanitizeColor` → `setState`/`PlayerState` → `world_state`/`player_joined` broadcast → client roster). The avatar rendered as a pink circle (screenshot-confirmed).
> - **Independent multi-client identity, same room**: a raw `WebSocket` connecting to `/parties/main/48AMDA?username=Camembert&color=%23ffd479` received `world_state` showing the existing "Roquefort"/`#f6a5c0` player, and was itself broadcast as `player_joined` with its own distinct identity (`"Camembert"`, `#ffd479`) — and the original client's roster updated to include it. Proves: same room via shared code, fully independent identities, bidirectional sync.
> - **Server-side sanitization** (5 raw-`WebSocket` connect attempts with deliberately-bad query params, verified via the resulting `player_joined` broadcasts):
>   - `"  <script>alert(1)</script>\x07\x1b a very very long name...  "` + `#ffffff` → became `"<script>alert(1)</sc"` + `#ffffff` (control chars stripped, trimmed, **hard-capped at `MAX_USERNAME_LENGTH=20`** — the literal angle-bracket text survives sanitization untouched, which is fine and expected: it's never parsed as markup, see XSS note below)
>   - `"   "` (whitespace-only) + `#abc123` → fell back to a cheese name (`"Halloumi"`) + kept the valid color `#abc123`
>   - `"Edam"` + `"red"` (CSS color name, not hex) → kept the username, color fell back to `DEFAULT_AVATAR_COLOR=#f4c95d`
>   - `"Havarti"` + `"#fff"` (3-digit shorthand hex, doesn't match `COLOR_PATTERN`'s 6-digit requirement) → kept the username, color fell back to `#f4c95d`
>   - no `username`/`color` params at all → fell back to a cheese name (`"Edam"`) + `#f4c95d`
> - **XSS safety**: confirmed via `grep` that [server/src/client.ts](server/src/client.ts) contains **zero** uses of `innerHTML`/`outerHTML`/`insertAdjacentHTML` — every dynamic string reaches the page via `textContent` (DOM) or `ctx.fillText` (canvas), neither of which parses HTML/markup, so even an unsanitized `<script>` string can only ever appear as inert displayed text.
>
> Debug hook fully removed afterward (verified via Grep — 0 matches for `__debug|TEMP DEBUG`); `npx tsc --noEmit -p tsconfig.json` clean (exit 0) both before and after removal.

## Round logic (deferred)

- [ ] Win conditions, round reset, platform lifecycle (delete on reset / by creator, storage cleared, per-player body caps over a round's lifetime)

## Deployment

- [x] Deploy PartyKit server (`npx partykit deploy`) → live at [https://mice.shisatum.partykit.dev](https://mice.shisatum.partykit.dev)
- [x] Deploy client via Cloudflare Workers Static Assets (`wrangler.toml`, `npx wrangler deploy`) → live at [https://mice.thardobodol.workers.dev](https://mice.thardobodol.workers.dev)
- [ ] (Optional) Point a custom domain (`mice.ordulis.com`) at the Cloudflare Workers deployment via the dashboard — PartyKit's `.partykit.dev` subdomain stays as-is (managed PartyKit doesn't support custom domains; cross-origin client↔server is expected and correct per the GDD)
- [ ] (Optional) Automated deploys via GitHub Actions for both PartyKit and Cloudflare Workers

> **Verified live, end to end (2026-06-07):** renamed `partykit.json`'s `"name"` to `"mice"` so the deploy lands on `mice.[username].partykit.dev` (the GDD's expected pattern) instead of the scaffold default; `npx partykit deploy` published both the room logic and the bundled static client (per `serve.build`/`serve.path` in `partykit.json`) to `https://mice.shisatum.partykit.dev` — confirmed reachable (`HTTP 200`) after a few minutes of TLS cert provisioning. For the client, rather than standing up a separate build pipeline, `wrangler.toml` points `[assets].directory` straight at the existing `server/public/` folder (the same PartyKit-built bundle, which already has `PARTYKIT_HOST` baked in as the literal string `"mice.shisatum.partykit.dev"` at build time — confirmed by grepping `public/dist/client.js`). `npx wrangler deploy` (authenticated via `wrangler login`, run by the user in their own terminal so no token passed through chat) published it to `https://mice.thardobodol.workers.dev`. The preview tool can't load non-localhost URLs (it blocked the live link), so end-to-end verification — join screen, identity/room flow, cross-origin WSS connection from the Cloudflare-hosted client to the PartyKit server, drawing, physics, and multiplayer sync all working against the live production deployment — was done by the user manually in their own browser and confirmed working.

## GitHub repo prep

- [x] Add a root [.gitignore](.gitignore) — covers `node_modules/`, the PartyKit-generated `server/public/dist/` build output, local tool state (`server/.partykit/`, `server/.wrangler/`), env files, and OS/log cruft. Replaces the scaffold-generated `server/.gitignore` (which had garbled patterns like `_.log`) with one canonical file; `server/.vscode/` is deliberately kept (it's scaffold-provided project config — `partykit.json` schema association and PartyKit debugger attach settings — not personal editor state).
- [x] Add a root [README.md](README.md) — project overview, stack, live URLs, local-dev instructions, and a from-scratch deployment walkthrough for both the PartyKit server and the Cloudflare Workers client (including the optional custom-domain step), grounded in the actual commands and `wrangler.toml`/`partykit.json` configs used for this deployment rather than the GDD's earlier draft plan (e.g. the client reuses PartyKit's existing build output instead of a separate `npm run build` step).
- [x] `git init`, initial commit, and push to a private GitHub repo → [github.com/shisatum/mice](https://github.com/shisatum/mice)
