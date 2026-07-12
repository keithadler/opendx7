// OpenDX7 — FM Synthesizer (MIT License)
// Copyright (c) 2026 Keith Adler
// DX7 Algorithm visualization — high-DPI aware

// Topology of the 32 DX7 algorithms, derived from the engine's routing table
// (ALGOS in dx7-processor.js). Each chain lists ops top→bottom; consecutive
// entries are modulator→target edges. An op already placed by an earlier chain
// keeps its position, so [[5,4],[6,4]] draws both OP5→OP4 and OP6→OP4.
// fb marks the operator whose box gets the feedback-loop arc.
const ALGO_DEFS = [
  { carriers: [1,3], chains: [[6,5,4,3],[2,1]], fb: 6 },
  { carriers: [1,3], chains: [[6,5,4,3],[2,1]], fb: 2 },
  { carriers: [1,4], chains: [[6,5,4],[3,2,1]], fb: 6 },
  { carriers: [1,4], chains: [[6,5,4],[3,2,1]], fb: 6 },
  { carriers: [1,3,5], chains: [[6,5],[4,3],[2,1]], fb: 6 },
  { carriers: [1,3,5], chains: [[6,5],[4,3],[2,1]], fb: 6 },
  { carriers: [1,3], chains: [[6,5,3],[4,3],[2,1]], fb: 6 },
  { carriers: [1,3], chains: [[6,5,3],[4,3],[2,1]], fb: 4 },
  { carriers: [1,3], chains: [[6,5,3],[4,3],[2,1]], fb: 2 },
  { carriers: [1,4], chains: [[3,2,1],[5,4],[6,4]], fb: 3 },
  { carriers: [1,4], chains: [[3,2,1],[5,4],[6,4]], fb: 6 },
  { carriers: [1,3], chains: [[2,1],[4,3],[5,3],[6,3]], fb: 2 },
  { carriers: [1,3], chains: [[2,1],[4,3],[5,3],[6,3]], fb: 6 },
  { carriers: [1,3], chains: [[2,1],[5,4,3],[6,4]], fb: 6 },
  { carriers: [1,3], chains: [[2,1],[5,4,3],[6,4]], fb: 2 },
  { carriers: [1], chains: [[6,5,1],[4,3,1],[2,1]], fb: 6 },
  { carriers: [1], chains: [[6,5,1],[4,3,1],[2,1]], fb: 2 },
  { carriers: [1], chains: [[6,5,4,1],[3,1],[2,1]], fb: 3 },
  { carriers: [1,4,5], chains: [[3,2,1],[6,5],[6,4]], fb: 6 },
  { carriers: [1,2,4], chains: [[3,1],[3,2],[5,4],[6,4]], fb: 3 },
  { carriers: [1,2,4,5], chains: [[3,1],[3,2],[6,4],[6,5]], fb: 3 },
  { carriers: [1,3,4,5], chains: [[2,1],[6,3],[6,4],[6,5]], fb: 6 },
  { carriers: [1,2,4,5], chains: [[1],[3,2],[6,4],[6,5]], fb: 6 },
  { carriers: [1,2,3,4,5], chains: [[1],[2],[6,3],[6,4],[6,5]], fb: 6 },
  { carriers: [1,2,3,4,5], chains: [[1],[2],[3],[6,4],[6,5]], fb: 6 },
  { carriers: [1,2,4], chains: [[1],[3,2],[5,4],[6,4]], fb: 6 },
  { carriers: [1,2,4], chains: [[1],[3,2],[5,4],[6,4]], fb: 3 },
  { carriers: [1,3,6], chains: [[2,1],[5,4,3],[6]], fb: 5 },
  { carriers: [1,2,3,5], chains: [[1],[2],[4,3],[6,5]], fb: 6 },
  { carriers: [1,2,3,6], chains: [[1],[2],[5,4,3],[6]], fb: 5 },
  { carriers: [1,2,3,4,5], chains: [[1],[2],[3],[4],[6,5]], fb: 6 },
  { carriers: [1,2,3,4,5,6], chains: [[1],[2],[3],[4],[5],[6]], fb: 6 },
];

export function drawAlgorithm(canvas, algoIndex) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 200;
  const h = rect.height || 80;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, w, h);
  const algo = ALGO_DEFS[algoIndex];
  if (!algo) return;

  const boxW = Math.min(28, w / 8);
  const boxH = Math.min(18, h / 5);
  const gapX = boxW * 0.3;
  const gapY = boxH * 0.35;

  const chains = algo.chains;
  const numChains = chains.length;
  let maxLen = 0;
  for (const c of chains) maxLen = Math.max(maxLen, c.length);

  const totalW = numChains * (boxW + gapX) - gapX;
  const totalH = maxLen * (boxH + gapY) - gapY;
  const startX = (w - totalW) / 2;
  const startY = (h - totalH - 14) / 2;

  const positions = {};
  for (let ci = 0; ci < chains.length; ci++) {
    const chain = chains[ci];
    const x = startX + ci * (boxW + gapX);
    for (let oi = 0; oi < chain.length; oi++) {
      const opNum = chain[oi];
      const y = startY + oi * (boxH + gapY);
      if (!positions[opNum]) {
        positions[opNum] = { x: x + boxW / 2, y: y + boxH / 2 };
      }
    }
  }

  // Connections
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 1.5;
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const from = positions[chain[i]];
      const to = positions[chain[i + 1]];
      if (from && to) {
        ctx.beginPath();
        ctx.moveTo(from.x, from.y + boxH / 2);
        ctx.lineTo(to.x, to.y - boxH / 2);
        ctx.stroke();
      }
    }
  }

  // Feedback arc
  if (algo.fb) {
    const p = positions[algo.fb];
    if (p) {
      ctx.strokeStyle = '#666';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.arc(p.x + boxW / 2 + 3, p.y, 7, -Math.PI * 0.7, Math.PI * 0.7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Operator boxes
  for (let op = 1; op <= 6; op++) {
    const p = positions[op];
    if (!p) continue;
    const isCar = algo.carriers.includes(op);

    ctx.fillStyle = isCar ? '#1a2a3a' : '#151515';
    ctx.strokeStyle = isCar ? '#4af' : '#444';
    ctx.lineWidth = isCar ? 1.5 : 1;
    ctx.beginPath();
    const r = 3;
    const x = p.x - boxW / 2, y = p.y - boxH / 2;
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + boxW - r, y); ctx.arcTo(x + boxW, y, x + boxW, y + r, r);
    ctx.lineTo(x + boxW, y + boxH - r); ctx.arcTo(x + boxW, y + boxH, x + boxW - r, y + boxH, r);
    ctx.lineTo(x + r, y + boxH); ctx.arcTo(x, y + boxH, x, y + boxH - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = isCar ? '#fff' : '#888';
    ctx.font = `bold ${Math.round(boxH * 0.55)}px Inter, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(op.toString(), p.x, p.y);
  }

  // Output bar
  const outY = startY + (maxLen - 1) * (boxH + gapY) + boxH / 2 + gapY + 2;
  for (const c of algo.carriers) {
    const p = positions[c];
    if (p) {
      ctx.strokeStyle = '#4af';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + boxH / 2);
      ctx.lineTo(p.x, outY);
      ctx.stroke();
    }
  }

  const xs = algo.carriers.map(c => positions[c]?.x).filter(Boolean);
  if (xs.length > 0) {
    const minX = Math.min(...xs) - 4;
    const maxX = Math.max(...xs) + 4;
    ctx.strokeStyle = '#4af';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(minX, outY);
    ctx.lineTo(maxX, outY);
    ctx.stroke();

    const midX = (minX + maxX) / 2;
    ctx.beginPath();
    ctx.moveTo(midX, outY);
    ctx.lineTo(midX, outY + 8);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(midX - 3, outY + 5);
    ctx.lineTo(midX, outY + 10);
    ctx.lineTo(midX + 3, outY + 5);
    ctx.fillStyle = '#4af';
    ctx.fill();
  }
}
