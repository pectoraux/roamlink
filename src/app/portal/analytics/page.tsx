"use client";

/**
 * Phase 6.6 — Reseller Analytics Dashboard
 *
 * Shows revenue, profit, customers, usage, and recent orders.
 */

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DollarSign, TrendingUp, Users, Package } from "lucide-react";

type Analytics = {
  period: { days: number; since: string };
  revenue: number;
  profit: number;
  costs: number;
  fees: number;
  platformFees: number;
  orderCount: number;
  activeEntitlements: number;
  customerCount: number;
  ordersByStatus: Record<string, number>;
  recentOrders: Array<{
    id: string;
    status: string;
    paidAmountMinor: number;
    currency: string;
    createdAt: string;
    product: { name: string };
    customer: { email: string; name: string | null };
  }>;
};

export default function AnalyticsPage() {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [days, setDays] = useState("30");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const res = await fetch(`/api/analytics/reseller?days=${days}`);
      if (res.ok && !cancelled) {
        const data = await res.json();
        setAnalytics(data.analytics);
      }
    })();
    return () => { cancelled = true; };
  }, [days]);

  if (!analytics) {
    return <div className="min-h-screen flex items-center justify-center">Loading...</div>;
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="container mx-auto p-4 md:p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Analytics</h1>
            <p className="text-muted-foreground">Your business at a glance</p>
          </div>
          <Select value={days} onValueChange={setDays}>
            <SelectTrigger className="w-[140px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Revenue</CardTitle>
              <DollarSign className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">${(analytics.revenue / 100).toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">{analytics.orderCount} orders</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Profit</CardTitle>
              <TrendingUp className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold text-green-600">${(analytics.profit / 100).toFixed(2)}</div>
              <p className="text-xs text-muted-foreground">
                Margin: {analytics.revenue > 0 ? ((analytics.profit / analytics.revenue) * 100).toFixed(1) : 0}%
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Customers</CardTitle>
              <Users className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.customerCount}</div>
              <p className="text-xs text-muted-foreground">Total unique</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Entitlements</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{analytics.activeEntitlements}</div>
              <p className="text-xs text-muted-foreground">Currently provisioned</p>
            </CardContent>
          </Card>
        </div>

        {/* Cost Breakdown */}
        <Card>
          <CardHeader>
            <CardTitle>Cost Breakdown</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-muted-foreground">Provider Costs</p>
                <p className="font-medium">${(analytics.costs / 100).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Payment Fees</p>
                <p className="font-medium">${(analytics.fees / 100).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Platform Fees</p>
                <p className="font-medium">${(analytics.platformFees / 100).toFixed(2)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Net Profit</p>
                <p className="font-medium text-green-600">${(analytics.profit / 100).toFixed(2)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
          </CardHeader>
          <CardContent>
            {analytics.recentOrders.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No orders in this period.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {analytics.recentOrders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-medium">
                        {order.customer.name ?? order.customer.email}
                      </TableCell>
                      <TableCell>{order.product.name}</TableCell>
                      <TableCell>${(order.paidAmountMinor / 100).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={order.status === "fulfilled" ? "default" : "secondary"}>
                          {order.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
