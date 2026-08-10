import Link from "next/link";
import { listPlans, getPopularDestinations, getRegions, getCountries } from "@/lib/plans/service";
import { PlanCard } from "@/components/plan-card";
import { PlansFilters } from "@/components/plans-filters";
import { Card } from "@/components/ui/card";
import { countryFlag } from "@/lib/format";
import { Globe } from "lucide-react";

export default async function PlansPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const query = {
    search: sp.search,
    countryCode: sp.country,
    region: sp.region,
    minDataMB: sp.minData ? Number(sp.minData) : undefined,
    sort: (sp.sort as "price_asc" | "price_desc" | "data_asc" | "data_desc" | "validity_desc") ?? "price_asc",
  };

  const [plans, destinations, regions, countries] = await Promise.all([
    listPlans(query),
    getPopularDestinations(8),
    getRegions(),
    getCountries(),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-bold tracking-tight">Browse eSIM plans</h1>
        <p className="text-muted-foreground">Find the perfect data plan for your destination.</p>
      </div>

      {destinations.length > 0 && (
        <div className="mt-6 flex flex-wrap gap-2">
          {destinations.map((d) => (
            <Link
              key={d.countryCode}
              href={`/esim/${d.country.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm hover:border-primary/40 hover:bg-primary/5"
            >
              <span aria-hidden>{countryFlag(d.countryCode)}</span> {d.country}
            </Link>
          ))}
        </div>
      )}

      <div className="mt-6 grid gap-6 lg:grid-cols-[260px_1fr]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <PlansFilters countries={countries} regions={regions} />
        </aside>

        <div>
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm text-muted-foreground">
              <span className="font-semibold text-foreground">{plans.length}</span> plan{plans.length === 1 ? "" : "s"} found
            </p>
          </div>

          {plans.length === 0 ? (
            <Card className="flex flex-col items-center justify-center gap-3 p-12 text-center">
              <Globe className="h-10 w-10 text-muted-foreground" />
              <div>
                <p className="font-medium">No plans match your filters</p>
                <p className="text-sm text-muted-foreground">Try clearing filters or searching another destination.</p>
              </div>
              <Link href="/esim" className="text-sm font-medium text-primary hover:underline">Clear all filters</Link>
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {plans.map((p) => (
                <PlanCard key={p.id} plan={p} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
