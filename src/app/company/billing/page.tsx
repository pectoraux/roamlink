"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ArrowLeft, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { formatPrice } from "@/lib/format";
import { toast } from "sonner";

type BillingData = {
  billing: { billingEmail: string | null; monthlySpendLimit: number; currentMonthSpend: number } | null;
};

export default function CompanyBillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [billingEmail, setBillingEmail] = useState("");
  const [spendLimit, setSpendLimit] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    api.get<BillingData>("/api/organization/billing").then((d) => {
      setData(d);
      setBillingEmail(d.billing?.billingEmail ?? "");
      setSpendLimit(d.billing ? (d.billing.monthlySpendLimit / 100).toString() : "");
    });
  }, []);

  async function save() {
    setSaving(true);
    try {
      await api.patch("/api/organization/billing", {
        billingEmail,
        monthlySpendLimit: spendLimit ? Math.round(Number(spendLimit) * 100) : 0,
      });
      toast.success("Billing settings saved");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  if (!data) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <Link href="/company" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Back to dashboard</Link>
      <h1 className="mt-4 text-2xl font-bold tracking-tight">Billing Settings</h1>

      {/* Current spend */}
      <Card className="mt-6">
        <CardContent className="p-5">
          <div className="flex justify-between">
            <div>
              <p className="text-sm text-muted-foreground">Current Month Spend</p>
              <p className="text-2xl font-bold">{formatPrice(data.billing?.currentMonthSpend ?? 0)}</p>
            </div>
            <div className="text-right">
              <p className="text-sm text-muted-foreground">Monthly Limit</p>
              <p className="text-2xl font-bold">{data.billing?.monthlySpendLimit ? formatPrice(data.billing.monthlySpendLimit) : "Unlimited"}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Settings form */}
      <Card className="mt-4">
        <CardHeader><CardTitle className="text-base">Configure</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Billing Email</Label>
            <Input type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="billing@company.com" />
          </div>
          <div className="space-y-2">
            <Label>Monthly Spend Limit (USD)</Label>
            <Input type="number" step="0.01" value={spendLimit} onChange={(e) => setSpendLimit(e.target.value)} placeholder="0 = unlimited" />
            <p className="text-xs text-muted-foreground">Set to 0 for unlimited. Members exceeding this limit will be blocked from purchasing.</p>
          </div>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Save</Button>
        </CardContent>
      </Card>
    </div>
  );
}
