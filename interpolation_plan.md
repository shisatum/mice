# Plan: Client-side entity interpolation (smooth movement)

## Goal

Players currently look like they move at a low frame rate. The server broadcasts
position snapshots at **20Hz** (`TICK_MS = 50` in `server/src/server.ts`), but the
client renders at ~60fps. The render loop (`frame()` in `server/src/client.ts`)
draws the single latest snapshot as-is, so each server position is painted ~3
identical frames in a row and then *snaps* to the next — that stair-stepping is
the choppiness.

Fix: **client-side entity interpolation**. Instead of rendering the newest
snapshot the instant it arrives, render the world a fixed delay *in the past* and
tween each avatar between the two server snapshots that bracket that render time.
The server keeps sending 20 positions/sec; the client fills in all the in-between
frames smoothly at display rate.

This is a **client-only, render-only** change. Do **not** add any client-side
physics, prediction, or reconciliation. The server stays the sole source of
truth; the client only ever *draws* server-provided positions, with the gaps
between them smoothed. This deliberately respects the project's pinned
"client does no local physics or prediction" convention (see `CLAUDE.md`).

### Accepted tradeoff (intentional)

Interpolation renders ~100ms in the past, so **every** avatar — including the
local player's own — lags input by that buffer. This is the known and accepted
cost of option #1 and applies equally to local and remote players. If the local
avatar ends up feeling too laggy after testing, the follow-up is local
prediction (a separate, larger change that breaks the no-client-physics
convention) — out of scope here, not to be added preemptively.

## Scope

All changes are in **`server/src/client.ts`** only. No protocol changes, no
server changes (except the optional tick-rate tweak noted at the bottom, which is
gated on testing + maintainer approval — do **not** do it in this pass).

Only **players** move, so only players need interpolation. Platforms, the cheese,
chat, ink meter, previews, etc. are untouched.

## Implementation steps

### 1. Add two mirrored constants

Near the other mirrored world constants at the top of `client.ts` (around lines
9–19, alongside `WORLD_WIDTH`, `PLAYER_RADIUS`, etc.), add:

```ts
// Mirrors the server's TICK_MS — the interval between position snapshots.
// Kept as its own client-side copy for the same reason WORLD_WIDTH et al. are:
// this is a separate (browser) bundle that can't import the backend module.
// MUST stay in sync with server/src/server.ts's TICK_MS.
const SERVER_TICK_MS = 50;

// How far in the past to render, for entity interpolation. Two snapshot
// intervals: one is the minimum (so there's normally a newer snapshot to tween
// toward), the second is jitter/late-packet margin (one delayed or dropped
// snapshot still leaves a bracket to interpolate within). Larger = smoother
// under bad networks but more input latency on the local avatar.
const INTERP_DELAY_MS = SERVER_TICK_MS * 2;
```

### 2. Replace `latestPlayers` with a timestamped snapshot buffer

Currently:

```ts
let latestPlayers: PlayerSnapshot[] = [];
```

Replace with a small history of snapshots, each stamped with its local arrival
time (use `performance.now()` — monotonic, and the same clock `frame()` will read):

```ts
type Snapshot = { receivedAt: number; players: PlayerSnapshot[] };

// Recent position snapshots, oldest-first, for entity interpolation. The render
// loop (frame -> playersAt) draws a blend of the two snapshots bracketing
// "now - INTERP_DELAY_MS" rather than the newest one outright, so 20Hz server
// updates render smoothly at display rate. Pruned to just the window the current
// render needs (see the snapshot case below).
let snapshotBuffer: Snapshot[] = [];
```

### 3. Update the `"snapshot"` case to push (and prune) instead of overwrite

In the `conn.addEventListener("message", ...)` switch, the `case "snapshot"`
currently does `latestPlayers = msg.players as PlayerSnapshot[]`. Keep the
existing `Array.isArray(msg.players)` shape check exactly as-is (do **not** add
per-field validation — see `CLAUDE.md`'s client-validation posture; the server
already deep-validates). Just change what happens on success:

```ts
case "snapshot": {
  if (Array.isArray(msg.players)) {
    const now = performance.now();
    snapshotBuffer.push({ receivedAt: now, players: msg.players as PlayerSnapshot[] });
    // Prune snapshots older than the current render window needs. We only ever
    // need the one snapshot just-older than the render time, plus everything
    // newer — keep buf[0] as that bracketing-older one and drop the rest.
    const cutoff = now - INTERP_DELAY_MS;
    while (snapshotBuffer.length > 2 && snapshotBuffer[1].receivedAt <= cutoff) {
      snapshotBuffer.shift();
    }
  } else {
    warnUnexpectedShape(msg.type, msg);
  }
  break;
}
```

### 4. Add the interpolation function (free function, plain data)

Per the project's "geometry stays data + free functions, never classes"
convention, add a module-level free function. It returns the set of avatars to
draw at a given render time, with positions interpolated:

```ts
// Returns each player's position interpolated to `renderTime` (which is
// deliberately in the past — see INTERP_DELAY_MS), blending the two snapshots
// that bracket it. Purely a rendering transform over server-authoritative
// positions: no physics, no prediction, the server is still the only thing that
// decides where anyone actually is.
function playersAt(renderTime: number): PlayerSnapshot[] {
  const buf = snapshotBuffer;
  if (buf.length === 0) return [];

  // Find the newest snapshot at or before renderTime ("older"), and the one
  // right after it ("newer").
  let older: Snapshot | null = null;
  let newer: Snapshot | null = null;
  for (let i = buf.length - 1; i >= 0; i--) {
    if (buf[i].receivedAt <= renderTime) {
      older = buf[i];
      newer = buf[i + 1] ?? null;
      break;
    }
  }

  // renderTime is before everything we have (just connected): show the oldest.
  if (!older) return buf[0].players;
  // renderTime is past the newest (server stalled / packets stopped): hold the
  // last known positions. Deliberately NOT extrapolated — holding is safe and
  // keeps this strictly "render server data," matching the no-client-physics rule.
  if (!newer) return older.players;

  const span = newer.receivedAt - older.receivedAt;
  const t = span > 0 ? Math.max(0, Math.min(1, (renderTime - older.receivedAt) / span)) : 0;

  const newerById = new Map(newer.players.map((p) => [p.id, p]));
  const result: PlayerSnapshot[] = [];
  for (const o of older.players) {
    const n = newerById.get(o.id);
    if (n) {
      // Present in both: linear-interpolate position. vx/vy aren't used by
      // drawPlayers, so carry the newer values through unchanged for shape parity.
      result.push({
        id: o.id,
        x: o.x + (n.x - o.x) * t,
        y: o.y + (n.y - o.y) * t,
        vx: n.vx,
        vy: n.vy,
      });
      newerById.delete(o.id);
    } else {
      // Only in the older snapshot (player left between the two) — draw last
      // known spot; it disappears once `older` advances past it.
      result.push(o);
    }
  }
  // Anything left in newerById only appeared in the newer snapshot (just joined).
  for (const n of newerById.values()) result.push(n);

  return result;
}
```

### 5. Drive `drawPlayers` from interpolated positions

`drawPlayers()` currently iterates the module-level `latestPlayers`. Make it take
the interpolated list as a parameter and have `frame()` compute it:

```ts
function drawPlayers(players: PlayerSnapshot[]) {
  for (const player of players) {
    const isMe = player.id === conn.id;
    // ...unchanged body (uses player.id / player.x / player.y; conn.id still
    // identifies the local avatar exactly as before)...
  }
}
```

And in `frame()`:

```ts
function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGround();
  drawErasePreview();
  drawPlatforms();
  drawCheese();
  drawPlayers(playersAt(performance.now() - INTERP_DELAY_MS));
  drawInProgressPath();
  updateCountdownDisplay();
  requestAnimationFrame(frame);
}
```

### 6. Clean up

- Remove the now-unused `latestPlayers` declaration (confirm with grep that
  nothing else references it — currently only the snapshot case and `drawPlayers`
  do).
- `npx tsc --noEmit` must be clean.

## Verification

Match the project's established verification discipline (see `CLAUDE.md` /
`TODO.md`). Concretely:

1. **Type check**: `npx tsc --noEmit` clean before and after.
2. **Smoothness (the actual fix)**: run locally (`npm run dev` from `server/`),
   open the client. Temporarily instrument `playersAt` (or sample its output from
   a `window.__debug` hook, the project's established technique) to log a moving
   player's interpolated `x` across consecutive `frame()` calls. Confirm you see
   **distinct intermediate x values between server snapshots** (smooth ramp),
   not the current "3 identical frames, then a jump." Remove the hook after
   (grep for `__debug` → 0 matches, as prior features did).
3. **Steady motion looks continuous**: hold a movement key; the avatar should
   glide, not stutter. Sanity-check the local avatar's added input latency feels
   acceptable (~100ms) — this is the intended tradeoff; flag to maintainer if it
   feels too high (that's the trigger for considering local prediction later).
4. **Edge cases don't break**:
   - Single connected player still falls and lands correctly on join (buffer
     with only 1–2 snapshots falls back to drawing what's available).
   - A second client joining / leaving mid-session: no crash, label/identity
     still correct, no lingering ghost avatar after leave.
   - Brief server stall (or just the gap right after connect): avatar holds last
     position rather than flying off (the `!newer` branch).
5. **No regressions**: drawing, erasing, chat, ink meter, cheese-race countdown
   and win still work — interpolation only touches player rendering.

## Documentation (do this last, it's part of "done" in this project)

This codebase records every feature in `CLAUDE.md` and `TODO.md`. After
verification:

- Add a `CLAUDE.md` status section describing the interpolation feature (what
  changed, the accepted local-latency tradeoff, the constants added, and the
  verification performed), in the same style as the existing feature writeups.
- Update `TODO.md` accordingly.

---

## NOTE — tick-rate adjustment (gated: testing + maintainer approval first)

If 50ms / 20Hz still feels insufficiently smooth after interpolation is in and
tested, we can try raising the server tick to **~33ms (30Hz)** — but **only
after testing and with the maintainer's (Erik's) explicit approval. Do not change
the tick rate in this pass.**

When/if approved, it's a two-line change kept in sync:

- `server/src/server.ts`: `const TICK_MS = 50;` → `33`. `SUB_STEPS` is derived
  (`Math.round(TICK_MS / SUB_STEP_MS)`), so the physics sub-stepping recomputes
  automatically (3 sub-steps at 50ms → 2 at 33ms, each still ~16.7ms — no manual
  retuning needed).
- `server/src/client.ts`: `const SERVER_TICK_MS = 50;` → `33` (these two
  constants **must** match — `INTERP_DELAY_MS` scales off the client copy, so the
  interpolation buffer shrinks to ~66ms automatically, cutting local-input
  latency too).

Tradeoff to weigh at that point: 30Hz is 50% more snapshot broadcasts (more
bandwidth + server CPU per room). Interpolation already removes most of the
visible choppiness on its own, so treat the higher tick rate as a *second* dial
to try only if needed, not a default.
