# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run dev      # Start local dev server at http://localhost:8787/pirates/
npm run build    # Compile TypeScript
npm run deploy   # Deploy to Cloudflare Workers
```

Open two browser tabs to test multiplayer locally. Changes to `public/` hot-reload; changes to `src/` require restart.

## Architecture

This is a real-time 2-player multiplayer hex navigation game using Cloudflare Workers + Durable Objects.

```
Browser → Worker (src/index.ts) → Durable Object (src/game-room.ts)
              │                         │
              ├─ Static assets          ├─ Game state
              ├─ Room creation          ├─ WebSocket hub
              └─ Path normalization     ├─ A* pathfinding
                                        └─ 50ms game loop
```

**Key files:**
- `src/index.ts` - Worker entry point, routes `/pirates/api/*` requests, serves static assets
- `src/game-room.ts` - Durable Object with game logic, WebSocket management
- `public/pirates/index.html` - Frontend (vanilla JS, three renderers: Canvas 3D, SVG, Terminal)

**Path normalization:** All routes include `/pirates` prefix (e.g., `/pirates/api/rooms`). Worker strips prefix before processing. This allows multiple games on the same domain.

## WebSocket Protocol

**Client → Server:**
```typescript
{ type: 'click', q: number, r: number }  // Plan path to hex
{ type: 'move' }                          // Start navigation
{ type: 'setSpeed', duration: number }    // Movement speed (ms per tile)
```

**Server → Client:**
```typescript
{ type: 'init', state: GameState, playerId: string }
{ type: 'stateUpdate', players: Record<string, PlayerState> }
{ type: 'playerJoined', playerId: string, color: string }
{ type: 'playerLeft', playerId: string }
```

## Hex Coordinate System

Uses axial coordinates (q, r). Key functions in both frontend and backend:
- `hexToPixel(q, r)` / `pixelToHex(x, y)` - coordinate conversion
- `getNeighbors(hex)` - returns 6 adjacent hexes
- `hexDistance(a, b)` - cube distance for A* heuristic
- `findPath(tiles, start, target, occupiedTiles)` - A* pathfinding through water

## Deployment

Auto-deploys via GitHub Actions on push to `main`. Requires secrets:
- `CLOUDFLARE_API_TOKEN` - Workers Scripts (Edit) permission
- `CLOUDFLARE_ACCOUNT_ID`

Durable Objects use SQLite migration (required for free plan). Each room is a separate Durable Object instance with persistent state.
