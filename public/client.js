const socket = io();
let currentRoom = null;
let myRole = '';
let myId = '';
let playersList = [];
let isHost = false;
let hasVoted = false;
let currentPhase = 'lobby';

socket.on('connect', () => { myId = socket.id; });
function byId(id) { return document.getElementById(id); }
function createRoom() {
  const name = byId('playerName').value.trim();
  if (!name) return alert('Please enter your nickname.');
  const code = Math.random().toString(36).slice(2, 7).toUpperCase();
  socket.emit('createRoom', { roomCode: code, playerName: name });
}
function joinRoom() {
  const name = byId('playerName').value.trim();
  const code = byId('roomCodeInput').value.trim().toUpperCase();
  if (!name || !code) return alert('Please enter your nickname and room code.');
  socket.emit('joinRoom', { roomCode: code, playerName: name });
}
socket.on('roomCreated', ({roomCode, isHost: host}) => { isHost = host; setupRoom(roomCode); });
socket.on('roomJoined', ({roomCode, isHost: host}) => { isHost = host; setupRoom(roomCode); });
socket.on('errorMsg', msg => alert(msg));

function setupRoom(code) {
  currentRoom = code;
  byId('lobby-select').style.display = 'none';
  byId('game-room').style.display = 'block';
  byId('room-title').innerText = `Room: ${code}`;
  byId('start-btn').style.display = isHost ? 'inline-block' : 'none';
}
socket.on('updatePlayers', payload => {
  // Accept both the current structured payload and an older array payload.
  const players = Array.isArray(payload) ? payload : (payload.players || []);
  if (!Array.isArray(payload) && payload.hostId) {
    isHost = payload.hostId === myId;
    if (currentRoom && payload.roomCode === currentRoom) {
      byId('start-btn').style.display = isHost && currentPhase === 'lobby' ? 'inline-block' : 'none';
    }
  }
  playersList = players;
  const list = byId('player-list');
  list.innerHTML = '';
  players.forEach(p => {
    const row = document.createElement('div');
    row.className = `flex justify-between items-center p-2 rounded bg-slate-800 text-sm ${p.alive ? 'text-slate-200' : 'text-red-400 line-through'}`;
    const name = document.createElement('span');
    name.textContent = `${p.name}${p.id === myId ? ' (You)' : ''}`;
    const status = document.createElement('span');
    status.textContent = `${p.silenced ? '🤐 Silenced ' : ''}${p.voteCancelled ? '🚫 Vote cancelled ' : ''}${!p.alive ? '💀 Dead' : ''}`;
    row.append(name, status);
    list.appendChild(row);
  });
  if (currentPhase === 'voting') renderVotingPanel();
});
socket.on('roleAssigned', ({role}) => {
  myRole = role;
  byId('role-display').innerText = `Role: ${role.toUpperCase()}`;
});
function startGame() {
  socket.emit('startGame', currentRoom);
}
socket.on('phaseChange', ({phase, text, nightSummary}) => {
  currentPhase = phase;
  if (phase !== 'lobby') byId('start-btn').style.display = 'none';
  byId('phase-banner').innerText = text;
  byId('announcement').innerText = nightSummary || '';
  const panel = byId('action-panel');
  panel.innerHTML = '';
  hasVoted = false;
  const me = playersList.find(p => p.id === myId);
  if (me && !me.alive) {
    panel.textContent = 'You have been eliminated. You can watch the rest of the game.';
    return;
  }
  if (['killer','doctor','detective','torturer'].includes(phase)) {
    if (phase === myRole) panel.appendChild(createTargetDropdown(phase));
    else panel.textContent = `The city is asleep. Waiting for ${phase}…`;
  } else if (phase === 'discussion') {
    const note = document.createElement('p');
    note.className = 'text-sm text-slate-300 mb-3';
    note.textContent = me && me.silenced ? '🤐 You are silenced this round; please do not speak.' : 'Discuss what happened, then vote.';
    panel.appendChild(note);
    const btn = makeButton('Proceed to Voting Early', 'bg-red-600 hover:bg-red-700');
    btn.onclick = () => socket.emit('startVoting', currentRoom);
    panel.appendChild(btn);
  } else if (phase === 'voting') renderVotingPanel();
  else if (phase === 'judge_turn') panel.textContent = 'Waiting for the Judge to decide…';
  else if (phase === 'round_result') panel.textContent = 'Preparing the next night…';
});
function makeButton(text, classes) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.className = `px-3 py-2 rounded text-sm font-semibold ${classes}`;
  return btn;
}
function createTargetDropdown(phase) {
  const box = document.createElement('div');
  box.className = 'w-full space-y-3';
  const label = document.createElement('p');
  label.className = 'text-sm font-medium text-yellow-400';
  label.textContent = `Your turn (${phase.toUpperCase()}): select a target`;
  box.appendChild(label);
  const select = document.createElement('select');
  select.id = 'target-select';
  select.className = 'w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-white';
  playersList.filter(p => p.alive).forEach(p => {
    const option = document.createElement('option');
    option.value = p.id;
    option.textContent = `${p.name}${p.id === myId ? ' (You)' : ''}`;
    select.appendChild(option);
  });
  box.appendChild(select);
  let actionSelect;
  if (phase === 'torturer') {
    actionSelect = document.createElement('select');
    actionSelect.className = 'w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-white';
    actionSelect.innerHTML = '<option value="silence">Silence player (can still vote)</option><option value="cancelVote">Cancel vote (can still speak)</option>';
    box.appendChild(actionSelect);
  }
  const submit = makeButton('Confirm Action', 'w-full bg-red-600 hover:bg-red-700');
  submit.onclick = () => {
    const targetId = select.value;
    if (!targetId) return alert('Choose a target.');
    if (phase === 'torturer') socket.emit('torturerAction', {roomCode: currentRoom, targetId, actionType: actionSelect.value});
    else socket.emit(`${phase}Action`, {roomCode: currentRoom, targetId});
    submit.disabled = true;
    submit.textContent = 'Action submitted';
  };
  box.appendChild(submit);
  return box;
}
socket.on('detectiveResult', ({isKiller, targetName}) => {
  alert(isKiller ? `🕵️ ${targetName} IS the Killer!` : `🕵️ ${targetName} is not the Killer.`);
});
function renderVotingPanel() {
  const panel = byId('action-panel');
  panel.innerHTML = '';
  const me = playersList.find(p => p.id === myId);
  if (!me || !me.alive) { panel.textContent = 'You cannot vote while eliminated.'; return; }
  if (me.voteCancelled) {
    panel.textContent = '🚫 Your vote was cancelled by the Torturer. You can still speak.';
    return;
  }
  if (hasVoted) { panel.textContent = '✅ Your vote is registered. Waiting for the other eligible voters…'; return; }
  if (me.silenced) {
    const warning = document.createElement('p');
    warning.className = 'text-yellow-400 text-xs mb-2';
    warning.textContent = '🤐 You are silenced but can still vote.';
    panel.appendChild(warning);
  }
  const heading = document.createElement('h4');
  heading.className = 'text-sm font-semibold text-slate-300 mb-2';
  heading.textContent = 'Cast your vote';
  panel.appendChild(heading);
  const buttons = document.createElement('div');
  buttons.className = 'flex flex-wrap gap-2 justify-center';
  const choices = [{id:'skip', label:'Skip vote'}, ...playersList.filter(p => p.alive).map(p => ({id:p.id, label:`Vote ${p.name}`}))];
  choices.forEach(choice => {
    const btn = makeButton(choice.label, choice.id === 'skip' ? 'bg-slate-700 hover:bg-slate-600' : 'bg-red-900/70 hover:bg-red-800 border border-red-700');
    btn.onclick = () => {
      hasVoted = true;
      socket.emit('castVote', {roomCode: currentRoom, votedId: choice.id});
      renderVotingPanel();
    };
    buttons.appendChild(btn);
  });
  panel.appendChild(buttons);
}
socket.on('voteRegistered', ({voterId}) => {
  if (voterId === myId) { hasVoted = true; renderVotingPanel(); }
});
socket.on('promptJudge', ({targetName}) => {
  const panel = byId('action-panel');
  panel.innerHTML = '';
  if (myRole !== 'judge') { panel.textContent = 'Waiting for the Judge…'; return; }
  const title = document.createElement('p');
  title.className = 'text-sm font-bold text-yellow-400 mb-2';
  title.textContent = `⚖️ Judge decision — majority verdict: ${targetName}`;
  panel.appendChild(title);
  const pass = makeButton('Pass (accept majority)', 'bg-slate-700 hover:bg-slate-600 w-full');
  pass.onclick = () => submitJudge('pass', null);
  panel.appendChild(pass);
  const select = document.createElement('select');
  select.id = 'judge-overrule-target';
  select.className = 'w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded text-white mt-2';
  playersList.filter(p => p.alive).forEach(p => {
    const option = document.createElement('option');
    option.value = p.id; option.textContent = p.name;
    select.appendChild(option);
  });
  panel.appendChild(select);
  const overrule = makeButton('Overrule & guess the Killer', 'bg-red-600 hover:bg-red-700 w-full mt-2');
  overrule.onclick = () => submitJudge('overrule', select.value);
  panel.appendChild(overrule);
});
function submitJudge(choice, targetId) {
  socket.emit('judgeAction', {roomCode: currentRoom, choice, targetId});
  byId('action-panel').textContent = 'Decision submitted…';
}
socket.on('roundResult', ({verdictText}) => {
  currentPhase = 'round_result';
  byId('phase-banner').innerText = verdictText;
  byId('action-panel').textContent = 'Preparing next night…';
});
socket.on('gameOver', ({winner, roles}) => {
  currentPhase = 'ended';
  byId('phase-banner').innerText = `🏆 GAME OVER: ${winner}`;
  const panel = byId('action-panel');
  panel.innerHTML = '';
  const result = document.createElement('p');
  result.className = 'text-slate-300';
  result.textContent = 'Game concluded. Final roles: ' + (roles || []).map(p => `${p.name}: ${p.role}`).join(' · ');
  panel.appendChild(result);
});
