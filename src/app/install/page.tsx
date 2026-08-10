"use client";

import { useState, useEffect, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle, Loader2, Smartphone, CheckCircle2, QrCode, Copy } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { countryFlag } from "@/lib/format";
import { toast } from "sonner";

type InstallData = {
  esim: {
    esimId: string;
    iccid: string | null;
    smdpAddress: string | null;
    activationCode: string | null;
    matchId: string | null;
    qrCode: string | null;
    country: string;
    planName: string;
  };
};

function InstallContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const token = searchParams.get("token");
  const [data, setData] = useState<InstallData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      router.push(`/login?next=/install${token ? `?token=${token}` : ""}`);
      return;
    }
    if (!token) {
      return; // error state handled by render when data is null and no token
    }
    let cancelled = false;
    api.get<InstallData>(`/api/install/${token}`)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e instanceof ApiError ? e.message : "Failed to load installation details"); });
    return () => { cancelled = true; };
  }, [authLoading, user, token, router]);

  if (authLoading) {
    return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (error || (!token && user)) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <AlertCircle className="mx-auto h-12 w-12 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Installation link invalid</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error ?? "No installation token provided."}</p>
        <Button asChild className="mt-6"><Link href="/dashboard/esims">Go to My eSIMs</Link></Button>
      </div>
    );
  }

  if (!data) {
    return <div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  const { esim } = data;

  function copy(text: string, label: string) {
    navigator.clipboard?.writeText(text);
    toast.success(`${label} copied`);
  }

  return (
    <div className="mx-auto max-w-lg px-4 py-8">
      <div className="flex flex-col items-center text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
          <CheckCircle2 className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-2xl font-bold tracking-tight">Install your eSIM</h1>
        <p className="mt-1 text-sm text-muted-foreground">Your {esim.country} eSIM is ready to install on this device.</p>
      </div>

      <Card className="mt-6">
        <CardContent className="p-6">
          <div className="flex items-center gap-3">
            <span className="text-4xl leading-none" aria-hidden>{countryFlag(esim.iccid?.slice(0, 2) ?? "")}</span>
            <div>
              <p className="font-semibold">{esim.country}</p>
              <p className="text-xs text-muted-foreground">{esim.planName}</p>
            </div>
          </div>

          {esim.qrCode && (
            <div className="mt-6 flex flex-col items-center">
              <p className="mb-3 flex items-center gap-1.5 text-sm font-medium"><QrCode className="h-4 w-4 text-primary" /> Scan to install</p>
              <img src={esim.qrCode} alt="eSIM QR code" width={240} height={240} className="rounded-lg border border-border/60 bg-white p-2" />
            </div>
          )}

          <div className="mt-6 space-y-3 border-t border-border/60 pt-4">
            <Field label="SM-DP+ address" value={esim.smdpAddress} onCopy={() => copy(esim.smdpAddress ?? "", "SM-DP+ address")} />
            <Field label="Activation code" value={esim.activationCode} onCopy={() => copy(esim.activationCode ?? "", "Activation code")} />
            {esim.matchId && <Field label="Match ID" value={esim.matchId} onCopy={() => copy(esim.matchId, "Match ID")} />}
            {esim.iccid && <Field label="ICCID" value={esim.iccid} onCopy={() => copy(esim.iccid, "ICCID")} />}
          </div>
        </CardContent>
      </Card>

      <Card className="mt-4 p-5">
        <h2 className="flex items-center gap-2 font-semibold"><Smartphone className="h-4 w-4 text-primary" /> Installation steps</h2>
        <ol className="mt-3 space-y-2 text-sm text-muted-foreground">
          <li className="flex gap-2"><span className="font-bold text-primary">1.</span> Open Settings → Cellular → Add eSIM</li>
          <li className="flex gap-2"><span className="font-bold text-primary">2.</span> Scan the QR code above, or enter details manually</li>
          <li className="flex gap-2"><span className="font-bold text-primary">3.</span> Label your eSIM (e.g. "Ghana travel")</li>
          <li className="flex gap-2"><span className="font-bold text-primary">4.</span> Select it as your data line</li>
          <li className="flex gap-2"><span className="font-bold text-primary">5.</span> Enable data roaming if required, then connect</li>
        </ol>
      </Card>

      <Button asChild variant="outline" className="mt-4 w-full"><Link href="/dashboard/esims">View My eSIMs</Link></Button>
    </div>
  );
}

function Field({ label, value, onCopy }: { label: string; value: string | null; onCopy: () => void }) {
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

export default function InstallPage() {
  return (
    <Suspense fallback={<div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>}>
      <InstallContent />
    </Suspense>
  );
}
