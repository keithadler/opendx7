// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// DX7 Envelope visualization — high-DPI aware

function setupHiDPI(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || canvas.width;
  const h = rect.height || canvas.height;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, w, h };
}

export function drawEnvelope(canvas, r1, r2, r3, r4, l1, l2, l3, l4) {
  const { ctx, w, h } = setupHiDPI(canvas);
  const pad = 8;

  // Background
  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  // Grid lines
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  for (let i = 1; i <= 3; i++) {
    const y = pad + (h - 2 * pad) * i / 4;
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(w - pad, y); ctx.stroke();
  }

  const rateToTime = (r) => Math.max(0.02, 1.0 - r / 99.0);
  const levelToY = (l) => pad + (h - 2 * pad) * (1 - l / 99.0);

  const times = [rateToTime(r1), rateToTime(r2), rateToTime(r3), rateToTime(r4)];
  const totalTime = times.reduce((a, b) => a + b, 0);
  const usableW = w - 2 * pad;

  const points = [{ x: pad, y: levelToY(0) }];
  let x = pad;
  const levels = [l1, l2, l3, l4];
  for (let i = 0; i < 4; i++) {
    x += (times[i] / totalTime) * usableW;
    points.push({ x, y: levelToY(levels[i]) });
  }

  // Filled area under curve
  ctx.beginPath();
  ctx.moveTo(points[0].x, h - pad);
  for (const p of points) ctx.lineTo(p.x, p.y);
  ctx.lineTo(points[points.length - 1].x, h - pad);
  ctx.closePath();
  ctx.fillStyle = 'rgba(68, 170, 255, 0.08)';
  ctx.fill();

  // Envelope line
  ctx.strokeStyle = '#4af';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  // Points
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#4af';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }

  // Labels
  ctx.fillStyle = '#556';
  ctx.font = '8px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center';
  const labels = ['', 'L1', 'L2', 'L3', 'L4'];
  for (let i = 1; i < points.length; i++) {
    ctx.fillText(labels[i], points[i].x, h - 1);
  }
}

export function drawPitchEnvelope(canvas, r1, r2, r3, r4, l1, l2, l3, l4) {
  const { ctx, w, h } = setupHiDPI(canvas);
  const pad = 6;

  ctx.fillStyle = '#0a0a0a';
  ctx.fillRect(0, 0, w, h);

  // Center line
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  ctx.beginPath(); ctx.moveTo(pad, h / 2); ctx.lineTo(w - pad, h / 2); ctx.stroke();

  const rateToTime = (r) => Math.max(0.02, 1.0 - r / 99.0);
  const levelToY = (l) => pad + (h - 2 * pad) * (1 - l / 99.0);

  const times = [rateToTime(r1), rateToTime(r2), rateToTime(r3), rateToTime(r4)];
  const totalTime = times.reduce((a, b) => a + b, 0);
  const usableW = w - 2 * pad;

  const points = [{ x: pad, y: levelToY(l4) }];
  let x = pad;
  const levels = [l1, l2, l3, l4];
  for (let i = 0; i < 4; i++) {
    x += (times[i] / totalTime) * usableW;
    points.push({ x, y: levelToY(levels[i]) });
  }

  ctx.strokeStyle = '#f84';
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
  ctx.stroke();

  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#f84';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.fill();
  }
}
