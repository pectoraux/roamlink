"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Smartphone, Phone, ArrowRight, Sparkles } from "lucide-react";
import { api } from "@/lib/api-client";
import { countryFlag } from "@/lib/format";

type CrossSellData = {
  hasNumber: boolean;
  hasESIM: boolean;
  esimCountry?: string;
  esimCountryCode?: string;
};

/**
 * Cross-sell recommendations shown after a purchase.
 * - If user bought an eSIM: recommend a virtual number
 * - If user bought a number: recommend an eSIM
 */
export function CrossSellRecommendations({ productType, countryCode, countryName }: {
  productType: "esim" | "virtual_number";
  countryCode?: string;
  countryName?: string;
}) {
  const [data, setData] = useState<CrossSellData | null>(null);

  useEffect(() => {
    Promise.all([
      api.get<{ numbers: any[] }>("/api/virtual-numbers").catch(() => ({ numbers: [] })),
      api.get<{ esims: any[] }>("/api/esims").catch(() => ({ esims: [] })),
    ]).then(([vnRes, esimRes]) => {
      setData({
        hasNumber: (vnRes.numbers?.length ?? 0) > 0,
        hasESIM: (esimRes.esims?.length ?? 0) > 0,
      });
    });
  }, []);

  if (!data) return null;

  // If they just bought an eSIM and don't have a number, recommend one
  if (productType === "esim" && !data.hasNumber) {
    return (
      <Card className="mt-4 border-primary/30 bg-primary/5">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Phone className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="flex items-center gap-1.5 font-semibold text-sm"><Sparkles className="h-3.5 w-3.5 text-primary" /> Get a virtual number too</p>
              <p className="mt-1 text-xs text-muted-foreground">Add a local phone number for SMS and voice. Stay reachable while traveling.</p>
              <Button asChild size="sm" className="mt-3">
                <Link href={countryCode ? `/numbers/${countryCode.toLowerCase()}` : "/numbers"}>
                  Browse numbers <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // If they just bought a number and don't have an eSIM, recommend one
  if (productType === "virtual_number" && !data.hasESIM) {
    return (
      <Card className="mt-4 border-primary/30 bg-primary/5">
        <CardContent className="p-5">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Smartphone className="h-5 w-5 text-primary" />
            </div>
            <div className="flex-1">
              <p className="flex items-center gap-1.5 font-semibold text-sm"><Sparkles className="h-3.5 w-3.5 text-primary" /> Need data too?</p>
              <p className="mt-1 text-xs text-muted-foreground">Get an eSIM for mobile data. Stay connected without roaming fees.</p>
              <Button asChild size="sm" className="mt-3">
                <Link href={countryCode ? `/esim/${countryName?.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}` : "/esim"}>
                  Browse eSIMs <ArrowRight className="ml-1 h-3.5 w-3.5" />
                </Link>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return null;
}
