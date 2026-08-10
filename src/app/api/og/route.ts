import { NextRequest } from "next/server";

/**
 * Dynamic OG image generator — returns a simple SVG card for social sharing.
 * No external image dependencies; renders an SVG with the country flag + name.
 */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const countryCode = searchParams.get("country") ?? "WW";
  const name = searchParams.get("name") ?? "eSIM";

  const flag = countryCode.length === 2
    ? String.fromCodePoint(...countryCode.toUpperCase().split("").map((c) => 127397 + c.charCodeAt(0)))
    : "🌐";

  const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#0d9488"/>
      <stop offset="100%" style="stop-color:#14b8a6"/>
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#bg)"/>
  <text x="600" y="260" font-size="180" text-anchor="middle" dominant-baseline="middle">${flag}</text>
  <text x="600" y="400" font-size="64" font-weight="bold" fill="white" text-anchor="middle" font-family="system-ui, sans-serif">${name} eSIM</text>
  <text x="600" y="470" font-size="32" fill="white" fill-opacity="0.8" text-anchor="middle" font-family="system-ui, sans-serif">Instant travel data · No physical SIM</text>
  <text x="600" y="560" font-size="28" font-weight="bold" fill="white" text-anchor="middle" font-family="system-ui, sans-serif">RoamLink</text>
</svg>`;

  return new Response(svg, { headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" } });
}
