const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

// Separate waiting queues for text and video modes
const queues = { text: [], video: [] };
// Map socket.id -> { partnerId, roomId, mode }
const activePairs = new Map();
// Simple in-memory report counter (use Redis/DB in production)
const reportCounts = new Map();

function findMatch(socket, mode, interests) {
  const queue = queues[mode];
  const existingIdx = queue.findIndex(u => u.id === socket.id);
  if (existingIdx !== -1) queue.splice(existingIdx, 1);

  let bestMatchIndex = -1;
  let sharedTags = [];

  // 1. Prioritize users with matching interest tags
  if (interests.length > 0) {
    for (let i = 0; i < queue.length; i++) {
      const overlap = queue[i].interests.filter(tag => interests.includes(tag));
      if (overlap.length > 0) {
        bestMatchIndex = i;
        sharedTags = overlap;
        break;
      }
    }
  }

  // 2. Fallback to any waiting user if no tag match
  if (bestMatchIndex === -1 && queue.length > 0) {
    bestMatchIndex = 0;
  }

  if (bestMatchIndex !== -1) {
    const partner = queue.splice(bestMatchIndex, 1)[0];
    const roomId = `${socket.id}#${partner.id}`;

    activePairs.set(socket.id, { partnerId: partner.id, roomId, mode });
    activePairs.set(partner.id, { partnerId: socket.id, roomId, mode });

    io.to(socket.id).emit('matched', { initiator: true, sharedTags });
    io.to(partner.id).emit('matched', { initiator: false, sharedTags });
  } else {
    queue.push({ id: socket.id, interests, joinedAt: Date.now() });
  }
}

function cleanupUser(socketId) {
  ['text', 'video'].forEach(mode => {
    const idx = queues[mode].findIndex(u => u.id === socketId);
    if (idx !== -1) queues[mode].splice(idx, 1);
  });

  const pair = activePairs.get(socketId);
  if (pair) {
    io.to(pair.partnerId).emit('partner-disconnected');
    activePairs.delete(pair.partnerId);
    activePairs.delete(socketId);
  }
}

io.on('connection', (socket) => {
  io.emit('online-count', io.engine.clientsCount);

  socket.on('find-partner', ({ mode, interests }) => {
    cleanupUser(socket.id);
    const cleanInterests = Array.isArray(interests)
      ? interests.map(t => String(t).toLowerCase().trim()).slice(0, 10)
      : [];
    findMatch(socket, mode === 'video' ? 'video' : 'text', cleanInterests);
  });

  // WebRTC Signaling Relays
  socket.on('webrtc-offer', (offer) => {
    const pair = activePairs.get(socket.id);
    if (pair) io.to(pair.partnerId).emit('webrtc-offer', offer);
  });

  socket.on('webrtc-answer', (answer) => {
    const pair = activePairs.get(socket.id);
    if (pair) io.to(pair.partnerId).emit('webrtc-answer', answer);
  });

  socket.on('webrtc-ice-candidate', (candidate) => {
    const pair = activePairs.get(socket.id);
    if (pair) io.to(pair.partnerId).emit('webrtc-ice-candidate', candidate);
  });

  // Chat & Typing Relays
  socket.on('chat-message', (text) => {
    const pair = activePairs.get(socket.id);
    if (!pair || typeof text !== 'string') return;
    const sanitized = text.trim().slice(0, 1000);
    if (sanitized) {
      io.to(pair.partnerId).emit('chat-message', sanitized);
    }
  });

  socket.on('typing', (isTyping) => {
    const pair = activePairs.get(socket.id);
    if (pair) io.to(pair.partnerId).emit('typing', Boolean(isTyping));
  });

  // Moderation & Reporting
  socket.on('report-partner', ({ reason }) => {
    const pair = activePairs.get(socket.id);
    if (!pair) return;
    const count = (reportCounts.get(pair.partnerId) || 0) + 1;
    reportCounts.set(pair.partnerId, count);
    console.warn(`[REPORT] User ${pair.partnerId} reported for: ${reason} (Total: ${count})`);

    if (count >= 3) {
      io.to(pair.partnerId).emit('banned', 'You have been disconnected due to multiple community reports.');
      io.sockets.sockets.get(pair.partnerId)?.disconnect(true);
    }
    cleanupUser(socket.id);
  });

  socket.on('leave-chat', () => cleanupUser(socket.id));

  socket.on('disconnect', () => {
    cleanupUser(socket.id);
    io.emit('online-count', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`VibeLink server running on http://localhost:${PORT}`));
