"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, Gift, Copy, Users, Wallet, TrendingUp } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api } from "@/lib/api-client";
import { formatPrice, formatDate } from "@/lib/format";
import { toast } from "sonner";

type ReferralData = {
  referral: { referralCode: string; totalReferrals: number; completedReferrals: number; totalRewardPaid: number };
  credit: { balanceMinor: number; currency: string; totalEarned: number; totalSpent: number };
  history: { id: string; type: string; amountMinor: number; balanceAfter: number; reason: string | null; createdAt: string }[];
};

export default function ReferralPage() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [data, setData] = useState<ReferralData | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push("/login?next=/dashboard/referral"); return; }
    api.get<ReferralData>("/api/referral").then(setData).catch(() => toast.error("Failed to load"));
  }, [user, loading, router]);

  if (loading || !data) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  const referralLink = `${typeof window !== "undefined" ? window.location.origin : ""}/register?ref=${data.referral.referralCode}`;

  function copyCode() {
    navigator.clipboard?.writeText(data.referral.referralCode);
    toast.success("Referral code copied!");
  }

  function copyLink() {
    navigator.clipboard?.writeText(referralLink);
    toast.success("Referral link copied!");
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">Refer & Earn</h1>
      <p className="text-sm text-muted-foreground">Invite friends — you both get $2.00 in RoamLink credit when they make their first purchase.</p>

      <Card className="mt-6 bg-primary/5 border-primary/20">
        <CardContent className="flex items-center gap-4 p-5">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/10">
            <Wallet className="h-6 w-6 text-primary" />
          </div>
          <div className="flex-1">
            <p className="text-sm text-muted-foreground">RoamLink Credit Balance</p>
            <p className="text-2xl font-bold">{formatPrice(data.credit.balanceMinor, data.credit.currency)}</p>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <p>Earned: {formatPrice(data.credit.totalEarned)}</p>
            <p>Spent: {formatPrice(data.credit.totalSpent)}</p>
          </div>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Gift className="h-4 w-4 text-primary" /> Your Referral Code</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg bg-muted px-4 py-3 text-lg font-bold tracking-wider">{data.referral.referralCode}</code>
            <Button variant="outline" size="icon" onClick={copyCode}><Copy className="h-4 w-4" /></Button>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-1">Or share your referral link:</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 text-xs">{referralLink}</code>
              <Button variant="outline" size="sm" onClick={copyLink}>Copy</Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="mt-6 grid grid-cols-3 gap-4">
        <Card><CardContent className="p-4 text-center"><Users className="mx-auto h-5 w-5 text-muted-foreground" /><p className="mt-2 text-xl font-bold">{data.referral.totalReferrals}</p><p className="text-xs text-muted-foreground">Invited</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><TrendingUp className="mx-auto h-5 w-5 text-emerald-600" /><p className="mt-2 text-xl font-bold">{data.referral.completedReferrals}</p><p className="text-xs text-muted-foreground">Completed</p></CardContent></Card>
        <Card><CardContent className="p-4 text-center"><Wallet className="mx-auto h-5 w-5 text-primary" /><p className="mt-2 text-xl font-bold">{formatPrice(data.referral.totalRewardPaid)}</p><p className="text-xs text-muted-foreground">Earned</p></CardContent></Card>
      </div>

      {data.history.length > 0 && (
        <Card className="mt-6">
          <CardHeader><CardTitle className="text-sm">Credit History</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2">
              {data.history.map((tx) => (
                <div key={tx.id} className="flex items-center justify-between border-b border-border/40 pb-2 last:border-0">
                  <div>
                    <p className="text-sm font-medium">{tx.reason || tx.type}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(tx.createdAt)}</p>
                  </div>
                  <span className={`text-sm font-semibold ${tx.amountMinor > 0 ? "text-emerald-600" : "text-rose-600"}`}>
                    {tx.amountMinor > 0 ? "+" : ""}{formatPrice(Math.abs(tx.amountMinor))}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
