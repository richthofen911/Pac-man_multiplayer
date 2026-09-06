(function () {
  'use strict';

  const socket = io();
  const ROLE_NAMES = ['Pacman', 'Blinky', 'Pinky', 'Inky', 'Clyde'];

  let myId = null;
  let game = null;            // render state (from render.js)
  let myRole = null;          // roles entry for this socket
  let joined = false;
  let isHost = false;
  let inGame = false;

  const el = {
    screenLobby: document.getElementById('screen-lobby'),
    screenGame: document.getElementById('screen-game'),
    name: document.getElementById('name'),
    joinBtn: document.getElementById('joinBtn'),
    startBtn: document.getElementById('startBtn'),
    slotPreview: document.getElementById('slotPreview'),
    status: document.getElementById('status'),
    score: document.getElementById('score'),
    lives: document.getElementById('lives'),
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
    roster: document.getElementById('roster')
  };

  socket.on('connect', () => {
    myId = socket.id;
    renderLobby({ count: 0, max: 5, isHost: false, names: [], starting: false });
  });

  socket.on('hello', ({ id }) => { myId = id; });

  socket.on('lobby', renderLobby);

  socket.on('error', ({ msg }) => { el.status.textContent = '⚠ ' + msg; });

  socket.on('started', (data) => {
    inGame = true;
    game = window.PR.init(data.maze, data.cols, data.rows, data.roles, myId);
    myRole = data.roles.find(r => r.socketId === myId) || null;
    el.leaderboard.innerHTML = '';
    el.surge.hidden = true;
    showGame();
    buildRoleBadge(data.roles);
    buildRoster(data.roles);
  });

  socket.on('state', (st) => {
    if (!game) return;
    window.PR.onState(st);
    el.score.textContent = st.score;
    renderLives(st.lives);
    updateRosterScores(st.players);
    updateSurge(st.pulseIn);
    if (st.over) showOverlay(st.winner);
    else hideOverlay();
  });

  socket.on('results', ({ standings }) => renderLeaderboard(standings));

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

  function leave() {
    socket.emit('leave');
    inGame = false;
    game = null;
    myRole = null;
    joined = false;
    el.joinBtn.disabled = false;
    el.name.disabled = false;
    el.surge.hidden = true;
    hideOverlay();
    showLobby();
  }

  function renderLobby(data) {
    isHost = data.isHost;
    localStorage.setItem('pacman_host', isHost ? '1' : '0');
    if (!inGame) showLobby();
    el.slotPreview.innerHTML = '';

    const slotTexts = ['Pacman', 'Blinky', 'Pinky', 'Inky', 'Clyde'];
    for (let i = 0; i < slotTexts.length; i++) {
      const role = slotTexts[i];
      const div = document.createElement('div');
      div.className = 'slot filled';
      div.style.setProperty('--c', roleColor(role));

      let playerName = null, isBot = false;
      if (data.starting && data.slots && data.slots[i]) {
        playerName = data.slots[i].name;
        isBot = !!data.slots[i].bot;
      } else {
        playerName = i < data.names.length ? data.names[i] : null;
        isBot = playerName === null;
      }

      div.innerHTML = '<span style="color:var(--c)">●</span><span class="rt">' + role + '</span>' +
        (playerName
          ? '<span>' + escapeHtml(playerName) + '</span>' + (isBot ? '<span class="bot">BOT</span>' : '')
          : '<span class="bot">BOT</span>');
      el.slotPreview.appendChild(div);
    }

    if (data.starting) {
      el.status.textContent = 'Game in progress…';
      el.startBtn.hidden = true;
    } else if (data.count >= data.max) {
      el.status.textContent = '5 players — starting!';
      el.startBtn.hidden = true;
    } else {
      const rest = data.max - data.count;
      el.status.textContent = rest > 0
        ? ('Waiting for ' + rest + ' more player' + (rest > 1 ? 's' : '') + '…')
        : 'Ready!';
      el.startBtn.hidden = !(isHost && data.count >= 1);
    }
  }

  function buildRoleBadge(roles) {
    const r = roles.find(x => x.socketId === myId);
    if (!r) return;
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
      const roleName = ROLE_NAMES[r.role] || '?';
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
    el.screenLobby.classList.add('active');
    el.screenGame.classList.remove('active');
    el.overlay.hidden = true;
  }
  function showGame() {
    el.screenLobby.classList.remove('active');
    el.screenGame.classList.add('active');
    el.overlay.hidden = true;
  }

  function showOverlay(winner) {
    el.overlay.hidden = false;
    const title = winner === 'pacman' ? 'Pacman Wins!' : 'Ghosts Win!';
    el.overlayTitle.textContent = title;
    el.overlayText.textContent = winner === 'pacman'
      ? 'All dots cleared. Pacman team takes the round.'
      : 'Pacman ran out of lives. Ghost team takes the round.';
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

  // Swipe on the board
  const board = document.getElementById('game');
  let swipeStart = null;
  board.addEventListener('touchstart', (e) => {
    const t = e.touches[0];
    swipeStart = { x: t.clientX, y: t.clientY };
  }, { passive: true });
  board.addEventListener('touchend', (e) => {
    if (!swipeStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - swipeStart.x;
    const dy = t.clientY - swipeStart.y;
    swipeStart = null;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < 22) return;
    sendDir(ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
  }, { passive: true });

  function roleColor(role) {
    return { Pacman: '#ffd400', Blinky: '#ff0000', Pinky: '#ffb8ff', Inky: '#00ffff', Clyde: '#ffb852' }[role] || '#555';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }

  // render loop
  function loop() {
    requestAnimationFrame(loop);
    if (game) {
      try { window.PR.draw(); } catch (err) { console.error('draw error', err); }
    }
  }
  requestAnimationFrame(loop);
})();
