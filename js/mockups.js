/* Noifla Digital Studio — anteprime di siti disegnate su canvas (concept per settore, nessun cliente reale). */
(function () {
  'use strict';

  const FONT = 'Geist, ui-sans-serif, system-ui, sans-serif';

  const fontsReady = (async () => {
    try {
      await Promise.all([
        document.fonts.load(`500 40px Geist`),
        document.fonts.load(`400 40px Geist`),
      ]);
    } catch (e) { /* si usa il font di sistema */ }
  })();

  /* ---------- helper ---------- */
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const mix = (a, b, t) => {
    const A = hex(a), B = hex(b);
    return `rgb(${A.map((v, i) => Math.round(v + (B[i] - v) * t)).join(',')})`;
  };
  const lum = (h) => { const [r, g, b] = hex(h); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };

  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function text(ctx, str, x, y, size, { weight = 400, color = '#000', align = 'left', track = 0, max } = {}) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    if ('letterSpacing' in ctx) ctx.letterSpacing = `${track * size}px`;
    if (max) {
      let s = size;
      while (ctx.measureText(str).width > max && s > 6) {
        s *= 0.94; ctx.font = `${weight} ${s}px ${FONT}`;
        if ('letterSpacing' in ctx) ctx.letterSpacing = `${track * s}px`;
      }
    }
    ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    ctx.fillText(str, x, y);
    if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
  }
  function seeded(seed) {
    let s = seed >>> 0 || 1;
    return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  }

  /* ---------- illustrazione astratta del settore ---------- */
  function illus(ctx, x, y, w, h, r, s, seed = 1) {
    const p = s.pal, rnd = seeded(seed * 97 + s.id.length * 13);
    ctx.save();
    rr(ctx, x, y, w, h, r); ctx.clip();
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, mix(p.accent, p.bg, 0.15));
    g.addColorStop(1, mix(p.accent2, p.accent, 0.35));
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    const m = Math.min(w, h), cx = x + w * (0.45 + rnd() * 0.2), cy = y + h * (0.5 + rnd() * 0.1);
    ctx.lineWidth = Math.max(1, m * 0.012);
    switch (s.motif) {
      case 'plate':
        ctx.fillStyle = mix(p.card, p.accent, 0.05);
        ctx.beginPath(); ctx.arc(cx, cy, m * 0.36, 0, 7); ctx.fill();
        ctx.strokeStyle = mix(p.accent, p.card, 0.4);
        for (const k of [0.29, 0.2]) { ctx.beginPath(); ctx.arc(cx, cy, m * k, 0, 7); ctx.stroke(); }
        ctx.fillStyle = p.accent2;
        ctx.beginPath(); ctx.arc(cx + m * 0.05, cy - m * 0.04, m * 0.09, 0, 7); ctx.fill();
        break;
      case 'sun':
        ctx.fillStyle = mix(p.accent2, '#ffffff', 0.15);
        ctx.beginPath(); ctx.arc(cx, y + h * 0.48, m * 0.24, 0, 7); ctx.fill();
        for (let i = 0; i < 6; i++) {
          ctx.fillStyle = i % 2 ? mix(p.accent, p.ink, 0.25) : mix(p.accent, p.bg, 0.25);
          ctx.fillRect(x, y + h * (0.58 + i * 0.075), w, h * 0.075);
        }
        break;
      case 'drop':
        for (let i = 0; i < 3; i++) {
          ctx.fillStyle = [p.card, p.accent2, mix(p.accent, p.ink, 0.3)][i];
          ctx.beginPath();
          ctx.ellipse(x + w * (0.3 + i * 0.2), y + h * (0.62 - i * 0.05), m * (0.16 - i * 0.02), m * (0.26 - i * 0.03), 0, 0, 7);
          ctx.fill();
        }
        break;
      case 'arch':
        for (let i = 0; i < 3; i++) {
          const aw = w * 0.22, ax = x + w * 0.14 + i * aw * 1.15, ay = y + h * (0.32 + (i % 2) * 0.1);
          ctx.fillStyle = [p.card, p.accent2, mix(p.accent, p.ink, 0.2)][i];
          ctx.beginPath(); ctx.moveTo(ax, y + h); ctx.lineTo(ax, ay + aw / 2);
          ctx.arc(ax + aw / 2, ay + aw / 2, aw / 2, Math.PI, 0); ctx.lineTo(ax + aw, y + h); ctx.fill();
        }
        break;
      case 'leaf':
        for (let i = 0; i < 5; i++) {
          ctx.save();
          ctx.translate(x + w * (0.2 + i * 0.16), y + h * (0.55 + Math.sin(i * 1.7) * 0.12));
          ctx.rotate(-0.6 + i * 0.32);
          ctx.fillStyle = i % 2 ? mix(p.accent, p.ink, 0.15) : p.accent2;
          ctx.beginPath(); ctx.ellipse(0, 0, m * 0.07, m * 0.22, 0, 0, 7); ctx.fill();
          ctx.restore();
        }
        break;
      case 'stripe':
      default:
        ctx.strokeStyle = mix(p.accent2, p.card, 0.2); ctx.lineWidth = m * 0.07;
        for (let i = -4; i < 10; i++) {
          ctx.beginPath(); ctx.moveTo(x + i * m * 0.2, y + h); ctx.lineTo(x + i * m * 0.2 + h, y); ctx.stroke();
        }
        ctx.fillStyle = mix(p.card, p.bg, 0.2);
        ctx.beginPath(); ctx.arc(cx, cy, m * 0.2, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  /* ---------- desktop ---------- */
  function drawDesktop(ctx, W, H, s, { chrome = true, variant = 0 } = {}) {
    const p = s.pal, u = W / 100, dark = lum(p.bg) < 0.45;
    const soft = mix(p.ink, p.bg, 0.55);
    ctx.fillStyle = p.bg; ctx.fillRect(0, 0, W, H);
    let t = 0;
    if (chrome) {
      t = 5 * u;
      ctx.fillStyle = dark ? mix(p.bg, '#000000', 0.35) : mix(p.bg, '#000000', 0.06);
      ctx.fillRect(0, 0, W, t);
      ['#ff5f57', '#febc2e', '#28c840'].forEach((c, i) => {
        ctx.fillStyle = c; ctx.beginPath(); ctx.arc(2.6 * u + i * 2 * u, t / 2, 0.6 * u, 0, 7); ctx.fill();
      });
      ctx.fillStyle = dark ? mix(p.bg, '#ffffff', 0.08) : '#ffffff';
      rr(ctx, 35 * u, 1.2 * u, 30 * u, 2.6 * u, 1.3 * u); ctx.fill();
      text(ctx, s.url, 50 * u, 3 * u, 1.3 * u, { color: soft, align: 'center' });
    }
    // nav
    const ny = t + 5 * u;
    text(ctx, s.name, 5 * u, ny, 2.1 * u, { weight: 500, color: p.ink, track: -0.02 });
    ctx.font = `500 ${1.4 * u}px ${FONT}`;
    const cw = ctx.measureText(s.cta).width + 3.6 * u;
    ctx.font = `400 ${1.4 * u}px ${FONT}`;
    const lw = s.links.map((l) => ctx.measureText(l).width);
    let lx = 95 * u - cw - 3 * u - lw.reduce((a, b) => a + b, 0) - 2.6 * u * (s.links.length - 1);
    s.links.forEach((l, i) => { text(ctx, l, lx, ny, 1.4 * u, { color: soft }); lx += lw[i] + 2.6 * u; });
    ctx.fillStyle = p.accent; rr(ctx, 95 * u - cw, ny - 2.4 * u, cw, 3.6 * u, 1.8 * u); ctx.fill();
    text(ctx, s.cta, 95 * u - cw / 2, ny - 0.1 * u, 1.4 * u, { weight: 500, color: lum(p.accent) > 0.6 ? p.ink : '#ffffff', align: 'center' });

    const top = t + 10 * u, heroH = 38 * u;
    const btn = (x, y, label, solid, align = 'left') => {
      ctx.font = `500 ${1.5 * u}px ${FONT}`;
      const bw = ctx.measureText(label).width + 4 * u;
      const bx = align === 'center' ? x - bw / 2 : x;
      ctx.fillStyle = solid ? p.ink : 'transparent';
      ctx.strokeStyle = p.ink; ctx.lineWidth = Math.max(1, 0.15 * u);
      rr(ctx, bx, y, bw, 4.4 * u, 2.2 * u); solid ? ctx.fill() : ctx.stroke();
      text(ctx, label, bx + bw / 2, y + 2.85 * u, 1.5 * u, { weight: 500, color: solid ? p.bg : p.ink, align: 'center' });
      return bw;
    };
    const bars = (x, y, w, align = 'left') => {
      ctx.fillStyle = mix(p.ink, p.bg, 0.78);
      [1, 0.72].forEach((k, i) => {
        const bw = w * k, bx = align === 'center' ? x - bw / 2 : x;
        rr(ctx, bx, y + i * 2.2 * u, bw, 1 * u, 0.5 * u); ctx.fill();
      });
    };

    if (variant === 1) {
      illus(ctx, 5 * u, top, 90 * u, heroH, 1.6 * u, s, 3);
      const g = ctx.createLinearGradient(0, top + heroH * 0.35, 0, top + heroH);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.45)');
      ctx.fillStyle = g; rr(ctx, 5 * u, top, 90 * u, heroH, 1.6 * u); ctx.fill();
      s.headline.forEach((l, i) => text(ctx, l, 9 * u, top + heroH - 10.5 * u + i * 6.2 * u, 5.6 * u, { weight: 500, color: '#ffffff', track: -0.035 }));
    } else if (variant === 2) {
      s.headline.forEach((l, i) => text(ctx, l, 50 * u, top + 7 * u + i * 6.4 * u, 5.8 * u, { weight: 500, color: p.ink, align: 'center', track: -0.035 }));
      bars(50 * u, top + 16.5 * u, 30 * u, 'center');
      [0, 1, 2].forEach((i) => illus(ctx, (5 + i * 30.66) * u, top + 23 * u, 29 * u, 15 * u, 1.2 * u, s, i + 2));
    } else {
      s.headline.forEach((l, i) => text(ctx, l, 5 * u, top + 9 * u + i * 6.2 * u, 5.6 * u, { weight: 500, color: p.ink, track: -0.035, max: 44 * u }));
      bars(5 * u, top + 19 * u, 34 * u);
      const bw = btn(5 * u, top + 26 * u, s.cta, true);
      btn(5 * u + bw + 1.2 * u, top + 26 * u, s.links[0], false);
      illus(ctx, 52 * u, top, 43 * u, heroH, 1.6 * u, s, 1);
    }

    // card in basso
    const cy = top + heroH + 4 * u, ch = Math.max(8 * u, H - cy - 4 * u);
    s.items.forEach(([name, price], i) => {
      const x = (5 + i * 30.66) * u, w = 29 * u;
      ctx.fillStyle = p.card; rr(ctx, x, cy, w, ch, 1.2 * u); ctx.fill();
      ctx.strokeStyle = mix(p.ink, p.bg, 0.88); ctx.lineWidth = Math.max(1, 0.1 * u); ctx.stroke();
      text(ctx, name, x + 2 * u, cy + 3.6 * u, 1.6 * u, { weight: 500, color: p.ink, max: w - 4 * u });
      if (price) text(ctx, price, x + 2 * u, cy + 6.2 * u, 1.4 * u, { weight: 500, color: p.accent });
    });
  }

  /* ---------- telefono ---------- */
  function drawPhone(ctx, X, Y, W, H, s) {
    const p = s.pal, u = W / 100, soft = mix(p.ink, p.bg, 0.55);
    ctx.save();
    ctx.fillStyle = '#0b0f17';
    rr(ctx, X, Y, W, H, 14 * u); ctx.fill();
    const ix = X + 3.5 * u, iy = Y + 3.5 * u, iw = W - 7 * u, ih = H - 7 * u;
    rr(ctx, ix, iy, iw, ih, 11 * u); ctx.clip();
    ctx.fillStyle = p.bg; ctx.fillRect(ix, iy, iw, ih);
    const L = ix + 6 * u, R = ix + iw - 6 * u, cw = R - L;
    text(ctx, '9:41', L, iy + 8 * u, 4 * u, { weight: 500, color: p.ink });
    ctx.fillStyle = '#0b0f17'; rr(ctx, ix + iw / 2 - 14 * u, iy + 3 * u, 28 * u, 7 * u, 3.5 * u); ctx.fill();
    text(ctx, s.name, L, iy + 21 * u, 5.4 * u, { weight: 500, color: p.ink, track: -0.02, max: cw * 0.6 });
    ctx.fillStyle = p.ink;
    [0, 1].forEach((k) => ctx.fillRect(R - 7 * u, iy + 17 * u + k * 3 * u, 7 * u, 0.9 * u));
    const imgY = iy + 27 * u, imgH = ih * 0.36;
    illus(ctx, L, imgY, cw, imgH, 5 * u, s, 5);
    let y = imgY + imgH + 13 * u;
    s.headline.forEach((l, i) => text(ctx, l, L, y + i * 9.6 * u, 8.6 * u, { weight: 500, color: p.ink, track: -0.035, max: cw }));
    y += 2 * 9.6 * u + 1 * u;
    ctx.fillStyle = p.accent; rr(ctx, L, y, cw, 13 * u, 6.5 * u); ctx.fill();
    text(ctx, s.cta, L + cw / 2, y + 8.4 * u, 4.4 * u, { weight: 500, color: lum(p.accent) > 0.6 ? p.ink : '#ffffff', align: 'center' });
    y += 20 * u;
    s.items.slice(0, 3).forEach(([name, price], i) => {
      const ry = y + i * 11 * u;
      if (ry > iy + ih - 6 * u) return;
      ctx.fillStyle = mix(p.ink, p.bg, 0.88); ctx.fillRect(L, ry, cw, Math.max(1, 0.3 * u));
      text(ctx, name, L, ry + 7.5 * u, 4 * u, { color: p.ink, max: cw * 0.65 });
      if (price) text(ctx, price, R, ry + 7.5 * u, 4 * u, { weight: 500, color: soft, align: 'right' });
    });
    ctx.restore();
  }

  /* ---------- API ---------- */
  // kind: 'desktop' (4:3, con barra del browser) · 'phone' (1:2) · 'feature' (3:2, a tutto schermo) · 'poster' (4:5)
  const ASPECT = { desktop: 4 / 3, phone: 0.5, feature: 1.5, poster: 0.8 };

  function drawMockup(s, kind = 'desktop', width = 640, variant = 0) {
    const W = Math.round(width), H = Math.round(width / ASPECT[kind]);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    if (kind === 'phone') {
      drawPhone(ctx, 0, 0, W, H, s);
    } else if (kind === 'poster') {
      const g = ctx.createLinearGradient(0, 0, W, H);
      g.addColorStop(0, mix(s.pal.accent, s.pal.bg, 0.55));
      g.addColorStop(1, mix(s.pal.accent2, s.pal.bg, 0.4));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      const ph = H * 0.84, pw = ph * 0.5;
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = W * 0.06; ctx.shadowOffsetY = W * 0.03;
      drawPhone(ctx, (W - pw) / 2, (H - ph) / 2 + H * 0.02, pw, ph, s);
    } else if (kind === 'feature') {
      // margine di sicurezza: a tutto schermo i bordi vengono tagliati in base al formato dello schermo
      ctx.fillStyle = s.pal.bg; ctx.fillRect(0, 0, W, H);
      const k = 0.76;
      ctx.save();
      ctx.translate(W * (1 - k) / 2, H * 0.15);
      ctx.scale(k, k);
      drawDesktop(ctx, W, H, s, { chrome: false, variant });
      ctx.restore();
    } else {
      drawDesktop(ctx, W, H, s, { chrome: true, variant });
    }
    return c;
  }

  const urlCache = new Map();
  function mockupURL(s, kind = 'poster', width = 480, variant = 0) {
    const key = `${s.id}:${kind}:${width}:${variant}`;
    if (!urlCache.has(key)) {
      urlCache.set(key, fontsReady.then(() => new Promise((res) => {
        drawMockup(s, kind, width, variant).toBlob((b) => res(URL.createObjectURL(b)), 'image/webp', 0.86);
      })));
    }
    return urlCache.get(key);
  }

  window.NOIFLA = window.NOIFLA || {};
  window.NOIFLA.mockups = { drawMockup: drawMockup, mockupURL: mockupURL, fontsReady: fontsReady, ASPECT: ASPECT, mix: mix };
})();
