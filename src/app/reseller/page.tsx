"use client";

import { useEffect, useState } from "react";
import { Users, ShoppingBag, Wifi, TrendingUp, AlertCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";

type DashboardData = {
  tenant: { id: string; name: string; slug: string; role: string } | null;
  entitlements: {
    saaasPlanName: string;
    monthlyPriceMinor: number;
    includedCustomers: number;
    includedOrdersPerMonth: number;
    subscriptionStatus: string;
  } | null;
  stats: {
    customers: { total: number; active: number; suspended: number; cancelled: number };
    orders: number;
    activeServices: number;
  } | null;
};

export default function ResellerDashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/tenant/me")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  if (loading || !data) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      </div>
    );
  }

  const stats = [
    {
      label: "Customers",
      value: data.stats?.customers.total ?? 0,
      sub: `${data.stats?.customers.active ?? 0} active`,
      icon: Users,
      href: "/reseller/customers",
    },
    {
      label: "Total Orders",
      value: data.stats?.orders ?? 0,
      sub: "All time",
      icon: ShoppingBag,
      href: "/reseller/orders",
    },
    {
      label: "Active Services",
      value: data.stats?.activeServices ?? 0,
      sub: "Connectivity services",
      icon: Wifi,
      href: "/reseller/orders",
    },
    {
      label: "SaaS Plan",
      value: data.entitlements?.saaasPlanName ?? "free",
      sub: data.entitlements?.subscriptionStatus === "active" ? "Active" : "No subscription",
      icon: TrendingUp,
      href: "/reseller/billing",
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {data.tenant?.name} — reseller control plane
        </p>
      </div>

      {/* Stats grid */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link key={stat.label} href={stat.href}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    {stat.label}
                  </CardTitle>
                  <Icon className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{stat.value}</div>
                  <p className="text-xs text-muted-foreground mt-1">{stat.sub}</p>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Entitlement usage */}
      {data.entitlements && data.stats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Plan Usage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <UsageBar
              label="Customers"
              used={data.stats.customers.total}
              included={data.entitlements.includedCustomers}
            />
            <UsageBar
              label="Orders this month"
              used={data.stats.orders}
              included={data.entitlements.includedOrdersPerMonth}
            />
          </CardContent>
        </Card>
      )}

      {/* Quick actions */}
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Quick Actions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <Link href="/reseller/customers" className="block text-sm text-primary hover:underline">
              → Add a customer
            </Link>
            <Link href="/reseller/catalog" className="block text-sm text-primary hover:underline">
              → Enable a product in your catalog
            </Link>
            <Link href="/reseller/orders" className="block text-sm text-primary hover:underline">
              → Create an order for a customer
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Architecture</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Your orders are fulfilled through the canonical RoamLink pipeline:
            </p>
            <div className="mt-3 text-xs font-mono text-muted-foreground bg-muted p-3 rounded-lg leading-relaxed">
              Customer → Product → DistributionOffer → Orchestration → Supplier → FulfillmentAdapter → Service → Ledger
            </div>
            <p className="text-xs text-muted-foreground mt-3">
              You manage retail pricing and customers. RoamLink handles supplier selection and fulfillment.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function UsageBar({ label, used, included }: { label: string; used: number; included: number }) {
  const pct = included > 0 ? Math.min((used / included) * 100, 100) : 0;
  const isNearLimit = pct >= 80;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className={isNearLimit ? "text-orange-600 font-medium" : ""}>
          {used} / {included === 999999 ? "∞" : included}
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${isNearLimit ? "bg-orange-500" : "bg-primary"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
