import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization } from "@/server/services/organization";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowLeft, Smartphone, Plus } from "lucide-react";
import { formatDataSize, formatDate, statusColor, prettifyStatus } from "@/lib/format";

export default async function CompanyEsimsPage() {
  const user = await getCurrentUser();
  if (!user) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Button asChild><Link href="/login?next=/company/esims">Sign in</Link></Button></div>;

  const org = await getUserOrganization(user.id);
  if (!org) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Building2 className="mx-auto h-12 w-12 text-muted-foreground" /><p className="mt-4 text-sm text-muted-foreground">No organization.</p><Button asChild className="mt-4"><Link href="/company">Create one</Link></Button></div>;

  // Get eSIMs assigned to this org with their details
  const orgEsims = await db.organizationESIM.findMany({
    where: { organizationId: org.id },
    include: { esim: { include: { order: { include: { plan: true } } } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/company" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to dashboard</Link>
      <div className="mt-4 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Company eSIMs</h1>
          <p className="text-sm text-muted-foreground">{orgEsims.length} assigned to {org.name}</p>
        </div>
        <Button asChild><Link href="/esim"><Plus className="mr-1 h-4 w-4" /> Buy eSIM</Link></Button>
      </div>

      {orgEsims.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="flex flex-col items-center gap-4 p-12 text-center">
            <Smartphone className="h-10 w-10 text-muted-foreground" />
            <div>
              <p className="font-medium">No eSIMs assigned yet</p>
              <p className="text-sm text-muted-foreground">Purchase eSIMs and assign them to employees.</p>
            </div>
            <Button asChild><Link href="/esim">Browse plans</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-3">
          {orgEsims.map((oe) => {
            const esim = oe.esim;
            return (
              <Card key={oe.id}>
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10"><Smartphone className="h-5 w-5 text-primary" /></div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{esim.order.plan.country}</p>
                    <p className="text-xs text-muted-foreground">{esim.order.plan.name} · {formatDataSize(esim.dataRemaining)} / {formatDataSize(esim.dataAmount)}</p>
                    {oe.assignedTo && <p className="text-xs text-muted-foreground">Assigned to: {oe.assignedTo}</p>}
                  </div>
                  <Badge className={statusColor(esim.status)}>{prettifyStatus(esim.status)}</Badge>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
