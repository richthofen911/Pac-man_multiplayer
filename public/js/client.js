import { parseMaze } from './shared/maze.js';
import { SnapshotBuffer } from './shared/snapshot.js';
import { createRenderer, preferredKind, setPreferredKind, webglAvailable } from './renderer.js';
import { roleColor, RED_COLOR, BLUE_COLOR } from './shared/theme.js';

const socket = io();
const ROLE_NAMES = ['Pacman', 'Blinky', 'Pinky', 'Inky', 'Clyde'];

let myId = null;
let buffer = null;          // shared snapshot state, read by whichever renderer is active
let renderer = null;        // { draw(), dispose() }
let rendererOpts = null;    // what the current renderer was built from, for an in-place rebuild
let myRole = null;          // roles entry for this socket
let joined = false;
let isHost = false;
let inGame = false;
let gameMode = 'classic';
let gameStage = null;       // last 3v3 stage seen ('skirmish' | 'hunt')
let bannerTimer = null;     // hides the one-shot stage banner

const el = {
  screenLobby: document.getElementById('screen-lobby'),
  screenGame: document.getElementById('screen-game'),
  name: document.getElementById('name'),
  joinBtn: document.getElementById('joinBtn'),
  startBtn: document.getElementById('startBtn'),
  modeRow: document.getElementById('modeRow'),
  modeSelect: document.getElementById('modeSelect'),
  gfxSelect: document.getElementById('gfxSelect'),
  gfxNote: document.getElementById('gfxNote'),
  blobHint: document.getElementById('blobHint'),
  slotPreview: document.getElementById('slotPreview'),
  status: document.getElementById('status'),
  score: document.getElementById('score'),
  classicScoreRow: document.getElementById('classicScoreRow'),
  lives: document.getElementById('lives'),
  teamScores: document.getElementById('teamScores'),
  redScore: document.getElementById('redScore'),
  blueScore: document.getElementById('blueScore'),
  timer: document.getElementById('timer'),
  roleBadge: document.getElementById('roleBadge'),
  overlay: document.getElementById('overlay'),
  overlayTitle: document.getElementById('overlayTitle'),
  overlayText: document.getElementById('overlayText'),
  restartBtn: document.getElementById('restartBtn'),
  restartWait: document.getElementById('restartWait'),
  leaveBtn: document.getElementById('leaveBtn'),
  overlayLeaveBtn: document.getElementById('overlayLeaveBtn'),
  leaderboard: document.getElementById('leaderboard'),
  surge: document.getElementById('surge'),
  roster: document.getElementById('roster'),
  canvasWrap: document.querySelector('.canvas-wrap')
};

socket.on('connect', () => {
  myId = socket.id;
  renderLobby({ count: 0, max: 5, isHost: false, names: [], starting: false, mode: 'classic' });
});

socket.on('hello', ({ id }) => { myId = id; });

socket.on('lobby', renderLobby);

socket.on('error', ({ msg }) => { el.status.textContent = '⚠ ' + msg; });

socket.on('started', (data) => {
  inGame = true;
  gameMode = data.mode || 'classic';
  destroyRenderer();
  const parsed = parseMaze(data.maze, data.cols, data.rows);
  buffer = new SnapshotBuffer(parsed, data.cols, data.rows);
  rendererOpts = {
    buffer, parsed, cols: data.cols, rows: data.rows,
    roles: data.roles, mySocketId: myId, mode: gameMode,
    onFallback: () => showBanner('3D is not available on this device — playing in Classic 2D.', 6000)
  };
  renderer = createRenderer(preferredKind(), rendererOpts);
  watchContextLoss(renderer);
  myRole = data.roles.find(r => r.socketId === myId) || null;
  el.leaderboard.innerHTML = '';
  el.surge.hidden = true;
  if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
  gameStage = null;
  showGame();
  applyHudMode();
  buildRoleBadge(data.roles);
  buildRoster(data.roles);
});

socket.on('state', (st) => {
  if (!buffer) return;
  buffer.push(st);
  if (st.mode === '3v3') {
    el.redScore.textContent = st.teamScores.red;
    el.blueScore.textContent = st.teamScores.blue;
    renderTimer(st.timeRemaining);
    updateRosterScoresFromEntities(st.entities);
    updateRoleBadgeFor3v3(st.entities);
    if (st.stage !== gameStage) {
      gameStage = st.stage;
      if (st.stage === 'hunt' && !st.over) showBanner(huntBannerText(st.entities), 7000);
    }
  } else {
    el.score.textContent = st.score;
    renderLives(st.lives);
    updateRosterScores(st.players);
    updateSurge(st.pulseIn);
  }
  if (st.over) showOverlay(st.winner, st.mode);
  else hideOverlay();
});

socket.on('results', ({ standings, mode }) => renderLeaderboard(standings, mode));

// one-shot toast; #surge is the existing in-game broadcast channel
function showBanner(text, ms) {
  el.surge.textContent = text;
  el.surge.hidden = false;
  if (bannerTimer) clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => { el.surge.hidden = true; bannerTimer = null; }, ms || 6000);
}

function updateSurge(pulseIn) {
  if (pulseIn !== null && pulseIn <= 5) {
    el.surge.textContent = 'Power surge in ' + pulseIn + '…';
    el.surge.hidden = false;
  } else {
    el.surge.hidden = true;
  }
}

function join() {
  const name = (el.name.value || '').trim() || 'Player';
  socket.emit('join', { name });
  joined = true;
  el.joinBtn.disabled = true;
  el.name.disabled = true;
}

el.joinBtn.addEventListener('click', join);
el.name.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
el.startBtn.addEventListener('click', () => socket.emit('start'));
el.restartBtn.addEventListener('click', () => socket.emit('restart'));
el.leaveBtn.addEventListener('click', leave);
el.overlayLeaveBtn.addEventListener('click', leave);
el.modeSelect.addEventListener('change', () => {
  socket.emit('setMode', { mode: el.modeSelect.value });
});

// Graphics choice is local to this browser, so it is seeded once and never touched by lobby updates.
el.gfxSelect.value = preferredKind();
if (!webglAvailable()) {
  el.gfxSelect.querySelector('option[value="3d"]').disabled = true;
  el.gfxSelect.value = '2d';
  el.gfxNote.textContent = '3D is not available on this device, so this game uses Classic 2D.';
  el.gfxNote.hidden = false;
}
el.gfxSelect.addEventListener('change', () => setPreferredKind(el.gfxSelect.value));

function destroyRenderer() {
  if (!renderer) return;
  try { renderer.dispose(); } catch (err) { console.error('renderer dispose failed', err); }
  renderer = null;
}

// Browsers reclaim WebGL contexts when a page is backgrounded or the GPU runs short. The buffer
// survives, so rebuilding in 2D keeps the round going with every dot still eaten.
function watchContextLoss(r) {
  if (!r || !r.canvas) return;
  r.canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    if (renderer !== r) return;
    destroyRenderer();
    renderer = createRenderer('2d', rendererOpts);
    showBanner('3D rendering was lost — continuing in Classic 2D.', 6000);
  });
}

function leave() {
  socket.emit('leave');
  inGame = false;
  destroyRenderer();
  buffer = null;
  myRole = null;
  joined = false;
  el.joinBtn.disabled = false;
  el.name.disabled = false;
  el.surge.hidden = true;
  el.timer.hidden = true;
  el.teamScores.hidden = true;
  el.classicScoreRow.hidden = false;
  el.lives.hidden = false;
  hideOverlay();
  showLobby();
}

function renderLobby(data) {
  isHost = data.isHost;
  gameMode = data.mode || 'classic';
  localStorage.setItem('pacman_host', isHost ? '1' : '0');
  if (!inGame) showLobby();

  // host-only mode picker; disabled once the game has started
  el.modeSelect.value = gameMode;
  el.modeRow.hidden = !isHost || !!data.starting;
  el.modeSelect.disabled = !!data.starting;
  el.blobHint.hidden = gameMode === '3v3';

  el.slotPreview.innerHTML = '';
  const n = data.max || 5;
  el.slotPreview.style.setProperty('--slot-count', n);

  const slots = [];
  for (let i = 0; i < n; i++) {
    if (gameMode === '3v3') {
      const team = i < 3 ? 'Red' : 'Blue';
      slots.push({ label: `${team} ${i % 3 + 1}`, color: team === 'Red' ? RED_COLOR : BLUE_COLOR, team: team.toLowerCase() });
    } else {
      const role = ['Pacman', 'Blinky', 'Pinky', 'Inky', 'Clyde'][i];
      slots.push({ label: role, color: roleColor(role), team: null });
    }
  }

  for (let i = 0; i < n; i++) {
    const s = slots[i];
    const div = document.createElement('div');
    div.className = 'slot filled' + (s.team ? ' team-' + s.team : '');
    div.style.setProperty('--c', s.color);

    let playerName = null, isBot = false;
    if (data.starting && data.slots && data.slots[i]) {
      playerName = data.slots[i].name;
      isBot = !!data.slots[i].bot;
    } else {
      playerName = i < data.names.length ? data.names[i] : null;
      isBot = playerName === null;
    }

    div.innerHTML = '<span style="color:var(--c)">●</span><span class="rt">' + s.label + '</span>' +
      (playerName
        ? '<span>' + escapeHtml(playerName) + '</span>' + (isBot ? '<span class="bot">BOT</span>' : '')
        : '<span class="bot">BOT</span>');
    el.slotPreview.appendChild(div);
  }

  if (data.starting) {
    el.status.textContent = 'Game in progress…';
    el.startBtn.hidden = true;
  } else if (data.count >= data.max) {
    el.status.textContent = data.max + ' players — starting!';
    el.startBtn.hidden = true;
  } else {
    const rest = data.max - data.count;
    el.status.textContent = rest > 0
      ? ('Waiting for ' + rest + ' more player' + (rest > 1 ? 's' : '') + '…')
      : 'Ready!';
    el.startBtn.hidden = !(isHost && data.count >= 1);
  }
}

function applyHudMode() {
  if (gameMode === '3v3') {
    el.classicScoreRow.hidden = true;
    el.lives.hidden = true;
    el.surge.hidden = true;
    el.teamScores.hidden = false;
    el.timer.hidden = false;
  } else {
    el.classicScoreRow.hidden = false;
    el.lives.hidden = false;
    el.teamScores.hidden = true;
    el.timer.hidden = true;
  }
}

function renderTimer(seconds) {
  const s = Math.max(0, seconds | 0);
  const m = Math.floor(s / 60);
  const ss = s % 60;
  el.timer.textContent = m + ':' + (ss < 10 ? '0' : '') + ss;
  el.timer.classList.toggle('warn', s <= 15);
}

function huntBannerText(entities) {
  const mine = myRole ? entities.find(x => x.slot === myRole.role) : null;
  if (!mine) return 'FINAL HUNT · roles are locked — the Ghost hunts, the Pacmen survive';
  return mine.currentRole === 'ghost'
    ? 'FINAL HUNT · you are the Ghost — the only scorer, hunt their Pacmen'
    : 'FINAL HUNT · you are prey — survive the enemy Ghost';
}

function updateRoleBadgeFor3v3(entities) {
  if (!myRole) return;
  const e = entities.find(x => x.slot === myRole.role);
  if (!e) return;
  const teamName = e.team === 'red' ? 'Red' : 'Blue';
  const roleName = e.currentRole === 'ghost' ? 'Ghost' : (e.transitioning ? 'Switching…' : 'Pacman');
  const playerName = e.bot ? 'Bot' : e.name;
  el.roleBadge.innerHTML =
    '<span class="role-chip"><span class="swatch" style="background:' + e.color + '"></span>' +
    teamName + ' · <b>' + roleName + '</b>' +
    '<span class="who">&mdash; ' + escapeHtml(playerName) + '</span></span>';
}

function updateRosterScoresFromEntities(entities) {
  if (!entities) return;
  for (const e of entities) {
    const node = el.roster.querySelector('.sc[data-slot="' + e.slot + '"]');
    if (node) node.textContent = e.score;
  }
}

function buildRoleBadge(roles) {
  const r = roles.find(x => x.socketId === myId);
  if (!r) return;
  if (gameMode === '3v3') {
    const teamName = r.team === 'red' ? 'Red' : 'Blue';
    const playerName = r.bot ? 'Bot' : r.name;
    el.roleBadge.innerHTML =
      '<span class="role-chip"><span class="swatch" style="background:' + r.color + '"></span>' +
      teamName + ' · <b>Ghost</b>' +
      '<span class="who">&mdash; ' + escapeHtml(playerName) + '</span></span>';
    return;
  }
  const roleName = ROLE_NAMES[r.role] || 'Spectator';
  const playerName = r.bot ? 'Bot' : r.name;
  el.roleBadge.innerHTML =
    '<span class="role-chip"><span class="swatch" style="background:' + r.color + '"></span>' +
    'You are <b>' + escapeHtml(roleName) + '</b>' +
    '<span class="who">&mdash; ' + escapeHtml(playerName) + '</span></span>';
}

function buildRoster(roles) {
  el.roster.innerHTML = '';
  for (const r of roles) {
    const card = document.createElement('div');
    card.className = 'roster-card' + (r.socketId === myId ? ' you' : '');
    const roleName = gameMode === '3v3'
      ? `${r.team === 'red' ? 'Red' : 'Blue'} ${r.role % 3 + 1}`
      : (ROLE_NAMES[r.role] || '?');
    const playerName = r.bot ? 'Computer' : r.name;
    card.innerHTML =
      '<span class="swatch" style="background:' + r.color + '"></span>' +
      '<span class="rm">' + escapeHtml(roleName) + '</span>' +
      '<span class="nm">' + escapeHtml(playerName) + '</span>' +
      '<span class="sc" data-slot="' + r.role + '">0</span>' +
      (r.bot ? '<span class="bot">BOT</span>' : '');
    el.roster.appendChild(card);
  }
}

function updateRosterScores(players) {
  if (!players) return;
  for (const p of players) {
    const node = el.roster.querySelector('.sc[data-slot="' + p.slot + '"]');
    if (node) node.textContent = p.score;
  }
}

function renderLeaderboard(standings) {
  if (!standings || !standings.length) return;
  const medals = ['🥇', '🥈', '🥉'];
  el.leaderboard.innerHTML = '<div class="lb-title">Leaderboard</div>';
  standings.forEach((row, i) => {
    const div = document.createElement('div');
    div.className = 'lb-row' + (row.bot ? ' bot-row' : '');
    div.innerHTML =
      '<span class="lb-rank">' + (medals[i] || (i + 1) + '.') + '</span>' +
      '<span class="swatch" style="background:' + row.color + '"></span>' +
      '<span class="lb-name">' + escapeHtml(row.name) + (row.bot ? ' <span class="bot">BOT</span>' : '') + '</span>' +
      '<span class="lb-role">' + escapeHtml(row.roleName) + '</span>' +
      '<span class="lb-round">+' + row.round + '</span>' +
      '<span class="lb-total">' + row.total + '</span>';
    el.leaderboard.appendChild(div);
  });
}

function showLobby() {
  document.documentElement.classList.remove('no-pull-refresh');
  el.screenLobby.classList.add('active');
  el.screenGame.classList.remove('active');
  el.overlay.hidden = true;
}
function showGame() {
  document.documentElement.classList.add('no-pull-refresh');
  el.screenLobby.classList.remove('active');
  el.screenGame.classList.add('active');
  el.overlay.hidden = true;
}

function showOverlay(winner, mode) {
  el.overlay.hidden = false;
  let title, text;
  if (mode === '3v3') {
    if (winner === 'red')       { title = 'Red Wins!';   text = 'Team Red takes the round.'; }
    else if (winner === 'blue') { title = 'Blue Wins!';  text = 'Team Blue takes the round.'; }
    else                        { title = 'Draw!';       text = 'Both teams finished even.'; }
  } else {
    title = winner === 'pacman' ? 'Pacman Wins!' : 'Ghosts Win!';
    text = winner === 'pacman'
      ? 'All dots cleared. Pacman team takes the round.'
      : 'Pacman ran out of lives. Ghost team takes the round.';
  }
  el.overlayTitle.textContent = title;
  el.overlayText.textContent = text;
  el.restartBtn.hidden = !isHost;
  el.restartWait.hidden = isHost;
}
function hideOverlay() { el.overlay.hidden = true; }

function renderLives(lives) {
  el.lives.innerHTML = '';
  for (let i = 0; i < lives; i++) {
    const d = document.createElement('div');
    d.className = 'life';
    el.lives.appendChild(d);
  }
}

const KEYMAP = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right'
};

function sendDir(dir) { socket.emit('input', { dir }); }

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const dir = KEYMAP[e.code];
  if (dir) {
    e.preventDefault();
    sendDir(dir);
  }
});

// --- on-screen touch controls ---
function markTouch() { document.body.classList.add('touch'); }
window.addEventListener('touchstart', markTouch, { once: true, passive: true });

// Virtual joystick
const joy = document.getElementById('joy');
const knob = document.getElementById('joyKnob');
const JOY_MAX = 36;      // knob travel in px
const JOY_DEADZONE = 12; // px before a direction registers
let joyDir = null;
let joyPointer = null;

function joyCenter() {
  const r = joy.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function joySetKnob(dx, dy) {
  knob.style.transform = 'translate(calc(-50% + ' + dx + 'px), calc(-50% + ' + dy + 'px))';
}

function joyUpdate(e) {
  const c = joyCenter();
  let dx = e.clientX - c.x;
  let dy = e.clientY - c.y;
  const mag = Math.hypot(dx, dy);
  if (mag > JOY_MAX) { dx *= JOY_MAX / mag; dy *= JOY_MAX / mag; }
  joySetKnob(Math.round(dx), Math.round(dy));

  if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < JOY_DEADZONE) return; // keep last dir
  const dir = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'down' : 'up');
  if (dir !== joyDir) {
    joyDir = dir;
    sendDir(dir);
  }
}

function joyEnd() {
  joyPointer = null;
  joy.classList.remove('active');
  joySetKnob(0, 0);
  // last wish persists, matching keyboard behavior
}

joy.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  joyPointer = e.pointerId;
  joy.setPointerCapture(e.pointerId);
  joy.classList.add('active');
  joyDir = null;
  joyUpdate(e);
});
joy.addEventListener('pointermove', (e) => {
  if (e.pointerId !== joyPointer) return;
  e.preventDefault();
  joyUpdate(e);
});
joy.addEventListener('pointerup', joyEnd);
joy.addEventListener('pointercancel', joyEnd);

// Swipe on the board. Bound to the container rather than #game so it keeps working when the 3D
// renderer mounts its own canvas and hides #game. The label overlay is pointer-events:none, so a
// touch there falls through to the canvas and still counts as a board touch.
let swipeStart = null;
const onBoard = (t) => t === el.canvasWrap || t.tagName === 'CANVAS';

el.canvasWrap.addEventListener('touchstart', (e) => {
  if (!onBoard(e.target)) return;
  const t = e.touches[0];
  swipeStart = { x: t.clientX, y: t.clientY };
}, { passive: true });
el.canvasWrap.addEventListener('touchend', (e) => {
  if (!swipeStart || !onBoard(e.target)) return;
  const t = e.changedTouches[0];
  const dx = t.clientX - swipeStart.x;
  const dy = t.clientY - swipeStart.y;
  swipeStart = null;
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < 22) return;
  sendDir(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
}, { passive: true });
el.canvasWrap.addEventListener('touchcancel', () => { swipeStart = null; }, { passive: true });

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

// render loop
function loop() {
  requestAnimationFrame(loop);
  if (renderer) {
    try { renderer.draw(); } catch (err) { console.error('draw error', err); }
  }
}
requestAnimationFrame(loop);
