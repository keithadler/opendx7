// DX7 Envelope visualization

const TWO_PI = Math.PI * 2;

export function drawEnvelope(canvas, r1, r2, r3, r4, l1, l2, l3, l4) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const pad = 10;

  ctx.clearRect(0, 0, w, h);

  // Background grid
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 4; i++) {
    const y = pad + (h - 2 * pad) * i / 4;
    ctx.beginPath();
    ctx.moveTo(pad, y);
    ctx.lineTo(w - pad, y);
    ctx.stroke();
  }

  // Convert rates to time segments (higher rate = shorter time)
  const rateToTime = (r) => 1.0 - r / 99.0;
  const levelToY = (l) => pad + (h - 2 * pad) * (1 - l / 99.0);

  const times = [rateToTime(r1), rateToTime(r2), rateToTime(r3), rateToTime(r4)];
  const totalTime = times.reduce((a, b) => a + b, 0) || 1;
  const usableW = w - 2 * pad;

  // Starting point (L4 of previous note, assume 0)
  const points = [{ x: pad, y: levelToY(0) }];

  let x = pad;
  const levels = [l1, l2, l3, l4];
  for (let i = 0; i < 4; i++) {
    x += (times[i] / totalTime) * usableW;
    points.push({ x, y: levelToY(levels[i]) });
  }

  // Draw envelope
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  // Draw points
  ctx.fillStyle = '#fff';
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 3, 0, TWO_PI);
    ctx.fill();
  }

  // Labels
  ctx.fillStyle = '#666';
  ctx.font = '8px monospace';
  ctx.textAlign = 'center';
  const labels = ['L4', 'L1', 'L2', 'L3', 'L4'];
  for (let i = 0; i < points.length; i++) {
    ctx.fillText(labels[i], points[i].x, h - 2);
  }
}

export function drawPitchEnvelope(canvas, r1, r2, r3, r4, l1, l2, l3, l4) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const pad = 8;

  ctx.clearRect(0, 0, w, h);

  // Center line
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(pad, h / 2);
  ctx.lineTo(w - pad, h / 2);
  ctx.stroke();

  const rateToTime = (r) => 1.0 - r / 99.0;
  const levelToY = (l) => pad + (h - 2 * pad) * (1 - l / 99.0);

  const times = [rateToTime(r1), rateToTime(r2), rateToTime(r3), rateToTime(r4)];
  const totalTime = times.reduce((a, b) => a + b, 0) || 1;
  const usableW = w - 2 * pad;

  const points = [{ x: pad, y: levelToY(l4) }]; // Start from L4
  let x = pad;
  const levels = [l1, l2, l3, l4];
  for (let i = 0; i < 4; i++) {
    x += (times[i] / totalTime) * usableW;
    points.push({ x, y: levelToY(levels[i]) });
  }

  ctx.strokeStyle = '#aaa';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();

  ctx.fillStyle = '#fff';
  for (const p of points) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2, 0, TWO_PI);
    ctx.fill();
  }
}
