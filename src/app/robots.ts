import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://roamlink-chi.vercel.app";
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/dashboard", "/api", "/checkout", "/order"] },
    sitemap: `${baseUrl}/sitemap.xml`,
    host: baseUrl,
  };
}
