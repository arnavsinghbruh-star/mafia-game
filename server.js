
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
const DISCUSSION_TIMEOUT_MS = 20000;
const VOTING_TIMEOUT_MS = 30000;
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
  if (!target) return socket.emit('errorMsg', 'Please choose a living player.');

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
  if (!room || room.phase === 'ended') return;

  clearTimer(room, 'nightTimer');

  let victim = null;

  if (room.night.killedId && room.night.killedId !== room.night.savedId) {
    victim = room.players.find(p => p.id === room.night.killedId && p.alive);
    if (victim) victim.alive = false;
  }

  emitPlayers(roomCode);

  const message = victim
    ? `${victim.name} was killed during the night.`
    : 'No one died during the night.';

  if (checkWinner(roomCode)) return;

  sendPhase(roomCode, 'discussion', 'City wakes up! Discuss what happened.', {
    nightSummary: message
  });

  room.discussionTimer = setTimeout(
    () => startVoting(roomCode),
    DISCUSSION_TIMEOUT_MS
  );
}

function startVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'discussion') return;

  clearTimer(room, 'discussionTimer');
  room.votes = Object.create(null);

  sendPhase(roomCode, 'voting', 'Discussion is over. Cast your vote.');
  maybeFinishVoting(roomCode);

  if (room.phase === 'voting') {
    room.votingTimer = setTimeout(
      () => finishVoting(roomCode),
      VOTING_TIMEOUT_MS
    );
  }
}

function eligibleVoters(room) {
  return room.players.filter(p => p.alive && !p.voteCancelled);
}

function maybeFinishVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'voting') return;

  const eligible = eligibleVoters(room);
  const castCount = eligible.filter(p =>
    Object.prototype.hasOwnProperty.call(room.votes, p.id)
  ).length;

  if (castCount >= eligible.length) finishVoting(roomCode);
}

function majorityVote(room) {
  const counts = Object.create(null);

  for (const voter of eligibleVoters(room)) {
    const targetId = room.votes[voter.id];

    if (!targetId || targetId === 'skip') continue;
    if (!room.players.some(p => p.id === targetId && p.alive)) continue;

    counts[targetId] = (counts[targetId] || 0) + 1;
  }

  const entries = Object.entries(counts);
  if (!entries.length) return null;

  const highest = Math.max(...entries.map(([, count]) => count));
  const leaders = entries.filter(([, count]) => count === highest);

  if (leaders.length !== 1) return null;

  return room.players.find(
    p => p.id === leaders[0][0] && p.alive
  ) || null;
}

function finishVoting(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.phase !== 'voting') return;

  clearTimer(room, 'votingTimer');
  room.majorityVerdictId = (majorityVote(room) || {}).id || null;

  const judge = findRole(room, 'judge');

  if (judge && !room.judgeUsed) {
    sendPhase(roomCode, 'judge_turn', 'Voting is complete. Waiting for the Judge.');

    io.to(judge.id).emit('promptJudge', {
      targetName: room.majorityVerdictId
        ? room.players.find(p => p.id === room.majorityVerdictId).name
        : 'No majority / Skip',
      players: publicPlayers(room)
    });

    room.judgeTimer = setTimeout(() => {
      if (rooms[roomCode] &&
          room.phase === 'judge_turn' &&
          !room.judgeUsed) {
        room.judgeUsed = true;
        applyVerdict(roomCode, room.majorityVerdictId);
      }
    }, JUDGE_TIMEOUT_MS);
  } else {
    applyVerdict(roomCode, room.majorityVerdictId);
  }
}

function applyVerdict(roomCode, targetId) {
  const room = rooms[roomCode];
  if (!room || room.phase === 'ended') return;

  clearTimer(room, 'judgeTimer');

  const eliminated = targetId
    ? room.players.find(p => p.id === targetId && p.alive)
    : null;

  if (eliminated) eliminated.alive = false;

  emitPlayers(roomCode);

  const verdictText = eliminated
    ? `${eliminated.name} was eliminated by the vote.`
    : 'No one was eliminated (skip or tie).';

  concludeRound(roomCode, verdictText);
}

function checkWinner(roomCode) {
  const room = rooms[roomCode];
  if (!room) return true;

  const killer = room.players.find(p => p.role === 'killer');
  const alive = getAlive(room);
  let winner = null;

  if (!killer || !killer.alive) {
    winner = 'City Wins! The Killer has been eliminated!';
  } else if (alive.length <= 3) {
    winner = 'Killer Wins! Three or fewer players remain.';
  }

  if (winner) {
    clearAllTimers(room);
    room.phase = 'ended';

    io.to(roomCode).emit('gameOver', {
      winner,
      players: publicPlayers(room),
      roles: room.players.map(p => ({
        id: p.id,
        name: p.name,
        role: p.role,
        alive: p.alive
      }))
    });

    return true;
  }

  return false;
}

function concludeRound(roomCode, verdictText) {
  const room = rooms[roomCode];
  if (!room) return;

  if (checkWinner(roomCode)) return;

  sendPhase(roomCode, 'round_result', verdictText);
  io.to(roomCode).emit('roundResult', { verdictText });

  room.nextRoundTimer = setTimeout(
    () => startNight(roomCode),
    NEXT_ROUND_DELAY_MS
  );
}

io.on('connection', socket => {
  socket.on('createRoom', payload => {
    const playerName = String(payload?.playerName || '').trim().slice(0, 24);
    const roomCode = String(payload?.roomCode || '').trim().toUpperCase();

    if (!playerName || !roomCode) {
      return socket.emit('errorMsg', 'Enter a nickname to create a room.');
    }

    if (rooms[roomCode]) {
      return socket.emit('errorMsg', 'That room code is already in use. Try again.');
    }

    rooms[roomCode] = {
      host: socket.id,
      players: [{
        id: socket.id,
        name: playerName,
        role: '',
        alive: true,
        silenced: false,
        voteCancelled: false
      }],
      phase: 'lobby',
      votes: Object.create(null),
      night: {},
      judgeUsed: false,
      majorityVerdictId: null,
      nightTimer: null,
      discussionTimer: null,
      votingTimer: null,
      judgeTimer: null,
      nextRoundTimer: null
    };

    socket.join(roomCode);
    socket.emit('roomCreated', { roomCode, isHost: true });
    emitPlayers(roomCode);
  });

  socket.on('joinRoom', payload => {
    const roomCode = String(payload?.roomCode || '').trim().toUpperCase();
    const playerName = String(payload?.playerName || '').trim().slice(0, 24);
    const room = rooms[roomCode];

    if (!playerName || !roomCode) {
      return socket.emit('errorMsg', 'Enter your nickname and room code.');
    }

    if (!room) return socket.emit('errorMsg', 'Room not found.');

    if (room.phase !== 'lobby') {
      return socket.emit('errorMsg', 'This game has already started.');
    }

    if (room.players.length >= MAX_PLAYERS) {
      return socket.emit('errorMsg', 'Room is full (maximum 8 players).');
    }

    room.players.push({
      id: socket.id,
      name: playerName,
      role: '',
      alive: true,
      silenced: false,
      voteCancelled: false
    });

    socket.join(roomCode);
    socket.emit('roomJoined', { roomCode, isHost: false });
    emitPlayers(roomCode);
  });

  socket.on('startGame', roomCode => {
    const room = rooms[roomCode];

    if (!room || room.host !== socket.id) {
      return socket.emit('errorMsg', 'Only the host can start the game.');
    }

    if (room.phase !== 'lobby') return;

    if (room.players.length < MIN_PLAYERS) {
      return socket.emit('errorMsg', `At least ${MIN_PLAYERS} players are required.`);
    }

    assignRoles(room);
    room.judgeUsed = false;

    room.players.forEach(p =>
      io.to(p.id).emit('roleAssigned', { role: p.role })
    );

    startNight(roomCode);
  });

  socket.on('killerAction', payload =>
    roleAction(socket, payload, 'killer', (room, actor, target) => {
      room.night.killedId = target.id;
      advanceNight(payload.roomCode, 'doctor');
    })
  );

  socket.on('doctorAction', payload =>
    roleAction(socket, payload, 'doctor', (room, actor, target) => {
      room.night.savedId = target.id;
      advanceNight(payload.roomCode, 'detective');
    })
  );

  socket.on('detectiveAction', payload =>
    roleAction(socket, payload, 'detective', (room, actor, target) => {
      socket.emit('detectiveResult', {
        isKiller: target.role === 'killer',
        targetName: target.name
      });

      advanceNight(payload.roomCode, 'torturer');
    })
  );

  socket.on('torturerAction', payload => {
    roleAction(socket, payload, 'torturer', (room, actor, target) => {
      if (payload.actionType === 'silence') {
        target.silenced = true;
        target.voteCancelled = false;
      } else if (payload.actionType === 'cancelVote') {
        target.voteCancelled = true;
        target.silenced = false;
      } else {
        return socket.emit('errorMsg', 'Choose a valid Torturer action.');
      }

      emitPlayers(payload.roomCode);
      finishNight(payload.roomCode);
    });
  });

  socket.on('startVoting', roomCode => {
    const room = rooms[roomCode];

    if (!room || room.phase !== 'discussion') return;
    if (!room.players.some(p => p.id === socket.id && p.alive)) return;

    startVoting(roomCode);
  });

  socket.on('castVote', payload => {
    const roomCode = payload?.roomCode;
    const room = rooms[roomCode];

    if (!room || room.phase !== 'voting') return;

    const voter = room.players.find(p => p.id === socket.id);
    if (!voter || !voter.alive) return;

    if (voter.voteCancelled) {
      return socket.emit(
        'errorMsg',
        'Your vote was cancelled by the Torturer this round.'
      );
    }

    const targetId = String(payload.votedId || '');

    if (targetId !== 'skip' &&
        !room.players.some(p => p.id === targetId && p.alive)) {
      return socket.emit('errorMsg', 'That vote target is not available.');
    }

    room.votes[socket.id] = targetId;
    io.to(roomCode).emit('voteRegistered', { voterId: socket.id });
    maybeFinishVoting(roomCode);
  });

  socket.on('judgeAction', payload => {
    const roomCode = payload?.roomCode;
    const room = rooms[roomCode];

    if (!room || room.phase !== 'judge_turn' || room.judgeUsed) return;

    const judge = findRole(room, 'judge');
    if (!judge || judge.id !== socket.id) return;

    room.judgeUsed = true;
    clearTimer(room, 'judgeTimer');

    if (payload.choice === 'pass') {
      applyVerdict(roomCode, room.majorityVerdictId);
    } else if (payload.choice === 'overrule') {
      const target = room.players.find(
        p => p.id === payload.targetId && p.alive
      );

      if (target && target.role === 'killer') {
        applyVerdict(roomCode, target.id);
      } else {
        applyVerdict(roomCode, judge.id);
      }
    } else {
      room.judgeUsed = false;
      socket.emit('errorMsg', 'Choose Pass or Overrule.');
    }
  });

  socket.on('disconnect', () => {
    for (const [roomCode, room] of Object.entries(rooms)) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;

      if (room.phase === 'lobby') {
        room.players.splice(idx, 1);

        if (!room.players.length) {
          delete rooms[roomCode];
          continue;
        }

        if (room.host === socket.id) room.host = room.players[0].id;
        emitPlayers(roomCode);
      } else if (room.phase !== 'ended') {
        const player = room.players[idx];
        player.alive = false;

        emitPlayers(roomCode);

        if (!checkWinner(roomCode) && room.phase === 'voting') {
          maybeFinishVoting(roomCode);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Serving frontend from: ${publicPath}`);
});
