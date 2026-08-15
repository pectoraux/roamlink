"use client";

/**
 * Phase 3 — Checkout Form (client component)
 *
 * Handles the purchase flow:
 *   1. Customer enters email (or is logged in)
 *   2. POST /api/commerce/orders — creates a pending order
 *   3. POST /api/commerce/orders/[id]/fulfill — simulates payment + provisioning
 *   4. Displays the credentials (WiFi password / eSIM ICCID)
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { CheckCircle2, Loader2, Wifi, Smartphone } from "lucide-react";

type FulfillmentState = "idle" | "creating_order" | "fulfilling" | "fulfilled" | "failed";

export function CheckoutForm({ productId, tenantId: _tenantId }: { productId: string; tenantId: string }) {
  // tenantId is no longer sent to the API — the customer API derives it
  // from the productId for security (Phase 5.1C). It's kept in the props
  // for potential future UI use but prefixed with _ to indicate unused.
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [state, setState] = useState<FulfillmentState>("idle");
  const [credentials, setCredentials] = useState<Record<string, unknown> | null>(null);
  const [orderId, setOrderId] = useState<string | null>(null);

  async function handlePurchase(e: React.FormEvent) {
    e.preventDefault();
    setState("creating_order");

    try {
      // Step 1: Find or create a customer user with this email.
      // SECURITY (Phase 5.1C): the API derives tenantId from the productId,
      // not from the request body. This prevents creating users in arbitrary tenants.
      const customerRes = await fetch("/api/commerce/customer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, productId }),
      });

      if (!customerRes.ok) {
        const data = await customerRes.json();
        throw new Error(data.error || "Failed to find/create customer");
      }

      const { customer } = await customerRes.json();

      // Step 2: Create the order
      const orderRes = await fetch("/api/commerce/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, customerId: customer.id }),
      });

      if (!orderRes.ok) {
        const data = await orderRes.json();
        throw new Error(data.error || "Failed to create order");
      }

      const { order } = await orderRes.json();
      setOrderId(order.id);
      setState("fulfilling");

      // Step 3: Fulfill the order (simulates payment + provisioning)
      const fulfillRes = await fetch(`/api/commerce/orders/${order.id}/fulfill`, {
        method: "POST",
      });

      if (!fulfillRes.ok) {
        const data = await fulfillRes.json();
        throw new Error(data.error || data.result?.error || "Fulfillment failed");
      }

      const { result } = await fulfillRes.json();

      if (result.status === "fulfilled") {
        setCredentials(result.credentials);
        setState("fulfilled");
        toast.success("Purchase complete!");
      } else {
        throw new Error(result.error || "Fulfillment failed");
      }
    } catch (err) {
      setState("failed");
      toast.error(err instanceof Error ? err.message : "Purchase failed");
    }
  }

  if (state === "fulfilled" && credentials) {
    return (
      <Card>
        <CardContent className="pt-6 space-y-4">
          <div className="flex items-center gap-3">
            <div className="rounded-full bg-green-100 p-2">
              <CheckCircle2 className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h3 className="font-semibold text-lg">Purchase Complete!</h3>
              <p className="text-sm text-muted-foreground">Your connectivity is now active.</p>
            </div>
          </div>

          <div className="space-y-3 p-4 border rounded-lg bg-muted/50">
            <h4 className="font-medium text-sm">Your Credentials</h4>

            {credentials.hotspotUsername && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Wifi className="h-4 w-4" />
                  WiFi Username
                </div>
                <div className="font-mono text-lg font-semibold bg-background p-2 rounded border">
                  {credentials.hotspotUsername as string}
                </div>
              </div>
            )}

            {credentials.iccid && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Smartphone className="h-4 w-4" />
                  eSIM ICCID
                </div>
                <div className="font-mono text-lg font-semibold bg-background p-2 rounded border">
                  {credentials.iccid as string}
                </div>
              </div>
            )}

            {credentials.instructions && (
              <p className="text-xs text-muted-foreground pt-2">
                {credentials.instructions as string}
              </p>
            )}

            {orderId && (
              <p className="text-xs text-muted-foreground pt-2 border-t">
                Order ID: <span className="font-mono">{orderId}</span>
              </p>
            )}
          </div>

          <Button variant="outline" className="w-full" onClick={() => window.location.reload()}>
            Buy another
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <form onSubmit={handlePurchase} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="name">Full Name</Label>
            <Input
              id="name"
              placeholder="Jane Doe"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="jane@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={state !== "idle"}>
            {state === "creating_order" && (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Creating order...
              </>
            )}
            {state === "fulfilling" && (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Provisioning...
              </>
            )}
            {state === "idle" && "Buy Now"}
            {state === "failed" && "Retry"}
          </Button>
          <p className="text-xs text-center text-muted-foreground">
            Payment is simulated for this demo. In production, Stripe/Paystack handles payment.
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
