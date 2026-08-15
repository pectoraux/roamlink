"use client";

/**
 * Phase 6.2/6.3 — Marketplace Page
 *
 * The customer-facing "connectivity intelligence" page. The customer
 * doesn't choose a product — they express a need in natural language,
 * and the system ranks available offers.
 *
 * Flow:
 *   1. Customer types their need ("I need internet in Accra today")
 *   2. POST /api/commerce/intent — parses + ranks offers
 *   3. Customer sees ranked offers with scores + match reasons
 *   4. Customer selects an offer → POST /api/commerce/intent/[id]/purchase
 *   5. Redirects to payment provider
 *   6. After payment, webhook → fulfillOrder() → credentials
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Search, Wifi, Smartphone, CheckCircle2, MapPin, DollarSign, Zap, Gauge } from "lucide-react";

type RankedOffer = {
  offerId: string;
  score: number;
  customerPriceMinor: number;
  matchReasons: string[];
  scores: {
    intentMatch: number;
    locationMatch: number;
    availability: number;
    price: number;
    margin: number;
    reliability: number;
  };
  offer: {
    capabilityType: string;
    providerType: string;
    spec: {
      downloadMbps?: number;
      uploadMbps?: number;
      dataLimitBytes?: number;
      validityDays?: number;
      allowedCountries?: string[];
    };
    coverage: {
      countries?: string[];
      cities?: string[];
    };
    wholesalePriceMinor: number;
    customerPriceMinor: number;
    currency: string;
    supplierId: string | null;
    reliabilityScore: number;
  };
};

export default function MarketplacePage() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [confidence, setConfidence] = useState(0);
  const [offers, setOffers] = useState<RankedOffer[]>([]);
  const [intentId, setIntentId] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
    setLoading(true);

    try {
      const res = await fetch("/api/commerce/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rawText: query }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to search");
      }

      const data = await res.json();
      setSummary(data.summary);
      setConfidence(data.confidence);
      setOffers(data.ranked);
      setIntentId(data.intentId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Search failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePurchase(offer: RankedOffer) {
    if (!intentId) return;
    setPurchasing(offer.offerId);

    try {
      const res = await fetch(`/api/commerce/intent/${intentId}/purchase`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ offerId: offer.offerId }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to purchase");
      }

      const data = await res.json();

      // Redirect to payment provider
      if (data.nextAction?.url) {
        window.location.href = data.nextAction.url;
      } else {
        toast.success("Payment initiated. Check your email for confirmation.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Purchase failed");
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="container mx-auto p-4 md:p-8 max-w-4xl space-y-6">
        {/* Header */}
        <div className="text-center">
          <h1 className="text-3xl font-bold tracking-tight">Find Connectivity</h1>
          <p className="text-muted-foreground mt-2">
            Tell us what you need. We&apos;ll find the best options.
          </p>
        </div>

        {/* Search */}
        <Card>
          <CardContent className="pt-6">
            <form onSubmit={handleSearch} className="space-y-4">
              <div className="flex gap-2">
                <Input
                  placeholder="I need internet in Accra today..."
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="flex-1"
                />
                <Button type="submit" disabled={loading}>
                  <Search className="mr-2 h-4 w-4" />
                  {loading ? "Searching..." : "Search"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setQuery("I need internet in Accra today")}>
                  Internet in Accra
                </Button>
                <Button variant="outline" size="sm" onClick={() => setQuery("Cheap roaming data for travel")}>
                  Cheap roaming
                </Button>
                <Button variant="outline" size="sm" onClick={() => setQuery("50Mbps WiFi monthly")}>
                  50Mbps WiFi
                </Button>
                <Button variant="outline" size="sm" onClick={() => setQuery("5GB eSIM for Nigeria")}>
                  5GB eSIM Nigeria
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>

        {/* Parsed Intent */}
        {summary && (
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Understanding your request:</p>
                  <p className="text-lg">{summary}</p>
                </div>
                <Badge variant={confidence > 0.5 ? "default" : "secondary"}>
                  {Math.round(confidence * 100)}% confidence
                </Badge>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Ranked Offers */}
        {offers.length > 0 && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Recommended Options</h2>
            {offers.map((ranked, idx) => (
              <Card key={ranked.offerId} className={idx === 0 ? "border-primary" : ""}>
                <CardContent className="pt-6">
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-3 flex-1">
                      {/* Header */}
                      <div className="flex items-center gap-3">
                        {ranked.offer.capabilityType === "INTERNET" && <Wifi className="h-5 w-5" />}
                        {ranked.offer.capabilityType === "ROAMING" && <Smartphone className="h-5 w-5" />}
                        <div>
                          <h3 className="font-semibold">
                            {ranked.offer.capabilityType} — {ranked.offer.providerType}
                          </h3>
                          <p className="text-sm text-muted-foreground">
                            {ranked.offer.coverage.cities?.join(", ") || ranked.offer.coverage.countries?.join(", ") || "Global"}
                          </p>
                        </div>
                        {idx === 0 && (
                          <Badge className="ml-auto">Best match</Badge>
                        )}
                      </div>

                      {/* Spec */}
                      <div className="flex flex-wrap gap-3 text-sm">
                        {ranked.offer.spec.downloadMbps && (
                          <span className="flex items-center gap-1">
                            <Gauge className="h-4 w-4 text-muted-foreground" />
                            {ranked.offer.spec.downloadMbps} Mbps
                          </span>
                        )}
                        {ranked.offer.spec.dataLimitBytes && (
                          <span className="flex items-center gap-1">
                            <Zap className="h-4 w-4 text-muted-foreground" />
                            {ranked.offer.spec.dataLimitBytes / 1_000_000_000} GB
                          </span>
                        )}
                        {ranked.offer.spec.validityDays && (
                          <span className="flex items-center gap-1">
                            <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                            {ranked.offer.spec.validityDays} days
                          </span>
                        )}
                        <span className="flex items-center gap-1">
                          <MapPin className="h-4 w-4 text-muted-foreground" />
                          {ranked.offer.coverage.countries?.join(", ") || "Global"}
                        </span>
                      </div>

                      {/* Match Reasons */}
                      {ranked.matchReasons.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {ranked.matchReasons.map((reason, i) => (
                            <Badge key={i} variant="secondary" className="text-xs">
                              {reason}
                            </Badge>
                          ))}
                        </div>
                      )}

                      {/* Score Breakdown */}
                      <div className="grid grid-cols-6 gap-2 text-xs">
                        <ScoreBar label="Intent" value={ranked.scores.intentMatch} />
                        <ScoreBar label="Location" value={ranked.scores.locationMatch} />
                        <ScoreBar label="Avail" value={ranked.scores.availability} />
                        <ScoreBar label="Price" value={ranked.scores.price} />
                        <ScoreBar label="Margin" value={ranked.scores.margin} />
                        <ScoreBar label="Reliab" value={ranked.scores.reliability} />
                      </div>
                    </div>

                    {/* Price + Buy */}
                    <div className="text-right space-y-2 min-w-[120px]">
                      <div>
                        <div className="text-2xl font-bold">
                          ${(ranked.customerPriceMinor / 100).toFixed(2)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Score: {(ranked.score * 100).toFixed(0)}
                        </div>
                      </div>
                      <Button
                        onClick={() => handlePurchase(ranked)}
                        disabled={purchasing === ranked.offerId}
                        size="sm"
                      >
                        {purchasing === ranked.offerId ? "Processing..." : "Buy"}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty state */}
        {!loading && offers.length === 0 && summary && (
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground">
                No offers found matching your request. Try a different query.
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

function ScoreBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(value * 100);
  const color = pct >= 70 ? "bg-green-500" : pct >= 40 ? "bg-yellow-500" : "bg-red-500";
  return (
    <div className="space-y-1">
      <div className="flex justify-between">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div className="h-1 bg-muted rounded-full overflow-hidden">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
