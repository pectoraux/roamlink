"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import {
  ArrowLeft,
  AlertCircle,
  Mail,
  Phone,
  User as UserIcon,
  Pencil,
  Loader2,
  ShoppingBag,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, formatPrice, statusColor, prettifyStatus } from "@/lib/format";

type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  userId: string | null;
  createdAt: string;
};

type Order = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  tenantCustomerId: string | null;
  createdAt: string;
  plan: { id: string; name: string; country: string } | null;
};

export default function CustomerDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;

  const [customer, setCustomer] = useState<Customer | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [showEdit, setShowEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: "", phone: "", status: "active" });
  const [formError, setFormError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [custRes, ordRes] = await Promise.all([
        fetch(`/api/tenant/customers/${id}`, { cache: "no-store" }),
        fetch("/api/tenant/orders", { cache: "no-store" }),
      ]);
      const custData = await custRes.json();
      if (!custRes.ok) throw new Error(custData?.error ?? "Failed to load customer");
      setCustomer(custData.customer);
      setForm({
        name: custData.customer.name ?? "",
        phone: custData.customer.phone ?? "",
        status: custData.customer.status ?? "active",
      });
      if (ordRes.ok) {
        const ordData = await ordRes.json();
        setOrders(ordData.orders ?? []);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load customer");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  const customerOrders = useMemo(
    () => orders.filter((o) => o.tenantCustomerId === id),
    [orders, id],
  );

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Name is required.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/tenant/customers/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          phone: form.phone.trim() || null,
          status: form.status,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to update customer");
      setShowEdit(false);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : "Failed to update customer");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-2">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </div>
    );
  }

  if (error || !customer) {
    return (
      <div className="space-y-4">
        <Link
          href="/reseller/customers"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to customers
        </Link>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load customer</AlertTitle>
          <AlertDescription>{error ?? "Customer not found."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/reseller/customers"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to customers
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{customer.name}</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Customer since {formatDate(customer.createdAt)}
          </p>
        </div>
        <Button variant="outline" onClick={() => setShowEdit(true)} className="gap-2">
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Contact information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <UserIcon className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Name</p>
                <p className="font-medium truncate">{customer.name}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <Mail className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Email</p>
                <p className="font-medium truncate">{customer.email}</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                <Phone className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">Phone</p>
                <p className="font-medium truncate">{customer.phone ?? "—"}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Account status</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <p className="text-xs text-muted-foreground">Status</p>
              <Badge className={`mt-1 ${statusColor(customer.status)}`}>
                {prettifyStatus(customer.status)}
              </Badge>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Linked user account</p>
              <p className="font-medium mt-1">
                {customer.userId ? "Linked" : "No linked account"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {customer.userId
                  ? "Customer can self-serve via their RoamLink account."
                  : "Customer is managed by your team only."}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total orders</p>
              <p className="font-medium mt-1">{customerOrders.length}</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Customer orders */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Orders</CardTitle>
          <CardDescription>Orders linked to this customer.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {customerOrders.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <ShoppingBag className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium text-sm">No orders yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create an order for this customer from the orders page.
              </p>
              <Button
                variant="outline"
                size="sm"
                className="mt-3"
                onClick={() => router.push("/reseller/orders")}
              >
                Go to orders
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Order</TableHead>
                  <TableHead className="hidden sm:table-cell">Plan</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden md:table-cell">Payment</TableHead>
                  <TableHead className="pr-6 hidden sm:table-cell">Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {customerOrders.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/reseller/orders/${o.id}`)}
                  >
                    <TableCell className="pl-6 font-mono text-xs">
                      {o.id.slice(-10)}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {o.plan?.name ?? "—"}
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatPrice(o.amount, o.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColor(o.status)}>
                        {prettifyStatus(o.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <Badge variant="outline" className={statusColor(o.paymentStatus)}>
                        {prettifyStatus(o.paymentStatus)}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-6 hidden sm:table-cell text-muted-foreground">
                      {formatDate(o.createdAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={showEdit} onOpenChange={setShowEdit}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit customer</DialogTitle>
            <DialogDescription>
              Update customer details or change their account status.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleSave} className="space-y-4">
            {formError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{formError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="edit-name">Full name</Label>
              <Input
                id="edit-name"
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-phone">Phone (optional)</Label>
              <Input
                id="edit-phone"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+1 555 123 4567"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-status">Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm({ ...form, status: v })}
              >
                <SelectTrigger id="edit-status" className="w-full">
                  <SelectValue placeholder="Select status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="suspended">Suspended</SelectItem>
                  <SelectItem value="cancelled">Cancelled</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowEdit(false)}
                disabled={saving}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Saving...
                  </>
                ) : (
                  "Save changes"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
