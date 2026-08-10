"use client";

import { useEffect, useState, use } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ArrowLeft, MessageSquare, Phone, Smartphone, Loader2, Send } from "lucide-react";
import { useAuth } from "@/app/providers";
import { api, ApiError } from "@/lib/api-client";
import { countryFlag, formatDate, formatPrice } from "@/lib/format";
import { toast } from "sonner";

type VNumber = {
  id: string;
  e164: string;
  country: string;
  countryCode: string;
  region: string | null;
  smsEnabled: boolean;
  voiceEnabled: boolean;
  status: string;
  sellingPrice: number;
  currency: string;
  expiresAt: string | null;
  messages?: { id: string; direction: string; fromNumber: string; toNumber: string; body: string; status: string; createdAt: string }[];
  calls?: { id: string; direction: string; fromNumber: string; toNumber: string; status: string; durationSeconds: number; createdAt: string }[];
};

export default function NumberDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const { user, loading } = useAuth();
  const [vn, setVn] = useState<VNumber | null>(null);
  const [sendTo, setSendTo] = useState("");
  const [sendBody, setSendBody] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push(`/login?next=/dashboard/numbers/${id}`); return; }
    api.get<{ number: VNumber }>(`/api/virtual-numbers/${id}`).then((d) => setVn(d.number)).catch(() => toast.error("Number not found"));
  }, [user, loading, router, id]);

  async function sendSMS(e: React.FormEvent) {
    e.preventDefault();
    if (!sendTo || !sendBody) return;
    setSending(true);
    try {
      await api.post(`/api/virtual-numbers/${id}/messages`, { to: sendTo, body: sendBody });
      toast.success("SMS sent!");
      setSendTo("");
      setSendBody("");
      // Reload
      const d = await api.get<{ number: VNumber }>(`/api/virtual-numbers/${id}`);
      setVn(d.number);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to send SMS");
    } finally {
      setSending(false);
    }
  }

  if (loading || !vn) return <div className="flex justify-center py-16"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <Link href="/dashboard/numbers" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> My Numbers</Link>

      <div className="mt-4 flex items-center gap-4">
        <span className="text-4xl">{countryFlag(vn.countryCode)}</span>
        <div>
          <h1 className="text-2xl font-bold font-mono">{vn.e164}</h1>
          <p className="text-sm text-muted-foreground">{vn.country} · {vn.region ?? "Local"}</p>
        </div>
        <Badge className="ml-auto" variant={vn.status === "active" ? "default" : "secondary"}>{vn.status}</Badge>
      </div>

      <div className="mt-4 flex gap-2">
        {vn.smsEnabled && <Badge variant="secondary" className="gap-1"><MessageSquare className="h-3 w-3" /> SMS</Badge>}
        {vn.voiceEnabled && <Badge variant="secondary" className="gap-1"><Phone className="h-3 w-3" /> Voice</Badge>}
      </div>

      <Card className="mt-6 p-4">
        <div className="flex justify-between text-sm">
          <div><p className="text-muted-foreground">Price</p><p className="font-semibold">{formatPrice(vn.sellingPrice, vn.currency)}/mo</p></div>
          <div><p className="text-muted-foreground">Renews</p><p className="font-semibold">{vn.expiresAt ? formatDate(vn.expiresAt) : "—"}</p></div>
        </div>
      </Card>

      <Tabs defaultValue="messages" className="mt-6">
        <TabsList className="grid w-full grid-cols-2">
          <TabsTrigger value="messages"><MessageSquare className="mr-1 h-4 w-4" /> Messages</TabsTrigger>
          <TabsTrigger value="calls"><Phone className="mr-1 h-4 w-4" /> Calls</TabsTrigger>
        </TabsList>
        <TabsContent value="messages" className="mt-4 space-y-4">
          {vn.smsEnabled && (
            <Card>
              <CardHeader><CardTitle className="text-sm">Send SMS</CardTitle></CardHeader>
              <CardContent>
                <form onSubmit={sendSMS} className="space-y-3">
                  <input className="w-full rounded-lg border border-border px-3 py-2 text-sm" placeholder="To: +233..." value={sendTo} onChange={(e) => setSendTo(e.target.value)} />
                  <textarea className="w-full rounded-lg border border-border px-3 py-2 text-sm" placeholder="Message..." rows={3} value={sendBody} onChange={(e) => setSendBody(e.target.value)} />
                  <Button type="submit" size="sm" disabled={sending}>{sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <><Send className="mr-1 h-3.5 w-3.5" /> Send</>}</Button>
                </form>
              </CardContent>
            </Card>
          )}
          <div className="space-y-2">
            {vn.messages?.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">No messages yet.</p>
            ) : (
              vn.messages?.map((m) => (
                <Card key={m.id}>
                  <CardContent className="p-3">
                    <div className="flex items-center justify-between text-xs text-muted-foreground mb-1">
                      <span>{m.direction === "inbound" ? `From: ${m.fromNumber}` : `To: ${m.toNumber}`}</span>
                      <span>{formatDate(m.createdAt)}</span>
                    </div>
                    <p className="text-sm">{m.body}</p>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </TabsContent>
        <TabsContent value="calls" className="mt-4">
          {vn.calls?.length === 0 ? (
            <p className="text-center text-sm text-muted-foreground py-8">No calls yet.</p>
          ) : (
            vn.calls?.map((c) => (
              <Card key={c.id}>
                <CardContent className="flex items-center justify-between p-3">
                  <div>
                    <p className="text-sm font-medium">{c.direction === "inbound" ? `From: ${c.fromNumber}` : `To: ${c.toNumber}`}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(c.createdAt)}</p>
                  </div>
                  <div className="text-right">
                    <Badge variant="secondary">{c.status}</Badge>
                    <p className="text-xs text-muted-foreground mt-1">{Math.floor(c.durationSeconds / 60)}m {c.durationSeconds % 60}s</p>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
