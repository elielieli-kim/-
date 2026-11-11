// 천 리본 애니메이션: 금액이 클수록 리본이 길어지고, 줄면 짧아진다.
// 한 캔버스에 여러 리본(spec)을 그린다.
//   spec = { frac: 0~1(너비 대비 길이), budgetFrac: 0~1|null, y: 0~1, amp, thick, freq, twist, seed }
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

const FACE = [236, 233, 222];   // 리본 앞면
const BACK = [184, 180, 165];   // 리본 뒷면(음영)
const OVER_FACE = [255, 204, 0]; // 예산 초과 구간: #FFCC00
const OVER_BACK = [201, 160, 0];

const mix = (a, b, t) => `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`;

export class RibbonField {
  constructor(canvas, specs) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.specs = specs.map((s) => ({ amp: 10, thick: 22, freq: 1.4, twist: 2.2, y: 0.5, seed: Math.random() * 6, budgetFrac: null, ...s, cur: REDUCED ? s.frac : 0 }));
    this.phase = 0;
    this.visible = true;
    this.last = performance.now();
    this.resize = this.resize.bind(this);
    this.tick = this.tick.bind(this);
    this.ro = new ResizeObserver(this.resize);
    this.ro.observe(canvas);
    this.io = new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; if (this.visible) this.kick(); });
    this.io.observe(canvas);
    this.resize();
    this.kick();
  }

  // 목표 길이 갱신 → 현재 길이에서 새 길이로 부드럽게 변한다
  update(specs) {
    specs.forEach((s, i) => { if (this.specs[i]) { Object.assign(this.specs[i], s); if (REDUCED) this.specs[i].cur = s.frac ?? this.specs[i].cur; } });
    this.kick();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const r = this.canvas.getBoundingClientRect();
    this.W = r.width; this.H = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  kick() { if (!this.raf && !REDUCED) { this.last = performance.now(); this.raf = requestAnimationFrame(this.tick); } else if (REDUCED) this.draw(); }

  tick(now) {
    this.raf = 0;
    if (!this.canvas.isConnected) { this.ro.disconnect(); this.io.disconnect(); return; }
    if (!this.visible) return;
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.phase += dt;
    // 지수 보간: 목표 길이로 부드럽게 접근
    const k = 1 - Math.exp(-dt * 3.2);
    for (const s of this.specs) s.cur += (s.frac - s.cur) * k;
    this.draw();
    this.raf = requestAnimationFrame(this.tick);
  }

  draw() {
    const { ctx, W, H } = this;
    if (!W) return;
    ctx.clearRect(0, 0, W, H);
    for (const s of this.specs) this.ribbon(s);
  }

  ribbon(s) {
    const { ctx, W, H, phase } = this;
    const L = Math.max(0, s.cur) * W;
    if (L < 2) return;
    const step = 3;
    const ph = REDUCED ? 0 : phase;
    const pt = (x) => {
      const u = x / W;
      const yc = s.y * H + s.amp * Math.sin(u * 6.283 * s.freq + ph * 0.9 + s.seed);
      const tw = Math.cos(u * 6.283 * s.twist + ph * 0.55 + s.seed * 1.7);
      return { yc, tw, half: s.thick * (0.1 + 0.9 * Math.abs(tw)) };
    };
    const overX = s.budgetFrac != null ? s.budgetFrac * W : Infinity;
    let a = pt(0);
    for (let x = 0; x < L; x += step) {
      const x1 = Math.min(x + step, L);
      const b = pt(x1);
      const over = x >= overX;
      const t = (a.tw + 1) / 2;                      // 앞면↔뒷면
      const edge = 1 - Math.min(1, Math.abs(a.tw) * 4); // 옆면(얇아질 때) 더 어둡게
      const base = over ? mix(OVER_BACK, OVER_FACE, t) : mix(BACK, FACE, t);
      ctx.fillStyle = base;
      ctx.strokeStyle = base;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.moveTo(x, a.yc - a.half);
      ctx.lineTo(x1, b.yc - b.half);
      ctx.lineTo(x1, b.yc + b.half);
      ctx.lineTo(x, a.yc + a.half);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      if (edge > 0.05) { ctx.fillStyle = `rgba(26,26,26,${0.18 * edge})`; ctx.fill(); }
      a = b;
    }
    // 예산 한도선
    if (s.budgetFrac != null && s.budgetFrac < 1) {
      ctx.fillStyle = 'rgba(26,26,26,.55)';
      ctx.fillRect(Math.round(s.budgetFrac * W), s.y * H - s.thick - s.amp - 4, 1.5, (s.thick + s.amp + 4) * 2);
    }
  }
}

// 숫자 카운트업
export function countUp(el, to, fmt = (n) => Math.round(n).toLocaleString('ko-KR')) {
  const from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  if (REDUCED || from === to) { el.textContent = fmt(to); return; }
  const t0 = performance.now(), dur = 800;
  const step = (now) => {
    if (!el.isConnected) return;
    const p = Math.min(1, (now - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
