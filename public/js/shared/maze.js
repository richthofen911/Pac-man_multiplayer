// Pixels per tile for the 2D canvas renderer. Named to avoid the collision with the server's
// TILE tile-*type* enum in server/maze.js.
export const PX_PER_TILE = 20;

export function keyOf(r, c) {
  return r + ',' + c;
}

// Legend matches server/maze.js: '#' wall, '.' dot, 'o' power pellet, '-' ghost house door.
export function parseMaze(map, cols, rows) {
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
      else if (ch === '.') { row.push(2); dots.add(keyOf(r, c)); }
      else if (ch === 'o') { row.push(3); pellets.add(keyOf(r, c)); }
      else if (ch === '-') { row.push(4); doorCells.push([r, c]); }
      else row.push(0);
    }
    maze.push(row);
  }
  return { maze, wallCells, doorCells, dots, pellets };
}

export function dirAngle(dir) {
  switch (dir) {
    case 'up': return -Math.PI / 2;
    case 'down': return Math.PI / 2;
    case 'left': return Math.PI;
    case 'right':
    default: return 0;
  }
}

// Column/row delta per direction string as sent on the wire. dirAngle serves the 2D canvas; this
// serves the 3D renderer's yaw, and keeping both here means one definition of what a direction is.
export const DIR_VEC = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 }
};
