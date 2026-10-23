// Our Little Universe — game host + two-player relay.
// Serves the game files from this folder and pairs two phones in a private room
// identified by a short code (e.g. KITE-42). The server only passes messages
// between the two players; nothing is stored and there are no accounts.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 10000;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png',
  '.glb': 'model/gltf-binary', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};
const PUBLIC = new Set(['index.html', 'game.js', 'sw.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', 'girl_toon.glb', 'guy_toon.glb']);
const MAX_MSG = 64 * 1024;

// ---------------- static files ----------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (!PUBLIC.has(name)) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('Not found'); }
  try {
    const body = await readFile(join(ROOT, name));
    res.writeHead(200, {
      'content-type': TYPES[extname(name)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': name === 'index.html' || name === 'sw.js' ? 'no-cache' : 'public, max-age=3600',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }); res.end('Not found');
  }
});

// ---------------- rooms ----------------
const WORDS = ['KITE', 'MOON', 'STAR', 'LEAF', 'BEAR', 'CAKE', 'WAVE', 'SNOW', 'ROSE', 'FERN', 'BIRD', 'MINT', 'SUNNY', 'CLOUD', 'PEACH', 'HONEY', 'TULIP', 'OTTER', 'PANDA', 'LEMON'];
/** @type {Map<string, {host: any, guest: any, hostToken: string, guestToken: string, hostHero: string, timer: any}>} */
const rooms = new Map();
const newCode = () => {
  for (let i = 0; i < 200; i++) {
    const c = `${WORDS[Math.floor(Math.random() * WORDS.length)]}-${10 + Math.floor(Math.random() * 90)}`;
    if (!rooms.has(c)) return c;
  }
  return `ROOM-${randomBytes(3).toString('hex').toUpperCase()}`;
};
const token = () => randomBytes(12).toString('hex');
const send = (ws, msg) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const normalise = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+)(\d+)$/, '$1-$2');

function closeRoomLater(code) {
  const r = rooms.get(code);
  if (!r) return;
  clearTimeout(r.timer);
  // keep the room for a while so a phone that briefly lost signal can rejoin
  r.timer = setTimeout(() => { const x = rooms.get(code); if (x && !x.host && !x.guest) rooms.delete(code); }, 3 * 60 * 1000);
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MSG });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.on('pong', () => (ws.alive = true));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(String(raw)); } catch { return; }
    if (!m || typeof m.t !== 'string') return;
    if (m.t === 'create') {
      const code = newCode(), r = { host: ws, guest: null, hostToken: token(), guestToken: token(), hostHero: m.hero === 'fawaz' ? 'fawaz' : 'malek', timer: null };
      rooms.set(code, r); ws.room = code; ws.role = 'host';
      return send(ws, { t: 'created', code, token: r.hostToken, role: 'host' });
    }
    if (m.t === 'join') {
      const code = normalise(m.code), r = rooms.get(code);
      if (!r) return send(ws, { t: 'error', code: 'no-room', msg: 'No room with that code. Check the code and try again.' });
      if (r.guest && r.guest.readyState === 1) return send(ws, { t: 'error', code: 'full', msg: 'That room already has two players.' });
      if (!r.host) return send(ws, { t: 'error', code: 'host-offline', msg: 'The person who made this room is offline right now.' });
      r.guest = ws; ws.room = code; ws.role = 'guest'; clearTimeout(r.timer);
      send(ws, { t: 'joined', code, token: r.guestToken, role: 'guest', hostHero: r.hostHero });
      return send(r.host, { t: 'peer-joined' });
    }
    if (m.t === 'rejoin') {
      const code = normalise(m.code), r = rooms.get(code);
      if (!r) return send(ws, { t: 'error', code: 'closed', msg: 'That room has closed.', fatal: true });
      const role = m.token === r.hostToken ? 'host' : m.token === r.guestToken ? 'guest' : null;
      if (!role) return send(ws, { t: 'error', code: 'closed', msg: 'Could not rejoin that room.', fatal: true });
      if (r[role] && r[role] !== ws) { try { r[role].close(); } catch { /* ignore */ } }
      r[role] = ws; ws.room = code; ws.role = role; clearTimeout(r.timer);
      send(ws, { t: 'rejoined', code, role, hostHero: r.hostHero, peer: !!(role === 'host' ? r.guest : r.host) });
      return send(role === 'host' ? r.guest : r.host, { t: 'peer-joined', again: true });
    }
    if (m.t === 'relay') {
      const r = rooms.get(ws.room);
      if (!r) return;
      return send(ws.role === 'host' ? r.guest : r.host, { t: 'msg', d: m.d });
    }
    if (m.t === 'leave') { leave(ws, true); }
  });
  ws.on('close', () => leave(ws, false));
});

function leave(ws, forever) {
  const code = ws.room, r = code && rooms.get(code);
  if (!r) return;
  if (r[ws.role] !== ws) return; // an older connection that was already replaced
  r[ws.role] = null;
  const other = ws.role === 'host' ? r.guest : r.host;
  send(other, { t: 'peer-left', role: ws.role, forever });
  if (forever && ws.role === 'host') { send(r.guest, { t: 'room-closed' }); rooms.delete(code); return; }
  if (forever && ws.role === 'guest') r.guestToken = token(); // a new guest can take the seat
  closeRoomLater(code);
  ws.room = null;
}

// drop dead connections (phones that went to sleep without closing)
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false; ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log(`Our Little Universe on :${PORT}`));
