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
const ERASE_PREVIEW_COLOR = "#ff6b6b"; // a "danger" red, deliberately outside PALETTE_COLORS' pastel set (and distinct from the "(you)" green) — communicates "about to be removed," not "an avatar/platform color choice"
const MAX_CHAT_LENGTH = 240; // mirrors the server's MAX_CHAT_LENGTH — caps the <input> so nothing gets typed that the server would just truncate anyway

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
// ROYGBIV-ordered (Indigo dropped — at pastel saturation/lightness it reads as
// indistinguishable from Blue/Violet, a well-known critique of Newton's 7-way
// split; six evenly-spaced hues give better at-a-glance separation than seven
// crowded ones). Keeps Yellow/Green/Blue/Violet from the old palette — they
// were never the problem — and replaces only the two near-identical "reds"
// (#f6a5c0 a pink, #f3a3a3 a salmon — easy to confuse at a glance) with one
// clear Red plus a new Orange to complete the spectrum. Hues land roughly at
// 5°/27°/41°/154°/219°/262°, each ~15-65° from its neighbors — enough gap to
// stay distinct while keeping the same soft pastel character throughout.
const PALETTE_COLORS = ["#f4978e", "#f7a663", "#ffd479", "#8fd3b6", "#a3c4f3", "#c5a3f3"];
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

// A line in the chat log — either a real chat message (rendered as a colored
// username + text, mirroring how avatars show identity) or a system note for
// join/leave events (rendered muted/italic, like .join-hint). System entries
// are derived client-side from player_joined/player_left — see the chat setup
// in startGame for why that's preferable to a dedicated protocol message.
type ChatEntry =
  | { kind: "chat"; username: string; color: string; text: string }
  | { kind: "system"; text: string };

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

// Right-click hit-testing: finds whichever *segment*, across every platform,
// passes closest to `point` within ERASE_HIT_TOLERANCE — checking each
// consecutive point pair the same way drawPlatformPath renders them, so "what
// you can click" always matches "what you see". Picking by closest distance
// (rather than e.g. most-recently-drawn / topmost) is deliberate: Map
// iteration order reflects each client's own arrival order for these platforms
// — via world_state's storage listing for pre-existing ones, live broadcasts
// for new ones — which can differ between clients, so there's no globally-
// consistent "z-order" to pick by. Closest-to-cursor is both simpler and more
// intuitive to aim. Returns the segment's *index within its platform* (not the
// segment's geometry) — that's what the server needs to cut the right piece
// out of the right platform's point array (see splitPoints server-side).
function findSegmentAt(point: Point): { platformId: string; segmentIndex: number } | null {
  let closest: { platformId: string; segmentIndex: number } | null = null;
  let closestDist = ERASE_HIT_TOLERANCE;
  for (const platform of platforms.values()) {
    for (let i = 0; i < platform.points.length - 1; i++) {
      const dist = pointToSegmentDistance(point, platform.points[i], platform.points[i + 1]);
      if (dist < closestDist) {
        closestDist = dist;
        closest = { platformId: platform.id, segmentIndex: i };
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
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

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

// Right-click-drag erase capture: a platformId → segmentIndex-set accumulator,
// alive only for the duration of one drag gesture (null between gestures,
// mirroring `drawing`'s null-when-idle convention). Every segment the cursor
// crosses gets recorded — Sets dedupe a drag doubling back over itself — and
// on release the whole accumulated batch goes out as ONE `erase` message,
// exactly how `drawing` collects a whole stroke before sending one `draw`.
let erasing: Map<string, Set<number>> | null = null;

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
    if (chatOpen) return; // the chat input owns the keyboard while it's open — see the chat setup further down
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
    if (event.button === 2) {
      // Right button starts an erase drag — see `erasing`'s declaration and
      // the contextmenu listener below (which only suppresses the native menu;
      // the actual hit-testing lives here and in mousemove/mouseup, exactly
      // mirroring how drawing capture spans mousedown/mousemove/mouseup).
      erasing = new Map();
      recordEraseHit(canvasPoint(event));
      return;
    }
    if (event.button !== 0) return; // only the primary (left) button draws
    drawing = [canvasPoint(event)];
  });

  canvas.addEventListener("mousemove", (event) => {
    if (erasing) recordEraseHit(canvasPoint(event));
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

  // Records one hit-tested point into the in-progress erase-drag accumulator —
  // shared by the initial mousedown (so a plain right-click-without-dragging
  // still erases something) and every subsequent mousemove while dragging.
  function recordEraseHit(point: Point) {
    if (!erasing) return;
    const hit = findSegmentAt(point);
    if (!hit) return;
    let segments = erasing.get(hit.platformId);
    if (!segments) erasing.set(hit.platformId, (segments = new Set()));
    segments.add(hit.segmentIndex);
  }

  // Flushes the accumulated drag as ONE batched `erase` message — mirroring
  // finishDrawing's "collect the whole gesture, send once on release" shape.
  // The server is the final authority and will reject anything malformed or
  // rate-limit-violating regardless of what this sends (see CLAUDE.md's
  // "shared whiteboard"/"anyone can erase anything" rationale).
  function finishErasing() {
    if (!erasing) return;
    const hits: { platformId: string; segmentIndex: number }[] = [];
    for (const [platformId, segments] of erasing) {
      for (const segmentIndex of segments) hits.push({ platformId, segmentIndex });
    }
    erasing = null;
    if (hits.length > 0) conn.send(JSON.stringify({ type: "erase", hits }));
  }

  window.addEventListener("mouseup", finishDrawing);
  window.addEventListener("mouseup", finishErasing);

  // "Ink" meter — a small live readout of how much of the room's shared
  // segment budget remains, kept current by the server's `ink` messages (see the
  // "ink" case in the message switch below, and sendInkUpdate server-side —
  // the server is the sole source of truth for the number; this just displays
  // it). Built here, alongside the rest of this connection's UI, rather than
  // up with #palette at module load — its content is meaningless before a room
  // connection exists, the same reasoning that placed the chat panel here too.
  const inkMeter = document.createElement("div");
  inkMeter.id = "ink-meter";
  inkMeter.textContent = "Ink left: …"; // placeholder text until the server's baseline reading arrives (sent right after world_state on join — see onConnect)
  document.body.appendChild(inkMeter);

  // Erasing — right-click-drag erases every segment the cursor crosses (see
  // `erasing`/recordEraseHit/finishErasing above, wired into mousedown/
  // mousemove/mouseup alongside drawing capture). Per this game's "shared
  // whiteboard" design, anyone can erase anything (see CLAUDE.md for the
  // rationale and trade-offs); the server is the final authority and will
  // reject malformed or rate-limit-violating attempts regardless of what this
  // sends. All this listener does is preventDefault() to suppress the native
  // context menu — there's nothing on this canvas that needs it.
  canvas.addEventListener("contextmenu", (event) => {
    event.preventDefault();
  });

  // Chat — toggled open/closed with Enter (the window-level handler at the
  // bottom of this block). Collapsed, the log clips to its most recent lines —
  // a passive "ticker" so a message never goes unseen mid-game without taking
  // over the screen; expanded, it becomes a full scrollable history with an
  // input box that takes over the keyboard (see setKey's `chatOpen` guard
  // above, and the held-key release below).
  //
  // Join/leave log entries are deliberately *not* a separate protocol message —
  // they're derived right here from player_joined/player_left, the very
  // messages the roster already tracks. That keeps join/leave wording
  // consistent with however names are actually displayed (sanitized/fallback-
  // applied, never raw user input) for free, with no extra server bookkeeping
  // and no second source of truth for "who's in the room" to drift out of sync.
  let chatOpen = false;
  const MAX_CHAT_LOG = 200; // caps DOM growth over a long session — generous for "scroll back to see what you missed"

  const chatPanel = document.createElement("div");
  chatPanel.id = "chat";

  const chatLogEl = document.createElement("div");
  chatLogEl.classList.add("chat-log");
  chatPanel.appendChild(chatLogEl);

  const chatInput = document.createElement("input");
  chatInput.classList.add("chat-input");
  chatInput.placeholder = "Press Enter to chat…";
  chatInput.maxLength = MAX_CHAT_LENGTH;
  chatInput.autocomplete = "off";
  chatPanel.appendChild(chatInput);

  document.body.appendChild(chatPanel);

  function appendChatEntry(entry: ChatEntry) {
    const line = document.createElement("div");
    line.classList.add("chat-entry");
    if (entry.kind === "system") {
      line.classList.add("chat-system");
      line.textContent = entry.text;
    } else {
      const name = document.createElement("span");
      name.classList.add("chat-username");
      name.style.color = entry.color;
      name.textContent = entry.username;
      // textContent (+ a plain text node) for both pieces, never innerHTML —
      // per the GDD's "XSS via Usernames and Chat" guidance, nothing
      // user-supplied is ever parsed as markup, only ever rendered as inert text.
      line.append(name, document.createTextNode(`: ${entry.text}`));
    }
    chatLogEl.appendChild(line);
    while (chatLogEl.children.length > MAX_CHAT_LOG) chatLogEl.firstElementChild?.remove();
    chatLogEl.scrollTop = chatLogEl.scrollHeight;
  }

  function setChatOpen(open: boolean) {
    if (chatOpen === open) return;
    chatOpen = open;
    chatPanel.classList.toggle("expanded", open);
    if (open) {
      // The chat input is about to own the keyboard. Release any movement keys
      // held at this exact instant — without this, a key held down at the
      // moment chat opens would never see its matching keyup (setKey ignores
      // both while chatOpen is true), leaving the avatar "stuck" running for as
      // long as the panel stays open.
      if (keys.left || keys.right || keys.jump) {
        keys.left = keys.right = keys.jump = false;
        conn.send(JSON.stringify({ type: "input", keys }));
      }
      chatInput.focus();
      chatLogEl.scrollTop = chatLogEl.scrollHeight;
    } else {
      chatInput.value = "";
      chatInput.blur();
    }
  }

  chatInput.addEventListener("keydown", (event) => {
    // Stop here — the window-level handlers below (movement capture and the
    // closed-state "open chat" trigger) must never see keystrokes meant for
    // composing a message. This is also what keeps setKey's chatOpen guard from
    // ever mattering while actually typing; that guard only earns its keep if
    // focus drifts away from this input while the panel stays open (e.g. a
    // click on the canvas).
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      const text = chatInput.value.trim();
      if (text.length > 0) conn.send(JSON.stringify({ type: "chat", text }));
      setChatOpen(false);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setChatOpen(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && document.activeElement !== chatInput) {
      event.preventDefault();
      setChatOpen(!chatOpen);
    } else if (event.key === "Escape" && chatOpen) {
      setChatOpen(false);
    }
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
          // Logged for everyone the broadcast reaches, including the joiner
          // themselves — matching this project's established "no special-cased
          // local preview" pattern (see CLAUDE.md / Phases 5-6) rather than
          // reaching for a self-id check that conn.id might not even be
          // populated by yet at this exact moment in the connection lifecycle.
          appendChatEntry({ kind: "system", text: `${msg.username} joined` });
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "player_left": {
        if (isString(msg.id)) {
          // Look the username up *before* deleting — player_left only carries
          // an id (see CLAUDE.md's note on not exposing more than usernames),
          // and the roster is the only place this client knows that mapping.
          const identity = roster.get(msg.id);
          roster.delete(msg.id);
          if (identity) appendChatEntry({ kind: "system", text: `${identity.username} left` });
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
      case "chat": {
        if (isString(msg.id) && isString(msg.username) && isString(msg.color) && isString(msg.text)) {
          appendChatEntry({ kind: "chat", username: msg.username, color: msg.color, text: msg.text });
        } else {
          warnUnexpectedShape(msg.type, msg);
        }
        break;
      }
      case "ink": {
        // The server sends `used`/`max` (not `remaining`) because it's the one
        // deriving `used` from this.platforms — `remaining = max - used` is
        // pure display-layer arithmetic on values it already gave us directly,
        // not a re-derivation of any server-side validation/business logic
        // (the kind of duplication CLAUDE.md's client-validation note warns
        // against), so computing it here is fine.
        if (isNumber(msg.used) && isNumber(msg.max)) {
          inkMeter.textContent = `Ink left: ${Math.max(0, msg.max - msg.used)} / ${msg.max}`;
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
function drawPlatformPath(points: Point[], color: string) {
  if (points.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = PLATFORM_THICKNESS;
  ctx.stroke();
}

function drawPlatforms() {
  for (const platform of platforms.values()) {
    drawPlatformPath(platform.points, platform.color);
  }
}

// Live preview of the in-progress stroke, in the locally-selected color —
// the server has the final say (this redraws from `platforms` once it
// broadcasts `platform_added`, including back to the drawer).
function drawInProgressPath() {
  if (drawing) drawPlatformPath(drawing, selectedColor);
}

// Live preview of an in-progress erase drag — re-strokes each segment
// `erasing` has accumulated so far (see its declaration) in a wider, danger-
// colored line *underneath* the platform's own stroke (drawn after this, in
// `frame`), producing a glow around exactly what mouse-up will remove. Purely
// cosmetic and ephemeral: nothing is actually gone until the server broadcasts
// `platform_removed`/`platform_added`, mirroring `drawInProgressPath`'s "local
// preview, server has final say" posture for drawing.
function drawErasePreview() {
  if (!erasing) return;
  for (const [platformId, segments] of erasing) {
    const platform = platforms.get(platformId);
    if (!platform) continue;
    for (const index of segments) {
      const start = platform.points[index];
      const end = platform.points[index + 1];
      if (!start || !end) continue;
      ctx.beginPath();
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      ctx.lineCap = "round";
      ctx.strokeStyle = ERASE_PREVIEW_COLOR;
      ctx.lineWidth = PLATFORM_THICKNESS + 6;
      ctx.stroke();
    }
  }
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
  drawErasePreview();
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

let selectedAvatarColor = PALETTE_COLORS[3]; // a green, distinct from the platform palette's default red (PALETTE_COLORS[0])

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
