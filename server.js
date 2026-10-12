'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Always resolve frontend files relative to server.js
const publicPath = path.join(__dirname, 'public');

app.use(express.static(publicPath));

// Explicitly serve the game's homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(publicPath, 'index.html'));
});

const rooms = Object.create(null);
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 8;
const NIGHT_TIMEOUT_MS = 25000;
const JUDGE_TIMEOUT_MS = 15000;
const NEXT_ROUND_DELAY_MS = 3500;

const ROLE_NAMES = ['killer', 'doctor', 'detective', 'torturer', 'judge'];

function publicPlayers(room) {
  return room.players.map(({ id, name, alive, silenced, voteCancelled }) => ({
    id, name, alive, silenced: !!silenced, voteCancelled: !!voteCancelled
  }));
}

function emitPlayers(roomCode) {
  const room = rooms[roomCode];
  if (room) {
    io.to(roomCode).emit('updatePlayers', {
      players: publicPlayers(room),
      hostId: room.host,
      roomCode
    });
  }
}

function clearTimer(room, key) {
  if (room && room[key]) {
    clearTimeout(room[key]);
    room[key] = null;
  }
}

function clearAllTimers(room) {
  ['nightTimer', 'discussionTimer', 'votingTimer', 'judgeTimer', 'nextRoundTimer']
    .forEach(k => clearTimer(room, k));
}

function sendPhase(roomCode, phase, text, extra = {}) {
  const room = rooms[roomCode];
  if (!room) return;
  room.phase = phase;
  io.to(roomCode).emit('phaseChange', { phase, text, ...extra });
}

function getAlive(room) {
  return room.players.filter(p => p.alive);
}

function findRole(room, role) {
  return room.players.find(p => p.role === role && p.alive);
}

function roleAction(socket, payload, expectedRole, action) {
  const roomCode = payload && payload.roomCode;
  const room = rooms[roomCode];

  if (!room || room.phase !== expectedRole) return;

  const actor = room.players.find(p => p.id === socket.id);
  if (!actor || !actor.alive || actor.role !== expectedRole) return;

  const target = room.players.find(p => p.id === payload.targetId && p.alive);
  if (!target) {
    return socket.emit('errorMsg', 'Please choose a living player.');
  }

  clearTimer(room, 'nightTimer');
  action(room, actor, target);
}

function assignRoles(room) {
  const roles = [...ROLE_NAMES];

  while (roles.length < room.players.length) roles.push('citizen');

  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
    p.silenced = false;
    p.voteCancelled = false;
  });
}

function startNight(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase === 'ended') return;

  clearAllTimers(room);
  room.votes = Object.create(null);
  room.night = { killedId: null, savedId: null };

  room.players.forEach(p => {
    p.silenced = false;
    p.voteCancelled = false;
  });

  emitPlayers(roomCode);
  advanceNight(roomCode, 'killer');
}

function advanceNight(roomCode, phase) {
  const room = rooms[roomCode];
  if (!room || room.phase === 'ended') return;

  const actor = findRole(room, phase);

  if (!actor) {
    const next = {
      killer: 'doctor',
      doctor: 'detective',
      detective: 'torturer'
    }[phase];

    if (next) return advanceNight(roomCode, next);
    return finishNight(roomCode);
  }

  const texts = {
    killer: 'City is sleeping… Killer, choose a target.',
    doctor: 'Doctor, choose someone to protect.',
    detective: 'Detective, choose someone to investigate.',
    torturer: 'Torturer, choose a player and an effect.'
  };

  sendPhase(roomCode, phase, texts[phase]);

  // Night actions retain their timeout.
  room.nightTimer = setTimeout(() => {
    if (rooms[roomCode] && rooms[roomCode].phase === phase) {
      if (phase === 'killer') advanceNight(roomCode, 'doctor');
      else if (phase === 'doctor') advanceNight(roomCode, 'detective');
      else if (phase === 'detective') advanceNight(roomCode, 'torturer');
      else finishNight(roomCode);
    }
  }, NIGHT_TIMEOUT_MS);
}

function finishNight(roomCode) {
  const room = rooms[roomCode];
  if (!room || room
