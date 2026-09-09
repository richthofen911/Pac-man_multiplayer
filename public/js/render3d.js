import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { PX_PER_TILE, DIR_VEC } from './shared/maze.js';
import {
  WALL_COLOR, WALL_EDGE, DOOR_COLOR, DOT_COLOR, DOT_DIM, PELLET_COLOR, PELLET_DIM,
  RED_COLOR, BLUE_COLOR, PACMAN_COLOR, CENTER_COL, BACKGROUND_COLOR,
  FRIGHT_COLOR, FRIGHT_FLASH, isHomeSide
} from './shared/theme.js';

const WALL_H = 0.5;
const WALL_CAP_H = 0.06;
const WALL_D = 0.94;
// 35 degrees from vertical. With WALL_H = 0.5 the camera ray from any floor dot to the camera clears
// the top of a wall one tile toward the camera (ray y at the wall's far face is 0.78 > WALL_H), so
// walls never occlude dots or entities. Re-check if WALL_H or TILT changes.
const TILT = THREE.MathUtils.degToRad(35);
const CAM_DIST = 60;                          // arbitrary under an orthographic projection
const ENT_R = 0.46;
const DOT_R = 0.13;      // 2.6px at 20px/tile, matching the 2D renderer
const PELLET_R = 0.275;  // 5.5px at 20px/tile
const GHOST_SKIRT_H = 0.42;
const GHOST_HOVER = 0.22;   // ghosts float this far above the floor; pacmen stay grounded
const FRIGHT_AMPLITUDE = 4 / PX_PER_TILE;    // the 2D zigzag swings 4px either way
const MAX_RIGS = 6;

const WHITE = new THREE.Color(0xffffff);

// Floor decals: the 2D renderer draws these in screen space, so lay them flat and face up.
function flatDisc(geo) {
  geo.rotateX(-Math.PI / 2);
  return geo;
}

export function createRenderer3D({ buffer, parsed, cols, rows, roles, mySocketId, mode }) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoftShadowMap was removed in r186 and aliases this

  const wrap = document.querySelector('.canvas-wrap');
  wrap.classList.add('mode-3d');
  wrap.insertBefore(renderer.domElement, wrap.firstChild);

  const myRole = roles.find(r => r.socketId === mySocketId) || null;
  const viewMode = mode || 'classic';
  const myTeam = myRole ? myRole.team : null;

  // The board lies in the XZ plane with Y up, one world unit per tile, origin at the board center.
  const worldX = x => x - (cols - 1) / 2;
  const worldZ = y => y - (rows - 1) / 2;
  const onHomeSide = c => isHomeSide(viewMode, myTeam, c);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKGROUND_COLOR);

  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 200);
  camera.position.set(0, CAM_DIST * Math.cos(TILT), CAM_DIST * Math.sin(TILT));
  camera.lookAt(0, 0, 0);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'labels';
  wrap.appendChild(labelRenderer.domElement);

  addLight();
  buildBoard();
  const food = buildFood();
  const rigs = buildRigs();

  const ro = new ResizeObserver(onResize);
  ro.observe(wrap);
  onResize();

  function addLight() {
    // Light rakes in from the side rather than from the camera's own direction: a camera-side light
    // drops every wall shadow behind its wall where it is never visible, so nothing reads as depth.
    const sun = new THREE.DirectionalLight(0xffffff, 2.0);
    sun.position.set(-20, 26, 6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.normalBias = 0.02;
    const sc = sun.shadow.camera;
    sc.left = -22; sc.right = 22; sc.top = 24; sc.bottom = -24; sc.near = 1; sc.far = 120;
    sc.updateProjectionMatrix();
    scene.add(sun);
    scene.add(new THREE.AmbientLight(0x8888aa, 0.5));
  }

  function buildBoard() {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(cols + 2, rows + 2),
      new THREE.MeshLambertMaterial({ color: '#050508' })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);

    // Walls are short and slightly translucent so floor dots stay readable through them. The bright
    // opaque cap on top keeps walls reading as solid geometry. instanceColor is left in place on the
    // wall body should individual cells ever need dimming.
    const wallMat = new THREE.MeshLambertMaterial({
      color: WALL_COLOR, emissive: WALL_COLOR, emissiveIntensity: 0.32,
      transparent: true, opacity: 0.72, depthWrite: false
    });
    const walls = new THREE.InstancedMesh(
      new RoundedBoxGeometry(WALL_D, WALL_H, WALL_D, 2, 0.08), wallMat,
      Math.max(parsed.wallCells.length, 1)
    );
    walls.castShadow = walls.receiveShadow = true;
    walls.frustumCulled = false;

    const capMat = new THREE.MeshLambertMaterial({
      color: WALL_EDGE, emissive: WALL_EDGE, emissiveIntensity: 0.45
    });
    const caps = new THREE.InstancedMesh(
      new THREE.BoxGeometry(WALL_D, WALL_CAP_H, WALL_D), capMat,
      Math.max(parsed.wallCells.length, 1)
    );
    caps.frustumCulled = false;

    const place = new THREE.Object3D();
    parsed.wallCells.forEach(([r, c], i) => {
      place.position.set(worldX(c), WALL_H / 2, worldZ(r));
      place.updateMatrix();
      walls.setMatrixAt(i, place.matrix);
      walls.setColorAt(i, WHITE);
      place.position.set(worldX(c), WALL_H + WALL_CAP_H / 2, worldZ(r));
      place.updateMatrix();
      caps.setMatrixAt(i, place.matrix);
    });
    walls.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    caps.instanceMatrix.needsUpdate = true;
    scene.add(walls);
    scene.add(caps);

    if (parsed.doorCells.length) {
      const [r0, c0] = parsed.doorCells[0]; // door cells are contiguous horizontally
      const span = parsed.doorCells.length;
      const door = new THREE.Mesh(
        new THREE.BoxGeometry(span * WALL_D, 0.14, 0.12),
        new THREE.MeshBasicMaterial({ color: DOOR_COLOR })
      );
      door.position.set(worldX(c0 + (span - 1) / 2), WALL_H / 2, worldZ(r0));
      scene.add(door);
    }

    if (viewMode === '3v3') {
      // Dashed red-white-blue divider on the boundary between CENTER_COL-1 and CENTER_COL.
      const bx = worldX(CENTER_COL) - 0.5;
      const pts = [
        new THREE.Vector3(bx, 0.02, worldZ(0) - 0.5),
        new THREE.Vector3(bx, 0.02, worldZ(rows / 2)),
        new THREE.Vector3(bx, 0.02, worldZ(rows - 1) + 0.5)
      ];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      geo.setAttribute('color', new THREE.Float32BufferAttribute([
        ...new THREE.Color(RED_COLOR).toArray(),
        ...new THREE.Color(0xffffff).toArray(),
        ...new THREE.Color(BLUE_COLOR).toArray()
      ], 3));
      const line = new THREE.Line(geo, new THREE.LineDashedMaterial({
        vertexColors: true, dashSize: 0.3, gapSize: 0.3, transparent: true, opacity: 0.32
      }));
      line.computeLineDistances();
      scene.add(line);
    }
  }

  function buildFood() {
    const dotMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    const dotGeo = new THREE.CircleGeometry(DOT_R, 10);
    dotGeo.rotateX(-Math.PI / 2);
    const dots = new THREE.InstancedMesh(dotGeo, dotMat, Math.max(buffer.dots.size, 1));
    dots.frustumCulled = false;
    dots.count = 0;
    scene.add(dots);

    const bright = new THREE.MeshBasicMaterial({ color: PELLET_COLOR });
    const dim = new THREE.MeshBasicMaterial({ color: PELLET_DIM });
    const pelletGeo = new THREE.SphereGeometry(PELLET_R, 12, 10);
    const pellets = [...buffer.pellets].map(key => {
      const [r, c] = key.split(',').map(Number);
      const mesh = new THREE.Mesh(pelletGeo, onHomeSide(c) ? dim : bright);
      mesh.position.set(worldX(c), PELLET_R, worldZ(r));
      scene.add(mesh);
      return { key, mesh };
    });

    let builtVersion = -1;
    const place = new THREE.Object3D();

    function sync() {
      // Home-side pellets stay dim; everything else alternates, exactly as the 2D renderer does
      // (in classic no cell counts as a home side, so every pellet blinks).
      const blink = Math.floor(performance.now() / 220) % 2 === 0;
      bright.color.set(blink ? PELLET_COLOR : DOOR_COLOR);

      // Pellet visibility is pure Set membership, so an eaten or regenerated pellet reacts the same
      // frame; keep it outside the version-gated dot rebuild below.
      for (const p of pellets) p.mesh.visible = buffer.pellets.has(p.key);

      if (buffer.foodVersion === builtVersion) return;
      builtVersion = buffer.foodVersion;
      let i = 0;
      for (const key of buffer.dots) {
        const [r, c] = key.split(',').map(Number);
        place.position.set(worldX(c), 0.02, worldZ(r));
        place.updateMatrix();
        dots.setMatrixAt(i, place.matrix);
        dots.setColorAt(i, onHomeSide(c) ? DOT_DIM_COLOR : DOT_COLOR_HEX);
        i++;
      }
      dots.count = i;
      dots.instanceMatrix.needsUpdate = true;
      if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    }
    return { sync };
  }

  function buildRigs() {
    const jawTopGeo = new THREE.SphereGeometry(ENT_R, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2);
    const jawBotGeo = new THREE.SphereGeometry(ENT_R, 24, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2);
    const domeGeo = new THREE.SphereGeometry(ENT_R, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2);
    const skirtGeo = makeSkirtGeometry(ENT_R, GHOST_SKIRT_H, 5, 0.16);
    const eyeGeo = new THREE.SphereGeometry(ENT_R * 0.28, 12, 8);
    const pupilGeo = new THREE.SphereGeometry(ENT_R * 0.13, 10, 8);
    const ringGeo = flatDisc(new THREE.RingGeometry(0.55, 0.62, 32));
    const flashGeo = flatDisc(new THREE.CircleGeometry(0.55, 24));
    // Role pads: filled disc under pacmen, hollow ring under ghosts. Always-on, team-colored, and
    // small enough to sit inside the existing fright/exposed ring at radius 0.55-0.62.
    const padDiscGeo = flatDisc(new THREE.CircleGeometry(0.34, 24));
    const padRingGeo = flatDisc(new THREE.RingGeometry(0.28, 0.40, 28));
    const faceGeo = frightFaceGeometry();
    const shared = { jawTopGeo, jawBotGeo, domeGeo, skirtGeo, eyeGeo, pupilGeo, ringGeo, flashGeo, padDiscGeo, padRingGeo, faceGeo };

    const out = [];
    for (let i = 0; i < MAX_RIGS; i++) {
      const group = new THREE.Group();

      // Pacman: two hemispheres hinged on the shoulder axis, so the chomp is transform-only. The
      // cut plane is open, hence DoubleSide.
      const pacMat = new THREE.MeshLambertMaterial({ color: PACMAN_COLOR, transparent: true, side: THREE.DoubleSide });
      const pacNode = new THREE.Group();
      const pivot = new THREE.Group();
      pivot.position.y = ENT_R;
      const jawTop = new THREE.Group();
      const jawBot = new THREE.Group();
      const topMesh = new THREE.Mesh(shared.jawTopGeo, pacMat);
      const botMesh = new THREE.Mesh(shared.jawBotGeo, pacMat);
      topMesh.castShadow = botMesh.castShadow = true;
      jawTop.add(topMesh);
      jawBot.add(botMesh);
      pivot.add(jawTop, jawBot);
      pacNode.add(pivot);
      group.add(pacNode);

      const ghostMat = new THREE.MeshLambertMaterial({ color: RED_COLOR, transparent: true, side: THREE.DoubleSide });
      const eyeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true });
      const pupilMat = new THREE.MeshBasicMaterial({ color: FRIGHT_COLOR, transparent: true });
      const ghostNode = new THREE.Group();
      ghostNode.position.y = GHOST_HOVER;
      const dome = new THREE.Mesh(shared.domeGeo, ghostMat);
      dome.position.y = GHOST_SKIRT_H;
      const skirt = new THREE.Mesh(shared.skirtGeo, ghostMat);
      skirt.position.y = GHOST_SKIRT_H / 2;
      dome.castShadow = skirt.castShadow = true;
      const eyes = [], pupils = [];
      for (const sx of [-1, 1]) {
        const eye = new THREE.Mesh(shared.eyeGeo, eyeMat);
        eye.position.set(sx * ENT_R * 0.37, GHOST_SKIRT_H + 0.16, ENT_R * 0.78);
        const pupil = new THREE.Mesh(shared.pupilGeo, pupilMat);
        pupil.position.set(sx * ENT_R * 0.37, GHOST_SKIRT_H + 0.16, ENT_R * 0.98);
        ghostNode.add(eye, pupil);
        eyes.push(eye);
        pupils.push(pupil);
      }
      const face = new THREE.Line(shared.faceGeo, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true }));
      ghostNode.add(dome, skirt, face);
      ghostNode.visible = false;
      group.add(ghostNode);

      // Role pad sits below the existing fright ring (y=0.05) and transition flash (y=0.04) so the
      // three stack cleanly without z-fighting.
      const padDisc = new THREE.Mesh(shared.padDiscGeo, new THREE.MeshBasicMaterial({
        color: PACMAN_COLOR, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false
      }));
      padDisc.position.y = 0.03;
      padDisc.visible = false;
      group.add(padDisc);

      const padRing = new THREE.Mesh(shared.padRingGeo, new THREE.MeshBasicMaterial({
        color: RED_COLOR, transparent: true, opacity: 0.65, side: THREE.DoubleSide, depthWrite: false
      }));
      padRing.position.y = 0.03;
      padRing.visible = false;
      group.add(padRing);

      const ring = new THREE.Mesh(shared.ringGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, side: THREE.DoubleSide
      }));
      ring.position.y = 0.05;
      ring.visible = false;
      group.add(ring);

      const flash = new THREE.Mesh(shared.flashGeo, new THREE.MeshBasicMaterial({
        color: 0xffffff, transparent: true, side: THREE.DoubleSide
      }));
      flash.position.y = 0.04;
      flash.visible = false;
      group.add(flash);

      const tag = document.createElement('div');
      tag.className = 'ent-tag';
      const tagObj = new CSS2DObject(tag);
      tagObj.position.set(0, 1.2, 0);
      group.add(tagObj);

      scene.add(group);
      out.push({
        group, pacNode, pivot, jawTop, jawBot, pacMat,
        ghostNode, ghostMat, eyeMat, pupilMat, eyes, pupils, face,
        ring, flash, padDisc, padRing, tag
      });
    }
    return out;
  }

  // Open cylinder whose bottom ring is pushed up into `scallops` waves, giving the classic notched
  // hem. A LatheGeometry cannot do this: its bottom edge is always a perfect circle.
  function makeSkirtGeometry(r, h, scallops, amp) {
    const geo = new THREE.CylinderGeometry(r, r, h, 32, 1, true);
    const pos = geo.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (y > -h / 2 + 1e-6) continue;
      const theta = Math.atan2(pos.getZ(i), pos.getX(i));
      pos.setY(i, y + amp * (0.5 + 0.5 * Math.cos(scallops * theta)));
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    return geo;
  }

  // The zigzag has to follow the dome, not sit in a flat plane, or the body hides it.
  function frightFaceGeometry() {
    const y = GHOST_SKIRT_H + 0.1;
    const dy = y - GHOST_SKIRT_H;
    const zAt = x => Math.sqrt(Math.max(0.0001, ENT_R * ENT_R - x * x - dy * dy)) + 0.015;
    const pts = [];
    const start = -ENT_R * 0.5;
    pts.push(new THREE.Vector3(start, y, zAt(start)));
    for (let i = 0; i < 4; i++) {
      const x = start + (ENT_R / 4) * (i * 2 + 1);
      pts.push(new THREE.Vector3(x, y + (i % 2 ? FRIGHT_AMPLITUDE : -FRIGHT_AMPLITUDE), zAt(x)));
    }
    const end = ENT_R * 0.5;
    pts.push(new THREE.Vector3(end, y, zAt(end)));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }

  function draw() {
    if (!buffer.hasData) return;
    const st = buffer.interpolate();
    food.sync();
    syncEntities(st);
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
  }

  // Mirrors the 2D renderer's drawEntities exactly, including which flag drives each effect.
  function collectViews(st) {
    const views = [];
    if (Array.isArray(st.entities)) {
      for (const e of st.entities) {
        if (e.eaten || e.currentRole !== 'ghost') continue;
        views.push({
          x: e.x, y: e.y, dir: e.dir, color: e.color, name: e.name, role: 'ghost',
          fright: e.fright,
          blink: st.teamFright ? st.teamFright[e.team] > 1.5 : e.fright,
          dim: e.invincible, ring: e.fright ? e.color : null, flash: e.transitioning
        });
      }
      for (const e of st.entities) {
        if (e.eaten || e.currentRole !== 'pacman') continue;
        views.push({
          x: e.x, y: e.y, dir: e.dir, color: e.color, name: e.name, role: 'pacman',
          invincible: e.invincible, flash: e.transitioning
        });
      }
      return views;
    }
    st.ghosts.forEach((g, i) => {
      if (g.eaten) return;
      views.push({
        x: g.x, y: g.y, dir: g.dir, color: roles[i + 1].color, name: roles[i + 1].name, role: 'ghost',
        fright: g.fright, blink: st.fright > 1.5 ? false : st.fright > 0,
        exposed: g.exposed, dim: g.phasing
      });
    });
    views.push({
      x: st.pacman.x, y: st.pacman.y, dir: st.pacman.dir, color: PACMAN_COLOR,
      name: roles[0].name, role: 'pacman', invincible: st.invincible
    });
    return views;
  }

  function syncEntities(st) {
    const views = collectViews(st);
    const now = performance.now();
    rigs.forEach((rig, i) => {
      const v = views[i];
      if (!v) { rig.group.visible = false; return; }
      rig.group.visible = true;
      rig.group.position.set(worldX(v.x), 0, worldZ(v.y));

      const isPac = v.role === 'pacman';
      rig.pacNode.visible = isPac;
      rig.ghostNode.visible = !isPac;
      const mat = isPac ? rig.pacMat : rig.ghostMat;

      if (isPac) {
        mat.color.set(v.color);
        const d = DIR_VEC[v.dir];
        if (d) rig.pivot.rotation.y = Math.atan2(d.x, d.y);
        const mouth = 0.18 + 0.16 * Math.abs(Math.sin(now / 90));
        rig.jawTop.rotation.x = -mouth;
        rig.jawBot.rotation.x = mouth;
        mat.opacity = v.invincible && Math.floor(now / 120) % 2 === 0 ? 0.35 : 1;
        rig.padDisc.visible = true;
        rig.padDisc.material.color.set(v.color);
        rig.padRing.visible = false;
      } else {
        const fright = !!v.fright;
        mat.color.set(fright ? (v.blink ? FRIGHT_FLASH : FRIGHT_COLOR) : v.color);
        // 2D dims the whole ghost via globalAlpha, eyes and frightened face included.
        const alpha = v.dim ? 0.45 : 1;
        mat.opacity = alpha;
        rig.eyeMat.opacity = alpha;
        rig.pupilMat.opacity = alpha;
        rig.face.material.opacity = alpha;
        rig.eyes.forEach(e => { e.visible = !fright; });
        rig.pupils.forEach(p => { p.visible = !fright; });
        rig.face.visible = fright;
        // Pad keeps the team/role color even while the body flashes fright blue, so the role cue
        // never disappears during a fright window.
        rig.padRing.visible = true;
        rig.padRing.material.color.set(v.color);
        rig.padDisc.visible = false;
      }

      const showRing = v.role === 'ghost' && (v.exposed && !v.fright ? 'exposed' : v.ring ? 'team' : null);
      if (!showRing) {
        rig.ring.visible = false;
      } else {
        rig.ring.visible = true;
        if (showRing === 'exposed') {
          const pulse = 0.5 + 0.5 * Math.sin(now / 120);
          rig.ring.material.color.set(0xffffff);
          rig.ring.material.opacity = 0.4 + 0.6 * pulse;
          rig.ring.scale.setScalar(1 + 0.1 * pulse);
        } else {
          rig.ring.material.color.set(v.ring);
          rig.ring.material.opacity = 0.85;
          rig.ring.scale.setScalar(1);
        }
      }

      if (!v.flash) {
        rig.flash.visible = false;
      } else {
        rig.flash.visible = true;
        rig.flash.material.opacity = Math.floor(now / 80) % 2 === 0 ? 0.5 : 0.15;
      }

      const label = v.name.length > 8 ? v.name.slice(0, 7) + '…' : v.name;
      if (rig.tag.textContent !== label) rig.tag.textContent = label;
      rig.tag.style.color = v.color;
    });
  }

  function onResize() {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    labelRenderer.setSize(w, h);
    fitCamera(camera, w / h, cols, rows, WALL_H, TILT);
  }

  function dispose() {
    ro.disconnect();
    scene.traverse(obj => {
      if (obj.geometry) obj.geometry.dispose();
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) if (m) m.dispose();
    });
    for (const rig of rigs) if (rig.tag.parentNode) rig.tag.parentNode.removeChild(rig.tag);
    labelRenderer.domElement.remove();
    renderer.domElement.remove();
    renderer.dispose();
    renderer.forceContextLoss();
    wrap.classList.remove('mode-3d');
  }

  return { draw, dispose, canvas: renderer.domElement };
}

// A ground point's screen-vertical coordinate under this camera is y*sin(tilt) - z*cos(tilt), so the
// board projects to ROWS*cos(tilt) tall by COLS wide, with wall tops adding WALL_H*sin(tilt).
function fitCamera(cam, aspect, cols, rows, wallH, tilt, pad = 1.04) {
  const needW = cols * pad;
  const needH = (rows * Math.cos(tilt) + wallH * Math.sin(tilt)) * pad;
  const halfH = Math.max(needH / 2, (needW / 2) / aspect);
  cam.top = halfH;
  cam.bottom = -halfH;
  cam.left = -halfH * aspect;
  cam.right = halfH * aspect;
  cam.updateProjectionMatrix();
}

const DOT_COLOR_HEX = new THREE.Color(DOT_COLOR);
const DOT_DIM_COLOR = new THREE.Color(DOT_DIM);
