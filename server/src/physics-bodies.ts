import Matter from "matter-js";
import {
  WORLD_WIDTH, WORLD_HEIGHT, GROUND_THICKNESS, WALL_THICKNESS, PLAYER_RADIUS,
  PLATFORM_THICKNESS, MOVE_SPEED, JUMP_SPEED,
  type Point, type Keys,
} from "./physics";

// Matter-*runtime*-dependent counterpart to physics.ts (see that file's header
// comment for why the split exists): the body-factory and movement functions
// that actually call into `matter-js`, rather than just describing the model
// in constants/types/pure predicates. Importing this module pulls the real
// Matter runtime into whatever bundle imports it (~84KB minified, empirically) —
// the server always pays that cost (it *is* the physics authority), and the
// client only starts paying it at prediction Phase 2 (a real local Matter
// world for the local player). Phase 0/1 deliberately import only from
// physics.ts to avoid incurring this cost early.

// Chain of thin static rectangles, one per consecutive point pair — identical
// to the prototype's pointsToBodies; deterministic so every client can
// regenerate matching cosmetic (and, for the local predicted player, physical)
// geometry from the same point array.
export function createPlatformBodies(points: Point[]): Matter.Body[] {
  const bodies: Matter.Body[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.5) continue; // skip degenerate zero-length segments
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    bodies.push(
      Matter.Bodies.rectangle(mid.x, mid.y, length, PLATFORM_THICKNESS, {
        isStatic: true,
        angle,
        label: "platform",
      })
    );
  }
  return bodies;
}

// Direct-velocity horizontal movement plus a one-shot, ground-gated jump —
// identical logic to the prototype's updatePlayer(), now the single source both
// the server's authoritative tick (applyInput) and the client's local
// prediction sim (from Phase 2 on) drive a body through. Returns the new
// `jumpHeld`: the edge-detect that keeps holding jump from repeatedly
// triggering is state the *caller* owns (PlayerState server-side, the local
// prediction state client-side) — this function is stateless besides the body
// it mutates.
export function applyMovement(body: Matter.Body, keys: Keys, jumpHeld: boolean, grounded: boolean): boolean {
  let vx = 0;
  if (keys.left) vx -= MOVE_SPEED;
  if (keys.right) vx += MOVE_SPEED;
  Matter.Body.setVelocity(body, { x: vx, y: body.velocity.y });

  if (keys.jump && !jumpHeld && grounded) {
    Matter.Body.setVelocity(body, { x: body.velocity.x, y: -JUMP_SPEED });
  }
  return keys.jump;
}

// The player circle factory — radius/friction/etc. identical to the
// prototype's avatar, single-sourced so a client-predicted body has identical
// dynamics to the server's authoritative one.
export function createPlayerBody(x: number, y: number): Matter.Body {
  return Matter.Bodies.circle(x, y, PLAYER_RADIUS, {
    label: "player",
    friction: 0.05,
    frictionAir: 0.01,
    restitution: 0,
    inertia: Infinity, // locked rotation, same as the prototype's avatar
  });
}

// Static ground plus invisible boundary walls along the world's left/right/top
// edges. Without them a player can simply run — or, given a tall enough drawn
// structure, climb — straight past the visible canvas and disappear off-screen
// with no way back (the world has no camera/scrolling; everything within
// [0, WORLD_WIDTH] x [0, WORLD_HEIGHT] is the whole stage). Each wall sits just
// outside the world so its *inner* face is flush with the edge (x=0,
// x=WORLD_WIDTH, y=0), and is overlength to cover the corners.
//
// They reuse label "platform" rather than introducing a new label: the
// empirically-derived normal-sign check in physics.ts's isSupportingContact
// already distinguishes "resting on top of" from "bumping into the
// side/underside of" *any* static body purely from contact geometry, so a side
// wall or ceiling can never be mistaken for ground to stand on and re-arm a jump.
export function createBoundaryBodies(): Matter.Body[] {
  const ground = Matter.Bodies.rectangle(
    WORLD_WIDTH / 2,
    WORLD_HEIGHT - GROUND_THICKNESS / 2,
    WORLD_WIDTH * 2,
    GROUND_THICKNESS,
    { isStatic: true, label: "platform" }
  );
  const leftWall = Matter.Bodies.rectangle(
    -WALL_THICKNESS / 2, WORLD_HEIGHT / 2, WALL_THICKNESS, WORLD_HEIGHT * 2,
    { isStatic: true, label: "platform" }
  );
  const rightWall = Matter.Bodies.rectangle(
    WORLD_WIDTH + WALL_THICKNESS / 2, WORLD_HEIGHT / 2, WALL_THICKNESS, WORLD_HEIGHT * 2,
    { isStatic: true, label: "platform" }
  );
  const ceiling = Matter.Bodies.rectangle(
    WORLD_WIDTH / 2, -WALL_THICKNESS / 2, WORLD_WIDTH * 2, WALL_THICKNESS,
    { isStatic: true, label: "platform" }
  );
  return [ground, leftWall, rightWall, ceiling];
}
