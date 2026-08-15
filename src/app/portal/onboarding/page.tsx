"use client";

/**
 * Phase 6.4 — Operator Onboarding Wizard
 *
 * A multi-step onboarding flow that guides the operator through:
 *   1. Choose operator type (WiFi / Telco / eSIM)
 *   2. Connect infrastructure (router for WiFi, supplier API for eSIM/telco)
 *   3. Create first product
 *   4. Launch storefront
 *
 * This replaces the "figure it out yourself" experience with a guided flow.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Router, Smartphone, Radio, CheckCircle2, ArrowRight } from "lucide-react";

type OperatorType = "wifi" | "telco" | "esim";

export default function OnboardingWizardPage() {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [operatorType, setOperatorType] = useState<OperatorType | null>(null);

  // Infrastructure form
  const [instanceName, setInstanceName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [configKey, setConfigKey] = useState("");

  // Product form
  const [productName, setProductName] = useState("");
  const [price, setPrice] = useState(0);
  const [downloadMbps, setDownloadMbps] = useState(50);

  const steps = [
    { num: 1, label: "Choose Type" },
    { num: 2, label: "Connect Infrastructure" },
    { num: 3, label: "Create Product" },
    { num: 4, label: "Launch" },
  ];

  async function handleConnectInfrastructure() {
    if (!operatorType || !instanceName) {
      toast.error("Please fill in all required fields");
      return;
    }

    const providerType = operatorType === "wifi" ? "mikrotik" : "esim";

    try {
      const res = await fetch("/api/connectivity/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerType,
          name: instanceName,
          endpoint: endpoint || undefined,
          configurationKey: configKey || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to connect");
      }

      toast.success("Infrastructure connected!");
      setStep(3);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect");
    }
  }

  async function handleCreateProduct() {
    if (!productName) {
      toast.error("Please enter a product name");
      return;
    }

    const capabilityType = operatorType === "wifi" ? "INTERNET" : "ROAMING";
    const providerType = operatorType === "wifi" ? "mikrotik" : "esim";

    try {
      const res = await fetch("/api/commerce/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: productName,
          capabilityType,
          providerType,
          priceMinor: Math.round(price * 100),
          currency: "USD",
          billingCycle: "one_time",
          capabilitySet: operatorType === "wifi"
            ? { downloadMbps, uploadMbps: 10 }
            : { dataLimitBytes: 5_000_000_000, validityDays: 30, allowedCountries: ["GH"] },
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create product");
      }

      toast.success("Product created!");
      setStep(4);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create product");
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="container mx-auto p-4 md:p-8 max-w-2xl">
        <div className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">Welcome to RoamLink</h1>
          <p className="text-muted-foreground">Let&apos;s set up your connectivity business in 4 steps.</p>
        </div>

        {/* Steps */}
        <div className="flex items-center justify-between mb-8">
          {steps.map((s, i) => (
            <div key={s.num} className="flex items-center flex-1">
              <div className={`flex items-center gap-2 ${step >= s.num ? "text-primary" : "text-muted-foreground"}`}>
                <div className={`w-8 h-8 rounded-full flex items-center justify-center border-2 ${step > s.num ? "bg-primary text-primary-foreground border-primary" : step === s.num ? "border-primary" : "border-muted"}`}>
                  {step > s.num ? <CheckCircle2 className="h-4 w-4" /> : s.num}
                </div>
                <span className="text-sm font-medium hidden md:inline">{s.label}</span>
              </div>
              {i < steps.length - 1 && <div className={`flex-1 h-px mx-2 ${step > s.num ? "bg-primary" : "bg-muted"}`} />}
            </div>
          ))}
        </div>

        {/* Step 1: Choose Type */}
        {step === 1 && (
          <Card>
            <CardHeader>
              <CardTitle>What type of connectivity do you sell?</CardTitle>
              <CardDescription>Choose your operator type to get started.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <button
                onClick={() => { setOperatorType("wifi"); setStep(2); }}
                className="w-full p-4 border rounded-lg hover:border-primary text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Router className="h-6 w-6" />
                  <div>
                    <p className="font-medium">WiFi Operator</p>
                    <p className="text-sm text-muted-foreground">Manage hotspots, sell WiFi access (MikroTik)</p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => { setOperatorType("telco"); setStep(2); }}
                className="w-full p-4 border rounded-lg hover:border-primary text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Radio className="h-6 w-6" />
                  <div>
                    <p className="font-medium">Telco Reseller</p>
                    <p className="text-sm text-muted-foreground">Import and resell telecom products</p>
                  </div>
                </div>
              </button>

              <button
                onClick={() => { setOperatorType("esim"); setStep(2); }}
                className="w-full p-4 border rounded-lg hover:border-primary text-left transition-colors"
              >
                <div className="flex items-center gap-3">
                  <Smartphone className="h-6 w-6" />
                  <div>
                    <p className="font-medium">eSIM Reseller</p>
                    <p className="text-sm text-muted-foreground">Sell roaming eSIM data products</p>
                  </div>
                </div>
              </button>
            </CardContent>
          </Card>
        )}

        {/* Step 2: Connect Infrastructure */}
        {step === 2 && (
          <Card>
            <CardHeader>
              <CardTitle>
                Connect your {operatorType === "wifi" ? "MikroTik router" : operatorType === "esim" ? "eSIM supplier" : "telco provider"}
              </CardTitle>
              <CardDescription>
                {operatorType === "wifi"
                  ? "Enter your router's REST API endpoint. Credentials are stored via environment variables."
                  : "Enter your supplier's API endpoint and configuration key."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  placeholder={operatorType === "wifi" ? "Accra Router 01" : "Airalo Production"}
                  value={instanceName}
                  onChange={(e) => setInstanceName(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="endpoint">Endpoint URL</Label>
                <Input
                  id="endpoint"
                  placeholder={operatorType === "wifi" ? "https://192.168.1.1/rest" : "https://api.supplier.com/v1"}
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="configKey">Configuration Key</Label>
                <Input
                  id="configKey"
                  placeholder={operatorType === "wifi" ? "mikrotik-accra-01" : "esim-airalo-prod"}
                  value={configKey}
                  onChange={(e) => setConfigKey(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  References env vars for credentials. Ask your admin to configure them.
                </p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(1)}>Back</Button>
                <Button onClick={handleConnectInfrastructure}>
                  Connect <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 3: Create Product */}
        {step === 3 && (
          <Card>
            <CardHeader>
              <CardTitle>Create your first product</CardTitle>
              <CardDescription>
                {operatorType === "wifi"
                  ? "Define a WiFi plan your customers can buy."
                  : "Define a data product your customers can buy."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="productName">Product Name</Label>
                <Input
                  id="productName"
                  placeholder={operatorType === "wifi" ? "Accra WiFi 50Mbps Monthly" : "5GB Roaming 30 Days"}
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                />
              </div>
              {operatorType === "wifi" && (
                <div className="space-y-2">
                  <Label htmlFor="speed">Download Speed (Mbps)</Label>
                  <Input
                    id="speed"
                    type="number"
                    value={downloadMbps}
                    onChange={(e) => setDownloadMbps(Number(e.target.value))}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label htmlFor="price">Price (USD)</Label>
                <Input
                  id="price"
                  type="number"
                  step="0.01"
                  value={price}
                  onChange={(e) => setPrice(Number(e.target.value))}
                />
              </div>
              <div className="flex gap-2">
                <Button variant="outline" onClick={() => setStep(2)}>Back</Button>
                <Button onClick={handleCreateProduct}>
                  Create Product <ArrowRight className="ml-2 h-4 w-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Step 4: Launch */}
        {step === 4 && (
          <Card>
            <CardHeader className="text-center">
              <div className="mx-auto w-12 h-12 rounded-full bg-green-100 flex items-center justify-center mb-2">
                <CheckCircle2 className="h-6 w-6 text-green-600" />
              </div>
              <CardTitle>You&apos;re ready to sell!</CardTitle>
              <CardDescription>
                Your infrastructure is connected and your first product is live.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="bg-muted/50 rounded-lg p-4 space-y-2">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Operator type</span>
                  <Badge>{operatorType}</Badge>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Infrastructure</span>
                  <span className="font-medium">{instanceName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Product</span>
                  <span className="font-medium">{productName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Price</span>
                  <span className="font-medium">${price.toFixed(2)}</span>
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <Button onClick={() => router.push("/")}>
                  Go to Dashboard
                </Button>
                <Button variant="outline" onClick={() => router.push("/marketplace")}>
                  View Marketplace
                </Button>
                <Button variant="outline" onClick={() => router.push("/portal/analytics")}>
                  View Analytics
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
