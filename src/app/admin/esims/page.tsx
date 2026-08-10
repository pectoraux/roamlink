"use client";

import { useEffect, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Loader2, Search } from "lucide-react";
import { api } from "@/lib/api-client";
import { formatDataSize, formatDate, countryFlag, prettifyStatus, statusColor } from "@/lib/format";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";

type ESIM = {
  id: string;
  iccid: string | null;
  status: string;
  dataAmount: number;
  dataRemaining: number;
  expiresAt: string | null;
  createdAt: string;
  user: { email: string };
  order: { id: string };
};

export default function AdminESIMsPage() {
  const [esims, setEsims] = useState<ESIM[] | null>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");

  function load() {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    api.get<{ esims: ESIM[] }>(`/api/admin/esims?${params.toString()}`).then((d) => setEsims(d.esims)).catch(() => setEsims([]));
  }

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [search, status]);

  return (
    <div>
      <h2 className="text-xl font-bold tracking-tight">eSIMs</h2>
      <p className="text-sm text-muted-foreground">Search by ICCID, status, owner</p>

      <div className="mt-4 flex flex-wrap gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search ICCID..." className="pl-9" />
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="exhausted">Exhausted</SelectItem>
            <SelectItem value="expired">Expired</SelectItem>
            <SelectItem value="cancelled">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!esims ? (
        <div className="mt-8 flex justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : esims.length === 0 ? (
        <Card className="mt-4"><CardContent className="p-8 text-center text-sm text-muted-foreground">No eSIMs found.</CardContent></Card>
      ) : (
        <Card className="mt-4">
          <CardContent className="p-0">
            <div className="scroll-area max-h-[70vh] overflow-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="p-3">ICCID</th>
                    <th className="p-3">Owner</th>
                    <th className="p-3">Data</th>
                    <th className="p-3">Remaining</th>
                    <th className="p-3">Expires</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {esims.map((e) => (
                    <tr key={e.id} className="border-t border-border/60">
                      <td className="p-3 font-mono text-xs">{e.iccid ?? "—"}</td>
                      <td className="p-3">{e.user.email}</td>
                      <td className="p-3">{formatDataSize(e.dataAmount)}</td>
                      <td className="p-3">{formatDataSize(e.dataRemaining)}</td>
                      <td className="p-3 text-xs text-muted-foreground">{e.expiresAt ? formatDate(e.expiresAt) : "—"}</td>
                      <td className="p-3"><Badge className={statusColor(e.status)}>{prettifyStatus(e.status)}</Badge></td>
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
