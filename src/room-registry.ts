// Durable Object for tracking active game rooms
// Provides a central registry that rooms report to when players join/leave

export interface RoomInfo {
  roomId: string;
  playerCount: number;
  lastUpdated: number;
}

export class RoomRegistry implements DurableObject {
  private state: DurableObjectState;
  private rooms: Map<string, RoomInfo> = new Map();

  constructor(state: DurableObjectState) {
    this.state = state;
    // Load rooms from storage on startup
    this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get<Record<string, RoomInfo>>('rooms');
      if (stored) {
        this.rooms = new Map(Object.entries(stored));
        // Clean up stale rooms (older than 5 minutes with no updates)
        this.cleanupStaleRooms();
      }
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // POST /register - Room registers/updates its player count
    if (url.pathname === '/register' && request.method === 'POST') {
      const body = await request.json() as { roomId: string; playerCount: number };
      const { roomId, playerCount } = body;

      if (playerCount > 0) {
        this.rooms.set(roomId, {
          roomId,
          playerCount,
          lastUpdated: Date.now(),
        });
      } else {
        // No players, remove from registry
        this.rooms.delete(roomId);
      }

      // Persist to storage
      await this.saveRooms();

      return new Response(JSON.stringify({ success: true }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // GET /list - List all active rooms
    if (url.pathname === '/list' && request.method === 'GET') {
      this.cleanupStaleRooms();

      const roomList = Array.from(this.rooms.values())
        .sort((a, b) => b.lastUpdated - a.lastUpdated);

      return new Response(JSON.stringify({ rooms: roomList }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private cleanupStaleRooms() {
    const now = Date.now();
    const staleThreshold = 5 * 60 * 1000; // 5 minutes

    for (const [roomId, info] of this.rooms.entries()) {
      if (now - info.lastUpdated > staleThreshold) {
        this.rooms.delete(roomId);
      }
    }
  }

  private async saveRooms() {
    const roomsObj: Record<string, RoomInfo> = {};
    for (const [key, value] of this.rooms.entries()) {
      roomsObj[key] = value;
    }
    await this.state.storage.put('rooms', roomsObj);
  }
}
