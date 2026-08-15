/**
 * Phase 3 — Customer Checkout Page
 *
 * A public page where a customer can view a product and purchase it.
 * The page is a server component that fetches the product by ID, then
 * renders a client-side checkout form.
 *
 * Flow:
 *   1. Customer visits /checkout/[productId]
 *   2. Page fetches the product (must be active)
 *   3. Customer enters their email (or is already logged in)
 *   4. On "Buy", a CustomerOrder is created (POST /api/commerce/orders)
 *   5. The order is fulfilled (POST /api/commerce/orders/[id]/fulfill)
 *      — this simulates payment confirmation + provisioning
 *   6. The customer sees their credentials (WiFi password / eSIM ICCID)
 *
 * In production, step 5 would be split:
 *   - Step 4 creates the order (pending)
 *   - Stripe/Paystack handles payment
 *   - A webhook marks the order paid and calls fulfillOrder()
 * For the MVP, we simulate payment confirmation directly.
 */

import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { CheckoutForm } from "./checkout-form";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ productId: string }>;
}) {
  const { productId } = await params;

  const product = await db.resellerProduct.findFirst({
    where: { id: productId, status: "active" },
    include: {
      tenant: { select: { id: true, name: true, slug: true, brandName: true } },
    },
  });

  if (!product) {
    notFound();
  }

  const capabilitySet = JSON.parse(product.capabilitySet);
  const brandName = product.tenant.brandName ?? product.tenant.name;

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-bold">{brandName}</h1>
          <p className="text-sm text-muted-foreground">Purchase connectivity</p>
        </div>

        <div className="border rounded-lg p-6 space-y-4">
          <div>
            <h2 className="text-xl font-semibold">{product.name}</h2>
            {product.description && (
              <p className="text-sm text-muted-foreground mt-1">{product.description}</p>
            )}
          </div>

          {/* Capability details */}
          <div className="space-y-2 text-sm">
            {product.capabilityType === "INTERNET" && (
              <>
                {capabilitySet.downloadMbps && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Download</span>
                    <span className="font-medium">{capabilitySet.downloadMbps} Mbps</span>
                  </div>
                )}
                {capabilitySet.uploadMbps && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Upload</span>
                    <span className="font-medium">{capabilitySet.uploadMbps} Mbps</span>
                  </div>
                )}
              </>
            )}
            {product.capabilityType === "ROAMING" && (
              <>
                {capabilitySet.dataLimitBytes && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Data</span>
                    <span className="font-medium">
                      {(capabilitySet.dataLimitBytes / 1_000_000_000).toFixed(1)} GB
                    </span>
                  </div>
                )}
                {capabilitySet.allowedCountries && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Countries</span>
                    <span className="font-medium">
                      {(capabilitySet.allowedCountries as string[]).join(", ")}
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="flex justify-between border-t pt-2">
              <span className="text-muted-foreground">Validity</span>
              <span className="font-medium">
                {product.billingCycle === "monthly" ? "30 days" : product.billingCycle}
              </span>
            </div>
          </div>

          <div className="border-t pt-4">
            <div className="flex justify-between items-center">
              <span className="text-lg font-medium">Total</span>
              <span className="text-2xl font-bold">
                {product.priceMinor === 0
                  ? "Free"
                  : `${(product.priceMinor / 100).toFixed(2)} ${product.currency}`}
              </span>
            </div>
          </div>
        </div>

        <CheckoutForm productId={product.id} tenantId={product.tenantId} />
      </div>
    </div>
  );
}
