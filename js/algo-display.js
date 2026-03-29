// DX7 Algorithm visualization — draws the 32 algorithm diagrams on canvas

// Algorithm definitions: each is an array of connections
// Format: { carriers: [op indices], connections: [[from, to], ...], feedback: opIdx }
// Operators are numbered 1-6 (display), 0-5 (internal)
const ALGO_DEFS = [
  // 1: 6→5→4→3, 2→1, out=[1,3]
  { ops: [[1,0],[2,1],[3,2],[4,3],[5,4],[6,5]], carriers: [1,3], chains: [[6,5,4,3],[2,1]], fb: 6 },
  // 2: 6→5→4→3, 2→1, out=[1,3], fb=2
  { carriers: [1,3], chains: [[6,5,4,3],[2,1]], fb: 2 },
  // 3: 6→5→4, 3→2→1, out=[1,4], fb=6
  { carriers: [1,4], chains: [[6,5,4],[3,2,1]], fb: 6 },
  // 4: 6→5→4→3→2→1, out=[1], fb=6
  { carriers: [1], chains: [[6,5,4,3,2,1]], fb: 6 },
  // 5: 6→5, 4→3, 2→1, out=[1,3,5], fb=6
  { carriers: [1,3,5], chains: [[6,5],[4,3],[2,1]], fb: 6 },
  // 6: 6→5, 4→3, 2→1, out=[1,3,5], fb=6
  { carriers: [1,3,5], chains: [[6,5],[4,3],[2,1]], fb: 6 },
  // 7: 6→5, 3→(2+4)→1, out=[1], fb=6
  { carriers: [1], chains: [[6,5,4],[3,2,1]], fb: 6, merge: {1: [2,4]} },
  // 8: 4→3→2→1, 6→5, out=[1,5], fb=6 (actually fb=4)
  { carriers: [1,5], chains: [[4,3,2,1],[6,5]], fb: 6 },
  // 9: 6→5→4, 3→2→1, out=[1], fb=6, merge: {1: [2,4]}
  { carriers: [1], chains: [[6,5,4],[3,2,1]], fb: 6 },
  // 10: 3→2→1, 6→5→4, out=[1,4], fb=6
  { carriers: [1,4], chains: [[3,2,1],[6,5,4]], fb: 6 },
  // 11: 6→5→4, 3→2→1, out=[1,4], fb=6
  { carriers: [1,4], chains: [[6,5,4],[3,2,1]], fb: 6 },
  // 12: 6→5→4→3, 2→1, out=[1,3], fb=2
  { carriers: [1,3], chains: [[6,5,4,3],[2,1]], fb: 2 },
  // 13: 6→5→4, 3→2→1, out=[1,4], fb=2
  { carriers: [1,4], chains: [[6,5,4],[3,2,1]], fb: 2 },
  // 14: 6→5→4→3, 2→1, out=[1], fb=6
  { carriers: [1], chains: [[6,5,4,3,2,1]], fb: 6 },
  // 15: 6→5→2→1, 4→3, out=[1,3], fb=6
  { carriers: [1,3], chains: [[6,5,2,1],[4,3]], fb: 6 },
  // 16: 6→5→(3+4)→2→1, out=[1], fb=6
  { carriers: [1], chains: [[6,5,4,3,2,1]], fb: 6 },
  // 17: 6→(5+4)→3→2→1, out=[1], fb=1
  { carriers: [1], chains: [[6,5,4,3,2,1]], fb: 1 },
  // 18: 6→5, 6→4, 3→2→1, out=[1,4,5], fb=6
  { carriers: [1,4,5], chains: [[3,2,1],[6,5],[6,4]], fb: 6 },
  // 19: 6→5, 6→4→3, 2→1, out=[1,3,5], fb=6
  { carriers: [1,3,5], chains: [[2,1],[6,5],[6,4,3]], fb: 6 },
  // 20: 3→2→1, 5→4, 6, out=[1,4,6], fb=3
  { carriers: [1,4,6], chains: [[3,2,1],[5,4],[6]], fb: 3 },
  // 21: 3→2→1, 5→4, 6, out=[1,4,6], fb=6
  { carriers: [1,4,6], chains: [[3,2,1],[5,4],[6]], fb: 6 },
  // 22: 6→5, 4→3, 2→1, out=[1,3,5], fb=6
  { carriers: [1,3,5], chains: [[6,5],[4,3],[2,1]], fb: 6 },
  // 23: 6→5, 6→4, 3, 2→1, out=[1,3,4,5], fb=6
  { carriers: [1,3,4,5], chains: [[6,5],[6,4],[3],[2,1]], fb: 6 },
  // 24: 6→5, 6→4, 6→3, 2→1, out=[1,3,4,5], fb=6
  { carriers: [1,3,4,5], chains: [[6,5],[6,4],[6,3],[2,1]], fb: 6 },
  // 25: 6→5, 4, 3, 2→1, out=[1,3,4,5], fb=6
  { carriers: [1,3,4,5], chains: [[6,5],[4],[3],[2,1]], fb: 6 },
  // 26: 6→5, 3→2, 4, 1, out=[1,2,4,5], fb=6
  { carriers: [1,2,4,5], chains: [[6,5],[3,2],[4],[1]], fb: 6 },
  // 27: 3→2, 6→5, 4, 1, out=[1,2,4,5], fb=6
  { carriers: [1,2,4,5], chains: [[3,2],[6,5],[4],[1]], fb: 6 },
  // 28: 6→5→4, 3, 2→1, out=[1,3,4], fb=6
  { carriers: [1,3,4], chains: [[6,5,4],[3],[2,1]], fb: 6 },
  // 29: 6→5, 4→3, 2, 1, out=[1,2,3,5], fb=6
  { carriers: [1,2,3,5], chains: [[6,5],[4,3],[2],[1]], fb: 6 },
  // 30: 6→5→4, 3, 2, 1, out=[1,2,3,4], fb=6
  { carriers: [1,2,3,4], chains: [[6,5,4],[3],[2],[1]], fb: 6 },
  // 31: 6→5, 4, 3, 2, 1, out=[1,2,3,4,5], fb=6
  { carriers: [1,2,3,4,5], chains: [[6,5],[4],[3],[2],[1]], fb: 6 },
  // 32: all carriers, out=[1,2,3,4,5,6], fb=6
  { carriers: [1,2,3,4,5,6], chains: [[6],[5],[4],[3],[2],[1]], fb: 6 },
];

export function drawAlgorithm(canvas, algoIndex) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const algo = ALGO_DEFS[algoIndex];
  if (!algo) return;

  const boxW = 32;
  const boxH = 22;
  const gapX = 8;
  const gapY = 8;

  // Position operators based on chains
  const positions = {};
  const chains = algo.chains;
  const numChains = chains.length;

  // Layout: chains side by side, operators top to bottom within each chain
  const totalWidth = numChains * (boxW + gapX) - gapX;
  const startX = (w - totalWidth) / 2;

  let maxChainLen = 0;
  for (const chain of chains) {
    maxChainLen = Math.max(maxChainLen, chain.length);
  }

  const totalHeight = maxChainLen * (boxH + gapY) - gapY;
  const startY = (h - totalHeight) / 2 - 5;

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

  // Draw connections
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 2;
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

  // Draw feedback loop
  if (algo.fb) {
    const fbPos = positions[algo.fb];
    if (fbPos) {
      ctx.strokeStyle = '#888';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(fbPos.x + boxW / 2 + 4, fbPos.y, 10, -Math.PI * 0.7, Math.PI * 0.7);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Draw operator boxes
  for (let opNum = 1; opNum <= 6; opNum++) {
    const pos = positions[opNum];
    if (!pos) continue;

    const isCarrier = algo.carriers.includes(opNum);

    // Box
    ctx.fillStyle = isCarrier ? '#333' : '#1a1a1a';
    ctx.strokeStyle = isCarrier ? '#fff' : '#666';
    ctx.lineWidth = isCarrier ? 2 : 1.5;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(pos.x - boxW / 2, pos.y - boxH / 2, boxW, boxH, 4);
    } else {
      ctx.rect(pos.x - boxW / 2, pos.y - boxH / 2, boxW, boxH);
    }
    ctx.fill();
    ctx.stroke();

    // Label
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opNum.toString(), pos.x, pos.y);
  }

  // Draw output line
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  const outY = startY + (maxChainLen - 1) * (boxH + gapY) + boxH / 2 + 10;
  for (const cNum of algo.carriers) {
    const pos = positions[cNum];
    if (pos) {
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y + boxH / 2);
      ctx.lineTo(pos.x, outY);
      ctx.stroke();
    }
  }

  // Output bar
  if (algo.carriers.length > 0) {
    const xs = algo.carriers.map(c => positions[c]?.x).filter(Boolean);
    if (xs.length > 0) {
      const minX = Math.min(...xs) - 5;
      const maxX = Math.max(...xs) + 5;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(minX, outY);
      ctx.lineTo(maxX, outY);
      ctx.stroke();

      // Arrow down
      const midX = (minX + maxX) / 2;
      ctx.beginPath();
      ctx.moveTo(midX, outY);
      ctx.lineTo(midX, outY + 12);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(midX - 4, outY + 8);
      ctx.lineTo(midX, outY + 14);
      ctx.lineTo(midX + 4, outY + 8);
      ctx.fillStyle = '#fff';
      ctx.fill();
    }
  }
}
