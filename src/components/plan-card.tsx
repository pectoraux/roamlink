import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Wifi, Clock, Globe, Smartphone } from "lucide-react";
import { formatPrice, formatDataSize, countryFlag } from "@/lib/format";
import type { PublicPlan } from "@/types";

export function PlanCard({ plan }: { plan: PublicPlan }) {
  return (
    <Card className="lift flex flex-col overflow-hidden p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="text-3xl leading-none" aria-hidden>
            {countryFlag(plan.countryCode)}
          </span>
          <div>
            <h3 className="font-semibold leading-tight">{plan.country}</h3>
            <p className="text-xs text-muted-foreground">{plan.region}</p>
          </div>
        </div>
        {plan.roaming && <Badge variant="secondary" className="text-[10px]">Roaming</Badge>}
      </div>

      <div className="mt-5 flex items-end gap-2">
        <span className="text-3xl font-bold tracking-tight">{formatDataSize(plan.dataAmountMB)}</span>
        <span className="mb-1 text-sm text-muted-foreground">data</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Clock className="h-3.5 w-3.5" /> {plan.validityDays} days validity
      </div>

      <div className="mt-4 flex flex-wrap gap-1.5">
        {plan.speed && (
          <Badge variant="outline" className="gap-1 text-[11px]">
            <Wifi className="h-3 w-3" /> {plan.speed}
          </Badge>
        )}
        {plan.hotspot && (
          <Badge variant="outline" className="gap-1 text-[11px]">
            <Smartphone className="h-3 w-3" /> Hotspot
          </Badge>
        )}
      </div>

      {plan.networks && plan.networks.length > 0 && (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Globe className="h-3.5 w-3.5" />
          <span className="truncate">{plan.networks.slice(0, 3).join(" · ")}</span>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between border-t border-border/60 pt-4">
        <div>
          <span className="text-2xl font-bold">{formatPrice(plan.priceMinor, plan.currency)}</span>
          <p className="text-[11px] text-muted-foreground">one-time</p>
        </div>
        <Button asChild size="sm">
          <Link href={`/esim/${plan.id}`}>Buy now</Link>
        </Button>
      </div>
    </Card>
  );
}
