import { useEffect, useRef } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  Line,
  LineBasicMaterial,
  LineDashedMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  Vector3,
  WebGLRenderer,
} from 'three';

/**
 * The login observatory, rebuilt as a real 3D scene: the nucleus is a line-art
 * SQL drum, and the flat orbit ellipses become inclined electron shells the
 * camera drifts around. Geometry constants descend from the original SVG
 * (680x520 view box) scaled by SVG_SCALE.
 */

const SVG_SCALE = 0.0396;

/** One electron shell: a circle of RADIUS inclined by PITCH, rolled by ROLL. */
type Shell = {
  radius: number;
  pitch: number;
  roll: number;
  dashed: boolean;
  opacity: number;
  /** The main hoop carries the ember accent, like the original ellipse. */
  ember: boolean;
};

const SHELLS: Shell[] = [
  // Outer dotted hoop (was the dashed ellipse).
  { radius: 278 * SVG_SCALE, pitch: 1.04, roll: 0, dashed: true, opacity: 0.55, ember: false },
  // The ember main hoop, rolled to echo the original -28deg ellipse.
  { radius: 252 * SVG_SCALE, pitch: 1.145, roll: -0.49, dashed: false, opacity: 0.6, ember: true },
  // Fine dashed hoop (+36deg in the flat art).
  { radius: 221 * SVG_SCALE, pitch: 1.21, roll: 0.63, dashed: true, opacity: 0.8, ember: false },
  // Steep axis hoop (+58deg).
  { radius: 217 * SVG_SCALE, pitch: 1.11, roll: 1.01, dashed: false, opacity: 0.42, ember: false },
];

type Electron = {
  shell: number;
  size: number;
  /** Seconds per revolution. */
  period: number;
  phase: number;
  trail: number;
  muted: boolean;
};

const ELECTRONS: Electron[] = [
  { shell: 1, size: 0.17, period: 38, phase: 2.2, trail: 46, muted: false },
  { shell: 2, size: 0.13, period: 30, phase: 4.4, trail: 34, muted: false },
  { shell: 0, size: 0.15, period: 58, phase: 0.8, trail: 40, muted: false },
  { shell: 3, size: 0.09, period: 24, phase: 1.6, trail: 0, muted: true },
];

type Palette = {
  bg: Color;
  ember: Color;
  muted: Color;
  line: Color;
  orbit: Color;
  glow: Color;
};

const FALLBACK: Palette = {
  bg: new Color('#0c1018'),
  ember: new Color('#ff8a3d'),
  muted: new Color('#a0abbb'),
  line: new Color('#b8c8df'),
  orbit: new Color('#c2d0e4'),
  glow: new Color('#ea793d'),
};

const WHITE = new Color('#ffffff');

/** The sun's hot tint: the theme glow pulled toward white. */
function hotTint(glow: Color): Color {
  return glow.clone().lerp(WHITE, 0.45);
}

/** Rough bell curve in [-1, 1] for scattering galaxy particles. */
function gauss(): number {
  return (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
}

/** Resolves a CSS custom property (including color-mix()) to a three Color. */
function readCssColor(probe: HTMLElement, name: string, fallback: Color): Color {
  probe.style.color = `var(${name})`;
  const raw = getComputedStyle(probe).color;
  const legacy = /rgba?\(([^)]+)\)/.exec(raw);
  const srgb = /color\(\s*srgb\s+([^)]+)\)/.exec(raw);
  let r: number;
  let g: number;
  let b: number;
  if (legacy) {
    const parts = legacy[1].split(/[\s,/]+/).filter(Boolean);
    r = Number(parts[0]);
    g = Number(parts[1]);
    b = Number(parts[2]);
  } else if (srgb) {
    const parts = srgb[1].split(/[\s,/]+/).filter(Boolean);
    r = Number(parts[0]) * 255;
    g = Number(parts[1]) * 255;
    b = Number(parts[2]) * 255;
  } else {
    return fallback;
  }
  if (!Number.isFinite(r + g + b)) return fallback;
  // CSS reports sRGB components; building from a CSS string lets three convert
  // them into its working color space correctly.
  return new Color(`rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`);
}

function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;';
  host.appendChild(probe);
  const pick = (name: string, fallback: Color) => readCssColor(probe, name, fallback);
  const palette: Palette = {
    bg: pick('--auth-scene-bg', FALLBACK.bg),
    ember: pick('--color-ember', FALLBACK.ember),
    muted: pick('--auth-scene-muted', FALLBACK.muted),
    line: pick('--auth-scene-line', FALLBACK.line),
    orbit: pick('--auth-scene-orbit', FALLBACK.orbit),
    glow: pick('--auth-glow', FALLBACK.glow),
  };
  probe.remove();
  return palette;
}

/** Points of a circle of `radius` on the XY plane, first == last. */
function circlePoints(radius: number, segments = 128): Vector3[] {
  const points: Vector3[] = [];
  for (let i = 0; i <= segments; i += 1) {
    const a = (i / segments) * Math.PI * 2;
    points.push(new Vector3(Math.cos(a) * radius, Math.sin(a) * radius, 0));
  }
  return points;
}

function makeGlowTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    // Extra stops keep the falloff smooth so no sprite edge bands on dark themes.
    gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
    gradient.addColorStop(0.2, 'rgba(255, 255, 255, 0.5)');
    gradient.addColorStop(0.45, 'rgba(255, 255, 255, 0.18)');
    gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.06)');
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, size, size);
  }
  return new CanvasTexture(canvas);
}

/**
 * A comet trail behind an electron: a fixed-length strip of past positions
 * whose vertex colors fade from ink into the current paper color.
 */
class Trail {
  line: Line;

  private positions: Float32Array;

  private colors: Float32Array;

  private count: number;

  private geometry: BufferGeometry;

  constructor(count: number) {
    this.count = count;
    this.positions = new Float32Array(count * 3);
    this.colors = new Float32Array(count * 3);
    this.geometry = new BufferGeometry();
    const positionAttr = new BufferAttribute(this.positions, 3);
    positionAttr.setUsage(DynamicDrawUsage);
    this.geometry.setAttribute('position', positionAttr);
    this.geometry.setAttribute('color', new BufferAttribute(this.colors, 3));
    this.line = new Line(
      this.geometry,
      new LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.9 }),
    );
    this.line.frustumCulled = false;
  }

  /** Seeds every sample with one position so no streak is drawn from the origin. */
  reset(at: Vector3): void {
    for (let i = 0; i < this.count; i += 1) {
      this.positions[i * 3] = at.x;
      this.positions[i * 3 + 1] = at.y;
      this.positions[i * 3 + 2] = at.z;
    }
    this.geometry.attributes.position.needsUpdate = true;
  }

  push(at: Vector3): void {
    this.positions.copyWithin(3, 0, (this.count - 1) * 3);
    this.positions[0] = at.x;
    this.positions[1] = at.y;
    this.positions[2] = at.z;
    this.geometry.attributes.position.needsUpdate = true;
  }

  /** Rebuilds the fade so the tail always sinks into the current paper color. */
  tint(bg: Color, ink: Color): void {
    for (let i = 0; i < this.count; i += 1) {
      const k = Math.pow(1 - i / (this.count - 1), 1.7);
      const c = bg.clone().lerp(ink, k);
      this.colors[i * 3] = c.r;
      this.colors[i * 3 + 1] = c.g;
      this.colors[i * 3 + 2] = c.b;
    }
    this.geometry.attributes.color.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    (this.line.material as LineBasicMaterial).dispose();
  }
}

export default function ObservatoryAtomScene() {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    } catch {
      // No WebGL available; the observatory stays quietly empty.
      return undefined;
    }

    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.domElement.classList.add('observatory-canvas');
    host.appendChild(renderer.domElement);

    const scene = new Scene();
    const camera = new PerspectiveCamera(40, 1, 0.1, 120);
    camera.position.set(0, 2.3, 26);
    camera.lookAt(0, 0, 0);

    const geometryPool: BufferGeometry[] = [];
    const materialPool: Array<{ dispose(): void }> = [];
    const trailPool: Trail[] = [];
    const trackGeometry = <T extends BufferGeometry>(geometry: T): T => {
      geometryPool.push(geometry);
      return geometry;
    };
    const trackMaterial = <T extends { dispose(): void }>(material: T): T => {
      materialPool.push(material);
      return material;
    };

    const world = new Group();
    const atom = new Group();
    world.add(atom);
    scene.add(world);

    const paletteFns: Array<(p: Palette) => void> = [];
    const tint = (material: { color: Color }, pick: (p: Palette) => Color): void => {
      paletteFns.push((p) => {
        material.color.copy(pick(p));
      });
    };

    // --- Electron shells ---------------------------------------------------
    const shellGroups = SHELLS.map((shell) => {
      const group = new Group();
      group.rotation.set(shell.pitch, 0, shell.roll);
      const geometry = trackGeometry(
        new BufferGeometry().setFromPoints(circlePoints(shell.radius, 168)),
      );
      const material = trackMaterial(
        shell.dashed
          ? new LineDashedMaterial({
              transparent: true,
              opacity: shell.opacity,
              dashSize: 0.08,
              gapSize: 0.28,
            })
          : new LineBasicMaterial({
              transparent: true,
              opacity: shell.opacity,
            }),
      );
      const ring = new Line(geometry, material);
      ring.computeLineDistances();
      group.add(ring);
      atom.add(group);
      return group;
    });

    // Shell ring colors are tinted through their materials.
    shellGroups.forEach((group, index) => {
      const ring = group.children[0] as Line;
      const material = ring.material as LineBasicMaterial | LineDashedMaterial;
      tint(material, (p) => (SHELLS[index].ember ? p.ember : p.orbit));
    });

    // --- Nucleus: a glowing galaxy ------------------------------------------
    // A hot core with layered corona sprites and a spiral particle disc,
    // colored entirely from the theme palette. The `nucleus` group carries the
    // bob and sway; the disc spins inside it while the camera-facing halos
    // stay put.
    const nucleus = new Group();
    atom.add(nucleus);

    const sunCore = new Mesh(
      trackGeometry(new SphereGeometry(0.48, 32, 24)),
      trackMaterial(new MeshBasicMaterial()),
    );
    tint(sunCore.material, (p) => hotTint(p.glow));
    nucleus.add(sunCore);

    const glowTexture = makeGlowTexture();
    const coronaLayers: Array<{
      sprite: Sprite;
      base: number;
      wobble: number;
      phase: number;
    }> = [];
    const addCorona = (scale: number, opacity: number, pick: (p: Palette) => Color): Sprite => {
      const material = trackMaterial(
        new SpriteMaterial({ map: glowTexture, transparent: true, opacity, depthWrite: false }),
      );
      tint(material, pick);
      const sprite = new Sprite(material);
      sprite.scale.setScalar(scale);
      sprite.renderOrder = coronaLayers.length;
      nucleus.add(sprite);
      coronaLayers.push({
        sprite,
        base: opacity,
        wobble: opacity * 0.3,
        phase: coronaLayers.length * 2.1,
      });
      return sprite;
    };

    addCorona(7.2, 0.1, (p) => p.glow);
    addCorona(4.0, 0.2, (p) => p.ember);
    addCorona(2.1, 0.5, (p) => hotTint(p.glow));

    // Spiral disc: a spheroid bulge plus two logarithmic arms whose scatter
    // loosens toward the rim. The disc tips toward the camera so the arms read
    // as a swirl, and it precesses slowly (see pose). Particle colors cool
    // from the hot core out to the theme's muted ink, so the disc re-tints
    // when the theme flips.
    const DISC_TILT_X = 0.35;
    const disc = new Group();
    disc.rotation.set(DISC_TILT_X, 0, 0.18);
    nucleus.add(disc);

    const galaxyClouds = [
      { count: 180, size: 0.062, opacity: 0.9, bulge: true },
      { count: 470, size: 0.055, opacity: 0.8, bulge: false },
    ].map(({ count, size, opacity, bulge }) => {
      const positions = new Float32Array(count * 3);
      const colors = new Float32Array(count * 3);
      const heat = new Float32Array(count);
      const rMin = bulge ? 0.06 : 0.78;
      const rMax = bulge ? 0.95 : 2.3;
      for (let i = 0; i < count; i += 1) {
        let r: number;
        let angle: number;
        if (bulge) {
          r = rMin + Math.pow(Math.random(), 1.6) * (rMax - rMin);
          angle = Math.random() * Math.PI * 2;
        } else {
          r = rMin + Math.pow(Math.random(), 0.74) * (rMax - rMin);
          // Two log-spiral arms, ever looser toward the rim.
          const arm = (i % 2) * Math.PI;
          const curl = Math.log(r / 0.72) * 3.4;
          const looseness = 0.12 + ((r - rMin) / (rMax - rMin)) * 0.34;
          angle = arm + curl + gauss() * looseness;
        }
        positions[i * 3] = Math.cos(angle) * r;
        positions[i * 3 + 1] = bulge
          ? (Math.random() - 0.5) * 0.3 * (1 - r / rMax)
          : gauss() * 0.045;
        positions[i * 3 + 2] = Math.sin(angle) * r;
        heat[i] = (r - rMin) / (rMax - rMin);
      }
      const geometry = trackGeometry(new BufferGeometry());
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('color', new BufferAttribute(colors, 3));
      const material = trackMaterial(
        new PointsMaterial({
          size,
          sizeAttenuation: true,
          vertexColors: true,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      );
      const cloud = new Points(geometry, material);
      disc.add(cloud);
      return { cloud, geometry, heat };
    });

    // The double halo echoes the old core circle, now drawn in space.
    const haloInnerMaterial = trackMaterial(
      new LineBasicMaterial({ transparent: true, opacity: 0.6 }),
    );
    const haloOuterMaterial = trackMaterial(
      new LineBasicMaterial({ transparent: true, opacity: 0.8 }),
    );
    tint(haloInnerMaterial, (p) => p.ember);
    tint(haloOuterMaterial, (p) => p.line);
    const haloInner = new Line(
      trackGeometry(new BufferGeometry().setFromPoints(circlePoints(2.0, 96))),
      haloInnerMaterial,
    );
    const haloOuter = new Line(
      trackGeometry(new BufferGeometry().setFromPoints(circlePoints(2.25, 96))),
      haloOuterMaterial,
    );
    nucleus.add(haloInner, haloOuter);

    // Galaxy colors cool outward: hot core -> ember -> muted ink.
    const colorScratch = new Color();
    paletteFns.push((p) => {
      const hot = hotTint(p.glow);
      for (const { geometry, heat } of galaxyClouds) {
        const colors = geometry.attributes.color.array as Float32Array;
        for (let i = 0; i < heat.length; i += 1) {
          colorScratch.copy(hot).lerp(p.ember, Math.min(1, heat[i] * 1.9));
          if (heat[i] > 0.55) {
            colorScratch.lerp(p.muted, ((heat[i] - 0.55) / 0.45) * 0.9);
          }
          colors[i * 3] = colorScratch.r;
          colors[i * 3 + 1] = colorScratch.g;
          colors[i * 3 + 2] = colorScratch.b;
        }
        geometry.attributes.color.needsUpdate = true;
      }
    });

    // --- Dust field -----------------------------------------------------------
    const dustCount = 150;
    const dustPositions = new Float32Array(dustCount * 3);
    for (let i = 0; i < dustCount; i += 1) {
      const radius = 5 + Math.random() * 7.5;
      const angle = Math.random() * Math.PI * 2;
      const y = (Math.random() - 0.5) * radius * 0.9;
      dustPositions[i * 3] = Math.cos(angle) * radius;
      dustPositions[i * 3 + 1] = y * 0.55;
      dustPositions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const dustGeometry = trackGeometry(new BufferGeometry());
    dustGeometry.setAttribute('position', new BufferAttribute(dustPositions, 3));
    const dustMaterial = trackMaterial(
      new PointsMaterial({
        size: 0.085,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.38,
        depthWrite: false,
      }),
    );
    tint(dustMaterial, (p) => p.muted);
    const dust = new Points(dustGeometry, dustMaterial);
    atom.add(dust);

    // --- Crosshair ticks --------------------------------------------------------
    const tickPoints = [
      new Vector3(-13.5, 0, 0),
      new Vector3(-11.9, 0, 0),
      new Vector3(11.9, 0, 0),
      new Vector3(13.5, 0, 0),
      new Vector3(0, -9.8, 0),
      new Vector3(0, -8.8, 0),
      new Vector3(0, 8.8, 0),
      new Vector3(0, 9.8, 0),
    ];
    const tickMaterial = trackMaterial(new LineBasicMaterial({ transparent: true, opacity: 0.55 }));
    tint(tickMaterial, (p) => p.line);
    const ticks = new LineSegments(
      trackGeometry(new BufferGeometry().setFromPoints(tickPoints)),
      tickMaterial,
    );
    atom.add(ticks);

    // --- Electrons ----------------------------------------------------------------
    // Each electron is parented to its shell group, and its trail lives in the
    // same group: an orbit trail lies in the orbital plane, in ring-local
    // coordinates, so no world-space conversion is needed.
    const electrons = ELECTRONS.map((spec) => {
      const material = trackMaterial(new MeshBasicMaterial());
      tint(material, (p) => (spec.muted ? p.muted : p.ember));
      const orb = new Mesh(trackGeometry(new SphereGeometry(spec.size, 20, 14)), material);
      shellGroups[spec.shell].add(orb);

      const trail = spec.trail > 0 ? new Trail(spec.trail) : null;
      if (trail) {
        shellGroups[spec.shell].add(trail.line);
        trailPool.push(trail);
        paletteFns.push((p) => {
          trail.tint(p.bg, spec.muted ? p.muted : p.ember);
        });
      }
      return { spec, orb, trail };
    });

    // --- Sizing --------------------------------------------------------------------
    const resize = (): void => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);

    const applyPalette = (): void => {
      const next = readPalette(host);
      for (const apply of paletteFns) apply(next);
    };

    const themeObserver = new MutationObserver(() => {
      applyPalette();
      renderer.render(scene, camera);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    // --- Motion ----------------------------------------------------------------------
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: 0, y: 0, tx: 0, ty: 0 };
    const onPointerMove = (event: MouseEvent): void => {
      if (reduced.matches) return;
      pointer.tx = (event.clientX / window.innerWidth) * 2 - 1;
      pointer.ty = (event.clientY / window.innerHeight) * 2 - 1;
    };
    window.addEventListener('mousemove', onPointerMove);

    let t = 18;
    const pose = (): void => {
      // Slow editorial drift (the old 70s CSS wobble) plus pointer parallax.
      pointer.x += (pointer.tx - pointer.x) * 0.04;
      pointer.y += (pointer.ty - pointer.y) * 0.04;
      world.rotation.y = Math.sin((t * Math.PI * 2) / 70) * 0.3 + pointer.x * 0.12;
      world.rotation.x = Math.sin((t * Math.PI * 2) / 97 + 1.7) * 0.05 + pointer.y * 0.07;
      dust.rotation.y = -t * 0.01;
      // The galaxy bobs and precesses, the disc turns with a slower bulge,
      // and the corona shimmers.
      nucleus.position.y = Math.sin(t * 0.5) * 0.1;
      nucleus.rotation.z = Math.sin(t * 0.12) * 0.04;
      disc.rotation.x = DISC_TILT_X + Math.sin(t * 0.09) * 0.06;
      galaxyClouds[1].cloud.rotation.y = t * 0.05;
      galaxyClouds[0].cloud.rotation.y = t * 0.03;
      for (const layer of coronaLayers) {
        (layer.sprite.material as SpriteMaterial).opacity =
          layer.base + Math.sin(t * 1.6 + layer.phase) * layer.wobble;
      }
    };

    const placeElectrons = (): void => {
      for (const { spec, orb, trail } of electrons) {
        const shell = SHELLS[spec.shell];
        const angle = spec.phase + (t * Math.PI * 2) / spec.period;
        orb.position.set(Math.cos(angle) * shell.radius, Math.sin(angle) * shell.radius, 0);
        if (trail) trail.reset(orb.position);
      }
    };

    const renderOnce = (): void => {
      pose();
      placeElectrons();
      renderer.render(scene, camera);
    };

    let raf = 0;
    let last = performance.now();
    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min((now - last) / 1000, 0.05);
      last = now;
      if (!reduced.matches) t += dt;
      pose();
      for (const { spec, orb, trail } of electrons) {
        const shell = SHELLS[spec.shell];
        const angle = spec.phase + (t * Math.PI * 2) / spec.period;
        orb.position.set(Math.cos(angle) * shell.radius, Math.sin(angle) * shell.radius, 0);
        if (trail) trail.push(orb.position);
      }
      renderer.render(scene, camera);
    };

    const onReducedChange = (): void => {
      pointer.tx = 0;
      pointer.ty = 0;
      renderOnce();
    };
    reduced.addEventListener('change', onReducedChange);

    resize();
    applyPalette();
    renderOnce();
    if (!reduced.matches) {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      cancelAnimationFrame(raf);
      themeObserver.disconnect();
      resizeObserver.disconnect();
      reduced.removeEventListener('change', onReducedChange);
      window.removeEventListener('mousemove', onPointerMove);
      for (const trail of trailPool) trail.dispose();
      for (const geometry of geometryPool) geometry.dispose();
      for (const material of materialPool) material.dispose();
      glowTexture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={hostRef} className="observatory-3d" aria-hidden="true" />;
}
