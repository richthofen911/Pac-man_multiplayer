'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Game, Game3v3 } = require('./game');

const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');

// Render probes this before sending traffic to a newly deployed instance.
app.get('/healthz', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

app.use(express.static(path.join(__dirname, '..', 'public')));

// three.js for the browser, resolved by the importmap in index.html. Only these two subtrees are
// exposed: the package also ships src/, a second unbundled copy of every module, and an import that
// resolved there would build duplicate singletons of the core classes. build/ is mounted whole
// because three.module.js imports its ./three.core.js sibling relatively.
const THREE_ROOT = path.join(__dirname, '..', 'node_modules', 'three');
app.use('/three/build', express.static(path.join(THREE_ROOT, 'build'), { maxAge: '7d' }));
app.use('/three/examples/jsm', express.static(path.join(THREE_ROOT, 'examples', 'jsm'), { maxAge: '7d' }));

const server = http.createServer(app);
const io = new Server(server);

const players = new Map(); // socketId -> {id,name,socket}
let game = null;
let hostId = null;
let gameMode = 'classic';
const totals = new Map();  // name -> cumulative score across games

function maxPlayers() { return gameMode === '3v3' ? 6 : 5; }

function slotName(s) {
  if (gameMode === '3v3') {
    const team = s < 3 ? 'Red' : 'Blue';
    return `${team} ${s % 3 + 1}`;
  }
  return s === 0 ? 'Pacman' : ['Blinky', 'Pinky', 'Inky', 'Clyde'][s - 1];
}

function lobbyPayload() {
  return {
    type: 'lobby',
    mode: gameMode,
    count: players.size,
    max: maxPlayers(),
    isHost: null, // set per-socket on emit
    names: [...players.values()].map(p => p.name),
    starting: !!game,
    slots: game ? game.getRoles().map(r => ({
      role: r.role,
      name: r.name,
      color: r.color,
      team: r.team,
      bot: r.bot
    })) : null
  };
}

function broadcastLobby() {
  const base = lobbyPayload();
  io.emit('lobby', { ...base, isHost: false });
  const ids = [...players.keys()];
  for (const id of ids) {
    io.to(id).emit('lobby', { ...base, isHost: id === hostId });
  }
}

function startGame() {
  if (game) return;
  const list = [...players.values()].slice(0, maxPlayers());
  const Ctor = gameMode === '3v3' ? Game3v3 : Game;
  const finished = new Ctor(list,
    (payload) => io.emit(payload.type, payload),
    {
      onEnd: (winner) => {
        const standings = finished.getStandings();
        for (const row of standings) {
          totals.set(row.name, (totals.get(row.name) || 0) + row.round);
        }
        io.emit('results', {
          winner,
          mode: gameMode,
          standings: standings.map(row => ({ ...row, total: totals.get(row.name) || 0 }))
        });
        game = null;
        broadcastLobby();
      }
    }
  );
  game = finished;
  game.start();
  broadcastLobby();
}

io.on('connection', (socket) => {
  socket.emit('hello', { id: socket.id });

  socket.on('join', ({ name }) => {
    if (players.size >= maxPlayers()) {
      socket.emit('error', { msg: `Lobby is full (${maxPlayers()} players max).` });
      return;
    }
    if (game) {
      socket.emit('error', { msg: 'A game is already in progress. Wait for it to finish.' });
      return;
    }
    if (players.has(socket.id)) return;
    players.set(socket.id, { id: socket.id, socket, name: cleanName(name) });
    if (!hostId) hostId = socket.id;
    broadcastLobby();

    // auto-start when full
    if (players.size === maxPlayers()) startGame();
  });

  socket.on('input', ({ dir }) => {
    if (game) game.setWish(socket.id, dir);
  });

  socket.on('setMode', ({ mode }) => {
    if (socket.id !== hostId) return;
    if (game) return;
    if (mode !== 'classic' && mode !== '3v3') return;
    if (mode === gameMode) return;
    gameMode = mode;
    broadcastLobby();
  });

  socket.on('start', () => {
    if (game) return;
    if (socket.id !== hostId) return;
    if (players.size < 1) return;
    startGame();
  });

  socket.on('restart', () => {
    if (game || !hostId) return;
    if (socket.id !== hostId) return;
    startGame();
  });

  socket.on('leave', () => {
    removePlayer(socket.id);
    broadcastLobby();
  });

  socket.on('disconnect', () => {
    removePlayer(socket.id);
    broadcastLobby();
  });
});

function removePlayer(id) {
  const gone = players.get(id);
  if (!gone) return;
  players.delete(id);
  if (id === hostId) hostId = [...players.keys()][0] || null;

  // bots alone must not keep the lobby shut: an unfinished round is dropped, not scored
  if (players.size === 0) {
    if (game) {
      game.abandon();
      game = null;
    }
    return;
  }

  // convert to bot mid-game
  if (game) {
    const slot = game.slotOfHuman.get(id);
    game.slotOfHuman.delete(id);
    if (slot === undefined) return;
    if (gameMode === '3v3') {
      const e = game.entities[slot];
      if (e) { e.bot = true; e.wish = 'none'; }
    } else if (slot === 0) {
      game.pacman.bot = true;
      game.pacman.wish = 'none';
    } else if (slot >= 1 && slot <= 4) {
      const g = game.ghosts[slot - 1];
      if (g) { g.bot = true; g.wish = 'none'; }
    }
  }
}

function cleanName(name) {
  const n = String(name || '').replace(/[<>]/g, '').trim().slice(0, 12);
  return n || 'Player';
}

const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Pacman server running on port ${PORT}.`);
  if (PUBLIC_URL) {
    console.log(`\n  Public URL:        ${PUBLIC_URL}`);
  } else {
    console.log(`\n  On this device:    http://localhost:${PORT}`);
    console.log(`  On your network:   http://<this-device-ip>:${PORT}`);
  }
  console.log('\nOther players should open the same URL on their own devices.\n');
});

// Render sends SIGTERM on deploys/restarts; close connections instead of dropping them abruptly.
function shutdown(signal) {
  console.log(`${signal} received, shutting down.`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
