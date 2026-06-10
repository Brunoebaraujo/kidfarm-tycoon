import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type FieldState = "empty" | "prepared" | "planted" | "growing1" | "growing2" | "growing3" | "ready";
type TaskKind = "prepare" | "plant" | "harvest" | "deliver";
type Facing = "down" | "up" | "left" | "right";

type Task = {
  id: number;
  kind: TaskKind;
  tx: number;
  ty: number;
};

type Worker = {
  id: string;
  name: string;
  x: number;
  y: number;
  task: Task | null;
  queue: Task[];
  facing: Facing;
  workTimer: number;
  walkPhase: number;
  hair: string;
  shirt: string;
};

type Field = {
  state: FieldState;
  growth: number;
};

type WorkerUi = {
  id: string;
  name: string;
  status: string;
  currentTask: string;
  queueLength: number;
  isSelected: boolean;
};

const TILE = 32;
const MAP_W = 22;
const MAP_H = 16;
const FIELD_AREA = { x0: 3, y0: 5, x1: 12, y1: 12 };
const SHIPPING_BIN = { x: 16, y: 11 };
const FARMHOUSE = { x: 16, y: 4, w: 4, h: 3 };
const BARN = { x: 14, y: 8, w: 3, h: 3 };
const COOP = { x: 17, y: 8, w: 3, h: 2 };
const WELL = { x: 13, y: 6 };
const TOOLSHED = { x: 2, y: 3, w: 2, h: 2 };
const WHEAT = { seedCost: 2, yield: 4, price: 3, growMs: 18_000 };
const DAY_MS = 90_000;
const DAILY_COST = 8;
const HIRE_COST_BASE = 50;
const WORK_MS = 850;

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
  selected: "#fff06a",
};

const TASK_LABELS: Record<TaskKind, string> = {
  prepare: "Prepare Soil",
  plant: "Plant Wheat",
  harvest: "Harvest Wheat",
  deliver: "Deliver Wheat",
};

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function createFields(): Field[] {
  const w = FIELD_AREA.x1 - FIELD_AREA.x0 + 1;
  const h = FIELD_AREA.y1 - FIELD_AREA.y0 + 1;
  return Array.from({ length: w * h }, () => ({ state: "empty" as FieldState, growth: 0 }));
}

function makeWorker(id: string, name: string, x: number, y: number, hair: string, shirt: string): Worker {
  return {
    id,
    name,
    x,
    y,
    task: null,
    queue: [],
    facing: "down",
    workTimer: 0,
    walkPhase: 0,
    hair,
    shirt,
  };
}

function workerStatus(worker: Worker) {
  if (worker.task) return worker.workTimer > 0 ? "Busy" : "Moving";
  return "Idle";
}

function taskName(task: Task | null) {
  return task ? TASK_LABELS[task.kind] : "Idle";
}

function drawGrassTile(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number) {
  px(ctx, x, y, TILE, TILE, COLORS.grass);
  const a = (seed * 9301 + 49297) % 233280;
  const r1 = (a >> 2) % TILE;
  const r2 = (a >> 5) % TILE;
  px(ctx, x + r1, y + r2, 2, 2, COLORS.grassDark);
  px(ctx, x + ((r1 + 11) % TILE), y + ((r2 + 7) % TILE), 2, 1, COLORS.grassLight);
}

function drawSoilTile(ctx: CanvasRenderingContext2D, x: number, y: number, prepared: boolean) {
  px(ctx, x, y, TILE, TILE, prepared ? COLORS.soilWet : COLORS.soilDry);
  for (let i = 4; i < TILE; i += 8) {
    px(ctx, x + 2, y + i, TILE - 4, 1, COLORS.soil);
    px(ctx, x + 2, y + i + 2, TILE - 4, 1, prepared ? COLORS.soilDry : COLORS.soilWet);
  }
  px(ctx, x, y, TILE, 1, COLORS.black);
  px(ctx, x, y + TILE - 1, TILE, 1, COLORS.black);
}

function drawWheat(ctx: CanvasRenderingContext2D, x: number, y: number, state: FieldState) {
  drawSoilTile(ctx, x, y, true);
  const heights: Record<FieldState, number> = {
    empty: 0,
    prepared: 0,
    planted: 3,
    growing1: 7,
    growing2: 12,
    growing3: 17,
    ready: 20,
  };
  const height = heights[state];
  for (let i = 0; i < 4; i += 1) {
    const sx = x + 6 + i * 6;
    px(ctx, sx, y + 24 - height, 1, height, state === "ready" || state === "growing3" ? COLORS.wheatStalk : COLORS.leafDark);
    px(ctx, sx - 2, y + 23 - height, 5, state === "ready" ? 6 : 3, state === "ready" ? COLORS.wheatLight : COLORS.leaf);
  }
}

function drawRectBuilding(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, body: string, roof: string) {
  px(ctx, x + 4, y + h / 3, w - 8, (h * 2) / 3 - 2, body);
  px(ctx, x + 4, y + h - 4, w - 8, 4, COLORS.woodDark);
  for (let r = 0; r < h / 3; r += 1) {
    const inset = Math.floor((r / (h / 3)) * (w / 2 - 2));
    px(ctx, x + inset, y + r, w - inset * 2, 1, roof);
  }
}

function drawShippingBin(ctx: CanvasRenderingContext2D, x: number, y: number) {
  px(ctx, x + 2, y + 8, TILE - 4, TILE - 12, COLORS.woodLight);
  px(ctx, x + 2, y + 8, TILE - 4, 3, COLORS.woodDark);
  px(ctx, x + 6, y + 2, TILE - 12, 8, COLORS.white);
  px(ctx, x + 9, y + 4, 12, 3, COLORS.black);
}

function drawWell(ctx: CanvasRenderingContext2D, x: number, y: number) {
  px(ctx, x + 6, y + 14, TILE - 12, 14, COLORS.stoneDark);
  px(ctx, x + 8, y + 14, TILE - 16, 12, COLORS.stone);
  px(ctx, x + 10, y + 17, TILE - 20, 6, COLORS.water);
  px(ctx, x + 7, y + 2, 2, 14, COLORS.wood);
  px(ctx, x + TILE - 9, y + 2, 2, 14, COLORS.wood);
  px(ctx, x + 4, y + 2, TILE - 8, 5, COLORS.roof);
}

function drawWorker(ctx: CanvasRenderingContext2D, worker: Worker, isSelected: boolean) {
  const x = worker.x | 0;
  const y = worker.y | 0;
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(x, y + 1, 9, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  if (isSelected) {
    ctx.strokeStyle = COLORS.selected;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(x, y + 4, 14, 6, 0, 0, Math.PI * 2);
    ctx.stroke();
    px(ctx, x - 2, y - 35, 4, 4, COLORS.selected);
  }

  const bob = worker.task ? Math.floor(worker.walkPhase) % 2 : 0;
  const top = y - 20 - bob;
  px(ctx, x - 4, top + 14, 3, 6, COLORS.jeans);
  px(ctx, x + 1, top + 14, 3, 6, COLORS.jeans);
  px(ctx, x - 5, top + 7, 10, 8, worker.shirt);
  px(ctx, x - 6, top + 8, 2, 6, worker.shirt);
  px(ctx, x + 5, top + 8, 2, 6, worker.shirt);
  px(ctx, x - 4, top + 1, 8, 7, COLORS.skin);
  px(ctx, x - 5, top, 10, 4, worker.hair);
  px(ctx, x + 5, top + 4, 2, 5, worker.hair);
  px(ctx, x - 6, top + 2, 12, 2, COLORS.hatBrown);
  px(ctx, x - 3, top - 1, 6, 3, COLORS.hatBrown);

  if (worker.facing !== "up") {
    px(ctx, worker.facing === "left" ? x - 3 : x - 2, top + 5, 1, 1, COLORS.black);
    px(ctx, worker.facing === "right" ? x + 2 : x + 1, top + 5, 1, 1, COLORS.black);
  }
}

export default function KidFarmGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const nextTaskId = useRef(1);

  const stateRef = useRef({
    coins: 25,
    seeds: 5,
    harvested: 0,
    revenue: 0,
    expenses: 0,
    dayMs: 0,
    day: 1,
    fields: createFields(),
    workers: [makeWorker("maya", "Maya", 10 * TILE + TILE / 2, 4 * TILE + TILE / 2, COLORS.hairBlonde, COLORS.shirtRed)],
    selectedWorkerId: "maya",
    camera: { x: 0, y: 0, freeX: 0, freeY: 0 },
    cssScale: 2,
    viewportW: 800,
    viewportH: 600,
    keys: new Set<string>(),
    pointer: { x: -1, y: -1, downAt: 0 as number | null, dragging: false, startX: 0, startY: 0, startCamX: 0, startCamY: 0 },
    lastTime: performance.now(),
    floaters: [] as { x: number; y: number; text: string; color: string; age: number }[],
  });

  const [ui, setUi] = useState({
    coins: 25,
    seeds: 5,
    harvested: 0,
    revenue: 0,
    expenses: 0,
    day: 1,
    time: "06:00",
    selectedWorkerId: "maya",
    selectedWorkerName: "Maya",
    selectedStatus: "Idle",
    selectedCurrentTask: "Idle",
    selectedQueueLength: 0,
    workers: [{ id: "maya", name: "Maya", status: "Idle", currentTask: "Idle", queueLength: 0, isSelected: true }] as WorkerUi[],
    message: "Selected Worker: Maya. Click soil to prepare it.",
  });

  function inField(tx: number, ty: number) {
    return tx >= FIELD_AREA.x0 && tx <= FIELD_AREA.x1 && ty >= FIELD_AREA.y0 && ty <= FIELD_AREA.y1;
  }

  function fieldIdx(tx: number, ty: number) {
    return (ty - FIELD_AREA.y0) * (FIELD_AREA.x1 - FIELD_AREA.x0 + 1) + (tx - FIELD_AREA.x0);
  }

  function selectedWorker() {
    const s = stateRef.current;
    return s.workers.find((worker) => worker.id === s.selectedWorkerId) ?? s.workers[0];
  }

  const setMessage = useCallback((message: string) => {
    setUi((current) => (current.message === message ? current : { ...current, message }));
  }, []);

  function addFloater(x: number, y: number, text: string, color: string) {
    stateRef.current.floaters.push({ x, y, text, color, age: 0 });
  }

  function selectWorker(workerId: string) {
    const s = stateRef.current;
    const worker = s.workers.find((candidate) => candidate.id === workerId);
    if (!worker) return;
    s.selectedWorkerId = worker.id;
    setMessage(`Selected Worker: ${worker.name}`);
    syncUi(true);
  }

  function assignTask(task: Omit<Task, "id">) {
    const worker = selectedWorker();
    const command = { ...task, id: nextTaskId.current };
    nextTaskId.current += 1;
    worker.queue.push(command);
    setMessage(`${TASK_LABELS[task.kind]} queued for ${worker.name}.`);
    syncUi(true);
  }

  const handleTileClick = useCallback((tx: number, ty: number) => {
    const s = stateRef.current;
    if (tx === SHIPPING_BIN.x && ty === SHIPPING_BIN.y) {
      if (s.harvested <= 0) {
        setMessage("No harvested wheat to ship.");
        return;
      }
      assignTask({ kind: "deliver", tx, ty });
      return;
    }

    if (!inField(tx, ty)) {
      setMessage("Click a worker to select, then click soil tiles or the shipping bin.");
      return;
    }

    const field = s.fields[fieldIdx(tx, ty)];
    if (field.state === "empty") {
      assignTask({ kind: "prepare", tx, ty });
    } else if (field.state === "prepared") {
      if (s.seeds <= 0) {
        setMessage("Out of seeds. Buy more seeds first.");
        return;
      }
      assignTask({ kind: "plant", tx, ty });
    } else if (field.state === "ready") {
      assignTask({ kind: "harvest", tx, ty });
    } else {
      setMessage("This crop is still growing.");
    }
  }, [setMessage]);

  function completeTask(worker: Worker) {
    const s = stateRef.current;
    const task = worker.task;
    if (!task) return;

    if (task.kind === "deliver") {
      const amount = s.harvested;
      const revenue = amount * WHEAT.price;
      s.coins += revenue;
      s.revenue += revenue;
      s.harvested = 0;
      addFloater(worker.x, worker.y - 24, `+${revenue}c`, "#f5c530");
      return;
    }

    if (!inField(task.tx, task.ty)) return;
    const field = s.fields[fieldIdx(task.tx, task.ty)];
    if (task.kind === "prepare" && field.state === "empty") {
      field.state = "prepared";
    } else if (task.kind === "plant" && field.state === "prepared" && s.seeds > 0) {
      field.state = "planted";
      field.growth = 0;
      s.seeds -= 1;
    } else if (task.kind === "harvest" && field.state === "ready") {
      field.state = "empty";
      field.growth = 0;
      s.harvested += WHEAT.yield;
      addFloater(worker.x, worker.y - 24, `+${WHEAT.yield} wheat`, "#fcdc70");
    }
  }

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
  }, []);

  function update(dt: number) {
    const s = stateRef.current;
    s.dayMs += dt;
    if (s.dayMs >= DAY_MS) {
      s.dayMs -= DAY_MS;
      s.day += 1;
      s.coins -= DAILY_COST;
      s.expenses += DAILY_COST;
      addFloater(SHIPPING_BIN.x * TILE + TILE / 2, SHIPPING_BIN.y * TILE - 10, `-${DAILY_COST}c daily`, COLORS.shirtRed);
    }

    for (const field of s.fields) {
      if (["planted", "growing1", "growing2", "growing3"].includes(field.state)) {
        field.growth += dt;
        const step = WHEAT.growMs / 4;
        if (field.growth >= step * 4) field.state = "ready";
        else if (field.growth >= step * 3) field.state = "growing3";
        else if (field.growth >= step * 2) field.state = "growing2";
        else if (field.growth >= step) field.state = "growing1";
      }
    }

    for (const worker of s.workers) {
      if (!worker.task && worker.queue.length > 0) {
        worker.task = worker.queue.shift() ?? null;
      }
      if (!worker.task) continue;

      const targetX = worker.task.tx * TILE + TILE / 2;
      const targetY = worker.task.ty * TILE + TILE / 2;
      const dx = targetX - worker.x;
      const dy = targetY - worker.y;
      const dist = Math.hypot(dx, dy);
      if (dist > 2) {
        const speed = 0.08;
        const move = Math.min(dist, speed * dt);
        worker.x += (dx / dist) * move;
        worker.y += (dy / dist) * move;
        worker.walkPhase += dt * 0.012;
        worker.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : (dy > 0 ? "down" : "up");
      } else {
        if (worker.workTimer === 0) worker.workTimer = WORK_MS;
        worker.workTimer -= dt;
        if (worker.workTimer <= 0) {
          completeTask(worker);
          worker.task = null;
          worker.workTimer = 0;
        }
      }
    }

    for (const floater of s.floaters) floater.age += dt;
    s.floaters = s.floaters.filter((floater) => floater.age < 1400);

    const panSpeed = 0.3;
    if (s.keys.has("ArrowLeft") || s.keys.has("a")) s.camera.freeX -= panSpeed * dt;
    if (s.keys.has("ArrowRight") || s.keys.has("d")) s.camera.freeX += panSpeed * dt;
    if (s.keys.has("ArrowUp") || s.keys.has("w")) s.camera.freeY -= panSpeed * dt;
    if (s.keys.has("ArrowDown") || s.keys.has("s")) s.camera.freeY += panSpeed * dt;
    clampCamera();
    s.camera.x += (s.camera.freeX - s.camera.x) * Math.min(1, dt / 120);
    s.camera.y += (s.camera.freeY - s.camera.y) * Math.min(1, dt / 120);

    syncUi();
  }

  function clampCamera() {
    const s = stateRef.current;
    const worldW = MAP_W * TILE;
    const worldH = MAP_H * TILE;
    const viewW = s.viewportW / s.cssScale;
    const viewH = s.viewportH / s.cssScale;
    s.camera.freeX = clamp(s.camera.freeX, 0, Math.max(0, worldW - viewW));
    s.camera.freeY = clamp(s.camera.freeY, 0, Math.max(0, worldH - viewH));
  }

  const lastSync = useRef(0);
  function syncUi(force = false) {
    const now = performance.now();
    if (!force && now - lastSync.current < 120) return;
    lastSync.current = now;
    const s = stateRef.current;
    const selected = selectedWorker();
    const timeProgress = Math.floor((s.dayMs / DAY_MS) * 16 * 60);
    const totalMin = 6 * 60 + timeProgress;
    const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const mm = String(totalMin % 60).padStart(2, "0");
    const workers = s.workers.map((worker) => ({
      id: worker.id,
      name: worker.name,
      status: workerStatus(worker),
      currentTask: taskName(worker.task),
      queueLength: worker.queue.length,
      isSelected: worker.id === s.selectedWorkerId,
    }));

    setUi((current) => ({
      ...current,
      coins: s.coins,
      seeds: s.seeds,
      harvested: s.harvested,
      revenue: s.revenue,
      expenses: s.expenses,
      day: s.day,
      time: `${hh}:${mm}`,
      selectedWorkerId: selected.id,
      selectedWorkerName: selected.name,
      selectedStatus: workerStatus(selected),
      selectedCurrentTask: taskName(selected.task),
      selectedQueueLength: selected.queue.length,
      workers,
    }));
  }

  function draw() {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const s = stateRef.current;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const viewW = Math.floor(s.viewportW / s.cssScale);
    const viewH = Math.floor(s.viewportH / s.cssScale);
    if (canvas.width !== viewW || canvas.height !== viewH) {
      canvas.width = viewW;
      canvas.height = viewH;
    }
    ctx.imageSmoothingEnabled = false;
    px(ctx, 0, 0, viewW, viewH, COLORS.sky);
    ctx.save();
    ctx.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));

    for (let y = 0; y < MAP_H; y += 1) {
      for (let x = 0; x < MAP_W; x += 1) {
        drawGrassTile(ctx, x * TILE, y * TILE, x * 31 + y * 17);
      }
    }

    for (let x = 0; x < MAP_W; x += 1) {
      px(ctx, x * TILE, 14 * TILE, TILE, TILE, COLORS.path);
      px(ctx, x * TILE + 4, 14 * TILE + 12, 6, 2, COLORS.pathDark);
      px(ctx, x * TILE + 18, 14 * TILE + 20, 6, 2, COLORS.pathDark);
    }

    for (let ty = FIELD_AREA.y0; ty <= FIELD_AREA.y1; ty += 1) {
      for (let tx = FIELD_AREA.x0; tx <= FIELD_AREA.x1; tx += 1) {
        const field = s.fields[fieldIdx(tx, ty)];
        const x = tx * TILE;
        const y = ty * TILE;
        if (field.state === "empty") {
          drawGrassTile(ctx, x, y, tx * 11 + ty * 7);
          px(ctx, x + 4, y + 4, TILE - 8, TILE - 8, "rgba(90,58,32,0.18)");
        } else if (field.state === "prepared") {
          drawSoilTile(ctx, x, y, true);
        } else {
          drawWheat(ctx, x, y, field.state);
        }
      }
    }

    ctx.strokeStyle = COLORS.woodDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(FIELD_AREA.x0 * TILE + 0.5, FIELD_AREA.y0 * TILE + 0.5, (FIELD_AREA.x1 - FIELD_AREA.x0 + 1) * TILE - 1, (FIELD_AREA.y1 - FIELD_AREA.y0 + 1) * TILE - 1);

    drawRectBuilding(ctx, FARMHOUSE.x * TILE, FARMHOUSE.y * TILE, FARMHOUSE.w * TILE, FARMHOUSE.h * TILE, COLORS.woodLight, COLORS.roof);
    drawRectBuilding(ctx, BARN.x * TILE, BARN.y * TILE, BARN.w * TILE, BARN.h * TILE, COLORS.roof, COLORS.roofDark);
    drawRectBuilding(ctx, COOP.x * TILE, COOP.y * TILE, COOP.w * TILE, COOP.h * TILE, COLORS.woodLight, COLORS.roof);
    drawRectBuilding(ctx, TOOLSHED.x * TILE, TOOLSHED.y * TILE, TOOLSHED.w * TILE, TOOLSHED.h * TILE, COLORS.wood, COLORS.stoneDark);
    drawWell(ctx, WELL.x * TILE, WELL.y * TILE);
    drawShippingBin(ctx, SHIPPING_BIN.x * TILE, SHIPPING_BIN.y * TILE);

    const hover = pointerToTile();
    if (hover) {
      const valid = inField(hover.tx, hover.ty) || (hover.tx === SHIPPING_BIN.x && hover.ty === SHIPPING_BIN.y);
      ctx.strokeStyle = valid ? COLORS.white : "rgba(255,255,255,0.4)";
      ctx.strokeRect(hover.tx * TILE + 0.5, hover.ty * TILE + 0.5, TILE - 1, TILE - 1);
    }

    const sorted = [...s.workers].sort((a, b) => a.y - b.y);
    for (const worker of sorted) {
      drawWorker(ctx, worker, worker.id === s.selectedWorkerId);
      drawWorkerText(ctx, worker, worker.id === s.selectedWorkerId);
    }

    for (const floater of s.floaters) {
      const alpha = 1 - floater.age / 1400;
      ctx.globalAlpha = Math.max(0, alpha);
      ctx.font = "8px 'Press Start 2P', monospace";
      ctx.fillStyle = COLORS.black;
      ctx.fillText(floater.text, Math.round(floater.x - 12) + 1, Math.round(floater.y - floater.age * 0.03) + 1);
      ctx.fillStyle = floater.color;
      ctx.fillText(floater.text, Math.round(floater.x - 12), Math.round(floater.y - floater.age * 0.03));
      ctx.globalAlpha = 1;
    }

    ctx.restore();

    const t = s.dayMs / DAY_MS;
    const tint = t < 0.1 ? (0.1 - t) * 4 : t > 0.85 ? (t - 0.85) * 4 : 0;
    if (tint > 0) {
      ctx.fillStyle = `rgba(40, 30, 80, ${Math.min(0.45, tint)})`;
      ctx.fillRect(0, 0, viewW, viewH);
    }
  }

  function drawWorkerText(ctx: CanvasRenderingContext2D, worker: Worker, isSelected: boolean) {
    ctx.font = "8px 'Press Start 2P', monospace";
    ctx.textAlign = "center";
    const label = worker.name;
    const status = worker.task ? taskName(worker.task) : "Idle";
    const labelY = worker.y - 34;
    px(ctx, worker.x - label.length * 3 - 4, labelY - 8, label.length * 6 + 8, 10, COLORS.black);
    ctx.fillStyle = isSelected ? COLORS.selected : COLORS.white;
    ctx.fillText(label, worker.x, labelY);
    px(ctx, worker.x - status.length * 3 - 4, worker.y + 13, status.length * 6 + 8, 10, COLORS.black);
    ctx.fillStyle = COLORS.white;
    ctx.fillText(status, worker.x, worker.y + 21);

    if (worker.task && worker.workTimer > 0) {
      const width = 24;
      const progress = clamp(1 - worker.workTimer / WORK_MS, 0, 1);
      px(ctx, worker.x - width / 2, worker.y + 25, width, 4, COLORS.black);
      px(ctx, worker.x - width / 2 + 1, worker.y + 26, Math.floor((width - 2) * progress), 2, COLORS.selected);
    }
    ctx.textAlign = "left";
  }

  function pointerWorld() {
    const s = stateRef.current;
    if (s.pointer.x < 0 || s.pointer.y < 0) return null;
    return {
      x: s.pointer.x / s.cssScale + s.camera.x,
      y: s.pointer.y / s.cssScale + s.camera.y,
    };
  }

  function pointerToTile() {
    const world = pointerWorld();
    if (!world) return null;
    const tx = Math.floor(world.x / TILE);
    const ty = Math.floor(world.y / TILE);
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return null;
    return { tx, ty };
  }

  function workerAtPointer() {
    const world = pointerWorld();
    if (!world) return null;
    const s = stateRef.current;
    return [...s.workers].reverse().find((worker) => Math.hypot(world.x - worker.x, world.y - (worker.y - 10)) <= 18) ?? null;
  }

  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const element = wrapRef.current;
      if (!element) return;
      const s = stateRef.current;
      s.viewportW = element.clientWidth;
      s.viewportH = element.clientHeight;
      const fitScale = Math.max(2, Math.floor(Math.min(s.viewportW / (MAP_W * TILE), s.viewportH / (MAP_H * TILE))));
      s.cssScale = Math.max(2, Math.min(3, fitScale));
      clampCamera();
    });
    if (wrapRef.current) observer.observe(wrapRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const s = stateRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const getPos = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onDown = (event: PointerEvent) => {
      const { x, y } = getPos(event);
      s.pointer.x = x;
      s.pointer.y = y;
      s.pointer.downAt = performance.now();
      s.pointer.dragging = false;
      s.pointer.startX = x;
      s.pointer.startY = y;
      s.pointer.startCamX = s.camera.x;
      s.pointer.startCamY = s.camera.y;
      (event.target as Element).setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      const { x, y } = getPos(event);
      s.pointer.x = x;
      s.pointer.y = y;
      if (s.pointer.downAt) {
        const dx = x - s.pointer.startX;
        const dy = y - s.pointer.startY;
        if (Math.hypot(dx, dy) > 6) {
          s.pointer.dragging = true;
          s.camera.freeX = s.pointer.startCamX - dx / s.cssScale;
          s.camera.freeY = s.pointer.startCamY - dy / s.cssScale;
          clampCamera();
        }
      }
    };
    const onUp = () => {
      const wasDragging = s.pointer.dragging;
      s.pointer.downAt = null;
      s.pointer.dragging = false;
      if (wasDragging) return;
      const worker = workerAtPointer();
      if (worker) {
        selectWorker(worker.id);
        return;
      }
      const tile = pointerToTile();
      if (tile) handleTileClick(tile.tx, tile.ty);
    };
    const onLeave = () => {
      s.pointer.x = -1;
      s.pointer.y = -1;
    };
    const onKey = (event: KeyboardEvent) => s.keys.add(event.key);
    const onKeyUp = (event: KeyboardEvent) => s.keys.delete(event.key);

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointerleave", onLeave);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [handleTileClick]);

  const buySeeds = (count: number) => {
    const s = stateRef.current;
    const cost = count * WHEAT.seedCost;
    if (s.coins < cost) {
      setMessage(`Need ${cost} coins for ${count} seeds.`);
      return;
    }
    s.coins -= cost;
    s.seeds += count;
    s.expenses += cost;
    addFloater(FARMHOUSE.x * TILE, FARMHOUSE.y * TILE + 10, `-${cost}c`, COLORS.shirtRed);
    setMessage(`Bought ${count} seeds.`);
    syncUi(true);
  };

  const hireWorker = () => {
    const s = stateRef.current;
    const cost = HIRE_COST_BASE * s.workers.length;
    if (s.coins < cost) {
      setMessage(`Hiring costs ${cost} coins. Earn more first.`);
      return;
    }
    s.coins -= cost;
    s.expenses += cost;
    const index = s.workers.length;
    const palette = [
      [COLORS.hairBrown, COLORS.shirtBlue],
      [COLORS.hairBlack, COLORS.shirtGreen],
      [COLORS.hairBlonde, COLORS.shirtBlue],
    ];
    const colors = palette[(index - 1) % palette.length];
    const worker = makeWorker(`worker-${index}`, `Worker ${index}`, (FARMHOUSE.x + 1) * TILE + TILE / 2, (FARMHOUSE.y + FARMHOUSE.h) * TILE + 8, colors[0], colors[1]);
    s.workers.push(worker);
    setMessage(`Hired ${worker.name}. Select them to give commands.`);
    syncUi(true);
  };

  const centerOnWorker = (workerId: string) => {
    const s = stateRef.current;
    const worker = s.workers.find((candidate) => candidate.id === workerId);
    if (!worker) return;
    const viewW = s.viewportW / s.cssScale;
    const viewH = s.viewportH / s.cssScale;
    s.camera.freeX = worker.x - viewW / 2;
    s.camera.freeY = worker.y - viewH / 2;
    clampCamera();
    setMessage(`Centered camera on ${worker.name}.`);
  };

  const dayPct = Math.min(100, Math.floor((stateRef.current.dayMs / DAY_MS) * 100));

  return (
    <div className="min-h-screen w-full flex flex-col" style={{ background: "linear-gradient(180deg, #a9d8ef 0%, #7ec84a 60%)" }}>
      <header className="px-3 py-2 flex flex-wrap gap-2 items-center justify-between" style={{ borderBottom: "3px solid var(--color-border)" }}>
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="pixel-chip" style={{ background: "var(--color-primary)", color: "var(--color-primary-foreground)", border: "2px solid var(--color-border)" }}>
            KidFarm
          </h1>
          <Chip label="Coins" value={`${ui.coins}c`} swatch="#f5c530" />
          <Chip label="Seeds" value={`${ui.seeds}`} swatch="#e3b94a" />
          <Chip label="Wheat" value={`${ui.harvested}`} swatch="#fcdc70" />
          <Chip label="Revenue" value={`${ui.revenue}c`} swatch="#3aa860" />
          <Chip label="Expenses" value={`${ui.expenses}c`} swatch="#c84a3a" />
          <Chip label="Profit" value={`${ui.revenue - ui.expenses}c`} swatch={ui.revenue - ui.expenses >= 0 ? "#3aa860" : "#c84a3a"} />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Chip label="Day" value={`${ui.day}`} swatch="#a9d8ef" />
          <Chip label="Time" value={ui.time} swatch="#fcdc70" />
          <Chip label="Selected" value={ui.selectedWorkerName} swatch="#fff06a" />
        </div>
      </header>

      <div className="flex-1 flex flex-col lg:flex-row gap-2 p-2">
        <div ref={wrapRef} className="relative flex-1 overflow-hidden pixel-panel" style={{ minHeight: 380 }}>
          <canvas ref={canvasRef} className="pixel-canvas w-full h-full" />
          <div className="absolute left-2 right-2 bottom-2 h-3" style={{ border: "2px solid var(--color-border)", borderRadius: 4, background: "rgba(255,255,255,0.6)" }}>
            <div style={{ width: `${dayPct}%`, height: "100%", background: "linear-gradient(90deg,#fcdc70,#f5c530)", borderRadius: 2 }} />
          </div>
          <div className="absolute left-2 top-2 max-w-[80%] pixel-panel" style={{ padding: "6px 8px", fontSize: 10 }}>
            {ui.message}
          </div>
        </div>

        <aside className="lg:w-[300px] flex flex-col gap-2">
          <Panel title="Selected Worker">
            <StatusLine label="Name" value={ui.selectedWorkerName} />
            <StatusLine label="Status" value={ui.selectedStatus} />
            <StatusLine label="Task" value={ui.selectedCurrentTask} />
            <StatusLine label="Queue" value={`${ui.selectedQueueLength}`} />
          </Panel>

          <Panel title="Workers">
            {ui.workers.map((worker) => (
              <div key={worker.id} className="flex gap-2 items-stretch">
                <button className={`pixel-btn flex-1 ${worker.isSelected ? "accent" : ""}`} onClick={() => selectWorker(worker.id)}>
                  {worker.name}<br />{worker.status} / Queue {worker.queueLength}
                </button>
                <button className="pixel-btn" onClick={() => centerOnWorker(worker.id)}>Find</button>
              </div>
            ))}
            <button className="pixel-btn primary" onClick={hireWorker}>Hire Worker - {HIRE_COST_BASE * ui.workers.length}c</button>
          </Panel>

          <Panel title="Shop">
            <button className="pixel-btn" onClick={() => buySeeds(1)}>Buy 1 Seed - 2c</button>
            <button className="pixel-btn" onClick={() => buySeeds(5)}>Buy 5 Seeds - 10c</button>
          </Panel>

          <Panel title="How to Play">
            <ol style={{ fontSize: 9, lineHeight: 1.6, paddingLeft: 14 }}>
              <li>Click a worker to select them.</li>
              <li>Click soil, crops, or the shipping bin.</li>
              <li>Only the selected worker gets the command.</li>
              <li>Busy selected workers keep their own queue.</li>
            </ol>
            <div style={{ fontSize: 9, opacity: 0.7 }}>Drag map or use arrow keys/WASD to pan freely.</div>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

function Chip({ label, value, swatch }: { label: string; value: string; swatch: string }) {
  return (
    <div className="pixel-chip">
      <span style={{ width: 10, height: 10, background: swatch, border: "1px solid var(--color-border)", display: "inline-block" }} />
      <span style={{ opacity: 0.7 }}>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-2" style={{ fontSize: 9, lineHeight: 1.5 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <strong style={{ textAlign: "right" }}>{value}</strong>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pixel-panel p-2 flex flex-col gap-2">
      <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: "var(--color-muted-foreground)" }}>{title}</div>
      {children}
    </div>
  );
}
