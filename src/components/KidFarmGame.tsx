import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

type CropId = "wheat" | "rice" | "corn" | "banana";
type ProductId = CropId | "milk";
type Season = "spring" | "summer" | "autumn" | "winter";
type FieldState = "empty" | "prepared" | "planted" | "growing1" | "growing2" | "growing3" | "ready";
type TaskKind = "prepare" | "plant" | "harvest" | "deliver" | "milk";
type Facing = "down" | "up" | "left" | "right";

type Task = {
  id: number;
  kind: TaskKind;
  tx: number;
  ty: number;
  crop?: CropId;
  tiles?: { tx: number; ty: number }[];
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
  workTotal: number;
  walkPhase: number;
  hair: string;
  shirt: string;
};

type EquipmentId = "manualPlow" | "tractor" | "harvester";
type Equipment = Record<EquipmentId, boolean>;

type Field = {
  state: FieldState;
  growth: number;
  growMs: number;
  crop: CropId | null;
};

type Inventory = Record<ProductId, number>;
type Cow = { x: number; y: number; lastMilkedDay: number };

type WorkerUi = {
  id: string;
  name: string;
  status: string;
  currentTask: string;
  queueLength: number;
  isSelected: boolean;
};

type JournalEntry = { day: number; season: Season; text: string };

const TILE = 32;
const MAP_W = 22;
const MAP_H = 16;
const FIELD_AREA = { x0: 3, y0: 5, x1: 12, y1: 12 };
const SHIPPING_BIN = { x: 16, y: 11 };
const FARMHOUSE = { x: 9, y: 1, w: 5, h: 3 };
const BARN = { x: 14, y: 8, w: 3, h: 3 };
const COOP = { x: 17, y: 8, w: 3, h: 2 };
const WELL = { x: 13, y: 6 };
const TOOLSHED = { x: 2, y: 3, w: 2, h: 2 };
const SEASON_TREE = { x: 20, y: 4 }; // landmark tree near farmhouse (east side)
const MILKING_PARLOR = { x: 18, y: 1, w: 3, h: 3 };
const COW_TILE = { x: 19, y: 3 };
const SAVE_KEY = "kidfarm-save-v1";
const DAY_MS = 90_000;
const DAILY_COST = 8;
const HIRE_COST_BASE = 50;
const SEASON_DAYS = 10;
const HISTORY_DAYS = 30;
const JOURNAL_MAX = 100;

// One in-game hour ≈ this many real ms (day cycle 06:00 → 22:00 = 16h).
const HOUR_MS = 750;
// Base MANUAL task durations (in ms) — slow on purpose so equipment matters.
const TASK_MANUAL_MS: Record<TaskKind, number> = {
  prepare: 4 * HOUR_MS,
  plant: 2 * HOUR_MS,
  harvest: 3 * HOUR_MS,
  milk: 2 * HOUR_MS,
  deliver: 2 * HOUR_MS,
};
const EQUIPMENT_PRICES: Record<EquipmentId, number> = { manualPlow: 75, tractor: 300, harvester: 500 };
const EQUIPMENT_LABELS: Record<EquipmentId, string> = { manualPlow: "Manual Plow", tractor: "Tractor", harvester: "Harvester" };

// Night = 20:00 → 06:00. Within one day cycle that's the last 2 of 16 in-game hours.
const NIGHT_START_FRACTION = 14 / 16;

function isNightAt(dayMs: number) {
  return dayMs / DAY_MS >= NIGHT_START_FRACTION;
}

const TRACTOR_PLANT_MAX = 10;
const TRACTOR_PREPARE_MAX = 4;
const HARVESTER_MAX = 4;

function getTaskDuration(kind: TaskKind, equipment: Equipment, tileCount = 1) {
  let ms = TASK_MANUAL_MS[kind];
  if (kind === "prepare") {
    if (equipment.tractor) ms *= 0.25;
    else if (equipment.manualPlow) ms *= 0.65;
  } else if (kind === "harvest") {
    if (equipment.harvester) ms *= 0.25;
  } else if (kind === "plant") {
    if (equipment.tractor) {
      // Tractor seeder: fixed quick per-tile sow so planting 10 tiles
      // (queued one-by-one) totals roughly the same time as planting
      // ~2 tiles by hand. Animation plays tile-by-tile.
      ms = 300;
      void tileCount;
    }
  }
  return Math.max(120, Math.round(ms));
}


type CropDef = {
  id: CropId;
  name: string;
  seedCost: number;
  yield: number;
  basePrice: number;
  stalk: string;
  leaf: string;
  fruit: string;
};

const CROPS: Record<CropId, CropDef> = {
  wheat: { id: "wheat", name: "Wheat", seedCost: 2, yield: 4, basePrice: 3, stalk: "#e3b94a", leaf: "#7ec84a", fruit: "#fcdc70" },
  rice: { id: "rice", name: "Rice", seedCost: 4, yield: 5, basePrice: 4, stalk: "#cfe07a", leaf: "#9ee062", fruit: "#f4f1c1" },
  corn: { id: "corn", name: "Corn", seedCost: 8, yield: 6, basePrice: 7, stalk: "#3aa860", leaf: "#2a7a2a", fruit: "#f5c530" },
  banana: { id: "banana", name: "Banana", seedCost: 15, yield: 8, basePrice: 12, stalk: "#7a4a25", leaf: "#3fa83f", fruit: "#f7d94a" },
};

const CROP_ORDER: CropId[] = ["wheat", "rice", "corn", "banana"];
const SEASON_ORDER: Season[] = ["spring", "summer", "autumn", "winter"];
const SEASON_LABEL: Record<Season, string> = { spring: "Spring", summer: "Summer", autumn: "Autumn", winter: "Winter" };

// Growth days by crop x season
const GROW_DAYS: Record<CropId, Record<Season, number>> = {
  wheat: { spring: 1, summer: 1, autumn: 2, winter: 3 },
  rice: { spring: 2, summer: 1, autumn: 2, winter: 4 },
  corn: { spring: 3, summer: 2, autumn: 4, winter: 6 },
  banana: { spring: 5, summer: 4, autumn: 6, winter: 8 },
};

// Seasonal price modifiers (added to base)
const PRICE_MOD: Record<CropId, Record<Season, number>> = {
  wheat: { spring: 0, summer: -1, autumn: 1, winter: 3 },
  rice: { spring: 2, summer: 1, autumn: 0, winter: -1 },
  corn: { spring: 0, summer: 2, autumn: 1, winter: -2 },
  banana: { spring: -1, summer: 3, autumn: 2, winter: 0 },
};

function seasonForDay(day: number): Season {
  const idx = Math.floor((day - 1) / SEASON_DAYS) % SEASON_ORDER.length;
  return SEASON_ORDER[(idx + SEASON_ORDER.length) % SEASON_ORDER.length];
}

function cropPriceFor(crop: CropId, season: Season, fluct: number) {
  return Math.max(1, CROPS[crop].basePrice + PRICE_MOD[crop][season] + fluct);
}

function cropGrowMs(crop: CropId, season: Season) {
  return GROW_DAYS[crop][season] * DAY_MS;
}

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

const SEASON_TINT: Record<Season, string> = {
  spring: "#9ee062",
  summer: "#3aa860",
  autumn: "#e08a3a",
  winter: "#cfe9f5",
};

const TASK_LABELS: Record<TaskKind, string> = {
  prepare: "Prepare Soil",
  plant: "Plant",
  harvest: "Harvest",
  deliver: "Deliver Goods",
  milk: "Milk Cow",
};

const MILK_BASE_PRICE = 5;
const MILK_PRICE_MOD: Record<Season, number> = { spring: 0, summer: -1, autumn: 1, winter: 2 };
const MILK_YIELD = 2;

function milkPriceFor(season: Season, fluct: number) {
  return Math.max(1, MILK_BASE_PRICE + MILK_PRICE_MOD[season] + fluct);
}

function productPriceFor(id: ProductId, season: Season, fluct: number) {
  if (id === "milk") return milkPriceFor(season, fluct);
  return cropPriceFor(id, season, fluct);
}

function productName(id: ProductId) {
  if (id === "milk") return "Milk";
  return CROPS[id].name;
}

const PRODUCT_ORDER: ProductId[] = ["wheat", "rice", "corn", "banana", "milk"];

function px(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string) {
  ctx.fillStyle = color;
  ctx.fillRect(x | 0, y | 0, w | 0, h | 0);
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function emptyInventory(): Inventory {
  return { wheat: 0, rice: 0, corn: 0, banana: 0, milk: 0 };
}

function emptySeeds(): Record<CropId, number> {
  return { wheat: 0, rice: 0, corn: 0, banana: 0 };
}

function createFields(): Field[] {
  const w = FIELD_AREA.x1 - FIELD_AREA.x0 + 1;
  const h = FIELD_AREA.y1 - FIELD_AREA.y0 + 1;
  return Array.from({ length: w * h }, () => ({ state: "empty" as FieldState, growth: 0, growMs: 0, crop: null }));
}

function makeWorker(id: string, name: string, x: number, y: number, hair: string, shirt: string): Worker {
  return { id, name, x, y, task: null, queue: [], facing: "down", workTimer: 0, workTotal: 0, walkPhase: 0, hair, shirt };
}

function workerStatus(worker: Worker, isNight: boolean) {
  if (worker.task) return worker.workTimer > 0 ? "Busy" : "Moving";
  if (isNight) return worker.queue.length > 0 ? "Resting (resumes 06:00)" : "Sleeping";
  return "Idle";
}

function taskName(task: Task | null) {
  if (!task) return "Idle";
  if (task.kind === "plant" && task.crop) return `Plant ${CROPS[task.crop].name}`;
  if (task.kind === "harvest" && task.crop) return `Harvest ${CROPS[task.crop].name}`;
  return TASK_LABELS[task.kind];
}

function drawGrassTile(ctx: CanvasRenderingContext2D, x: number, y: number, seed: number, season: Season) {
  const base = season === "winter" ? "#cfe1ea" : season === "autumn" ? "#a8b85a" : COLORS.grass;
  const dark = season === "winter" ? "#9fb8c4" : season === "autumn" ? "#7a8a3a" : COLORS.grassDark;
  const light = season === "winter" ? "#e6f0f5" : season === "autumn" ? "#c8d070" : COLORS.grassLight;
  px(ctx, x, y, TILE, TILE, base);
  const a = (seed * 9301 + 49297) % 233280;
  const r1 = (a >> 2) % TILE;
  const r2 = (a >> 5) % TILE;
  px(ctx, x + r1, y + r2, 2, 2, dark);
  px(ctx, x + ((r1 + 11) % TILE), y + ((r2 + 7) % TILE), 2, 1, light);
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

function stageHeight(state: FieldState) {
  switch (state) {
    case "planted": return 3;
    case "growing1": return 8;
    case "growing2": return 13;
    case "growing3": return 18;
    case "ready": return 22;
    default: return 0;
  }
}

function drawCrop(ctx: CanvasRenderingContext2D, x: number, y: number, state: FieldState, crop: CropId) {
  drawSoilTile(ctx, x, y, true);
  const def = CROPS[crop];
  const h = stageHeight(state);
  const ready = state === "ready";

  if (crop === "banana") {
    px(ctx, x + TILE / 2 - 1, y + 28 - h, 2, h, def.stalk);
    const crown = Math.max(2, Math.floor(h / 2));
    px(ctx, x + TILE / 2 - crown, y + 28 - h - 3, crown * 2, 3, def.leaf);
    px(ctx, x + TILE / 2 - crown - 2, y + 28 - h - 1, crown * 2 + 4, 2, def.leaf);
    if (ready) {
      px(ctx, x + TILE / 2 - 4, y + 28 - h + 2, 3, 5, def.fruit);
      px(ctx, x + TILE / 2 + 1, y + 28 - h + 2, 3, 5, def.fruit);
    }
  } else if (crop === "corn") {
    for (let i = 0; i < 3; i += 1) {
      const sx = x + 8 + i * 8;
      px(ctx, sx, y + 28 - h, 2, h, def.stalk);
      px(ctx, sx - 3, y + 26 - h, 8, 3, def.leaf);
      if (ready) px(ctx, sx, y + 22 - h, 2, 5, def.fruit);
    }
  } else {
    for (let i = 0; i < 4; i += 1) {
      const sx = x + 6 + i * 6;
      px(ctx, sx, y + 26 - h, 1, h, ready ? def.stalk : def.leaf);
      px(ctx, sx - 2, y + 25 - h, 5, ready ? 6 : 3, ready ? def.fruit : def.leaf);
    }
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

// Simple, cozy pixelart farmhouse — designed to be the starter house.
// Future upgrades can swap this function for larger / fancier variants.
function drawFarmhouse(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  // ground shadow
  px(ctx, x + 6, y + h - 3, w - 12, 3, COLORS.shadow);

  // walls
  const wallTop = y + Math.floor(h * 0.42);
  const wallBottom = y + h - 4;
  const wallLeft = x + 6;
  const wallRight = x + w - 6;
  const wallW = wallRight - wallLeft;
  const wallH = wallBottom - wallTop;
  px(ctx, wallLeft, wallTop, wallW, wallH, COLORS.woodLight);
  // wood plank lines
  for (let i = 6; i < wallH; i += 6) {
    px(ctx, wallLeft, wallTop + i, wallW, 1, COLORS.wood);
  }
  // foundation
  px(ctx, wallLeft - 1, wallBottom, wallW + 2, 4, COLORS.stoneDark);
  px(ctx, wallLeft - 1, wallBottom, wallW + 2, 1, COLORS.stone);

  // roof — triangular with eaves
  const roofBaseY = wallTop;
  const roofTopY = y + 2;
  const roofH = roofBaseY - roofTopY;
  const eaves = 4;
  for (let r = 0; r < roofH; r += 1) {
    const t = r / roofH;
    const inset = Math.floor(t * (wallW / 2 + eaves));
    const rx = wallLeft - eaves + inset;
    const rw = (wallW + eaves * 2) - inset * 2;
    px(ctx, rx, roofTopY + r, rw, 1, r < 2 ? COLORS.roofDark : COLORS.roof);
  }
  // roof highlight line
  for (let r = 2; r < roofH; r += 4) {
    const t = r / roofH;
    const inset = Math.floor(t * (wallW / 2 + eaves));
    px(ctx, wallLeft - eaves + inset, roofTopY + r, 2, 1, COLORS.roofLight);
  }

  // chimney
  const chimX = wallLeft + Math.floor(wallW * 0.72);
  const chimTop = roofTopY + 2;
  px(ctx, chimX, chimTop, 5, Math.max(6, roofH - 2), COLORS.stoneDark);
  px(ctx, chimX, chimTop, 5, 2, COLORS.stone);
  // gentle smoke puffs
  px(ctx, chimX + 1, chimTop - 3, 3, 2, "#f0f0f0");
  px(ctx, chimX + 2, chimTop - 6, 3, 2, "#e0e0e0");

  // door
  const doorW = 8;
  const doorH = Math.min(wallH - 4, 14);
  const doorX = wallLeft + Math.floor(wallW / 2) - Math.floor(doorW / 2);
  const doorY = wallBottom - doorH;
  px(ctx, doorX, doorY, doorW, doorH, COLORS.woodDark);
  px(ctx, doorX + 1, doorY + 1, doorW - 2, doorH - 1, COLORS.wood);
  px(ctx, doorX + doorW - 3, doorY + Math.floor(doorH / 2), 1, 1, "#f7d94a"); // knob
  // small step
  px(ctx, doorX - 1, wallBottom, doorW + 2, 1, COLORS.stone);

  // windows
  const winY = wallTop + 4;
  const winSize = 6;
  const winLeftX = wallLeft + 4;
  const winRightX = wallRight - 4 - winSize;
  for (const wx of [winLeftX, winRightX]) {
    px(ctx, wx - 1, winY - 1, winSize + 2, winSize + 2, COLORS.woodDark);
    px(ctx, wx, winY, winSize, winSize, "#bfe6ff");
    px(ctx, wx, winY, winSize, 2, "#7fbde0");
    px(ctx, wx + Math.floor(winSize / 2), winY, 1, winSize, COLORS.woodDark);
    px(ctx, wx, winY + Math.floor(winSize / 2), winSize, 1, COLORS.woodDark);
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

// Big landmark tree — drawn spanning 2 tiles wide x 3 tiles tall,
// anchored so trunk base sits on (tx, ty+2).
function drawSeasonTree(ctx: CanvasRenderingContext2D, tx: number, ty: number, season: Season, time: number) {
  const baseX = tx * TILE + TILE; // center of 2-tile wide
  const baseY = (ty + 2) * TILE + TILE - 2; // ground line
  // shadow
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(baseX, baseY + 2, 22, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // trunk
  const trunkH = 28;
  const trunkW = 8;
  px(ctx, baseX - trunkW / 2, baseY - trunkH, trunkW, trunkH, COLORS.wood);
  px(ctx, baseX - trunkW / 2, baseY - trunkH, 2, trunkH, COLORS.woodDark);
  px(ctx, baseX + 1, baseY - 18, 2, 4, COLORS.woodDark);

  const canopyCY = baseY - trunkH - 14;
  const canopyR = 26;

  if (season === "winter") {
    // bare branches
    ctx.strokeStyle = COLORS.woodDark;
    ctx.lineWidth = 2;
    for (const ang of [-1.1, -0.6, -0.1, 0.4, 0.9, 1.3]) {
      ctx.beginPath();
      ctx.moveTo(baseX, baseY - trunkH + 4);
      ctx.lineTo(baseX + Math.cos(ang) * 22, canopyCY + Math.sin(ang) * 12);
      ctx.stroke();
    }
    // few residual leaves + snow caps
    px(ctx, baseX - 14, canopyCY - 4, 3, 3, "#7a4a2a");
    px(ctx, baseX + 10, canopyCY + 2, 3, 3, "#7a4a2a");
    // snow on ground around trunk
    px(ctx, baseX - 18, baseY - 2, 36, 3, "#f4fbff");
    // snow flecks
    for (let i = 0; i < 5; i += 1) {
      px(ctx, baseX - 18 + i * 8, canopyCY - 10 + ((i * 5) % 14), 2, 2, "#ffffff");
    }
  } else {
    // canopy color per season
    let leaf = "#3aa860";
    let leafDark = COLORS.leafDark;
    let leafLight = "#9ee062";
    if (season === "spring") { leaf = "#7fd86a"; leafDark = "#3a9a3a"; leafLight = "#c6f06a"; }
    if (season === "summer") { leaf = "#2f9a48"; leafDark = "#1c6a2c"; leafLight = "#62c46a"; }
    if (season === "autumn") { leaf = "#e08a3a"; leafDark = "#a04a18"; leafLight = "#f5c43a"; }

    // main canopy — soft pixel blobs
    const sway = Math.sin(time * 0.0015) * 1.2;
    const drawBlob = (cx: number, cy: number, r: number, c: string) => {
      for (let dy = -r; dy <= r; dy += 2) {
        const w = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy))) * 2;
        px(ctx, cx - w / 2, cy + dy, w, 2, c);
      }
    };
    drawBlob(baseX + sway, canopyCY, canopyR, leafDark);
    drawBlob(baseX - 10 + sway, canopyCY - 4, 16, leaf);
    drawBlob(baseX + 10 + sway, canopyCY + 2, 18, leaf);
    drawBlob(baseX + sway, canopyCY - 10, 14, leafLight);

    if (season === "spring") {
      // pink flowers
      for (const [dx, dy] of [[-12, -4], [-2, 6], [10, -2], [16, 6], [-18, 4], [4, -10]]) {
        px(ctx, baseX + dx, canopyCY + dy, 3, 3, "#f7a8c8");
        px(ctx, baseX + dx + 1, canopyCY + dy + 1, 1, 1, "#fcdc70");
      }
    }
    if (season === "autumn") {
      // red accent leaves + falling
      for (const [dx, dy] of [[-14, 2], [12, -6], [-4, 10], [18, 0]]) {
        px(ctx, baseX + dx, canopyCY + dy, 3, 3, "#c83a2a");
      }
      const fall = (time * 0.04) % 40;
      px(ctx, baseX - 16, baseY - 30 - fall + 40, 2, 2, "#e08a3a");
      px(ctx, baseX + 14, baseY - 20 - ((fall + 20) % 40) + 40, 2, 2, "#c83a2a");
      px(ctx, baseX - 4, baseY - 10 - ((fall + 10) % 40) + 40, 2, 2, "#f5c43a");
    }
  }
}

function drawMilkingParlor(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  // grassy paddock
  px(ctx, x + 2, y + 2, w - 4, h - 4, "#a9d86a");
  // wooden fence posts + rails
  ctx.fillStyle = COLORS.wood;
  for (let i = 0; i <= w; i += 12) px(ctx, x + i, y, 2, h, COLORS.wood);
  px(ctx, x, y + 4, w, 2, COLORS.woodLight);
  px(ctx, x, y + h - 6, w, 2, COLORS.woodLight);
  // gate
  px(ctx, x + Math.floor(w / 2) - 6, y + h - 8, 12, 8, COLORS.woodDark);
  // milk bucket icon corner
  px(ctx, x + 4, y + 6, 7, 8, COLORS.stone);
  px(ctx, x + 4, y + 6, 7, 2, COLORS.white);
  px(ctx, x + 3, y + 5, 9, 2, COLORS.stoneDark);
}

function drawCow(ctx: CanvasRenderingContext2D, cx: number, cy: number, milked: boolean, time: number) {
  const bob = Math.floor(time * 0.004) % 2;
  // shadow
  ctx.fillStyle = COLORS.shadow;
  ctx.beginPath();
  ctx.ellipse(cx, cy + 6, 12, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  // body
  px(ctx, cx - 10, cy - 6 - bob, 20, 10, COLORS.white);
  // spots
  px(ctx, cx - 7, cy - 4 - bob, 4, 4, COLORS.black);
  px(ctx, cx + 2, cy - 2 - bob, 5, 4, COLORS.black);
  // legs
  px(ctx, cx - 8, cy + 3, 3, 4, COLORS.white);
  px(ctx, cx + 5, cy + 3, 3, 4, COLORS.white);
  // head
  px(ctx, cx - 14, cy - 4 - bob, 6, 6, COLORS.white);
  px(ctx, cx - 15, cy - 6 - bob, 2, 2, COLORS.woodDark); // horn
  px(ctx, cx - 9, cy - 6 - bob, 2, 2, COLORS.woodDark);
  px(ctx, cx - 13, cy - 2 - bob, 1, 1, COLORS.black); // eye
  // udder
  px(ctx, cx, cy + 3, 4, 3, milked ? "#e8a8b8" : "#f7c8d4");
  // status label
  ctx.font = "8px 'Press Start 2P', monospace";
  ctx.textAlign = "center";
  const label = milked ? "Milked today" : "Cow ready";
  px(ctx, cx - label.length * 3 - 4, cy - 22, label.length * 6 + 8, 10, COLORS.black);
  ctx.fillStyle = milked ? "#c8c8c8" : COLORS.selected;
  ctx.fillText(label, cx, cy - 14);
  ctx.textAlign = "left";
}

function drawWorker(ctx: CanvasRenderingContext2D, worker: Worker, isSelected: boolean, onTruck = false, taskKind?: TaskKind) {
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

  if (onTruck) drawTractorPlantOverlay(ctx, worker, taskKind === "plant");
}

function drawTractorPlantOverlay(ctx: CanvasRenderingContext2D, worker: Worker, withSeeds = true) {
  const x = worker.x | 0;
  const y = worker.y | 0;
  const phase = (worker.walkPhase * 0.6) % (Math.PI * 2);
  const wheelBob = Math.sin(phase * 4) > 0 ? 0 : 1;

  // Tractor body behind/around the worker
  // Red chassis
  px(ctx, x - 12, y - 10, 8, 8, "#c0392b");
  px(ctx, x - 11, y - 11, 6, 2, "#a83224");
  // Engine block
  px(ctx, x - 13, y - 7, 2, 4, "#7a2418");
  // Exhaust stack with puff
  px(ctx, x - 10, y - 16, 2, 5, "#2c2c2c");
  const puffR = 2 + Math.sin(phase * 2) * 0.8;
  ctx.fillStyle = "rgba(180,180,180,0.7)";
  ctx.beginPath();
  ctx.arc(x - 9, y - 18 - puffR, puffR, 0, Math.PI * 2);
  ctx.fill();
  // Wheels
  px(ctx, x - 13, y - 2 + wheelBob, 4, 4, "#1a1a1a");
  px(ctx, x - 6, y - 2 + wheelBob, 4, 4, "#1a1a1a");
  px(ctx, x - 12, y - 1 + wheelBob, 2, 2, "#f5c530");
  px(ctx, x - 5, y - 1 + wheelBob, 2, 2, "#f5c530");

  // Seed hopper behind worker (above shoulders)
  px(ctx, x + 2, y - 18, 7, 5, "#6b4a2b");
  px(ctx, x + 2, y - 19, 7, 1, "#4a3220");

  if (withSeeds) {
    // Scattering seeds — animated falling specks ahead of tractor
    const seedColors = ["#f5c530", "#e8a93a", "#c98a1a"];
    for (let i = 0; i < 5; i++) {
      const t = (phase + i * 1.1) % (Math.PI * 2);
      const sx = x + 4 + Math.cos(t) * 6;
      const sy = y + 2 + ((t * 3) % 6);
      px(ctx, sx | 0, sy | 0, 1, 1, seedColors[i % seedColors.length]);
    }
  }
}

export default function KidFarmGame() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const nextTaskId = useRef(1);
  const farmhouseImgRef = useRef<HTMLImageElement | null>(null);
  const farmhouseLoadedRef = useRef(false);

  const initialSeason = seasonForDay(1);
  const initialFluct: Record<ProductId, number> = { wheat: 0, rice: 0, corn: 0, banana: 0, milk: 0 };
  const initialHistory: Record<ProductId, { day: number; price: number }[]> = {
    wheat: [{ day: 1, price: cropPriceFor("wheat", initialSeason, 0) }],
    rice: [{ day: 1, price: cropPriceFor("rice", initialSeason, 0) }],
    corn: [{ day: 1, price: cropPriceFor("corn", initialSeason, 0) }],
    banana: [{ day: 1, price: cropPriceFor("banana", initialSeason, 0) }],
    milk: [{ day: 1, price: milkPriceFor(initialSeason, 0) }],
  };

  const initialState = () => ({
    coins: 25,
    seeds: { ...emptySeeds(), wheat: 5 } as Record<CropId, number>,
    harvested: emptyInventory(),
    revenue: 0,
    expenses: 0,
    dayMs: 0,
    day: 1,
    season: initialSeason,
    fluct: { ...initialFluct },
    history: initialHistory,
    journal: [{ day: 1, season: initialSeason, text: `${SEASON_LABEL[initialSeason]} has arrived` }] as JournalEntry[],
    seasonBanner: { text: `${SEASON_LABEL[initialSeason]} has arrived`, age: 0, ttl: 3500 },
    fields: createFields(),
    workers: [makeWorker("maya", "Maya", 10 * TILE + TILE / 2, 4 * TILE + TILE / 2, COLORS.hairBlonde, COLORS.shirtRed)],
    selectedWorkerId: "maya",
    cow: { x: COW_TILE.x * TILE + TILE / 2, y: COW_TILE.y * TILE + TILE / 2, lastMilkedDay: 0 } as Cow,
    equipment: { manualPlow: false, tractor: false, harvester: false } as Equipment,
    isNight: false,
  });

  const stateRef = useRef({
    ...initialState(),
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
    seeds: { ...emptySeeds(), wheat: 5 } as Record<CropId, number>,
    harvested: emptyInventory(),
    revenue: 0,
    expenses: 0,
    day: 1,
    time: "06:00",
    season: initialSeason as Season,
    prices: {
      wheat: cropPriceFor("wheat", initialSeason, 0),
      rice: cropPriceFor("rice", initialSeason, 0),
      corn: cropPriceFor("corn", initialSeason, 0),
      banana: cropPriceFor("banana", initialSeason, 0),
      milk: milkPriceFor(initialSeason, 0),
    } as Record<ProductId, number>,
    selectedWorkerId: "maya",
    selectedWorkerName: "Maya",
    selectedStatus: "Idle",
    selectedCurrentTask: "Idle",
    selectedQueueLength: 0,
    workers: [{ id: "maya", name: "Maya", status: "Idle", currentTask: "Idle", queueLength: 0, isSelected: true }] as WorkerUi[],
    message: "Selected Worker: Maya. Click soil to prepare it.",
    banner: { text: `${SEASON_LABEL[initialSeason]} has arrived`, visible: true },
    cowReady: true,
    isNight: false,
    equipment: { manualPlow: false, tractor: false, harvester: false } as Equipment,
  });

  const [plantPrompt, setPlantPrompt] = useState<{ tx: number; ty: number } | null>(null);
  const [shopOpen, setShopOpen] = useState(false);
  const [shopTab, setShopTab] = useState<"seeds" | "equipment" | "pesticides" | "land">("seeds");
  const [marketOpen, setMarketOpen] = useState(false);
  const [journalOpen, setJournalOpen] = useState(false);

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

  function logJournal(text: string) {
    const s = stateRef.current;
    s.journal.unshift({ day: s.day, season: s.season, text });
    if (s.journal.length > JOURNAL_MAX) s.journal.length = JOURNAL_MAX;
  }

  function currentPrice(crop: CropId) {
    const s = stateRef.current;
    return cropPriceFor(crop, s.season, s.fluct[crop]);
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
    setMessage(`${taskName(command as Task)} queued for ${worker.name}.`);
    syncUi(true);
  }

  function totalHarvested(inv: Inventory) {
    return PRODUCT_ORDER.reduce((sum, c) => sum + inv[c], 0);
  }

  function inMilkingParlor(tx: number, ty: number) {
    return tx >= MILKING_PARLOR.x && tx < MILKING_PARLOR.x + MILKING_PARLOR.w
      && ty >= MILKING_PARLOR.y && ty < MILKING_PARLOR.y + MILKING_PARLOR.h;
  }

  function getAffectedTiles(kind: TaskKind, tx: number, ty: number, crop?: CropId): { tx: number; ty: number }[] {
    const s = stateRef.current;
    // For plant/prepare/harvest with the right vehicle, BFS outward from the
    // clicked tile and collect up to N tiles matching the required state.
    // This finds the N CLOSEST eligible tiles rather than a rigid 2x2 box.
    let maxN = 1;
    let want: FieldState | null = null;
    if (kind === "plant") {
      if (!s.equipment.tractor || !crop) return [{ tx, ty }];
      const seedsAvail = s.seeds[crop] ?? 0;
      maxN = Math.min(TRACTOR_PLANT_MAX, seedsAvail);
      want = "prepared";
    } else if (kind === "prepare") {
      if (!s.equipment.tractor) return [{ tx, ty }];
      maxN = TRACTOR_PREPARE_MAX;
      want = "empty";
    } else if (kind === "harvest") {
      if (!s.equipment.harvester) return [{ tx, ty }];
      maxN = HARVESTER_MAX;
      want = "ready";
    } else {
      return [{ tx, ty }];
    }
    if (maxN <= 0) return [];
    const list: { tx: number; ty: number }[] = [];
    const seen = new Set<string>();
    const queue: { tx: number; ty: number }[] = [{ tx, ty }];
    while (queue.length > 0 && list.length < maxN) {
      const cur = queue.shift()!;
      const key = `${cur.tx},${cur.ty}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!inField(cur.tx, cur.ty)) continue;
      const f = s.fields[fieldIdx(cur.tx, cur.ty)];
      if (f.state === want && (kind !== "harvest" || f.crop)) list.push(cur);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        queue.push({ tx: cur.tx + dx, ty: cur.ty + dy });
      }
    }
    return list;
  }

  const handleTileClick = useCallback((tx: number, ty: number) => {
    const s = stateRef.current;
    if (tx === SHIPPING_BIN.x && ty === SHIPPING_BIN.y) {
      if (totalHarvested(s.harvested) <= 0) {
        setMessage("No harvested goods to ship.");
        return;
      }
      assignTask({ kind: "deliver", tx, ty });
      return;
    }
    if (inMilkingParlor(tx, ty)) {
      if (s.isNight) {
        setMessage("The cow is sleeping. Come back in the morning.");
        return;
      }
      if (s.cow.lastMilkedDay === s.day) {
        setMessage("The cow has already been milked today.");
        return;
      }
      assignTask({ kind: "milk", tx: COW_TILE.x, ty: COW_TILE.y });
      return;
    }
    if (!inField(tx, ty)) {
      setMessage("Click a worker to select, then click soil tiles, the cow, or the shipping bin.");
      return;
    }
    if (s.isNight) {
      setMessage("Workers are sleeping. Work resumes at 06:00.");
      return;
    }
    const field = s.fields[fieldIdx(tx, ty)];
    if (field.state === "empty") {
      const tiles = getAffectedTiles("prepare", tx, ty);
      if (s.equipment.tractor && tiles.length > 1) {
        queuePerTile(tiles.map((t) => ({ kind: "prepare", tx: t.tx, ty: t.ty })), `Tractor preparing ${tiles.length} tiles`);
      } else {
        assignTask({ kind: "prepare", tx, ty, tiles });
      }
    } else if (field.state === "prepared") {
      setPlantPrompt({ tx, ty });
    } else if (field.state === "ready" && field.crop) {
      const tiles = getAffectedTiles("harvest", tx, ty);
      if (s.equipment.harvester && tiles.length > 1) {
        queuePerTile(
          tiles.map((t) => ({ kind: "harvest", tx: t.tx, ty: t.ty, crop: s.fields[fieldIdx(t.tx, t.ty)].crop ?? field.crop ?? undefined })),
          `Harvester collecting ${tiles.length} tiles`,
        );
      } else {
        assignTask({ kind: "harvest", tx, ty, crop: field.crop, tiles });
      }
    } else {
      setMessage("This crop is still growing.");
    }
  }, [setMessage]);

  function queuePerTile(tasks: Omit<Task, "id">[], message: string) {
    const worker = selectedWorker();
    for (const t of tasks) {
      worker.queue.push({ ...t, id: nextTaskId.current } as Task);
      nextTaskId.current += 1;
    }
    setMessage(`${message} queued for ${worker.name}.`);
    syncUi(true);
  }

  function choosePlant(crop: CropId) {
    const prompt = plantPrompt;
    setPlantPrompt(null);
    if (!prompt) return;
    const s = stateRef.current;
    if (s.seeds[crop] <= 0) {
      setMessage(`Not enough seeds. Buy ${CROPS[crop].name} seeds first.`);
      return;
    }
    const tiles = getAffectedTiles("plant", prompt.tx, prompt.ty, crop);
    if (s.equipment.tractor && tiles.length > 1) {
      queuePerTile(
        tiles.map((t) => ({ kind: "plant", tx: t.tx, ty: t.ty, crop })),
        `Tractor sowing ${tiles.length} × ${CROPS[crop].name}`,
      );
      logJournal(`Tractor sowing ${tiles.length} × ${CROPS[crop].name} (${GROW_DAYS[crop][s.season]}d)`);
    } else {
      assignTask({ kind: "plant", tx: prompt.tx, ty: prompt.ty, crop, tiles });
    }
  }

  function completeTask(worker: Worker) {
    const s = stateRef.current;
    const task = worker.task;
    if (!task) return;

    if (task.kind === "deliver") {
      let total = 0;
      for (const id of PRODUCT_ORDER) {
        const qty = s.harvested[id];
        if (qty <= 0) continue;
        const price = id === "milk" ? milkPriceFor(s.season, s.fluct.milk) : currentPrice(id);
        const earn = qty * price;
        total += earn;
        s.harvested[id] = 0;
        logJournal(`Sold ${qty} ${productName(id)} for ${price}c each (+${earn}c)`);
      }
      s.coins += total;
      s.revenue += total;
      addFloater(worker.x, worker.y - 24, `+${total}c`, "#f5c530");
      return;
    }

    if (task.kind === "milk") {
      if (s.cow.lastMilkedDay === s.day) {
        setMessage("The cow has already been milked today.");
        return;
      }
      s.cow.lastMilkedDay = s.day;
      s.harvested.milk += MILK_YIELD;
      addFloater(worker.x, worker.y - 24, `+${MILK_YIELD} Milk`, "#fdf6e3");
      logJournal(`${worker.name} milked the cow (+${MILK_YIELD} Milk)`);
      return;
    }

    if (!inField(task.tx, task.ty)) return;
    const tiles = task.tiles && task.tiles.length > 0 ? task.tiles : [{ tx: task.tx, ty: task.ty }];

    if (task.kind === "prepare") {
      let prepared = 0;
      for (const t of tiles) {
        const f = s.fields[fieldIdx(t.tx, t.ty)];
        if (f.state === "empty") { f.state = "prepared"; prepared += 1; }
      }
      if (prepared > 1) logJournal(`Tractor prepared ${prepared} tiles`);
    } else if (task.kind === "plant") {
      if (!task.crop) return;
      const crop = task.crop;
      let planted = 0;
      for (const t of tiles) {
        if (s.seeds[crop] <= 0) break;
        const f = s.fields[fieldIdx(t.tx, t.ty)];
        if (f.state !== "prepared") continue;
        f.state = "planted";
        f.growth = 0;
        f.crop = crop;
        f.growMs = cropGrowMs(crop, s.season);
        s.seeds[crop] -= 1;
        planted += 1;
      }
      if (planted > 1) logJournal(`Tractor sowed ${planted} × ${CROPS[crop].name} (${GROW_DAYS[crop][s.season]}d)`);
      else if (planted === 1 && !s.equipment.tractor) logJournal(`Planted ${CROPS[crop].name} (${GROW_DAYS[crop][s.season]}d)`);
    } else if (task.kind === "harvest") {
      const totals: Partial<Record<CropId, number>> = {};
      for (const t of tiles) {
        const f = s.fields[fieldIdx(t.tx, t.ty)];
        if (f.state === "ready" && f.crop) {
          const def = CROPS[f.crop];
          s.harvested[f.crop] += def.yield;
          totals[f.crop] = (totals[f.crop] ?? 0) + def.yield;
          f.state = "empty"; f.growth = 0; f.growMs = 0; f.crop = null;
        }
      }
      for (const c of Object.keys(totals) as CropId[]) {
        addFloater(worker.x, worker.y - 24, `+${totals[c]} ${CROPS[c].name}`, CROPS[c].fruit);
        logJournal(`Harvested ${totals[c]} ${CROPS[c].name}${tiles.length > 1 ? " (Harvester)" : ""}`);
      }
    }
  }

  // ----- Save / Load / Reset -----
  function serializeState() {
    const s = stateRef.current;
    return {
      v: 1,
      coins: s.coins,
      seeds: s.seeds,
      harvested: s.harvested,
      revenue: s.revenue,
      expenses: s.expenses,
      dayMs: s.dayMs,
      day: s.day,
      season: s.season,
      fluct: s.fluct,
      history: s.history,
      journal: s.journal,
      fields: s.fields,
      workers: s.workers.map((w) => ({
        id: w.id, name: w.name, x: w.x, y: w.y, hair: w.hair, shirt: w.shirt,
        facing: w.facing,
        queue: w.queue,
        task: w.task,
      })),
      selectedWorkerId: s.selectedWorkerId,
      cow: s.cow,
      equipment: s.equipment,
      nextTaskId: nextTaskId.current,
    };
  }

  function saveGame() {
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(serializeState())); } catch { /* ignore */ }
  }

  function loadGame(): boolean {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1) return false;
      const s = stateRef.current;
      s.coins = data.coins; s.seeds = { ...emptySeeds(), ...data.seeds };
      s.harvested = { ...emptyInventory(), ...data.harvested };
      s.revenue = data.revenue; s.expenses = data.expenses;
      s.dayMs = data.dayMs; s.day = data.day; s.season = data.season;
      s.fluct = { wheat: 0, rice: 0, corn: 0, banana: 0, milk: 0, ...data.fluct };
      s.history = { ...s.history, ...data.history };
      if (!s.history.milk) s.history.milk = [{ day: s.day, price: milkPriceFor(s.season, 0) }];
      s.journal = data.journal ?? [];
      s.fields = data.fields ?? createFields();
      s.workers = (data.workers ?? []).map((w: { id: string; name: string; x: number; y: number; hair: string; shirt: string; facing?: Facing; queue?: Task[]; task?: Task | null }) => ({
        id: w.id, name: w.name, x: w.x, y: w.y, hair: w.hair, shirt: w.shirt,
        facing: (w.facing ?? "down") as Facing, queue: w.queue ?? [], task: w.task ?? null,
        workTimer: 0, workTotal: 0, walkPhase: 0,
      }));
      if (s.workers.length === 0) {
        s.workers = [makeWorker("maya", "Maya", 10 * TILE + TILE / 2, 4 * TILE + TILE / 2, COLORS.hairBlonde, COLORS.shirtRed)];
      }
      s.selectedWorkerId = data.selectedWorkerId ?? s.workers[0].id;
      s.cow = data.cow ?? { x: COW_TILE.x * TILE + TILE / 2, y: COW_TILE.y * TILE + TILE / 2, lastMilkedDay: 0 };
      s.equipment = { manualPlow: false, tractor: false, harvester: false, ...(data.equipment ?? {}) };
      nextTaskId.current = data.nextTaskId ?? 1;
      s.seasonBanner = { text: "", age: 9999, ttl: 1 };
      syncUi(true);
      setUi((c) => ({ ...c, banner: { ...c.banner, visible: false } }));
      return true;
    } catch { return false; }
  }

  function resetGame() {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    const init = initialState();
    const s = stateRef.current;
    Object.assign(s, init);
    nextTaskId.current = 1;
    setUi((c) => ({ ...c, message: "Game reset.", banner: { text: `${SEASON_LABEL[init.season]} has arrived`, visible: true } }));
    syncUi(true);
  }

  useEffect(() => {
    loadGame();
    const interval = window.setInterval(saveGame, 10_000);
    const onHide = () => { if (document.visibilityState === "hidden") saveGame(); };
    const onBeforeUnload = () => saveGame();
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
      saveGame();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const img = new Image();
    img.src = "/src/assets/buildings/farmhouse.png";
    img.onload = () => {
      farmhouseImgRef.current = img;
      farmhouseLoadedRef.current = true;
    };
    img.onerror = () => {
      farmhouseLoadedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const s = stateRef.current;
      const dt = Math.min(50, now - s.lastTime);
      s.lastTime = now;
      update(dt);
      draw(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  function rollFluctuations() {
    const s = stateRef.current;
    for (const id of PRODUCT_ORDER) {
      s.fluct[id] = Math.floor(Math.random() * 3) - 1; // -1, 0, +1
    }
  }

  function recordPriceHistory() {
    const s = stateRef.current;
    for (const id of PRODUCT_ORDER) {
      const arr = s.history[id];
      const price = id === "milk" ? milkPriceFor(s.season, s.fluct.milk) : cropPriceFor(id, s.season, s.fluct[id]);
      arr.push({ day: s.day, price });
      if (arr.length > HISTORY_DAYS) arr.splice(0, arr.length - HISTORY_DAYS);
    }
  }

  function update(dt: number) {
    const s = stateRef.current;
    s.dayMs += dt;
    if (s.dayMs >= DAY_MS) {
      s.dayMs -= DAY_MS;
      s.day += 1;
      s.coins -= DAILY_COST;
      s.expenses += DAILY_COST;
      addFloater(SHIPPING_BIN.x * TILE + TILE / 2, SHIPPING_BIN.y * TILE - 10, `-${DAILY_COST}c daily`, COLORS.shirtRed);

      const newSeason = seasonForDay(s.day);
      if (newSeason !== s.season) {
        s.season = newSeason;
        const text = `${SEASON_LABEL[newSeason]} has arrived`;
        s.seasonBanner = { text, age: 0, ttl: 3500 };
        logJournal(text);
        setUi((c) => ({ ...c, banner: { text, visible: true } }));
      }

      rollFluctuations();
      recordPriceHistory();
    }

    const nightNow = isNightAt(s.dayMs);
    if (nightNow !== s.isNight) {
      s.isNight = nightNow;
      if (nightNow) logJournal("Workers stopped for the night (20:00)");
      else logJournal("Workers resumed in the morning (06:00)");
    }

    if (s.seasonBanner) {
      s.seasonBanner.age += dt;
      if (s.seasonBanner.age >= s.seasonBanner.ttl && ui.banner.visible) {
        setUi((c) => (c.banner.visible ? { ...c, banner: { ...c.banner, visible: false } } : c));
      }
    }

    for (const field of s.fields) {
      if (!field.crop) continue;
      if (["planted", "growing1", "growing2", "growing3"].includes(field.state)) {
        field.growth += dt;
        const total = field.growMs || cropGrowMs(field.crop, s.season);
        const step = total / 4;
        if (field.growth >= step * 4) field.state = "ready";
        else if (field.growth >= step * 3) field.state = "growing3";
        else if (field.growth >= step * 2) field.state = "growing2";
        else if (field.growth >= step) field.state = "growing1";
      }
    }

    for (const worker of s.workers) {
      if (!worker.task && worker.queue.length > 0 && !s.isNight) {
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
        if (worker.workTimer === 0) {
          const tileCount = worker.task.tiles?.length ?? 1;
          const dur = getTaskDuration(worker.task.kind, s.equipment, tileCount);
          worker.workTotal = dur;
          worker.workTimer = dur;
        }
        worker.workTimer -= dt;
        if (worker.workTimer <= 0) {
          completeTask(worker);
          worker.task = null;
          worker.workTimer = 0;
          worker.workTotal = 0;
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
      status: workerStatus(worker, s.isNight),
      currentTask: taskName(worker.task),
      queueLength: worker.queue.length,
      isSelected: worker.id === s.selectedWorkerId,
    }));
    const prices: Record<ProductId, number> = {
      wheat: currentPrice("wheat"),
      rice: currentPrice("rice"),
      corn: currentPrice("corn"),
      banana: currentPrice("banana"),
      milk: milkPriceFor(s.season, s.fluct.milk),
    };

    setUi((current) => ({
      ...current,
      coins: s.coins,
      seeds: { ...s.seeds },
      harvested: { ...s.harvested },
      revenue: s.revenue,
      expenses: s.expenses,
      day: s.day,
      time: `${hh}:${mm}`,
      season: s.season,
      prices,
      selectedWorkerId: selected.id,
      selectedWorkerName: selected.name,
      selectedStatus: workerStatus(selected, s.isNight),
      selectedCurrentTask: taskName(selected.task),
      selectedQueueLength: selected.queue.length,
      workers,
      cowReady: s.cow.lastMilkedDay !== s.day,
      isNight: s.isNight,
      equipment: { ...s.equipment },
    }));
  }

  function draw(now: number) {
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
    px(ctx, 0, 0, viewW, viewH, s.season === "winter" ? "#c8e2f0" : COLORS.sky);
    ctx.save();
    ctx.translate(-Math.round(s.camera.x), -Math.round(s.camera.y));

    for (let y = 0; y < MAP_H; y += 1) {
      for (let x = 0; x < MAP_W; x += 1) {
        drawGrassTile(ctx, x * TILE, y * TILE, x * 31 + y * 17, s.season);
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
          drawGrassTile(ctx, x, y, tx * 11 + ty * 7, s.season);
          px(ctx, x + 4, y + 4, TILE - 8, TILE - 8, "rgba(90,58,32,0.18)");
        } else if (field.state === "prepared" || !field.crop) {
          drawSoilTile(ctx, x, y, true);
        } else {
          drawCrop(ctx, x, y, field.state, field.crop);
        }
      }
    }

    ctx.strokeStyle = COLORS.woodDark;
    ctx.lineWidth = 1;
    ctx.strokeRect(FIELD_AREA.x0 * TILE + 0.5, FIELD_AREA.y0 * TILE + 0.5, (FIELD_AREA.x1 - FIELD_AREA.x0 + 1) * TILE - 1, (FIELD_AREA.y1 - FIELD_AREA.y0 + 1) * TILE - 1);

    if (farmhouseLoadedRef.current && farmhouseImgRef.current) {
      ctx.drawImage(farmhouseImgRef.current, FARMHOUSE.x * TILE, FARMHOUSE.y * TILE, FARMHOUSE.w * TILE, FARMHOUSE.h * TILE);
    } else {
      drawFarmhouse(ctx, FARMHOUSE.x * TILE, FARMHOUSE.y * TILE, FARMHOUSE.w * TILE, FARMHOUSE.h * TILE);
    }
    drawRectBuilding(ctx, BARN.x * TILE, BARN.y * TILE, BARN.w * TILE, BARN.h * TILE, COLORS.roof, COLORS.roofDark);
    drawRectBuilding(ctx, COOP.x * TILE, COOP.y * TILE, COOP.w * TILE, COOP.h * TILE, COLORS.woodLight, COLORS.roof);
    drawRectBuilding(ctx, TOOLSHED.x * TILE, TOOLSHED.y * TILE, TOOLSHED.w * TILE, TOOLSHED.h * TILE, COLORS.wood, COLORS.stoneDark);
    drawWell(ctx, WELL.x * TILE, WELL.y * TILE);
    drawShippingBin(ctx, SHIPPING_BIN.x * TILE, SHIPPING_BIN.y * TILE);

    // Milking Parlor + cow
    drawMilkingParlor(ctx, MILKING_PARLOR.x * TILE, MILKING_PARLOR.y * TILE, MILKING_PARLOR.w * TILE, MILKING_PARLOR.h * TILE);
    drawCow(ctx, s.cow.x, s.cow.y, s.cow.lastMilkedDay === s.day, now);

    // Season landmark tree
    drawSeasonTree(ctx, SEASON_TREE.x, SEASON_TREE.y, s.season, now);

    const hover = pointerToTile();
    if (hover) {
      const valid = inField(hover.tx, hover.ty)
        || (hover.tx === SHIPPING_BIN.x && hover.ty === SHIPPING_BIN.y)
        || inMilkingParlor(hover.tx, hover.ty);
      ctx.strokeStyle = valid ? COLORS.white : "rgba(255,255,255,0.4)";
      ctx.strokeRect(hover.tx * TILE + 0.5, hover.ty * TILE + 0.5, TILE - 1, TILE - 1);
    }

    const sorted = [...s.workers].sort((a, b) => a.y - b.y);
    for (const worker of sorted) {
      const t = worker.task;
      const onTruck = !!(t && (
        ((t.kind === "plant" || t.kind === "prepare") && s.equipment.tractor) ||
        (t.kind === "harvest" && s.equipment.harvester)
      ));
      const tractorPlanting = onTruck;
      void tractorPlanting;
      drawWorker(ctx, worker, worker.id === s.selectedWorkerId, onTruck, t?.kind);
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

    if (worker.task && worker.workTimer > 0 && worker.workTotal > 0) {
      const width = 24;
      const progress = clamp(1 - worker.workTimer / worker.workTotal, 0, 1);
      px(ctx, worker.x - width / 2, worker.y + 25, width, 4, COLORS.black);
      px(ctx, worker.x - width / 2 + 1, worker.y + 26, Math.floor((width - 2) * progress), 2, COLORS.selected);
    }
    ctx.textAlign = "left";
  }

  function pointerWorld() {
    const s = stateRef.current;
    if (s.pointer.x < 0 || s.pointer.y < 0) return null;
    return { x: s.pointer.x / s.cssScale + s.camera.x, y: s.pointer.y / s.cssScale + s.camera.y };
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
      s.pointer.x = x; s.pointer.y = y;
      s.pointer.downAt = performance.now();
      s.pointer.dragging = false;
      s.pointer.startX = x; s.pointer.startY = y;
      s.pointer.startCamX = s.camera.x; s.pointer.startCamY = s.camera.y;
      (event.target as Element).setPointerCapture?.(event.pointerId);
    };
    const onMove = (event: PointerEvent) => {
      const { x, y } = getPos(event);
      s.pointer.x = x; s.pointer.y = y;
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
      if (worker) { selectWorker(worker.id); return; }
      const tile = pointerToTile();
      if (tile) handleTileClick(tile.tx, tile.ty);
    };
    const onLeave = () => { s.pointer.x = -1; s.pointer.y = -1; };
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

  const buySeeds = (crop: CropId, count: number) => {
    const s = stateRef.current;
    const def = CROPS[crop];
    const cost = count * def.seedCost;
    if (s.coins < cost) {
      setMessage(`Need ${cost} coins for ${count} ${def.name} seeds.`);
      return;
    }
    s.coins -= cost;
    s.seeds[crop] += count;
    s.expenses += cost;
    addFloater(FARMHOUSE.x * TILE, FARMHOUSE.y * TILE + 10, `-${cost}c`, COLORS.shirtRed);
    setMessage(`Bought ${count} ${def.name} seeds.`);
    syncUi(true);
  };

  const equipmentRequirement = (id: EquipmentId): EquipmentId | null => {
    if (id === "tractor") return "manualPlow";
    if (id === "harvester") return "tractor";
    return null;
  };

  const buyEquipment = (id: EquipmentId) => {
    const s = stateRef.current;
    if (s.equipment[id]) { setMessage(`${EQUIPMENT_LABELS[id]} already owned.`); return; }
    const req = equipmentRequirement(id);
    if (req && !s.equipment[req]) {
      setMessage(`Requires ${EQUIPMENT_LABELS[req]} first.`);
      return;
    }
    const cost = EQUIPMENT_PRICES[id];
    if (s.coins < cost) { setMessage(`Need ${cost} coins for ${EQUIPMENT_LABELS[id]}.`); return; }
    s.coins -= cost;
    s.expenses += cost;
    s.equipment[id] = true;
    addFloater(FARMHOUSE.x * TILE, FARMHOUSE.y * TILE + 10, `-${cost}c`, COLORS.shirtRed);
    setMessage(`Bought ${EQUIPMENT_LABELS[id]}.`);
    logJournal(`Bought ${EQUIPMENT_LABELS[id]} (-${cost}c)`);
    syncUi(true);
  };

  const hireWorker = () => {
    const s = stateRef.current;
    const cost = HIRE_COST_BASE * s.workers.length;
    if (s.coins < cost) { setMessage(`Hiring costs ${cost} coins. Earn more first.`); return; }
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
  const seasonIcon: Record<Season, string> = { spring: "🌸", summer: "☀️", autumn: "🍂", winter: "❄️" };


  const dayPct = Math.min(100, Math.floor((stateRef.current.dayMs / DAY_MS) * 100));
  const seasonIcon: Record<Season, string> = { spring: "🌸", summer: "☀️", autumn: "🍂", winter: "❄️" };
  const profit = ui.revenue - ui.expenses;

  return (
    <div className="min-h-screen w-full flex flex-col" style={{ background: "#0e0b07" }}>

      {/* ── TOP RESOURCE BAR ─────────────────────────────────── */}
      <header className="aoe-topbar">
        <span style={{ fontFamily: "'Cinzel', serif", fontSize: 14, fontWeight: 700, color: "var(--aoe-gold-light)", letterSpacing: 2, marginRight: 8, textShadow: "0 2px 6px rgba(200,150,12,0.5)" }}>
          KidFarm
        </span>
        <div className="aoe-topbar-divider" />

        <AoeResource icon="🪙" label="Coins"    value={`${ui.coins}`}    />
        <AoeResource icon="📈" label="Revenue"  value={`${ui.revenue}`}  color="#7ad060" />
        <AoeResource icon="📉" label="Expenses" value={`${ui.expenses}`} color="#e05030" />
        <AoeResource icon="💰" label="Profit"   value={`${profit}`}      color={profit >= 0 ? "#7ad060" : "#e05030"} />
        <div className="aoe-topbar-divider" />
        <AoeResource icon="📅" label="Day"      value={`${ui.day}`} />
        <AoeResource icon={seasonIcon[ui.season]} label="Season" value={SEASON_LABEL[ui.season]} />
        <AoeResource icon="🕐" label="Time"     value={ui.time} />
        <AoeResource icon={ui.isNight ? "🌙" : "☀️"} label="Phase" value={ui.isNight ? "Night" : "Day"} />
        <div className="aoe-topbar-divider" />
        <AoeResource icon="⚔️" label="Worker"  value={ui.selectedWorkerName} color="var(--aoe-gold-light)" />
      </header>

      {/* ── MAIN LAYOUT ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col lg:flex-row gap-2 p-2" style={{ minHeight: 0 }}>

        {/* MAP CANVAS */}
        <div ref={wrapRef} className="relative flex-1 overflow-hidden pixel-panel" style={{ minHeight: 380 }}>
          <canvas ref={canvasRef} className="pixel-canvas w-full h-full" />

          {/* Day progress bar */}
          <div className="aoe-daybar-wrap">
            <div className="aoe-daybar-fill" style={{ width: `${dayPct}%` }} />
          </div>

          {/* Status message */}
          <div className="aoe-message">{ui.message}</div>

          {/* Season banner */}
          {ui.banner.visible && (
            <div className="aoe-banner animate-fade-in">
              {seasonIcon[ui.season]} {ui.banner.text}
            </div>
          )}

          {/* Plant chooser modal */}
          {plantPrompt && (
            <div className="aoe-modal-overlay">
              <div className="aoe-modal" style={{ minWidth: 300, maxWidth: 400 }}>
                <div className="aoe-modal-title">⚔ Plant Crop — {SEASON_LABEL[ui.season]}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {CROP_ORDER.map((id) => {
                    const def = CROPS[id];
                    const owned = ui.seeds[id];
                    const days = GROW_DAYS[id][ui.season];
                    const price = ui.prices[id];
                    const projected = def.yield * price - def.seedCost;
                    return (
                      <button key={id} className="pixel-btn" disabled={owned <= 0} onClick={() => choosePlant(id)}
                        style={{ textAlign: "left", padding: "8px 12px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3 }}>
                          <span style={{ fontFamily: "'Cinzel',serif", fontSize: 11 }}>{def.name}</span>
                          <span style={{ color: "var(--aoe-text-muted)", fontSize: 10 }}>Seeds: {owned}</span>
                        </div>
                        <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", display: "flex", gap: 12 }}>
                          <span>{days}d to grow</span>
                          <span>Sells {price}c</span>
                          <span style={{ color: projected > 0 ? "#7ad060" : "#e05030" }}>Profit: {projected}c</span>
                        </div>
                      </button>
                    );
                  })}
                  <button className="pixel-btn" onClick={() => setPlantPrompt(null)}
                    style={{ marginTop: 4, color: "var(--aoe-text-muted)" }}>Cancel</button>
                </div>
              </div>
            </div>
          )}

          {/* Shop modal */}
          {shopOpen && (
            <div className="aoe-modal-overlay">
              <div className="aoe-modal" style={{ minWidth: 320, maxWidth: 480 }}>
                <div className="aoe-modal-title">🏪 Farm Supply Store</div>
                <div className="aoe-tabs" style={{ marginBottom: 10 }}>
                  {(["seeds", "equipment", "pesticides", "land"] as const).map((t) => (
                    <button key={t} className={`aoe-tab ${shopTab === t ? "active" : ""}`} onClick={() => setShopTab(t)}>
                      {t.charAt(0).toUpperCase() + t.slice(1)}
                    </button>
                  ))}
                </div>

                {shopTab === "seeds" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", marginBottom: 2 }}>
                      Prices shown for {SEASON_LABEL[ui.season]} — seasons change crop value.
                    </div>
                    {CROP_ORDER.map((id) => {
                      const def = CROPS[id];
                      const days = GROW_DAYS[id][ui.season];
                      const price = ui.prices[id];
                      const projected = def.yield * price - def.seedCost;
                      return (
                        <div key={id} className="aoe-item-card">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span className="aoe-item-name">{def.name}</span>
                            <span style={{ fontSize: 10, color: "var(--aoe-text-muted)" }}>Own: {ui.seeds[id]}</span>
                          </div>
                          <div className="aoe-item-grid">
                            <span>Cost: {def.seedCost}c/seed</span>
                            <span>Grow: {days}d</span>
                            <span>Sell: {price}c</span>
                            <span className={projected > 0 ? "profit-pos" : "profit-neg"}>Margin: {projected}c</span>
                          </div>
                          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
                            <button className="pixel-btn" style={{ flex: 1 }} onClick={() => buySeeds(id, 1)}>Buy 1 · {def.seedCost}c</button>
                            <button className="pixel-btn primary" style={{ flex: 1 }} onClick={() => buySeeds(id, 5)}>Buy 5 · {def.seedCost * 5}c</button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {shopTab === "equipment" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", marginBottom: 2 }}>
                      Upgrade path: Manual Plow → Tractor → Harvester
                    </div>
                    {(["manualPlow", "tractor", "harvester"] as EquipmentId[]).map((id) => {
                      const owned = ui.equipment[id];
                      const req = equipmentRequirement(id);
                      const reqMet = !req || ui.equipment[req];
                      const cost = EQUIPMENT_PRICES[id];
                      const effect = id === "manualPlow"
                        ? "−35% Prepare Soil time"
                        : id === "tractor"
                          ? "−75% Prepare · Sows up to 10 seeds at once"
                          : "−75% Harvest · 2×2 area";
                      return (
                        <div key={id} className="aoe-item-card">
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                            <span className="aoe-item-name">{EQUIPMENT_LABELS[id]}</span>
                            <span style={{ fontSize: 10, color: owned ? "#7ad060" : "var(--aoe-text-muted)" }}>
                              {owned ? "✓ Owned" : `${cost}c`}
                            </span>
                          </div>
                          <div className="aoe-item-desc">{effect}</div>
                          {req && !reqMet && (
                            <div style={{ fontSize: 9, color: "#e05030" }}>Requires {EQUIPMENT_LABELS[req]}</div>
                          )}
                          <button className="pixel-btn primary" style={{ marginTop: 4 }}
                            disabled={owned || !reqMet || ui.coins < cost}
                            onClick={() => buyEquipment(id)}>
                            {owned ? "Owned" : `Purchase · ${cost}c`}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}

                {shopTab === "pesticides" && (
                  <div className="aoe-item-card" style={{ textAlign: "center", padding: 20 }}>
                    <div className="aoe-item-name" style={{ marginBottom: 6 }}>Pesticides</div>
                    <div className="aoe-item-desc">Coming in a future season.</div>
                  </div>
                )}

                {shopTab === "land" && (
                  <div className="aoe-item-card" style={{ textAlign: "center", padding: 20 }}>
                    <div className="aoe-item-name" style={{ marginBottom: 6 }}>Land Expansion</div>
                    <div className="aoe-item-desc">Coming in a future season.</div>
                  </div>
                )}

                <button className="pixel-btn primary" style={{ marginTop: 10, width: "100%" }} onClick={() => setShopOpen(false)}>
                  Close Store
                </button>
              </div>
            </div>
          )}

          {/* Market modal */}
          {marketOpen && (
            <div className="aoe-modal-overlay">
              <div className="aoe-modal" style={{ minWidth: 340, maxWidth: 500 }}>
                <div className="aoe-modal-title">📊 Market — {SEASON_LABEL[ui.season]}</div>
                <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", marginBottom: 10 }}>
                  Price history for the last {HISTORY_DAYS} days. Prices vary by season and daily fluctuation.
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {PRODUCT_ORDER.map((id) => {
                    const hist = stateRef.current.history[id];
                    const color = id === "milk" ? "#f0e0a0" : CROPS[id as CropId]?.fruit ?? "#f0c030";
                    return (
                      <div key={id} className="aoe-item-card">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                          <span className="aoe-item-name">{productName(id)}</span>
                          <span style={{ color: "var(--aoe-gold-light)", fontFamily: "'Cinzel',serif", fontSize: 13, fontWeight: 700 }}>
                            {ui.prices[id]}c
                          </span>
                        </div>
                        <MiniChart data={hist} color={color} />
                      </div>
                    );
                  })}
                </div>
                <button className="pixel-btn primary" style={{ marginTop: 10, width: "100%" }} onClick={() => setMarketOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          )}

          {/* Journal modal */}
          {journalOpen && (
            <div className="aoe-modal-overlay">
              <div className="aoe-modal" style={{ minWidth: 340, maxWidth: 500, maxHeight: "88%" }}>
                <div className="aoe-modal-title">📜 Farm Journal</div>
                <div style={{ overflow: "auto", maxHeight: 380, display: "flex", flexDirection: "column", gap: 0 }}>
                  {stateRef.current.journal.length === 0 && (
                    <div style={{ fontSize: 10, color: "var(--aoe-text-muted)", padding: "12px 0" }}>No events recorded yet.</div>
                  )}
                  {stateRef.current.journal.map((e, i) => (
                    <div key={i} className="aoe-journal-entry">
                      <span className="aoe-journal-day">Day {e.day} · {SEASON_LABEL[e.season]}</span>
                      {e.text}
                    </div>
                  ))}
                </div>
                <button className="pixel-btn primary" style={{ marginTop: 10, width: "100%" }} onClick={() => setJournalOpen(false)}>
                  Close
                </button>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT SIDE PANEL ───────────────────────────────── */}
        <aside className="lg:w-[300px] flex flex-col gap-2" style={{ overflowY: "auto" }}>

          <AoePanel title="Selected Unit">
            <AoeStatusLine label="Name"   value={ui.selectedWorkerName} />
            <AoeStatusLine label="Status" value={ui.selectedStatus} />
            <AoeStatusLine label="Task"   value={ui.selectedCurrentTask} />
            <AoeStatusLine label="Queued" value={`${ui.selectedQueueLength} task${ui.selectedQueueLength !== 1 ? "s" : ""}`} />
          </AoePanel>

          <AoePanel title="Workers">
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {ui.workers.map((worker) => (
                <div key={worker.id} className={`aoe-worker-card ${worker.isSelected ? "selected" : ""}`}>
                  <button className="pixel-btn flex-1" style={{ border: "none", borderRadius: 0, textAlign: "left", flex: 1 }}
                    onClick={() => selectWorker(worker.id)}>
                    <div style={{ fontFamily: "'Cinzel',serif", fontSize: 11, color: worker.isSelected ? "var(--aoe-gold-light)" : "var(--aoe-text-light)" }}>
                      {worker.name}
                    </div>
                    <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", marginTop: 1 }}>
                      {worker.status} · Queue: {worker.queueLength}
                    </div>
                  </button>
                  <button className="pixel-btn" style={{ borderRadius: 0, fontSize: 9, padding: "0 10px" }}
                    onClick={() => centerOnWorker(worker.id)}>Find</button>
                </div>
              ))}
            </div>
            <button className="pixel-btn primary" style={{ width: "100%", marginTop: 2 }} onClick={hireWorker}>
              + Hire Worker — {HIRE_COST_BASE * ui.workers.length}c
            </button>
          </AoePanel>

          <AoePanel title="Actions">
            <button className="pixel-btn primary" style={{ width: "100%", marginBottom: 4 }} onClick={() => setShopOpen(true)}>
              🏪 Farm Supply Store
            </button>
            <button className="pixel-btn accent" style={{ width: "100%", marginBottom: 4 }} onClick={() => setMarketOpen(true)}>
              📊 Market &amp; Prices
            </button>
            <button className="pixel-btn" style={{ width: "100%" }} onClick={() => setJournalOpen(true)}>
              📜 Farm Journal
            </button>
          </AoePanel>

          <AoePanel title="Equipment">
            {(["manualPlow", "tractor", "harvester"] as EquipmentId[]).map((id) => (
              <AoeStatusLine key={id} label={EQUIPMENT_LABELS[id]}
                value={ui.equipment[id] ? "✓ Owned" : "Not owned"}
                valueColor={ui.equipment[id] ? "#7ad060" : undefined} />
            ))}
          </AoePanel>

          <AoePanel title="Milking Parlor">
            <AoeStatusLine label="Cow status"
              value={ui.cowReady ? "Ready to milk" : "Milked today"}
              valueColor={ui.cowReady ? "#7ad060" : "var(--aoe-text-muted)"} />
            <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", lineHeight: 1.6, marginTop: 2 }}>
              Select a worker, then click the cow to queue milking (+{MILK_YIELD} Milk).
            </div>
          </AoePanel>

          <AoePanel title="Market Prices">
            {PRODUCT_ORDER.map((id) => (
              <AoeStatusLine key={`price-${id}`} label={productName(id)} value={`${ui.prices[id]}c`} />
            ))}
          </AoePanel>

          <AoePanel title="Inventory">
            <div style={{ fontSize: 9, color: "var(--aoe-gold-dark)", textTransform: "uppercase", letterSpacing: 1, marginBottom: 3 }}>
              Seeds
            </div>
            {CROP_ORDER.map((id) => (
              <AoeStatusLine key={`seed-${id}`} label={CROPS[id].name} value={`${ui.seeds[id]}`} />
            ))}
            <div style={{ fontSize: 9, color: "var(--aoe-gold-dark)", textTransform: "uppercase", letterSpacing: 1, marginTop: 6, marginBottom: 3 }}>
              Harvested
            </div>
            {PRODUCT_ORDER.map((id) => (
              <AoeStatusLine key={`harv-${id}`} label={productName(id)} value={`${ui.harvested[id]}`} />
            ))}
          </AoePanel>

          <AoePanel title="How to Play">
            <ol style={{ fontSize: 10, lineHeight: 1.8, paddingLeft: 16, color: "var(--aoe-text-light)" }}>
              <li>Click a worker to select them.</li>
              <li>Click empty soil to prepare it.</li>
              <li>Click prepared soil to choose a crop.</li>
              <li>Click the cow to milk it (once per day).</li>
              <li>Click ripe crops, then the shipping bin.</li>
            </ol>
            <div style={{ fontSize: 9, color: "var(--aoe-text-muted)", marginTop: 4 }}>
              Drag map or use arrow keys / WASD to pan.
            </div>
            <button className="pixel-btn" style={{ width: "100%", marginTop: 6, background: "rgba(120,20,10,0.6)", borderColor: "#8a2010", color: "#ffb0a0" }}
              onClick={() => { if (window.confirm("Reset your farm? This deletes all saved progress.")) resetGame(); }}>
              ⚠ Reset Farm
            </button>
          </AoePanel>

        </aside>
      </div>
    </div>
  );
}

function MiniChart({ data, color }: { data: { day: number; price: number }[]; color: string }) {
  const w = 280;
  const h = 56;
  if (data.length === 0) return <div style={{ fontSize: 9, color: "var(--aoe-text-muted)" }}>No data yet.</div>;
  const prices = data.map((d) => d.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = Math.max(1, max - min);
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const points = data.map((d, i) => `${i * step},${h - ((d.price - min) / range) * (h - 10) - 5}`).join(" ");
  return (
    <div className="aoe-chart-wrap">
      <svg width={w} height={h} style={{ maxWidth: "100%" }}>
        <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
        {data.map((d, i) => (
          <circle key={i} cx={i * step} cy={h - ((d.price - min) / range) * (h - 10) - 5} r={2} fill={color} />
        ))}
      </svg>
      <div className="aoe-chart-legend">
        <span>Day {data[0].day}</span>
        <span>Low {min}c · High {max}c</span>
        <span>Day {data[data.length - 1].day}</span>
      </div>
    </div>
  );
}

function AoeResource({ icon, label, value, color }: { icon: string; label: string; value: string; color?: string }) {
  return (
    <div className="aoe-resource">
      <span className="aoe-resource-icon">{icon}</span>
      <div className="aoe-resource-info">
        <span className="aoe-resource-label">{label}</span>
        <span className="aoe-resource-value" style={color ? { color } : undefined}>{value}</span>
      </div>
    </div>
  );
}

function AoeStatusLine({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="aoe-status-line">
      <span className="aoe-status-label">{label}</span>
      <span className="aoe-status-value" style={valueColor ? { color: valueColor } : undefined}>{value}</span>
    </div>
  );
}

function AoePanel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pixel-panel" style={{ padding: "8px 10px" }}>
      <div className="aoe-panel-title">{title}</div>
      {children}
    </div>
  );
}
