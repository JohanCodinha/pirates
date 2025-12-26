# Pirates - Multiplayer Hex Navigation Game

A real-time multiplayer game where players navigate ships across a hex grid. Built with Cloudflare Workers, Durable Objects, and WebSockets.

**Live**: https://games.joadn.com/pirates/

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Edge                          │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────────┐  │
│  │   Assets    │    │   Worker    │    │ Durable Object  │  │
│  │ (Static)    │    │  (Router)   │───▶│   (GameRoom)    │  │
│  │             │    │             │    │                 │  │
│  │ index.html  │    │ /api/*      │    │ - Game state    │  │
│  │             │    │ WebSocket   │    │ - WebSocket hub │  │
│  └─────────────┘    └─────────────┘    │ - Pathfinding   │  │
│                                        └─────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### Components

| Component | Purpose |
|-----------|---------|
| **Static Assets** | Frontend HTML/JS served from `public/pirates/` |
| **Worker** (`src/index.ts`) | Routes API requests, normalizes paths |
| **Durable Object** (`src/game-room.ts`) | Per-room game state, WebSocket connections, game logic |

### Request Flow

1. Browser loads `games.joadn.com/pirates/` → Cloudflare serves `public/pirates/index.html`
2. Frontend calls `POST /pirates/api/rooms` → Worker creates room, returns room ID
3. Frontend opens WebSocket to `/pirates/api/rooms/{id}/ws` → Worker routes to Durable Object
4. Durable Object manages game state and broadcasts updates to all connected players

### Path Handling

The worker is deployed with route `games.joadn.com/pirates/*`. This means:
- All requests must include the `/pirates` prefix
- Worker strips this prefix before processing API routes
- Frontend auto-detects its base path from `window.location.pathname`

This allows multiple games to be deployed at different paths (e.g., `/froggy/`, `/chess/`).

## Project Structure

```
pirates/
├── public/
│   └── pirates/
│       └── index.html      # Frontend (game client)
├── src/
│   ├── index.ts            # Worker entry point (routing)
│   └── game-room.ts        # Durable Object (game logic)
├── .github/
│   └── workflows/
│       └── deploy.yml      # GitHub Actions CI/CD
├── wrangler.toml           # Cloudflare configuration
├── package.json
├── tsconfig.json
└── game.html               # Original single-player prototype
```

## Game Features

- **2-player multiplayer** via WebSocket
- **Hex grid** with water/land tiles
- **A* pathfinding** through water tiles
- **Soft collision** - ships stop at nearest available tile if blocked
- **Live re-routing** - click to change destination while moving
- **3 renderers**: Canvas 3D, SVG, Terminal ASCII

## Local Development

### Prerequisites

- Node.js 20+
- npm

### Setup

```bash
# Install dependencies
npm install

# Start local dev server
npm run dev
```

Open http://localhost:8787/pirates/ in two browser tabs to test multiplayer.

### Local Development Notes

- Durable Objects run in local mode (in-memory, not persistent)
- WebSocket connections work locally
- Changes to `src/` require restart; changes to `public/` are hot-reloaded

## Deployment

### Automatic (GitHub Actions)

Push to `main` branch triggers automatic deployment via GitHub Actions.

**Required GitHub Secrets**:
| Secret | Description |
|--------|-------------|
| `CLOUDFLARE_API_TOKEN` | API token with Workers Scripts (Edit) permission |
| `CLOUDFLARE_ACCOUNT_ID` | Your Cloudflare account ID |

### Manual

```bash
# Deploy to Cloudflare
npm run deploy
```

### Custom Domain Setup

1. Add DNS record in Cloudflare:
   - Type: `CNAME`
   - Name: `games`
   - Target: `pirates-multiplayer.johan-35f.workers.dev`
   - Proxy: Enabled

2. Route is configured in `wrangler.toml`:
   ```toml
   routes = [
     { pattern = "games.joadn.com/pirates/*", zone_name = "joadn.com" }
   ]
   ```

## API Reference

### Create Room

```
POST /pirates/api/rooms

Response:
{
  "roomId": "ABC123",
  "players": 0,
  "maxPlayers": 2
}
```

### Get Room Status

```
GET /pirates/api/rooms?id=ABC123

Response:
{
  "roomId": "ABC123",
  "players": 1,
  "maxPlayers": 2
}
```

### WebSocket Connection

```
GET /pirates/api/rooms/{roomId}/ws
Upgrade: websocket
```

#### Client → Server Messages

```typescript
{ type: 'click', q: number, r: number }  // Plan path to tile
{ type: 'move' }                          // Start navigation
{ type: 'setSpeed', duration: number }    // Set movement speed (ms per tile)
```

#### Server → Client Messages

```typescript
{ type: 'init', state: GameState, playerId: string }
{ type: 'playerJoined', playerId: string, color: string }
{ type: 'playerLeft', playerId: string }
{ type: 'stateUpdate', players: Record<string, PlayerState> }
```

## Configuration

### wrangler.toml

```toml
name = "pirates-multiplayer"
main = "src/index.ts"
compatibility_date = "2024-12-26"
workers_dev = true

routes = [
  { pattern = "games.joadn.com/pirates/*", zone_name = "joadn.com" }
]

assets = { directory = "public" }

[[durable_objects.bindings]]
name = "GAME_ROOM"
class_name = "GameRoom"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["GameRoom"]
```

### Adding Another Game

To deploy another game (e.g., "froggy") on the same domain:

1. Create a new worker project
2. Set route: `games.joadn.com/froggy/*`
3. Place assets in `public/froggy/`
4. Deploy

Cloudflare routes requests to the correct worker based on path.

## Development Notes

### Durable Objects

- Use `new_sqlite_classes` migration (required for free plan)
- Each room is a separate Durable Object instance
- State is automatically persisted by Cloudflare
- WebSocket connections are managed via `state.acceptWebSocket()`

### Renderers

The game supports three rendering modes, switchable at runtime:

1. **Canvas 3D** - Isometric 2.5D view with depth sorting
2. **SVG** - Vector graphics with CSS animations
3. **Terminal** - ASCII art rendering

All renderers share the same game state and input handling.

## License

MIT
