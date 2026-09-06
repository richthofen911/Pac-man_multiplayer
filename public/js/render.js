(function () {
  'use strict';

  const TILE = 20;
  const WALL_COLOR = '#2323c8';
  const WALL_EDGE = '#4a4ae0';
  const DOOR_COLOR = '#ffb8de';
  const DOT_COLOR = '#ffb897';
  const PELLET_COLOR = '#ffd9a8';
  const FRIGHT_COLOR = '#2121de';
  const FRIGHT_FLASH = '#f2f2ff';

  let R = null;

  function parseMaze(map, cols, rows) {
    const maze = [];
    const wallCells = [];
    const doorCells = [];
    const dots = new Set();
    const pellets = new Set();
    for (let r = 0; r < rows; r++) {
      const line = map[r];
      const row = [];
      for (let c = 0; c < cols; c++) {
        const ch = line[c];
        if (ch === '#') { row.push(1); wallCells.push([r, c]); }
        else if (ch === '.') { row.push(2); dots.add(r + ',' + c); }
        else if (ch === 'o') { row.push(3); pellets.add(r + ',' + c); }
        else if (ch === '-') { row.push(4); doorCells.push([r, c]); }
        else row.push(0);
      }
      maze.push(row);
    }
    return { maze, wallCells, doorCells, dots, pellets };
  }

  window.PR = {
    init(map, cols, rows, roles, mySocketId) {
      const canvas = document.getElementById('game');
      canvas.width = cols * TILE;
      canvas.height = rows * TILE;
      const parsed = parseMaze(map, cols, rows);
      const myRole = roles.find(r => r.socketId === mySocketId) || null;
      R = {
        canvas,
        ctx: canvas.getContext('2d'),
        cols, rows, roles, myRole,
        walls: parsed.wallCells,
        doors: parsed.doorCells,
        dots: parsed.dots,
        pellets: parsed.pellets,
        last: null, prev: null, lastAt: 0, prevAt: 0
      };
      return R;
    },

    onState(st) {
      if (!R) return;
      if (!st.pacman || !Array.isArray(st.ghosts)) return;
      R.prev = R.last;
      R.prevAt = R.lastAt;
      R.last = st;
      R.lastAt = performance.now();
      if (st.eaten) {
        for (const k of st.eaten) { R.dots.delete(k); R.pellets.delete(k); }
      }
    },

    draw() {
      if (!R || !R.last) return;
      const st = interpolate();
      drawBoard(st);
      drawEntities(st);
    }
  };

  function interpolate() {
    const st = R.last;
    if (!R.prev) return st;
    const f = clamp((performance.now() - R.prevAt) / ((R.lastAt - R.prevAt) || 1), 0, 1);
    const out = { ...st, pacman: { ...st.pacman }, ghosts: st.ghosts.map(g => ({ ...g })) };
    out.pacman.x = lerp(R.prev.pacman.x, st.pacman.x, f);
    out.pacman.y = lerp(R.prev.pacman.y, st.pacman.y, f);
    st.ghosts.forEach((g, i) => {
      const pg = R.prev.ghosts && R.prev.ghosts[i];
      if (pg) { out.ghosts[i].x = lerp(pg.x, g.x, f); out.ghosts[i].y = lerp(pg.y, g.y, f); }
    });
    return out;
  }

  function drawBoard(st) {
    const ctx = R.ctx;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, R.canvas.width, R.canvas.height);

    // walls
    for (const [r, c] of R.walls) {
      const x = c * TILE, y = r * TILE;
      roundRect(ctx, x, y, TILE, TILE, 4);
      ctx.fillStyle = WALL_COLOR;
      ctx.fill();
      ctx.strokeStyle = WALL_EDGE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ghost door
    if (R.doors.length) {
      const [r0, c0] = R.doors[0]; // door cells are contiguous horizontally
      const x = c0 * TILE, y = r0 * TILE, w = R.doors.length * TILE;
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y + TILE * 0.4, w, TILE * 0.5);
      ctx.fillStyle = DOOR_COLOR;
      ctx.fillRect(x + 2, y + TILE * 0.4, w - 4, 4);
    }

    // dots
    ctx.fillStyle = DOT_COLOR;
    for (const k of R.dots) {
      const [r, c] = k.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(c * TILE + TILE / 2, r * TILE + TILE / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // power pellets (blink)
    const blink = Math.floor(performance.now() / 220) % 2 === 0;
    ctx.fillStyle = blink ? PELLET_COLOR : DOOR_COLOR;
    for (const k of R.pellets) {
      const [r, c] = k.split(',').map(Number);
      ctx.beginPath();
      ctx.arc(c * TILE + TILE / 2, r * TILE + TILE / 2, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawEntities(st) {
    const ctx = R.ctx;
    // ghosts first (so pacman is drawn on top)
    for (const g of st.ghosts) {
      if (g.eaten) continue;
      if (g.phasing) ctx.globalAlpha = 0.45;
      drawGhost(g.x, g.y, R.roles[gGhostRole(g, st)].color, g.fright, st.fright > 1.5 ? false : st.fright > 0, g.exposed);
      if (g.phasing) ctx.globalAlpha = 1;
    }
    drawPacman(st.pacman.x, st.pacman.y, st.pacman.dir, st.invincible);
  }

  // match ghost index in array (0..3) to roles[1..4]
  function gGhostRole(g, st) {
    const idx = st.ghosts.indexOf(g);
    return idx + 1;
  }

  function drawPacman(x, y, dir, invincible) {
    const ctx = R.ctx;
    const cx = x * TILE + TILE / 2, cy = y * TILE + TILE / 2, r = TILE * 0.46;
    const a = dirAngle(dir);
    const mouth = 0.18 + 0.16 * Math.abs(Math.sin(performance.now() / 90));
    if (invincible && Math.floor(performance.now() / 120) % 2 === 0) {
      ctx.globalAlpha = 0.35;
    }
    ctx.fillStyle = '#ffd400';
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a + mouth, a + Math.PI * 2 - mouth);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGhost(x, y, color, fright, blink, exposed) {
    const ctx = R.ctx;
    const cx = x * TILE + TILE / 2, cy = y * TILE + TILE / 2, r = TILE * 0.46;
    const fill = fright ? (blink ? FRIGHT_FLASH : FRIGHT_COLOR) : color;

    if (exposed && !fright) {
      // anti-blob warning: pulsing white ring marks an edible ghost
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 120);
      ctx.save();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.globalAlpha = 0.4 + 0.6 * pulse;
      ctx.beginPath();
      ctx.arc(cx, cy - r * 0.25, r + 2.5 + pulse * 1.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.arc(cx, cy - r * 0.25, r, Math.PI, 0);
    const baseY = cy + r * 0.55;
    ctx.lineTo(cx + r, baseY);
    const waveN = 3;
    const step = (2 * r) / waveN;
    for (let i = 0; i < waveN; i++) {
      const x0 = cx + r - step * (i + 0.5);
      ctx.quadraticCurveTo(x0, baseY + r * 0.35, cx + r - step * (i + 1), baseY);
    }
    ctx.closePath();
    ctx.fill();

    if (fright) {
      // frightened face
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      const my = cy + r * 0.2;
      ctx.moveTo(cx - r * 0.5, my);
      for (let i = 0; i < 4; i++) {
        ctx.lineTo(cx - r * 0.5 + (r / 4) * (i * 2 + 1), my + (i % 2 ? 4 : -4));
      }
      ctx.lineTo(cx + r * 0.5, my);
      ctx.stroke();
    } else {
      // eyes
      drawEye(cx - r * 0.35, cy - r * 0.2, r);
      drawEye(cx + r * 0.35, cy - r * 0.2, r);
    }
  }

  function drawEye(cx, cy, r) {
    const ctx = R.ctx;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2121de';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }

  function dirAngle(dir) {
    switch (dir) {
      case 'up': return -Math.PI / 2;
      case 'down': return Math.PI / 2;
      case 'left': return Math.PI;
      case 'right':
      default: return 0;
    }
  }

  function roundRect(ctx, x, y, w, h, rad) {
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
    ctx.lineTo(x + rad, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
    ctx.lineTo(x, y + rad);
    ctx.quadraticCurveTo(x, y, x + rad, y);
    ctx.closePath();
  }

  function lerp(a, b, f) { return a + (b - a) * f; }
  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
})();
