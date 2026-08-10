"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2 } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDate } from "@/lib/format";

type User = {
  id: string;
  email: string;
  name: string | null;
  role: string;
  createdAt: string;
  _count: { orders: number; esims: number };
};

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[] | null>(null);

  useEffect(() => {
    api.get<{ users: User[] }>("/api/admin/users").then((d) => setUsers(d.users)).catch(() => setUsers([]));
  }, []);

  if (!users) return <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">Users</h2>
      <p className="text-sm text-muted-foreground">{users.length} registered</p>

      <Card className="mt-4">
        <CardContent className="p-0">
          <div className="scroll-area max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="p-3">Email</th>
                  <th className="p-3">Name</th>
                  <th className="p-3">Role</th>
                  <th className="p-3">Orders</th>
                  <th className="p-3">eSIMs</th>
                  <th className="p-3">Joined</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} className="border-t border-border/60">
                    <td className="p-3 font-medium">{u.email}</td>
                    <td className="p-3 text-muted-foreground">{u.name ?? "—"}</td>
                    <td className="p-3">
                      <Badge variant={u.role === "admin" ? "default" : "secondary"}>{u.role}</Badge>
                    </td>
                    <td className="p-3">{u._count.orders}</td>
                    <td className="p-3">{u._count.esims}</td>
                    <td className="p-3 text-xs text-muted-foreground">{formatDate(u.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
