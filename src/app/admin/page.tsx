"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Loader2, Users, ShoppingBag, DollarSign, CheckCircle2, XCircle, Smartphone, Package } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatPrice } from "@/lib/format";

type Stats = {
  totalUsers: number;
  totalOrders: number;
  revenueMinor: number;
  revenueCurrency: string;
  successfulOrders: number;
  failedOrders: number;
  activeESIMs: number;
  totalESIMs: number;
  totalPlans: number;
  activePlans: number;
};

export default function AdminOverview() {
  const [stats, setStats] = useState<Stats | null>(null);

  useEffect(() => {
    api.get<{ stats: Stats }>("/api/admin/stats").then((d) => setStats(d.stats)).catch(() => setStats(null));
  }, []);

  if (!stats) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    );
  }

  const cards = [
    { label: "Total users", value: stats.totalUsers, icon: Users, tone: "text-primary" },
    { label: "Total orders", value: stats.totalOrders, icon: ShoppingBag, tone: "text-primary" },
    { label: "Revenue", value: formatPrice(stats.revenueMinor, stats.revenueCurrency), icon: DollarSign, tone: "text-emerald-600" },
    { label: "Successful orders", value: stats.successfulOrders, icon: CheckCircle2, tone: "text-emerald-600" },
    { label: "Failed orders", value: stats.failedOrders, icon: XCircle, tone: "text-rose-600" },
    { label: "Active eSIMs", value: stats.activeESIMs, icon: Smartphone, tone: "text-primary" },
    { label: "Total eSIMs", value: stats.totalESIMs, icon: Smartphone, tone: "text-muted-foreground" },
    { label: "Active plans", value: `${stats.activePlans}/${stats.totalPlans}`, icon: Package, tone: "text-primary" },
  ];

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Overview</h2>
      <p className="text-sm text-muted-foreground">Key metrics across the marketplace</p>

      <div className="mt-5 grid grid-cols-2 gap-4 md:grid-cols-4">
        {cards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between">
                <c.icon className={`h-5 w-5 ${c.tone}`} />
              </div>
              <p className="mt-3 text-2xl font-bold">{c.value}</p>
              <p className="text-xs text-muted-foreground">{c.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">System status</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          <p>Providers are configured via environment variables. Current active providers:</p>
          <ul className="mt-2 space-y-1">
            <li>eSIM provider: <span className="font-mono font-medium text-foreground">{process.env.NEXT_PUBLIC_ESIM_PROVIDER ?? "mock"}</span></li>
            <li>Payment provider: <span className="font-mono font-medium text-foreground">{process.env.NEXT_PUBLIC_PAYMENT_PROVIDER ?? "mock"}</span></li>
          </ul>
          <p className="mt-3">See <Link className="text-primary hover:underline" href="/admin/providers">Providers</Link> for configuration status.</p>
        </CardContent>
      </Card>
    </div>
  );
}
