# KidFarm Tycoon

A cozy pixel-art farming and entrepreneurship game for kids. The app uses React, TanStack Router, Vite, and a custom canvas-rendered farm world.

## Run Locally

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Worker Command System

- Maya is selected by default.
- Clicking a worker selects that worker.
- Tile and shipping-bin commands are assigned only to the selected worker.
- Each worker has an independent task queue.
- Busy selected workers keep receiving queued commands.
- Idle workers that are not selected do not receive tasks automatically.
- The camera stays free while tasks run.
- Find buttons center the camera on a worker once without locking follow mode.

## Controls

- Click Maya or a hired worker: select the active worker.
- Click empty soil: queue Prepare Soil for the selected worker.
- Click prepared soil: queue Plant Wheat for the selected worker.
- Click ready wheat: queue Harvest Wheat for the selected worker.
- Click the shipping bin: queue Deliver Wheat for the selected worker.
- Drag the map, arrow keys, or WASD: pan the camera freely.
- Find: center on a worker once.

## Gameplay

- Buy seeds from the shop.
- Plant and grow wheat during active play time.
- Harvest wheat and deliver it to the shipping bin to earn coins.
- Hire workers as the farm earns money.
- Daily household costs are charged as in-game days pass.
