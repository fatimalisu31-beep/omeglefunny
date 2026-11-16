const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2kb' }));
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// ---------- PREMIUM CODES ----------
// Set on Render: PREMIUM_CODES=VIBE-AB12CD,VIBE-XY98ZW   (comma separated, one code per buyer)
const PREMIUM_CODES = new Set(
  (process.env.PREMIUM_CODES || '').split(',').map(c => c.trim().toLowerCase()).filter(Boolean)
);
const isPremiumCode = c => typeof c === 'string' && PREMIUM_CODES.has(c.trim().toLowerCase());

const attempts = new Map(); // simple brute-force limiter: 10 tries / minute / IP
setInterval(() => attempts.clear(), 60 * 1000);
app.post('/api/premium/verify', (req, res) => {
  const n = (attempts.get(req.ip) || 0) + 1;
  attempts.set(req.ip, n);
  if (n > 10) return res.status(429).json({ ok: false });
  res.json({ ok: isPremiumCode(req.body && req.body.code) });
});

// ---------- TURN (video/audio across strict networks) ----------
// Option 1 (Metered.ca): set METERED_DOMAIN=yourapp.metered.live and METERED_API_KEY=xxxx
// Option 2 (any TURN, e.g. Twilio/coturn): set TURN_URL=turn:host:3478,turns:host:443?transport=tcp  TURN_USER=...  TURN_PASS=...
let turnCache = { at: 0, list: [] };
let turnDebug = { source: 'none', ok: false, detail: 'not requested yet' };

async function loadTurn() {
  // Cache only successful, non-empty results so a temporary failure is retried on the next request.
  if (turnCache.list.length && Date.now() - turnCache.at < 10 * 60 * 1000) return turnCache.list;
  let list = [];
  const domain = (process.env.METERED_DOMAIN || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  const apiKey = (process.env.METERED_API_KEY || '').trim();
  if (domain && apiKey) {
    try {
      const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(apiKey)}`);
      if (r.ok) {
        list = await r.json();
        turnDebug = { source: 'metered', ok: Array.isArray(list) && list.length > 0, detail: 'HTTP ' + r.status };
      } else {
        turnDebug = { source: 'metered', ok: false, detail: 'Metered replied HTTP ' + r.status + ' (wrong API key or domain? Use the TURN Server key, not the Realtime Messaging key)' };
        console.log('TURN: Metered replied', r.status);
      }
    } catch (e) {
      turnDebug = { source: 'metered', ok: false, detail: 'request failed: ' + e.message };
      console.log('TURN: request failed', e.message);
    }
  } else if (process.env.TURN_URL) {
    list = [{ urls: process.env.TURN_URL.split(',').map(u => u.trim()), username: process.env.TURN_USER, credential: process.env.TURN_PASS }];
    turnDebug = { source: 'custom', ok: true, detail: 'TURN_URL set' };
  } else {
    turnDebug = { source: 'none', ok: false, detail: 'METERED_DOMAIN / METERED_API_KEY (or TURN_URL) not set on this server' };
  }
  list = Array.isArray(list) ? list : [];
  if (list.length) turnCache = { at: Date.now(), list };
  return list;
}

app.get('/api/turn', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await loadTurn()); } catch (e) { res.json([]); }
});

// Safe diagnostic page (never shows passwords): open /api/turn-status in a browser.
app.get('/api/turn-status', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const list = await loadTurn().catch(() => []);
  const urls = list.flatMap(s => [].concat(s.urls || []));
  res.json({ ...turnDebug, servers: list.length, hasTurnRelay: urls.some(u => /^turns?:/i.test(u)) });
});

// ---------- MATCHING ----------
const queues = { text: [], video: [] };
const activePairs = new Map();
const reportCounts = new Map();

function compatible(a, b) {
  // Country filter (premium only)
  if (a.premium && a.wantCountry !== 'any' && b.country !== a.wantCountry) return false;
  if (b.premium && b.wantCountry !== 'any' && a.country !== b.wantCountry) return false;
  // Strict interest match (premium only)
  const overlap = a.interests.filter(t => b.interests.includes(t));
  if (a.premium && a.strict && a.interests.length && !overlap.length) return false;
  if (b.premium && b.strict && b.interests.length && !overlap.length) return false;
  return true;
}

function findMatch(me, mode) {
  const queue = queues[mode];
  const old = queue.findIndex(u => u.id === me.id);
  if (old !== -1) queue.splice(old, 1);

  // Best candidate: shared interest > waiting premium user with filters (hardest to match) > anyone compatible
  const restricted = u => u.premium && (u.wantCountry !== 'any' || u.strict);
  let matchIdx = -1, sharedTags = [], best = -1;
  for (let i = 0; i < queue.length; i++) {
    if (!compatible(me, queue[i])) continue;
    const overlap = queue[i].interests.filter(t => me.interests.includes(t));
    const score = overlap.length ? 2 : (restricted(queue[i]) ? 1 : 0);
    if (score > best) { best = score; matchIdx = i; sharedTags = overlap; }
  }

  if (matchIdx !== -1) {
    const partner = queue.splice(matchIdx, 1)[0];
    activePairs.set(me.id, { partnerId: partner.id, mode });
    activePairs.set(partner.id, { partnerId: me.id, mode });
    io.to(me.id).emit('matched', { initiator: true, sharedTags, partnerCountry: partner.country });
    io.to(partner.id).emit('matched', { initiator: false, sharedTags, partnerCountry: me.country });
  } else {
    queue.push(me);
  }
}

function cleanupUser(id) {
  ['text', 'video'].forEach(m => {
    const i = queues[m].findIndex(u => u.id === id);
    if (i !== -1) queues[m].splice(i, 1);
  });
  const pair = activePairs.get(id);
  if (pair) {
    io.to(pair.partnerId).emit('partner-disconnected');
    activePairs.delete(pair.partnerId);
    activePairs.delete(id);
  }
}

io.on('connection', (socket) => {
  io.emit('online-count', io.engine.clientsCount);

  socket.on('find-partner', (p = {}) => {
    cleanupUser(socket.id);
    const interests = Array.isArray(p.interests)
      ? p.interests.map(t => String(t).toLowerCase().trim()).filter(Boolean).slice(0, 10) : [];
    const cc = v => (typeof v === 'string' && /^[A-Za-z]{2}$/.test(v)) ? v.toUpperCase() : '';
    const premium = isPremiumCode(p.premiumCode); // verified on the server, not trusted from the client
    findMatch({
      id: socket.id,
      interests,
      country: cc(p.country),
      premium,
      wantCountry: premium ? (cc(p.wantCountry) || 'any') : 'any',
      strict: premium && Boolean(p.strict)
    }, p.mode === 'video' ? 'video' : 'text');
  });

  socket.on('webrtc-offer', d => { const p = activePairs.get(socket.id); if (p) io.to(p.partnerId).emit('webrtc-offer', d); });
  socket.on('webrtc-answer', d => { const p = activePairs.get(socket.id); if (p) io.to(p.partnerId).emit('webrtc-answer', d); });
  socket.on('webrtc-ice-candidate', d => { const p = activePairs.get(socket.id); if (p) io.to(p.partnerId).emit('webrtc-ice-candidate', d); });
  socket.on('chat-message', txt => {
    const p = activePairs.get(socket.id);
    if (p && typeof txt === 'string' && txt.trim()) io.to(p.partnerId).emit('chat-message', txt.trim().slice(0, 1000));
  });
  socket.on('typing', v => { const p = activePairs.get(socket.id); if (p) io.to(p.partnerId).emit('typing', Boolean(v)); });
  socket.on('report-partner', () => {
    const p = activePairs.get(socket.id);
    if (!p) return;
    const c = (reportCounts.get(p.partnerId) || 0) + 1;
    reportCounts.set(p.partnerId, c);
    if (c >= 3) { io.to(p.partnerId).emit('banned', 'Disconnected due to multiple reports.'); io.sockets.sockets.get(p.partnerId)?.disconnect(true); }
    cleanupUser(socket.id);
  });
  socket.on('leave-chat', () => cleanupUser(socket.id));
  socket.on('disconnect', () => { cleanupUser(socket.id); io.emit('online-count', io.engine.clientsCount); });
});

server.listen(process.env.PORT || 3000, () => console.log('VibeLink Live'));
