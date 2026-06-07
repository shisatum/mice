import "./styles.css";

import PartySocket from "partysocket";

declare const PARTYKIT_HOST: string;

// Mirrors the world constants the room uses to build its physics scene —
// keeping the client dumb (it only renders what the server tells it).
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;
const GROUND_THICKNESS = 40;
const PLAYER_RADIUS = 16;
const PLATFORM_THICKNESS = 10; // matches the server's PLATFORM_THICKNESS / the prototype's SEGMENT_THICKNESS
const MIN_POINT_DISTANCE = 4; // px — minimum spacing between captured drawing points, matches the prototype
const RDP_EPSILON = 2; // px — Ramer-Douglas-Peucker tolerance; the bandwidth optimization the prototype deferred (see CLAUDE.md)
const ERASE_HIT_TOLERANCE = PLATFORM_THICKNESS / 2 + 6; // px — how close a right-click must land to a platform's stroke to erase it; a little forgiveness beyond the visual half-thickness so thin/precise strokes stay easy to target
const OWN_PLATFORM_HIGHLIGHT = "#6ee7b7"; // matches drawPlayers' "(you)" outline — reused here so "this is yours" reads as one consistent visual language

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
canvas.width = WORLD_WIDTH;
canvas.height = WORLD_HEIGHT;
const ctx = canvas.getContext("2d")!;

// The world has a fixed resolution (it's the server's coordinate space); scale
// the canvas element to fit whatever viewport it's shown in via CSS, keeping
// its internal drawing-buffer size — and therefore the server's coordinates —
// untouched.
function fitCanvasToViewport() {
  const scale = Math.min(window.innerWidth / WORLD_WIDTH, window.innerHeight / WORLD_HEIGHT);
  // Round to whole CSS pixels — a fixed-resolution canvas stretched to a
  // sub-pixel size gets blurred by the browser's scaling/anti-aliasing.
  canvas.style.width = `${Math.round(WORLD_WIDTH * scale)}px`;
  canvas.style.height = `${Math.round(WORLD_HEIGHT * scale)}px`;
}
window.addEventListener("resize", fitCanvasToViewport);
fitCanvasToViewport();

// Color palette — a small preset swatch picker (the GDD's draw message format
// always includes a color; a full custom picker is more UI than this whiteboard
// needs right now). Built in JS rather than index.html to keep the feature
// self-contained in one place, matching how keyboard capture lives here too.
const PALETTE_COLORS = ["#a3c4f3", "#f6a5c0", "#ffd479", "#8fd3b6", "#c5a3f3", "#f3a3a3"];
let selectedColor = PALETTE_COLORS[0];

const palette = document.createElement("div");
palette.id = "palette";
for (const color of PALETTE_COLORS) {
  const swatch = document.createElement("button");
  swatch.classList.add("swatch");
  swatch.style.backgroundColor = color;
  swatch.setAttribute("aria-label", `Draw in ${color}`);
  swatch.classList.toggle("selected", color === selectedColor);
  swatch.addEventListener("click", () => {
    selectedColor = color;
    for (const el of palette.querySelectorAll(".swatch")) el.classList.remove("selected");
    swatch.classList.add("selected");
  });
  palette.appendChild(swatch);
}
document.body.appendChild(palette);

type PlayerSnapshot = { id: string; x: number; y: number; vx: number; vy: number };
type Point = { x: number; y: number };
type Platform = { id: string; points: Point[]; color: string; owner: string };
type Identity = { username: string; color: string };

const DEFAULT_AVATAR_COLOR = "#f4c95d"; // matches the server's DEFAULT_AVATAR_COLOR fallback

let latestPlayers: PlayerSnapshot[] = [];

// Identities (username + chosen avatar color) arrive separately from position
// snapshots (world_state on join, player_joined/player_left as the roster
// changes) — keyed by connection id so they can be looked up while rendering
// each avatar from latestPlayers.
const roster = new Map<string, Identity>();

// Platforms arrive via world_state (on join) and platform_added (live draws),
// keyed by id — the server is the only source of truth for what's "real";
// rendering happens purely by regenerating geometry from each one's point array.
const platforms = new Map<string, Platform>();

// Right-click hit-testing: finds whichever platform's stroke passes closest to
// `point`, within ERASE_HIT_TOLERANCE — checking every consecutive segment pair
// the same way drawPlatformPath renders them, so "what you can click" always
// matches "what you see". Picking by closest distance (rather than e.g. most-
// recently-drawn / topmost) is deliberate: Map iteration order reflects each
// client's own arrival order for these platforms — via world_state's storage
// listing for pre-existing ones, live broadcasts for new ones — which can
// differ between clients, so there's no globally-consistent "z-order" to pick
// by. Closest-to-cursor is both simpler and more intuitive to aim.
function findPlatformAt(point: Point): Platform | null {
  let closest: Platform | null = null;
  let closestDist = ERASE_HIT_TOLERANCE;
  for (const platform of platforms.values()) {
    for (let i = 0; i < platform.points.length - 1; i++) {
      const dist = pointToSegmentDistance(point, platform.points[i], platform.points[i + 1]);
      if (dist < closestDist) {
        closestDist = dist;
        closest = platform;
      }
    }
  }
  return closest;
}

// Narrows an arbitrary JSON-decoded value down to "a non-null object whose
// string-keyed properties we can safely probe" — the minimal common shape
// every server message must have before we can even look at its `type`.
function asRecord(data: unknown): Record<string, unknown> | null {
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

// Shape-check vocabulary for inbound server messages — see CLAUDE.md's
// "Client-side validation posture toward the server" convention. The server
// is the sole source of truth and already deep-validates every message's
// fields before it ever broadcasts (gdd_partykit.md's "Schema Validation"/
// "Numbers Only" sections), so the client's job is only to confirm a message
// has the *shape* its declared type promises — right top-level keys, roughly-
// right primitive types — not to re-derive the server's own per-field
// validation a second time (two independent copies of "what does a valid
// Platform look like" will only drift apart over time). Anything that claims
// a known `type` but fails even this minimal check isn't "untrusted input"
// (filtering that is the server's job): it's a bug worth knowing about — a
// stale client, a version-skewed deploy, a protocol typo — so it's logged
// rather than silently dropped.
const isString = (v: unknown): v is string => typeof v === "string";

function warnUnexpectedShape(type: string, msg: Record<string, unknown>) {
  console.warn(`Ignoring "${type}" message from server — unexpected shape:`, msg);
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function perpendicularDistance(point: Point, lineStart: Point, lineEnd: Point): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  if (dx === 0 && dy === 0) return distance(point, lineStart);
  const t = ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / (dx * dx + dy * dy);
  return distance(point, { x: lineStart.x + t * dx, y: lineStart.y + t * dy });
}

// Distance from a point to a finite *segment* (unlike perpendicularDistance,
// which measures to the infinite line through the endpoints) — `t` is clamped
// to [0, 1] so the nearest point can't fall beyond either endpoint. This is
// what makes right-click hit-testing feel right: clicking just past the tip
// of a stroke shouldn't still register as "on" its underlying line.
function pointToSegmentDistance(point: Point, segStart: Point, segEnd: Point): number {
  const dx = segEnd.x - segStart.x;
  const dy = segEnd.y - segStart.y;
  if (dx === 0 && dy === 0) return distance(point, segStart);
  const t = Math.max(0, Math.min(1, ((point.x - segStart.x) * dx + (point.y - segStart.y) * dy) / (dx * dx + dy * dy)));
  return distance(point, { x: segStart.x + t * dx, y: segStart.y + t * dy });
}

// Ramer-Douglas-Peucker: recursively discards points that fall within `epsilon`
// of the straight line between the current segment's endpoints, keeping only
// those that meaningfully change the path's shape. This is the network-bandwidth
// optimization the prototype deliberately deferred (see CLAUDE.md's conventions) —
// it matters now because every point gets transmitted and stored.
function rdpSimplify(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;

  const first = points[0];
  const last = points[points.length - 1];
  let maxDist = 0;
  let maxIndex = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIndex = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIndex + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIndex), epsilon);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

// The world has a fixed resolution but the canvas element is CSS-scaled to fit
// the viewport (see fitCanvasToViewport), so client coordinates must be
// converted back into world/buffer space for both drawing capture and physics.
function canvasPoint(event: MouseEvent): Point {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) * canvas.width) / rect.width,
    y: ((event.clientY - rect.top) * canvas.height) / rect.height,
  };
}

// In-progress freehand stroke — module-level so the render loop's
// drawInProgressPath can preview it regardless of where capture is wired up.
let drawing: Point[] | null = null;

let conn: PartySocket;

// Opens the room connection and wires up everything that depends on it —
// called once the join screen has collected the player's identity. Keeping
// this deferred (rather than connecting at module load) is what lets the
// lobby pick a room and identity *before* the world starts simulating for us.
function startGame(roomId: string, identity: Identity) {
  conn = new PartySocket({
    host: PARTYKIT_HOST,
    room: roomId,
    query: { username: identity.username, color: identity.color },
  });

  // Keyboard capture — sends an `input` message only when the {left,right,jump}
  // state actually changes, rather than on every keydown/keyup repeat. The
  // render loop stays purely snapshot-driven; this client does no local physics.
  const keys = { left: false, right: false, jump: false };

  function setKey(code: string, value: boolean) {
    let changed = false;
    switch (code) {
      case "ArrowLeft":
      case "KeyA":
        changed = keys.left !== value;
        keys.left = value;
        break;
      case "ArrowRight":
      case "KeyD":
        changed = keys.right !== value;
        keys.right = value;
        break;
      case "ArrowUp":
      case "KeyW":
      case "Space":
        changed = keys.jump !== value;
        keys.jump = value;
        break;
    }
    if (changed) conn.send(JSON.stringify({ type: "input", keys }));
  }

  window.addEventListener("keydown", (event) => setKey(event.code, true));
  window.addEventListener("keyup", (event) => setKey(event.code, false));

  // Drawing capture — mousedown/mousemove/mouseup into a raw {x,y}[] path,
  // mirroring the prototype, then RDP-simplified and sent as a `draw` message
  // on stroke completion.
  canvas.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return; // only the primary (left) button draws — right-click is reserved for erasing (see contextmenu below)
    drawing = [canvasPoint(event)];
  });

  canvas.addEventListener("mousemove", (event) => {
    if (!drawing) return;
    const p = canvasPoint(event);
    if (distance(drawing[drawing.length - 1], p) >= MIN_POINT_DISTANCE) {
      drawing.push(p);
    }
  });

  function finishDrawing() {
    if (!drawing) return;
    const path = drawing;
    drawing = null;
    if (path.length < 2) return;
    const simplified = rdpSimplify(path, RDP_EPSILON);
    if (simplified.length >= 2) {
      conn.send(JSON.stringify({ type: "draw", points: simplified, color: selectedColor }));
    }
  }

  window.addEventListener("mouseup", finishDrawing);

  // Erasing — right-click a platform to remove it. Per this game's "shared
  // whiteboard" design, anyone can erase anything (see CLAUDE.md for the
  // rationale and trade-offs); the server is the final authority and will
  // reject malformed or rate-limit-violating attempts regardless of what this
  // sends. preventDefault() suppresses the native context menu — there's
  // nothing on this canvas that needs it.
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    const target = findPlatformAt(canvasPoint(event));
    if (target) conn.send(JSON.stringify({ type: "erase", id: target.id }));
  });

  conn.addEventListener("message", (event) => {
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      console.warn("Ignoring malformed (non-JSON) message from server:", event.data);
      return;
    }
    const msg = asRecord(data);
    if (!msg) {
      console.warn("Ignoring non-object message from server:", data);
      return;
    }

    // Every case below follows the same "right shape, or warn" structure —
    // see the isString/warnUnexpectedShape doc comment above for why this
    // uniformity (and the logging) matters more than it might look like it does.
    switch (msg.type) {
      case "snapshot": {
        if (Array.isArray(msg.players)) {
          latestPlayers = msg.players as PlayerSnapshot[];
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "world_state": {
        // Full roster/platform replacement on join — replaces any stale entries
        // from a previous connection to this room (e.g. after a reconnect).
        // Both arrays are required together: a message that's half-valid is
        // just as much "not the shape we expected" as one that's all wrong.
        if (Array.isArray(msg.players) && Array.isArray(msg.platforms)) {
          roster.clear();
          for (const p of msg.players as { id: string; username: string; color: string }[]) {
            roster.set(p.id, { username: p.username, color: p.color });
          }
          platforms.clear();
          for (const p of msg.platforms as Platform[]) platforms.set(p.id, p);
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "player_joined": {
        if (isString(msg.id) && isString(msg.username) && isString(msg.color)) {
          roster.set(msg.id, { username: msg.username, color: msg.color });
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "player_left": {
        if (isString(msg.id)) {
          roster.delete(msg.id);
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "platform_added": {
        if (isString(msg.id) && Array.isArray(msg.points) && isString(msg.color) && isString(msg.owner)) {
          platforms.set(msg.id, { id: msg.id, points: msg.points as Point[], color: msg.color, owner: msg.owner });
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "platform_removed": {
        if (isString(msg.id)) {
          platforms.delete(msg.id);
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      default:
        console.warn("Ignoring message from server with unrecognized type:", msg.type);
    }
  });

  requestAnimationFrame(frame);
}

function drawGround() {
  ctx.fillStyle = "#3a3f4b";
  ctx.fillRect(0, WORLD_HEIGHT - GROUND_THICKNESS, WORLD_WIDTH, GROUND_THICKNESS);
}

// Strokes a point array as a thick rounded path — purely cosmetic, mirroring
// the prototype's drawPlatform. Physics fidelity comes from the server's
// deterministically-generated bodies (see CLAUDE.md's rendering convention);
// this just needs to *look* like the same shape.
function drawPlatformPath(points: Point[], color: string, isOwn = false) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // A dashed halo, in the same accent color drawPlayers uses to mark "(you)",
  // stroked wider and underneath the platform's own color — so you can tell at
  // a glance which strokes are yours (and therefore which ones right-clicking
  // to erase would free up against MAX_PLATFORMS_PER_PLAYER) without changing
  // how the platform itself looks to anyone, including its owner.
  if (isOwn) {
    ctx.save();
    ctx.strokeStyle = OWN_PLATFORM_HIGHLIGHT;
    ctx.lineWidth = PLATFORM_THICKNESS + 6;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.restore();
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = PLATFORM_THICKNESS;
  ctx.stroke();
}

function drawPlatforms() {
  for (const platform of platforms.values()) {
    drawPlatformPath(platform.points, platform.color, platform.owner === conn.id);
  }
}

// Live preview of the in-progress stroke, in the locally-selected color —
// the server has the final say (this redraws from `platforms` once it
// broadcasts `platform_added`, including back to the drawer).
function drawInProgressPath() {
  if (drawing) drawPlatformPath(drawing, selectedColor);
}

function drawPlayers() {
  for (const player of latestPlayers) {
    const isMe = player.id === conn.id;
    const identity = roster.get(player.id);

    ctx.beginPath();
    ctx.arc(player.x, player.y, PLAYER_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = identity?.color ?? DEFAULT_AVATAR_COLOR;
    ctx.fill();
    ctx.lineWidth = isMe ? 3 : 2;
    ctx.strokeStyle = isMe ? "#6ee7b7" : "#1b1d23";
    ctx.stroke();

    if (identity) {
      ctx.fillStyle = "#c8ccd6";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(isMe ? `${identity.username} (you)` : identity.username, player.x, player.y - PLAYER_RADIUS - 6);
    }
  }
}

function frame() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGround();
  drawPlatforms();
  drawPlayers();
  drawInProgressPath();
  requestAnimationFrame(frame);
}

// Lobby — collects identity (name + avatar color) and a room before connecting.
// Per the GDD's "Room & Lobby System": room IDs are short, shareable codes
// generated client-side and carried in the URL (?room=XYZABC) so a player can
// hand the link to a friend and land in the same room.
const MAX_USERNAME_LENGTH = 20; // mirrors the server's MAX_USERNAME_LENGTH
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I/L
const ROOM_CODE_PATTERN = /^[A-Z0-9]{1,12}$/;

function generateRoomCode(): string {
  let code = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    code += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
  }
  return code;
}

function roomCodeFromUrl(): string | null {
  const raw = new URLSearchParams(location.search).get("room");
  if (!raw) return null;
  const normalized = raw.trim().toUpperCase();
  return ROOM_CODE_PATTERN.test(normalized) ? normalized : null;
}

let selectedAvatarColor = PALETTE_COLORS[3]; // a green, distinct from the platform palette's default blue

function buildJoinScreen() {
  const overlay = document.createElement("div");
  overlay.id = "join-screen";

  const card = document.createElement("form");
  card.id = "join-card";

  const title = document.createElement("h1");
  title.textContent = "Mouse";
  card.appendChild(title);

  const tagline = document.createElement("p");
  tagline.textContent = "A whiteboard where everyone's mouse can run and jump on whatever gets drawn.";
  card.appendChild(tagline);

  const nameLabel = document.createElement("label");
  nameLabel.textContent = "Name";
  // No id: the <label> wraps this input directly (an implicit label
  // association — no `for`/`id` pairing needed), and nothing else looks it up.
  const nameInput = document.createElement("input");
  nameInput.maxLength = MAX_USERNAME_LENGTH;
  nameInput.placeholder = "Cheddar";
  nameInput.autocomplete = "off";
  nameLabel.appendChild(nameInput);
  card.appendChild(nameLabel);

  const colorLabel = document.createElement("div");
  colorLabel.classList.add("join-field-label");
  colorLabel.textContent = "Color";
  card.appendChild(colorLabel);

  // No id here: nothing looks this element up by id, and ".swatch-row" alone
  // already carries all of its styling (see CLAUDE.md's "id vs. class" — an id
  // with neither a CSS rule nor a lookup is just an unused name to track).
  const colorPicker = document.createElement("div");
  colorPicker.classList.add("swatch-row");
  for (const color of PALETTE_COLORS) {
    const swatch = document.createElement("button");
    swatch.type = "button";
    swatch.classList.add("swatch");
    swatch.style.backgroundColor = color;
    swatch.setAttribute("aria-label", `Use avatar color ${color}`);
    swatch.classList.toggle("selected", color === selectedAvatarColor);
    swatch.addEventListener("click", () => {
      selectedAvatarColor = color;
      for (const el of colorPicker.querySelectorAll(".swatch")) el.classList.remove("selected");
      swatch.classList.add("selected");
    });
    colorPicker.appendChild(swatch);
  }
  card.appendChild(colorPicker);

  const roomLabel = document.createElement("label");
  roomLabel.textContent = "Room code";
  // Same reasoning as nameInput above — implicitly labeled, never looked up.
  const roomInput = document.createElement("input");
  roomInput.maxLength = 12;
  roomInput.autocomplete = "off";
  roomInput.value = roomCodeFromUrl() ?? generateRoomCode();
  roomLabel.appendChild(roomInput);
  card.appendChild(roomLabel);

  const hint = document.createElement("p");
  hint.classList.add("join-hint");
  hint.textContent = "Share the room code (or this page's URL) with friends to play together.";
  card.appendChild(hint);

  const submit = document.createElement("button");
  submit.type = "submit";
  submit.id = "join-submit";
  submit.textContent = "Play";
  card.appendChild(submit);

  card.addEventListener("submit", (event) => {
    event.preventDefault();

    const username = nameInput.value.trim().slice(0, MAX_USERNAME_LENGTH);
    const typedRoom = roomInput.value.trim().toUpperCase().slice(0, 12);
    const roomCode = ROOM_CODE_PATTERN.test(typedRoom) ? typedRoom : generateRoomCode();

    const url = new URL(location.href);
    url.searchParams.set("room", roomCode);
    history.replaceState(null, "", url);

    overlay.remove();
    startGame(roomCode, { username, color: selectedAvatarColor });
  });

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  nameInput.focus();
}

buildJoinScreen();
