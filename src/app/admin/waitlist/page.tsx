"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Users, Check, Ban, Mail } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { formatDateTime } from "@/lib/format";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type WaitlistEntry = {
  id: string;
  email: string;
  name: string | null;
  status: string;
  note: string | null;
  createdAt: string;
  approvedAt: string | null;
};

export default function AdminWaitlistPage() {
  const [entries, setEntries] = useState<WaitlistEntry[] | null>(null);
  const [status, setStatus] = useState("pending");
  const [approving, setApproving] = useState<WaitlistEntry | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);

  function load() {
    api.get<{ entries: WaitlistEntry[] }>(`/api/admin/waitlist?status=${status}`).then((d) => setEntries(d.entries)).catch(() => setEntries([]));
  }

  useEffect(() => { load(); }, [status]);

  async function approve() {
    if (!approving) return;
    if (newPassword.length < 8) { toast.error("Password must be at least 8 characters"); return; }
    setSubmitting(true);
    try {
      await api.post(`/api/admin/waitlist/${approving.id}/approve`, { password: newPassword, name: approving.name ?? undefined });
      toast.success(`Account created for ${approving.email}`);
      setApproving(null);
      setNewPassword("");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to approve");
    } finally {
      setSubmitting(false);
    }
  }

  async function reject(id: string) {
    try {
      await api.post(`/api/admin/waitlist/${id}/reject`, {});
      toast.success("Entry rejected");
      load();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to reject");
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Waitlist</h2>
          <p className="text-sm text-muted-foreground">Review sign-ups and create accounts</p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="pending">Pending</SelectItem>
            <SelectItem value="approved">Approved</SelectItem>
            <SelectItem value="rejected">Rejected</SelectItem>
            <SelectItem value="all">All</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!entries ? (
        <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : entries.length === 0 ? (
        <Card className="mt-4"><CardContent className="flex flex-col items-center gap-3 p-10 text-center text-muted-foreground">
          <Users className="h-8 w-8" />
          <p>No {status !== "all" ? status : ""} waitlist entries.</p>
        </CardContent></Card>
      ) : (
        <div className="mt-4 space-y-3">
          {entries.map((e) => (
            <Card key={e.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-4">
                <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Mail className="h-5 w-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{e.name ?? "No name provided"}</p>
                  <p className="text-sm text-muted-foreground">{e.email}</p>
                  <p className="text-xs text-muted-foreground">Requested {formatDateTime(e.createdAt)}</p>
                </div>
                <Badge variant={e.status === "approved" ? "default" : e.status === "rejected" ? "destructive" : "secondary"}>{e.status}</Badge>
                {e.status === "pending" && (
                  <div className="flex gap-2">
                    <Dialog open={approving?.id === e.id} onOpenChange={(o) => { if (!o) { setApproving(null); setNewPassword(""); } }}>
                      <DialogTrigger asChild>
                        <Button size="sm" onClick={() => { setApproving(e); setNewPassword(generatePassword()); }}>
                          <Check className="mr-1 h-3.5 w-3.5" /> Approve
                        </Button>
                      </DialogTrigger>
                      <DialogContent>
                        <DialogHeader><DialogTitle>Create account for {e.email}</DialogTitle></DialogHeader>
                        <div className="space-y-3 py-2">
                          <p className="text-sm text-muted-foreground">Set a temporary password. The user can change it after signing in.</p>
                          <div className="space-y-2">
                            <Label>Temporary password</Label>
                            <div className="flex gap-2">
                              <Input value={newPassword} onChange={(ev) => setNewPassword(ev.target.value)} />
                              <Button type="button" variant="outline" size="sm" onClick={() => setNewPassword(generatePassword())}>Generate</Button>
                            </div>
                          </div>
                        </div>
                        <DialogFooter>
                          <Button variant="outline" onClick={() => { setApproving(null); setNewPassword(""); }}>Cancel</Button>
                          <Button onClick={approve} disabled={submitting}>
                            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create account
                          </Button>
                        </DialogFooter>
                      </DialogContent>
                    </Dialog>
                    <Button size="sm" variant="ghost" onClick={() => reject(e.id)}>
                      <Ban className="mr-1 h-3.5 w-3.5" /> Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function generatePassword(): string {
  const chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let p = "";
  for (let i = 0; i < 12; i++) p += chars[Math.floor(Math.random() * chars.length)];
  return p;
}
