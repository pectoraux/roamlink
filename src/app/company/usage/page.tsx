import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization, getOrgUsage } from "@/server/services/organization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowLeft, Smartphone, Phone } from "lucide-react";
import { formatDataSize, countryFlag, statusColor, prettifyStatus } from "@/lib/format";

export default async function CompanyUsagePage() {
  const user = await getCurrentUser();
  if (!user) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Button asChild><Link href="/login?next=/company/usage">Sign in</Link></Button></div>;

  const org = await getUserOrganization(user.id);
  if (!org) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Building2 className="mx-auto h-12 w-12 text-muted-foreground" /><p className="mt-4 text-sm text-muted-foreground">No organization.</p><Button asChild className="mt-4"><Link href="/company">Create one</Link></Button></div>;

  const usage = await getOrgUsage(org.id);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/company" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to dashboard</Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Organization Usage</h1>
      <p className="text-sm text-muted-foreground">{org.name}</p>

      {/* eSIM Usage */}
      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Smartphone className="h-4 w-4 text-primary" /> eSIMs ({usage.esims.length})</CardTitle></CardHeader>
        <CardContent>
          {usage.esims.length === 0 ? (
            <p className="text-sm text-muted-foreground">No eSIMs assigned.</p>
          ) : (
            <div className="space-y-3">
              {usage.esims.map((e) => (
                <div key={e.id} className="flex items-center justify-between border-b border-border/40 pb-3 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{countryFlag(e.country.slice(0, 2).toUpperCase())}</span>
                    <div>
                      <p className="font-medium">{e.country}</p>
                      <p className="text-xs text-muted-foreground">{formatDataSize(e.dataRemaining)} / {formatDataSize(e.dataAmount)} remaining</p>
                      {e.assignedTo && <p className="text-xs text-muted-foreground">Assigned: {e.assignedTo}</p>}
                    </div>
                  </div>
                  <Badge className={statusColor(e.status)}>{prettifyStatus(e.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Number Usage */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Phone className="h-4 w-4 text-primary" /> Numbers ({usage.numbers.length})</CardTitle></CardHeader>
        <CardContent>
          {usage.numbers.length === 0 ? (
            <p className="text-sm text-muted-foreground">No numbers assigned.</p>
          ) : (
            <div className="space-y-3">
              {usage.numbers.map((n) => (
                <div key={n.id} className="flex items-center justify-between border-b border-border/40 pb-3 last:border-0">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{countryFlag(n.country.slice(0, 2).toUpperCase())}</span>
                    <div>
                      <p className="font-mono font-medium">{n.e164}</p>
                      <p className="text-xs text-muted-foreground">{n.country} · {n.messageCount} SMS · {n.callCount} calls</p>
                    </div>
                  </div>
                  <Badge className={statusColor(n.status)}>{prettifyStatus(n.status)}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
