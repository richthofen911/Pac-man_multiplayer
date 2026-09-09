import { PX_PER_TILE, dirAngle } from './shared/maze.js';
import {
  WALL_COLOR, WALL_EDGE, DOOR_COLOR, DOT_COLOR, DOT_DIM,
  PELLET_COLOR, PELLET_DIM, FRIGHT_COLOR, FRIGHT_FLASH,
  PACMAN_COLOR, CENTER_COL, BACKGROUND_COLOR, isHomeSide
} from './shared/theme.js';

// Canvas 2D renderer: a pure view over a SnapshotBuffer. State arrives through the buffer, so this
// module only ever reads it.
export function createRenderer2D({ buffer, parsed, cols, rows, roles, mySocketId, mode }) {
  const canvas = document.getElementById('game');
  canvas.width = cols * PX_PER_TILE;
  canvas.height = rows * PX_PER_TILE;
  const ctx = canvas.getContext('2d');

  const myRole = roles.find(r => r.socketId === mySocketId) || null;
  const viewMode = mode || 'classic';
  const myTeam = myRole ? myRole.team : null;
  const walls = parsed.wallCells;
  const doors = parsed.doorCells;

  function draw() {
    if (!buffer.hasData) return;
    const st = buffer.interpolate();
    drawBoard(st);
    drawEntities(st);
  }

  function drawBoard(st) {
    ctx.fillStyle = BACKGROUND_COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // walls
    for (const [r, c] of walls) {
      const x = c * PX_PER_TILE, y = r * PX_PER_TILE;
      roundRect(ctx, x, y, PX_PER_TILE, PX_PER_TILE, 4);
      ctx.fillStyle = WALL_COLOR;
      ctx.fill();
      ctx.strokeStyle = WALL_EDGE;
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // ghost door
    if (doors.length) {
      const [r0, c0] = doors[0]; // door cells are contiguous horizontally
      const x = c0 * PX_PER_TILE, y = r0 * PX_PER_TILE, w = doors.length * PX_PER_TILE;
      ctx.fillStyle = BACKGROUND_COLOR;
      ctx.fillRect(x, y + PX_PER_TILE * 0.4, w, PX_PER_TILE * 0.5);
      ctx.fillStyle = DOOR_COLOR;
      ctx.fillRect(x + 2, y + PX_PER_TILE * 0.4, w - 4, 4);
    }

    // dots
    for (const k of buffer.dots) {
      const [r, c] = k.split(',').map(Number);
      ctx.fillStyle = dotColorFor(c);
      ctx.beginPath();
      ctx.arc(c * PX_PER_TILE + PX_PER_TILE / 2, r * PX_PER_TILE + PX_PER_TILE / 2, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // power pellets (blink)
    const blink = Math.floor(performance.now() / 220) % 2 === 0;
    for (const k of buffer.pellets) {
      const [r, c] = k.split(',').map(Number);
      ctx.fillStyle = pelletColorFor(c, blink);
      ctx.beginPath();
      ctx.arc(c * PX_PER_TILE + PX_PER_TILE / 2, r * PX_PER_TILE + PX_PER_TILE / 2, 5.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // 3v3 border line: subtle vertical gradient at CENTER_COL
    if (viewMode === '3v3') {
      const x = CENTER_COL * PX_PER_TILE;
      const grad = ctx.createLinearGradient(0, 0, 0, canvas.height);
      grad.addColorStop(0, 'rgba(255,68,68,0.18)');
      grad.addColorStop(0.5, 'rgba(255,255,255,0.10)');
      grad.addColorStop(1, 'rgba(68,136,255,0.18)');
      ctx.strokeStyle = grad;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 6]);
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, canvas.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function dotColorFor(c) {
    return isHomeSide(viewMode, myTeam, c) ? DOT_DIM : DOT_COLOR;
  }

  function pelletColorFor(c, blink) {
    if (isHomeSide(viewMode, myTeam, c)) return PELLET_DIM;
    return blink ? PELLET_COLOR : DOOR_COLOR;
  }

  function drawEntities(st) {
    if (Array.isArray(st.entities)) {
      const ghosts = st.entities.filter(e => !e.eaten && e.currentRole === 'ghost');
      const pacmen = st.entities.filter(e => !e.eaten && e.currentRole === 'pacman');
      for (const g of ghosts) {
        if (g.invincible) ctx.globalAlpha = 0.45;
        drawGhost(g.x, g.y, g.color, g.fright, st.teamFright ? st.teamFright[g.team] > 1.5 : g.fright, false);
        if (g.invincible) ctx.globalAlpha = 1;
        if (g.fright) drawTeamRing(g);
        if (g.transitioning) drawTransitionFlash(g);
        drawNameTag(g.name, g.x, g.y, g.color);
      }
      for (const p of pacmen) {
        drawPacman(p.x, p.y, p.dir, p.invincible, p.color);
        if (p.transitioning) drawTransitionFlash(p);
        drawNameTag(p.name, p.x, p.y, p.color);
      }
      return;
    }
    for (const g of st.ghosts) {
      if (g.eaten) continue;
      if (g.phasing) ctx.globalAlpha = 0.45;
      drawGhost(g.x, g.y, roles[gGhostRole(g, st)].color, g.fright, st.fright > 1.5 ? false : st.fright > 0, g.exposed);
      if (g.phasing) ctx.globalAlpha = 1;
      drawNameTag(roles[gGhostRole(g, st)].name, g.x, g.y, roles[gGhostRole(g, st)].color);
    }
    drawPacman(st.pacman.x, st.pacman.y, st.pacman.dir, st.invincible);
    drawNameTag(roles[0].name, st.pacman.x, st.pacman.y, PACMAN_COLOR);
  }

  function drawNameTag(name, x, y, color) {
    const cx = x * PX_PER_TILE + PX_PER_TILE / 2;
    const cy = y * PX_PER_TILE - 2;
    const label = name.length > 8 ? name.slice(0, 7) + '…' : name;
    ctx.save();
    ctx.font = 'bold 9px Verdana, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(cx - tw / 2 - 3, cy - 12, tw + 6, 13);
    ctx.fillStyle = color || '#fff';
    ctx.fillText(label, cx, cy);
    ctx.restore();
  }

  function drawTeamRing(e) {
    const cx = e.x * PX_PER_TILE + PX_PER_TILE / 2;
    const cy = e.y * PX_PER_TILE + PX_PER_TILE / 2;
    ctx.save();
    ctx.strokeStyle = e.color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, PX_PER_TILE * 0.62, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  function drawTransitionFlash(e) {
    const cx = e.x * PX_PER_TILE + PX_PER_TILE / 2;
    const cy = e.y * PX_PER_TILE + PX_PER_TILE / 2;
    const on = Math.floor(performance.now() / 80) % 2 === 0;
    ctx.save();
    ctx.globalAlpha = on ? 0.5 : 0.15;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, PX_PER_TILE * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // match ghost index in array (0..3) to roles[1..4]
  function gGhostRole(g, st) {
    const idx = st.ghosts.indexOf(g);
    return idx + 1;
  }

  function drawPacman(x, y, dir, invincible, color) {
    const cx = x * PX_PER_TILE + PX_PER_TILE / 2, cy = y * PX_PER_TILE + PX_PER_TILE / 2, r = PX_PER_TILE * 0.46;
    const a = dirAngle(dir);
    const mouth = 0.18 + 0.16 * Math.abs(Math.sin(performance.now() / 90));
    if (invincible && Math.floor(performance.now() / 120) % 2 === 0) {
      ctx.globalAlpha = 0.35;
    }
    ctx.fillStyle = color || PACMAN_COLOR;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, a + mouth, a + Math.PI * 2 - mouth);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function drawGhost(x, y, color, fright, blink, exposed) {
    const cx = x * PX_PER_TILE + PX_PER_TILE / 2, cy = y * PX_PER_TILE + PX_PER_TILE / 2, r = PX_PER_TILE * 0.46;
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
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.28, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FRIGHT_COLOR;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.13, 0, Math.PI * 2);
    ctx.fill();
  }

  return { draw, dispose() {} };
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
