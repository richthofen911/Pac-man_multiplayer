export const WALL_COLOR = '#2323c8';
export const WALL_EDGE = '#4a4ae0';
export const DOOR_COLOR = '#ffb8de';
export const DOT_COLOR = '#ffb897';
export const DOT_DIM = '#4a3820';
export const PELLET_COLOR = '#ffd9a8';
export const PELLET_DIM = '#5a4a30';
export const FRIGHT_COLOR = '#2121de';
export const FRIGHT_FLASH = '#f2f2ff';
export const RED_COLOR = '#ff4444';
export const BLUE_COLOR = '#4488ff';
export const PACMAN_COLOR = '#ffd400';
export const BACKGROUND_COLOR = '#000';

// 3v3 border between c=13 (left/red) and c=14 (right/blue)
export const CENTER_COL = 14;

export function roleColor(role) {
  return { Pacman: PACMAN_COLOR, Blinky: '#ff0000', Pinky: '#ffb8ff', Inky: '#00ffff', Clyde: '#ffb852' }[role] || '#555';
}

// Home-side food cannot be scored, so both renderers draw it dimmed.
export function isHomeSide(mode, myTeam, c) {
  if (mode !== '3v3' || !myTeam) return false;
  const side = c < CENTER_COL ? 'left' : 'right';
  return side === (myTeam === 'red' ? 'left' : 'right');
}
