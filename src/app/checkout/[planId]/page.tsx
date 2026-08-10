"use client";

import { useState, use, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { ArrowLeft, ShieldCheck, CreditCard, Loader2, Lock } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import { formatPrice, formatDataSize, countryFlag } from "@/lib/format";
import type { PublicPlan } from "@/types";

export default function CheckoutPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = use(params);
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [plan, setPlan] = useState<PublicPlan | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<"form" | "processing">("form");
  // Mock card fields (never stored — Rule 10).
  const [cardName, setCardName] = useState("");
  const [cardNumber, setCardNumber] = useState("4242 4242 4242 4242");
  const [expiry, setExpiry] = useState("12/26");
  const [cvc, setCvc] = useState("123");
  const [paymentMethod, setPaymentMethod] = useState("card");

  // Fetch plan client-side + redirect to login if unauthenticated (in effects).
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push(`/login?next=/checkout/${planId}`);
      return;
    }
    if (!plan && !loadError) {
      api
        .get<{ plan: PublicPlan }>(`/api/plans/${planId}`)
        .then((d) => setPlan(d.plan))
        .catch((e) => setLoadError(e instanceof ApiError ? e.message : "Failed to load plan"));
    }
  }, [authLoading, user, plan, loadError, planId, router]);

  async function handlePay(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setLoading(true);
    setStep("processing");
    try {
      // 1. Create order (idempotent).
      const checkoutKey = `checkout_${planId}_${user.id}`;
      const orderRes = await api.post<{ order: { id: string }; idempotencyKey: string }>("/api/orders", {
        planId,
        idempotencyKey: checkoutKey,
      });
      const orderId = orderRes.order.id;

      // 2. Initiate payment (idempotent).
      const payKey = `payment_${orderId}`;
      const payRes = await api.post<{ paymentReference: string; idempotencyKey: string }>("/api/payments", {
        orderId,
        idempotencyKey: payKey,
      });

      // 3. Confirm payment (server-side verified) + provision.
      const confirmKey = `confirm_${orderId}`;
      const confirmRes = await api.post<{ status: string; esimId: string | null; paymentStatus: string }>(
        "/api/payments/confirm",
        { orderId, paymentReference: payRes.paymentReference, idempotencyKey: confirmKey },
      );

      if (confirmRes.status === "COMPLETED" && confirmRes.esimId) {
        toast.success("Payment confirmed — your eSIM is ready!");
        router.push(`/order/${orderId}`);
      } else if (confirmRes.status === "PAYMENT_FAILED") {
        toast.error("Payment failed. Please try again.");
        setStep("form");
        setLoading(false);
      } else if (confirmRes.status === "PROVISIONING_FAILED") {
        toast.error("Payment received but activation failed. We'll retry — your order is saved.");
        router.push(`/order/${orderId}`);
      } else {
        toast.error("Payment is still processing. Please wait a moment.");
        router.push(`/order/${orderId}`);
      }
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Checkout failed");
      setStep("form");
      setLoading(false);
    }
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <p className="font-medium">{loadError}</p>
        <Button asChild className="mt-4"><Link href="/esim">Browse plans</Link></Button>
      </div>
    );
  }

  if (!plan) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
        <p className="mt-2 text-sm">Loading plan…</p>
      </div>
    );
  }

  if (step === "processing") {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center px-4 py-24 text-center">
        <Loader2 className="h-10 w-10 animate-spin text-primary" />
        <h2 className="mt-6 text-xl font-semibold">Processing your payment</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Verifying payment securely and activating your eSIM. Please don't close this window.
        </p>
      </div>
    );
  }

  const fees = 0; // taxes/fees included
  const total = plan.priceMinor + fees;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href={`/esim/${planId}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to plan
      </Link>

      <h1 className="mt-4 text-2xl font-bold tracking-tight">Checkout</h1>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_360px]">
        {/* Payment form */}
        <div>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base"><Lock className="h-4 w-4 text-primary" /> Payment</CardTitle>
            </CardHeader>
            <CardContent>
              <form onSubmit={handlePay} className="space-y-4">
                <div className="space-y-2">
                  <Label>Email</Label>
                  <Input value={user?.email ?? ""} disabled />
                </div>

                <RadioGroup value={paymentMethod} onValueChange={setPaymentMethod} className="gap-2">
                  <Label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/60 p-3 has-[:checked]:border-primary has-[:checked]:bg-primary/5">
                    <RadioGroupItem value="card" />
                    <CreditCard className="h-4 w-4" />
                    <span className="text-sm font-medium">Card</span>
                    <span className="ml-auto text-xs text-muted-foreground">Mock</span>
                  </Label>
                  <Label className="flex cursor-pointer items-center gap-3 rounded-lg border border-border/60 p-3 opacity-60">
                    <RadioGroupItem value="mobile" disabled />
                    <span className="text-sm font-medium">Mobile Money</span>
                    <span className="ml-auto text-xs text-muted-foreground">Coming soon</span>
                  </Label>
                </RadioGroup>

                <div className="space-y-2">
                  <Label htmlFor="cardname">Name on card</Label>
                  <Input id="cardname" required value={cardName} onChange={(e) => setCardName(e.target.value)} placeholder="Full name" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="cardnumber">Card number</Label>
                  <Input id="cardnumber" required value={cardNumber} onChange={(e) => setCardNumber(e.target.value)} inputMode="numeric" />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="expiry">Expiry</Label>
                    <Input id="expiry" required value={expiry} onChange={(e) => setExpiry(e.target.value)} placeholder="MM/YY" />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="cvc">CVC</Label>
                    <Input id="cvc" required value={cvc} onChange={(e) => setCvc(e.target.value)} placeholder="123" inputMode="numeric" />
                  </div>
                </div>

                <div className="rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
                  <p className="font-medium text-foreground">Development mode</p>
                  <p className="mt-1">This is a mock payment. No real card is charged. Use card number 4242 4242 4242 4242 for success. We do not store card details.</p>
                </div>

                <Button type="submit" size="lg" className="w-full" disabled={loading}>
                  {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Pay {formatPrice(total, plan.currency)}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>

        {/* Order summary */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Order summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-3xl leading-none" aria-hidden>{countryFlag(plan.countryCode)}</span>
                <div>
                  <p className="font-semibold">{plan.country}</p>
                  <p className="text-xs text-muted-foreground">{plan.name}</p>
                </div>
              </div>

              <div className="space-y-2 border-t border-border/60 pt-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Data</span>
                  <span className="font-medium">{formatDataSize(plan.dataAmountMB)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Validity</span>
                  <span className="font-medium">{plan.validityDays} days</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Network</span>
                  <span className="font-medium">{plan.speed ?? "4G/5G"}</span>
                </div>
              </div>

              <div className="space-y-2 border-t border-border/60 pt-4 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Subtotal</span>
                  <span>{formatPrice(plan.priceMinor, plan.currency)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Taxes & fees</span>
                  <span>Included</span>
                </div>
                <div className="flex items-baseline justify-between border-t border-border/60 pt-3">
                  <span className="font-semibold">Total</span>
                  <span className="text-2xl font-bold">{formatPrice(total, plan.currency)}</span>
                </div>
              </div>

              <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Secured · Server-verified payment
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
