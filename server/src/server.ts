import type * as Party from "partykit/server";
import Matter from "matter-js";

const TICK_MS = 50; // ~20Hz, per the GDD's server-authoritative tick rate
const SUB_STEP_MS = 1000 / 60;
const SUB_STEPS = Math.round(TICK_MS / SUB_STEP_MS); // step physics at ~60Hz internally — Matter warns above ~16.7ms deltas and larger steps risk tunneling through thin bodies
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;
const GROUND_THICKNESS = 40;
const PLAYER_RADIUS = 16;
const MOVE_SPEED = 5; // px/tick horizontal velocity while running — same feel as the prototype
const JUMP_SPEED = 11; // px/tick upward velocity applied on jump

const PLATFORM_THICKNESS = 10; // px — matches the prototype's SEGMENT_THICKNESS
const MAX_DRAW_POINTS = 500; // generous cap on a single stroke's (already RDP-simplified) point count
const DRAW_COOLDOWN_MS = 1000; // per the GDD's physics-spam guidance: max one new platform per player per second
const MAX_PLATFORMS_PER_PLAYER = 10; // per the GDD's physics-spam guidance: cap active bodies per player
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_USERNAME_LENGTH = 20;
const DEFAULT_AVATAR_COLOR = "#f4c95d";
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

// Cheese names fit the mouse theme and match the GDD's own example ("Mozzarella") —
// used as the fallback identity whenever a connection doesn't supply (or supplies
// an unusable) username, e.g. raw test clients or a player who skips the picker.
const USERNAMES = [
  "Mozzarella", "Brie", "Gouda", "Cheddar", "Camembert", "Roquefort",
  "Provolone", "Parmesan", "Gruyere", "Feta", "Ricotta", "Manchego",
  "Halloumi", "Stilton", "Edam", "Havarti",
];
function pickUsername(): string {
  return USERNAMES[Math.floor(Math.random() * USERNAMES.length)];
}

// Per the GDD's "XSS via Usernames" security guidance: strip control characters
// and length-cap before the name ever reaches storage, broadcast, or rendering —
// canvas `fillText` doesn't parse HTML, but an unsanitized string could still be
// used to spoof other UI text or blow past layout bounds. Falls back to a cheese
// name for empty/non-string input so every player always has a displayable identity.
function sanitizeUsername(raw: unknown): string {
  if (typeof raw !== "string") return pickUsername();
  const cleaned = raw.replace(CONTROL_CHARS, "").trim().slice(0, MAX_USERNAME_LENGTH);
  return cleaned.length > 0 ? cleaned : pickUsername();
}

function sanitizeColor(raw: unknown): string {
  return typeof raw === "string" && COLOR_PATTERN.test(raw) ? raw : DEFAULT_AVATAR_COLOR;
}

type Keys = { left: boolean; right: boolean; jump: boolean };

function isValidInput(data: unknown): data is { type: "input"; keys: Keys } {
  if (typeof data !== "object" || data === null) return false;
  const { type, keys } = data as Record<string, unknown>;
  if (type !== "input" || typeof keys !== "object" || keys === null) return false;
  const { left, right, jump } = keys as Record<string, unknown>;
  return typeof left === "boolean" && typeof right === "boolean" && typeof jump === "boolean";
}

type Point = { x: number; y: number };

// Per the GDD's "Drawing Data: Numbers Only" security guidance: reject
// strings, NaN/Infinity, extra keys, and out-of-bounds coordinates — anything
// that isn't a clean finite {x,y} pair within the world stays out of the
// physics world, storage, and any rebroadcast.
function isValidPoint(p: unknown): p is Point {
  if (typeof p !== "object" || p === null) return false;
  const keys = Object.keys(p);
  if (keys.length !== 2 || !keys.includes("x") || !keys.includes("y")) return false;
  const { x, y } = p as Record<string, unknown>;
  return (
    typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= WORLD_WIDTH &&
    typeof y === "number" && Number.isFinite(y) && y >= 0 && y <= WORLD_HEIGHT
  );
}

function isValidDraw(data: unknown): data is { type: "draw"; points: Point[]; color: string } {
  if (typeof data !== "object" || data === null) return false;
  const { type, points, color } = data as Record<string, unknown>;
  if (type !== "draw") return false;
  if (typeof color !== "string" || !COLOR_PATTERN.test(color)) return false;
  if (!Array.isArray(points) || points.length < 2 || points.length > MAX_DRAW_POINTS) return false;
  return points.every(isValidPoint);
}

// Chain of thin static rectangles, one per consecutive point pair — identical
// to the prototype's pointsToBodies; deterministic so every client can
// regenerate matching cosmetic geometry from the same point array.
function createPlatformBodies(points: Point[]): Matter.Body[] {
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

function makePlatformId(): string {
  return `platform:${crypto.randomUUID().slice(0, 8)}`;
}

type PlatformData = { points: Point[]; color: string; owner: string };
type PlatformState = PlatformData & { id: string; bodies: Matter.Body[] };

type PlayerState = {
  body: Matter.Body;
  username: string;
  color: string;
  keys: Keys;
  groundContacts: number;
  jumpHeld: boolean; // edge-detect so holding jump doesn't repeatedly trigger
};

type ConnState = { username: string; color: string };

export default class Server implements Party.Server {
  engine = Matter.Engine.create();
  players = new Map<string, PlayerState>();
  bodyIdToConnId = new Map<number, string>();
  platforms = new Map<string, PlatformState>();
  lastDrawAt = new Map<string, number>(); // connection id -> ms timestamp, for rate limiting
  tick = 0;

  constructor(readonly room: Party.Room) {}

  async onStart() {
    this.engine.gravity.y = 1;

    // Static ground — mirrors the prototype's setup so a player dropped into
    // the room always has something to land on, drawn platforms or not.
    const ground = Matter.Bodies.rectangle(
      WORLD_WIDTH / 2,
      WORLD_HEIGHT - GROUND_THICKNESS / 2,
      WORLD_WIDTH * 2,
      GROUND_THICKNESS,
      { isStatic: true, label: "platform" }
    );
    Matter.World.add(this.engine.world, ground);

    // Restore platforms drawn before a restart/hibernation — PartyKit guarantees
    // onStart finishes (including this await) before the first onConnect fires,
    // so joiners always see a world that matches storage.
    const stored = await this.room.storage.list<PlatformData>({ prefix: "platform:" });
    for (const [id, data] of stored) this.addPlatform(id, data);

    this.registerGroundDetection();
    setInterval(() => this.step(), TICK_MS);
  }

  // Builds physics bodies from a platform's point array, adds them to the
  // world, and registers the platform — shared by storage restoration on boot
  // and live `draw` events, so both paths stay in sync by construction.
  private addPlatform(id: string, data: PlatformData): PlatformState {
    const bodies = createPlatformBodies(data.points);
    Matter.World.add(this.engine.world, bodies);
    const state: PlatformState = { id, ...data, bodies };
    this.platforms.set(id, state);
    return state;
  }

  // Tracks how many platform contacts currently support each player from above
  // (a counter, rather than a boolean set on any contact, avoids flicker when
  // standing across overlapping segments — same approach as the prototype).
  //
  // A vertical contact normal alone isn't enough to mean "standing on": bumping
  // your head on a platform's underside also produces a near-vertical normal,
  // and would otherwise refresh the jump mid-air. Resolving which side the
  // platform is on requires checking the normal's sign relative to which body
  // in the pair is the player — Matter 0.20's SAT normal is *not* a simple
  // "bodyA -> bodyB" center-to-center vector. This sign convention was derived
  // empirically in the prototype (see prototype/index.html's isSupportingContact)
  // and carries over unchanged: for a genuinely-supporting contact, normal.y is
  // negative when the player is bodyA, and positive when the platform is bodyA.
  private registerGroundDetection() {
    const isSupportingContact = (pair: Matter.Pair, player: Matter.Body) =>
      pair.bodyA === player ? pair.collision.normal.y < -0.5 : pair.collision.normal.y > 0.5;

    const forEachSupportingContact = (
      event: Matter.IEventCollision<Matter.Engine>,
      visit: (state: PlayerState) => void
    ) => {
      for (const pair of event.pairs) {
        const { bodyA, bodyB } = pair;
        const player =
          bodyA.label === "player" && bodyB.label === "platform"
            ? bodyA
            : bodyB.label === "player" && bodyA.label === "platform"
              ? bodyB
              : null;
        if (!player || !isSupportingContact(pair, player)) continue;

        const connId = this.bodyIdToConnId.get(player.id);
        const state = connId && this.players.get(connId);
        if (state) visit(state);
      }
    };

    Matter.Events.on(this.engine, "collisionStart", (event) => {
      forEachSupportingContact(event, (state) => state.groundContacts++);
    });

    Matter.Events.on(this.engine, "collisionEnd", (event) => {
      forEachSupportingContact(event, (state) => {
        state.groundContacts = Math.max(0, state.groundContacts - 1);
      });
    });
  }

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    // The lobby join screen passes the player's chosen identity as connect-time
    // query params (?username=...&color=...) — see client.ts's joinRoom. Sanitize
    // before it ever reaches storage, broadcast, or rendering (GDD's "XSS via
    // Usernames" guidance), and store via setState per the GDD's "Connection
    // State" guidance so the identity travels with the connection object itself.
    const params = new URL(ctx.request.url).searchParams;
    const username = sanitizeUsername(params.get("username"));
    const color = sanitizeColor(params.get("color"));
    conn.setState({ username, color } satisfies ConnState);

    // Snapshot the world as it stands *before* this player is added, and send
    // it directly to just the joiner — so they see everyone already in motion
    // immediately, rather than waiting for (and being confused by) the next
    // regular tick's snapshot, which carries positions but no usernames.
    const world_state = {
      type: "world_state",
      players: [...this.players.entries()].map(([id, { body, username, color }]) => ({
        id,
        username,
        color,
        x: body.position.x,
        y: body.position.y,
      })),
      platforms: [...this.platforms.values()].map(({ id, points, color, owner }) => ({
        id,
        points,
        color,
        owner,
      })),
    };
    conn.send(JSON.stringify(world_state));

    const body = Matter.Bodies.circle(WORLD_WIDTH / 2, WORLD_HEIGHT / 2 - 200, PLAYER_RADIUS, {
      label: "player",
      friction: 0.05,
      frictionAir: 0.01,
      restitution: 0,
      inertia: Infinity, // locked rotation, same as the prototype's avatar
    });
    this.players.set(conn.id, {
      body,
      username,
      color,
      keys: { left: false, right: false, jump: false },
      groundContacts: 0,
      jumpHeld: false,
    });
    this.bodyIdToConnId.set(body.id, conn.id);
    Matter.World.add(this.engine.world, body);

    // Broadcast to *everyone*, including the joiner — that's how they learn
    // their own (sanitized/fallback-applied) identity (world_state only
    // describes existing players).
    this.room.broadcast(JSON.stringify({ type: "player_joined", id: conn.id, username, color }));
  }

  onClose(conn: Party.Connection) {
    const state = this.players.get(conn.id);
    if (!state) return;
    Matter.World.remove(this.engine.world, state.body);
    this.bodyIdToConnId.delete(state.body.id);
    this.players.delete(conn.id);
    this.lastDrawAt.delete(conn.id);
    this.room.broadcast(JSON.stringify({ type: "player_left", id: conn.id }));
  }

  async onMessage(message: string, sender: Party.Connection) {
    let data: unknown;
    try {
      data = JSON.parse(message);
    } catch {
      return; // drop malformed JSON silently, per the GDD's security requirements
    }

    if (isValidInput(data)) {
      const state = this.players.get(sender.id);
      if (state) state.keys = data.keys;
      return;
    }

    if (isValidDraw(data)) {
      await this.handleDraw(data, sender);
      return;
    }

    // anything else doesn't match a known shape — drop it silently
  }

  // Validates rate/cap limits (the GDD's "physics spam prevention"), creates
  // and persists the platform, then broadcasts it to every client — including
  // the drawer, so their own stroke becomes "real" via the same code path
  // everyone else's platforms arrive through (no special-cased local preview).
  private async handleDraw(data: { points: Point[]; color: string }, sender: Party.Connection) {
    const now = Date.now();
    const last = this.lastDrawAt.get(sender.id) ?? 0;
    if (now - last < DRAW_COOLDOWN_MS) return;

    const ownedCount = [...this.platforms.values()].filter((p) => p.owner === sender.id).length;
    if (ownedCount >= MAX_PLATFORMS_PER_PLAYER) return;

    this.lastDrawAt.set(sender.id, now);

    const id = makePlatformId();
    const platformData: PlatformData = { points: data.points, color: data.color, owner: sender.id };
    this.addPlatform(id, platformData);
    await this.room.storage.put(id, platformData);

    this.room.broadcast(JSON.stringify({ type: "platform_added", id, ...platformData }));
  }

  // Direct-velocity movement and a one-shot, ground-gated jump — identical
  // logic to the prototype's updatePlayer(), now driven by network input
  // instead of local keyboard state.
  private applyInput(state: PlayerState) {
    const grounded = state.groundContacts > 0;

    let vx = 0;
    if (state.keys.left) vx -= MOVE_SPEED;
    if (state.keys.right) vx += MOVE_SPEED;
    Matter.Body.setVelocity(state.body, { x: vx, y: state.body.velocity.y });

    if (state.keys.jump && !state.jumpHeld && grounded) {
      Matter.Body.setVelocity(state.body, { x: state.body.velocity.x, y: -JUMP_SPEED });
    }
    state.jumpHeld = state.keys.jump;
  }

  step() {
    for (const state of this.players.values()) this.applyInput(state);

    for (let i = 0; i < SUB_STEPS; i++) {
      Matter.Engine.update(this.engine, SUB_STEP_MS);
    }

    const players = [...this.players.entries()].map(([id, { body }]) => ({
      id,
      x: body.position.x,
      y: body.position.y,
      vx: body.velocity.x,
      vy: body.velocity.y,
    }));

    this.room.broadcast(
      JSON.stringify({ type: "snapshot", players, tick: this.tick++ })
    );
  }
}

Server satisfies Party.Worker;
