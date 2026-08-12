"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ShoppingBag,
  Plus,
  Search,
  AlertCircle,
  ArrowRight,
  Loader2,
  Check,
  ChevronLeft,
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
import {
  countryFlag,
  formatDataSize,
  formatDate,
  formatPrice,
  statusColor,
  prettifyStatus,
} from "@/lib/format";

type Order = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  financialStatus: string;
  createdAt: string;
  tenantCustomerId: string | null;
  plan: { id: string; name: string; country: string; countryCode: string | null } | null;
};

type Customer = {
  id: string;
  name: string;
  email: string;
  status: string;
};

type Product = {
  id: string;
  name: string;
  productType: string;
  countryCode: string | null;
  dataAmount: number | null;
  validityDays: number | null;
  wholesalePriceMinor: number;
  distributionOffer: {
    id: string;
    retailPrice: number;
    status: string;
    audience: string;
  } | null;
};

type CreateStep = "customer" | "offer" | "confirm";

export default function OrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");

  // Create-order dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [step, setStep] = useState<CreateStep>("customer");
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [selectedCustomerId, setSelectedCustomerId] = useState<string>("");
  const [selectedOfferId, setSelectedOfferId] = useState<string>("");

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/orders", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load orders");
      setOrders(data.orders ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load orders");
      setOrders([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const filtered = useMemo(() => {
    if (!orders) return [];
    const q = search.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter !== "all" && o.status !== statusFilter) return false;
      if (!q) return true;
      return (
        o.id.toLowerCase().includes(q) ||
        (o.plan?.name ?? "").toLowerCase().includes(q)
      );
    });
  }, [orders, search, statusFilter]);

  async function openCreateDialog() {
    setShowCreate(true);
    setStep("customer");
    setSelectedCustomerId("");
    setSelectedOfferId("");
    setDialogError(null);
    setCustomersLoading(true);
    setCatalogLoading(true);
    try {
      const [custRes, catRes] = await Promise.all([
        fetch("/api/tenant/customers", { cache: "no-store" }),
        fetch("/api/tenant/catalog", { cache: "no-store" }),
      ]);
      const custData = await custRes.json();
      const catData = await catRes.json();
      if (custRes.ok) {
        setCustomers(
          (custData.customers ?? []).filter((c: Customer) => c.status === "active"),
        );
      }
      if (catRes.ok) {
        setProducts(
          (catData.products ?? []).filter(
            (p: Product) => p.distributionOffer?.status === "active",
          ),
        );
      }
    } finally {
      setCustomersLoading(false);
      setCatalogLoading(false);
    }
  }

  const selectedCustomer = customers.find((c) => c.id === selectedCustomerId);
  const selectedProduct = products.find(
    (p) => p.distributionOffer?.id === selectedOfferId,
  );

  async function handleCreateOrder() {
    if (!selectedCustomerId || !selectedOfferId) return;
    setDialogError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/tenant/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenantCustomerId: selectedCustomerId,
          distributionOfferId: selectedOfferId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to create order");
      setShowCreate(false);
      await load();
      if (data.order?.id) {
        router.push(`/reseller/orders/${data.order.id}`);
      }
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "Failed to create order");
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Orders</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Orders placed for your customers through your distribution offers.
          </p>
        </div>
        <Button onClick={openCreateDialog} className="gap-2">
          <Plus className="h-4 w-4" />
          Create Order
        </Button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by order id or plan..."
            className="pl-9"
          />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-full sm:w-52">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="PLAN_SELECTED">Plan selected</SelectItem>
            <SelectItem value="PAYMENT_PENDING">Payment pending</SelectItem>
            <SelectItem value="PAYMENT_CONFIRMED">Payment confirmed</SelectItem>
            <SelectItem value="ESIM_PROVISIONING">Provisioning</SelectItem>
            <SelectItem value="ESIM_PROVISIONED">Provisioned</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="PAYMENT_FAILED">Payment failed</SelectItem>
            <SelectItem value="PROVISIONING_FAILED">Provisioning failed</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
            <SelectItem value="REFUNDED">Refunded</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : orders === null ? (
        <OrdersSkeleton />
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <ShoppingBag className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="mt-4 font-medium">
              {orders.length === 0 ? "No orders yet" : "No matching orders"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {orders.length === 0
                ? "Create your first order for a customer to get started."
                : "Try adjusting your search or status filter."}
            </p>
            {orders.length === 0 && (
              <Button onClick={openCreateDialog} className="mt-4 gap-2">
                <Plus className="h-4 w-4" />
                Create Order
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {filtered.length} order{filtered.length === 1 ? "" : "s"}
            </CardTitle>
            <CardDescription>Click a row to view order details.</CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Order</TableHead>
                  <TableHead className="hidden md:table-cell">Plan</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="hidden sm:table-cell">Payment</TableHead>
                  <TableHead className="pr-6 hidden sm:table-cell">Date</TableHead>
                  <TableHead className="pr-6 w-10"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((o) => (
                  <TableRow
                    key={o.id}
                    className="cursor-pointer"
                    onClick={() => router.push(`/reseller/orders/${o.id}`)}
                  >
                    <TableCell className="pl-6 font-mono text-xs">
                      {o.id.slice(-10)}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex items-center gap-1.5">
                        {o.plan?.countryCode && (
                          <span aria-hidden>
                            {countryFlag(o.plan.countryCode)}
                          </span>
                        )}
                        <span className="truncate max-w-[200px] text-muted-foreground">
                          {o.plan?.name ?? "—"}
                        </span>
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {formatPrice(o.amount, o.currency)}
                    </TableCell>
                    <TableCell>
                      <Badge className={statusColor(o.status)}>
                        {prettifyStatus(o.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <Badge variant="outline" className={statusColor(o.paymentStatus)}>
                        {prettifyStatus(o.paymentStatus)}
                      </Badge>
                    </TableCell>
                    <TableCell className="pr-6 hidden sm:table-cell text-muted-foreground">
                      {formatDate(o.createdAt)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Create Order multi-step dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Create order</DialogTitle>
            <DialogDescription>
              {step === "customer" && "Select the customer this order is for."}
              {step === "offer" && "Choose a product from your catalog."}
              {step === "confirm" && "Review and confirm the order details."}
            </DialogDescription>
          </DialogHeader>

          {/* Stepper */}
          <div className="flex items-center gap-2 text-xs">
            <StepDot active={step === "customer"} done={step !== "customer"} label="Customer" />
            <div className="h-px flex-1 bg-border" />
            <StepDot
              active={step === "offer"}
              done={step === "confirm"}
              label="Product"
            />
            <div className="h-px flex-1 bg-border" />
            <StepDot active={step === "confirm"} done={false} label="Confirm" />
          </div>

          {dialogError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}

          {/* Step 1: Customer */}
          {step === "customer" && (
            <div className="space-y-3">
              {customersLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : customers.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No active customers available. Add a customer first.
                </div>
              ) : (
                <Select value={selectedCustomerId} onValueChange={setSelectedCustomerId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a customer..." />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={c.id}>
                        {c.name} — {c.email}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </Button>
                <Button
                  disabled={!selectedCustomerId}
                  onClick={() => setStep("offer")}
                >
                  Next
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* Step 2: Offer */}
          {step === "offer" && (
            <div className="space-y-3">
              {catalogLoading ? (
                <div className="flex items-center justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : products.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  No products enabled in your catalog. Enable products in the catalog
                  page first.
                </div>
              ) : (
                <Select value={selectedOfferId} onValueChange={setSelectedOfferId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a product..." />
                  </SelectTrigger>
                  <SelectContent>
                    {products.map((p) => (
                      <SelectItem
                        key={p.distributionOffer!.id}
                        value={p.distributionOffer!.id}
                      >
                        {p.name} — {formatPrice(p.distributionOffer!.retailPrice)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <DialogFooter>
                <Button variant="outline" onClick={() => setStep("customer")}>
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button
                  disabled={!selectedOfferId}
                  onClick={() => setStep("confirm")}
                >
                  Next
                </Button>
              </DialogFooter>
            </div>
          )}

          {/* Step 3: Confirm */}
          {step === "confirm" && selectedCustomer && selectedProduct && (
            <div className="space-y-4">
              <div className="space-y-3">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs text-muted-foreground">Customer</p>
                    <p className="font-medium">{selectedCustomer.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {selectedCustomer.email}
                    </p>
                  </div>
                </div>
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs text-muted-foreground">Product</p>
                    <p className="font-medium">{selectedProduct.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {prettifyStatus(selectedProduct.productType)}
                      {selectedProduct.countryCode &&
                        ` · ${countryFlag(selectedProduct.countryCode)} ${selectedProduct.countryCode}`}
                      {typeof selectedProduct.dataAmount === "number" &&
                        selectedProduct.dataAmount > 0 &&
                        ` · ${formatDataSize(selectedProduct.dataAmount)}`}
                      {selectedProduct.validityDays &&
                        ` · ${selectedProduct.validityDays}d`}
                    </p>
                  </div>
                </div>
                <div className="flex justify-between items-center border-t pt-3">
                  <span className="text-sm text-muted-foreground">Amount</span>
                  <span className="text-lg font-semibold">
                    {formatPrice(selectedProduct.distributionOffer!.retailPrice)}
                  </span>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The order will be created and auto-confirmed with mock payment. The
                underlying RoamLink pipeline handles supplier selection and fulfillment.
              </p>
              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setStep("offer")}
                  disabled={creating}
                >
                  <ChevronLeft className="h-4 w-4" />
                  Back
                </Button>
                <Button onClick={handleCreateOrder} disabled={creating}>
                  {creating ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Creating...
                    </>
                  ) : (
                    "Create order"
                  )}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function StepDot({
  active,
  done,
  label,
}: {
  active: boolean;
  done: boolean;
  label: string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div
        className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
          done
            ? "bg-emerald-600 text-white"
            : active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground"
        }`}
      >
        {done ? <Check className="h-3 w-3" /> : label.charAt(0)}
      </div>
      <span
        className={
          active
            ? "text-foreground font-medium"
            : "text-muted-foreground"
        }
      >
        {label}
      </span>
    </div>
  );
}

function OrdersSkeleton() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-5 w-32" />
        <Skeleton className="h-4 w-48" />
      </CardHeader>
      <CardContent className="p-0">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="flex items-center gap-4 border-b px-6 py-3">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-5 flex-1 max-w-[200px]" />
            <Skeleton className="h-5 w-16" />
            <Skeleton className="h-5 w-24" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
