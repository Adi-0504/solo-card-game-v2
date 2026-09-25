import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS || 60 * 60 * 1000);
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS || 60 * 1000);
const VICTORY_GROUPS = 4;
const rooms = new Map();

class RNG {
  constructor(seed = crypto.randomInt(1, 0x7fffffff)) { this.state = seed >>> 0 || 1; }
  next() { let t = this.state += 0x6D2B79F5; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }
  card() { return { number: 1 + Math.floor(this.next() * 13), suit: Math.floor(this.next() * 4), id: `card-${this.state.toString(36)}-${crypto.randomBytes(2).toString('hex')}` }; }
}

function isNext(a, b) { return b === a + 1 || (a === 13 && b === 1); }
function isSequence(cards) { return cards.length >= 4 && cards.every((c, i) => i === 0 || isNext(cards[i - 1].number, c.number)); }
function isSet(cards) { return cards.length >= 4 && cards.every(c => c.number === cards[0].number); }
function groupsFor(row) {
  const result = [];
  for (let start = 0; start < row.length; start++) {
    for (let end = start + 4; end <= row.length; end++) {
      const cards = row.slice(start, end);
      if (!isSequence(cards) && !isSet(cards)) continue;
      const rules = [];
      if (isSequence(cards)) rules.push('sequence');
      if (isSet(cards)) rules.push('same-number-set');
      result.push({ start, end, cards, rules });
    }
  }
  return result;
}
function chooseGroups(candidates) {
  let best = [];
  const visit = (at, chosen) => {
    if (chosen.length > best.length || (chosen.length === best.length && chosen.reduce((n, g) => n + g.cards.length, 0) > best.reduce((n, g) => n + g.cards.length, 0))) best = chosen.slice();
    for (let i = at; i < candidates.length; i++) {
      const g = candidates[i];
      if (chosen.every(x => g.end <= x.start || g.start >= x.end)) visit(i + 1, [...chosen, g]);
    }
  };
  visit(0, []);
  return best.sort((a, b) => a.start - b.start);
}

class PlayerGame {
  constructor(seed) {
    this.rng = new RNG(seed);
    this.hand = Array.from({ length: 13 }, () => this.rng.card());
    this.tableRow = [];
    this.completedGroups = [];
    this.moves = 0;
    this.rescuesUsed = 0;
    this.startedAt = 0;
    this.finishedAt = 0;
  }
  start() { this.startedAt = Date.now(); }
  elapsed() { return this.startedAt ? Math.max(0, (this.finishedAt || Date.now()) - this.startedAt) : 0; }
  place(cardId, index) {
    if (this.finishedAt) return { ok: false, code: 'FINISHED' };
    if (!Number.isInteger(index) || index < 0 || index > this.tableRow.length) return { ok: false, code: 'BAD_POSITION' };
    const handIndex = this.hand.findIndex(c => c.id === cardId);
    if (handIndex < 0) return { ok: false, code: 'CARD_NOT_IN_HAND' };
    this.moves++;
    const card = this.hand.splice(handIndex, 1)[0];
    this.tableRow.splice(index, 0, card);
    const groups = chooseGroups(groupsFor(this.tableRow));
    for (const group of groups.slice().sort((a, b) => b.start - a.start)) {
      this.completedGroups.push({ cards: group.cards.map(c => ({ ...c })), rules: [...group.rules] });
      this.tableRow.splice(group.start, group.cards.length);
    }
    if (this.completedGroups.length >= VICTORY_GROUPS) {
      this.finishedAt = Date.now();
      return { ok: true, completed: groups, won: true };
    }
    this.hand.push(this.rng.card());
    const noCompletion = this.tableRow.length >= 3 && !this.hand.some(c => Array.from({ length: this.tableRow.length + 1 }, (_, i) => i).some(i => groupsFor([...this.tableRow.slice(0, i), c, ...this.tableRow.slice(i)]).length));
    let rescueNumber = null;
    if (noCompletion && this.tableRow.length >= 7 && this.rescuesUsed < 1) {
      rescueNumber = this.tableRow.at(-1)?.number || 1;
      this.hand.splice(0, 4, ...Array.from({ length: 4 }, () => ({ ...this.rng.card(), number: rescueNumber })));
      this.rescuesUsed++;
    }
    return { ok: true, completed: groups, won: false, rescueNumber };
  }
  public() {
    return { hand: this.hand, tableRow: this.tableRow, completedGroups: this.completedGroups, moves: this.moves, elapsedMs: this.elapsed(), finished: Boolean(this.finishedAt), rescueAvailable: this.rescuesUsed === 0 };
  }
}

function roomCode() { let code; do code = crypto.randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code)); return code; }
function token() { return crypto.randomBytes(24).toString('base64url'); }
function safeJson(ws, payload) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload)); }
function sendError(ws, message, code = 'BAD_REQUEST') { safeJson(ws, { type: 'ERROR', code, message }); }
function publicMatch(room) { return { roomCode: room.code, status: room.status, players: [...room.players.values()].map(p => ({ player: p.number, connected: Boolean(p.ws), finished: Boolean(p.game.finishedAt), elapsedMs: p.game.elapsed() })) }; }
function stateFor(room, player) { return { type: 'STATE', room: publicMatch(room), player: player.number, game: player.game.public(), opponent: [...room.players.values()].filter(p => p !== player).map(p => ({ player: p.number, connected: Boolean(p.ws), finished: Boolean(p.game.finishedAt), elapsedMs: p.game.elapsed() })) }; }
function broadcast(room, payload) { for (const p of room.players.values()) if (p.ws) safeJson(p.ws, payload); }
function broadcastStates(room) { for (const p of room.players.values()) if (p.ws) safeJson(p.ws, stateFor(room, p)); }
function attachPlayer(room, player, ws) { player.ws = ws; player.disconnectTimer && clearTimeout(player.disconnectTimer); ws.roomCode = room.code; ws.playerNumber = player.number; safeJson(ws, { type: 'CONNECTED', room: publicMatch(room), player: player.number, token: player.token }); safeJson(ws, stateFor(room, player)); }
function startRoom(room) { room.status = 'PLAYING'; for (const p of room.players.values()) p.game.start(); broadcast(room, { type: 'MATCH_STARTED', room: publicMatch(room) }); broadcastStates(room); }
function finishRoom(room) { if ([...room.players.values()].every(p => p.game.finishedAt)) { room.status = 'FINISHED'; const results = [...room.players.values()].map(p => ({ player: p.number, elapsedMs: p.game.elapsed(), moves: p.game.moves })).sort((a, b) => a.elapsedMs - b.elapsedMs); broadcast(room, { type: 'MATCH_RESULT', room: publicMatch(room), results, winner: results[0].player }); } }

function handleMessage(ws, raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return sendError(ws, '訊息格式太大', 'MESSAGE_TOO_LARGE');
  let msg; try { msg = JSON.parse(raw); } catch { return sendError(ws, '無法讀取訊息', 'INVALID_JSON'); }
  if (!msg || typeof msg.type !== 'string') return sendError(ws, '缺少訊息類型');
  if (msg.type === 'PING') return safeJson(ws, { type: 'PONG', at: Date.now() });
  if (msg.type === 'CREATE_ROOM') {
    if (ws.roomCode) {
      const oldRoom = rooms.get(ws.roomCode);
      if (oldRoom && oldRoom.status !== 'FINISHED') {
        return sendError(ws, '你已經在房間中', 'ALREADY_IN_ROOM');
      }
      ws.roomCode = null;
      ws.playerNumber = null;
    }
    const room = { code: roomCode(), status: 'WAITING', createdAt: Date.now(), players: new Map() };
    const player = { number: 1, token: token(), ws, game: new PlayerGame(crypto.randomInt(1, 0x7fffffff)) };
    room.players.set(1, player); rooms.set(room.code, room); attachPlayer(room, player, ws); safeJson(ws, { type: 'ROOM_CREATED', code: room.code }); return;
  }
  if (msg.type === 'JOIN_ROOM') {
    const code = String(msg.code || '').trim().toUpperCase(); const room = rooms.get(code);
    if (!room) return sendError(ws, '找不到這個房間', 'ROOM_NOT_FOUND');
    if (room.status !== 'WAITING' || room.players.size >= 2) return sendError(ws, '房間已經開始或已滿', 'ROOM_FULL');
    const player = { number: 2, token: token(), ws, game: new PlayerGame(crypto.randomInt(1, 0x7fffffff)) }; room.players.set(2, player); attachPlayer(room, player, ws); startRoom(room); return;
  }
  if (msg.type === 'RECONNECT') {
    const room = rooms.get(String(msg.code || '').toUpperCase()); const player = room && [...room.players.values()].find(p => p.token === msg.token);
    if (!player) return sendError(ws, '重連資訊已失效', 'RECONNECT_FAILED'); attachPlayer(room, player, ws); if (room.status === 'WAITING' && room.players.size === 2) startRoom(room); return;
  }
  const room = ws.roomCode && rooms.get(ws.roomCode); const player = room && room.players.get(ws.playerNumber);
  if (!room || !player) return sendError(ws, '請先加入房間', 'NOT_IN_ROOM');
  if (msg.type === 'PLACE_CARD') {
    if (room.status !== 'PLAYING') return sendError(ws, '牌局目前不能出牌', 'MATCH_NOT_PLAYING');
    const result = player.game.place(String(msg.cardId || ''), Number(msg.index));
    if (!result.ok) return sendError(ws, '這張牌不能這樣出', result.code);
    broadcastStates(room); if (result.rescueNumber) safeJson(ws, { type: 'RESCUE_SET', number: result.rescueNumber }); if (result.won) { broadcast(room, { type: 'PLAYER_FINISHED', player: player.number, elapsedMs: player.game.elapsed() }); finishRoom(room); } return;
  }
  sendError(ws, '未知的訊息類型', 'UNKNOWN_MESSAGE');
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify({ ok: true, service: 'solo-card-game', rooms: rooms.size, now: Date.now() }));
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  const absolute = path.resolve(ROOT, `.${file}`);
  if (!absolute.startsWith(ROOT) || !fs.existsSync(absolute) || fs.statSync(absolute).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(absolute); const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }); fs.createReadStream(absolute).pipe(res);
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
server.on('upgrade', (req, socket, head) => { const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`); if (url.pathname !== '/ws') return socket.destroy(); wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req)); });
wss.on('connection', ws => { ws.on('message', data => handleMessage(ws, data.toString())); ws.on('close', () => { const room = ws.roomCode && rooms.get(ws.roomCode); const player = room && room.players.get(ws.playerNumber); if (!player || player.ws !== ws) return; player.ws = null; player.disconnectTimer = setTimeout(() => { if (!player.ws && room.status !== 'FINISHED') { room.players.delete(player.number); broadcast(room, { type: 'PLAYER_DISCONNECTED', player: player.number }); if (!room.players.size) rooms.delete(room.code); } }, RECONNECT_GRACE_MS); broadcast(room, { type: 'PLAYER_DISCONNECTED', player: player.number }); }); });
setInterval(() => { const now = Date.now(); for (const [code, room] of rooms) if (now - room.createdAt > ROOM_TTL_MS) { broadcast(room, { type: 'ROOM_EXPIRED' }); rooms.delete(code); } }, 60_000).unref();
server.listen(PORT, HOST, () => console.log(`Solo Card Game server listening on http://${HOST}:${PORT}`));
