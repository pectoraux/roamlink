"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CreditCard, ChevronRight } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api-client";
import { formatPrice, formatDateTime, countryFlag, prettifyStatus, statusColor } from "@/lib/format";

type Order = {
  id: string;
  status: string;
  amountMinor: number;
  currency: string;
  paymentStatus: string;
  planName: string;
  country: string;
  countryCode: string;
  esimId: string | null;
  createdAt: string;
};

export default function OrdersPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push("/login?next=/dashboard/orders"); return; }
    api.get<{ orders: Order[] }>("/api/orders").then((d) => setOrders(d.orders)).catch(() => setOrders([]));
  }, [user, loading, router]);

  if (loading || !orders) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10">
      <h1 className="text-2xl font-bold tracking-tight">Order history</h1>
      <p className="text-sm text-muted-foreground">All your purchases in one place</p>

      {orders.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <CreditCard className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No orders yet</p>
              <p className="text-sm text-muted-foreground">When you buy a plan, it'll appear here.</p>
            </div>
            <Button asChild><Link href="/esim">Browse plans</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {orders.map((o) => (
            <Link key={o.id} href={`/order/${o.id}`}>
              <Card className="lift flex items-center gap-4 p-4">
                <span className="text-3xl leading-none" aria-hidden>{countryFlag(o.countryCode)}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{o.planName}</p>
                  <p className="text-xs text-muted-foreground">{formatDateTime(o.createdAt)}</p>
                </div>
                <div className="text-right">
                  <p className="font-semibold">{formatPrice(o.amountMinor, o.currency)}</p>
                  <Badge className={`mt-1 ${statusColor(o.status)}`}>{prettifyStatus(o.status)}</Badge>
                </div>
                <ChevronRight className="h-5 w-5 text-muted-foreground" />
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
