import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization } from "@/server/services/organization";
import { db } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowLeft } from "lucide-react";
import { formatPrice, formatDate, statusColor, prettifyStatus } from "@/lib/format";

export default async function CompanyOrdersPage() {
  const user = await getCurrentUser();
  if (!user) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Button asChild><Link href="/login?next=/company/orders">Sign in</Link></Button></div>;

  const org = await getUserOrganization(user.id);
  if (!org) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Building2 className="mx-auto h-12 w-12 text-muted-foreground" /><p className="mt-4 text-sm text-muted-foreground">No organization.</p><Button asChild className="mt-4"><Link href="/company">Create one</Link></Button></div>;

  const orgOrders = await db.corporateOrder.findMany({
    where: { organizationId: org.id },
    include: { order: { include: { plan: true } } },
    orderBy: { createdAt: "desc" },
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/company" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to dashboard</Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Corporate Orders</h1>
      <p className="text-sm text-muted-foreground">{orgOrders.length} orders for {org.name}</p>

      {orgOrders.length === 0 ? (
        <Card className="mt-6"><CardContent className="p-12 text-center text-sm text-muted-foreground">No corporate orders yet.</CardContent></Card>
      ) : (
        <div className="mt-6 space-y-3">
          {orgOrders.map((oo) => {
            const order = oo.order;
            return (
              <Card key={oo.id}>
                <CardContent className="flex items-center gap-4 p-4">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{order.plan.name}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(order.createdAt)} · {order.id.slice(-8)}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-semibold">{formatPrice(order.amount, order.currency)}</p>
                    <Badge className={`mt-1 ${statusColor(order.status)}`}>{prettifyStatus(order.status)}</Badge>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
