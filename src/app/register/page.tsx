"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Signal, Loader2, CheckCircle2, Clock } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

export default function RegisterPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [joined, setJoined] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/auth/register", { name, email });
      setJoined(true);
      toast.success("You're on the waitlist!");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong");
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

      {joined ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 p-8 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-400">
              <CheckCircle2 className="h-7 w-7" />
            </div>
            <div>
              <h2 className="text-xl font-semibold">You're on the waitlist!</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                We'll email <span className="font-medium text-foreground">{email}</span> as soon as your account is ready.
                Our team reviews each request personally.
              </p>
            </div>
            <div className="w-full rounded-lg bg-muted/60 p-3 text-left text-xs text-muted-foreground">
              <p className="flex items-center gap-1.5 font-medium text-foreground"><Clock className="h-3.5 w-3.5" /> What happens next?</p>
              <p className="mt-1">1. We review your request (usually within 24 hours).</p>
              <p>2. We create your account and send you login details.</p>
              <p>3. You sign in and start buying travel eSIMs.</p>
            </div>
            <Button asChild variant="outline" className="w-full"><Link href="/login">Back to sign in</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="text-center">
            <CardTitle>Join the waitlist</CardTitle>
            <CardDescription>We're rolling out access in waves. Reserve your spot.</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name (optional)</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <Button type="submit" className="w-full" disabled={loading}>
                {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Join waitlist
              </Button>
            </form>
            <p className="mt-4 text-center text-sm text-muted-foreground">
              Already have an account? <Link href="/login" className="font-medium text-primary hover:underline">Sign in</Link>
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
