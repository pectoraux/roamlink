import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization, getOrgStats } from "@/server/services/organization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Users, Smartphone, ShoppingBag, Plus, Building2 } from "lucide-react";

export default async function CompanyDashboard() {
  const user = await getCurrentUser();
  if (!user) {
    return (
      <div className="mx-auto max-w-md px-4 py-16 text-center">
        <Building2 className="mx-auto h-12 w-12 text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Sign in required</h1>
        <Button asChild className="mt-4"><Link href="/login?next=/company">Sign in</Link></Button>
      </div>
    );
  }

  const org = await getUserOrganization(user.id);

  if (!org) {
    return (
      <div className="mx-auto max-w-md px-4 py-16">
        <div className="text-center">
          <Building2 className="mx-auto h-12 w-12 text-muted-foreground" />
          <h1 className="mt-4 text-2xl font-bold">Corporate Account</h1>
          <p className="mt-2 text-sm text-muted-foreground">Manage eSIMs for your team. Assign plans to employees, monitor usage, and centralize billing.</p>
        </div>
        <Card className="mt-8">
          <CardContent className="p-6">
            <CreateOrgForm />
          </CardContent>
        </Card>
      </div>
    );
  }

  const stats = await getOrgStats(org.id);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{org.name}</h1>
          <p className="text-sm text-muted-foreground">Corporate dashboard · You are {org.role}</p>
        </div>
        <Badge variant="secondary">{org.status}</Badge>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard icon={Users} label="Members" value={stats.members} href="/company/employees" />
        <StatCard icon={Smartphone} label="Assigned eSIMs" value={stats.esims} href="/company/esims" />
        <StatCard icon={ShoppingBag} label="Corporate orders" value={stats.orders} href="/company/orders" />
      </div>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">Quick actions</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap gap-3">
          <Button asChild variant="outline"><Link href="/company/employees">Manage employees</Link></Button>
          <Button asChild variant="outline"><Link href="/company/esims">View eSIMs</Link></Button>
          <Button asChild><Link href="/esim"><Plus className="mr-1 h-4 w-4" /> Buy eSIM</Link></Button>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">Members</CardTitle></CardHeader>
        <CardContent>
          {org.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-2">
              {org.members.map((m) => (
                <div key={m.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{m.user.name ?? m.user.email}</p>
                    <p className="text-xs text-muted-foreground">{m.user.email}</p>
                  </div>
                  <Badge variant={m.role === "owner" ? "default" : "secondary"}>{m.role}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, href }: { icon: React.ElementType; label: string; value: number; href: string }) {
  return (
    <Link href={href}>
      <Card className="lift">
        <CardContent className="p-5">
          <Icon className="h-5 w-5 text-primary" />
          <p className="mt-3 text-2xl font-bold">{value}</p>
          <p className="text-xs text-muted-foreground">{label}</p>
        </CardContent>
      </Card>
    </Link>
  );
}

function CreateOrgForm() {
  return (
    <form action="/api/organization" method="POST" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Create your organization</h2>
        <p className="text-sm text-muted-foreground">Get started with corporate eSIM management.</p>
      </div>
      <CreateOrgClientForm />
    </form>
  );
}

import { Badge } from "@/components/ui/badge";
import { CreateOrgClientForm } from "@/components/create-org-form";
