"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Loader2, MessageSquare, Phone, Smartphone, Check } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { formatPrice, countryFlag } from "@/lib/format";
import { toast } from "sonner";

type NumberResult = {
  providerNumberId: string;
  e164: string;
  country: string;
  countryCode: string;
  region?: string;
  city?: string;
  numberType: string;
  smsEnabled: boolean;
  mmsEnabled: boolean;
  voiceEnabled: boolean;
  monthlyCostMinor: number;
  currency: string;
  sellingPriceMinor: number;
};

export function NumberSearch({ countryCode, countryName }: { countryCode: string; countryName: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const [numbers, setNumbers] = useState<NumberResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [purchasing, setPurchasing] = useState<string | null>(null);
  const [smsRequired, setSmsRequired] = useState(true);
  const [voiceRequired, setVoiceRequired] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ country: countryCode });
      if (smsRequired) params.set("sms", "true");
      if (voiceRequired) params.set("voice", "true");
      const res = await api.get<{ numbers: NumberResult[] }>(`/api/virtual-numbers/search?${params}`);
      setNumbers(res.numbers);
    } catch {
      setNumbers([]);
    } finally {
      setLoading(false);
    }
  }, [countryCode, smsRequired, voiceRequired]);

  useEffect(() => { load(); }, [load]);

  async function purchase(num: NumberResult) {
    if (!user) {
      router.push(`/login?next=/numbers/${countryCode.toLowerCase()}`);
      return;
    }
    setPurchasing(num.providerNumberId);
    try {
      const res = await api.post<{ orderId: string; virtualNumberId: string; status: string }>("/api/virtual-numbers/orders", {
        providerNumberId: num.providerNumberId,
      });
      toast.success("Number purchased!");
      router.push(`/dashboard/numbers/${res.virtualNumberId}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Purchase failed");
    } finally {
      setPurchasing(null);
    }
  }

  return (
    <div>
      {/* Filters */}
      <Card className="mb-6 p-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="text-sm font-medium">Capabilities:</span>
          <Label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={smsRequired} onCheckedChange={(v) => setSmsRequired(v === true)} />
            <span className="text-sm">SMS</span>
          </Label>
          <Label className="flex items-center gap-2 cursor-pointer">
            <Checkbox checked={voiceRequired} onCheckedChange={(v) => setVoiceRequired(v === true)} />
            <span className="text-sm">Voice</span>
          </Label>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : "Search"}
          </Button>
        </div>
      </Card>

      {/* Results */}
      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
      ) : numbers.length === 0 ? (
        <Card><CardContent className="p-12 text-center text-muted-foreground">No numbers available with the selected capabilities.</CardContent></Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {numbers.map((num) => (
            <Card key={num.providerNumberId} className="lift overflow-hidden">
              <CardContent className="p-5">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xl font-bold font-mono">{num.e164}</p>
                    <p className="text-sm text-muted-foreground">{num.region ?? num.city ?? countryName}</p>
                  </div>
                  <span className="text-2xl">{countryFlag(num.countryCode)}</span>
                </div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {num.smsEnabled && <Badge variant="secondary" className="gap-1 text-[11px]"><MessageSquare className="h-3 w-3" /> SMS</Badge>}
                  {num.voiceEnabled && <Badge variant="secondary" className="gap-1 text-[11px]"><Phone className="h-3 w-3" /> Voice</Badge>}
                  {num.mmsEnabled && <Badge variant="secondary" className="gap-1 text-[11px]"><Smartphone className="h-3 w-3" /> MMS</Badge>}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-border/60 pt-4">
                  <div>
                    <span className="text-lg font-bold">{formatPrice(num.sellingPriceMinor, num.currency)}</span>
                    <span className="text-xs text-muted-foreground">/month</span>
                  </div>
                  <Button size="sm" onClick={() => purchase(num)} disabled={purchasing === num.providerNumberId}>
                    {purchasing === num.providerNumberId ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Check className="mr-1 h-3.5 w-3.5" /> Get number</>}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
