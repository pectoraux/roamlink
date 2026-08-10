"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, CheckCircle2, XCircle, Radio, CreditCard } from "lucide-react";
import { api } from "@/lib/api-client";

type Providers = {
  esim: { id: string; configured: boolean; hasApiUrl: boolean; hasApiKey: boolean };
  payment: { id: string; configured: boolean; hasApiUrl: boolean; hasApiKey: boolean };
};

export default function AdminProvidersPage() {
  const [providers, setProviders] = useState<Providers | null>(null);

  useEffect(() => {
    api.get<{ providers: Providers }>("/api/admin/providers").then((d) => setProviders(d.providers)).catch(() => setProviders(null));
  }, []);

  if (!providers) return <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Providers</h2>
      <p className="text-sm text-muted-foreground">eSIM & payment provider configuration status</p>

      <div className="mt-5 grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Radio className="h-4 w-4 text-primary" /> eSIM provider</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Provider key" value={<span className="font-mono">{providers.esim.id}</span>} />
            <Row label="Mode" value={<Badge variant={providers.esim.id === "mock" ? "secondary" : "default"}>{providers.esim.id === "mock" ? "Development mock" : "Production"}</Badge>} />
            <Row label="API URL set" value={<Status ok={providers.esim.hasApiUrl} />} />
            <Row label="API key set" value={<Status ok={providers.esim.hasApiKey} />} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><CreditCard className="h-4 w-4 text-primary" /> Payment provider</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Row label="Provider key" value={<span className="font-mono">{providers.payment.id}</span>} />
            <Row label="Mode" value={<Badge variant={providers.payment.id === "mock" ? "secondary" : "default"}>{providers.payment.id === "mock" ? "Development mock" : "Production"}</Badge>} />
            <Row label="API URL set" value={<Status ok={providers.payment.hasApiUrl} />} />
            <Row label="API key set" value={<Status ok={providers.payment.hasApiKey} />} />
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardContent className="p-5 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Switching providers</p>
          <p className="mt-1">
            Providers are selected via <code className="rounded bg-muted px-1">ESIM_PROVIDER</code> and{" "}
            <code className="rounded bg-muted px-1">PAYMENT_PROVIDER</code> environment variables. Set credentials in{" "}
            <code className="rounded bg-muted px-1">ESIM_API_URL</code> / <code className="rounded bg-muted px-1">ESIM_API_KEY</code>{" "}
            (and payment equivalents), then implement the adapter methods in{" "}
            <code className="rounded bg-muted px-1">src/lib/esim/real-provider.ts</code>. See <code className="rounded bg-muted px-1">docs/esim-provider.md</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-border/40 pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </div>
  );
}

function Status({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="inline-flex items-center gap-1 text-emerald-600"><CheckCircle2 className="h-4 w-4" /> Yes</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted-foreground"><XCircle className="h-4 w-4" /> No</span>
  );
}
