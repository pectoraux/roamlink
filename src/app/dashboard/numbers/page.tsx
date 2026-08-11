"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Smartphone, Plus, MessageSquare, Phone } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api-client";
import { countryFlag, formatDate } from "@/lib/format";

type VNumber = {
  id: string;
  e164: string;
  country: string;
  countryCode: string;
  region: string | null;
  smsEnabled: boolean;
  voiceEnabled: boolean;
  status: string;
  sellingPrice: number;
  currency: string;
  expiresAt: string | null;
};

export default function MyNumbersPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [numbers, setNumbers] = useState<VNumber[] | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push("/login?next=/dashboard/numbers"); return; }
    api.get<{ numbers: VNumber[] }>("/api/virtual-numbers").then((d) => setNumbers(d.numbers)).catch(() => setNumbers([]));
  }, [user, loading, router]);

  if (loading || !numbers) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">My Numbers</h1>
          <p className="text-sm text-muted-foreground">Manage your virtual phone numbers</p>
        </div>
        <Button asChild><Link href="/numbers"><Plus className="mr-1 h-4 w-4" /> New number</Link></Button>
      </div>

      {numbers.length === 0 ? (
        <Card className="mt-8">
          <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
            <Smartphone className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No numbers yet</p>
              <p className="text-sm text-muted-foreground">Browse available countries and get your first virtual number.</p>
            </div>
            <Button asChild><Link href="/numbers">Browse numbers</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {numbers.map((n) => (
            <Link key={n.id} href={`/dashboard/numbers/${n.id}`}>
              <Card className="lift">
                <CardContent className="flex items-center gap-4 p-4">
                  <span className="text-3xl">{countryFlag(n.countryCode)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="font-mono font-semibold text-lg">{n.e164}</p>
                    <p className="text-xs text-muted-foreground">{n.country} · {n.region ?? "Local"}</p>
                  </div>
                  <div className="flex gap-1">
                    {n.smsEnabled && <MessageSquare className="h-4 w-4 text-muted-foreground" />}
                    {n.voiceEnabled && <Phone className="h-4 w-4 text-muted-foreground" />}
                  </div>
                  <Badge variant={n.status === "active" ? "default" : "secondary"}>{n.status}</Badge>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
