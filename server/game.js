'use strict';

const mazeMod = require('./maze');
const {
  MAP, TILE, COLS, ROWS, DX, DY, OPPOSITE,
  MAP_3V3, CENTER_COL, RED_SPAWNS, BLUE_SPAWNS, buildMaze3v3,
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

// --- 3v3 mode constants ---
const GAME_DURATION = 180;        // 3-minute countdown
const ROLE_TRANSITION = 0.5;      // seconds to morph between ghost <-> pacman
const RESPAWN_INVINCIBLE = 5;     // tangibility grace after leaving ghost house
const EAT_SCORE_3V3 = 200;        // pacman eats enemy ghost -> team score
const KILL_SCORE_3V3 = 200;       // ghost kills enemy pacman -> team score
const ASSIST_SCORE_3V3 = 75;      // nearby same-team ghosts on a kill
const ASSIST_RANGE_3V3 = 8;
const DOT_SCORE_3V3 = 10;
const PELLET_SCORE_3V3 = 50;
const FRIGHT_DURATION_3V3 = 7;

// 3v3 bot strategy
const RAID_REEVAL_3V3 = 3;         // seconds between raid-quota recomputes
const RAID_DEFICIT_3V3 = 250;      // score deficit that escalates to 2 raiders
const MAX_RAIDERS_3V3 = 2;         // cap so one bot always defends
const BORDER_HYSTERESIS_3V3 = 4;   // seconds a bot must stay after crossing sides
const PELLET_BUDGET_3V3 = 30;      // BFS-tile budget for chasing an enemy pellet
const INTERCEPT_LEAD_3V3 = 2;      // tiles of prey-heading lead for defenders

// defender patrol pairs per home side; rank 0 and 1 take distinct routes so two
// solid same-team ghosts never share a target tile
const DEFEND_ROUTES_3V3 = {
  red:  [[[8, 13], [14, 6]], [[26, 13], [20, 9]]],
  blue: [[[8, 14], [14, 21]], [[26, 14], [20, 18]]]
};

// final hunting stage: starts when the food bank is empty; roles are pinned
// (1 ghost + 2 pacmen per team) and the map is left exactly as it is.
const HUNT_GHOST_SPEED = 3.3;      // hunter must outrun prey, unlike the skirmish
const HUNT_PACMAN_SPEED = 2.9;
// shared "run from what can touch you" scorer: hunt prey and skirmish ghosts
const EVADE_THREAT_CAP = 6;        // tiles of safety beyond which farther is not better
const EVADE_EXIT_WEIGHT = 1;       // dead-end avoidance
const EVADE_TEAMMATE_WEIGHT = 0.5; // two solid bodies stacking would jam
// respawn spots live in the col-6 / col-21 corridors: a pinned pacman cannot use the house
// doors, so it must never be put back inside the pocket
const HUNT_SPAWNS = {
  red:  [{ r: 8, c: 6 }, { r: 14, c: 6 }, { r: 20, c: 6 }],
  blue: [{ r: 8, c: 21 }, { r: 14, c: 21 }, { r: 20, c: 21 }]
};

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

class GameBase {
  constructor(players, broadcast, cb) {
    this.players = players;          // [{id,socket,name}]
    this.broadcast = broadcast;      // (payload) => void  payload has .type
    this.cb = cb || {};

    this.maze = null;                // subclass must populate (buildMaze / buildMaze3v3)
    this.dots = new Set();
    this.gameTime = 0;
    this.over = false;
    this.winner = null;
    this.eatenThisTick = [];
    this.loop = null;
  }

  start() {
    this.over = false;
    this.broadcastStarted();
    this.loop = setInterval(() => this.tick(DT), DT * 1000);
  }

  clampCell(r, c) {
    return { r: Math.min(ROWS - 1, Math.max(0, r)), c: Math.min(COLS - 1, Math.max(0, c)) };
  }

  // The enclosed house: rows 13-15 / cols 11-16 plus its two door cells on row 12. Pacmen
  // cannot pass the doors, so this is the only pacman-proof region on the map. The open ring
  // around it (rows 11 / 17, cols 9 / 18) is ordinary corridor and is deliberately excluded.
  inHouseInterior(e) {
    return e.r >= 12 && e.r <= 15 && e.c >= 11 && e.c <= 16;
  }

  // Door passability: ghosts only, and only until they have come out — the house is a
  // birthplace and a respawn bay, never a refuge. Every pathfinder must ask this instead of
  // `e.friendly`, or a bot will route through a door it cannot physically use.
  doorOpen(e) {
    return e.friendly && !e.houseExited;
  }

  updateHouseExit(e) {
    if (!e.houseExited && !this.inHouseInterior(e)) e.houseExited = true;
  }

  randomDir(e, ghost = true) {
    const order = shuffle(['up', 'down', 'left', 'right']);
    const open = order.filter(d => canMove(this.maze, e.r, e.c, d, ghost));
    if (!open.length) return 'none';
    const rev = OPPOSITE[e.dir];
    const noRev = open.filter(d => d !== rev);
    const pool = noRev.length ? noRev : open;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  eraseDot(r, c) {
    if (this.maze[r][c] === TILE.EMPTY) return;
    this.maze[r][c] = TILE.EMPTY;
    const k = r + ',' + c;
    this.dots.delete(k);
    this.eatenThisTick.push(k);
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
}

class Game extends GameBase {
  constructor(players, broadcast, cb) {
    super(players, broadcast, cb);

    this.maze = buildMaze().maze;
    this.dots = new Set();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (this.maze[r][c] === TILE.DOT || this.maze[r][c] === TILE.PELLET)
          this.dots.add(r + ',' + c);

    this.score = 0;
    this.lives = 3;
    this.frightTimer = 0;
    this.endgame = false;
    this.nextPulseAt = null;

    this.assignRoles();
    this.layoutEntities();
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
      houseExited: !this.inHouseInterior({ r: sp.r, c: sp.c }),
      frightened: false,
      eaten: false,
      eatenTimer: 0
    };
    return g;
  }

  // --- public API ---
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
      this.updateHouseExit(g);
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
    const door = this.doorOpen(e);
    for (const d of ['up', 'down', 'left', 'right']) {
      if (d === opp) continue;
      if (!canMove(this.maze, e.r, e.c, d, door)) continue;
      const nb = neighbor(this.maze, e.r, e.c, d, door);
      if (!this.tileReservedBy(nb.r, nb.c, e)) return d;
    }
    if (opp && canMove(this.maze, e.r, e.c, opp, door)) {
      const nb = neighbor(this.maze, e.r, e.c, opp, door);
      if (!this.tileReservedBy(nb.r, nb.c, e)) return opp;
    }
    return 'none';
  }

  moveEntity(e, dt, speed) {
    const door = this.doorOpen(e);
    if (!e.inTransit) {
      let d = this.nextDir(e);

      // ghost bodies: refuse to enter a reserved tile (unless phasing)
      if (d !== 'none' && e.kind === 'ghost' && !e.phasing) {
        let nb = neighbor(this.maze, e.r, e.c, d, door);
        if (this.tileReservedBy(nb.r, nb.c, e)) {
          e.blockedFor += dt;
          if (e.bot) {
            const alt = this.altDir(e);
            if (alt !== 'none') { d = alt; nb = neighbor(this.maze, e.r, e.c, d, door); }
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
        const nb = neighbor(this.maze, e.r, e.c, d, door);
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
    // passability, not role: a ghost that has already come out may never go back in
    const door = this.doorOpen(e);
    // human chooses freely (respect walls / doors for ghosts)
    if (e.wish && e.wish !== 'none' && canMove(this.maze, e.r, e.c, e.wish, door)) return e.wish;

    if (e.bot) {
      if (ghost && (this.isFright() || e.exposed)) return this.randomDir(e, door);
      if (!ghost) return this.pacmanBotDir(e);
      const target = this.botTarget(e);
      if (target) {
        const d = this.bfsFirstStep(e.r, e.c, target, door);
        if (d) return d;
      }
      // fall through to straight / none below
    }

    // humans / bots continue straight if open
    if (e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, door)) return e.dir;
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
    g.houseExited = !this.inHouseInterior(g);
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
      g.houseExited = !this.inHouseInterior(g);
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

// =================== 3v3 team battle mode ===================
class Game3v3 extends GameBase {
  constructor(players, broadcast, cb) {
    super(players, broadcast, cb);
    this.mode = '3v3';
    this.mapArray = MAP_3V3;
    this.maze = buildMaze3v3().maze;
    this.dots = new Set();
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++)
        if (this.maze[r][c] === TILE.DOT || this.maze[r][c] === TILE.PELLET)
          this.dots.add(r + ',' + c);

    this.timeRemaining = GAME_DURATION;
    this.teams = {
      red:  { side: 'left',  score: 0, frightTimer: 0, members: [], raidQuota: 1, nextRaidEvalAt: 0 },
      blue: { side: 'right', score: 0, frightTimer: 0, members: [], raidQuota: 1, nextRaidEvalAt: 0 }
    };
    this.entities = [];
    this.stage = 'skirmish';   // 'skirmish' until the food bank is empty, then 'hunt'

    this.assignTeams();
    this.layoutEntities3v3();
  }

  assignTeams() {
    const slots = [0, 1, 2, 3, 4, 5];
    shuffle(slots);
    this.slotOfHuman = new Map();
    const n = Math.min(this.players.length, 6);
    for (let i = 0; i < n; i++) this.slotOfHuman.set(this.players[i].id, slots[i]);
  }

  layoutEntities3v3() {
    for (let s = 0; s < 6; s++) {
      const team = s < 3 ? 'red' : 'blue';
      const idx = s % 3;
      const human = this.players.find(pl => this.slotOfHuman.get(pl.id) === s);
      const spawns = team === 'red' ? RED_SPAWNS : BLUE_SPAWNS;
      const e = this.makeEntity(s, team, idx, spawns[idx], human);
      this.entities.push(e);
      this.teams[team].members.push(e);
    }
  }

  makeEntity(slot, team, idx, spawn, human) {
    return {
      kind: 'entity',
      slot, idx, team,
      homeSide: team === 'red' ? 'left' : 'right',
      currentRole: 'ghost',
      transitioning: false, transitionUntil: 0, pendingRole: 'ghost',
      name: human ? human.name : `Bot ${team[0].toUpperCase() + team.slice(1)}-${idx + 1}`,
      bot: !human,
      color: team === 'red' ? '#ff4444' : '#4488ff',
      teamColor: team === 'red' ? '#ff4444' : '#4488ff',
      spawn,
      r: spawn.r, c: spawn.c,
      nr: null, nc: null, progress: 0, inTransit: false,
      dir: 'none', wish: 'none',
      px: spawn.c, py: spawn.r,
      speed: GHOST_SPEED,
      releaseAt: spawn.release,
      score: 0,
      friendly: true,
      frightened: false,
      eaten: false, eatenTimer: 0,
      invincible: false, invincUntil: 0,
      houseExited: !this.inHouseInterior({ r: spawn.r, c: spawn.c }),
      botRole: 'defend',           // bot intent: 'raid' crosses to the enemy side
      lastSide: spawn.c < CENTER_COL ? 'left' : 'right',
      lastCrossAt: -999,           // gameTime of the last side change
      patrolWp: 0
    };
  }

  broadcastStarted() {
    this.broadcast({ type: 'started', mode: '3v3', maze: MAP_3V3, cols: COLS, rows: ROWS, roles: this.getRoles() });
  }

  getRoles() {
    const out = [];
    for (let s = 0; s < 6; s++) {
      const e = this.entities[s];
      const humanId = [...this.slotOfHuman.entries()].find(([, v]) => v === s)?.[0];
      out.push({
        socketId: humanId || null,
        name: e.name,
        role: s,
        team: e.team,
        color: e.color,
        bot: e.bot
      });
    }
    return out;
  }

  setWish(socketId, dir) {
    if (this.over) return;
    const slot = this.slotOfHuman.get(socketId);
    if (slot === undefined) return;
    this.entities[slot].wish = dir;
  }

  // ---------- main tick ----------
  tick(dt) {
    if (this.over) return;
    this.gameTime += dt;
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      const r = this.teams.red.score, b = this.teams.blue.score;
      this.end(r === b ? 'draw' : (r > b ? 'red' : 'blue'));
      return;
    }

    // checked here, not inside collectTile, so the stage flip lands between steps
    if (this.stage !== 'hunt' && this.dots.size === 0) this.enterHuntStage3v3();

    for (const tn of ['red', 'blue']) this.evalRaidQuota3v3(tn, this.teams[tn]);

    for (const tn of ['red', 'blue']) {
      const t = this.teams[tn];
      if (t.frightTimer > 0) {
        t.frightTimer -= dt;
        if (t.frightTimer <= 0) this.endFright(tn);
      }
    }

    for (const e of this.entities) {
      if (this.gameTime < e.releaseAt) continue;
      if (e.eaten) {
        e.eatenTimer -= dt;
        if (e.eatenTimer <= 0) this.reviveEntity(e);
        continue;
      }
      // one grace window per life, armed by the act of coming out of the house itself;
      // the outward-only doors mean the latch can never flip a second time
      const leftHouse = !e.houseExited && !this.inHouseInterior(e);
      this.updateHouseExit(e);
      if (leftHouse) {
        e.invincible = true;
        e.invincUntil = this.gameTime + RESPAWN_INVINCIBLE;
      }
      if (e.invincible && this.gameTime >= e.invincUntil) e.invincible = false;

      const spd = this.roleSpeed(e);
      this.moveEntity3v3(e, dt, spd);
      if (e.currentRole === 'pacman' && !e.transitioning) this.collectTile(e);
    }

    for (const e of this.entities) this.updateRole(e);
    this.checkCollisions3v3();

    this.broadcastState();
  }

  // The house plus the one-tile open corridors that run past it (rows 11 and 17). Those rows
  // straddle CENTER_COL and are the only way round the house, so bodies stay pass-through here to
  // keep players from jamming at the door mouth, and role logic is held off these shared tiles.
  // This is NOT the ghost house: the respawn grace asks GameBase.inHouseInterior.
  inHouseClearance3v3(e) {
    return e.r >= 11 && e.r <= 18 && e.c >= 10 && e.c <= 17;
  }

  roleSpeed(e) {
    if (this.stage === 'hunt') {
      return e.currentRole === 'ghost' ? HUNT_GHOST_SPEED : HUNT_PACMAN_SPEED;
    }
    if (e.currentRole === 'pacman') return PACMAN_SPEED;
    return this.isFright(e.team) ? FRIGHT_SPEED : GHOST_SPEED;
  }

  isFright(team) { return this.teams[team].frightTimer > 0; }

  startFright(team, duration = FRIGHT_DURATION_3V3) {
    this.teams[team].frightTimer = duration;
    for (const g of this.entities) {
      if (g.team === team && g.currentRole === 'ghost' && !g.eaten) g.frightened = true;
    }
  }

  endFright(team) {
    this.teams[team].frightTimer = 0;
    for (const g of this.entities) if (g.team === team) g.frightened = false;
  }

  // ---------- final hunting stage ----------
  // Fired the tick after the last dot/pellet is eaten. Roles stop following the
  // centre line from here on, so they are assigned once and pinned.
  enterHuntStage3v3() {
    this.stage = 'hunt';
    // no pellet can ever come back, so a window left running here would be the
    // only way a pacman could score — the stage is the ghost's to win
    this.endFright('red');
    this.endFright('blue');

    for (const tn of ['red', 'blue']) {
      const picked = shuffle(this.teams[tn].members.slice());
      picked.forEach((e, i) => this.pinRole3v3(e, i === 0 ? 'ghost' : 'pacman'));
    }

    for (const e of this.entities) {
      // roles are pinned here, and a pinned pacman left in the pocket could never get out:
      // the doors only answer to ghosts. Put it back on the open map.
      if (e.currentRole === 'pacman' && this.inHouseInterior(e)) {
        const sp = this.huntSpawnOf(e);
        e.r = sp.r; e.c = sp.c;
      }
      e.inTransit = false; e.nr = null; e.nc = null; e.progress = 0;
      e.px = e.c; e.py = e.r; e.dir = 'none'; e.wish = 'none';
      e.houseExited = !this.inHouseInterior(e);
      // nobody gets killed by the transition itself. Anyone still in the house is left alone:
      // its window starts when it actually clears the door, same as any other exit.
      if (e.houseExited) {
        e.invincible = true;
        e.invincUntil = this.gameTime + RESPAWN_INVINCIBLE;
      }
    }
  }

  pinRole3v3(e, role) {
    e.currentRole = role;
    e.pendingRole = role;
    e.transitioning = false;
    e.transitionUntil = 0;
    e.frightened = false;
    e.friendly = (role === 'ghost');
    if (e.bot) e.botRole = (role === 'ghost') ? 'hunt' : 'evade';
  }

  huntSpawnOf(e) {
    const spots = HUNT_SPAWNS[e.team];
    return spots[e.idx % spots.length];
  }

  isGhostEdible(g) {
    if (g.currentRole !== 'ghost') return false;
    if (g.eaten) return false;
    if (this.gameTime < g.releaseAt) return false;
    return this.isFright(g.team);
  }

  // detect border crossings / complete pending transitions
  updateRole(e) {
    if (e.eaten) return;
    // the hunting stage pins roles; crossing the centre line transforms nothing
    if (this.stage === 'hunt') return;

    if (this.inHouseClearance3v3(e)) {
      if (e.transitioning || e.currentRole !== 'ghost') {
        e.transitioning = false;
        e.pendingRole = 'ghost';
        e.currentRole = 'ghost';
        e.friendly = true;
      }
      return;
    }

    const side = e.c < CENTER_COL ? 'left' : 'right';
    if (side !== e.lastSide) {
      if (e.bot) e.lastCrossAt = this.gameTime;
      e.lastSide = side;
    }
    const expected = (side === e.homeSide) ? 'ghost' : 'pacman';

    if (e.transitioning) {
      if (expected !== e.pendingRole) {
        // crossed back before finishing — cancel the transition
        e.transitioning = false;
        e.pendingRole = e.currentRole;
        return;
      }
      if (this.gameTime >= e.transitionUntil) {
        e.transitioning = false;
        e.currentRole = expected;
        e.friendly = (expected === 'ghost');
      }
      return;
    }

    if (e.currentRole !== expected) {
      e.transitioning = true;
      e.pendingRole = expected;
      e.transitionUntil = this.gameTime + ROLE_TRANSITION;
    }
  }

  // ---------- movement (3v3 body collision) ----------
  // Bodies are solid everywhere except in the shared house — a 1-tile-wide staging
  // area where two parked players would entomb the round — and during the 5s
  // post-respawn grace.
  isSolid3v3(e) {
    if (e.eaten || e.transitioning) return false;
    if (this.gameTime < e.releaseAt) return false;
    if (e.invincible && this.gameTime < e.invincUntil) return false;
    return !this.inHouseClearance3v3(e);
  }

  tileReservedBy3v3(r, c, self) {
    for (const g of this.entities) {
      if (g === self || !this.isSolid3v3(g)) continue;
      // opposite-role enemies must stay pass-through or eat/kill can never reach 0.7
      if (g.team !== self.team && g.currentRole !== self.currentRole) continue;
      if (g.r === r && g.c === c) return true;
      if (g.inTransit && g.nr === r && g.nc === c) return true;
    }
    return false;
  }

  altDir3v3(e) {
    const opp = OPPOSITE[e.dir] || null;
    const door = this.doorOpen(e);
    for (const d of ['up', 'down', 'left', 'right']) {
      if (d === opp) continue;
      if (!canMove(this.maze, e.r, e.c, d, door)) continue;
      if (this.sideStepCooling3v3(e, d)) continue;
      const nb = neighbor(this.maze, e.r, e.c, d, door);
      if (!this.tileReservedBy3v3(nb.r, nb.c, e)) return d;
    }
    if (opp && canMove(this.maze, e.r, e.c, opp, door)) {
      const nb = neighbor(this.maze, e.r, e.c, opp, door);
      if (!this.tileReservedBy3v3(nb.r, nb.c, e)) return opp;
    }
    return 'none';
  }

  moveEntity3v3(e, dt, speed) {
    const door = this.doorOpen(e);
    if (!e.inTransit) {
      const d0 = this.nextDir(e);
      if (d0 === 'none') { e.dir = d0; e.px = e.c; e.py = e.r; return; }
      let d = d0;
      let nb = neighbor(this.maze, e.r, e.c, d, door);
      if (this.isSolid3v3(e) && this.tileReservedBy3v3(nb.r, nb.c, e)) {
        if (e.bot) {
          const alt = this.altDir3v3(e);
          if (alt !== 'none') { d = alt; nb = neighbor(this.maze, e.r, e.c, d, door); }
        }
        // a human, or a bot with no way round: bump and hold
        if (this.tileReservedBy3v3(nb.r, nb.c, e)) {
          e.dir = d; e.px = e.c; e.py = e.r;
          return;
        }
      }
      e.dir = d;
      e.nr = nb.r; e.nc = nb.c; e.inTransit = true; e.progress = 0;
    }

    e.progress += speed * dt;
    if (e.progress >= 1) {
      e.progress = 0;
      e.r = e.nr; e.c = e.nc; e.inTransit = false; e.nr = null; e.nc = null;
    }
    if (e.inTransit) {
      e.px = e.c + DX[e.dir] * e.progress;
      e.py = e.r + DY[e.dir] * e.progress;
    } else {
      e.px = e.c; e.py = e.r;
    }
  }

  nextDir(e) {
    const door = this.doorOpen(e);
    if (e.wish && e.wish !== 'none' && canMove(this.maze, e.r, e.c, e.wish, door)) return e.wish;

    let d = null;
    if (e.bot) {
      if (e.currentRole === 'ghost' && this.isFright(e.team)) d = this.fleeDir3v3(e);
      else d = this.botDir(e);
      if (d === 'none') d = null;
    }
    if (!d && e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, door)) d = e.dir;
    // border hysteresis: a bot that just crossed sides must hold that side. Without
    // this, flipping across the border every ~0.3s keeps the 0.5s morph running
    // forever, and checkCollisions3v3 treats a transitioning body as intangible.
    if (d && this.sideStepCooling3v3(e, d)) {
      const alt = this.openDirSameSide3v3(e);
      if (alt) return alt;
    }
    return d || 'none';
  }

  // true while a bot is inside BORDER_HYSTERESIS_3V3 of its last side change and the
  // step would cross back. transitioning steps are exempt: reversing mid-morph only
  // cancels the morph (updateRole), it never completes a role flip, so it cannot
  // fuel the oscillation exploit — and it is how a frightened ghost aborts a raid.
  sideStepCooling3v3(e, d) {
    if (!e.bot || e.transitioning) return false;
    // nothing to oscillate against once roles are pinned; the hunter must be able
    // to cross the centre line freely
    if (this.stage === 'hunt') return false;
    if (this.gameTime - e.lastCrossAt >= BORDER_HYSTERESIS_3V3) return false;
    return this.changesSide3v3(e, d);
  }

  // would a step in d land on the other side of the border column
  changesSide3v3(e, d) {
    if (!d || d === 'none') return false;
    let nc = e.c + DX[d];
    if (nc < 0) nc = COLS - 1; else if (nc >= COLS) nc = 0;
    return (nc < CENTER_COL ? 'left' : 'right') !== e.lastSide;
  }

  // any open step that stays on the current side, preferring the current heading
  openDirSameSide3v3(e) {
    const door = this.doorOpen(e);
    if (e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, door) &&
        !this.changesSide3v3(e, e.dir)) return e.dir;
    for (const d of ['up', 'left', 'down', 'right']) {
      if (d === e.dir) continue;
      if (!canMove(this.maze, e.r, e.c, d, door)) continue;
      if (this.changesSide3v3(e, d)) continue;
      return d;
    }
    return null;
  }

  // ---------- bot AI ----------
  botDir(e) {
    if (this.stage === 'hunt') {
      return e.currentRole === 'ghost' ? this.huntGhostDir3v3(e) : this.huntEvadeDir3v3(e);
    }
    return e.currentRole === 'ghost' ? this.ghostBotDir(e) : this.pacmanBotDir3v3(e);
  }

  // hunt ghost: the only scorer on the team, so it pursues prey anywhere on the map
  huntGhostDir3v3(e) {
    let prey = null, bd = Infinity;
    for (const t of this.entities) {
      if (t.team === e.team || t.currentRole !== 'pacman' || t.eaten) continue;
      if (this.gameTime < t.releaseAt) continue;
      const d = Math.hypot(t.px - e.px, t.py - e.py);
      if (d < bd) { bd = d; prey = t; }
    }
    if (!prey) return null;
    return this.interceptDir3v3(e, prey, false);
  }

  // run-from-what-can-touch-you: threatDist(r, c, lookahead) reports tiles to the threat.
  // Shared by hunt prey (enemy ghost) and skirmish ghosts (enemy pacman).
  evadeDir3v3(e, threatDist) {
    const opp = OPPOSITE[e.dir] || null;
    const door = this.doorOpen(e);
    let best = null, bestScore = -Infinity;
    for (const d of ['up', 'left', 'down', 'right']) {
      if (!canMove(this.maze, e.r, e.c, d, door)) continue;
      const nb = neighbor(this.maze, e.r, e.c, d, door);
      const now = threatDist(nb.r, nb.c, 0);
      const projected = threatDist(nb.r, nb.c, DANGER_LOOKAHEAD);
      let score = Math.min(now, projected, EVADE_THREAT_CAP);
      let exits = 0;
      for (const d2 of ['up', 'left', 'down', 'right'])
        if (canMove(this.maze, nb.r, nb.c, d2, door)) exits++;
      score += EVADE_EXIT_WEIGHT * exits;
      let mate = Infinity;
      for (const t of this.entities) {
        if (t === e || t.team !== e.team || t.eaten || t.currentRole !== e.currentRole) continue;
        mate = Math.min(mate, Math.hypot(t.px - nb.c, t.py - nb.r));
      }
      score += EVADE_TEAMMATE_WEIGHT * Math.min(mate, 6);
      if (d === opp) score -= 1.5;
      if (d === e.dir) score += 0.5;
      if (score > bestScore) { bestScore = score; best = d; }
    }
    return best;
  }

  // hunt pacman: no scoring route, so the job is to stay alive and stay un-cornered
  huntEvadeDir3v3(e) {
    return this.evadeDir3v3(e, (r, c, la) => this.nearestThreatDist3v3(r, c, e.team, la));
  }

  // Ghost bot: raiders push onto the enemy side; defenders intercept prey that
  // came to the home side, or patrol their route when nobody is attacking.
  ghostBotDir(e) {
    const door = this.doorOpen(e);
    if (e.botRole === 'raid') {
      // aim for the nearest enemy-side dot: goals on bare tiles are reachable only
      // through the house's dead pockets (e.g. col 18 rows 11-15), where updateRole
      // force-keeps ghost role and the approach would cycle forever. Pellets and
      // deep tiles remain as fallbacks once the enemy side is picked clean.
      let target = this.bfsGoal(e.r, e.c, door, (r, c) =>
        this.maze[r][c] === TILE.DOT && this.isEnemySide(e, c));
      if (!target) {
        target = this.bfsGoal(e.r, e.c, door, (r, c) =>
          (this.maze[r][c] === TILE.PELLET || this.maze[r][c] === TILE.DOT) &&
          this.isEnemySide(e, c));
      }
      if (!target) {
        target = this.bfsGoal(e.r, e.c, door, (r, c) =>
          !this.inHouseClearance3v3({ r, c }) &&
          (e.homeSide === 'left' ? c >= CENTER_COL + 1 : c <= CENTER_COL - 2));
      }
      if (target) { const d = this.bfsFirstStep(e.r, e.c, target, door); if (d) return d; }
      return null;
    }
    const prey = this.entities.filter(t =>
      t.team !== e.team && t.currentRole === 'pacman' && !t.eaten &&
      this.gameTime >= t.releaseAt &&
      (e.homeSide === 'left' ? t.c <= CENTER_COL - 1 : t.c >= CENTER_COL));
    if (prey.length) {
      let best = null, bd = Infinity;
      for (const p of prey) {
        const d = Math.hypot(p.px - e.px, p.py - e.py);
        if (d < bd) { bd = d; best = p; }
      }
      const d = this.interceptDir3v3(e, best);
      if (d) return d;
    }
    return this.patrolDir3v3(e);
  }

  nearestBorderTileOnHome(e) {
    const targetCol = e.homeSide === 'left' ? CENTER_COL - 1 : CENTER_COL;
    let best = null, bd = Infinity;
    for (let r = 0; r < ROWS; r++) {
      if (this.maze[r][targetCol] === TILE.WALL) continue;
      // a house tile would trap the defender in ghost role, so it can never reinforce there
      if (this.inHouseClearance3v3({ r, c: targetCol })) continue;
      const d = Math.hypot(targetCol - e.px, r - e.py);
      if (d < bd) { bd = d; best = { r, c: targetCol }; }
    }
    return best;
  }

  // aim ahead of the prey's heading (it is faster, so a pure tail chase never lands).
  // clampHome keeps a skirmish defender from chasing prey across the centre line and
  // accidentally morphing; the hunt hunter has no such limit.
  interceptDir3v3(e, prey, clampHome = true) {
    const dr = DY[prey.dir] || 0, dc = DX[prey.dir] || 0;
    const lead = this.clampCell(prey.r + dr * INTERCEPT_LEAD_3V3, prey.c + dc * INTERCEPT_LEAD_3V3);
    let target = lead;
    if (this.maze[target.r][target.c] === TILE.WALL || this.inHouseClearance3v3(target)) {
      target = { r: prey.r, c: prey.c };
    } else {
      // keep the aim home-side — following prey across the border would morph the
      // defender into a raider and unbalance the raid quota
      if (clampHome) {
        if (e.homeSide === 'left' && target.c >= CENTER_COL) target.c = CENTER_COL - 1;
        if (e.homeSide === 'right' && target.c < CENTER_COL) target.c = CENTER_COL;
      }
      if (this.maze[target.r][target.c] === TILE.WALL) target = { r: prey.r, c: prey.c };
    }
    return this.bfsFirstStep(e.r, e.c, target, this.doorOpen(e));
  }

  // walk the assigned waypoint pair; distinct routes keep solid teammates apart
  patrolDir3v3(e) {
    const defenders = this.entities
      .filter(t => t.team === e.team && t.bot && t.botRole === 'defend' && !t.eaten &&
        this.gameTime >= t.releaseAt)
      .sort((a, b) => a.slot - b.slot);
    const rank = Math.max(0, defenders.indexOf(e));
    const routes = DEFEND_ROUTES_3V3[e.team];
    const pair = routes[rank % routes.length];
    const at = pair[e.patrolWp];
    if (e.r === at[0] && e.c === at[1]) e.patrolWp = 1 - e.patrolWp;
    const next = pair[e.patrolWp];
    return this.bfsFirstStep(e.r, e.c, { r: next[0], c: next[1] }, this.doorOpen(e));
  }

  // Frightened ghost bot. The house used to be the destination — pacmen cannot pass the doors,
  // so it was the one spot a slow ghost could not be followed into — but the doors only open
  // outward now, so a ghost that has come out has to out-run the chase instead.
  fleeDir3v3(e) {
    if (!e.houseExited) {
      const exit = this.bfsGoal(e.r, e.c, true, (r, c) => !this.inHouseInterior({ r, c }));
      const d = exit && this.bfsFirstStep(e.r, e.c, exit, true);
      if (d) return d;
    }
    const flee = this.evadeDir3v3(e, (r, c, la) =>
      this.nearestThreatDist3v3(r, c, e.team, la, 'pacman'));
    return flee || this.randomDir(e, this.doorOpen(e));
  }

  // adaptive raid quota: 1 raider normally, 2 while behind by RAID_DEFICIT_3V3 or
  // while the enemy team is frightened (their ghosts are edible for 200 each).
  // Roles only change for home-side bots; a bot across the border is never recalled.
  evalRaidQuota3v3(tn, t) {
    if (this.stage === 'hunt') return;   // roles pinned; no raid economy to balance
    if (this.gameTime < t.nextRaidEvalAt) return;
    t.nextRaidEvalAt = this.gameTime + RAID_REEVAL_3V3;
    const enemy = tn === 'red' ? 'blue' : 'red';
    // nothing left to steal on the enemy side: raid quota 0, or an exhausted
    // raider would be re-promoted every re-eval into a permanent cross-and-return
    let hasFood = false;
    for (const k of this.dots) {
      const cc = Number(k.slice(k.indexOf(',') + 1));
      if (tn === 'red' ? cc >= CENTER_COL : cc < CENTER_COL) { hasFood = true; break; }
    }
    let desired = 0;
    if (hasFood) {
      desired = (this.teams[enemy].score - t.score >= RAID_DEFICIT_3V3) ? 2 : 1;
      if (this.isFright(enemy)) desired = Math.max(desired, 2);
    }
    t.raidQuota = Math.min(desired, MAX_RAIDERS_3V3);

    const ready = t.members.filter(m => m.bot && this.gameTime >= m.releaseAt);
    const raiders = ready.filter(m => m.botRole === 'raid');
    if (raiders.length < t.raidQuota) {
      // promote the ready defender nearest its own border crossing
      let best = null, bd = Infinity;
      for (const m of ready) {
        if (m.botRole === 'raid') continue;
        const anchor = this.nearestBorderTileOnHome(m);
        if (!anchor) continue;
        const d = Math.hypot(anchor.c - m.px, anchor.r - m.py);
        if (d < bd) { bd = d; best = m; }
      }
      if (best) best.botRole = 'raid';
    } else if (raiders.length > t.raidQuota) {
      // demote over-quota raiders still at home, farthest from the border first
      // (least invested in its approach)
      let worst = null, wd = -1;
      for (const m of raiders) {
        if ((m.homeSide === 'left') === (m.c >= CENTER_COL)) continue; // across: keep
        const anchor = this.nearestBorderTileOnHome(m);
        if (!anchor) continue;
        const d = Math.hypot(anchor.c - m.px, anchor.r - m.py);
        if (d > wd) { wd = d; worst = m; }
      }
      if (worst) worst.botRole = 'defend';
    }
  }

  // Pacman bot (on enemy side): chase edible enemy ghost > pellet within budget > dot
  pacmanBotDir3v3(e) {
    const edible = this.nearestEdibleEnemy(e);
    if (edible) {
      const d = this.bfsFirstStep(e.r, e.c, edible, false);
      if (d) return d;
    }
    let target = null;
    if (!this.isFright(this.defendingTeamOf(e))) {
      const pellet = this.bfsGoalDist(e.r, e.c, false, (r, c) =>
        this.maze[r][c] === TILE.PELLET && this.isEnemySide(e, c));
      if (pellet && pellet.dist <= PELLET_BUDGET_3V3) target = pellet;
    }
    if (!target) {
      target = this.bfsGoal(e.r, e.c, false, (r, c) =>
        (this.maze[r][c] === TILE.DOT || this.maze[r][c] === TILE.PELLET) &&
        this.isEnemySide(e, c));
    }
    if (target) {
      const d = this.bfsFirstStep(e.r, e.c, target, false);
      if (d) return this.pacmanSafeDir3v3(e, target, d);
    }
    // nothing left to farm on the enemy side: convert to a defender and go home
    if (e.botRole === 'raid') e.botRole = 'defend';
    const home = this.bfsGoal(e.r, e.c, false, (r, c) =>
      !this.inHouseClearance3v3({ r, c }) &&
      (e.homeSide === 'left' ? c <= CENTER_COL - 1 : c >= CENTER_COL));
    if (home) {
      const hd = this.bfsFirstStep(e.r, e.c, home, false);
      if (hd) return hd;
    }
    if (e.dir && e.dir !== 'none' && canMove(this.maze, e.r, e.c, e.dir, false)) return e.dir;
    return 'none';
  }

  defendingTeamOf(e) {
    // the team whose home side e is currently on
    const side = e.c < CENTER_COL ? 'left' : 'right';
    return side === 'left' ? 'red' : 'blue';
  }

  isEnemySide(e, c) {
    const side = c < CENTER_COL ? 'left' : 'right';
    return side !== e.homeSide;
  }

  nearestEdibleEnemy(e) {
    let best = null, bd = Infinity;
    for (const g of this.entities) {
      if (g.team === e.team) continue;
      if (!this.isGhostEdible(g)) continue;
      const d = Math.hypot(g.px - e.px, g.py - e.py);
      if (d < bd) { bd = d; best = g; }
    }
    return best ? { r: best.r, c: best.c } : null;
  }

  nearestThreatDist3v3(r, c, myTeam, lookahead = 0, role = 'ghost') {
    let best = Infinity;
    for (const g of this.entities) {
      if (g.team === myTeam) continue;
      if (g.currentRole !== role) continue;
      if (g.eaten || this.gameTime < g.releaseAt) continue;
      if (this.isGhostEdible(g)) continue;
      let gx = g.px, gy = g.py;
      if (lookahead > 0) {
        const spd = this.roleSpeed(g) * lookahead;
        gx += (DX[g.dir] || 0) * spd;
        gy += (DY[g.dir] || 0) * spd;
      }
      best = Math.min(best, Math.hypot(gx - c, gy - r));
    }
    return best;
  }

  pacmanSafeDir3v3(e, target, bfsDir) {
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
      const now = this.nearestThreatDist3v3(nb.r, nb.c, e.team);
      const projected = this.nearestThreatDist3v3(nb.r, nb.c, e.team, DANGER_LOOKAHEAD);
      const dist = Math.min(now, projected);
      if (dist >= SAFE) return d;
      if (dist > bestDist) { bestDist = dist; bestDir = d; }
    }
    return bestDir;
  }

  // ---------- scoring / collision ----------
  collectTile(e) {
    if (!this.isEnemySide(e, e.c)) return;
    const t = this.maze[e.r][e.c];
    if (t === TILE.DOT) {
      this.award(e, DOT_SCORE_3V3);
      this.eraseDot(e.r, e.c);
    } else if (t === TILE.PELLET) {
      this.award(e, PELLET_SCORE_3V3);
      this.eraseDot(e.r, e.c);
      const defending = this.defendingTeamOf(e);
      this.startFright(defending);
    }
  }

  award(e, points) {
    e.score += points;
    this.teams[e.team].score += points;
  }

  checkCollisions3v3() {
    const ents = this.entities;
    for (let i = 0; i < ents.length; i++) {
      for (let j = i + 1; j < ents.length; j++) {
        const a = ents[i], b = ents[j];
        if (a.team === b.team) continue;
        if (a.eaten || b.eaten) continue;
        if (a.transitioning || b.transitioning) continue;
        if (this.gameTime < a.releaseAt || this.gameTime < b.releaseAt) continue;
        if ((a.invincible && this.gameTime < a.invincUntil) ||
            (b.invincible && this.gameTime < b.invincUntil)) continue;
        if (a.currentRole === b.currentRole) continue;
        const dist = Math.hypot(a.px - b.px, a.py - b.py);
        if (dist >= 0.7) continue;
        const pac = a.currentRole === 'pacman' ? a : b;
        const gh  = a.currentRole === 'pacman' ? b : a;
        if (this.isGhostEdible(gh)) this.eatEntity(gh, pac);
        else this.killEntity(pac, gh);
      }
    }
  }

  eatEntity(victim, killer) {
    this.award(killer, EAT_SCORE_3V3);
    victim.eaten = true;
    victim.eatenTimer = 2;
    victim.frightened = false;
    victim.dir = 'none'; victim.wish = 'none';
  }

  killEntity(victim, killer) {
    this.award(killer, KILL_SCORE_3V3);
    for (const g of this.entities) {
      if (g === killer || g.team !== killer.team || g.currentRole !== 'ghost') continue;
      if (g.eaten) continue;
      if (Math.hypot(g.px - victim.px, g.py - victim.py) <= ASSIST_RANGE_3V3) {
        this.award(g, ASSIST_SCORE_3V3);
      }
    }
    victim.eaten = true;
    victim.eatenTimer = 2;
    victim.dir = 'none'; victim.wish = 'none';
  }

  reviveEntity(e) {
    e.eaten = false;
    e.eatenTimer = 0;
    e.frightened = false;
    e.transitioning = false;
    const hunt = this.stage === 'hunt';
    let sp;
    if (hunt) {
      // the stage pinned this role, and a pinned pacman could never get back out of the
      // pocket (the doors only answer to ghosts), so respawn on the open map and arm the
      // grace directly — it otherwise arms on the way out of the house
      e.friendly = (e.currentRole === 'ghost');
      e.pendingRole = e.currentRole;
      sp = this.huntSpawnOf(e);
    } else {
      e.pendingRole = 'ghost';
      e.currentRole = 'ghost';
      e.friendly = true;
      const spawns = e.team === 'red' ? RED_SPAWNS : BLUE_SPAWNS;
      sp = spawns[e.idx] || spawns[0];
    }
    e.r = sp.r; e.c = sp.c;
    e.px = sp.c; e.py = sp.r;
    e.houseExited = !this.inHouseInterior(e);
    e.nr = null; e.nc = null; e.inTransit = false; e.progress = 0;
    e.dir = 'none'; e.wish = 'none';
    e.releaseAt = this.gameTime + 1;
    if (hunt) {
      e.invincible = true;
      e.invincUntil = this.gameTime + RESPAWN_INVINCIBLE;
    } else {
      e.invincible = false;  // arms when they actually leave the house
    }
    e.lastSide = sp.c < CENTER_COL ? 'left' : 'right';
    e.lastCrossAt = -999;
    e.patrolWp = 0;
  }

  // ---------- end / broadcast ----------
  end(winner) {
    if (this.over) return;
    this.over = true;
    this.winner = winner;
    clearInterval(this.loop);
    this.broadcastState();
    if (this.cb.onEnd) this.cb.onEnd(winner);
  }

  getStandings() {
    return this.entities.map(e => ({
      slot: e.slot,
      roleName: `${e.team[0].toUpperCase() + e.team.slice(1)} ${e.idx + 1}`,
      name: e.name, bot: e.bot, color: e.color, team: e.team,
      round: e.score
    })).sort((a, b) => b.round - a.round);
  }

  broadcastState() {
    this.broadcast({
      type: 'state',
      mode: '3v3',
      t: Math.round(this.gameTime * 100) / 100,
      timeRemaining: Math.ceil(this.timeRemaining),
      teamScores: { red: this.teams.red.score, blue: this.teams.blue.score },
      teamFright: {
        red: Math.round(this.teams.red.frightTimer * 100) / 100,
        blue: Math.round(this.teams.blue.frightTimer * 100) / 100
      },
      over: this.over,
      winner: this.winner,
      stage: this.stage,
      eaten: this.eatenThisTick,
      entities: this.entities.map(e => ({
        slot: e.slot,
        team: e.team,
        name: e.name,
        bot: e.bot,
        color: e.color,
        currentRole: e.currentRole,
        x: e.px, y: e.py, dir: e.dir,
        fright: !!e.frightened,
        eaten: !!e.eaten,
        transitioning: !!e.transitioning,
        invincible: !!(e.invincible && this.gameTime < e.invincUntil),
        score: e.score
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

module.exports = { Game, Game3v3, GameBase };
