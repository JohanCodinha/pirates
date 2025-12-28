// Worker entry point - handles static files and API routes

export { GameRoom } from './game-room';

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ASSETS: Fetcher;
}

function generateRoomId(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Rewrite /pirates to /pirates/ internally (serve index.html without redirect)
    if (url.pathname === '/pirates') {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = '/pirates/';
      return env.ASSETS.fetch(new Request(rewrittenUrl, request));
    }

    // Normalize API paths - strip /pirates prefix if present
    // e.g., /pirates/api/rooms -> /api/rooms
    let apiPath = url.pathname;
    if (apiPath.startsWith('/pirates')) {
      apiPath = apiPath.slice('/pirates'.length) || '/';
    }

    // API Routes
    if (apiPath.startsWith('/api/')) {
      const apiUrl = new URL(request.url);
      apiUrl.pathname = apiPath;
      return handleAPI(request, env, apiUrl);
    }

    // Static assets
    return env.ASSETS.fetch(request);
  },
};

async function handleAPI(request: Request, env: Env, url: URL): Promise<Response> {
  // CORS headers
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // POST /api/rooms - Create room
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    const roomId = generateRoomId();
    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    try {
      const statusRes = await stub.fetch('https://room/status');
      const status = await statusRes.json() as { players: number; maxPlayers: number };

      return new Response(JSON.stringify({
        roomId,
        players: status.players,
        maxPlayers: status.maxPlayers,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({
        roomId,
        players: 0,
        maxPlayers: 2,
      }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/rooms?id=XXX - Get room status
  if (url.pathname === '/api/rooms' && request.method === 'GET') {
    const roomId = url.searchParams.get('id');
    if (!roomId) {
      return new Response(JSON.stringify({ error: 'Room ID required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    try {
      const statusRes = await stub.fetch('https://room/status');
      const status = await statusRes.json() as { players: number; maxPlayers: number };
      return new Response(JSON.stringify({ roomId, ...status }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch {
      return new Response(JSON.stringify({ error: 'Room not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
  }

  // GET /api/rooms/:id/ws - WebSocket
  const wsMatch = url.pathname.match(/^\/api\/rooms\/([A-Z0-9]+)\/ws$/);
  if (wsMatch && request.method === 'GET') {
    const roomId = wsMatch[1];

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    return stub.fetch(request);
  }

  return new Response('Not found', { status: 404 });
}
