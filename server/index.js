'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { Game } = require('./game');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

const players = new Map(); // socketId -> {id,name,socket}
let game = null;
let hostId = null;
const totals = new Map();  // name -> cumulative score across games

function slotName(s) {
  return s === 0 ? 'Pacman' : ['Blinky', 'Pinky', 'Inky', 'Clyde'][s - 1];
}

function lobbyPayload() {
  return {
    type: 'lobby',
    count: players.size,
    max: MAX_PLAYERS,
    isHost: null, // set per-socket on emit
    names: [...players.values()].map(p => p.name),
    starting: !!game,
    slots: game ? game.getRoles().map(r => ({
      role: r.role,
      name: r.name,
      color: r.color,
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
  const list = [...players.values()].slice(0, MAX_PLAYERS);
  const finished = new Game(list,
    (payload) => io.emit(payload.type, payload),
    {
      onEnd: (winner) => {
        const standings = finished.getStandings();
        for (const row of standings) {
          totals.set(row.name, (totals.get(row.name) || 0) + row.round);
        }
        io.emit('results', {
          winner,
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
    if (players.size >= MAX_PLAYERS) {
      socket.emit('error', { msg: 'Lobby is full (5 players max).' });
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
    if (players.size === MAX_PLAYERS) startGame();
  });

  socket.on('input', ({ dir }) => {
    if (game) game.setWish(socket.id, dir);
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

  // convert to bot mid-game
  if (game) {
    const slot = game.slotOfHuman.get(id);
    game.slotOfHuman.delete(id);
    if (slot === 0) {
      game.pacman.bot = true;
      game.pacman.wish = 'none';
    } else if (slot && slot >= 1 && slot <= 4) {
      const g = game.ghosts[slot - 1];
      g.bot = true;
      g.wish = 'none';
    }
  }
}

function cleanName(name) {
  const n = String(name || '').replace(/[<>]/g, '').trim().slice(0, 12);
  return n || 'Player';
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('Pacman server running.');
  console.log(`\n  On this device:    http://localhost:${PORT}`);
  console.log(`  On your network:   http://<this-device-ip>:${PORT}`);
  console.log('\nOther players should open the network URL on their own devices.\n');
});
