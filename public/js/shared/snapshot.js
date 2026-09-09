// Owns the last two server snapshots and the live food Sets, and hands renderers smoothed state.
// Both renderers read positions through interpolate(), so the smoothing cannot drift between them.
export class SnapshotBuffer {
  constructor(parsed, cols, rows) {
    this.dots = parsed.dots;
    this.pellets = parsed.pellets;
    this.originalPellets = new Set(parsed.pellets);   // fixed layout record, used to route regen
    this.foodVersion = 0;                              // bumped on any eaten/restored change
    this.cols = cols;
    this.rows = rows;
    this.last = null;
    this.prev = null;
    this.lastAt = 0;
    this.prevAt = 0;
  }

  get hasData() { return !!this.last; }

  // Returns false if the payload is not a renderable snapshot.
  push(st) {
    if (st.mode === '3v3' || Array.isArray(st.entities)) {
      if (!Array.isArray(st.entities)) return false;
    } else {
      if (!st.pacman || !Array.isArray(st.ghosts)) return false;
    }
    this.prev = this.last;
    this.prevAt = this.lastAt;
    this.last = st;
    this.lastAt = performance.now();
    let foodChanged = false;
    if (st.eaten) {
      for (const k of st.eaten) { this.dots.delete(k); this.pellets.delete(k); }
      foodChanged = true;
    }
    if (st.restored) {
      for (const k of st.restored) {
        if (this.originalPellets.has(k)) this.pellets.add(k);
        else this.dots.add(k);
      }
      foodChanged = true;
    }
    if (foodChanged) this.foodVersion++;
    return true;
  }

  interpolate() {
    const st = this.last;
    if (!this.prev) return st;
    const buf = this;
    const f = clamp((performance.now() - buf.prevAt) / ((buf.lastAt - buf.prevAt) || 1), 0, 1);

    if (Array.isArray(st.entities)) {
      const prevBySlot = new Map();
      if (buf.prev.entities) for (const pe of buf.prev.entities) prevBySlot.set(pe.slot, pe);
      return {
        ...st,
        entities: st.entities.map(e => {
          const pe = prevBySlot.get(e.slot);
          if (!pe) return { ...e };
          return { ...e, x: lerpWrap(pe.x, e.x, f, buf.cols), y: lerpWrap(pe.y, e.y, f, buf.rows) };
        })
      };
    }

    const out = { ...st, pacman: { ...st.pacman }, ghosts: st.ghosts.map(g => ({ ...g })) };
    out.pacman.x = lerpWrap(buf.prev.pacman.x, st.pacman.x, f, buf.cols);
    out.pacman.y = lerpWrap(buf.prev.pacman.y, st.pacman.y, f, buf.rows);
    st.ghosts.forEach((g, i) => {
      const pg = buf.prev.ghosts && buf.prev.ghosts[i];
      if (pg) {
        out.ghosts[i].x = lerpWrap(pg.x, g.x, f, buf.cols);
        out.ghosts[i].y = lerpWrap(pg.y, g.y, f, buf.rows);
      }
    });
    return out;
  }
}

function lerp(a, b, f) { return a + (b - a) * f; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// The server lets px run past the board edge during a tunnel wrap before snapping to the other side,
// so a naive lerp would sweep the entity backwards across the entire maze for one snapshot interval.
// Snap instead; the slide-off-then-pop itself is left as the server sends it.
function lerpWrap(a, b, f, span) {
  if (Math.abs(b - a) > span / 2) return b;
  return lerp(a, b, f);
}
