"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, RefreshCw, Search, Check, Ban } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatPrice, formatDataSize, countryFlag } from "@/lib/format";
import { toast } from "sonner";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";

type Plan = {
  id: string;
  name: string;
  country: string;
  countryCode: string;
  region: string;
  dataAmount: number;
  validityDays: number;
  price: number;
  wholesalePrice: number;
  currency: string;
  status: string;
  networks: string | null;
  speed: string | null;
};

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [search, setSearch] = useState("");
  const [syncing, setSyncing] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [editPrice, setEditPrice] = useState("");

  function load() {
    api.get<{ plans: Plan[] }>("/api/admin/plans").then((d) => setPlans(d.plans)).catch(() => toast.error("Failed to load plans"));
  }

  useEffect(() => { load(); }, []);

  async function sync() {
    setSyncing(true);
    try {
      const res = await api.post<{ result: { created: number; updated: number; total: number } }>("/api/plans/sync");
      toast.success(`Synced: ${res.result.created} new, ${res.result.updated} updated`);
      load();
    } catch {
      toast.error("Sync failed");
    } finally {
      setSyncing(false);
    }
  }

  async function toggleStatus(plan: Plan) {
    const newStatus = plan.status === "active" ? "inactive" : "active";
    try {
      await api.patch(`/api/admin/plans/${plan.id}`, { status: newStatus });
      toast.success(`Plan ${newStatus}`);
      load();
    } catch {
      toast.error("Failed to update");
    }
  }

  async function savePrice() {
    if (!editing) return;
    const priceMinor = Math.round(Number(editPrice) * 100);
    if (!Number.isFinite(priceMinor)) { toast.error("Invalid price"); return; }
    try {
      await api.patch(`/api/admin/plans/${editing.id}`, { priceMinor });
      toast.success("Price updated");
      setEditing(null);
      load();
    } catch {
      toast.error("Failed to update price");
    }
  }

  const filtered = plans?.filter((p) =>
    p.name.toLowerCase().includes(search.toLowerCase()) ||
    p.country.toLowerCase().includes(search.toLowerCase()),
  ) ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Plans</h2>
          <p className="text-sm text-muted-foreground">Manage catalog & retail pricing</p>
        </div>
        <Button onClick={sync} disabled={syncing}>
          <RefreshCw className={`mr-2 h-4 w-4 ${syncing ? "animate-spin" : ""}`} /> Sync from provider
        </Button>
      </div>

      <div className="mt-4 relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search plans..." className="pl-9" />
      </div>

      {!plans ? (
        <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <div className="scroll-area max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-3">Plan</th>
                    <th className="p-3">Data</th>
                    <th className="p-3">Valid</th>
                    <th className="p-3">Retail</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((p) => (
                    <tr key={p.id} className="border-t border-border/60">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span aria-hidden>{countryFlag(p.countryCode)}</span>
                          <div>
                            <p className="font-medium">{p.name}</p>
                            <p className="text-xs text-muted-foreground">{p.country} · {p.region}</p>
                          </div>
                        </div>
                      </td>
                      <td className="p-3">{formatDataSize(p.dataAmount)}</td>
                      <td className="p-3">{p.validityDays}d</td>
                      <td className="p-3 font-medium">{formatPrice(p.price, p.currency)}</td>
                      <td className="p-3">
                        <Badge variant={p.status === "active" ? "default" : "secondary"}>{p.status}</Badge>
                      </td>
                      <td className="p-3 text-right">
                        <div className="flex justify-end gap-1">
                          <Dialog open={editing?.id === p.id} onOpenChange={(o) => { if (!o) setEditing(null); }}>
                            <DialogTrigger asChild>
                              <Button size="sm" variant="ghost" onClick={() => { setEditing(p); setEditPrice((p.price / 100).toString()); }}>
                                Edit price
                              </Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader><DialogTitle>Edit retail price</DialogTitle></DialogHeader>
                              <div className="space-y-2 py-2">
                                <Label>New price ({p.currency})</Label>
                                <Input type="number" step="0.01" value={editPrice} onChange={(e) => setEditPrice(e.target.value)} />
                                <p className="text-xs text-muted-foreground">Wholesale: {formatPrice(p.wholesalePrice, p.currency)}</p>
                              </div>
                              <DialogFooter>
                                <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
                                <Button onClick={savePrice}>Save</Button>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                          <Button size="sm" variant="ghost" onClick={() => toggleStatus(p)}>
                            {p.status === "active" ? <><Ban className="mr-1 h-3.5 w-3.5" /> Disable</> : <><Check className="mr-1 h-3.5 w-3.5" /> Enable</>}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
