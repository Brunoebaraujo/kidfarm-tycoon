import { createFileRoute } from "@tanstack/react-router";
import KidFarmGame from "@/components/KidFarmGame";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "KidFarm — A Cozy Farming Game for Kids" },
      { name: "description", content: "Plant, harvest, hire, and grow your farm. A pixel-art farming and entrepreneurship game for kids 8–12." },
      { property: "og:title", content: "KidFarm — A Cozy Farming Game for Kids" },
      { property: "og:description", content: "Plant, harvest, hire, and grow your farm. A pixel-art farming and entrepreneurship game for kids 8–12." },
    ],
    links: [
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "" },
      { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" },
    ],
  }),
  component: KidFarmGame,
});
