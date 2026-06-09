#!/usr/bin/env node
/**
 * cheese-race-bot.mjs — heuristic bot for testing Cheese Race mode
 *
 * Usage:
 *   node cheese-race-bot.mjs <roomCode> [botName] [botColor] [count] [host]
 *
 *   roomCode  Room code to join (required). Copy from the ?room= URL param.
 *   botName   Display name prefix. Multiple bots get a number suffix, e.g. "Bot1".
 *             Default: "Bot"
 *   botColor  Hex color like #ff6600. Default: "#ff6600"
 *   count     How many bot connections to spawn. Default: 1
 *   host      PartyKit host to connect to. Default: mice.shisatum.partykit.dev
 *             Use "localhost:1999" to target a local dev server.
 *
 * Examples:
 *   node cheese-race-bot.mjs ABCD                                        # 1 bot, production
 *   node cheese-race-bot.mjs ABCD BotMouse "#a0e0ff" 3                   # 3 bots, production
 *   node cheese-race-bot.mjs ABCD Bot "#ff6600" 1 localhost:1999         # local dev
 *
 * The bot(s) will:
 *   - Join the room and wait
 *   - Auto-vote YES when any cheese race vote starts
 *   - Once a race starts, chase the cheese using heuristic nav:
 *       move left/right toward the cheese's X, jump when the cheese is
 *       above them or when they get stuck against a wall
 *
 * Dependencies: ws (available via partykit's node_modules — no extra install needed
 *   as long as you've run `npm install` inside server/).
 */

import WebSocket from "ws";

// ── CLI args ──────────────────────────────────────────────────────────────────
const [, , roomCode, botNameArg = "Bot", botColor = "#ff6600", countArg = "1", hostArg] =
  process.argv;

if (!roomCode) {
  console.error("Usage: node cheese-race-bot.mjs <roomCode> [botName] [botColor] [count] [host]");
  process.exit(1);
}

const botCount = Math.max(1, parseInt(countArg, 10) || 1);
const PARTYKIT_HOST = hostArg ?? "mice.shisatum.partykit.dev";

// ── Constants (mirrored from physics.ts — do not change independently) ────────
const TICK_MS = 50;           // server tick rate ~20Hz
const PLAYER_RADIUS = 16;     // px
const CHEESE_RADIUS = 14;     // px
const CHEESE_PICKUP_DISTANCE = PLAYER_RADIUS + CHEESE_RADIUS; // win radius
const WORLD_WIDTH = 1600;
const WORLD_HEIGHT = 900;

// ── Spawn one bot per requested count ────────────────────────────────────────
for (let i = 0; i < botCount; i++) {
  const name = botCount === 1 ? botNameArg : `${botNameArg}${i + 1}`;
  // Stagger connections slightly so world_state arrives in order
  setTimeout(() => spawnBot(name, botColor), i * 300);
}

// ── Bot factory ───────────────────────────────────────────────────────────────
function spawnBot(botName, color) {
  const scheme = PARTYKIT_HOST.startsWith("localhost") ? "ws" : "wss";
  const url =
    `${scheme}://${PARTYKIT_HOST}/parties/main/${roomCode}` +
    `?username=${encodeURIComponent(botName)}&color=${encodeURIComponent(color)}`;

  console.log(`[${botName}] Connecting to room ${roomCode}...`);
  const ws = new WebSocket(url);

  // ── Per-bot state ──────────────────────────────────────────────────────────
  let myId = null;
  let myX = WORLD_WIDTH / 2;
  let myY = WORLD_HEIGHT / 2;
  let cheese = null;     // { x, y } when a race is active, null otherwise

  // Input state — only sent to the server when a key changes (matches the
  // client's own "send on state-change" pattern in client.ts).
  let keys = { left: false, right: false, jump: false };
  let prevKeys = { left: false, right: false, jump: false };

  // Stuck + jump-cooldown tracking for the nav heuristic
  let prevX = myX;
  let stuckTicks = 0;
  let jumpCooldown = 0; // ticks remaining before another jump is allowed

  // ── Helpers ────────────────────────────────────────────────────────────────
  function send(obj) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  function sendInput() {
    // Mirror client.ts: only transmit when something actually changed
    if (
      keys.left  === prevKeys.left &&
      keys.right === prevKeys.right &&
      keys.jump  === prevKeys.jump
    ) return;
    send({ type: "input", keys: { ...keys } });
    prevKeys = { ...keys };
  }

  // ── Navigation loop (runs every server tick) ───────────────────────────────
  //
  // Strategy: pure heuristic, no pathfinding graph.
  //
  //   Horizontal: always drift toward cheese.x.
  //
  //   Vertical (jump):
  //     1. Cheese is clearly above us (cheeseY < myY by > JUMP_ABOVE_PX) →
  //        jump to try to climb up.
  //     2. Stuck: holding a direction but x hasn't moved in > STUCK_TICKS ticks
  //        → probably against a wall; jump to get over it.
  //     3. Periodic jump every PERIODIC_JUMP_TICKS ticks while cheese is above
  //        → fallback to keep trying to reach elevated cheese even when not
  //        obviously "stuck" (e.g. a wide platform that must be jumped onto).
  //
  // A JUMP_COOLDOWN_TICKS cooldown prevents double-jumps and jitter.
  //
  // This handles a lot of practical cases:
  //   ✓ Cheese on same level  → walk straight to it
  //   ✓ Cheese on a platform  → walk toward the base, then jump up
  //   ✓ Wall blocking path    → detect stuck, jump over it
  //   ✗ Cheese behind a high ledge with no runup → may get stuck
  //      (good enough for race-mode testing; real pathfinding would need
  //       a nav graph built from world_state's platform point arrays)

  const DEAD_ZONE_PX      = 8;   // px — don't drift if already this close in X
  const JUMP_ABOVE_PX     = 60;  // px — cheese must be this far above to trigger a "reach up" jump
  const STUCK_TICKS       = 8;   // ticks of no-X-movement while holding a direction before jumping
  const PERIODIC_JUMP_TICKS = 60; // every ~3s, try a jump if cheese is anywhere above
  const JUMP_COOLDOWN_TICKS = 12; // ~600ms minimum between jumps
  let periodicJumpTimer = 0;

  function navigate() {
    if (!cheese || myId === null) {
      // No race active — stand still
      keys = { left: false, right: false, jump: false };
      sendInput();
      return;
    }

    const dx = cheese.x - myX;
    // y increases downward, so cheeseAboveDelta > 0 means cheese is above us
    const cheeseAboveDelta = myY - cheese.y;

    // Horizontal
    keys.left  = dx < -DEAD_ZONE_PX;
    keys.right = dx >  DEAD_ZONE_PX;

    // Jump logic
    if (jumpCooldown > 0) {
      jumpCooldown--;
      keys.jump = false;
    } else {
      // Stuck detection: trying to move horizontally but X barely changed
      const xDelta = Math.abs(myX - prevX);
      if ((keys.left || keys.right) && xDelta < 0.5) {
        stuckTicks++;
      } else {
        stuckTicks = 0;
      }

      periodicJumpTimer++;

      const shouldJump =
        (cheeseAboveDelta > JUMP_ABOVE_PX) ||          // cheese above us
        (stuckTicks >= STUCK_TICKS) ||                  // stuck against a wall
        (periodicJumpTimer >= PERIODIC_JUMP_TICKS && cheeseAboveDelta > 0); // periodic retry

      if (shouldJump) {
        keys.jump = true;
        jumpCooldown = JUMP_COOLDOWN_TICKS;
        stuckTicks = 0;
        periodicJumpTimer = 0;
      } else {
        keys.jump = false;
      }
    }

    prevX = myX;
    sendInput();
  }

  const navInterval = setInterval(navigate, TICK_MS);

  // ── WebSocket event handlers ───────────────────────────────────────────────
  ws.on("open", () => {
    console.log(`[${botName}] Connected.`);
  });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    switch (msg.type) {
      case "world_state":
        // Pre-existing players — our own player_joined arrives right after this.
        break;

      case "player_joined":
        // The first player_joined whose username matches ours is us (the server
        // broadcasts it to everyone including the joiner; world_state only lists
        // players who existed *before* we connected, so this is how we learn our
        // own connection id — see server.ts's onConnect).
        if (myId === null && msg.username === botName) {
          myId = msg.id;
          console.log(`[${botName}] Got own id: ${myId}`);
        }
        break;

      case "snapshot":
        // Update our position from the authoritative server snapshot
        if (!myId) break;
        for (const p of msg.players) {
          if (p.id === myId) {
            myX = p.x;
            myY = p.y;
            break;
          }
        }
        break;

      case "minigame_vote_started":
        // Auto-vote yes for any race — the whole point of the bot is to test
        // race mode, so it always agrees to play.
        console.log(`[${botName}] Vote started by ${msg.proposedByUsername} — voting YES`);
        send({ type: "minigame_vote", vote: true });
        break;

      case "minigame_countdown":
        console.log(`[${botName}] Race countdown — starts at ${new Date(msg.endsAt).toISOString()}`);
        break;

      case "minigame_started":
        // The cheese position is the only thing we need from this message
        cheese = msg.cheese; // { x, y }
        stuckTicks = 0;
        periodicJumpTimer = 0;
        jumpCooldown = 0;
        console.log(`[${botName}] Race started! Cheese at (${cheese.x.toFixed(1)}, ${cheese.y.toFixed(1)})`);
        break;

      case "minigame_ended":
        cheese = null;
        keys = { left: false, right: false, jump: false };
        sendInput();
        const won = msg.winnerId === myId ? " (that's me!)" : "";
        console.log(`[${botName}] Race ended. Winner: ${msg.winnerUsername}${won}`);
        break;

      case "minigame_vote_resolved":
        if (msg.outcome === "cancelled") {
          console.log(`[${botName}] Vote cancelled (${msg.reason})`);
        }
        break;
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(navInterval);
    console.log(`[${botName}] Disconnected (${code}${reason ? ": " + reason : ""})`);
  });

  ws.on("error", (err) => {
    clearInterval(navInterval);
    console.error(`[${botName}] Error: ${err.message}`);
  });
}
