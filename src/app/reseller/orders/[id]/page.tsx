"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  ArrowLeft,
  AlertCircle,
  Check,
  Clock,
  X,
  Loader2,
  User as UserIcon,
  CreditCard,
  Cpu,
  Package,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  formatDate,
  formatDateTime,
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
  paymentProvider: string | null;
  paymentReference: string | null;
  providerOrderId: string | null;
  fulfillmentStatus: string;
  financialStatus: string;
  fulfillmentExternalReference: string | null;
  failureReason: string | null;
  tenantCustomerId: string | null;
  distributionOfferId: string | null;
  createdAt: string;
  updatedAt: string;
  plan: {
    id: string;
    name: string;
    country: string | null;
    countryCode: string | null;
  } | null;
  esim: {
    id: string;
    iccid: string | null;
    status: string;
  } | null;
};

type Customer = {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
};

type TimelineStep = {
  key: string;
  label: string;
  description: string;
  state: "done" | "active" | "pending" | "failed";
};

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/tenant/orders/${id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load order");
      setOrder(data.order);
      // Best-effort fetch customer if linked
      if (data.order?.tenantCustomerId) {
        try {
          const cRes = await fetch(
            `/api/tenant/customers/${data.order.tenantCustomerId}`,
            { cache: "no-store" },
          );
          if (cRes.ok) {
            const cData = await cRes.json();
            setCustomer(cData.customer ?? null);
          }
        } catch {
          setCustomer(null);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load order");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [id]);

  const timeline = useMemo<TimelineStep[]>(() => {
    if (!order) return [];
    const s = order.status;
    const paymentOk = order.paymentStatus === "succeeded";
    const paymentFailed =
      order.paymentStatus === "failed" || s === "PAYMENT_FAILED";
    const provisioned =
      s === "ESIM_PROVISIONED" || s === "COMPLETED";
    const provisioningFailed = s === "PROVISIONING_FAILED";
    const completed = s === "COMPLETED";
    const cancelled = s === "CANCELLED";
    const refunded = s === "REFUNDED";

    return [
      {
        key: "created",
        label: "Order created",
        description: "Order placed in the system.",
        state: "done",
      },
      {
        key: "payment",
        label: "Payment confirmed",
        description: paymentFailed
          ? order.failureReason ?? "Payment failed."
          : "Payment captured successfully.",
        state: cancelled
          ? "pending"
          : paymentFailed
            ? "failed"
            : paymentOk
              ? "done"
              : "active",
      },
      {
        key: "provisioning",
        label: "Provisioning",
        description: provisioningFailed
          ? order.failureReason ?? "Provisioning failed."
          : provisioned
            ? "Service provisioned."
            : "Supplier selection + fulfillment.",
        state: cancelled || refunded
          ? "pending"
          : provisioningFailed
            ? "failed"
            : provisioned
              ? "done"
              : paymentOk
                ? "active"
                : "pending",
      },
      {
        key: "completed",
        label: "Completed",
        description: "Order fully fulfilled.",
        state: cancelled
          ? "failed"
          : refunded
            ? "pending"
            : completed
              ? "done"
              : provisioned
                ? "active"
                : "pending",
      },
    ];
  }, [order]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32 md:col-span-2" />
          <Skeleton className="h-32" />
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error || !order) {
    return (
      <div className="space-y-4">
        <Link
          href="/reseller/orders"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Back to orders
        </Link>
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load order</AlertTitle>
          <AlertDescription>{error ?? "Order not found."}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Link
        href="/reseller/orders"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Back to orders
      </Link>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight font-mono">
            #{order.id.slice(-10)}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Created {formatDateTime(order.createdAt)}
          </p>
        </div>
        <Badge className={statusColor(order.status)}>
          {prettifyStatus(order.status)}
        </Badge>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {/* Order info */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Order details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <Detail
                label="Amount"
                value={formatPrice(order.amount, order.currency)}
                strong
              />
              <Detail
                label="Plan"
                value={order.plan?.name ?? "—"}
              />
              <Detail
                label="Payment status"
                value={
                  <Badge variant="outline" className={statusColor(order.paymentStatus)}>
                    {prettifyStatus(order.paymentStatus)}
                  </Badge>
                }
              />
              <Detail
                label="Payment provider"
                value={order.paymentProvider ?? "—"}
              />
              <Detail
                label="Payment reference"
                value={
                  order.paymentReference ? (
                    <span className="font-mono text-xs">
                      {order.paymentReference.slice(-16)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Detail
                label="Provider order"
                value={
                  order.providerOrderId ? (
                    <span className="font-mono text-xs">
                      {order.providerOrderId.slice(-16)}
                    </span>
                  ) : (
                    "—"
                  )
                }
              />
              <Detail
                label="Created"
                value={formatDate(order.createdAt)}
              />
              <Detail
                label="Last updated"
                value={formatDate(order.updatedAt)}
              />
            </div>

            {order.failureReason && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>Failure reason</AlertTitle>
                <AlertDescription>{order.failureReason}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>

        {/* Customer */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Customer</CardTitle>
          </CardHeader>
          <CardContent>
            {customer ? (
              <div className="space-y-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted">
                    <UserIcon className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium truncate">{customer.name}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {customer.email}
                    </p>
                    {customer.phone && (
                      <p className="text-xs text-muted-foreground">
                        {customer.phone}
                      </p>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  asChild
                >
                  <Link href={`/reseller/customers/${customer.id}`}>
                    View customer
                  </Link>
                </Button>
              </div>
            ) : order.tenantCustomerId ? (
              <p className="text-sm text-muted-foreground">
                Customer record unavailable.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No customer linked to this order.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Statuses + timeline */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-1.5">
              <CreditCard className="h-3.5 w-3.5" />
              Payment
            </CardDescription>
            <CardTitle className="text-base">
              <Badge variant="outline" className={statusColor(order.paymentStatus)}>
                {prettifyStatus(order.paymentStatus)}
              </Badge>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5" />
              Fulfillment
            </CardDescription>
            <CardTitle className="text-base">
              <Badge variant="outline" className={statusColor(order.fulfillmentStatus)}>
                {prettifyStatus(order.fulfillmentStatus)}
              </Badge>
            </CardTitle>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardDescription className="flex items-center gap-1.5">
              <Package className="h-3.5 w-3.5" />
              Financial
            </CardDescription>
            <CardTitle className="text-base">
              <Badge variant="outline" className={statusColor(order.financialStatus)}>
                {prettifyStatus(order.financialStatus)}
              </Badge>
            </CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Timeline */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Timeline</CardTitle>
          <CardDescription>Order lifecycle progress.</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="relative space-y-6">
            {timeline.map((step, i) => (
              <li key={step.key} className="relative flex gap-4">
                {i < timeline.length - 1 && (
                  <div
                    className={`absolute left-[14px] top-7 bottom-[-24px] w-px ${
                      step.state === "done" ? "bg-emerald-500/50" : "bg-border"
                    }`}
                  />
                )}
                <div className="relative z-10">
                  <TimelineIcon state={step.state} />
                </div>
                <div className="pt-0.5 pb-1">
                  <p className="font-medium text-sm">{step.label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {step.description}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </CardContent>
      </Card>

      {/* eSIM card if provisioned */}
      {order.esim && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Provisioned service</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-4">
              <Detail label="eSIM ID" value={
                <span className="font-mono text-xs">{order.esim.id.slice(-10)}</span>
              } />
              <Detail
                label="ICCID"
                value={
                  order.esim.iccid ? (
                    <span className="font-mono text-xs">{order.esim.iccid}</span>
                  ) : (
                    "—"
                  )
                }
              />
              <Detail
                label="Service status"
                value={
                  <Badge variant="outline" className={statusColor(order.esim.status)}>
                    {prettifyStatus(order.esim.status)}
                  </Badge>
                }
              />
              {order.fulfillmentExternalReference && (
                <Detail
                  label="External ref"
                  value={
                    <span className="font-mono text-xs">
                      {order.fulfillmentExternalReference.slice(-16)}
                    </span>
                  }
                />
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Detail({
  label,
  value,
  strong,
}: {
  label: string;
  value: React.ReactNode;
  strong?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`mt-0.5 ${strong ? "text-lg font-semibold" : "text-sm"}`}>
        {value}
      </p>
    </div>
  );
}

function TimelineIcon({ state }: { state: TimelineStep["state"] }) {
  if (state === "done") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-600 text-white">
        <Check className="h-4 w-4" />
      </div>
    );
  }
  if (state === "active") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
    );
  }
  if (state === "failed") {
    return (
      <div className="flex h-7 w-7 items-center justify-center rounded-full bg-destructive text-white">
        <X className="h-4 w-4" />
      </div>
    );
  }
  return (
    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-muted-foreground border">
      <Clock className="h-3.5 w-3.5" />
    </div>
  );
}
