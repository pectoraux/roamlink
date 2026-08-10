"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Signal, Loader2 } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const next = searchParams.get("next") ?? "/dashboard/esims";

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post<{ user: { id: string } }>("/api/auth/login", { email, password });
      await refresh();
      toast.success("Welcome back!");
      router.push(next);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col px-4 py-12">
      <div className="mb-6 flex items-center justify-center gap-2">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Signal className="h-5 w-5" />
        </div>
        <span className="text-lg font-bold">RoamLink</span>
      </div>
      <Card>
        <CardHeader className="text-center">
          <CardTitle>Welcome back</CardTitle>
          <CardDescription>Sign in to manage your eSIMs</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Sign in
            </Button>
          </form>
          <div className="mt-4 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Demo accounts</p>
            <p className="mt-1">Customer: demo@esim.local / demo12345</p>
            <p>Admin: admin@esim.local / admin12345</p>
          </div>
          <p className="mt-4 text-center text-sm text-muted-foreground">
            No account? <Link href="/register" className="font-medium text-primary hover:underline">Create one</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
