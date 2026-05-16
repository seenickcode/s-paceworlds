const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const users = new Map();

io.on('connection', (socket) => {
  socket.on('join', (name) => {
    const cleanName = String(name || '').slice(0, 40).trim() || 'Anon';
    const joinedAt = Date.now();
    users.set(socket.id, { name: cleanName, joinedAt });

    const existingPeers = [];
    for (const [id, info] of users) {
      if (id !== socket.id) {
        existingPeers.push({ id, name: info.name, elapsedMs: Date.now() - info.joinedAt });
      }
    }
    socket.emit('peers', existingPeers);
    socket.broadcast.emit('user-joined', { id: socket.id, name: cleanName, elapsedMs: 0 });
    console.log(`[join] ${cleanName} (${socket.id}) — ${users.size} online`);
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !users.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (users.has(socket.id)) {
      const { name } = users.get(socket.id);
      users.delete(socket.id);
      socket.broadcast.emit('user-left', { id: socket.id });
      console.log(`[leave] ${name} (${socket.id}) — ${users.size} online`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice lobby running on http://localhost:${PORT}`);
});
