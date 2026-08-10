"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Loader2, Smartphone, Plus, Wifi, Clock } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api-client";
import { formatDataSize, formatDate, countryFlag, prettifyStatus, statusColor } from "@/lib/format";

type ESIM = {
  id: string;
  status: string;
  dataAmount: number;
  dataRemaining: number;
  validityDays: number;
  expiresAt: string | null;
  iccid: string | null;
  order: { plan: { country: string; countryCode: string; name: string } };
};

export default function MyESIMsPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [esims, setEsims] = useState<ESIM[] | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push("/login?next=/dashboard/esims"); return; }
    api.get<{ esims: ESIM[] }>("/api/esims").then((d) => setEsims(d.esims)).catch(() => setEsims([]));
  }, [user, loading, router]);

  if (loading || !esims) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-16 text-center text-muted-foreground">
        <Loader2 className="mx-auto h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My eSIMs</h1>
          <p className="text-sm text-muted-foreground">Manage your active and past eSIMs</p>
        </div>
        <Button asChild><Link href="/esim"><Plus className="mr-1 h-4 w-4" /> New eSIM</Link></Button>
      </div>

      {esims.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted">
              <Smartphone className="h-7 w-7 text-muted-foreground" />
            </div>
            <div>
              <p className="font-medium">No eSIMs yet</p>
              <p className="text-sm text-muted-foreground">Browse plans and purchase your first travel eSIM.</p>
            </div>
            <Button asChild><Link href="/esim">Browse plans</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          {esims.map((esim) => {
            const usedPct = esim.dataAmount > 0 ? Math.round(((esim.dataAmount - esim.dataRemaining) / esim.dataAmount) * 100) : 0;
            const expired = esim.expiresAt && new Date(esim.expiresAt) < new Date();
            return (
              <Card key={esim.id} className="lift overflow-hidden">
                <CardContent className="p-5">
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <span className="text-3xl leading-none" aria-hidden>{countryFlag(esim.order.plan.countryCode)}</span>
                      <div>
                        <p className="font-semibold">{esim.order.plan.country}</p>
                        <p className="text-xs text-muted-foreground">{esim.order.plan.name}</p>
                      </div>
                    </div>
                    <Badge className={statusColor(esim.status)}>{prettifyStatus(esim.status)}</Badge>
                  </div>

                  <div className="mt-4 space-y-1">
                    <div className="flex items-baseline justify-between text-sm">
                      <span className="text-muted-foreground">{formatDataSize(esim.dataRemaining)} remaining</span>
                      <span className="text-xs text-muted-foreground">of {formatDataSize(esim.dataAmount)}</span>
                    </div>
                    <Progress value={100 - usedPct} className="h-2" />
                  </div>

                  <div className="mt-4 flex items-center gap-4 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> {esim.expiresAt ? (expired ? "Expired" : `Expires ${formatDate(esim.expiresAt)}`) : "—"}</span>
                  </div>

                  <Button asChild variant="outline" size="sm" className="mt-4 w-full">
                    <Link href={`/dashboard/esims/${esim.id}`}>View details</Link>
                  </Button>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
