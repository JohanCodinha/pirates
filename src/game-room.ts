// Durable Object for multiplayer game room
// Handles WebSocket connections, game state, and real-time synchronization

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
}

// Types
interface Hex {
  q: number;
  r: number;
}

interface Tile extends Hex {
  type: 'water' | 'land';
}

interface PlayerState {
  id: string;
  color: 'red' | 'blue';
  boat: Hex;
  plannedPath: Hex[];
  nav: {
    active: boolean;
    queue: Hex[];
    t: number;
    duration: number;
  };
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
  | { type: 'move' }
  | { type: 'setSpeed'; duration: number };

// Server -> Client messages
type ServerMessage =
  | { type: 'init'; state: GameState; playerId: string }
  | { type: 'playerJoined'; playerId: string; color: string }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'stateUpdate'; players: Record<string, PlayerState> }
  | { type: 'error'; message: string };

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

// A* pathfinding
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

export class GameRoom implements DurableObject {
  private state: DurableObjectState;
  private sessions: Map<WebSocket, string> = new Map(); // ws -> playerId
  private gameState: GameState | null = null;
  private tickInterval: number | null = null;

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // HTTP endpoints
    if (url.pathname === '/status') {
      return new Response(JSON.stringify({
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
      plannedPath: [],
      nav: {
        active: false,
        queue: [],
        t: 0,
        duration: 500,
      },
    };

    this.gameState.players[playerId] = player;
    this.sessions.set(server, playerId);

    // Send init message (will be sent when WebSocket is ready)
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
    }, server);

    // Start game tick if not running
    if (this.tickInterval === null) {
      this.startGameTick();
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;

    const playerId = this.sessions.get(ws);
    if (!playerId || !this.gameState) return;

    const player = this.gameState.players[playerId];
    if (!player) return;

    try {
      const msg = JSON.parse(message) as ClientMessage;
      this.handleMessage(player, msg);
    } catch (e) {
      console.error('Failed to parse message:', e);
    }
  }

  webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean) {
    const playerId = this.sessions.get(ws);
    this.sessions.delete(ws);

    if (playerId && this.gameState) {
      delete this.gameState.players[playerId];
      this.broadcast({ type: 'playerLeft', playerId });
    }

    // Stop tick if no players
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
      case 'move':
        this.handleMove(player);
        break;
      case 'setSpeed':
        player.nav.duration = Math.max(50, msg.duration);
        break;
    }

    // Broadcast state update
    this.broadcastState();
  }

  private handleClick(player: PlayerState, q: number, r: number) {
    if (!this.gameState) return;

    const target = { q, r };

    // Get tiles occupied by other players
    const occupiedTiles = new Set<string>();
    for (const [id, p] of Object.entries(this.gameState.players)) {
      if (id !== player.id) {
        occupiedTiles.add(getKey(p.boat.q, p.boat.r));
      }
    }

    if (player.nav.active) {
      // Dynamic re-routing while navigating
      if (player.nav.queue.length > 0) {
        const currentTarget = player.nav.queue[0];
        if (currentTarget.q === target.q && currentTarget.r === target.r) {
          player.nav.queue = [currentTarget];
          return;
        }
        const newPath = findPath(this.gameState.tiles, currentTarget, target, occupiedTiles);
        player.nav.queue = [currentTarget, ...newPath];
      }
    } else {
      // Plan new path
      const path = findPath(this.gameState.tiles, player.boat, target, occupiedTiles);
      player.plannedPath = path;
    }
  }

  private handleMove(player: PlayerState) {
    if (player.nav.active || player.plannedPath.length === 0) return;

    player.nav.active = true;
    player.nav.queue = [...player.plannedPath];
    player.nav.t = 0;
    player.plannedPath = [];
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

    const dt = 50; // 50ms tick

    // Update all players
    let stateChanged = false;
    for (const player of Object.values(this.gameState.players)) {
      if (this.updatePlayerNavigation(player, dt)) {
        stateChanged = true;
      }
    }

    if (stateChanged) {
      this.broadcastState();
    }

    // Schedule next tick
    this.state.storage.setAlarm(Date.now() + 50);
  }

  private updatePlayerNavigation(player: PlayerState, dt: number): boolean {
    if (!player.nav.active || !this.gameState) return false;

    player.nav.t += dt / player.nav.duration;

    if (player.nav.t >= 1) {
      const nextNode = player.nav.queue.shift();
      if (nextNode) {
        // Check if tile is occupied by another player
        const nextKey = getKey(nextNode.q, nextNode.r);
        let canMove = true;

        for (const [id, p] of Object.entries(this.gameState.players)) {
          if (id !== player.id && getKey(p.boat.q, p.boat.r) === nextKey) {
            canMove = false;
            break;
          }
        }

        if (canMove) {
          player.boat = { q: nextNode.q, r: nextNode.r };
        } else {
          // Blocked - stop navigation
          player.nav.active = false;
          player.nav.queue = [];
          return true;
        }
      }

      if (player.nav.queue.length > 0) {
        player.nav.t = 0;
      } else {
        player.nav.active = false;
      }
      return true;
    }

    return true; // Always return true during navigation for smooth updates
  }

  private broadcast(message: ServerMessage, exclude?: WebSocket) {
    const data = JSON.stringify(message);
    for (const ws of this.sessions.keys()) {
      if (ws !== exclude) {
        try {
          ws.send(data);
        } catch (e) {
          // WebSocket might be closed
        }
      }
    }
  }

  private broadcastState() {
    if (!this.gameState) return;

    this.broadcast({
      type: 'stateUpdate',
      players: this.gameState.players,
    });
  }
}
