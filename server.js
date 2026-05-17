const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Game world dimensions used for asteroid spawn coords (must match client canvas)
const GAME_W = 800;

const users = new Map(); // socketId -> { name, color, avatarSeed, joinedAt }

function takenColors(excludeId) {
  const out = [];
  for (const [id, u] of users) {
    if (id !== excludeId) out.push(u.color);
  }
  return out;
}

function publicProfile(id) {
  const u = users.get(id);
  if (!u) return null;
  return {
    id, name: u.name, color: u.color, avatarSeed: u.avatarSeed,
    currentGame: u.currentGame, score: u.score || 0,
  };
}

io.on('connection', (socket) => {
  socket.on('get-taken-colors', () => {
    socket.emit('taken-colors', takenColors(socket.id));
  });

  socket.on('join', (profile) => {
    const name = String(profile?.name || '').slice(0, 40).trim() || 'Anon';
    const color = String(profile?.color || '#888888');
    const avatarSeed = Number(profile?.avatarSeed) || 0;

    if (takenColors(socket.id).includes(color)) {
      socket.emit('join-rejected', { reason: 'color-taken', takenColors: takenColors(socket.id) });
      return;
    }

    const joinedAt = Date.now();
    const score = Number(profile?.score) || 0;
    users.set(socket.id, { name, color, avatarSeed, joinedAt, currentGame: null, score });

    const existingPeers = [];
    for (const [id, info] of users) {
      if (id !== socket.id) {
        existingPeers.push({
          id, name: info.name, color: info.color, avatarSeed: info.avatarSeed,
          currentGame: info.currentGame, score: info.score || 0,
          elapsedMs: Date.now() - info.joinedAt,
        });
      }
    }
    socket.emit('joined', { id: socket.id, peers: existingPeers });
    socket.broadcast.emit('user-joined', {
      id: socket.id, name, color, avatarSeed, currentGame: null,
      score, elapsedMs: 0,
    });
    console.log(`[join] ${name} (${socket.id}) — ${users.size} online`);
  });

  socket.on('profile-update', (profile) => {
    const u = users.get(socket.id);
    if (!u) return;
    const newColor = String(profile?.color || u.color);
    if (newColor !== u.color && takenColors(socket.id).includes(newColor)) {
      socket.emit('profile-rejected', {
        reason: 'color-taken', takenColors: takenColors(socket.id),
      });
      return;
    }
    u.name = String(profile?.name || u.name).slice(0, 40).trim() || u.name;
    u.color = newColor;
    if (profile?.avatarSeed !== undefined) u.avatarSeed = Number(profile.avatarSeed) || u.avatarSeed;
    if (profile?.score !== undefined) u.score = Math.max(0, Number(profile.score) || 0);
    io.emit('profile-updated', publicProfile(socket.id));
  });

  socket.on('signal', ({ to, data }) => {
    if (!to || !users.has(to)) return;
    io.to(to).emit('signal', { from: socket.id, data });
  });

  // --- Game multiplayer relay ---
  // Clients enter a "game room" when they open a game and leave when they go back.
  // The server is the single source of asteroid spawns so every client sees the same field.
  // Fires, ship positions, and kill claims are broadcast peer-to-peer through the room.

  socket.on('game-enter', (gameId) => {
    const u = users.get(socket.id);
    if (!u) return;
    // If user was in another game, leave it first.
    if (u.currentGame && u.currentGame !== gameId) {
      const prev = 'game:' + u.currentGame;
      socket.leave(prev);
      socket.to(prev).emit('game-player-left', { id: socket.id });
    }
    u.currentGame = gameId;
    const room = 'game:' + gameId;
    socket.join(room);
    const loop = ensureGameLoop(gameId);
    const others = [];
    for (const id of io.sockets.adapter.rooms.get(room) || []) {
      if (id !== socket.id && users.has(id)) others.push(publicProfile(id));
    }
    const scores = {};
    for (const [pid, s] of loop.scores) scores[pid] = s;
    const now = Date.now();
    const activeAsteroids = [];
    for (const a of loop.asteroids.values()) {
      activeAsteroids.push({ ...a, spawnedMsAgo: now - a.spawnTime });
    }
    socket.emit('game-state', {
      players: others,
      scores,
      shield: loop.shield,
      asteroids: activeAsteroids,
      paused: loop.paused,
      pausedBy: loop.pausedBy,
    });
    socket.to(room).emit('game-player-joined', publicProfile(socket.id));
    io.emit('user-game-changed', { id: socket.id, currentGame: gameId });
  });

  socket.on('game-leave', (gameId) => {
    const u = users.get(socket.id);
    if (u) u.currentGame = null;
    const room = 'game:' + gameId;
    socket.leave(room);
    socket.to(room).emit('game-player-left', { id: socket.id });
    io.emit('user-game-changed', { id: socket.id, currentGame: null });
  });

  socket.on('game-move', ({ gameId, x, y }) => {
    socket.to('game:' + gameId).emit('game-move', { id: socket.id, x, y });
  });

  socket.on('game-fire', ({ gameId, x, y }) => {
    const u = users.get(socket.id);
    io.to('game:' + gameId).emit('game-fire', {
      id: socket.id,
      x, y,
      color: u?.color || '#ffeb3b',
      bulletId: socket.id + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 6),
    });
  });

  socket.on('game-kill', ({ gameId, asteroidId }) => {
    const loop = gameLoops[gameId];
    if (!loop) return;
    const a = loop.asteroids.get(asteroidId);
    if (!a) return; // already gone — first claim wins
    loop.asteroids.delete(asteroidId);
    const delta = Math.round(50 - a.r);
    loop.scores.set(socket.id, (loop.scores.get(socket.id) || 0) + delta);
    io.to('game:' + gameId).emit('game-kill', {
      asteroidId, by: socket.id, scoreDelta: delta,
    });
  });

  socket.on('game-hit', ({ gameId, asteroidId }) => {
    const loop = gameLoops[gameId];
    if (!loop) return;
    const a = loop.asteroids.get(asteroidId);
    if (!a) return; // already gone
    loop.asteroids.delete(asteroidId);
    // Asteroid radius ranges roughly 14..36; small impacts barely scratch the shield,
    // a max-size impact takes ~35% off in one go.
    const t = Math.max(0, Math.min(1, (a.r - 14) / 22));
    const damage = 5 + t * 30;
    loop.shield = Math.max(0, loop.shield - damage);
    io.to('game:' + gameId).emit('game-hit', {
      asteroidId, damage, shield: loop.shield,
    });
  });

  socket.on('game-restart', (gameId) => {
    const loop = gameLoops[gameId];
    if (loop) {
      loop.ticksAlive = 0;
      loop.spawnIntervalMs = 1100;
      loop.lastSpawn = Date.now();
      loop.scores.clear();
      loop.shield = 100;
      loop.asteroids.clear();
      loop.paused = false;
      loop.pausedBy = null;
    }
    io.to('game:' + gameId).emit('game-restart', { by: socket.id });
  });

  socket.on('game-toggle-pause', (gameId) => {
    const loop = gameLoops[gameId];
    if (!loop) return;
    loop.paused = !loop.paused;
    loop.pausedBy = loop.paused ? socket.id : null;
    if (loop.paused) {
      // freshen lastSpawn so spawns don't burst when we resume
      loop.lastSpawn = Date.now();
      io.to('game:' + gameId).emit('game-paused', { by: socket.id });
    } else {
      loop.lastSpawn = Date.now();
      io.to('game:' + gameId).emit('game-resumed', { by: socket.id });
    }
  });

  socket.on('disconnect', () => {
    if (users.has(socket.id)) {
      const { name } = users.get(socket.id);
      users.delete(socket.id);
      socket.broadcast.emit('user-left', { id: socket.id });
      // socket.io auto-removes from rooms; tell game rooms anyway
      io.emit('game-player-left', { id: socket.id });
      // drop their scores from any active game loops
      for (const loop of Object.values(gameLoops)) loop.scores.delete(socket.id);
      console.log(`[leave] ${name} (${socket.id}) — ${users.size} online`);
    }
  });
});

const gameLoops = {}; // gameId -> { interval, nextId, spawnIntervalMs, lastSpawn, ticksAlive, scores, shield, asteroids }

function ensureGameLoop(gameId) {
  if (gameLoops[gameId]) return gameLoops[gameId];
  const room = 'game:' + gameId;
  const loop = {
    nextId: 1,
    spawnIntervalMs: 1100,
    lastSpawn: Date.now(),
    ticksAlive: 0,
    scores: new Map(),
    shield: 100,
    asteroids: new Map(),
    paused: false,
    pausedBy: null,
  };
  loop.interval = setInterval(() => {
    const members = io.sockets.adapter.rooms.get(room);
    if (!members || members.size === 0) {
      clearInterval(loop.interval);
      delete gameLoops[gameId];
      return;
    }
    if (loop.paused) return;
    loop.ticksAlive++;
    loop.spawnIntervalMs = Math.max(400, 1100 - loop.ticksAlive * 5);
    if (Date.now() - loop.lastSpawn >= loop.spawnIntervalMs) {
      loop.lastSpawn = Date.now();
      const r = 14 + Math.random() * 22;
      const asteroid = {
        id: loop.nextId++,
        x: r + Math.random() * (GAME_W - r * 2),
        r,
        vx: (Math.random() - 0.5) * 40,
        vy: 60 + Math.random() * 100,
        vrot: (Math.random() - 0.5) * 2,
        shape: Math.floor(Math.random() * 1000),
        spawnTime: Date.now(),
      };
      loop.asteroids.set(asteroid.id, asteroid);
      io.to(room).emit('game-asteroid', asteroid);
    }
  }, 100);
  gameLoops[gameId] = loop;
  return loop;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Voice lobby running on http://localhost:${PORT}`);
});
