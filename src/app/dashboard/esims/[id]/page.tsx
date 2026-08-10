"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ArrowLeft, Loader2, Smartphone, Wifi, Clock, Copy, Plus, Zap, RefreshCw,
  QrCode, ShieldCheck, Signal,
} from "lucide-react";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api-client";
import { formatDataSize, formatDate, formatDateTime, countryFlag, prettifyStatus, statusColor } from "@/lib/format";
import { toast } from "sonner";

type ESIMDetail = {
  id: string;
  iccid: string | null;
  smdpAddress: string | null;
  activationCode: string | null;
  matchId: string | null;
  qrCode: string | null;
  status: string;
  dataAmount: number;
  dataRemaining: number;
  validityDays: number;
  expiresAt: string | null;
  provider: string;
  order: { id: string; plan: { country: string; countryCode: string; name: string; networks: string | null; speed: string | null } };
};

export default function ESIMDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user, loading } = useAuth();
  const [esim, setEsim] = useState<ESIMDetail | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push(`/login?next=/dashboard/esims/${id}`); return; }
    api.get<{ esim: ESIMDetail }>(`/api/esims/${id}`).then((d) => setEsim(d.esim)).catch(() => toast.error("eSIM not found"));
  }, [user, loading, router, id]);

  function copy(text: string, label: string) {
    navigator.clipboard?.writeText(text);
    toast.success(`${label} copied`);
  }

  async function simulateUsage(usedMB: number) {
    setSimulating(true);
    try {
      const res = await api.post<{ result: { dataRemainingMB: number; status: string } }>(`/api/esims/${id}/usage`, { usedMB });
      setEsim((e) => e ? { ...e, dataRemaining: res.result.dataRemainingMB, status: res.result.status } : e);
      toast.success(`Simulated ${usedMB} MB usage`);
    } catch {
      toast.error("Failed to simulate usage");
    } finally {
      setSimulating(false);
    }
  }

  async function refreshUsage() {
    setRefreshing(true);
    // Re-fetch the eSIM (the simulate/sync updates it).
    try {
      const d = await api.get<{ esim: ESIMDetail }>(`/api/esims/${id}`);
      setEsim(d.esim);
      toast.success("Usage refreshed");
    } finally {
      setRefreshing(false);
    }
  }

  if (loading || !esim) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
      </div>
    );
  }

  const usedPct = esim.dataAmount > 0 ? Math.round(((esim.dataAmount - esim.dataRemaining) / esim.dataAmount) * 100) : 0;
  const networks = esim.order.plan.networks ? safeParse(esim.order.plan.networks, []) : [];
  const isMock = esim.provider === "mock";

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/dashboard/esims" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> My eSIMs
      </Link>

      <div className="mt-4 flex items-center gap-4">
        <span className="text-4xl leading-none" aria-hidden>{countryFlag(esim.order.plan.countryCode)}</span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{esim.order.plan.country}</h1>
          <p className="text-sm text-muted-foreground">{esim.order.plan.name}</p>
        </div>
        <Badge className={`ml-auto ${statusColor(esim.status)}`}>{prettifyStatus(esim.status)}</Badge>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
        {/* Left: details */}
        <div className="space-y-6">
          {/* Usage */}
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="flex items-center gap-2 text-base"><Wifi className="h-4 w-4 text-primary" /> Data usage</CardTitle>
              <Button variant="ghost" size="sm" onClick={refreshUsage} disabled={refreshing}>
                <RefreshCw className={`mr-1 h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
              </Button>
            </CardHeader>
            <CardContent>
              <div className="flex items-baseline gap-2">
                <span className="text-3xl font-bold">{formatDataSize(esim.dataRemaining)}</span>
                <span className="text-sm text-muted-foreground">remaining of {formatDataSize(esim.dataAmount)}</span>
              </div>
              <Progress value={100 - usedPct} className="mt-3 h-2" />
              <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                <span>{usedPct}% used</span>
                <span>{100 - usedPct}% remaining</span>
              </div>
              <div className="mt-4 flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                {esim.expiresAt ? `Expires ${formatDate(esim.expiresAt)}` : "No expiry"}
                <span>·</span>
                <span>{esim.validityDays} day plan</span>
              </div>

              {/* Dev: simulate usage */}
              {isMock && esim.status === "active" && (
                <div className="mt-4 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
                  <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Zap className="h-3.5 w-3.5" /> Development: simulate data usage</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {[100, 500, 1024, 2048].map((mb) => (
                      <Button key={mb} size="sm" variant="outline" disabled={simulating} onClick={() => simulateUsage(mb)}>
                        Use {formatDataSize(mb)}
                      </Button>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Plan info */}
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Signal className="h-4 w-4 text-primary" /> Plan details</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Destination" value={esim.order.plan.country} />
              <Row label="Data allowance" value={formatDataSize(esim.dataAmount)} />
              <Row label="Validity" value={`${esim.validityDays} days`} />
              <Row label="Network speed" value={esim.order.plan.speed ?? "4G"} />
              {networks.length > 0 && (
                <div className="flex items-start justify-between gap-4">
                  <span className="text-muted-foreground">Networks</span>
                  <div className="flex flex-wrap justify-end gap-1">
                    {networks.map((n) => <Badge key={n} variant="secondary" className="text-[11px]">{n}</Badge>)}
                  </div>
                </div>
              )}
              <Row label="ICCID" value={esim.iccid ?? "—"} mono />
              <Row label="Provider" value={esim.provider} />
            </CardContent>
          </Card>

          {esim.status === "active" && (
            <Button asChild variant="outline" className="w-full">
              <Link href={`/dashboard/esims/${id}/top-up`}><Plus className="mr-2 h-4 w-4" /> Buy a top-up</Link>
            </Button>
          )}
        </div>

        {/* Right: installation */}
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><QrCode className="h-4 w-4 text-primary" /> Install your eSIM</CardTitle></CardHeader>
            <CardContent>
              {isMock && (
                <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  ⚠ Development eSIM — test values, not a real carrier.
                </div>
              )}
              {esim.qrCode ? (
                <div className="flex flex-col items-center">
                  <img src={esim.qrCode} alt="eSIM installation QR code" width={220} height={220} className="rounded-lg border border-border/60 bg-white p-2" />
                  <p className="mt-3 text-center text-xs text-muted-foreground">Scan with your camera or eSIM settings to install</p>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">QR code not available.</p>
              )}

              <div className="mt-4 space-y-2 border-t border-border/60 pt-4">
                <CopyField label="SM-DP+ address" value={esim.smdpAddress} onCopy={() => copy(esim.smdpAddress ?? "", "SM-DP+ address")} />
                <CopyField label="Activation code" value={esim.activationCode} onCopy={() => copy(esim.activationCode ?? "", "Activation code")} />
                {esim.matchId && <CopyField label="Match ID" value={esim.matchId} onCopy={() => copy(esim.matchId ?? "", "Match ID")} />}
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle className="text-base">Installation guide</CardTitle></CardHeader>
            <CardContent>
              <Tabs defaultValue="iphone">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="iphone">iPhone</TabsTrigger>
                  <TabsTrigger value="android">Android</TabsTrigger>
                </TabsList>
                <TabsContent value="iphone" className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <Step n={1}>Open <b>Settings → Cellular</b> and tap <b>Add eSIM</b> (iOS 17+) or <b>Add Cellular Plan</b>.</Step>
                  <Step n={2}>Point the camera at the QR code above, or choose <b>Enter details manually</b> and type the SM-DP+ address and activation code.</Step>
                  <Step n={3}>Confirm adding the plan. Label it (e.g. "Travel data").</Step>
                  <Step n={4}>Set the eSIM as your data line. Turn it on when you land.</Step>
                  <Step n={5}>Activation completes once your phone registers on a local network.</Step>
                </TabsContent>
                <TabsContent value="android" className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <Step n={1}>Open <b>Settings → Network &amp; Internet → SIMs</b> and tap <b>Add eSIM</b>.</Step>
                  <Step n={2}>Scan the QR code, or tap <b>Need help? → Enter it manually</b> and use the SM-DP+ address and activation code.</Step>
                  <Step n={3}>Follow prompts to download and activate the plan.</Step>
                  <Step n={4}>Enable data on the new eSIM. Steps vary by manufacturer (Pixel, Samsung, etc.).</Step>
                  <Step n={5}><b>Not all Android devices support eSIM.</b> Verify compatibility before purchase.</Step>
                </TabsContent>
              </Tabs>
              <p className="mt-4 flex items-start gap-1.5 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                Automatic installation depends on device support. Manual activation is always available as a fallback.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className={`font-medium text-right break-all ${mono ? "font-mono text-xs" : ""}`}>{value}</span>
    </div>
  );
}

function CopyField({ label, value, onCopy }: { label: string; value: string | null; onCopy: () => void }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="mt-1 flex items-center gap-2">
        <code className="flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{value ?? "—"}</code>
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={onCopy} disabled={!value}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">{n}</span>
      <p>{children}</p>
    </div>
  );
}

function safeParse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
