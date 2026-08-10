"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Signal, Loader2, Zap } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

const DEMO_ACCOUNTS = [
  { label: "Demo Customer", email: "demo@esim.local", password: "demo12345", role: "customer" },
  { label: "Demo Admin", email: "admin@esim.local", password: "admin12345", role: "admin" },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { refresh } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [quickLoading, setQuickLoading] = useState<string | null>(null);

  const next = searchParams.get("next") ?? "/dashboard/esims";

  async function doLogin(em: string, pw: string) {
    await api.post("/api/auth/login", { email: em, password: pw });
    await refresh();
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await doLogin(email, password);
      toast.success("Welcome back!");
      router.push(next);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  }

  async function quickLogin(em: string, pw: string, label: string) {
    setQuickLoading(label);
    try {
      await doLogin(em, pw);
      toast.success(`Signed in as ${label}`);
      const target = em === "admin@esim.local" ? "/admin" : next;
      router.push(target);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Login failed");
    } finally {
      setQuickLoading(null);
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

          <div className="mt-4 rounded-lg border border-dashed border-primary/30 bg-primary/5 p-3">
            <p className="flex items-center gap-1.5 text-xs font-medium text-primary"><Zap className="h-3.5 w-3.5" /> Quick demo login</p>
            <p className="mt-1 text-xs text-muted-foreground">No account? Try the demo accounts instantly:</p>
            <div className="mt-2 grid grid-cols-1 gap-2">
              {DEMO_ACCOUNTS.map((acc) => (
                <button
                  key={acc.email}
                  type="button"
                  onClick={() => quickLogin(acc.email, acc.password, acc.label)}
                  disabled={quickLoading !== null}
                  className="flex items-center justify-between rounded-lg border border-border/60 bg-card px-3 py-2 text-left text-sm transition-colors hover:border-primary/40 hover:bg-primary/5 disabled:opacity-60"
                >
                  <span>
                    <span className="font-medium">{acc.label}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{acc.email}</span>
                  </span>
                  {quickLoading === acc.label ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                  ) : (
                    <span className="text-xs font-medium text-primary">Sign in →</span>
                  )}
                </button>
              ))}
            </div>
          </div>

          <p className="mt-4 text-center text-sm text-muted-foreground">
            New here? <Link href="/register" className="font-medium text-primary hover:underline">Join the waitlist</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="flex min-h-[60vh] items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    }>
      <LoginForm />
    </Suspense>
  );
}
