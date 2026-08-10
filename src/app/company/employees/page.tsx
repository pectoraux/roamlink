import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getUserOrganization } from "@/server/services/organization";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Building2, ArrowLeft } from "lucide-react";

export default async function EmployeesPage() {
  const user = await getCurrentUser();
  if (!user) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Button asChild><Link href="/login?next=/company/employees">Sign in</Link></Button></div>;

  const org = await getUserOrganization(user.id);
  if (!org) return <div className="mx-auto max-w-md px-4 py-16 text-center"><Building2 className="mx-auto h-12 w-12 text-muted-foreground" /><p className="mt-4 text-sm text-muted-foreground">No organization.</p><Button asChild className="mt-4"><Link href="/company">Create one</Link></Button></div>;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <Link href="/company" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to dashboard</Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Employees</h1>
      <p className="text-sm text-muted-foreground">Members of {org.name}</p>

      <Card className="mt-6">
        <CardHeader><CardTitle className="text-base">Team members ({org.members.length})</CardTitle></CardHeader>
        <CardContent>
          {org.members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="space-y-3">
              {org.members.map((m) => (
                <div key={m.id} className="flex items-center justify-between border-b border-border/40 pb-3 last:border-0">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-bold">
                      {(m.user.name ?? m.user.email)[0].toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{m.user.name ?? "No name"}</p>
                      <p className="text-xs text-muted-foreground">{m.user.email}</p>
                    </div>
                  </div>
                  <Badge variant={m.role === "owner" ? "default" : "secondary"}>{m.role}</Badge>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardContent className="p-5">
          <p className="text-sm text-muted-foreground">To add a member, the user must first create an account (via the waitlist approval flow). Then use the API to add them to the organization.</p>
        </CardContent>
      </Card>
    </div>
  );
}
