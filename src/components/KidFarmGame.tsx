import { useEffect, useRef, useState, useCallback } from "react";

// ============ TYPES ============
type FieldState = 0 | 1 | 2 | 3 | 4 | 5 | 6; // EMPTY..READY
const EMPTY = 0, PREPARED = 1, PLANTED = 2, G1 = 3, G2 = 4, G3 = 5, READY = 6;

type TaskKind = "prepare" | "plant" | "harvest" | "deliver";
interface Task { kind: TaskKind; tx: number; ty: number; }
interface Worker {
  id: number; name: string;
  x: number; y: number;          // pixel position
  tx: number; ty: number;        // target tile
  task: Task | null;
  queue: Task[];
  facing: "down" | "up" | "left" | "right";
  workTimer: number;             // ms remaining for current task action
  walkPhase: number;
  hair: string; shirt: string;   // colors for sprite variety
}

interface Field {
  state: FieldState;
  growth: number; // ms accumulated in growing states
}

// ============ CONSTANTS ============
const TILE = 32;                 // logical pixel size per tile (will scale)
const MAP_W = 22;
const MAP_H = 16;
const FIELD_AREA = { x0: 3, y0: 5, x1: 12, y1: 12 }; // inclusive tiles that are farmland
const SHIPPING_BIN = { x: 16, y: 11 };
const FARMHOUSE = { x: 16, y: 4, w: 4, h: 3 };
const BARN = { x: 14, y: 8, w: 3, h: 3 };
const COOP = { x: 17, y: 8, w: 3, h: 2 };
const WELL = { x: 13, y: 6 };
const TOOLSHED = { x: 2, y: 3, w: 2, h: 2 };

const WHEAT = { seedCost: 2, yield: 4, price: 3, growMs: 18000 }; // 18s total
const DAY_MS = 90_000; // 90s = one day
const DAILY_COST = 8;
const HIRE_COST_BASE = 50;
const SEED_COST = WHEAT.seedCost;

const COLORS = {
  sky: "#a9d8ef",
  grass: "#7ec84a",
  grassDark: "#5fa934",
  grassLight: "#9ee062",
  path: "#c9a36a",
  pathDark: "#9a7846",
  soilDry: "#6b4a2b",
  soil: "#5a3a20",
  soilWet: "#3e2814",
  wood: "#7a4a25",
  woodDark: "#4a2a12",
  woodLight: "#a87340",
  roof: "#b8442e",
  roofDark: "#7a2818",
  roofLight: "#e0633d",
  stone: "#8a8a92",
  stoneDark: "#5a5a62",
  water: "#4a8cd6",
  waterLight: "#7ab8f0",
  wheatStalk: "#e3b94a",
  wheatLight: "#fcdc70",
  leaf: "#3fa83f",
  leafDark: "#2a7a2a",
  skin: "#f6c79a",
  hairBlonde: "#f0d36a",
  hairBrown: "#5a3318",
  hairBlack: "#1d1416",
  shirtRed: "#c84a3a",
  shirtBlue: "#3a78c8",
  shirtGreen: "#3aa860",
  jeans: "#2a3e72",
  hatBrown: "#7a4a2a",
  shadow: "rgba(0,0,0,0.25)",
  white: "#fdf6e3",
  black: "#1a1410",
};

// ============ PIXEL DRAW HELPERS ============
function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function drawGrassTile(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number) {
  px(ctx, x, y, TILE, TILE, COLORS.grass);
  // a couple of grass tufts based on seed
  const a = (seed * 9301 + 49297) % 233280;
  const r1 = (a >> 2) % TILE;
  const r2 = (a >> 5) % TILE;
  px(ctx, x + r1, y + r2, 2, 2, COLORS.grassDark);
  px(ctx, x + ((r1 + 11) % TILE), y + ((r2 + 7) % TILE), 2, 1, COLORS.grassLight);
  px(ctx, x + ((r1 + 19) % TILE), y + ((r2 + 17) % TILE), 1, 2, COLORS.grassDark);
}

function drawSoilTile(ctx: CanvasRenderingContext2D, x: number, y: number, prepared: boolean) {
  const base = prepared ? COLORS.soilWet : COLORS.soilDry;
  px(ctx, x, y, TILE, TILE, base);
  // furrow rows
  for (let i = 4; i < TILE; i += 8) {
    px(ctx, x + 2, y + i, TILE - 4, 1, COLORS.soil);
    px(ctx, x + 2, y + i + 2, TILE - 4, 1, prepared ? COLORS.soilDry : COLORS.soilWet);
  }
  // border
  px(ctx, x, y, TILE, 1, COLORS.black);
  px(ctx, x, y + TILE - 1, TILE, 1, COLORS.black);
}

function drawWheat(ctx: CanvasRenderingContext2D, x: number, y: number, stage: FieldState) {
  drawSoilTile(ctx, x, y, true);
  if (stage === PLANTED) {
    // seeds
    for (let i = 0; i < 4; i++) {
      px(ctx, x + 6 + i * 6, y + 22, 2, 2, COLORS.wheatStalk);
    }
    return;
  }
  if (stage === G1) {
    for (let i = 0; i < 4; i++) {
      px(ctx, x + 6 + i * 6, y + 18, 1, 6, COLORS.leaf);
    }
    return;
  }
  if (stage === G2) {
    for (let i = 0; i < 4; i++) {
      px(ctx, x + 6 + i * 6, y + 12, 1, 12, COLORS.leafDark);
      px(ctx, x + 5 + i * 6, y + 14, 3, 2, COLORS.leaf);
    }
    return;
  }
  if (stage === G3) {
    for (let i = 0; i < 4; i++) {
      px(ctx, x + 6 + i * 6, y + 8, 1, 16, COLORS.wheatStalk);
      px(ctx, x + 5 + i * 6, y + 10, 3, 3, COLORS.wheatLight);
    }
    return;
  }
  if (stage === READY) {
    for (let i = 0; i < 4; i++) {
      px(ctx, x + 6 + i * 6, y + 6, 1, 18, COLORS.wheatStalk);
      px(ctx, x + 4 + i * 6, y + 6, 5, 6, COLORS.wheatLight);
      px(ctx, x + 5 + i * 6, y + 7, 3, 1, COLORS.wheatStalk);
    }
  }
}

function drawHouse(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = FARMHOUSE.w * TILE, h = FARMHOUSE.h * TILE;
  // body
  px(ctx, x + 4, y + h / 2, w - 8, h / 2 - 2, COLORS.woodLight);
  px(ctx, x + 4, y + h / 2, w - 8, 3, COLORS.wood);
  px(ctx, x + 4, y + h - 3, w - 8, 3, COLORS.woodDark);
  // planks
  for (let i = (h / 2) + 6; i < h - 4; i += 6) {
    px(ctx, x + 6, y + i, w - 12, 1, COLORS.woodDark);
  }
  // roof (triangle)
  const roofH = h / 2;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor((r / roofH) * (w / 2 - 2));
    px(ctx, x + inset, y + r, w - inset * 2, 1, COLORS.roof);
  }
  // roof shadow
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor((r / roofH) * (w / 2 - 2));
    px(ctx, x + inset, y + r, 3, 1, COLORS.roofDark);
    px(ctx, x + w - inset - 3, y + r, 3, 1, COLORS.roofLight);
  }
  // door
  const dx = x + w / 2 - 6, dy = y + h - 18;
  px(ctx, dx, dy, 12, 16, COLORS.woodDark);
  px(ctx, dx + 1, dy + 1, 10, 14, COLORS.wood);
  px(ctx, dx + 9, dy + 8, 1, 2, "#f5c530");
  // window
  px(ctx, x + 8, y + h / 2 + 8, 10, 10, COLORS.sky);
  px(ctx, x + 8, y + h / 2 + 8, 10, 10, COLORS.sky);
  px(ctx, x + 12, y + h / 2 + 8, 2, 10, COLORS.wood);
  px(ctx, x + 8, y + h / 2 + 12, 10, 2, COLORS.wood);
  px(ctx, x + 8, y + h / 2 + 8, 10, 1, COLORS.woodDark);
  px(ctx, x + 8, y + h / 2 + 17, 10, 1, COLORS.woodDark);

  px(ctx, x + w - 18, y + h / 2 + 8, 10, 10, COLORS.sky);
  px(ctx, x + w - 14, y + h / 2 + 8, 2, 10, COLORS.wood);
  px(ctx, x + w - 18, y + h / 2 + 12, 10, 2, COLORS.wood);
}

function drawBarn(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = BARN.w * TILE, h = BARN.h * TILE;
  // body red
  px(ctx, x + 4, y + h / 3, w - 8, (2 * h) / 3 - 2, COLORS.roof);
  px(ctx, x + 4, y + h - 3, w - 8, 3, COLORS.roofDark);
  // plank cross "X"
  px(ctx, x + w / 2 - 8, y + h / 3 + 8, 16, 2, COLORS.white);
  px(ctx, x + w / 2 - 8, y + h - 16, 16, 2, COLORS.white);
  for (let i = 0; i < 14; i++) {
    px(ctx, x + w / 2 - 7 + i, y + h / 3 + 10 + i, 2, 2, COLORS.white);
    px(ctx, x + w / 2 + 7 - i, y + h / 3 + 10 + i, 2, 2, COLORS.white);
  }
  // roof
  const roofH = h / 3;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor((r / roofH) * (w / 2 - 2));
    px(ctx, x + inset, y + r, w - inset * 2, 1, COLORS.roofDark);
  }
  // doors
  const dx = x + w / 2 - 10, dy = y + h - 22;
  px(ctx, dx, dy, 20, 22, COLORS.woodDark);
  px(ctx, dx + 9, dy, 2, 22, COLORS.roofDark);
}

function drawCoop(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = COOP.w * TILE, h = COOP.h * TILE;
  px(ctx, x + 4, y + h / 2, w - 8, h / 2 - 2, COLORS.woodLight);
  px(ctx, x + 4, y + h - 3, w - 8, 3, COLORS.woodDark);
  // roof
  const roofH = h / 2;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor((r / roofH) * (w / 2 - 2));
    px(ctx, x + inset, y + r, w - inset * 2, 1, COLORS.roof);
  }
  // little opening
  px(ctx, x + w / 2 - 4, y + h - 14, 8, 12, COLORS.black);
  px(ctx, x + w / 2 - 3, y + h - 12, 6, 4, COLORS.shirtRed);
}

function drawShed(ctx: CanvasRenderingContext2D, x: number, y: number) {
  const w = TOOLSHED.w * TILE, h = TOOLSHED.h * TILE;
  px(ctx, x + 3, y + h / 3, w - 6, (2 * h) / 3 - 3, COLORS.wood);
  px(ctx, x + 3, y + h - 3, w - 6, 3, COLORS.woodDark);
  const roofH = h / 3;
  for (let r = 0; r < roofH; r++) {
    const inset = Math.floor((r / roofH) * (w / 2 - 2));
    px(ctx, x + inset, y + r, w - inset * 2, 1, COLORS.stoneDark);
  }
  px(ctx, x + w / 2 - 4, y + h - 14, 8, 12, COLORS.woodDark);
}

function drawWell(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // base stones
  px(ctx, x + 6, y + 14, TILE - 12, 14, COLORS.stoneDark);
  px(ctx, x + 8, y + 14, TILE - 16, 12, COLORS.stone);
  px(ctx, x + 10, y + 16, TILE - 20, 8, COLORS.water);
  px(ctx, x + 11, y + 17, TILE - 22, 1, COLORS.waterLight);
  // posts + roof
  px(ctx, x + 7, y + 2, 2, 14, COLORS.wood);
  px(ctx, x + TILE - 9, y + 2, 2, 14, COLORS.wood);
  for (let r = 0; r < 6; r++) {
    px(ctx, x + 4 + r, y + 2 + r, TILE - 8 - r * 2, 1, COLORS.roof);
  }
}

function drawShippingBin(ctx: CanvasRenderingContext2D, x: number, y: number) {
  px(ctx, x + 2, y + 8, TILE - 4, TILE - 12, COLORS.woodLight);
  px(ctx, x + 2, y + 8, TILE - 4, 3, COLORS.woodDark);
  px(ctx, x + 2, y + TILE - 6, TILE - 4, 3, COLORS.woodDark);
  for (let i = 12; i < TILE - 8; i += 4) {
    px(ctx, x + 2, y + i, TILE - 4, 1, COLORS.wood);
  }
  // sign
  px(ctx, x + 6, y + 2, TILE - 12, 8, COLORS.white);
  px(ctx, x + 6, y + 2, TILE - 12, 1, COLORS.black);
  px(ctx, x + 6, y + 9, TILE - 12, 1, COLORS.black);
  px(ctx, x + 9, y + 4, 2, 4, COLORS.black);
  px(ctx, x + 12, y + 4, 2, 4, COLORS.black);
  px(ctx, x + 15, y + 4, 2, 4, COLORS.black);
  px(ctx, x + 18, y + 4, 2, 4, COLORS.black);
}

function drawWorker(ctx: CanvasRenderingContext2D, w: Worker) {
  const x = w.x | 0, y = w.y | 0;
  // shadow
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 8, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  const bob = w.task || (w.tx * TILE + TILE / 2 !== w.x || w.ty * TILE + TILE / 2 !== w.y)
    ? Math.floor(w.walkPhase) % 2 : 0;
  const top = y - 20 - bob;
  // legs (jeans)
  px(ctx, x - 4, top + 14, 3, 6, COLORS.jeans);
  px(ctx, x + 1, top + 14, 3, 6, COLORS.jeans);
  px(ctx, x - 4, top + 19, 3, 1, COLORS.black);
  px(ctx, x + 1, top + 19, 3, 1, COLORS.black);
  // shirt
  px(ctx, x - 5, top + 7, 10, 8, w.shirt);
  // plaid lines if red
  if (w.shirt === COLORS.shirtRed) {
    px(ctx, x - 5, top + 9, 10, 1, COLORS.roofDark);
    px(ctx, x - 5, top + 12, 10, 1, COLORS.roofDark);
    px(ctx, x - 2, top + 7, 1, 8, COLORS.roofDark);
    px(ctx, x + 2, top + 7, 1, 8, COLORS.roofDark);
  }
  // arms
  px(ctx, x - 6, top + 8, 2, 6, w.shirt);
  px(ctx, x + 5, top + 8, 2, 6, w.shirt);
  px(ctx, x - 6, top + 13, 2, 2, COLORS.skin);
  px(ctx, x + 5, top + 13, 2, 2, COLORS.skin);
  // head
  px(ctx, x - 4, top + 1, 8, 7, COLORS.skin);
  // hair back (ponytail)
  px(ctx, x - 5, top + 0, 10, 4, w.hair);
  px(ctx, x - 5, top + 3, 2, 3, w.hair);
  px(ctx, x + 4, top + 3, 2, 3, w.hair);
  // ponytail back
  px(ctx, x + 5, top + 4, 2, 5, w.hair);
  // hat (cowgirl brown)
  px(ctx, x - 6, top + 2, 12, 2, COLORS.hatBrown);   // brim
  px(ctx, x - 3, top - 1, 6, 3, COLORS.hatBrown);    // crown
  px(ctx, x - 3, top + 0, 6, 1, COLORS.woodDark);
  // eyes (face down by default)
  if (w.facing === "up") {
    // back of head, no eyes
  } else {
    const ex1 = w.facing === "left" ? x - 3 : x - 2;
    const ex2 = w.facing === "right" ? x + 2 : x + 1;
    px(ctx, ex1, top + 5, 1, 1, COLORS.black);
    px(ctx, ex2, top + 5, 1, 1, COLORS.black);
    px(ctx, x - 1, top + 7, 2, 1, COLORS.shirtRed);
  }
}

// ============ COMPONENT ============
export default function KidFarmGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // mutable game state lives in a ref so the render loop is stable
  const stateRef = useRef({
    coins: 25,
    seeds: 5,
    harvested: 0,    // wheat units in hand, ready for shipping bin
    revenue: 0,
    expenses: 0,
    dayMs: 0,
    day: 1,
    fields: createFields(),
    workers: [
      makeWorker(1, "Maya", 10 * TILE + TILE / 2, 4 * TILE + TILE / 2, COLORS.hairBlonde, COLORS.shirtRed),
    ] as Worker[],
    camera: { x: 0, y: 0, follow: null as Worker | null, freeX: 0, freeY: 0 },
    cssScale: 2,
    viewportW: 800,
    viewportH: 600,
    keys: new Set<string>(),
    pointer: { x: 0, y: 0, downAt: 0 as number | null, dragging: false, startX: 0, startY: 0, startCamX: 0, startCamY: 0 },
    selectedTool: "auto" as "auto" | "prepare" | "plant" | "harvest",
    lastTime: performance.now(),
    floaters: [] as { x: number; y: number; text: string; color: string; age: number }[],
  });

  // ui state mirrors what we want to render in React
  const [ui, setUi] = useState({
    coins: 25, seeds: 5, harvested: 0, revenue: 0, expenses: 0, day: 1, time: "06:00",
    workers: 1, tool: "auto" as "auto" | "prepare" | "plant" | "harvest",
    message: "Click your soil to prepare it. Then plant. Then harvest!",
  });

  // ---------- helpers ----------
  function inField(tx: number, ty: number) {
    return tx >= FIELD_AREA.x0 && tx <= FIELD_AREA.x1 && ty >= FIELD_AREA.y0 && ty <= FIELD_AREA.y1;
  }
  function fieldIdx(tx: number, ty: number) {
    return (ty - FIELD_AREA.y0) * (FIELD_AREA.x1 - FIELD_AREA.x0 + 1) + (tx - FIELD_AREA.x0);
  }

  const setMessage = useCallback((m: string) => {
    setUi(u => (u.message === m ? u : { ...u, message: m }));
  }, []);

  const addFloater = (x: number, y: number, text: string, color: string) => {
    stateRef.current.floaters.push({ x, y, text, color, age: 0 });
  };

  // ---------- click → assign task ----------
  const handleTileClick = useCallback((tx: number, ty: number) => {
    const s = stateRef.current;
    if (!inField(tx, ty)) {
      // shipping bin?
      if (tx === SHIPPING_BIN.x && ty === SHIPPING_BIN.y) {
        if (s.harvested <= 0) {
          setMessage("No harvested wheat to ship.");
          return;
        }
        assignTask(s, { kind: "deliver", tx, ty });
        setMessage("Worker delivering wheat to the shipping bin.");
        return;
      }
      setMessage("Click on your soil tiles or the shipping bin.");
      return;
    }
    const i = fieldIdx(tx, ty);
    const f = s.fields[i];
    let kind: TaskKind | null = null;
    if (f.state === EMPTY) kind = "prepare";
    else if (f.state === PREPARED) {
      if (s.seeds <= 0) { setMessage("Out of seeds! Buy more (2 coins each)."); return; }
      kind = "plant";
    } else if (f.state === READY) kind = "harvest";
    else { setMessage("This crop is still growing."); return; }
    assignTask(s, { kind, tx, ty });
  }, [setMessage]);

  function assignTask(s: typeof stateRef.current, task: Task) {
    // pick the worker with the smallest queue
    let best = s.workers[0];
    for (const w of s.workers) if (w.queue.length + (w.task ? 1 : 0) < best.queue.length + (best.task ? 1 : 0)) best = w;
    best.queue.push(task);
  }

  // ---------- main loop ----------
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const s = stateRef.current;
      const dt = Math.min(50, now - s.lastTime);
      s.lastTime = now;
      update(dt);
      draw();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update(dt: number) {
    const s = stateRef.current;
    // day progress
    s.dayMs += dt;
    if (s.dayMs >= DAY_MS) {
      s.dayMs -= DAY_MS;
      s.day += 1;
      s.coins -= DAILY_COST;
      s.expenses += DAILY_COST;
      addFloater(SHIPPING_BIN.x * TILE + TILE / 2, SHIPPING_BIN.y * TILE - 10, `-${DAILY_COST}c daily`, "#c84a3a");
    }

    // crops growth
    for (const f of s.fields) {
      if (f.state >= PLANTED && f.state < READY) {
        f.growth += dt;
        const step = WHEAT.growMs / 4;
        const target = Math.min(READY, PLANTED + Math.floor(f.growth / step)) as FieldState;
        if (target > f.state) f.state = target;
      }
    }

    // workers
    for (const w of s.workers) {
      if (!w.task && w.queue.length > 0) w.task = w.queue.shift()!;
      if (!w.task) continue;

      const cx = w.task.tx * TILE + TILE / 2;
      const cy = w.task.ty * TILE + TILE / 2;
      // walk near tile (one tile below it visually for fields, on tile for bin)
      const tcx = cx;
      const tcy = cy;
      const dx = tcx - w.x, dy = tcy - w.y;
      const dist = Math.hypot(dx, dy);
      const speed = 0.08; // px per ms ~80px/s
      if (dist > 2) {
        const mv = Math.min(dist, speed * dt);
        w.x += (dx / dist) * mv;
        w.y += (dy / dist) * mv;
        w.walkPhase += dt * 0.012;
        w.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
        // camera follow
        s.camera.follow = w;
      } else {
        // perform work
        if (w.workTimer === 0) w.workTimer = 800; // 0.8s per action
        w.workTimer -= dt;
        if (w.workTimer <= 0) {
          completeTask(s, w);
          w.task = null;
          w.workTimer = 0;
          if (w.queue.length === 0) {
            // release camera back to free, smoothly handled in render
            s.camera.follow = null;
          }
        }
      }
    }

    // floaters
    for (const f of s.floaters) f.age += dt;
    s.floaters = s.floaters.filter(f => f.age < 1400);

    // camera target
    const cam = s.camera;
    let targetX = cam.freeX, targetY = cam.freeY;
    if (cam.follow) {
      targetX = cam.follow.x - s.viewportW / (2 * s.cssScale);
      targetY = cam.follow.y - s.viewportH / (2 * s.cssScale);
    }
    // keyboard pan
    const panSpeed = 0.3;
    if (s.keys.has("ArrowLeft") || s.keys.has("a")) { cam.freeX -= panSpeed * dt; cam.follow = null; }
    if (s.keys.has("ArrowRight") || s.keys.has("d")) { cam.freeX += panSpeed * dt; cam.follow = null; }
    if (s.keys.has("ArrowUp") || s.keys.has("w")) { cam.freeY -= panSpeed * dt; cam.follow = null; }
    if (s.keys.has("ArrowDown") || s.keys.has("s")) { cam.freeY += panSpeed * dt; cam.follow = null; }
    if (!cam.follow) { targetX = cam.freeX; targetY = cam.freeY; }
    // clamp
    const worldW = MAP_W * TILE, worldH = MAP_H * TILE;
    const viewW = s.viewportW / s.cssScale, viewH = s.viewportH / s.cssScale;
    targetX = Math.max(0, Math.min(worldW - viewW, targetX));
    targetY = Math.max(0, Math.min(worldH - viewH, targetY));
    // ease
    cam.x += (targetX - cam.x) * Math.min(1, dt / 120);
    cam.y += (targetY - cam.y) * Math.min(1, dt / 120);
    if (!cam.follow) { cam.freeX = cam.x; cam.freeY = cam.y; }

    // sync UI ~ every 100ms
    syncUi();
  }

  let lastSync = 0;
  function syncUi() {
    const now = performance.now();
    if (now - lastSync < 120) return;
    lastSync = now;
    const s = stateRef.current;
    const t = Math.floor((s.dayMs / DAY_MS) * 16 * 60); // 06:00 -> 22:00
    const totalMin = 6 * 60 + t;
    const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    setUi(u => {
      const next = {
        ...u,
        coins: s.coins, seeds: s.seeds, harvested: s.harvested,
        revenue: s.revenue, expenses: s.expenses,
        day: s.day, time: `${hh}:${mm}`, workers: s.workers.length, tool: s.selectedTool,
      };
      if (next.coins === u.coins && next.seeds === u.seeds && next.harvested === u.harvested
        && next.revenue === u.revenue && next.expenses === u.expenses && next.day === u.day
        && next.time === u.time && next.workers === u.workers && next.tool === u.tool) return u;
      return next;
    });
  }

  function completeTask(s: typeof stateRef.current, w: Worker) {
    const t = w.task!;
    if (t.kind === "deliver") {
      const amount = s.harvested;
      const revenue = amount * WHEAT.price;
      s.coins += revenue;
      s.revenue += revenue;
      s.harvested = 0;
      addFloater(w.x, w.y - 24, `+${revenue}c`, "#f5c530");
      return;
    }
    if (!inField(t.tx, t.ty)) return;
    const f = s.fields[fieldIdx(t.tx, t.ty)];
    if (t.kind === "prepare" && f.state === EMPTY) {
      f.state = PREPARED;
    } else if (t.kind === "plant" && f.state === PREPARED && s.seeds > 0) {
      f.state = PLANTED; f.growth = 0; s.seeds -= 1;
    } else if (t.kind === "harvest" && f.state === READY) {
      f.state = EMPTY; f.growth = 0;
      s.harvested += WHEAT.yield;
      addFloater(w.x, w.y - 24, `+${WHEAT.yield} wheat`, "#fcdc70");
    }
  }

  // ---------- drawing ----------
  function draw() {
    const cvs = canvasRef.current;
    if (!cvs) return;
    const s = stateRef.current;
    const ctx = cvs.getContext("2d");
    if (!ctx) return;

    // Set internal canvas size to viewport / scale
    const viewW = Math.floor(s.viewportW / s.cssScale);
    const viewH = Math.floor(s.viewportH / s.cssScale);
    if (cvs.width !== viewW || cvs.height !== viewH) {
      cvs.width = viewW; cvs.height = viewH;
    }
    ctx.imageSmoothingEnabled = false;

    // sky bg
    ctx.fillStyle = COLORS.sky;
    ctx.fillRect(0, 0, viewW, viewH);

    ctx.save();
    ctx.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));

    // ground (grass tiles)
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        drawGrassTile(ctx, x * TILE, y * TILE, x * 31 + y * 17);
      }
    }
    // path
    for (let x = 0; x < MAP_W; x++) {
      px(ctx, x * TILE, 14 * TILE, TILE, TILE, COLORS.path);
      // dashes
      px(ctx, x * TILE + 4, 14 * TILE + 12, 6, 2, COLORS.pathDark);
      px(ctx, x * TILE + 18, 14 * TILE + 20, 6, 2, COLORS.pathDark);
    }

    // fields
    for (let ty = FIELD_AREA.y0; ty <= FIELD_AREA.y1; ty++) {
      for (let tx = FIELD_AREA.x0; tx <= FIELD_AREA.x1; tx++) {
        const f = s.fields[fieldIdx(tx, ty)];
        const x = tx * TILE, y = ty * TILE;
        if (f.state === EMPTY) {
          // light dirt patch border to suggest tillable
          drawGrassTile(ctx, x, y, tx * 11 + ty * 7);
          px(ctx, x + 4, y + 4, TILE - 8, TILE - 8, "rgba(90,58,32,0.18)");
        } else if (f.state === PREPARED) {
          drawSoilTile(ctx, x, y, true);
        } else {
          drawWheat(ctx, x, y, f.state);
        }
      }
    }
    // field fence (subtle border)
    ctx.strokeStyle = COLORS.woodDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(FIELD_AREA.x0 * TILE + 0.5, FIELD_AREA.y0 * TILE + 0.5,
      (FIELD_AREA.x1 - FIELD_AREA.x0 + 1) * TILE - 1, (FIELD_AREA.y1 - FIELD_AREA.y0 + 1) * TILE - 1);

    // buildings
    drawHouse(ctx, FARMHOUSE.x * TILE, FARMHOUSE.y * TILE);
    drawBarn(ctx, BARN.x * TILE, BARN.y * TILE);
    drawCoop(ctx, COOP.x * TILE, COOP.y * TILE);
    drawShed(ctx, TOOLSHED.x * TILE, TOOLSHED.y * TILE);
    drawWell(ctx, WELL.x * TILE, WELL.y * TILE);
    drawShippingBin(ctx, SHIPPING_BIN.x * TILE, SHIPPING_BIN.y * TILE);

    // tile hover indicator
    const hover = pointerToTile();
    if (hover) {
      const x = hover.tx * TILE, y = hover.ty * TILE;
      const valid = inField(hover.tx, hover.ty) || (hover.tx === SHIPPING_BIN.x && hover.ty === SHIPPING_BIN.y);
      ctx.strokeStyle = valid ? "#fdf6e3" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      if (valid) {
        ctx.strokeStyle = COLORS.black;
        ctx.strokeRect(x + 1.5, y + 1.5, TILE - 3, TILE - 3);
      }
    }

    // workers (sort by y for depth)
    const sorted = [...s.workers].sort((a, b) => a.y - b.y);
    for (const w of sorted) drawWorker(ctx, w);

    // floaters
    for (const f of s.floaters) {
      const alpha = 1 - f.age / 1400;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.fillStyle = COLORS.black;
      ctx.font = "8px 'Press Start 2P', monospace";
      ctx.fillText(f.text, Math.round(f.x - 12) + 1, Math.round(f.y - f.age * 0.03) + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, Math.round(f.x - 12), Math.round(f.y - f.age * 0.03));
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    // day/night tint
    const t = s.dayMs / DAY_MS; // 0..1
    let tint = 0;
    if (t < 0.1) tint = (0.1 - t) * 4; // dawn
    else if (t > 0.85) tint = (t - 0.85) * 4; // dusk
    if (tint > 0) {
      ctx.fillStyle = `rgba(40, 30, 80, ${Math.min(0.45, tint)})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
  }

  function pointerToTile() {
    const s = stateRef.current;
    const p = s.pointer;
    if (p.x < 0 || p.y < 0) return null;
    const wx = p.x / s.cssScale + s.camera.x;
    const wy = p.y / s.cssScale + s.camera.y;
    const tx = Math.floor(wx / TILE);
    const ty = Math.floor(wy / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return null;
    return { tx, ty };
  }

  // ---------- resize ----------
  useEffect(() => {
    const ro = new ResizeObserver(() => {
      const el = wrapRef.current; if (!el) return;
      const s = stateRef.current;
      s.viewportW = el.clientWidth;
      s.viewportH = el.clientHeight;
      // pick a chunky scale
      const fitScale = Math.max(2, Math.floor(Math.min(s.viewportW / (MAP_W * TILE), s.viewportH / (MAP_H * TILE))));
      // Prefer showing slightly zoomed-in view
      s.cssScale = Math.max(2, Math.min(3, fitScale));
    });
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, []);

  // ---------- input ----------
  useEffect(() => {
    const s = stateRef.current;
    const cvs = canvasRef.current!;
    const getPos = (e: PointerEvent) => {
      const rect = cvs.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    const onDown = (e: PointerEvent) => {
      const { x, y } = getPos(e);
      s.pointer.x = x; s.pointer.y = y;
      s.pointer.downAt = performance.now();
      s.pointer.dragging = false;
      s.pointer.startX = x; s.pointer.startY = y;
      s.pointer.startCamX = s.camera.x; s.pointer.startCamY = s.camera.y;
      (e.target as Element).setPointerCapture?.(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = getPos(e);
      s.pointer.x = x; s.pointer.y = y;
      if (s.pointer.downAt) {
        const dx = x - s.pointer.startX, dy = y - s.pointer.startY;
        if (Math.hypot(dx, dy) > 6) {
          s.pointer.dragging = true;
          s.camera.follow = null;
          s.camera.freeX = s.pointer.startCamX - dx / s.cssScale;
          s.camera.freeY = s.pointer.startCamY - dy / s.cssScale;
        }
      }
    };
    const onUp = (e: PointerEvent) => {
      const wasDragging = s.pointer.dragging;
      s.pointer.downAt = null;
      s.pointer.dragging = false;
      if (wasDragging) return;
      const t = pointerToTile();
      if (t) handleTileClick(t.tx, t.ty);
    };
    const onLeave = () => { s.pointer.x = -1; s.pointer.y = -1; };
    const onKey = (e: KeyboardEvent) => { s.keys.add(e.key); };
    const onKeyUp = (e: KeyboardEvent) => { s.keys.delete(e.key); };
    cvs.addEventListener("pointerdown", onDown);
    cvs.addEventListener("pointermove", onMove);
    cvs.addEventListener("pointerup", onUp);
    cvs.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      cvs.removeEventListener("pointerdown", onDown);
      cvs.removeEventListener("pointermove", onMove);
      cvs.removeEventListener("pointerup", onUp);
      cvs.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [handleTileClick]);

  // ---------- shop actions ----------
  const buySeeds = (n: number) => {
    const s = stateRef.current;
    const cost = n * SEED_COST;
    if (s.coins < cost) { setMessage(`Need ${cost} coins for ${n} seeds.`); return; }
    s.coins -= cost; s.seeds += n; s.expenses += cost;
    addFloater(FARMHOUSE.x * TILE, FARMHOUSE.y * TILE + 10, `-${cost}c`, "#c84a3a");
    setMessage(`Bought ${n} seeds. Click prepared soil to plant.`);
  };
  const hireWorker = () => {
    const s = stateRef.current;
    const cost = HIRE_COST_BASE * s.workers.length;
    if (s.coins < cost) { setMessage(`Hiring costs ${cost} coins. Earn more first.`); return; }
    s.coins -= cost; s.expenses += cost;
    const palette = [
      [COLORS.hairBrown, COLORS.shirtBlue],
      [COLORS.hairBlack, COLORS.shirtGreen],
      [COLORS.hairBlonde, COLORS.shirtBlue],
    ];
    const choice = palette[(s.workers.length - 1) % palette.length];
    const names = ["Sam", "Theo", "Riley", "Jess", "Kai"];
    const w = makeWorker(s.workers.length + 1, names[(s.workers.length - 1) % names.length],
      (FARMHOUSE.x + 1) * TILE + TILE / 2, (FARMHOUSE.y + FARMHOUSE.h) * TILE + 8, choice[0], choice[1]);
    s.workers.push(w);
    setMessage(`Hired ${w.name}! Two workers can work at once.`);
  };
  const focusWorker = () => {
    const s = stateRef.current;
    s.camera.follow = s.workers[0] ?? null;
  };

  const dayPct = Math.min(100, Math.floor((stateRef.current.dayMs / DAY_MS) * 100));

  return (
    <div className="min-h-screen w-full flex flex-col" style={{ background: "linear-gradient(180deg, #a9d8ef 0%, #7ec84a 60%)" }}>
      {/* Top HUD */}
      <header className="px-3 py-2 flex flex-wrap gap-2 items-center justify-between" style={{ borderBottom: "3px solid var(--color-border)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="pixel-chip" style={{ background: "var(--color-primary)", color: "var(--color-primary-foreground)", border: "2px solid var(--color-border)" }}>
            🌾 KidFarm
          </h1>
          <Chip label="Coins" value={`${ui.coins}c`} swatch="#f5c530" />
          <Chip label="Seeds" value={`${ui.seeds}`} swatch="#e3b94a" />
          <Chip label="Wheat" value={`${ui.harvested}`} swatch="#fcdc70" />
          <Chip label="Revenue" value={`${ui.revenue}c`} swatch="#3aa860" />
          <Chip label="Expenses" value={`${ui.expenses}c`} swatch="#c84a3a" />
          <Chip label="Profit" value={`${ui.revenue - ui.expenses}c`} swatch={(ui.revenue - ui.expenses) >= 0 ? "#3aa860" : "#c84a3a"} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip label="Day" value={`${ui.day}`} swatch="#a9d8ef" />
          <Chip label="Time" value={ui.time} swatch="#fcdc70" />
          <Chip label="Workers" value={`${ui.workers}`} swatch="#c84a3a" />
        </div>
      </header>

      {/* main: world + side panel */}
      <div className="flex-1 flex flex-col lg:flex-row gap-2 p-2">
        <div ref={wrapRef} className="relative flex-1 overflow-hidden pixel-panel" style={{ minHeight: 380 }}>
          <canvas ref={canvasRef} className="pixel-canvas w-full h-full" />
          {/* day progress bar */}
          <div className="absolute left-2 right-2 bottom-2 h-3" style={{
            border: "2px solid var(--color-border)", borderRadius: 4, background: "rgba(255,255,255,0.6)",
          }}>
            <div style={{ width: `${dayPct}%`, height: "100%", background: "linear-gradient(90deg,#fcdc70,#f5c530)", borderRadius: 2 }} />
          </div>
          {/* message */}
          <div className="absolute left-2 top-2 max-w-[80%] pixel-panel" style={{ padding: "6px 8px", fontSize: 10 }}>
            {ui.message}
          </div>
        </div>

        <aside className="lg:w-[260px] flex flex-col gap-2">
          <Panel title="Shop">
            <button className="pixel-btn" onClick={() => buySeeds(1)}>Buy 1 Seed · 2c</button>
            <button className="pixel-btn" onClick={() => buySeeds(5)}>Buy 5 Seeds · 10c</button>
          </Panel>
          <Panel title="Workers">
            <button className="pixel-btn primary" onClick={hireWorker}>
              Hire Worker · {HIRE_COST_BASE * ui.workers}c
            </button>
            <button className="pixel-btn" onClick={focusWorker}>Find Maya</button>
            <div style={{ fontSize: 9, lineHeight: 1.5 }}>
              More workers = more tasks at the same time. That&apos;s leverage!
            </div>
          </Panel>
          <Panel title="How to Play">
            <ol style={{ fontSize: 9, lineHeight: 1.6, paddingLeft: 14 }}>
              <li>Click a soil tile → worker prepares it.</li>
              <li>Click prepared soil → plant a seed.</li>
              <li>Wait for wheat to grow.</li>
              <li>Click golden wheat → harvest.</li>
              <li>Click the SHIP bin → sell for coins.</li>
            </ol>
            <div style={{ fontSize: 9, opacity: 0.7 }}>Drag map to pan. Arrow keys also pan.</div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

// ============ small UI bits ============
function Chip({ label, value, swatch }: { label: string; value: string; swatch: string }) {
  return (
    <div className="pixel-chip">
      <span style={{ width: 10, height: 10, background: swatch, border: "1px solid var(--color-border)", display: "inline-block" }} />
      <span style={{ opacity: 0.7 }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pixel-panel p-2 flex flex-col gap-2">
      <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-muted-foreground)" }}>{title}</div>
      {children}
    </div>
  );
}

// ============ factories ============
function createFields(): Field[] {
  const w = FIELD_AREA.x1 - FIELD_AREA.x0 + 1;
  const h = FIELD_AREA.y1 - FIELD_AREA.y0 + 1;
  const arr: Field[] = [];
  for (let i = 0; i < w * h; i++) arr.push({ state: EMPTY, growth: 0 });
  return arr;
}

function makeWorker(id: number, name: string, x: number, y: number, hair: string, shirt: string): Worker {
  return {
    id, name, x, y, tx: Math.floor(x / TILE), ty: Math.floor(y / TILE),
    task: null, queue: [], facing: "down", workTimer: 0, walkPhase: 0, hair, shirt,
  };
}
