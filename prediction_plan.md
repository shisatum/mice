# Plan: Local-player client-side prediction (reduce input lag)

## Goal & principle

Interpolation (already shipped) smoothed movement but made the **local** avatar
lag input by ~100ms, because it renders every player — including yourself — in
the past. This plan removes that lag for the local player only: the local avatar
responds to your keypresses *immediately*, simulated client-side, then corrects
against the server's authoritative snapshots. **Remote players keep the existing
interpolation unchanged.**

This is the genre-standard architecture (server-authoritative + remote
interpolation + local prediction; see Gabriel Gambetta's "Fast-Paced
Multiplayer" series). Crucially, **it adds zero hosting cost**: the server already
runs the full simulation, so prediction is pure client-side work. The cost is
client code and a convention change, not server load or bandwidth.

### Convention impact (read first — these are pinned in CLAUDE.md)

This deliberately introduces an exception to two pinned conventions. Both changes
are intentional and must be written back into CLAUDE.md when done:

1. **"The client does no local physics or prediction."** This plan adds exactly
   that — but *scoped to the local player only*, with the server still the sole
   authority (the client's prediction is always corrected by server snapshots,
   never trusted over them). Remote players remain pure render-of-server-data.
2. **"The client mirrors server constants by hand."** Faithful prediction
   requires the local sim to use the *same* movement model as the server.
   Re-mirroring it by hand would guarantee drift. Instead, extract the shared
   movement model into one module both `server.ts` and `client.ts` import (see
   Phase 0) — this *strengthens* single-sourcing rather than weakening it. (Note:
   the existing comment in client.ts claiming it "can't import a backend module"
   is specifically about `directory.ts`, which pulls in `partykit/server`. A pure
   shared module with no server-runtime imports is safe for the browser bundle.)

## Staged approach (stop when it feels good enough)

Implement in order; each phase is shippable on its own. Stop at the earliest
phase that feels responsive enough — don't build later phases preemptively.

- **Phase 0** — Extract a shared simulation module (prerequisite for any faithful
  prediction).
- **Phase 1** — Horizontal-only prediction. Lightest; removes lag from *running*,
  which is the dominant felt latency. No physics engine on the client.
- **Phase 2** — Full local physics sim. Predicts jumps/falls/collisions too, for a
  fully responsive local avatar. Bundles Matter.js into the client.
- **Phase 3** (optional) — Input sequence numbers + reconciliation replay, for
  frame-accurate correctness under real latency. Tiny protocol addition.

---

## Phase 0 — Shared simulation module (prerequisite)

Create `server/src/physics.ts` (or `shared.ts`) containing **only** pure
constants + pure functions + Matter.js usage (Matter is browser-safe — it's
originally a browser lib — so the client can import it). **No** `partykit/server`
or other server-runtime imports, so it's safe in the browser bundle.

Move/centralize here, and import from both `server.ts` and `client.ts`:

- **Constants:** `WORLD_WIDTH`, `WORLD_HEIGHT`, `GROUND_THICKNESS`,
  `WALL_THICKNESS`, `PLAYER_RADIUS`, `PLATFORM_THICKNESS`, `MOVE_SPEED`,
  `JUMP_SPEED`, `TICK_MS`, `SUB_STEP_MS`, `SUB_STEPS`, and `GRAVITY_Y` (currently
  the inline `this.engine.gravity.y = 1`). The client's hand-mirrored copies of
  these (top of `client.ts`) get deleted in favor of importing them.
- **`createPlatformBodies(points)`** — already a free function in `server.ts`;
  move it here so client and server build identical platform geometry.
- **`applyMovement(body, keys, jumpHeld, grounded): boolean`** — extract the body
  of the server's `applyInput` (the direct-velocity horizontal set + the
  one-shot ground-gated jump). Returns the new `jumpHeld`. The server's
  `applyInput` becomes a thin wrapper that reads `groundContacts > 0` and calls
  this; the client's local sim calls the *same* function. This is the single most
  important extraction — it's what guarantees the prediction can't drift from the
  authoritative movement rule.
- **`isSupportingContact(pair, player)`** — the empirically-derived normal-sign
  predicate from `registerGroundDetection`. Both sides need identical ground
  detection or jump-gating will mispredict. Share the predicate; each side wires
  its own `Matter.Events` listeners around it (the wiring differs, the rule
  doesn't).
- **`createPlayerBody(x, y)`** — the player circle factory (radius, `friction:
  0.05`, `frictionAir: 0.01`, `restitution: 0`, `inertia: Infinity`,
  `label: "player"`), so the client's predicted body has identical dynamics.
- **`createBoundaryBodies()`** — ground + left/right walls + ceiling builders from
  `onStart`, so the client's local world has the same static geometry. (Needed in
  Phase 2; harmless to extract now.)

Verify `npx tsc --noEmit` is clean and the server behaves identically after the
refactor *before* adding any prediction. This phase should be behavior-preserving.

---

## Phase 1 — Horizontal-only prediction (recommended first ship)

Predict only the local avatar's **x** from your own keys, rendered immediately;
keep **y** (and all remote players) interpolated as today. Rationale: server
horizontal motion is direct velocity (`vx = ±MOVE_SPEED`) and doesn't depend on
collisions except the world walls (a cheap clamp) and the rare vertical-ish
platform edge — so x is faithfully predictable with almost no machinery, and
running is the motion where the lag is most felt. Jumps/falls stay slightly
lagged (acceptable for a casual platformer; Phase 2 fixes them if needed).

### Changes in `client.ts`

1. **Hoist `keys` to module scope** (it currently lives inside `startGame`) so the
   module-level `frame()` can read it. `conn` is already module-level; do the same.

2. **Add prediction state and tuning constants:**

   ```ts
   let localX: number | null = null;     // predicted world-x of the local avatar; null until first snapshot seeds it
   const RECONCILE_BLEND = 0.15;          // per-snapshot fraction to ease predicted x toward authority (tune)
   const PREDICT_SNAP_PX = 64;            // error above this = hard snap (big desync), don't smooth (tune)
   ```

3. **Predict each frame** (call from `frame()`, using its frame delta `dtMs`):

   ```ts
   function predictLocalX(dtMs: number) {
     if (localX === null) return;
     let dir = 0;
     if (keys.left) dir -= 1;
     if (keys.right) dir += 1;
     // Server moves MOVE_SPEED px per TICK_MS tick; convert to px/ms.
     localX += dir * MOVE_SPEED * (dtMs / TICK_MS);
     localX = Math.max(PLAYER_RADIUS, Math.min(WORLD_WIDTH - PLAYER_RADIUS, localX)); // world walls
   }
   ```

4. **Reconcile in the `"snapshot"` case** (after buffering for interpolation as
   today), easing predicted x toward the authoritative value:

   ```ts
   const me = (msg.players as PlayerSnapshot[]).find((p) => p.id === conn.id);
   if (me) {
     if (localX === null) localX = me.x;                 // seed on first snapshot
     else {
       const error = me.x - localX;
       if (Math.abs(error) > PREDICT_SNAP_PX) localX = me.x; // big desync: snap
       else localX += error * RECONCILE_BLEND;               // small: ease toward authority
     }
   }
   ```

5. **Render the local avatar at predicted x** in `frame()` — keep its interpolated
   y, and leave remote players fully interpolated:

   ```ts
   function frame() {
     // ...clear, dt computed as ms since last frame...
     predictLocalX(dtMs);
     const players = playersAt(performance.now() - INTERP_DELAY_MS);
     if (localX !== null) {
       const me = players.find((p) => p.id === conn.id);
       if (me) me.x = localX;   // override only x; y stays interpolated
     }
     // ...drawGround/Platforms/Cheese/drawPlayers(players)/etc...
   }
   ```

### Honest limitation of Phase 1

The reconciliation here eases toward a snapshot that is already ~RTT+tick old, so
while you're actively running there's a small standing error (predicted is ahead
of stale authority) that the blend constantly chases. On low latency (localhost,
good connections) this is invisible. Under high latency it can feel slightly
floaty or tug backward. If that shows up in testing, that's the signal to do
Phase 3 (replay), which eliminates it. Also expect a subtle mismatch in feel
because x is responsive while y (jumping/landing) still lags — judge whether
that's acceptable before committing to Phase 2.

---

## Phase 2 — Full local physics sim (responsive jumps too)

Only if Phase 1's vertical lag still bothers you. Run a real Matter.js world on
the client for the **local player only**, and reconcile it against snapshots.

1. **Import Matter.js into `client.ts`** (already a project dependency; browser-
   safe). This grows the client *download* size (~tens of KB) — a client cost,
   not a hosting cost.

2. **Build a local world** at connect using the shared builders: gravity =
   `GRAVITY_Y`, add `createBoundaryBodies()` (ground/walls/ceiling), add a local
   player body via `createPlayerBody()`, and wire a `collisionStart`/
   `collisionEnd` listener using the shared `isSupportingContact` to maintain a
   local `groundContacts` count for jump-gating.

3. **Keep local platforms in sync with the `platforms` Map:** on `world_state`
   rebuild all platform bodies; on `platform_added` add via
   `createPlatformBodies`; on `platform_removed` remove the tracked bodies for
   that id. (Track a `localPlatformBodies: Map<string, Matter.Body[]>` alongside
   the existing `platforms` Map.)

4. **Step the local sim** on a fixed-timestep accumulator driven by `frame()`:
   apply input via the shared `applyMovement`, then `Matter.Engine.update` in
   `SUB_STEP_MS` increments. Matching the server's per-tick input + 3-sub-step
   structure as closely as practical keeps prediction error small; minor
   structural mismatch is absorbed by reconciliation.

5. **Reconcile with visual-offset smoothing** (recommended over snapping the body
   directly): on each snapshot, snap the *physics body* to the authoritative
   position/velocity (keeps the simulation correct), but maintain a `renderOffset
   = previousRenderedPos − authoritativePos` that **decays to zero over a few
   frames**, so the correction is never seen as a jump. Render the local avatar at
   `body.position + renderOffset`. Big errors can zero the offset (hard snap).

6. **Render local from the local body** (smooth at frame rate, no interpolation
   delay); remote players still come from `playersAt(...)`. Remove the Phase 1
   `localX` x-override in favor of this.

---

## Phase 3 — Input sequence numbers + replay (optional precision upgrade)

The frame-accurate version, if real-latency testing shows drift/rubber-banding
under Phase 1 or 2. Applies on top of either.

- **Client:** tag each `input` message with an incrementing `seq`; keep a buffer
  of unacknowledged inputs (seq + keys + timestamp).
- **Server:** track the last processed `seq` per connection; include it in the
  snapshot for that recipient (e.g. a per-player `lastInput`, or a field only on
  the recipient's view). This is a *tiny* protocol addition — one integer —
  negligible bandwidth, no real hosting cost.
- **Client reconciliation:** on a snapshot, reset the local body to the
  authoritative state, discard inputs `<= lastInput`, and **replay** the remaining
  buffered inputs through the local sim. This removes the standing error entirely,
  because correction and replay land the predicted state exactly where the server
  would have it "now."

Keep the validation posture consistent: the server still owns truth and validates
input shape; `seq` is attribution/ordering only, never security-relevant.

---

## Verification

Follow the project's established discipline (synthetic events, `window.__debug`
hooks removed afterward, `tsc` clean, screenshots/sampling):

1. `npx tsc --noEmit` clean after Phase 0 (behavior-preserving refactor) and after
   each subsequent phase.
2. **Phase 0 regression:** server movement/jump/collision and remote rendering
   behave exactly as before the refactor (the existing interpolation verification
   still passes).
3. **Responsiveness (the fix):** instrument the rendered local-avatar position and
   confirm it begins moving on the *same frame* (or within ~1) as the keydown,
   versus the ~100ms delay today. A `CanvasRenderingContext2D.prototype.arc`
   monkey-patch (the technique used to verify interpolation) can sample the local
   avatar's drawn x against input timing.
4. **Reconciliation doesn't visibly snap:** drive movement, then inject an
   artificial authoritative correction (or test under throttled latency) and
   confirm the avatar eases rather than teleports; a large desync still snaps.
5. **Remote players unchanged:** a second client still renders smoothly via
   interpolation, with no ghosts on join/leave and zero `console.warn` (no
   protocol-shape drift).
6. **No regressions:** drawing, erasing, chat, ink meter, cheese-race countdown/
   win all still work.

## Documentation (part of "done")

Update `CLAUDE.md` and `TODO.md`:

- Record the new feature and, explicitly, the **two convention changes**: local-
  player prediction is now a deliberate, scoped exception to "client does no local
  physics/prediction" (server still authoritative, remote players still pure
  render); and the movement model is now single-sourced in `physics.ts` rather
  than hand-mirrored, with a note on why (faithful prediction requires it).
- Note which phase shipped and the accepted limitations of stopping there.
