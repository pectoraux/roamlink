"use client";

/**
 * Phase 3 — New Product Page
 *
 * A client component form for creating a new reseller product. The form
 * posts to /api/commerce/products and redirects back to the portal on
 * success.
 *
 * The form supports both WiFi (INTERNET capability + MikroTik provider)
 * and eSIM (ROAMING capability + eSIM provider) products.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";

export default function NewProductPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [capabilityType, setCapabilityType] = useState("INTERNET");
  const [providerType, setProviderType] = useState("mikrotik");
  const [priceMinor, setPriceMinor] = useState(0);
  const [currency, setCurrency] = useState("USD");
  const [billingCycle, setBillingCycle] = useState("one_time");

  // Capability-specific fields
  const [downloadMbps, setDownloadMbps] = useState(50);
  const [uploadMbps, setUploadMbps] = useState(10);
  const [dataLimitBytes, setDataLimitBytes] = useState(0);
  const [allowedCountries, setAllowedCountries] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      // Build the capabilitySet based on the capability type
      const capabilitySet: Record<string, unknown> = {};
      if (capabilityType === "INTERNET") {
        capabilitySet.downloadMbps = downloadMbps;
        capabilitySet.uploadMbps = uploadMbps;
        if (dataLimitBytes > 0) capabilitySet.monthlyQuotaBytes = dataLimitBytes;
      } else if (capabilityType === "ROAMING") {
        if (dataLimitBytes > 0) capabilitySet.dataLimitBytes = dataLimitBytes;
        if (allowedCountries) {
          capabilitySet.allowedCountries = allowedCountries
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
        }
      }

      const res = await fetch("/api/commerce/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || undefined,
          capabilityType,
          providerType,
          priceMinor: Math.round(priceMinor * 100),
          currency,
          billingCycle,
          capabilitySet,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create product");
      }

      toast.success("Product created");
      router.push("/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create product");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="container mx-auto p-4 md:p-8 max-w-2xl">
        <Card>
          <CardHeader>
            <CardTitle>Create Product</CardTitle>
            <CardDescription>
              Add a connectivity product to your catalog. Customers can purchase this product
              and it will be automatically provisioned at the provider.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Product Name</Label>
                <Input
                  id="name"
                  placeholder="Accra WiFi 50Mbps Monthly"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  placeholder="High-speed WiFi access for 30 days"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Capability Type</Label>
                  <Select value={capabilityType} onValueChange={setCapabilityType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="INTERNET">Internet (WiFi/ISP)</SelectItem>
                      <SelectItem value="ROAMING">Roaming (eSIM)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Provider</Label>
                  <Select
                    value={providerType}
                    onValueChange={setProviderType}
                    disabled={capabilityType === "ROAMING"}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mikrotik">MikroTik (WiFi)</SelectItem>
                      <SelectItem value="esim">eSIM Supplier</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Capability-specific fields */}
              {capabilityType === "INTERNET" && (
                <div className="grid grid-cols-2 gap-4 p-4 border rounded-lg bg-muted/50">
                  <div className="space-y-2">
                    <Label htmlFor="download">Download (Mbps)</Label>
                    <Input
                      id="download"
                      type="number"
                      value={downloadMbps}
                      onChange={(e) => setDownloadMbps(Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="upload">Upload (Mbps)</Label>
                    <Input
                      id="upload"
                      type="number"
                      value={uploadMbps}
                      onChange={(e) => setUploadMbps(Number(e.target.value))}
                    />
                  </div>
                </div>
              )}

              {capabilityType === "ROAMING" && (
                <div className="space-y-4 p-4 border rounded-lg bg-muted/50">
                  <div className="space-y-2">
                    <Label htmlFor="countries">Allowed Countries (comma-separated ISO codes)</Label>
                    <Input
                      id="countries"
                      placeholder="GH, NG, KE"
                      value={allowedCountries}
                      onChange={(e) => setAllowedCountries(e.target.value)}
                    />
                  </div>
                </div>
              )}

              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="price">Price</Label>
                  <Input
                    id="price"
                    type="number"
                    step="0.01"
                    value={priceMinor}
                    onChange={(e) => setPriceMinor(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Currency</Label>
                  <Select value={currency} onValueChange={setCurrency}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="USD">USD</SelectItem>
                      <SelectItem value="GHS">GHS</SelectItem>
                      <SelectItem value="NGN">NGN</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Billing Cycle</Label>
                  <Select value={billingCycle} onValueChange={setBillingCycle}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="one_time">One-time</SelectItem>
                      <SelectItem value="monthly">Monthly</SelectItem>
                      <SelectItem value="prepaid">Prepaid</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="flex gap-2 pt-4">
                <Button type="submit" disabled={loading}>
                  {loading ? "Creating..." : "Create Product"}
                </Button>
                <Button type="button" variant="outline" onClick={() => router.push("/")}>
                  Cancel
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
