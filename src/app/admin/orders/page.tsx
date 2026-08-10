"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatPrice, formatDateTime, countryFlag, prettifyStatus, statusColor } from "@/lib/format";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type Order = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  paymentReference: string | null;
  providerOrderId: string | null;
  createdAt: string;
  user: { email: string; name: string | null };
  plan: { name: string; country: string; countryCode: string };
  esim: { id: string } | null;
};

export default function AdminOrdersPage() {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  function load() {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    api.get<{ orders: Order[] }>(`/api/admin/orders?${params.toString()}`).then((d) => setOrders(d.orders)).catch(() => setOrders([]));
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, status]);

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Orders</h2>
      <p className="text-sm text-muted-foreground">Inspect payment & provisioning state</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search order id or email..." className="pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="PAYMENT_FAILED">Payment failed</SelectItem>
            <SelectItem value="PROVISIONING_FAILED">Provisioning failed</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!orders ? (
        <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : orders.length === 0 ? (
        <Card className="mt-4"><CardContent className="p-8 text-center text-sm text-muted-foreground">No orders found.</CardContent></Card>
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <div className="scroll-area max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-3">Order</th>
                    <th className="p-3">Customer</th>
                    <th className="p-3">Plan</th>
                    <th className="p-3">Amount</th>
                    <th className="p-3">Payment</th>
                    <th className="p-3">Provider order</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Date</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.id} className="border-t border-border/60 align-top">
                      <td className="p-3 font-mono text-xs">{o.id.slice(-10)}</td>
                      <td className="p-3">{o.user.email}</td>
                      <td className="p-3">
                        <div className="flex items-center gap-1.5">
                          <span aria-hidden>{countryFlag(o.plan.countryCode)}</span>
                          <span className="truncate">{o.plan.name}</span>
                        </div>
                      </td>
                      <td className="p-3 font-medium">{formatPrice(o.amount, o.currency)}</td>
                      <td className="p-3">
                        <Badge className={statusColor(o.paymentStatus)}>{prettifyStatus(o.paymentStatus)}</Badge>
                        {o.paymentReference && <p className="mt-1 font-mono text-[10px] text-muted-foreground">{o.paymentReference.slice(-12)}</p>}
                      </td>
                      <td className="p-3 font-mono text-[10px] text-muted-foreground">{o.providerOrderId?.slice(-12) ?? "—"}</td>
                      <td className="p-3"><Badge className={statusColor(o.status)}>{prettifyStatus(o.status)}</Badge></td>
                      <td className="p-3 text-xs text-muted-foreground">{formatDateTime(o.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
