// Start page background ("dot grid"): a grid of dots like an LED board. The Selfbound star shows in it
// and turns slowly; a wave runs faster and faster from left to right and makes it flash; the mouse
// casts circular ripples.
//
// Frugal: one fragment shader, only a few uniforms from the main thread per frame. Runs only while
// the tab is visible and the canvas on screen. With reduced motion a still image; without WebGL 2 a
// still image via Canvas 2D. If frames take too long, first the resolution drops, then the frame rate.

export type Place = (w: number, h: number) => { x: number; y: number; r: number; k?: number };

const PERIOD = 7;
/** Moment of the still image: wave across the middle of the page, star bright */
const STILL_T = PERIOD * 0.45;

/** Colors per scheme (sRGB 0..1), from oklch with accent hue 276 as in styles/app.css */
const COLORS = {
  dark: { bg: [0.027, 0.027, 0.035], dot: [0.173, 0.176, 0.2], accent: [0.373, 0.412, 0.824], hi: [0.651, 0.698, 0.969] },
  light: { bg: [0.965, 0.969, 0.976], dot: [0.812, 0.816, 0.847], accent: [0.373, 0.412, 0.824], hi: [0.231, 0.251, 0.592] },
} as const;

const VS = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
uniform vec2 u_res;      // device pixels
uniform float u_dpr;
uniform float u_gap;     // grid spacing in device pixels
uniform float u_t;
uniform float u_phase;   // 0..1 within the period
uniform vec2 u_center;   // device pixels, y up
uniform float u_scale;
uniform float u_starK;   // star strength (dimmed behind text)
uniform vec3 u_ptr;      // x, y (device pixels, y up), strength
uniform sampler2D u_star;
uniform vec3 u_bg, u_dot, u_accent, u_hi;
out vec4 o;

float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + 1.0), u.x), u.y);
}

void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 cell = floor(frag / u_gap);
  vec2 cc = (cell + 0.5) * u_gap;
  // star, turning slowly
  vec2 q = (cc - u_center) / u_scale;
  float a = u_t * 0.08;
  q = mat2(cos(a), -sin(a), sin(a), cos(a)) * q;
  float star = texture(u_star, vec2(q.x, -q.y) * 0.5 + 0.5).a;
  // wave: accelerates across the width, long tail behind it
  float p = u_phase;
  float xs = pow(p, 2.2) * (u_res.x + 600.0 * u_dpr) - 300.0 * u_dpr;
  float dx = cc.x - xs;
  float tail = (200.0 + 900.0 * p) * u_dpr;
  float wave = dx < 0.0 ? exp(dx / tail) : exp(-dx * dx / (900.0 * u_dpr * u_dpr));
  wave *= 0.7 + 0.3 * noise(vec2(cell.y * 0.35, u_t * 2.0));
  float base = 0.06 + 0.1 * noise(cell * 0.12 + vec2(u_t * 0.35, u_t * 0.1));
  float d = length(cc - u_ptr.xy) / u_dpr;
  float ripple = u_ptr.z * max(0.0, sin(d * 0.06 - u_t * 5.0)) * exp(-d / 220.0);
  float v = clamp(base + u_starK * star * (0.45 + 0.55 * wave) + wave * 0.42 + ripple * 0.35, 0.0, 1.0);
  float r = mix(0.14, 0.46, v) * u_gap;
  float dotMask = smoothstep(r + 0.75, r - 0.75, length(frag - cc));
  vec3 col = v < 0.5 ? mix(u_dot, u_accent, v * 2.0) : mix(u_accent, u_hi, (v - 0.5) * 2.0);
  o = vec4(mix(u_bg, col, dotMask), 1.0);
}`;

type Theme = 'dark' | 'light';

export interface RasterOptions {
  place: Place;
  theme: () => Theme;
  /** Star (logo mark) as an image; without it only the grid remains */
  star: Promise<CanvasImageSource | null>;
}

export interface Raster {
  /** Redraw (color scheme or placement changed) */
  refresh(): void;
  setPlace(place: Place): void;
  destroy(): void;
}

const smallScreen = () => matchMedia('(max-width: 700px), (pointer: coarse)').matches;

export function mountRaster(canvas: HTMLCanvasElement, opts: RasterOptions): Raster {
  let place = opts.place;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false, stencil: false, powerPreference: 'low-power', preserveDrawingBuffer: false });
  const renderer = gl ? glRenderer(gl, canvas) : canvasRenderer(canvas);

  const rm = matchMedia('(prefers-reduced-motion: reduce)');
  const pointer = { x: -1e4, y: -1e4, k: 0, on: false };
  let starReady = false;
  let raf = 0;
  let running = false;
  let inView = true;
  let t = 0;
  let last = 0;
  let cw = 1;
  let ch = 1;
  // Adapting to weak devices: 0 full, 1 resolution 1×, 2 also 30 frames/s
  let level = 0;
  let slowSince = 0;
  let skip = false;

  const dprFor = () => Math.min(devicePixelRatio || 1, level > 0 ? 1 : smallScreen() ? 1.5 : 2);
  const resize = () => {
    const dpr = dprFor();
    cw = canvas.clientWidth || innerWidth;
    ch = canvas.clientHeight || innerHeight;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    renderer.viewport();
  };
  const draw = (time: number) => {
    if (!starReady) return;
    const rect = canvas.getBoundingClientRect();
    renderer.draw({
      t: time,
      dpr: canvas.width / cw,
      gap: Math.round((smallScreen() ? 9 : 11) * (canvas.width / cw)),
      place: place(cw, ch),
      pointer: { x: pointer.x - rect.left, y: pointer.y - rect.top, k: pointer.k },
      colors: COLORS[opts.theme()],
    });
    canvas.classList.add('ready');
  };

  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const frame = now - last;
    last = now;
    adapt(frame, now);
    if (level >= 2 && (skip = !skip)) return;
    const dt = Math.min(frame / 1000, 1 / 20) * (level >= 2 ? 2 : 1);
    t += dt;
    pointer.k += ((pointer.on ? 1 : 0) - pointer.k) * Math.min(1, dt * 4);
    draw(t);
  };
  // More than a second in a row above 24 ms per frame: one level more frugal.
  const adapt = (frame: number, now: number) => {
    if (level >= 2 || frame > 200) return; // > 200 ms: the tab came back, do not count it
    if (frame <= 24) {
      slowSince = 0;
      return;
    }
    if (!slowSince) slowSince = now;
    else if (now - slowSince > 1000) {
      level++;
      slowSince = 0;
      if (level === 1) resize();
    }
  };
  const start = () => {
    if (running) return;
    running = true;
    last = performance.now();
    raf = requestAnimationFrame(tick);
  };
  const stop = () => {
    running = false;
    cancelAnimationFrame(raf);
  };
  const still = () => !gl || rm.matches;
  const update = () => {
    if (still()) {
      stop();
      draw(STILL_T);
    } else if (document.hidden || !inView || !starReady) stop();
    else start();
  };
  const refresh = () => {
    resize();
    if (!running) draw(still() ? STILL_T : t);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') return;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.on = true;
  };
  const onLeave = () => {
    pointer.on = false;
  };
  const io = new IntersectionObserver(([e]) => {
    inView = e.isIntersecting;
    update();
  });
  const ro = new ResizeObserver(refresh);
  addEventListener('pointermove', onMove, { passive: true });
  document.documentElement.addEventListener('pointerleave', onLeave);
  document.addEventListener('visibilitychange', update);
  rm.addEventListener('change', update);
  io.observe(canvas);
  ro.observe(canvas);
  if (gl) {
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      stop();
      canvas.classList.remove('ready');
    });
  }

  resize();
  void opts.star.then((img) => {
    renderer.setStar(img);
    starReady = true;
    update();
  });

  return {
    refresh,
    setPlace(p) {
      place = p;
      refresh();
    },
    destroy() {
      stop();
      io.disconnect();
      ro.disconnect();
      removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', update);
      rm.removeEventListener('change', update);
    },
  };
}

interface Frame {
  t: number;
  dpr: number;
  gap: number;
  place: ReturnType<Place>;
  pointer: { x: number; y: number; k: number };
  colors: (typeof COLORS)[Theme];
}

interface Renderer {
  viewport(): void;
  setStar(img: CanvasImageSource | null): void;
  draw(f: Frame): void;
}

function glRenderer(gl: WebGL2RenderingContext, canvas: HTMLCanvasElement): Renderer {
  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(prog);
  const u = (name: string) => gl.getUniformLocation(prog, name);
  const loc = {
    res: u('u_res'), dpr: u('u_dpr'), gap: u('u_gap'), t: u('u_t'), phase: u('u_phase'), center: u('u_center'), scale: u('u_scale'),
    starK: u('u_starK'), ptr: u('u_ptr'), star: u('u_star'), bg: u('u_bg'), dot: u('u_dot'), accent: u('u_accent'), hi: u('u_hi'),
  };
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  const aPos = gl.getAttribLocation(prog, 'a_pos');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  return {
    viewport: () => gl.viewport(0, 0, canvas.width, canvas.height),
    setStar(img) {
      if (!img) return;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img as TexImageSource);
    },
    draw(f) {
      const H = canvas.height;
      gl.useProgram(prog);
      gl.uniform2f(loc.res, canvas.width, H);
      gl.uniform1f(loc.dpr, f.dpr);
      gl.uniform1f(loc.gap, f.gap);
      gl.uniform1f(loc.t, f.t);
      gl.uniform1f(loc.phase, (f.t % PERIOD) / PERIOD);
      gl.uniform2f(loc.center, f.place.x * f.dpr, H - f.place.y * f.dpr);
      gl.uniform1f(loc.scale, f.place.r * f.dpr);
      gl.uniform1f(loc.starK, f.place.k ?? 1);
      gl.uniform3f(loc.ptr, f.pointer.x * f.dpr, H - f.pointer.y * f.dpr, f.pointer.k);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(loc.star, 0);
      gl.uniform3fv(loc.bg, f.colors.bg);
      gl.uniform3fv(loc.dot, f.colors.dot);
      gl.uniform3fv(loc.accent, f.colors.accent);
      gl.uniform3fv(loc.hi, f.colors.hi);
      gl.bindVertexArray(vao);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
  };
}

/** Without WebGL 2: the same grid as a still image (star, no wave), redrawn only on size or color changes. */
function canvasRenderer(canvas: HTMLCanvasElement): Renderer {
  const g = canvas.getContext('2d')!;
  let mask: ImageData | null = null;
  const M = 128;
  const css = (c: readonly number[]) => `rgb(${c.map((v) => Math.round(v * 255)).join(' ')})`;
  return {
    viewport() {},
    setStar(img) {
      if (!img) return;
      const m = document.createElement('canvas');
      m.width = m.height = M;
      const mg = m.getContext('2d', { willReadFrequently: true })!;
      mg.drawImage(img, 0, 0, M, M);
      mask = mg.getImageData(0, 0, M, M);
    },
    draw(f) {
      const { width: W, height: H } = canvas;
      g.fillStyle = css(f.colors.bg);
      g.fillRect(0, 0, W, H);
      const cx = f.place.x * f.dpr;
      const cy = f.place.y * f.dpr;
      const r = f.place.r * f.dpr;
      const k = f.place.k ?? 1;
      const lo = css(f.colors.dot);
      const mid = css(f.colors.accent);
      for (let y = f.gap / 2; y < H; y += f.gap) {
        for (let x = f.gap / 2; x < W; x += f.gap) {
          let s = 0;
          if (mask) {
            const mx = Math.floor(((x - cx) / r / 2 + 0.5) * M);
            const my = Math.floor(((y - cy) / r / 2 + 0.5) * M);
            if (mx >= 0 && my >= 0 && mx < M && my < M) s = (mask.data[(my * M + mx) * 4 + 3] / 255) * k;
          }
          const v = 0.1 + s * 0.6;
          g.fillStyle = s > 0.3 ? mid : lo;
          g.beginPath();
          g.arc(x, y, (0.14 + 0.32 * v) * f.gap, 0, Math.PI * 2);
          g.fill();
        }
      }
    },
  };
}

/** Logo mark as a blurred mask (soft edges give graded dots in the grid). */
export async function loadStar(url: string, size = 512): Promise<HTMLCanvasElement | null> {
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const g = c.getContext('2d')!;
    const pad = size * 0.02;
    // Fit without stretching: the symbol does not have to be square.
    const k = size - 2 * pad / Math.max(img.naturalWidth, img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    g.filter = `blur(${Math.round(size / 85)}px)`;
    g.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    return c;
  } catch {
    return null;
  }
}
