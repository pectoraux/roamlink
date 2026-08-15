import type { MetadataRoute } from "next";

// Mark this route as dynamic — it should not be statically prerendered
// because it queries the database. This prevents build failures when
// DATABASE_URL is not available during the Vercel build step.
export const dynamic = "force-dynamic";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://roamlink-chi.vercel.app";

  // Try to fetch destinations, but don't fail the build if the DB is unavailable
  let destinationPages: MetadataRoute.Sitemap = [];
  try {
    const { getAllDestinations } = await import("@/lib/plans/service");
    const destinations = await getAllDestinations();
    destinationPages = destinations.map((d) => ({
      url: `${baseUrl}/esim/${d.slug}`,
      lastModified: new Date(),
      changeFrequency: "weekly" as const,
      priority: 0.8,
    }));
  } catch {
    // DB not available during build — return static-only sitemap
  }

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${baseUrl}/esim`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/login`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/register`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
  ];

  return [...staticPages, ...destinationPages];
}
