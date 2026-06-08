import type * as Matter from "matter-js";

// The shared simulation model — single-sourced so the server's authoritative
// physics and the client's local-player prediction (a deliberate, scoped
// exception to "the client does no local physics or prediction" — see
// CLAUDE.md) can never apply two different movement rules. Faithful prediction
// requires the local sim to use the *exact* model the server does; hand-mirroring
// it (the way client.ts mirrors display-only constants like DEFAULT_AVATAR_COLOR)
// would only guarantee drift.
//
// This module is deliberately Matter-*runtime*-free — every `Matter` reference
// here is `import type`, erased entirely at compile time (verified empirically:
// an esbuild bundle importing only from this module came out at 320 bytes with
// zero `matter-js` references, vs. ~84KB minified the moment a real `import
// Matter from "matter-js"` enters the graph). That split matters because Phase 1
// of local-player prediction (horizontal-only, no client physics engine) only
// needs the *constants* below — pulling in real Matter for those would silently
// incur Phase 2's "~tens of KB client download" cost a whole phase early. The
// handful of functions that actually *drive* Matter bodies — createPlatformBodies,
// applyMovement, createPlayerBody, createBoundaryBodies — live in
// physics-bodies.ts instead, which both the server (always) and the client
// (starting at Phase 2, when it runs a real local Matter world) import.

export const TICK_MS = 50; // ~20Hz, per the GDD's server-authoritative tick rate
export const SUB_STEP_MS = 1000 / 60;
export const SUB_STEPS = Math.round(TICK_MS / SUB_STEP_MS); // step physics at ~60Hz internally — Matter warns above ~16.7ms deltas and larger steps risk tunneling through thin bodies
export const WORLD_WIDTH = 1600;
export const WORLD_HEIGHT = 900;
export const GROUND_THICKNESS = 40;
export const WALL_THICKNESS = 40; // px — invisible boundary walls along the world's left/right/top edges (see physics-bodies.ts's createBoundaryBodies)
export const PLAYER_RADIUS = 16;
export const PLATFORM_THICKNESS = 10; // px — matches the prototype's SEGMENT_THICKNESS
export const MOVE_SPEED = 5; // px/tick horizontal velocity while running — same feel as the prototype
export const JUMP_SPEED = 11; // px/tick upward velocity applied on jump
export const GRAVITY_Y = 1; // world gravity, same feel as the prototype

export type Point = { x: number; y: number };
export type Keys = { left: boolean; right: boolean; jump: boolean };

// The empirically-derived normal-sign predicate from the prototype's
// isSupportingContact, carried over unchanged through every later phase (see
// CLAUDE.md). A vertical contact normal alone isn't enough to mean "standing
// on": bumping your head on a platform's underside also produces a
// near-vertical normal. Resolving which side requires checking the normal's
// sign relative to which body in the pair is the player — Matter 0.20's SAT
// normal is *not* a simple "bodyA -> bodyB" center-to-center vector: for a
// genuinely-supporting contact, normal.y is negative when the player is bodyA,
// and positive when the platform is bodyA. Both the server's
// registerGroundDetection and (from Phase 2 on) the client's local prediction
// sim wire their own Matter.Events listeners around this — the wiring differs,
// the rule must not. Pure structural property access on the pair/body — needs
// only Matter's *types*, never its runtime, which is exactly why it lives here
// rather than in physics-bodies.ts.
export function isSupportingContact(pair: Matter.Pair, player: Matter.Body): boolean {
  return pair.bodyA === player ? pair.collision.normal.y < -0.5 : pair.collision.normal.y > 0.5;
}
