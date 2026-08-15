"use client";

/**
 * Phase 5.1D — Reseller Onboarding Page
 *
 * Public page where a new connectivity operator can sign up.
 * Creates a user + tenant + trial subscription, then redirects to the portal.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import Link from "next/link";

export default function OnboardingPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessSlug, setBusinessSlug] = useState("");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);

    try {
      const res = await fetch("/api/onboarding/tenant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, name, businessName, businessSlug: businessSlug || undefined }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to create account");
      }

      toast.success("Account created! Welcome to RoamLink.");
      router.push(data.redirectTo || "/");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-md w-full">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold tracking-tight">RoamLink OS</h1>
          <p className="text-muted-foreground mt-2">
            The operating system for connectivity resellers
          </p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Create your reseller account</CardTitle>
            <CardDescription>
              Start selling WiFi, eSIM, or telecom connectivity under your own brand.
              14-day free trial — no credit card required.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="businessName">Business Name</Label>
                <Input
                  id="businessName"
                  placeholder="Accra WiFi Networks"
                  value={businessName}
                  onChange={(e) => setBusinessName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="businessSlug">Business Slug (optional)</Label>
                <Input
                  id="businessSlug"
                  placeholder="accra-wifi"
                  value={businessSlug}
                  onChange={(e) => setBusinessSlug(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  Used in your portal URL. Leave blank to auto-generate from business name.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">Your Name</Label>
                <Input
                  id="name"
                  placeholder="Jane Doe"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  placeholder="jane@accrawifi.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="At least 8 characters"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={8}
                />
              </div>

              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? "Creating account..." : "Start free trial"}
              </Button>

              <p className="text-xs text-center text-muted-foreground">
                Already have an account?{" "}
                <Link href="/auth/login" className="text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </form>
          </CardContent>
        </Card>

        <p className="text-xs text-center text-muted-foreground mt-4">
          By signing up, you agree to the RoamLink Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
