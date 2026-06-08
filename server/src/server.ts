import type * as Party from "partykit/server";
import Matter from "matter-js";

const TICK_MS = 50; // ~20Hz, per the GDD's server-authoritative tick rate
const SUB_STEP_MS = 1000 / 60;
const SUB_STEPS = Math.round(TICK_MS / SUB_STEP_MS); // step physics at ~60Hz internally — Matter warns above ~16.7ms deltas and larger steps risk tunneling through thin bodies
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;
const GROUND_THICKNESS = 40;
const WALL_THICKNESS = 40; // px — invisible boundary walls along the world's left/right/top edges (see onStart)
const PLAYER_RADIUS = 16;
const MOVE_SPEED = 5; // px/tick horizontal velocity while running — same feel as the prototype
const JUMP_SPEED = 11; // px/tick upward velocity applied on jump

const PLATFORM_THICKNESS = 10; // px — matches the prototype's SEGMENT_THICKNESS
const MAX_DRAW_POINTS = 500; // generous cap on a single stroke's (already RDP-simplified) point count
const DRAW_COOLDOWN_MS = 1000; // per the GDD's physics-spam guidance: max one new platform per player per second
// "Ink" budget — per the GDD's physics-spam guidance: cap how many physics
// bodies the room's whole shared canvas can hold at once. createPlatformBodies
// emits one body per consecutive point pair, so total segment count *is* total
// body count — and a live performance probe (a fresh isolated room, grown in
// batches while sampling the ~20Hz snapshot broadcast's actual cadence) found
// that's also almost exactly what determines whether Matter.Engine.update keeps
// up: a flat ~50ms tick held rock-steady through 1,960 segments/40 platforms,
// started jittering by 3,920/80 (10x the variance, a stray 97ms spike), and fell
// off a cliff at 5,586/114 (≈896ms mean — an ~18x stall) and beyond (zero ticks
// broadcast in a 10s window past ~144 platforms). 1200 sits with real margin
// below the first sign of strain — comfortably more than "200/player x a
// realistic handful of concurrent drawers" while staying far from the wall.
//
// This is *the room's* shared budget, not any one player's — reflecting that
// the cost it bounds (physics tick time) is a shared-room property too: one
// slow tick degrades the game for everyone in the room equally, regardless of
// who drew what. See sendInkUpdate for how players see the room's "ink left".
const MAX_SEGMENTS_PER_ROOM = 1200;
const ERASE_COOLDOWN_MS = 250; // per-connection rate limit on erase, per the GDD's general "Rate Limiting" guidance —
// erasing doesn't strain physics the way drawing does (it only ever removes bodies), so this is
// deliberately looser than DRAW_COOLDOWN_MS; it just keeps a spam-right-clicker from hammering
// storage.delete() and broadcast() rather than gating a gameplay mechanic. Segment-erase batches
// a whole drag gesture into one message (mirroring how `draw` batches a whole stroke), so this
// single per-message cooldown naturally gates "once per drag" rather than "once per segment" —
// no separate per-segment limiter needed.
const MAX_ERASE_HITS = 500; // generous cap on one batched erase message's segment-hit count — same
// order of magnitude as MAX_DRAW_POINTS, for the same reason: legitimate drags (even fast ones
// crossing several overlapping platforms) land nowhere near this; it only stops egregious abuse
const MAX_CHAT_LENGTH = 240; // generous for a quick line of chat — comfortably under anything that'd overwhelm the log; enforced here AND as the client's <input maxlength>, but this copy is the one that actually matters
const CHAT_COOLDOWN_MS = 400; // per-connection rate limit, per the GDD's "Rate Limiting" guidance — looser than DRAW_COOLDOWN_MS (chat never touches physics) but tight enough to block flooding; the same "spam guard, not a gameplay gate" posture ERASE_COOLDOWN_MS established
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

// Per the GDD's "XSS via Usernames and Chat" guidance: strip control characters
// and length-cap before a message ever reaches broadcast — canvas `fillText`
// doesn't parse HTML, but an unsanitized string could still spoof other UI text
// or blow past layout bounds. Unlike sanitizeUsername there's no placeholder
// fallback for empty input: a message that's blank after sanitizing (e.g. all
// whitespace, or all control characters) just isn't worth sending — handleChat
// drops it rather than broadcasting nothing meaningful.
function sanitizeChatText(raw: string): string {
  return raw.replace(CONTROL_CHARS, "").trim().slice(0, MAX_CHAT_LENGTH);
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

// A single segment hit: which platform, and which of its consecutive-point-pair
// segments (by index) the cursor crossed. The (platformId, segmentIndex) pair
// alone is enough to identify *which segment* — no further payload is trusted
// or needed. Note that, by this game's deliberate "shared whiteboard" design
// (anyone can erase anything), there is no owner check to bypass here: trusting
// a client-claimed id grants nothing beyond what the permission model already
// allows. The only things worth validating are the message shape and that each
// referenced platform/segment still exists (handleErase checks the latter,
// since "still exists" can only be answered against live server state).
function isValidEraseHit(hit: unknown): hit is { platformId: string; segmentIndex: number } {
  if (typeof hit !== "object" || hit === null) return false;
  const keys = Object.keys(hit);
  if (keys.length !== 2) return false;
  const { platformId, segmentIndex } = hit as Record<string, unknown>;
  return (
    typeof platformId === "string" &&
    typeof segmentIndex === "number" &&
    Number.isInteger(segmentIndex) &&
    segmentIndex >= 0
  );
}

// `hits` batches a whole right-click-drag gesture into one message — exactly
// how `draw` already batches a whole stroke into one message on mouseup —
// rather than sending one message per segment crossed. This is what lets the
// existing per-message ERASE_COOLDOWN_MS keep working unchanged as a "once per
// gesture" gate (see its comment) instead of needing a new per-segment limiter.
function isValidErase(data: unknown): data is { type: "erase"; hits: { platformId: string; segmentIndex: number }[] } {
  if (typeof data !== "object" || data === null) return false;
  const { type, hits } = data as Record<string, unknown>;
  if (type !== "erase") return false;
  if (!Array.isArray(hits) || hits.length === 0 || hits.length > MAX_ERASE_HITS) return false;
  return hits.every(isValidEraseHit);
}

// Chat messages carry only the text — identity (username/color) is read from
// this connection's own server-tracked PlayerState in handleChat, never trusted
// from the message itself, so there's nothing here for a client to spoof.
function isValidChat(data: unknown): data is { type: "chat"; text: string } {
  if (typeof data !== "object" || data === null) return false;
  const { type, text } = data as Record<string, unknown>;
  return type === "chat" && typeof text === "string";
}

// Upper-bound estimate of how many physics bodies a point array will produce —
// createPlatformBodies emits one rectangle per consecutive point pair, skipping
// only true degenerate (sub-half-pixel) ones, so points.length-1 never
// under-counts the real cost. Deliberately *not* derived by actually building
// the bodies (wasteful when a draw might get rejected) or counting
// `addPlatform`'s output after the fact (would mean checking the budget too
// late) — this is the same cheap arithmetic both the quota check (handleDraw)
// and the "ink left" readout (sendInkUpdate) share, so they can't drift apart.
function segmentCount(points: Point[]): number {
  return Math.max(0, points.length - 1);
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

// Splits a point array around a set of removed segment indices into the
// surviving contiguous runs — e.g. [A,B,C,D,E] (segments 0=A-B, 1=B-C, 2=C-D,
// 3=D-E) with segment 1 removed becomes [[A,B],[C,D,E]]; removing segment 0
// from a 2-point platform yields [] (the lone survivor B can't form a
// platform by itself, so the whole thing vanishes). A run that collapses to a
// single point — an orphaned endpoint, or both segments touching an interior
// point getting erased — is discarded the same way: one point has no segments
// and so no physics cost, exactly like an (already-rejected) 1-point draw.
function splitPoints(points: Point[], removedSegments: Set<number>): Point[][] {
  const pieces: Point[][] = [];
  let runStart = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (!removedSegments.has(i)) continue;
    const piece = points.slice(runStart, i + 1);
    if (piece.length >= 2) pieces.push(piece);
    runStart = i + 1;
  }
  const tail = points.slice(runStart);
  if (tail.length >= 2) pieces.push(tail);
  return pieces;
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
  lastEraseAt = new Map<string, number>(); // connection id -> ms timestamp, for rate limiting
  lastChatAt = new Map<string, number>(); // connection id -> ms timestamp, for rate limiting
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

    // Invisible boundary walls along the world's left/right/top edges. Without
    // them a player can simply run — or, given a tall enough drawn structure,
    // climb — straight past the visible canvas and disappear off-screen with
    // no way back (the world has no camera/scrolling; everything within
    // [0, WORLD_WIDTH] x [0, WORLD_HEIGHT] is the whole stage). Each wall sits
    // just outside the world so its *inner* face is flush with the edge
    // (x=0, x=WORLD_WIDTH, y=0), and is overlength to cover the corners.
    //
    // They reuse label "platform" rather than introducing a new label: the
    // empirically-derived normal-sign check in registerGroundDetection already
    // distinguishes "resting on top of" from "bumping into the side/underside
    // of" *any* static body purely from contact geometry, so a side wall or
    // ceiling can never be mistaken for ground to stand on and re-arm a jump.
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

    Matter.World.add(this.engine.world, [ground, leftWall, rightWall, ceiling]);

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

    // The room's shared ink budget doesn't change just because someone joined —
    // but the joiner's own UI needs *some* numbers immediately rather than a
    // placeholder until the next draw/erase broadcast happens to fire. A plain
    // conn.send (not the broadcast sendInkUpdate uses elsewhere) is correct
    // here specifically because nothing actually changed for anyone else.
    conn.send(JSON.stringify({ type: "ink", used: this.totalSegments(), max: MAX_SEGMENTS_PER_ROOM }));

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
    this.lastEraseAt.delete(conn.id);
    this.lastChatAt.delete(conn.id);
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

    if (isValidErase(data)) {
      await this.handleErase(data, sender);
      return;
    }

    if (isValidChat(data)) {
      this.handleChat(data, sender);
      return;
    }

    // anything else doesn't match a known shape — drop it silently
  }

  // Sums the segment cost of every platform currently in the room — derived
  // fresh from this.platforms each time, the same single-source-of-truth
  // approach the erase feature's ownedCount established (see CLAUDE.md/TODO.md's
  // "quota release" verification note: no separate counter to fall out of sync
  // with what's actually in the world). Backs both the budget check in
  // handleDraw and the "ink left" readout in sendInkUpdate. Room-wide rather
  // than per-owner because the cost it bounds — physics tick time — is a
  // room-wide property: it's spent on *every* body regardless of who drew it.
  private totalSegments(): number {
    let total = 0;
    for (const platform of this.platforms.values()) total += segmentCount(platform.points);
    return total;
  }

  // Tells the room how much of its shared segment "ink" budget is left —
  // broadcast (not targeted: this is shared room state, the same "no
  // special-cased local preview" pattern platform_added/platform_removed/chat
  // all follow) right after world_state on join (so a joiner's UI has a real
  // baseline immediately, never a placeholder) and again after anything changes
  // the total: every accepted draw and every erase, by anyone, of anything.
  private sendInkUpdate() {
    this.room.broadcast(JSON.stringify({ type: "ink", used: this.totalSegments(), max: MAX_SEGMENTS_PER_ROOM }));
  }

  // Validates rate/cap limits (the GDD's "physics spam prevention"), creates
  // and persists the platform, then broadcasts it to every client — including
  // the drawer, so their own stroke becomes "real" via the same code path
  // everyone else's platforms arrive through (no special-cased local preview).
  private async handleDraw(data: { points: Point[]; color: string }, sender: Party.Connection) {
    const now = Date.now();
    const last = this.lastDrawAt.get(sender.id) ?? 0;
    if (now - last < DRAW_COOLDOWN_MS) return;

    const newSegments = segmentCount(data.points);
    if (this.totalSegments() + newSegments > MAX_SEGMENTS_PER_ROOM) return;

    this.lastDrawAt.set(sender.id, now);

    const id = makePlatformId();
    const platformData: PlatformData = { points: data.points, color: data.color, owner: sender.id };
    this.addPlatform(id, platformData);
    await this.room.storage.put(id, platformData);

    this.room.broadcast(JSON.stringify({ type: "platform_added", id, ...platformData }));
    this.sendInkUpdate();
  }

  // Erases at the *segment* level, not the whole-platform level: a batch of
  // (platformId, segmentIndex) hits — one right-click-drag gesture's worth,
  // see isValidErase — gets grouped by platform, each platform's hit segments
  // are cut out via splitPoints, and whatever survives on either side becomes
  // its own fresh platform (new id, but the *original* color/owner carried
  // through as passive provenance — see the PlatformData/owner note in
  // CLAUDE.md for why that field stays even though no UI reads it anymore).
  // Reusing the existing platform_removed/platform_added message types for
  // splits — rather than inventing an atomic platform_split — keeps the
  // protocol surface minimal: delivery over one ordered WebSocket already
  // guarantees clients see "old gone, new pieces in" in that order, with no
  // real risk of an inconsistent intermediate state to guard against.
  //
  // By this game's deliberate "anyone can erase anything" design (see
  // CLAUDE.md), there's no owner check: any connection may name any existing
  // platform/segment. The per-connection cooldown — now naturally gating
  // "once per drag gesture" since a whole drag arrives as one message (see
  // ERASE_COOLDOWN_MS's comment) — is the only gate, and (mirroring the old
  // single-id version's behavior) is only consumed when there's real work to
  // do, not on a batch that turns out to name nothing live.
  private async handleErase(data: { hits: { platformId: string; segmentIndex: number }[] }, sender: Party.Connection) {
    const now = Date.now();
    const last = this.lastEraseAt.get(sender.id) ?? 0;
    if (now - last < ERASE_COOLDOWN_MS) return;

    // Group hits by platform, deduping segment indices — a drag can cross the
    // same segment more than once (e.g. doubling back), and splitPoints wants
    // a Set of indices, not a list with repeats.
    const hitsByPlatform = new Map<string, Set<number>>();
    for (const hit of data.hits) {
      let segments = hitsByPlatform.get(hit.platformId);
      if (!segments) hitsByPlatform.set(hit.platformId, (segments = new Set()));
      segments.add(hit.segmentIndex);
    }

    let didErase = false;
    for (const [platformId, removedSegments] of hitsByPlatform) {
      const platform = this.platforms.get(platformId);
      if (!platform) continue; // already erased (e.g. by someone else mid-drag), or never existed

      // A segment index only makes sense against this platform's *current*
      // point array — if anything's out of range, the client's view of this
      // platform is stale (it changed shape since the cursor crossed it), so
      // skip the whole platform's hits rather than guess at a mismatched cut.
      const segCount = platform.points.length - 1;
      let inRange = true;
      for (const index of removedSegments) {
        if (index >= segCount) { inRange = false; break; }
      }
      if (!inRange) continue;

      if (!didErase) { didErase = true; this.lastEraseAt.set(sender.id, now); }

      Matter.World.remove(this.engine.world, platform.bodies);
      this.platforms.delete(platformId);
      await this.room.storage.delete(platformId);
      this.room.broadcast(JSON.stringify({ type: "platform_removed", id: platformId }));

      for (const piece of splitPoints(platform.points, removedSegments)) {
        const pieceId = makePlatformId();
        const pieceData: PlatformData = { points: piece, color: platform.color, owner: platform.owner };
        this.addPlatform(pieceId, pieceData);
        await this.room.storage.put(pieceId, pieceData);
        this.room.broadcast(JSON.stringify({ type: "platform_added", id: pieceId, ...pieceData }));
      }
    }

    if (didErase) this.sendInkUpdate();
  }

  // Sanitizes and rate-limits a chat message, then broadcasts it to everyone —
  // including the sender, the same "no special-cased local preview" pattern
  // handleDraw/handleErase established for platforms. Username/color are read
  // from this connection's own tracked PlayerState (set once at onConnect,
  // already sanitized) rather than the message itself — the client supplies
  // only the text, so there's nothing here for it to spoof. Deliberately not
  // persisted: unlike platforms — part of the shared, persistent world that
  // must survive a restart — chat is just the room's live conversation, with
  // no "restore on restart" expectation (contrast handleDraw's storage.put).
  private handleChat(data: { text: string }, sender: Party.Connection) {
    const now = Date.now();
    const last = this.lastChatAt.get(sender.id) ?? 0;
    if (now - last < CHAT_COOLDOWN_MS) return;

    const text = sanitizeChatText(data.text);
    if (text.length === 0) return; // nothing worth broadcasting once sanitized (e.g. all-whitespace)

    const state = this.players.get(sender.id);
    if (!state) return; // shouldn't happen on a live connection — guards a theoretical onMessage/onClose race

    this.lastChatAt.set(sender.id, now);

    this.room.broadcast(
      JSON.stringify({ type: "chat", id: sender.id, username: state.username, color: state.color, text })
    );
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
