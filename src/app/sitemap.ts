import type { MetadataRoute } from "next";
import { getAllDestinations } from "@/lib/plans/service";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://roamlink-chi.vercel.app";
  const destinations = await getAllDestinations();

  const staticPages: MetadataRoute.Sitemap = [
    { url: `${baseUrl}/`, lastModified: new Date(), changeFrequency: "weekly", priority: 1 },
    { url: `${baseUrl}/esim`, lastModified: new Date(), changeFrequency: "weekly", priority: 0.9 },
    { url: `${baseUrl}/login`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
    { url: `${baseUrl}/register`, lastModified: new Date(), changeFrequency: "yearly", priority: 0.3 },
  ];

  const destinationPages: MetadataRoute.Sitemap = destinations.map((d) => ({
    url: `${baseUrl}/esim/${d.slug}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: 0.8,
  }));

  return [...staticPages, ...destinationPages];
}
