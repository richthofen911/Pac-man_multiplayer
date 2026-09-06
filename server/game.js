'use strict';

const mazeMod = require('./maze');
const {
  MAP, TILE, COLS, ROWS, DX, DY, OPPOSITE,
  buildMaze, canEnter, canMove, neighbor, tileAt
} = mazeMod;

const DT = 1 / 30; // 30 ticks/sec
const PACMAN_SPEED = 3.3;   // tiles / sec
const GHOST_SPEED = 2.7;
const FRIGHT_SPEED = 2.4;

const TAG_BONUS = 200;           // ghost credit for costing pacman a life
const ASSIST_BONUS = 175;        // for ghosts near pacman when he dies
const GHOST_INCOME = 11;         // ghost survival points / sec
const GHOST_INCOME_RANGE = 8;    // income + assists only within this many tiles of pacman
const WIN_BONUS = 500;           // per member of the winning side

// anti-blob: ghosts that cluster together too long become edible
const BLOB_RANGE = 3;            // tiles — proximity that counts as packing
const BLOB_TIME = 5;             // seconds of continuous packing before exposure

// camp tax: ghosts that hold a small area too long become edible
const CAMP_RADIUS = 2;           // tiles of drift allowed from anchor point
const CAMP_TIME = 7;             // seconds stationary before exposure

// endgame fright pulses: guaranteed breach windows vs sieges
const PULSE_THRESHOLD = 25;      // dots remaining to enter endgame
const PULSE_PERIOD = 15;         // seconds between pulses
const PULSE_DURATION = 4;        // fright seconds per pulse
const PULSE_FIRST_DELAY = 5;     // first pulse after crossing threshold
const PULSE_APPROACH_WINDOW = 3; // bot pacman closes on a ghost this long before pulse

// ghost bodies: blocked this long -> phase through to break deadlocks
const GHOST_BLOCKED_PHASE = 1.0; // seconds

// bot pacman pellet seeking: chase a pellet when its BFS distance <= nearest dot * PELLET_RATIO
const PELLET_RATIO = 4;

// bot pacman threat projection: also evaluate where each threat ghost will be this many seconds ahead
const DANGER_LOOKAHEAD = 0.4;

const GHOST_NAMES = ['Blinky', 'Pinky', 'Inky', 'Clyde'];
const GHOST_COLORS = ['#ff0000', '#ffb8ff', '#00ffff', '#ffb852'];
const PACMAN_COLOR = '#ffd400';

const PACMAN_SPAWN = { r: 23, c: 14 };
const GHOST_SPAWNS = [
  { r: 11, c: 13, release: 0 },
  { r: 14, c: 11, release: 3 },
  { r: 14, c: 16, release: 5 },
  { r: 14, c: 12, release: 7 }
];

class Game {
  constructor(players, broadcast, cb) {
    this.players = players;          // [{id,socket,name}]
    this.broadcast = broadcast;      // (payload) => void  payload has .type
    this.cb = cb || {};

    this.maze = buildMaze().maze;
    this.dots = new Set();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (this.maze[r][c] === TILE.DOT || this.maze[r][c] === TILE.PELLET)
          this.dots.add(r + ',' + c);

    this.score = 0;
    this.lives = 3;
    this.frightTimer = 0;
    this.gameTime = 0;
    this.endgame = false;
    this.nextPulseAt = null;
    this.over = false;
    this.winner = null;
    this.eatenThisTick = [];

    this.assignRoles();
    this.layoutEntities();
    this.loop = null;
  }

  // --- role assignment: shuffle 5 slots, humans take first n, bots fill rest ---
  assignRoles() {
    const slots = [0, 1, 2, 3, 4];
    shuffle(slots);
    this.slotOfHuman = new Map();
    const n = Math.min(this.players.length, 5);
    for (let i = 0; i < n; i++) this.slotOfHuman.set(this.players[i].id, slots[i]);
  }

  layoutEntities() {
    const p = this.players.find(pl => this.slotOfHuman.get(pl.id) === 0);
    this.pacman = this.makePacman(p);

    this.ghosts = [];
    for (let s = 1; s <= 4; s++) {
      const human = this.players.find(pl => this.slotOfHuman.get(pl.id) === s);
      this.ghosts.push(this.makeGhost(s, human));
    }
  }

  roleOfSlot(slotId) { return slotId; } // 0 = pacman, 1-4 = ghosts

  makePacman(human) {
    return {
      kind: 'pacman',
      slot: 0,
      name: human ? human.name : 'Bot',
      bot: !human,
      color: PACMAN_COLOR,
      spawn: PACMAN_SPAWN,
      r: PACMAN_SPAWN.r, c: PACMAN_SPAWN.c,
      nr: null, nc: null, progress: 0, inTransit: false,
      dir: 'none', wish: 'none',
      px: PACMAN_SPAWN.c, py: PACMAN_SPAWN.r,
      speed: PACMAN_SPEED,
      score: 0,
      friendly: false,
      invincible: false, invincUntil: 0
    };
  }

  makeGhost(slot, human) {
    const i = slot - 1;
    const sp = GHOST_SPAWNS[i];
    const g = {
      kind: 'ghost',
      slot,
      i,
      personality: GHOST_NAMES[i],
      name: human ? human.name : 'Bot ' + GHOST_NAMES[i],
      bot: !human,
      color: GHOST_COLORS[i],
      spawn: { r: sp.r, c: sp.c },
      releaseAt: sp.release,
      r: sp.r, c: sp.c,
      nr: null, nc: null, progress: 0, inTransit: false,
      dir: 'none', wish: 'none',
      px: sp.c, py: sp.r,
      speed: GHOST_SPEED,
      frightSpeed: FRIGHT_SPEED,
      score: 0, scoreF: 0,
      packTime: 0, exposed: false,
      anchorX: sp.c, anchorY: sp.r, campTime: 0,
      blockedFor: 0, phasing: false,
      friendly: true,
      frightened: false,
      eaten: false,
      eatenTimer: 0
    };
    return g;
  }

  // --- public API ---
  start() {
    this.over = false;
    this.broadcastStarted();
    this.loop = setInterval(() => this.tick(DT), DT * 1000);
  }

  setWish(socketId, dir) {
    if (this.over) return;
    const slot = this.slotOfHuman.get(socketId);
    if (slot === undefined) return;
    if (slot === 0) this.pacman.wish = dir;
    else {
      const g = this.ghosts[slot - 1];
      if (g) g.wish = dir;
    }
  }

  getRoles() {
    const roles = [];
    for (let s = 0; s < 5; s++) {
      const humanId = [...this.slotOfHuman.entries()].find(([, v]) => v === s)?.[0];
      if (s === 0) {
        roles.push({ socketId: humanId || null, name: this.pacman.name, role: 0, color: PACMAN_COLOR, bot: this.pacman.bot });
      } else {
        const g = this.ghosts[s - 1];
        roles.push({ socketId: humanId || null, name: g.name, role: s, color: g.color, bot: g.bot });
      }
    }
    return roles;
  }

  broadcastStarted() {
    this.broadcast({ type: 'started', maze: MAP, cols: COLS, rows: ROWS, roles: this.getRoles() });
  }

  // --- main loop ---
  tick(dt) {
    if (this.over) return;
    this.gameTime += dt;

    if (this.frightTimer > 0) {
      this.frightTimer -= dt;
      if (this.frightTimer <= 0) this.endFright();
    }

    // endgame fright pulses
    this.endgame = this.dots.size <= PULSE_THRESHOLD;
    if (this.endgame && this.nextPulseAt === null) {
      this.nextPulseAt = this.gameTime + PULSE_FIRST_DELAY;
    }
    if (this.endgame && !this.isFright() && this.gameTime >= this.nextPulseAt) {
      this.startFright(PULSE_DURATION);
      this.nextPulseAt = this.gameTime + PULSE_PERIOD;
    }

    const p = this.pacman;
    this.moveEntity(p, dt, p.speed);
    this.collectTile(p);

    for (const g of this.ghosts) {
      if (this.gameTime < g.releaseAt) continue;
      if (g.eaten) {
        g.eatenTimer -= dt;
        if (g.eatenTimer <= 0) this.reviveGhost(g);
        continue;
      }
      const spd = this.isFright() ? g.frightSpeed : g.speed;
      this.moveEntity(g, dt, spd);
      // pressure income: only earn while hunting near pacman
      if (Math.hypot(g.px - p.px, g.py - p.py) <= GHOST_INCOME_RANGE) {
        g.scoreF += GHOST_INCOME * dt;
        if (g.scoreF >= 1) {
          const add = Math.floor(g.scoreF);
          g.scoreF -= add;
          g.score += add;
        }
      }
    }

    this.updatePacking(dt);
    this.checkCollisions();

    if (this.dots.size === 0 && !this.over) this.end('pacman');

    this.broadcastState();
  }

  // solid ghosts hold their logical tile and their transit destination
  reservesTile(g) {
    return g.kind === 'ghost' && !g.eaten && !g.frightened && !g.exposed &&
      !g.phasing && this.gameTime >= g.releaseAt;
  }

  tileReservedBy(r, c, self) {
    for (const g of this.ghosts) {
      if (g === self || !this.reservesTile(g)) continue;
      if (g.r === r && g.c === c) return true;
      if (g.inTransit && g.nr === r && g.nc === c) return true;
    }
    return false;
  }

  // bot escape hatch when the chosen way is body-blocked
  altDir(e) {
    const opp = OPPOSITE[e.dir] || null;
    for (const d of ['up', 'down', 'left', 'right']) {
      if (d === opp) continue;
      if (!canMove(this.maze, e.r, e.c, d, e.friendly)) continue;
      const nb = neighbor(this.maze, e.r, e.c, d, e.friendly);
      if (!this.tileReservedBy(nb.r, nb.c, e)) return d;
    }
    if (opp && canMove(this.maze, e.r, e.c, opp, e.friendly)) {
      const nb = neighbor(this.maze, e.r, e.c, opp, e.friendly);
      if (!this.tileReservedBy(nb.r, nb.c, e)) return opp;
    }
    return 'none';
  }

  moveEntity(e, dt, speed) {
    if (!e.inTransit) {
      let d = this.nextDir(e);

      // ghost bodies: refuse to enter a reserved tile (unless phasing)
      if (d !== 'none' && e.kind === 'ghost' && !e.phasing) {
        let nb = neighbor(this.maze, e.r, e.c, d, e.friendly);
        if (this.tileReservedBy(nb.r, nb.c, e)) {
          e.blockedFor += dt;
          if (e.bot) {
            const alt = this.altDir(e);
            if (alt !== 'none') { d = alt; nb = neighbor(this.maze, e.r, e.c, d, e.friendly); }
          }
          if (this.tileReservedBy(nb.r, nb.c, e)) {
            // still blocked: wait; phase through after GHOST_BLOCKED_PHASE
            e.dir = d;
            e.px = e.c; e.py = e.r;
            if (e.blockedFor >= GHOST_BLOCKED_PHASE) e.phasing = true;
            return;
          }
        }
        e.blockedFor = 0;
        e.dir = d;
        e.nr = nb.r; e.nc = nb.c; e.inTransit = true; e.progress = 0;
      } else {
        e.dir = d;
        if (d === 'none') {
          e.px = e.c; e.py = e.r;
          return;
        }
        const nb = neighbor(this.maze, e.r, e.c, d, e.friendly);
        e.nr = nb.r; e.nc = nb.c; e.inTransit = true; e.progress = 0;
      }
    }

    e.progress += speed * dt;
    if (e.progress >= 1) {
      e.progress = 0;
      e.r = e.nr; e.c = e.nc; e.inTransit = false; e.nr = null; e.nc = null;
      if (e.kind === 'ghost') {
        if (e.phasing) e.phasing = false; // one free step consumed
        e.blockedFor = 0;
      }
    }

    if (e.inTransit) {
      e.px = e.c + DX[e.dir] * e.progress;
      e.py = e.r + DY[e.dir] * e.progress;
    } else {
      e.px = e.c; e.py = e.r;
    }
  }

  nextDir(e) {
    const ghost = e.friendly;
    // human chooses freely (respect walls / doors for ghosts)
    if (e.wish && e.wish !== 'none' && canMove(this.maze, e.r, e.c, e.wish, ghost)) return e.wish;

    if (e.bot) {
      if (ghost && (this.isFright() || e.exposed)) return this.randomDir(e);
      if (!ghost) return this.pacmanBotDir(e);
      const target = this.botTarget(e);
      if (target) {
        const d = this.bfsFirstStep(e.r, e.c, target, ghost);
        if (d) return d;
      }
      // fall through to straight / none below
    }

    // humans / bots continue straight if open
    if (e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, ghost)) return e.dir;
    return 'none';
  }

  // distance to the nearest live threat — edible ghosts (frightened / exposed) are excluded.
  // optional `lookahead` projects each threat along its current heading by `speed * t` tiles.
  nearestGhostDist(r, c, lookahead = 0) {
    let best = Infinity;
    for (const g of this.ghosts) {
      if (g.eaten || this.gameTime < g.releaseAt) continue;
      if (this.isGhostEdible(g)) continue;
      let gx = g.px, gy = g.py;
      if (lookahead > 0) {
        const spd = g.speed * lookahead;
        gx += (DX[g.dir] || 0) * spd;
        gy += (DY[g.dir] || 0) * spd;
      }
      best = Math.min(best, Math.hypot(gx - c, gy - r));
    }
    return best;
  }

  isGhostEdible(g) {
    return !g.eaten && this.gameTime >= g.releaseAt && (this.isFright() || g.exposed);
  }

  // nearest edible ghost tile, or null if none are edible
  nearestEdibleGhost(e) {
    let best = null, bestDist = Infinity;
    for (const g of this.ghosts) {
      if (!this.isGhostEdible(g)) continue;
      const d = Math.hypot(g.px - e.px, g.py - e.py);
      if (d < bestDist) { bestDist = d; best = g; }
    }
    return best ? { r: best.r, c: best.c } : null;
  }

  // nearest live ghost tile (released + not eaten) — used for pulse pre-positioning
  nearestLiveGhost(e) {
    let best = null, bestDist = Infinity;
    for (const g of this.ghosts) {
      if (g.eaten || this.gameTime < g.releaseAt) continue;
      const d = Math.hypot(g.px - e.px, g.py - e.py);
      if (d < bestDist) { bestDist = d; best = g; }
    }
    return best ? { r: best.r, c: best.c } : null;
  }

  nearestPellet(e) {
    return this.bfsGoalDist(e.r, e.c, false, (r, c) => this.maze[r][c] === TILE.PELLET);
  }

  // full pacman-bot decision: chase edible ghosts > seek pellets > collect dots
  pacmanBotDir(e) {
    // 1. aggressively chase the nearest edible ghost — no dodge, reward is worth it
    const edible = this.nearestEdibleGhost(e);
    if (edible) {
      const d = this.bfsFirstStep(e.r, e.c, edible, false);
      if (d) return d;
    }
    // 2. endgame pulse incoming — close on a ghost so we can eat it the moment fright fires
    if (this.endgame && !this.isFright() && this.nextPulseAt !== null &&
        (this.nextPulseAt - this.gameTime) <= PULSE_APPROACH_WINDOW) {
      const approach = this.nearestLiveGhost(e);
      if (approach) {
        const d = this.bfsFirstStep(e.r, e.c, approach, false);
        if (d) return this.pacmanSafeDir(e, approach, d);
      }
    }
    // 3. prefer power pellets when no fright active, but skip them if a dot is much closer
    let target = null;
    if (!this.isFright()) {
      const pellet = this.nearestPellet(e);
      if (pellet) {
        const nearestDotOnly = this.bfsGoalDist(e.r, e.c, false, (r, c) => this.maze[r][c] === TILE.DOT);
        if (!nearestDotOnly || pellet.dist <= nearestDotOnly.dist * PELLET_RATIO) target = pellet;
      }
    }
    // 4. fall back to nearest dot / pellet
    if (!target) target = this.nearestDot(e);
    if (target) {
      const d = this.bfsFirstStep(e.r, e.c, target, false);
      if (d) return this.pacmanSafeDir(e, target, d);
    }
    if (e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, false)) return e.dir;
    return 'none';
  }

  // pick a safe step toward the target; fall back to the safest open dir
  pacmanSafeDir(e, target, bfsDir) {
    const SAFE = 2.5;
    const tryOrder = [bfsDir];
    const opp = OPPOSITE[e.dir] || null;
    for (const d of ['up', 'left', 'down', 'right']) {
      if (d !== bfsDir && d !== opp) tryOrder.push(d);
    }
    if (opp) tryOrder.push(opp);
    let bestDir = null, bestDist = -Infinity;
    for (const d of tryOrder) {
      if (!canMove(this.maze, e.r, e.c, d, false)) continue;
      const nb = neighbor(this.maze, e.r, e.c, d, false);
      // worst case between "now" and "lookahead seconds from now" along each ghost's heading
      const now = this.nearestGhostDist(nb.r, nb.c);
      const projected = this.nearestGhostDist(nb.r, nb.c, DANGER_LOOKAHEAD);
      const dist = Math.min(now, projected);
      if (dist >= SAFE) return d;             // safe and closest to preference order
      if (dist > bestDist) { bestDist = dist; bestDir = d; }
    }
    return bestDir; // all dangerous: take the one farthest from any ghost
  }

  botTarget(e) {
    const p = this.pacman;
    const per = e.personality;
    if (per === 'Blinky') return { r: p.r, c: p.c };
    if (per === 'Pinky') {
      const dr = DY[p.dir] || (p.dir === 'none' ? 0 : DY[p.wish] || 0);
      const dc = DX[p.dir] || (p.dir === 'none' ? 0 : DX[p.wish] || 0);
      return this.clampCell(p.r + dr * 4, p.c + dc * 4);
    }
    if (per === 'Inky') {
      const blinky = this.ghosts[0];
      const dr = DY[p.dir] || 0, dc = DX[p.dir] || 0;
      const ax = p.r + dr * 2, ay = p.c + dc * 2;
      return this.clampCell(ax * 2 - blinky.r, ay * 2 - blinky.c);
    }
    // Clyde: near pacman -> chase, far -> scatter corner
    const dist = Math.hypot(p.px - e.px, p.py - e.py);
    return dist > 8 ? { r: p.r, c: p.c } : this.clampCell(ROWS - 1, COLS - 5);
  }

  nearestDot(e) {
    const found = this.bfsGoal(e.r, e.c, false, (r, c) =>
      this.maze[r][c] === TILE.DOT || this.maze[r][c] === TILE.PELLET);
    return found;
  }

  clampCell(r, c) {
    return { r: Math.min(ROWS - 1, Math.max(0, r)), c: Math.min(COLS - 1, Math.max(0, c)) };
  }

  randomDir(e) {
    const order = shuffle(['up', 'down', 'left', 'right']);
    const open = order.filter(d => canMove(this.maze, e.r, e.c, d, true));
    if (!open.length) return 'none';
    const rev = OPPOSITE[e.dir];
    const noRev = open.filter(d => d !== rev);
    const pool = noRev.length ? noRev : open;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // BFS from (r,c): returns first goal cell reached, or null
  bfsGoal(r, c, ghost, isGoal) {
    const seen = new Set([r + ',' + c]);
    const q = [[r, c]];
    while (q.length) {
      const [cr, cc] = q.shift();
      if ((cr !== r || cc !== c) && isGoal(cr, cc)) return { r: cr, c: cc };
      for (const d of ['up', 'left', 'down', 'right']) {
        let nr = cr + DY[d], nc = cc + DX[d];
        if (nc < 0) nc = COLS - 1; if (nc >= COLS) nc = 0;
        if (nr < 0 || nr >= ROWS) continue;
        const k = nr + ',' + nc;
        if (seen.has(k)) continue;
        if (!canEnter(this.maze, nr, nc, ghost)) continue;
        seen.add(k); q.push([nr, nc]);
      }
    }
    return null;
  }

  // same as bfsGoal but also returns BFS depth (graph distance from start)
  bfsGoalDist(r, c, ghost, isGoal) {
    const seen = new Set([r + ',' + c]);
    const q = [[r, c, 0]];
    while (q.length) {
      const [cr, cc, depth] = q.shift();
      if ((cr !== r || cc !== c) && isGoal(cr, cc)) return { r: cr, c: cc, dist: depth };
      for (const d of ['up', 'left', 'down', 'right']) {
        let nr = cr + DY[d], nc = cc + DX[d];
        if (nc < 0) nc = COLS - 1; if (nc >= COLS) nc = 0;
        if (nr < 0 || nr >= ROWS) continue;
        const k = nr + ',' + nc;
        if (seen.has(k)) continue;
        if (!canEnter(this.maze, nr, nc, ghost)) continue;
        seen.add(k); q.push([nr, nc, depth + 1]);
      }
    }
    return null;
  }

  // BFS: first-step direction from (r,c) toward target, or null
  bfsFirstStep(r, c, target, ghost) {
    if (target.r === r && target.c === c) return null;
    const startK = r + ',' + c;
    const seen = new Set([startK]);
    const firstDir = new Map(); firstDir.set(startK, null);
    const q = [[r, c]];
    while (q.length) {
      const [cr, cc] = q.shift();
      const k1 = cr + ',' + cc;
      if (cr === target.r && cc === target.c) return firstDir.get(k1);
      for (const d of ['up', 'left', 'down', 'right']) {
        let nr = cr + DY[d], nc = cc + DX[d];
        if (nc < 0) nc = COLS - 1; if (nc >= COLS) nc = 0;
        if (nr < 0 || nr >= ROWS) continue;
        const k = nr + ',' + nc;
        if (seen.has(k)) continue;
        if (!canEnter(this.maze, nr, nc, ghost)) continue;
        seen.add(k);
        let fd = firstDir.get(k1);
        if (fd == null) fd = d;
        firstDir.set(k, fd);
        q.push([nr, nc]);
      }
    }
    return null;
  }

  collectTile(e) {
    const t = this.maze[e.r][e.c];
    if (t === TILE.DOT) {
      this.score += 7;
      e.score += 7;
      this.eraseDot(e.r, e.c);
    } else if (t === TILE.PELLET) {
      this.score += 35;
      e.score += 35;
      this.eraseDot(e.r, e.c);
      this.startFright();
    }
  }

  eraseDot(r, c) {
    if (this.maze[r][c] === TILE.EMPTY) return;
    this.maze[r][c] = TILE.EMPTY;
    const k = r + ',' + c;
    this.dots.delete(k);
    this.eatenThisTick.push(k);
  }

  isFright() { return this.frightTimer > 0; }

  // ghosts that cluster together OR hold a small area become exposed (edible without fright)
  updatePacking(dt) {
    const active = this.ghosts.filter(g => !g.eaten && this.gameTime >= g.releaseAt);
    for (const g of this.ghosts) {
      if (!active.includes(g)) { g.packTime = 0; g.campTime = 0; g.exposed = false; continue; }

      // anti-blob: continuous proximity to another ghost
      let packed = false;
      for (const o of active) {
        if (o === g) continue;
        if (Math.hypot(g.px - o.px, g.py - o.py) < BLOB_RANGE) { packed = true; break; }
      }
      if (packed) g.packTime += dt;
      else g.packTime = 0;

      // camp tax: drift from anchor point
      // body-blocked / phasing ghosts aren't camping — the valve forces them through
      if (g.blockedFor > 0 || g.phasing) {
        g.anchorX = g.px; g.anchorY = g.py;
      } else {
        const drift = Math.hypot(g.px - g.anchorX, g.py - g.anchorY);
        if (drift > CAMP_RADIUS) {
          g.anchorX = g.px; g.anchorY = g.py; g.campTime = 0;
        } else {
          g.campTime += dt;
        }
      }

      g.exposed = g.packTime >= BLOB_TIME || g.campTime >= CAMP_TIME;
    }
  }

  startFright(duration = 9) {
    this.frightTimer = duration;
    for (const g of this.ghosts) if (!g.eaten) g.frightened = true;
  }

  endFright() {
    this.frightTimer = 0;
    for (const g of this.ghosts) g.frightened = false;
  }

  checkCollisions() {
    const p = this.pacman;
    if (p.invincible && this.gameTime < p.invincUntil) return;
    if (p.invincible && this.gameTime >= p.invincUntil) p.invincible = false;
    for (const g of this.ghosts) {
      if (this.gameTime < g.releaseAt) continue;
      if (g.eaten) continue;
      const dist = Math.hypot(g.px - p.px, g.py - p.py);
      if (dist < 0.7) {
        if (this.isFright() || g.exposed) this.eatGhost(g);
        else { this.killPacman(g); return; }
      }
    }
  }

  eatGhost(g) {
    this.score += 200;
    this.pacman.score += 200;
    g.eaten = true;
    g.eatenTimer = 2;
    g.dir = 'none'; g.wish = 'none';
    g.r = 14; g.c = 14; g.px = 14; g.py = 14;
    g.frightened = false;
  }

  reviveGhost(g) {
    g.eaten = false;
    g.frightened = false;
    g.r = g.spawn.r; g.c = g.spawn.c;
    g.px = g.spawn.c; g.py = g.spawn.r;
    g.anchorX = g.px; g.anchorY = g.py; g.campTime = 0;
    g.packTime = 0;
    g.exposed = false;
    g.blockedFor = 0;
    g.phasing = false;
    g.dir = 'none'; g.wish = 'none';
    g.nr = null; g.nc = null; g.inTransit = false; g.progress = 0;
    g.releaseAt = this.gameTime + 1;
  }

  killPacman(taggedBy) {
    this.lives--;
    if (taggedBy && taggedBy.kind === 'ghost') taggedBy.score += TAG_BONUS;
    // everyone who helped corner pacman gets a cut
    for (const g of this.ghosts) {
      if (g === taggedBy || g.eaten || this.gameTime < g.releaseAt) continue;
      if (Math.hypot(g.px - this.pacman.px, g.py - this.pacman.py) <= GHOST_INCOME_RANGE) {
        g.score += ASSIST_BONUS;
      }
    }
    this.endFright();
    if (this.lives <= 0) { this.end('ghosts'); return; }
    this.resetRound();
    this.pacman.invincible = true;
    this.pacman.invincUntil = this.gameTime + 2.5;
  }

  resetRound() {
    const p = this.pacman;
    p.r = p.spawn.r; p.c = p.spawn.c;
    p.px = p.spawn.c; p.py = p.spawn.r;
    p.dir = 'none'; p.wish = 'none'; p.nr = null; p.nc = null;
    p.inTransit = false; p.progress = 0;

    this.ghosts.forEach((g, i) => {
      g.r = g.spawn.r; g.c = g.spawn.c;
      g.px = g.spawn.c; g.py = g.spawn.r;
      g.dir = 'none'; g.wish = 'none'; g.nr = null; g.nc = null;
      g.inTransit = false; g.progress = 0;
      g.frightened = false; g.eaten = false; g.eatenTimer = 0;
      g.packTime = 0; g.exposed = false;
      g.anchorX = g.px; g.anchorY = g.py; g.campTime = 0;
      g.blockedFor = 0; g.phasing = false;
      g.releaseAt = this.gameTime + [0, 2, 4, 6][i];
    });
  }

  end(winner) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    clearInterval(this.loop);
    if (winner === 'pacman') this.pacman.score += WIN_BONUS;
    else for (const g of this.ghosts) g.score += WIN_BONUS;
    this.broadcastState();
    if (this.cb.onEnd) this.cb.onEnd(winner);
  }

  getStandings() {
    const rows = [{
      slot: 0, roleName: 'Pacman',
      name: this.pacman.name, bot: this.pacman.bot,
      color: this.pacman.color, round: this.pacman.score
    }];
    for (const g of this.ghosts) {
      rows.push({
        slot: g.slot, roleName: g.personality,
        name: g.name, bot: g.bot,
        color: g.color, round: g.score
      });
    }
    rows.sort((a, b) => b.round - a.round);
    return rows;
  }

  broadcastState() {
    const p = this.pacman;
    this.broadcast({
      type: 'state',
      t: Math.round(this.gameTime * 100) / 100,
      score: this.score,
      lives: this.lives,
      dotsLeft: this.dots.size,
      fright: Math.round(this.frightTimer * 100) / 100,
      pulseIn: this.endgame && !this.over && !this.isFright() && this.nextPulseAt !== null
        ? Math.max(0, Math.round(this.nextPulseAt - this.gameTime))
        : null,
      over: this.over,
      winner: this.winner,
      eaten: this.eatenThisTick,
      invincible: p.invincible && this.gameTime < p.invincUntil,
      players: [
        { slot: 0, score: p.score },
        ...this.ghosts.map(g => ({ slot: g.slot, score: g.score }))
      ],
      pacman: { x: p.px, y: p.py, dir: p.dir },
      ghosts: this.ghosts.map(g => ({
        x: g.px, y: g.py, dir: g.dir,
        fright: g.frightened, eaten: g.eaten, exposed: !!g.exposed,
        phasing: !!g.phasing
      }))
    });
    this.eatenThisTick = [];
  }
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

module.exports = { Game };
