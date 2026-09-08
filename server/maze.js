'use strict';

const MAP = [
  '############################',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#o####.#####.##.#####.####o#',
  '#.####.#####.##.#####.####.#',
  '#..........................#',
  '#.####.##.########.##.####.#',
  '#.####.##.########.##.####.#',
  '#......##....##....##......#',
  '######.##### ## #####.######',
  '     #.##### ## #####.#     ',
  '     #.##          ##.#     ',
  '     #.## ###--### ##.#     ',
  '######.## #      # ##.######',
  '      .   #      #   .      ',
  '######.## #      # ##.######',
  '     #.## ######## ##.#     ',
  '     #.##          ##.#     ',
  '     #.## ######## ##.#     ',
  '######.## ######## ##.######',
  '#............##............#',
  '#.####.#####.##.#####.####.#',
  '#.####.#####.##.#####.####.#',
  '#o..##.......  .......##..o#',
  '###.##.##.########.##.##.###',
  '###.##.##.########.##.##.###',
  '#......##....##....##......#',
  '#.##########.##.##########.#',
  '#.##########.##.##########.#',
  '#..........................#',
  '############################'
];

const TILE = {
  EMPTY: 0,
  WALL: 1,
  DOT: 2,
  PELLET: 3,
  DOOR: 4
};

const COLS = 28;
const ROWS = 31;

const DIRS = { up: 0, down: 1, left: 2, right: 3 };
const DX = { up: 0, down: 0, left: -1, right: 1 };
const DY = { up: -1, down: 1, left: 0, right: 0 };
const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };

function buildMaze() {
  const maze = [];
  let dots = 0;
  let pellets = 0;
  for (let r = 0; r < ROWS; r++) {
    const line = MAP[r];
    if (line.length !== COLS) {
      throw new Error(`Maze row ${r} has length ${line.length}, expected ${COLS}`);
    }
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const ch = line[c];
      let t = TILE.EMPTY;
      if (ch === '#') t = TILE.WALL;
      else if (ch === '.') { t = TILE.DOT; dots++; }
      else if (ch === 'o') { t = TILE.PELLET; pellets++; }
      else if (ch === '-') t = TILE.DOOR;
      row.push(t);
    }
    maze.push(row);
  }
  return { maze, dots, pellets };
}

function isWall(t) {
  return t === TILE.WALL;
}

// A cell is enterable by an entity. Doors are ghost-only.
function canEnter(maze, r, c, ghost) {
  const t = maze[r][c];
  if (t === TILE.WALL) return false;
  if (t === TILE.DOOR && !ghost) return false;
  return true;
}

// Is there a clear walk onto the neighbour cell from (r,c) in direction d?
function canMove(maze, r, c, d, ghost) {
  let nr = r + DY[d];
  let nc = c + DX[d];
  if (nc < 0) nc = COLS - 1;
  if (nc >= COLS) nc = 0;
  if (nr < 0 || nr >= ROWS) return false;
  return canEnter(maze, nr, nc, ghost);
}

// Resolve a neighbour cell for a direction, tunneling horizontally at the
// sides where the edge cells are passable.
function neighbor(maze, r, c, d, ghost) {
  let nr = r + DY[d];
  let nc = c + DX[d];
  if (nc < 0) nc = COLS - 1;
  if (nc >= COLS) nc = 0;
  return { r: nr, c: nc };
}

function tileAt(maze, r, c) {
  return maze[r][c];
}

// --- 3v3 mode additions ---

// Border column: tiles with c < CENTER_COL are red home side; c >= CENTER_COL are blue home side.
const CENTER_COL = 14;

// Derived map: open the center wall pair on rows 8 and 26 so 6 dynamic players have
// additional crossing routes besides rows 5 / 23 / 29.
const MAP_3V3 = MAP.map((row, i) => {
  if (i === 8 || i === 26) {
    return row.substring(0, 13) + '..' + row.substring(15);
  }
  return row;
});

const RED_SPAWNS = [
  { r: 14, c: 11, release: 0 },
  { r: 13, c: 12, release: 3 },
  { r: 15, c: 12, release: 5 }
];
const BLUE_SPAWNS = [
  { r: 14, c: 16, release: 0 },
  { r: 13, c: 15, release: 3 },
  { r: 15, c: 15, release: 5 }
];

function buildMaze3v3() {
  const maze = [];
  let dots = 0;
  let pellets = 0;
  for (let r = 0; r < ROWS; r++) {
    const line = MAP_3V3[r];
    if (line.length !== COLS) {
      throw new Error(`3v3 maze row ${r} has length ${line.length}, expected ${COLS}`);
    }
    const row = [];
    for (let c = 0; c < COLS; c++) {
      const ch = line[c];
      let t = TILE.EMPTY;
      if (ch === '#') t = TILE.WALL;
      else if (ch === '.') { t = TILE.DOT; dots++; }
      else if (ch === 'o') { t = TILE.PELLET; pellets++; }
      else if (ch === '-') t = TILE.DOOR;
      row.push(t);
    }
    maze.push(row);
  }
  return { maze, dots, pellets };
}

module.exports = {
  MAP, TILE, COLS, ROWS, DIRS, DX, DY, OPPOSITE,
  buildMaze, isWall, canEnter, canMove, neighbor, tileAt,
  MAP_3V3, CENTER_COL, RED_SPAWNS, BLUE_SPAWNS, buildMaze3v3
};
