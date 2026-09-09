import { createRenderer2D } from './render2d.js';
import { createRenderer3D } from './render3d.js';

const FACTORIES = {
  '2d': createRenderer2D,
  '3d': createRenderer3D
};

const GFX_KEY = 'pacman_gfx';
let webglOk = null;

export function webglAvailable() {
  if (webglOk === null) {
    try {
      const probe = document.createElement('canvas');
      webglOk = !!(probe.getContext('webgl2') || probe.getContext('webgl'));
    } catch (err) {
      webglOk = false;
    }
  }
  return webglOk;
}

export function preferredKind() {
  const stored = localStorage.getItem(GFX_KEY);
  if (stored !== '2d' && stored !== '3d') return webglAvailable() ? '3d' : '2d';
  return stored === '3d' && webglAvailable() ? '3d' : '2d';
}

export function setPreferredKind(kind) {
  localStorage.setItem(GFX_KEY, kind === '3d' ? '3d' : '2d');
}

// Both renderers are pure views over opts.buffer, so swapping one for the other mid-game preserves
// which dots have already been eaten.
export function createRenderer(kind, opts) {
  const make = FACTORIES[kind];
  if (!make) return createRenderer2D(opts);
  try {
    return make(opts);
  } catch (err) {
    console.warn('Renderer "' + kind + '" could not start, using Classic 2D:', err);
    if (opts.onFallback) opts.onFallback(err);
    return createRenderer2D(opts);
  }
}
