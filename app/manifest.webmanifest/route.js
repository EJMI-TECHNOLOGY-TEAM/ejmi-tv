export const dynamic = "force-static"

export function GET() {
  const manifest = {
    name: "Encounter Jesus Television",
    short_name: "Encounter Jesus TV",
    description: "Watch Encounter Jesus Television live from anywhere in the world.",
    start_url: "/",
    display: "standalone",
    orientation: "any",
    background_color: "#020617",
    theme_color: "#020617",
    categories: ["entertainment", "lifestyle"],
    icons: [
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  }

  return new Response(JSON.stringify(manifest), {
    headers: {
      "Content-Type": "application/manifest+json",
      "Cache-Control": "public, max-age=86400",
    },
  })
}
