"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useCallback } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Search, SlidersHorizontal, X } from "lucide-react";

type FilterProps = {
  countries: { country: string; countryCode: string }[];
  regions: string[];
};

export function PlansFilters({ countries, regions }: FilterProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const update = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(params.toString());
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
      router.push(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  const reset = () => router.push(pathname, { scroll: false });

  const hasFilters = params.toString() !== "";

  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        <SlidersHorizontal className="h-4 w-4" /> Filters
      </div>
      <div className="mt-3 flex flex-col gap-3">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search destination..."
            defaultValue={params.get("search") ?? ""}
            onChange={(e) => update("search", e.target.value || null)}
            className="pl-9"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select value={params.get("country") ?? "all"} onValueChange={(v) => update("country", v === "all" ? null : v)}>
            <SelectTrigger><SelectValue placeholder="Country" /></SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">All countries</SelectItem>
              {countries.map((c) => (
                <SelectItem key={c.countryCode} value={c.countryCode}>{c.country}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={params.get("region") ?? "all"} onValueChange={(v) => update("region", v === "all" ? null : v)}>
            <SelectTrigger><SelectValue placeholder="Region" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All regions</SelectItem>
              {regions.map((r) => (
                <SelectItem key={r} value={r}>{r}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Select value={params.get("minData") ?? "all"} onValueChange={(v) => update("minData", v === "all" ? null : v)}>
            <SelectTrigger><SelectValue placeholder="Min data" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any data</SelectItem>
              <SelectItem value="1024">1 GB+</SelectItem>
              <SelectItem value="5120">5 GB+</SelectItem>
              <SelectItem value="10240">10 GB+</SelectItem>
              <SelectItem value="20480">20 GB+</SelectItem>
            </SelectContent>
          </Select>
          <Select value={params.get("sort") ?? "price_asc"} onValueChange={(v) => update("sort", v)}>
            <SelectTrigger><SelectValue placeholder="Sort" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="price_asc">Price: Low to High</SelectItem>
              <SelectItem value="price_desc">Price: High to Low</SelectItem>
              <SelectItem value="data_desc">Most data</SelectItem>
              <SelectItem value="validity_desc">Longest validity</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {hasFilters && (
          <Button variant="ghost" size="sm" onClick={reset} className="justify-start text-muted-foreground">
            <X className="mr-1 h-3.5 w-3.5" /> Clear filters
          </Button>
        )}
      </div>
    </div>
  );
}
