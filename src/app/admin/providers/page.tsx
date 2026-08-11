"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Radio, CreditCard, Activity, Shield } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatPrice } from "@/lib/format";

type ProviderHealth = {
  providerId: string;
  label: string;
  isMock: boolean;
  type: string;
  healthy: boolean;
  successCount: number;
  failureCount: number;
  avgLatencyMs: number;
  creditLimit: number;
  outstandingLiability: number;
  availableCredit: number;
};

type Providers = {
  esim: { id: string; configured: boolean; hasApiUrl: boolean; hasApiKey: boolean };
  payment: { id: string; configured: boolean; hasApiUrl: boolean; hasApiKey: boolean };
};

export default function AdminProvidersPage() {
  const [providers, setProviders] = useState<Providers | null>(null);
  const [health, setHealth] = useState<ProviderHealth[] | null>(null);

  useEffect(() => {
    api.get<Providers>("/api/admin/providers").then((d) => setProviders(d));
    api.get<{ providers: ProviderHealth[] }>("/api/admin/providers/health").then((d) => setHealth(d.providers)).catch(() => setHealth([]));
  }, []);

  if (!providers) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Providers</h2>
      <p className="text-sm text-muted-foreground">Provider configuration, health & credit status</p>

      {/* Provider Health */}
      {health && health.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-muted-foreground mb-3">PROVIDER HEALTH & RELIABILITY</h3>
          <div className="space-y-4">
            {health.map((p) => (
              <Card key={p.providerId + p.type}>
                <CardContent className="p-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      {p.type === "esim" ? <Radio className="h-5 w-5 text-primary" /> : <CreditCard className="h-5 w-5 text-primary" />}
                      <span className="font-semibold">{p.label}</span>
                      <Badge variant="outline" className="text-[10px]">{p.type}</Badge>
                      {p.isMock && <Badge variant="secondary" className="text-[10px]">DEV</Badge>}
                    </div>
                    <Badge className={p.healthy ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}>
                      {p.healthy ? "Healthy" : "Unhealthy"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-2 gap-4 md:grid-cols-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Success</p>
                      <p className="font-semibold text-emerald-600">{p.successCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Failures</p>
                      <p className={`font-semibold ${p.failureCount > 0 ? "text-rose-600" : ""}`}>{p.failureCount}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Avg Latency</p>
                      <p className="font-semibold">{p.avgLatencyMs > 0 ? `${Math.round(p.avgLatencyMs)}ms` : "—"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Available Credit</p>
                      <p className="font-semibold text-emerald-600">{formatPrice(p.availableCredit)}</p>
                    </div>
                  </div>
                  {p.creditLimit > 0 && (
                    <div className="mt-3">
                      <div className="flex justify-between text-xs text-muted-foreground mb-1">
                        <span>Credit: {formatPrice(p.outstandingLiability)} / {formatPrice(p.creditLimit)}</span>
                        <span>{Math.round((p.outstandingLiability / p.creditLimit) * 100)}%</span>
                      </div>
                      <div className="h-2 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full rounded-full ${p.outstandingLiability / p.creditLimit > 0.75 ? "bg-red-500" : "bg-emerald-500"}`} style={{ width: `${Math.min(100, (p.outstandingLiability / p.creditLimit) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </div>
      )}

      {/* Configuration Status */}
      <div className="mt-8">
        <h3 className="text-sm font-semibold text-muted-foreground mb-3">CONFIGURATION</h3>
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4 text-primary" /> eSIM Provider</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Provider" value={<span className="font-mono">{providers.esim.id}</span>} />
              <Row label="Mode" value={<Badge variant={providers.esim.id === "mock" ? "secondary" : "default"}>{providers.esim.id === "mock" ? "Development mock" : "Production"}</Badge>} />
              <Row label="API URL" value={<Status ok={providers.esim.hasApiUrl} />} />
              <Row label="API Key" value={<Status ok={providers.esim.hasApiKey} />} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4 text-primary" /> Payment Provider</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <Row label="Provider" value={<span className="font-mono">{providers.payment.id}</span>} />
              <Row label="Mode" value={<Badge variant={providers.payment.id === "mock" ? "secondary" : "default"}>{providers.payment.id === "mock" ? "Development mock" : "Production"}</Badge>} />
              <Row label="API URL" value={<Status ok={providers.payment.hasApiUrl} />} />
              <Row label="API Key" value={<Status ok={providers.payment.hasApiKey} />} />
            </CardContent>
          </Card>
        </div>
      </div>

      <Card className="mt-6">
        <CardContent className="p-5 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Multi-Provider Routing</p>
          <p className="mt-1">The routing layer checks provider health, credit availability, and capabilities before each purchase. When a real provider is added, the system can route to the best provider based on cost, reliability, and margin.</p>
          <p className="mt-2">To add a real provider: implement the adapter in <code className="rounded bg-muted px-1">src/lib/esim/real-provider.ts</code> or a new <code className="rounded bg-muted px-1">VirtualNumberProvider</code>, set the env var, and the routing layer will include it automatically.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return <div className="flex items-center justify-between"><span className="text-muted-foreground">{label}</span><span>{value}</span></div>;
}

function Status({ ok }: { ok: boolean }) {
  return ok ? <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Set</span> : <span className="inline-flex items-center gap-1 text-muted-foreground"><XCircle className="h-4 w-4" /> Not set</span>;
}
