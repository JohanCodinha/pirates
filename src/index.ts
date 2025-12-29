// Worker entry point - handles static files and API routes

export { GameRoom } from './game-room';
export { RoomRegistry } from './room-registry';

export interface Env {
  GAME_ROOM: DurableObjectNamespace;
  ROOM_REGISTRY: DurableObjectNamespace;
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

    // Room list at /pirates/seas (server-rendered)
    if (url.pathname === '/pirates/seas' || url.pathname === '/pirates/seas/') {
      return renderRoomListPage(env);
    }

    // Viewer at /pirates/seas/:roomId → serve viewer.html
    const seasMatch = url.pathname.match(/^\/pirates\/seas\/([A-Z0-9]+)\/?$/);
    if (seasMatch) {
      const roomId = seasMatch[1];
      const viewerUrl = new URL(request.url);
      viewerUrl.pathname = '/pirates/viewer.html';
      viewerUrl.searchParams.set('room', roomId);
      return Response.redirect(viewerUrl.toString(), 302);
    }

    // Rewrite /pirates to /pirates/ internally (serve index.html without redirect)
    if (url.pathname === '/pirates') {
      const rewrittenUrl = new URL(request.url);
      rewrittenUrl.pathname = '/pirates/';
      return env.ASSETS.fetch(new Request(rewrittenUrl, request));
    }

    // Redirect viewer URL to viewer page with room ID as query param
    // /pirates/view/ABC123 -> /pirates/viewer?room=ABC123
    const viewerMatch = url.pathname.match(/^\/pirates\/view\/([A-Z0-9]+)\/?$/);
    if (viewerMatch) {
      const roomId = viewerMatch[1];
      return Response.redirect(new URL(`/pirates/viewer?room=${roomId}`, request.url).toString(), 302);
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
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
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

  // GET /api/view/:id - Viewer WebSocket (spectator mode)
  const viewerWsMatch = url.pathname.match(/^\/api\/view\/([A-Z0-9]+)\/ws$/);
  if (viewerWsMatch && request.method === 'GET') {
    const roomId = viewerWsMatch[1];
    console.log('[Worker] Viewer WebSocket request for room:', roomId);

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const id = env.GAME_ROOM.idFromName(roomId);
    console.log('[Worker] Viewer DO ID:', id.toString());
    const stub = env.GAME_ROOM.get(id);

    // Pass viewer flag and roomId via query param
    const viewerUrl = new URL(request.url);
    viewerUrl.searchParams.set('viewer', 'true');
    viewerUrl.searchParams.set('roomId', roomId);
    return stub.fetch(new Request(viewerUrl, request));
  }

  // POST /api/rooms - Create room
  if (url.pathname === '/api/rooms' && request.method === 'POST') {
    const roomId = generateRoomId();
    const id = env.GAME_ROOM.idFromName(roomId);
    const stub = env.GAME_ROOM.get(id);

    try {
      const statusRes = await stub.fetch(`https://room/status?roomId=${roomId}`);
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

  // GET /api/rooms/list - List all active rooms
  if (url.pathname === '/api/rooms/list' && request.method === 'GET') {
    const registryId = env.ROOM_REGISTRY.idFromName('global');
    const registry = env.ROOM_REGISTRY.get(registryId);

    try {
      const listRes = await registry.fetch('https://registry/list');
      const data = await listRes.json() as { rooms: Array<{ roomId: string; playerCount: number; lastUpdated: number }> };
      return new Response(JSON.stringify(data), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    } catch (e) {
      return new Response(JSON.stringify({ rooms: [] }), {
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
      const statusRes = await stub.fetch(`https://room/status?roomId=${roomId}`);
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
    console.log('[Worker] Player WebSocket request for room:', roomId);

    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const id = env.GAME_ROOM.idFromName(roomId);
    console.log('[Worker] Player DO ID:', id.toString());
    const stub = env.GAME_ROOM.get(id);

    // Pass roomId via query param
    const wsUrl = new URL(request.url);
    wsUrl.searchParams.set('roomId', roomId);
    return stub.fetch(new Request(wsUrl, request));
  }

  return new Response('Not found', { status: 404 });
}

async function renderRoomListPage(env: Env): Promise<Response> {
  let rooms: Array<{ roomId: string; playerCount: number; lastUpdated: number }> = [];

  try {
    const registryId = env.ROOM_REGISTRY.idFromName('global');
    const registry = env.ROOM_REGISTRY.get(registryId);
    const listRes = await registry.fetch('https://registry/list');
    const data = await listRes.json() as { rooms: typeof rooms };
    rooms = data.rooms || [];
  } catch {
    // Registry might not exist yet
  }

  const roomListHtml = rooms.length > 0
    ? rooms.map(room => `
        <a href="/pirates/seas/${room.roomId}" class="room-card">
          <div>
            <strong>${room.roomId}</strong>
            <time datetime="${new Date(room.lastUpdated).toISOString()}">${new Date(room.lastUpdated).toISOString()}</time>
          </div>
          <span class="badge ${room.playerCount === 2 ? 'full' : ''}">${room.playerCount}/2</span>
        </a>
      `).join('')
    : `<p class="empty">No active rooms. <a href="/pirates/">Start a new game</a></p>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pirates - Seas</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: linear-gradient(135deg, #0d1117, #1a2332);
      font-family: system-ui, sans-serif;
      color: #e6edf3;
      display: grid;
      place-items: center;
      padding: 2rem;
    }
    main {
      background: rgba(0,0,0,0.5);
      backdrop-filter: blur(10px);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 1rem;
      padding: 2rem;
      width: min(400px, 100%);
    }
    h1 {
      margin: 0 0 0.5rem;
      font-size: 1.5rem;
      background: linear-gradient(135deg, #8957e5, #4299e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle { color: #8b949e; margin: 0 0 1.5rem; }
    .room-card {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 1rem;
      margin-bottom: 0.5rem;
      background: rgba(255,255,255,0.05);
      border-radius: 0.5rem;
      text-decoration: none;
      color: inherit;
      transition: background 0.2s;
    }
    .room-card:hover { background: rgba(255,255,255,0.1); }
    .room-card strong { display: block; font-size: 1.1rem; }
    .room-card time { font-size: 0.8rem; color: #8b949e; }
    .badge {
      background: #1f6feb;
      padding: 0.25rem 0.75rem;
      border-radius: 1rem;
      font-size: 0.85rem;
    }
    .badge.full { background: #238636; }
    .empty {
      text-align: center;
      color: #8b949e;
      padding: 2rem 0;
    }
    .empty a { color: #58a6ff; }
    .actions {
      margin-top: 1.5rem;
      padding-top: 1rem;
      border-top: 1px solid rgba(255,255,255,0.1);
      text-align: center;
    }
    .actions a {
      color: #8b949e;
      text-decoration: none;
      font-size: 0.9rem;
    }
    .actions a:hover { color: #e6edf3; }
  </style>
</head>
<body>
  <main>
    <h1>The Seven Seas</h1>
    <p class="subtitle">Watch voyages in progress</p>
    <div id="rooms">${roomListHtml}</div>
    <div class="actions">
      <a href="">↻ Refresh</a>
    </div>
  </main>
  <script>
    // Format times as relative
    document.querySelectorAll('time').forEach(el => {
      const ms = Date.now() - new Date(el.dateTime).getTime();
      const s = Math.floor(ms / 1000);
      el.textContent = s < 60 ? 'now' : s < 3600 ? Math.floor(s/60) + 'm ago' : Math.floor(s/3600) + 'h ago';
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
