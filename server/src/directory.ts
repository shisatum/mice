import type * as Party from "partykit/server";

// A second PartyKit "party" (declared in partykit.json's `parties`), entirely
// separate from the game-room party this file's sibling server.ts implements.
// It runs as a single well-known room ("main" — see ROOM_ID below) that game
// rooms register/ping with on player-count changes, and that the join screen
// queries for a list of active rooms to join — see CLAUDE.md/TODO.md's "Server/
// room list" notes for the cheap-vs-medium options that were weighed; this is
// the "medium" (singleton directory room) option.
//
// Bookkeeping is purely in-memory and best-effort by design: a stale or missing
// entry just means a room doesn't show up in the list (or lingers briefly after
// emptying) — never a gameplay-affecting failure, so there's nothing here worth
// persisting to `room.storage` or guarding with retries.

export const ROOM_ID = "main"; // the one room ID this party ever uses — exported so server.ts's ping and a future client fetch agree on it without duplicating the literal

const STALE_AFTER_MS = 90_000; // ~3x DIRECTORY_PING_INTERVAL_MS (server.ts) — tolerates a couple of missed pings (a transient fetch failure, a slow tick) before a room ages out, so normal jitter doesn't cause it to flicker in and out of the list

type RoomEntry = { playerCount: number; lastSeen: number };

// Minimal shape-check on an inbound ping — this party's only "client" is other
// rooms in the same project (server.ts's pingDirectory), not untrusted browsers,
// but a stale/mismatched deploy could still send something malformed, so this
// stays defensive rather than trusting blindly. roomId is capped at 12 to match
// the join screen's room-code field (client.ts); anything longer can't be a real
// room code and isn't worth tracking.
function isValidPing(data: unknown): data is { roomId: string; playerCount: number } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    typeof d.roomId === "string" &&
    d.roomId.length > 0 &&
    d.roomId.length <= 12 &&
    typeof d.playerCount === "number" &&
    Number.isInteger(d.playerCount) &&
    d.playerCount >= 0
  );
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json",
};

export default class Directory implements Party.Server {
  rooms = new Map<string, RoomEntry>();

  constructor(readonly room: Party.Room) {}

  // Drops any entry not heard from recently — called on every request so the
  // map stays bounded by "rooms active or recently active" rather than growing
  // by one for every room ID that's ever existed across the directory's lifetime.
  private pruneStale() {
    const cutoff = Date.now() - STALE_AFTER_MS;
    for (const [roomId, entry] of this.rooms) {
      if (entry.lastSeen < cutoff) this.rooms.delete(roomId);
    }
  }

  async onRequest(req: Party.Request) {
    this.pruneStale();

    if (req.method === "POST") {
      let data: unknown;
      try {
        data = await req.json();
      } catch {
        return new Response("bad request", { status: 400 });
      }
      if (!isValidPing(data)) return new Response("bad request", { status: 400 });

      // Record the ping as-is, even at playerCount: 0 — and let pruneStale's
      // lastSeen-based expiry retire it rather than deleting it on the spot.
      // Why keep zero-player entries around at all: the join screen's "show
      // empty rooms" debug toggle (client.ts) needs *something* to display,
      // and a room that just emptied is exactly the interesting case to see
      // (room lifecycle/churn). The directory stays dumb either way — it's
      // the client's job to filter these out of the default view.
      this.rooms.set(data.roomId, { playerCount: data.playerCount, lastSeen: Date.now() });
      return new Response("ok");
    }

    // GET — the join screen's room-list fetch. Cross-origin (the client is
    // served from a different origin than this PartyKit room — see CLAUDE.md's
    // "game is live" note), so it needs an explicit CORS allow-origin; the
    // payload is purely public, non-sensitive (room codes + player counts that
    // are also visible to anyone who joins), so a wildcard is appropriate.
    const rooms = [...this.rooms.entries()]
      .sort(([, a], [, b]) => b.playerCount - a.playerCount) // most-populated first — the most useful ordering for "which room should I join"
      .map(([roomId, entry]) => ({ roomId, playerCount: entry.playerCount }));

    return new Response(JSON.stringify({ rooms }), { headers: CORS_HEADERS });
  }
}
