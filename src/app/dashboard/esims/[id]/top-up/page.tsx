"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2, Plus, Zap, ShieldCheck } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { formatDataSize, formatPrice, countryFlag } from "@/lib/format";
import { toast } from "sonner";

type TopUpPackage = {
  id: string;
  name: string;
  dataAmountMB: number;
  priceMinor: number;
  currency: string;
  validityDays?: number;
};

type ESIM = {
  id: string;
  status: string;
  dataRemaining: number;
  dataAmount: number;
  order: { plan: { country: string; countryCode: string } };
};

export default function TopUpPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user, loading } = useAuth();
  const [esim, setEsim] = useState<ESIM | null>(null);
  const [packages, setPackages] = useState<TopUpPackage[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push(`/login?next=/dashboard/esims/${id}/top-up`); return; }
    Promise.all([
      api.get<{ esim: ESIM }>(`/api/esims/${id}`).then((d) => setEsim(d.esim)),
      api.get<{ packages: TopUpPackage[] }>(`/api/esims/${id}/topups`).then((d) => {
        setPackages(d.packages);
        if (d.packages[0]) setSelected(d.packages[0].id);
      }),
    ]).catch(() => toast.error("Failed to load"));
  }, [user, loading, router, id]);

  async function purchase() {
    if (!selected) return;
    setProcessing(true);
    try {
      const res = await api.post<{ topUpId: string; newRemainingMB: number }>(`/api/esims/${id}/topups`, {
        packageId: selected,
        idempotencyKey: `topup_${id}_${Date.now()}`,
      });
      toast.success(`Top-up applied! +${formatDataSize(packages.find((p) => p.id === selected)?.dataAmountMB ?? 0)}`);
      router.push(`/dashboard/esims/${id}`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Top-up failed");
      setProcessing(false);
    }
  }

  if (loading || !esim) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-16 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (packages.length === 0) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <Link href={`/dashboard/esims/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to eSIM
        </Link>
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
            <Zap className="h-8 w-8 text-muted-foreground" />
            <div>
              <p className="font-medium">Top-ups not available</p>
              <p className="text-sm text-muted-foreground">This eSIM doesn't support top-ups. You can purchase a new plan instead.</p>
            </div>
            <Button asChild><Link href="/esim">Browse plans</Link></Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href={`/dashboard/esims/${id}`} className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to eSIM
      </Link>

      <div className="mt-4 flex items-center gap-3">
        <span className="text-3xl leading-none" aria-hidden>{countryFlag(esim.order.plan.countryCode)}</span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Top up your eSIM</h1>
          <p className="text-sm text-muted-foreground">{esim.order.plan.country} · {formatDataSize(esim.dataRemaining)} remaining</p>
        </div>
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Plus className="h-4 w-4 text-primary" /> Choose a top-up</CardTitle></CardHeader>
        <CardContent>
          <RadioGroup value={selected ?? ""} onValueChange={setSelected} className="gap-3">
            {packages.map((p) => (
              <Label
                key={p.id}
                className="flex cursor-pointer items-center gap-4 rounded-xl border border-border/60 p-4 has-[:checked]:border-primary has-[:checked]:bg-primary/5"
              >
                <RadioGroupItem value={p.id} />
                <div className="flex-1">
                  <p className="font-semibold">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatDataSize(p.dataAmountMB)}
                    {p.validityDays ? ` · ${p.validityDays} days` : ""}
                  </p>
                </div>
                <span className="text-lg font-bold">{formatPrice(p.priceMinor, p.currency)}</span>
              </Label>
            ))}
          </RadioGroup>

          <div className="mt-5 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Development mode</p>
            <p className="mt-1">Mock payment — no real charge. Top-ups are applied instantly via the provider.</p>
          </div>

          <Button className="mt-5 w-full" size="lg" disabled={!selected || processing} onClick={purchase}>
            {processing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {selected ? `Pay ${formatPrice(packages.find((p) => p.id === selected)?.priceMinor ?? 0)} & top up` : "Select a package"}
          </Button>
          <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Secure · Server-verified payment
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
