"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription,
} from "@/components/ui/dialog";
import { Smartphone, QrCode, Link2, Loader2, Copy, Check } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";
import Image from "next/image";

export function SendToPhoneButton({ esimId }: { esimId: string }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [installUrl, setInstallUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generateLink() {
    setLoading(true);
    try {
      const res = await api.post<{ token: string; expiresAt: string }>(`/api/esims/${esimId}/install-token`);
      const baseUrl = window.location.origin;
      setInstallUrl(`${baseUrl}/install?token=${res.token}`);
      toast.success("Installation link generated — valid for 15 minutes");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to generate link");
    } finally {
      setLoading(false);
    }
  }

  function copyLink() {
    if (installUrl) {
      navigator.clipboard?.writeText(installUrl);
      setCopied(true);
      toast.success("Link copied");
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) { setInstallUrl(null); setCopied(false); } }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="lg" className="w-full">
          <Smartphone className="mr-2 h-4 w-4" /> Install on your phone
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install on your phone</DialogTitle>
          <DialogDescription>
            eSIM installation happens on the phone that will use the eSIM. Generate a secure, short-lived link to continue on your mobile device.
          </DialogDescription>
        </DialogHeader>

        {!installUrl ? (
          <div className="py-4">
            <div className="rounded-lg bg-muted/60 p-4 text-sm text-muted-foreground">
              <p className="font-medium text-foreground">How it works</p>
              <ol className="mt-2 space-y-1 list-decimal list-inside">
                <li>Generate a secure installation link (valid 15 minutes)</li>
                <li>Open the link on your phone (scan QR or copy URL)</li>
                <li>Sign in with the same account</li>
                <li>Follow the installation instructions</li>
              </ol>
            </div>
          </div>
        ) : (
          <div className="py-4 space-y-4">
            <div className="flex flex-col items-center gap-3">
              <div className="rounded-lg border border-border/60 bg-white p-3">
                <Image src={`https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(installUrl)}`} alt="Installation QR" width={200} height={200} unoptimized />
              </div>
              <p className="text-xs text-muted-foreground">Scan this QR code with your phone camera</p>
            </div>
            <div>
              <Label>Or copy this link</Label>
              <div className="mt-1 flex gap-2">
                <Input value={installUrl} readOnly className="font-mono text-xs" />
                <Button size="icon" variant="outline" onClick={copyLink}>
                  {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <p className="mt-2 text-xs text-amber-600">⚠ This link expires in 15 minutes and can only be used once.</p>
            </div>
          </div>
        )}

        <DialogFooter>
          {!installUrl && (
            <Button onClick={generateLink} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Link2 className="mr-2 h-4 w-4" />}
              Generate installation link
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
