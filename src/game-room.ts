// Durable Object for multiplayer game room
// Handles WebSocket connections, game state, and real-time synchronization

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ROOM_REGISTRY: DurableObjectNamespace;
}

// Types
interface Hex {
  q: number;
  r: number;
}

interface Tile extends Hex {
  type: 'water' | 'land';
}

interface NavPlan {
  path: Hex[];          // Full path from current position to destination
  startTime: number;    // Server timestamp when navigation started
  duration: number;     // ms per tile
}

interface PlayerState {
  id: string;
  color: 'red' | 'blue';
  boat: Hex;            // Current authoritative position (updated as tiles are reached)
  navPlan: NavPlan | null;
}

interface GameState {
  mapSeed: number;
  tiles: Record<string, Tile>;
  players: Record<string, PlayerState>;
  config: {
    hexSize: number;
    mapRadius: number;
    landChance: number;
  };
}

// Client -> Server messages
type ClientMessage =
  | { type: 'click'; q: number; r: number }
  | { type: 'setSpeed'; duration: number };

// Server -> Client messages
type ServerMessage =
  | { type: 'init'; state: GameState; playerId: string | null }
  | { type: 'playerJoined'; playerId: string; color: string; boat: Hex }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'navPlan'; playerId: string; path: Hex[]; duration: number; fromPosition: Hex; elapsed: number }
  | { type: 'navEnd'; playerId: string; position: Hex }
  | { type: 'error'; message: string }
  | { type: 'debug'; direction: 'in' | 'out'; payload: unknown; timestamp: number };

// Seeded random number generator (mulberry32)
function seededRandom(seed: number): () => number {
  return function() {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Hex math helpers
function getKey(q: number, r: number): string {
  return `${q},${r}`;
}

function hexDistance(a: Hex, b: Hex): number {
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

function getNeighbors(hex: Hex): Hex[] {
  return [
    { q: hex.q + 1, r: hex.r },
    { q: hex.q + 1, r: hex.r - 1 },
    { q: hex.q, r: hex.r - 1 },
    { q: hex.q - 1, r: hex.r },
    { q: hex.q - 1, r: hex.r + 1 },
    { q: hex.q, r: hex.r + 1 },
  ];
}

// Generate map with seed
function generateMap(seed: number, radius: number, landChance: number): Record<string, Tile> {
  const random = seededRandom(seed);
  const tiles: Record<string, Tile> = {};

  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      let type: 'water' | 'land' = 'water';
      // Don't place land near center (for boat starting positions)
      if (hexDistance({ q: 0, r: 0 }, { q, r }) > 2 && random() < landChance) {
        type = 'land';
      }
      tiles[getKey(q, r)] = { q, r, type };
    }
  }

  return tiles;
}

// A* pathfinding - avoids occupied tiles
function findPath(
  tiles: Record<string, Tile>,
  start: Hex,
  target: Hex,
  occupiedTiles: Set<string>
): Hex[] {
  const pq: { item: Hex; prio: number }[] = [];
  const enqueue = (item: Hex, prio: number) => {
    pq.push({ item, prio });
    pq.sort((a, b) => a.prio - b.prio);
  };
  const dequeue = () => pq.shift()!.item;

  enqueue(start, 0);
  const cameFrom = new Map<string, Hex | null>();
  const costSoFar = new Map<string, number>();
  const startKey = getKey(start.q, start.r);

  cameFrom.set(startKey, null);
  costSoFar.set(startKey, 0);

  let closest = start;
  let minDst = hexDistance(start, target);
  let reached = false;

  const targetTile = tiles[getKey(target.q, target.r)];
  const targetWalkable = targetTile && targetTile.type === 'water';

  while (pq.length > 0) {
    const current = dequeue();
    const d = hexDistance(current, target);
    if (d < minDst) {
      minDst = d;
      closest = current;
    }
    if (current.q === target.q && current.r === target.r) {
      reached = true;
      break;
    }

    for (const next of getNeighbors(current)) {
      const nextKey = getKey(next.q, next.r);
      const tile = tiles[nextKey];
      if (!tile || tile.type === 'land') continue;

      // Avoid tiles occupied by other boats (treat same as land)
      if (occupiedTiles.has(nextKey)) continue;

      const newCost = costSoFar.get(getKey(current.q, current.r))! + 1;
      if (!costSoFar.has(nextKey) || newCost < costSoFar.get(nextKey)!) {
        costSoFar.set(nextKey, newCost);
        enqueue(next, newCost + hexDistance(next, target));
        cameFrom.set(nextKey, current);
      }
    }
  }

  let end = reached && targetWalkable ? target : closest;
  if (end.q === start.q && end.r === start.r) {
    return [];
  }

  // Reconstruct path
  const path: Hex[] = [];
  let curr: Hex | null = end;
  while (curr && !(curr.q === start.q && curr.r === start.r)) {
    path.push(curr);
    curr = cameFrom.get(getKey(curr.q, curr.r)) || null;
  }
  return path.reverse();
}

// Get starting position for a player (different positions for each)
function getStartingPosition(playerIndex: number): Hex {
  // Player 1 starts at (0, 0), Player 2 starts at (2, 0)
  const positions: Hex[] = [
    { q: 0, r: 0 },
    { q: 2, r: 0 },
  ];
  return positions[playerIndex] || { q: 0, r: 0 };
}

// Default speed (ms per tile)
const DEFAULT_DURATION = 500;

export class GameRoom implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private roomId: string | null = null;
  private sessions: Map<WebSocket, string> = new Map(); // ws -> playerId
  private viewers: Set<WebSocket> = new Set(); // viewer connections (no playerId)
  private gameState: GameState | null = null;
  private playerDurations: Map<string, number> = new Map(); // playerId -> duration

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Extract roomId from query param if provided
    const roomIdParam = url.searchParams.get('roomId');
    if (roomIdParam && !this.roomId) {
      this.roomId = roomIdParam;
    }

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      // Check if this is a viewer connection
      const isViewer = url.searchParams.get('viewer') === 'true';
      if (isViewer) {
        return this.handleViewerWebSocket();
      }
      return this.handleWebSocket(request);
    }

    // HTTP endpoints
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
        roomId: this.roomId,
        players: this.gameState ? Object.keys(this.gameState.players).length : 0,
        maxPlayers: 2,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(_request: Request): Promise<Response> {
    // Check player count
    if (this.gameState && Object.keys(this.gameState.players).length >= 2) {
      return new Response('Room is full', { status: 403 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket
    this.state.acceptWebSocket(server);

    // Initialize game state if needed
    if (!this.gameState) {
      const seed = Date.now();
      this.gameState = {
        mapSeed: seed,
        tiles: generateMap(seed, 10, 0.3),
        players: {},
        config: {
          hexSize: 32,
          mapRadius: 10,
          landChance: 0.3,
        },
      };
    }

    // Create player
    const playerId = crypto.randomUUID();
    const playerCount = Object.keys(this.gameState.players).length;
    const color: 'red' | 'blue' = playerCount === 0 ? 'red' : 'blue';
    const startPos = getStartingPosition(playerCount);

    const player: PlayerState = {
      id: playerId,
      color,
      boat: startPos,
      navPlan: null,
    };

    this.gameState.players[playerId] = player;
    this.sessions.set(server, playerId);
    this.playerDurations.set(playerId, DEFAULT_DURATION);

    // Send init message
    server.send(JSON.stringify({
      type: 'init',
      state: this.gameState,
      playerId,
    } as ServerMessage));

    // Broadcast player joined to others
    this.broadcast({
      type: 'playerJoined',
      playerId,
      color,
      boat: player.boat,
    }, server);

    // Start game tick if not running
    this.startGameTick();

    // Notify registry of player count change
    this.notifyRegistry();

    return new Response(null, { status: 101, webSocket: client });
  }

  private handleViewerWebSocket(): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Accept the WebSocket
    this.state.acceptWebSocket(server);

    // Add to viewers set
    this.viewers.add(server);

    console.log('[Viewer] Connected. Existing gameState:', !!this.gameState,
      'players:', this.gameState ? Object.keys(this.gameState.players).length : 0,
      'sessions:', this.sessions.size);

    // Initialize game state if needed (viewer might join empty room)
    if (!this.gameState) {
      console.log('[Viewer] No existing gameState, creating new one');
      const seed = Date.now();
      this.gameState = {
        mapSeed: seed,
        tiles: generateMap(seed, 10, 0.3),
        players: {},
        config: {
          hexSize: 32,
          mapRadius: 10,
          landChance: 0.3,
        },
      };
    }

    // Send init message with null playerId (viewer mode)
    server.send(JSON.stringify({
      type: 'init',
      state: this.gameState,
      playerId: null,
    } as ServerMessage));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;

    // Ignore messages from viewers (they're read-only)
    if (this.viewers.has(ws)) return;

    const playerId = this.sessions.get(ws);
    if (!playerId || !this.gameState) return;

    const player = this.gameState.players[playerId];
    if (!player) return;

    try {
      const msg = JSON.parse(message) as ClientMessage;

      // Send debug message to viewers (incoming from player)
      this.broadcastToViewers({
        type: 'debug',
        direction: 'in',
        payload: { playerId, ...msg },
        timestamp: Date.now(),
      });

      this.handleMessage(player, msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    // Handle viewer disconnect
    if (this.viewers.has(ws)) {
      this.viewers.delete(ws);
      return;
    }

    const playerId = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (playerId && this.gameState) {
      delete this.gameState.players[playerId];
      this.playerDurations.delete(playerId);
      this.broadcast({ type: 'playerLeft', playerId });
      // Notify registry of player count change
      this.notifyRegistry();
    }

    // Stop tick if no players (keep running if only viewers, but reset state)
    if (this.sessions.size === 0) {
      this.stopGameTick();
      this.gameState = null;
    }
  }

  webSocketError(_ws: WebSocket, _error: unknown) {
    // Handle error if needed
  }

  private handleMessage(player: PlayerState, msg: ClientMessage) {
    switch (msg.type) {
      case 'click':
        this.handleClick(player, msg.q, msg.r);
        break;
    }
  }

  private handleClick(player: PlayerState, q: number, r: number) {
    if (!this.gameState) return;

    const target = { q, r };
    const now = Date.now();
    const duration = this.playerDurations.get(player.id) || DEFAULT_DURATION;

    // Get tiles occupied by other players (treated same as land for pathfinding)
    const occupiedTiles = this.getOccupiedTiles(player.id);

    let fromPosition: Hex;
    let fullPath: Hex[];
    let elapsedTime: number;

    if (player.navPlan) {
      // Currently navigating - compute new path from the tile we're heading to
      const currentTile = this.getCurrentTilePosition(player, now);
      const nextTile = this.getNextTilePosition(player, now);

      // Compute path from nextTile to target
      const pathFromNext = findPath(this.gameState.tiles, nextTile, target, occupiedTiles);

      if (pathFromNext.length === 0 && (nextTile.q !== target.q || nextTile.r !== target.r)) {
        // No valid path, continue current navigation
        return;
      }

      // Full path includes the tile we're heading to, then the new path
      fullPath = [nextTile, ...pathFromNext];
      fromPosition = currentTile;

      // Calculate elapsed time since we started moving toward nextTile
      const totalElapsed = now - player.navPlan.startTime;
      const tileIndex = Math.floor(totalElapsed / player.navPlan.duration);
      elapsedTime = totalElapsed - (tileIndex * duration);

      // Update server's navPlan
      player.navPlan = {
        path: fullPath,
        startTime: now - elapsedTime,  // Adjusted to maintain timing
        duration,
      };
      player.boat = currentTile;

    } else {
      // Not navigating - start fresh from current boat position
      fromPosition = player.boat;
      fullPath = findPath(this.gameState.tiles, player.boat, target, occupiedTiles);
      elapsedTime = 0;

      if (fullPath.length === 0) {
        return;
      }

      player.navPlan = {
        path: fullPath,
        startTime: now,
        duration,
      };
    }

    // Broadcast the new navigation plan
    this.broadcast({
      type: 'navPlan',
      playerId: player.id,
      path: fullPath,
      duration,
      fromPosition,
      elapsed: elapsedTime,
    });
  }

  // Get the next tile the boat will reach (for rerouting and collision detection)
  // Returns the tile the boat is currently heading TOWARD
  private getNextTilePosition(player: PlayerState, now: number): Hex {
    if (!player.navPlan) {
      return player.boat;
    }

    const elapsed = now - player.navPlan.startTime;
    const tileIndex = Math.floor(elapsed / player.navPlan.duration);

    if (tileIndex >= player.navPlan.path.length) {
      // Navigation complete, return final position
      return player.navPlan.path[player.navPlan.path.length - 1];
    }

    if (tileIndex < 0) {
      return player.navPlan.path[0];
    }

    // Return the tile we're heading TO (not the one we're on)
    return player.navPlan.path[tileIndex];
  }

  // Get the tile the boat is currently ON (for authoritative position)
  private getCurrentTilePosition(player: PlayerState, now: number): Hex {
    if (!player.navPlan) {
      return player.boat;
    }

    const elapsed = now - player.navPlan.startTime;
    const tileIndex = Math.floor(elapsed / player.navPlan.duration);

    if (tileIndex >= player.navPlan.path.length) {
      return player.navPlan.path[player.navPlan.path.length - 1];
    }

    if (tileIndex <= 0) {
      return player.boat;
    }

    return player.navPlan.path[tileIndex - 1];
  }

  private getOccupiedTiles(excludePlayerId: string): Set<string> {
    const occupiedTiles = new Set<string>();
    if (!this.gameState) return occupiedTiles;

    const now = Date.now();
    for (const [id, p] of Object.entries(this.gameState.players)) {
      if (id !== excludePlayerId) {
        // Use current tile position for pathfinding avoidance
        const pos = this.getCurrentTilePosition(p, now);
        occupiedTiles.add(getKey(pos.q, pos.r));
        // Also block the tile they're heading to
        if (p.navPlan) {
          const nextPos = this.getNextTilePosition(p, now);
          occupiedTiles.add(getKey(nextPos.q, nextPos.r));
        }
      }
    }
    return occupiedTiles;
  }

  private startGameTick() {
    // Use alarm for periodic updates (Durable Objects don't have setInterval)
    this.state.storage.setAlarm(Date.now() + 50);
  }

  private stopGameTick() {
    this.state.storage.deleteAlarm();
  }

  async alarm() {
    if (!this.gameState || this.sessions.size === 0) {
      return;
    }

    const now = Date.now();

    // Update all players - check for completed navigation and collisions
    for (const player of Object.values(this.gameState.players)) {
      this.updatePlayerNavigation(player, now);
    }

    // Schedule next tick
    this.state.storage.setAlarm(Date.now() + 50);
  }

  private updatePlayerNavigation(player: PlayerState, now: number): void {
    if (!player.navPlan || !this.gameState) return;

    const elapsed = now - player.navPlan.startTime;
    const tileIndex = Math.floor(elapsed / player.navPlan.duration);

    // Update authoritative boat position to match progress
    if (tileIndex > 0 && tileIndex <= player.navPlan.path.length) {
      const newPos = player.navPlan.path[tileIndex - 1];
      player.boat = { q: newPos.q, r: newPos.r };
    }

    // Check if navigation is complete
    if (tileIndex >= player.navPlan.path.length) {
      const finalPos = player.navPlan.path[player.navPlan.path.length - 1];
      player.boat = { q: finalPos.q, r: finalPos.r };
      player.navPlan = null;

      this.broadcast({
        type: 'navEnd',
        playerId: player.id,
        position: player.boat,
      });
      return;
    }

    // Check for collision with next tile
    const nextTile = player.navPlan.path[tileIndex];
    if (nextTile) {
      const nextKey = getKey(nextTile.q, nextTile.r);
      let blocked = false;

      for (const [id, p] of Object.entries(this.gameState.players)) {
        if (id !== player.id) {
          const otherPos = this.getCurrentTilePosition(p, now);
          if (getKey(otherPos.q, otherPos.r) === nextKey) {
            blocked = true;
            break;
          }
        }
      }

      if (blocked) {
        // Try to reroute around the obstacle (finds closest reachable tile if destination occupied)
        const finalDestination = player.navPlan.path[player.navPlan.path.length - 1];
        const occupiedTiles = this.getOccupiedTiles(player.id);
        const newPath = findPath(this.gameState.tiles, player.boat, finalDestination, occupiedTiles);

        if (newPath.length > 0) {
          // Found alternate route
          const duration = this.playerDurations.get(player.id) || DEFAULT_DURATION;
          player.navPlan = {
            path: newPath,
            startTime: now,
            duration,
          };

          this.broadcast({
            type: 'navPlan',
            playerId: player.id,
            path: newPath,
            duration,
            fromPosition: player.boat,
            elapsed: 0,  // Starting fresh from current tile
          });
        } else {
          // No path available - stop navigation
          player.navPlan = null;

          this.broadcast({
            type: 'navEnd',
            playerId: player.id,
            position: player.boat,
          });
        }
      }
    }
  }

  private broadcast(message: ServerMessage, exclude?: WebSocket) {
    const data = JSON.stringify(message);

    // Send to players
    for (const ws of this.sessions.keys()) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch (e) {
          // WebSocket might be closed
        }
      }
    }

    // Send to viewers (game messages)
    for (const ws of this.viewers) {
      try {
        ws.send(data);
      } catch (e) {
        // WebSocket might be closed
      }
    }

    // Also send debug wrapper to viewers (outgoing message)
    this.broadcastToViewers({
      type: 'debug',
      direction: 'out',
      payload: message,
      timestamp: Date.now(),
    });
  }

  private broadcastToViewers(message: ServerMessage) {
    const data = JSON.stringify(message);
    for (const ws of this.viewers) {
      try {
        ws.send(data);
      } catch (e) {
        // WebSocket might be closed
      }
    }
  }

  private async notifyRegistry() {
    if (!this.roomId || !this.env.ROOM_REGISTRY) return;

    try {
      const registryId = this.env.ROOM_REGISTRY.idFromName('global');
      const registry = this.env.ROOM_REGISTRY.get(registryId);

      const playerCount = this.gameState ? Object.keys(this.gameState.players).length : 0;

      await registry.fetch('https://registry/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomId: this.roomId,
          playerCount,
        }),
      });
    } catch (e) {
      console.error('[GameRoom] Failed to notify registry:', e);
    }
  }
}
