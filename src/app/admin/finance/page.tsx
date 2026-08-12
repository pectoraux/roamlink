"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, DollarSign, TrendingUp, TrendingDown, AlertTriangle, CreditCard, Users, Smartphone, Phone, Activity } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatPrice } from "@/lib/format";

type FinanceData = {
  today: { totalRevenue: number; totalProviderCost: number; totalPaymentFees: number; grossProfit: number; contributionProfit: number; transactionCount: number; activeESIMs: number; activeNumbers: number; successfulOrders: number; failedOrders: number };
  thisMonth: { totalRevenue: number; totalProviderCost: number; grossProfit: number; contributionProfit: number; mrr: number; newUsers: number; secondPurchaseRate: number };
  providers: { provider: string; creditLimit: number; outstandingLiability: number; availableCredit: number; utilization: number; alertLevel: string; canCommit: boolean; invoices: any[] }[];
  metrics: { totalUsers: number; activeESIMs: number; activeNumbers: number; successfulOrders: number; failedOrders: number; mrr: number; secondPurchaseRate: number };
};

export default function AdminFinancePage() {
  const [data, setData] = useState<FinanceData | null>(null);

  useEffect(() => {
    api.get<{ today: any; thisMonth: any; providers: any[]; metrics: any }>("/api/admin/finance").then((d) => setData(d as FinanceData));
  }, []);

  if (!data) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  const alertColors: Record<string, string> = {
    none: "bg-emerald-100 text-emerald-700",
    info: "bg-blue-100 text-blue-700",
    warn: "bg-amber-100 text-amber-700",
    elevated: "bg-orange-100 text-orange-700",
    critical: "bg-red-100 text-red-700",
    emergency: "bg-red-200 text-red-800",
  };

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Business Intelligence</h2>
      <p className="text-sm text-muted-foreground">Financial metrics, provider exposure & contribution profit</p>

      {/* Today */}
      <div className="mt-6">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">TODAY</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard icon={DollarSign} label="Revenue" value={formatPrice(data.today.totalRevenue)} tone="text-emerald-600" />
          <MetricCard icon={TrendingDown} label="Provider Cost" value={formatPrice(data.today.totalProviderCost)} tone="text-rose-600" />
          <MetricCard icon={TrendingUp} label="Contribution Profit" value={formatPrice(data.today.contributionProfit)} tone="text-emerald-600" />
          <MetricCard icon={Activity} label="Transactions" value={String(data.today.transactionCount)} />
        </div>
      </div>

      {/* This Month */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">THIS MONTH</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard icon={DollarSign} label="Revenue" value={formatPrice(data.thisMonth.totalRevenue)} tone="text-emerald-600" />
          <MetricCard icon={TrendingUp} label="Gross Profit" value={formatPrice(data.thisMonth.grossProfit)} tone="text-emerald-600" />
          <MetricCard icon={CreditCard} label="MRR" value={formatPrice(data.thisMonth.mrr)} tone="text-primary" />
          <MetricCard icon={Users} label="2nd Purchase Rate" value={`${data.thisMonth.secondPurchaseRate}%`} />
        </div>
      </div>

      {/* Key Metrics */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">KEY METRICS</h3>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <MetricCard icon={Users} label="Total Users" value={String(data.metrics.totalUsers)} />
          <MetricCard icon={Smartphone} label="Active eSIMs" value={String(data.metrics.activeESIMs)} />
          <MetricCard icon={Phone} label="Active Numbers" value={String(data.metrics.activeNumbers)} />
          <MetricCard icon={Activity} label="Successful Orders" value={String(data.metrics.successfulOrders)} />
        </div>
      </div>

      {/* Provider Credit Exposure */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">PROVIDER CREDIT EXPOSURE</h3>
        <div className="space-y-4">
          {data.providers.map((p) => (
            <Card key={p.provider}>
              <CardContent className="p-5">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <CreditCard className="h-5 w-5 text-primary" />
                    <span className="font-semibold capitalize">{p.provider}</span>
                  </div>
                  <Badge className={alertColors[p.alertLevel] || "bg-muted"}>{p.alertLevel}</Badge>
                </div>
                <div className="grid grid-cols-2 gap-4 md:grid-cols-4 text-sm">
                  <div>
                    <p className="text-xs text-muted-foreground">Credit Limit</p>
                    <p className="font-semibold">{formatPrice(p.creditLimit)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Outstanding Liability</p>
                    <p className="font-semibold text-rose-600">{formatPrice(p.outstandingLiability)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Available Credit</p>
                    <p className="font-semibold text-emerald-600">{formatPrice(p.availableCredit)}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Utilization</p>
                    <p className={`font-semibold ${p.utilization > 75 ? "text-rose-600" : "text-emerald-600"}`}>{p.utilization}%</p>
                  </div>
                </div>
                {/* Utilization bar */}
                <div className="mt-3 h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full ${p.utilization > 90 ? "bg-red-500" : p.utilization > 75 ? "bg-amber-500" : "bg-emerald-500"}`}
                    style={{ width: `${Math.min(100, p.utilization)}%` }}
                  />
                </div>
                {!p.canCommit && (
                  <div className="mt-3 flex items-center gap-2 text-sm text-rose-600">
                    <AlertTriangle className="h-4 w-4" />
                    New commitments restricted — credit at {p.utilization}% utilization
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Financial Definitions */}
      <Card className="mt-8">
        <CardHeader><CardTitle className="text-sm">Financial Definitions</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-xs text-muted-foreground">
          <p><strong>Gross Profit</strong> = Customer Price − Provider Cost</p>
          <p><strong>Contribution Profit</strong> = Gross Profit − Payment Fees − Refunds − Fraud Loss</p>
          <p><strong>MRR</strong> = Monthly Recurring Revenue (active number subscriptions)</p>
          <p><strong>2nd Purchase Rate</strong> = Users with 2+ completed orders / Total users</p>
          <p><strong>Provider Credit</strong> = Financial liability, NOT cash. Must be settled per provider terms.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, tone }: { icon: React.ElementType; label: string; value: string; tone?: string }) {
  return (
    <Card>
      <CardContent className="p-4">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <p className="mt-2 text-2xl font-bold">{value}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}
