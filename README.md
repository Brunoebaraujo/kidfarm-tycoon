# Capitalism 4 Kids

A Vite, React, TypeScript, and Phaser pixel-art farming game foundation.

React owns the HUD and interface panels. Phaser owns the entire farm world: tiles, sprites, movement, fields, animations, and interactions.

## Run Locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Current Foundation

- Phaser renders the farm inside React.
- The Phaser instance is stored in a React ref and is not recreated by HUD rerenders.
- The farm world is composed from 32x32 tile textures generated with Phaser graphics.
- Maya is a placeholder pixel sprite with animation states.
- Maya moves tile-by-tile with keyboard controls.
- Field 1 starts unlocked and cycles Harvested -> Prepared -> Planted -> Harvested.
- Field 2 starts locked and remains unavailable.
- Maya is selected by default, and clicking a worker changes the active worker.
- Each worker owns an independent task queue.
- Tile and HUD commands are assigned only to the selected worker.
- The camera stays free during task assignment; Find buttons center once without locking.
- Inventory and economy state are reflected in the React HUD.

## Controls

- Click Maya or Worker 1: select the active worker.
- Click a field: assign the field action to the selected worker.
- Arrow keys or WASD: move the selected idle worker one tile at a time.
- Space: perform the context field action for the selected worker.
- 1: Queue Prepare Soil for the selected worker.
- 2: Queue Plant Wheat for the selected worker.
- 3: Queue Harvest Wheat for the selected worker.
- 4: Queue Milk Cow for the selected worker.
- Find: center the camera on that worker once.

## Docs

- `docs/vision.md`
- `docs/art-direction.md`
- `docs/technical-architecture.md`
- `docs/roadmap.md`
