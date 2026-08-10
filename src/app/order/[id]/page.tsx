"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, PartyPopper, Smartphone, AlertCircle, RefreshCw, Clock } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { formatPrice, formatDataSize, countryFlag, prettifyStatus, statusColor } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { SendToPhoneButton } from "@/components/send-to-phone-button";

type OrderData = {
  order: {
    id: string;
    status: string;
    amountMinor: number;
    currency: string;
    paymentStatus: string;
    planName: string;
    country: string;
    countryCode: string;
    dataAmountMB: number;
    validityDays: number;
    esimId: string | null;
    failureReason: string | null;
  };
};

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [order, setOrder] = useState<OrderData["order"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [resolvedId, setResolvedId] = useState<string | null>(null);

  useEffect(() => {
    params.then((p) => setResolvedId(p.id));
  }, [params]);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push(`/login?next=/order/${resolvedId}`);
      return;
    }
    if (!resolvedId) return;
    let cancelled = false;
    async function load() {
      try {
        const data = await api.get<OrderData>(`/api/orders/${resolvedId}`);
        if (cancelled) return;
        setOrder(data.order);

        // Redirect-return flow: if we stashed payment refs (from a redirect
        // provider like PayStack/Flutterwave) and the order is still pending
        // payment, auto-confirm server-side now.
        const stash = sessionStorage.getItem(`pay_return_${resolvedId}`);
        if (stash && data.order.paymentStatus === "pending") {
          sessionStorage.removeItem(`pay_return_${resolvedId}`);
          const { paymentReference, confirmKey } = JSON.parse(stash);
          try {
            const res = await api.post<{ status: string; esimId: string | null }>("/api/payments/confirm", {
              orderId: resolvedId,
              paymentReference,
              idempotencyKey: confirmKey,
            });
            if (res.status === "COMPLETED") {
              toast.success("Payment confirmed — your eSIM is ready!");
            } else if (res.status === "PAYMENT_FAILED") {
              toast.error("Payment was not completed.");
            }
          } catch (e) {
            // Verification may genuinely fail if the user didn't pay — show a soft message.
            toast.error(e instanceof ApiError ? e.message : "Payment verification pending.");
          }
          // Reload to reflect the confirmed state.
          const fresh = await api.get<OrderData>(`/api/orders/${resolvedId}`);
          if (!cancelled) setOrder(fresh.order);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load order");
      }
    }
    load();
    return () => { cancelled = true; };
  }, [authLoading, user, router, resolvedId]);

  async function retryProvisioning() {
    if (!resolvedId) return;
    setRetrying(true);
    try {
      const res = await api.post<{ status: string; esimId: string | null }>(`/api/payments/confirm`, {
        orderId: resolvedId,
        idempotencyKey: `retry_${resolvedId}_${Date.now()}`,
      });
      if (res.status === "COMPLETED" && res.esimId) {
        toast.success("eSIM activated!");
        const data = await api.get<OrderData>(`/api/orders/${resolvedId}`);
        setOrder(data.order);
      } else {
        toast.error("Activation still failing. We'll keep retrying.");
      }
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  if (authLoading || (!order && !error)) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        <p className="mt-2 text-sm">Loading order…</p>
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-muted-foreground" />
        <p className="mt-4 font-medium">{error ?? "Order not found"}</p>
        <Button asChild className="mt-4"><Link href="/dashboard/orders">View orders</Link></Button>
      </div>
    );
  }

  const completed = order.status === "COMPLETED";
  const provisioning = ["PAYMENT_CONFIRMED", "ESIM_PROVISIONING", "ESIM_PROVISIONED"].includes(order.status);
  const failed = ["PAYMENT_FAILED", "PROVISIONING_FAILED"].includes(order.status);

  return (
    <div className="mx-auto max-w-lg px-4 py-10">
      {completed ? (
        <div className="flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
            <PartyPopper className="h-8 w-8" />
          </div>
          <h1 className="mt-5 text-2xl font-bold tracking-tight">Your eSIM is ready 🎉</h1>
          <p className="mt-1 text-sm text-muted-foreground">Payment confirmed and eSIM activated.</p>

          <Card className="mt-6 w-full">
            <CardContent className="p-6">
              <div className="flex items-center gap-3">
                <span className="text-4xl leading-none" aria-hidden>{countryFlag(order.countryCode)}</span>
                <div className="text-left">
                  <p className="font-semibold">{order.country}</p>
                  <p className="text-xs text-muted-foreground">{order.planName}</p>
                </div>
                <Badge className={`ml-auto ${statusColor(order.status)}`}>{prettifyStatus(order.status)}</Badge>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 border-t border-border/60 pt-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Data</p>
                  <p className="font-semibold">{formatDataSize(order.dataAmountMB)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Validity</p>
                  <p className="font-semibold">{order.validityDays} days</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Amount paid</p>
                  <p className="font-semibold">{formatPrice(order.amountMinor, order.currency)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Order ID</p>
                  <p className="font-mono text-xs">{order.id.slice(-8)}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="mt-6 flex w-full flex-col gap-3">
            {order.esimId && (
              <>
                <Button asChild size="lg">
                  <Link href={`/dashboard/esims/${order.esimId}`}>
                    <Smartphone className="mr-2 h-4 w-4" /> Install eSIM
                  </Link>
                </Button>
                <SendToPhoneButton esimId={order.esimId} />
              </>
            )}
            <Button asChild variant="outline">
              <Link href="/dashboard/esims">View My eSIMs</Link>
            </Button>
          </div>
        </div>
      ) : provisioning ? (
        <div className="flex flex-col items-center text-center">
          <Loader2 className="h-10 w-10 animate-spin text-primary" />
          <h1 className="mt-5 text-xl font-semibold">Activating your eSIM…</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Payment received. We're activating your eSIM now — this usually takes a few seconds.
          </p>
          <Badge className={`mt-4 ${statusColor(order.status)}`}>{prettifyStatus(order.status)}</Badge>
          <Button variant="outline" className="mt-6" onClick={() => location.reload()}>
            <RefreshCw className="mr-2 h-4 w-4" /> Refresh
          </Button>
        </div>
      ) : failed ? (
        <div className="flex flex-col items-center text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-400">
            {order.status === "PAYMENT_FAILED" ? <AlertCircle className="h-8 w-8" /> : <Clock className="h-8 w-8" />}
          </div>
          <h1 className="mt-5 text-xl font-semibold">
            {order.status === "PAYMENT_FAILED" ? "Payment failed" : "Activation delayed"}
          </h1>
          <p className="mt-1 max-w-sm text-sm text-muted-foreground">
            {order.status === "PAYMENT_FAILED"
              ? "We couldn't process your payment. No charge was made. Please try again."
              : "Your payment has been received and we're retrying activation. You don't need to do anything — your order is saved."}
          </p>
          <Badge className={`mt-4 ${statusColor(order.status)}`}>{prettifyStatus(order.status)}</Badge>
          <div className="mt-6 flex gap-3">
            {order.status === "PROVISIONING_FAILED" && (
              <Button onClick={retryProvisioning} disabled={retrying}>
                {retrying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Retry activation
              </Button>
            )}
            <Button asChild variant="outline"><Link href="/esim">Browse plans</Link></Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col items-center text-center">
          <Badge className={statusColor(order.status)}>{prettifyStatus(order.status)}</Badge>
          <Button asChild className="mt-6"><Link href="/dashboard/orders">View orders</Link></Button>
        </div>
      )}
    </div>
  );
}
