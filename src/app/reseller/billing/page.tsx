"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CreditCard,
  AlertCircle,
  Loader2,
  Key,
  Plus,
  Copy,
  Check,
  Trash2,
  TrendingUp,
  Users,
  ShoppingBag,
  UserCog,
  Receipt,
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

type BillingData = {
  entitlements: {
    saaasPlanName: string;
    monthlyPriceMinor: number;
    includedStaff: number;
    includedCustomers: number;
    includedOrdersPerMonth: number;
    platformFeePercent: number;
    perOrderFeeMinor: number;
    features: string[];
    subscriptionStatus: string;
    currentPeriodEnd: string;
  };
  subscription: {
    id: string;
    status: string;
    billingCycle: string;
    currentPeriodEnd: string;
    plan: {
      id: string;
      name: string;
      displayName: string;
      monthlyPriceMinor: number;
      currency: string;
    };
  } | null;
  usage: {
    ordersThisMonth: number;
    customers: number;
    staff: number;
    includedOrdersPerMonth: number;
    includedCustomers: number;
    includedStaff: number;
  };
  billing: {
    totalOrderVolumeMinor: number;
    platformFeeMinor: number;
    platformFeePercent: number;
    perOrderFeeMinor: number;
    saasMonthlyPriceMinor: number;
  };
};

type ApiKey = {
  id: string;
  name: string;
  prefix: string;
  scopes: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
};

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [keysError, setKeysError] = useState<string | null>(null);

  // Create key dialog
  const [showCreate, setShowCreate] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [keyScope, setKeyScope] = useState("read");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // New key display
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Remove key confirmation
  const [removeKey, setRemoveKey] = useState<ApiKey | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function loadBilling() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/billing", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed to load billing");
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load billing");
    }
  }

  async function loadKeys() {
    setKeysError(null);
    try {
      const res = await fetch("/api/tenant/api-keys", { cache: "no-store" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed to load API keys");
      setKeys(d.keys ?? []);
    } catch (e) {
      setKeysError(e instanceof Error ? e.message : "Failed to load API keys");
      setKeys([]);
    }
  }

  useEffect(() => {
    loadBilling();
    loadKeys();
  }, []);

  async function handleCreateKey(e: React.FormEvent) {
    e.preventDefault();
    setCreateError(null);
    if (!keyName.trim()) {
      setCreateError("A name is required for the API key.");
      return;
    }
    setCreating(true);
    try {
      const res = await fetch("/api/tenant/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: keyName.trim(),
          scopes: [keyScope],
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed to create key");
      setShowCreate(false);
      setNewKey(d.key);
      setKeyName("");
      setKeyScope("read");
      await loadKeys();
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Failed to create key");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!removeKey) return;
    setRemoveError(null);
    setRemoving(true);
    try {
      const res = await fetch(`/api/tenant/api-keys/${removeKey.id}`, {
        method: "DELETE",
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.error ?? "Failed to revoke key");
      setRemoveKey(null);
      await loadKeys();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Failed to revoke key");
    } finally {
      setRemoving(false);
    }
  }

  function copyKey() {
    if (!newKey) return;
    navigator.clipboard.writeText(newKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const parsedScopes = (raw: string): string[] => {
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v : [String(v)];
    } catch {
      return raw ? [raw] : [];
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Billing</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your SaaS plan, usage, fees, and API keys.
        </p>
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load billing</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : !data ? (
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-48 md:col-span-2" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
          <Skeleton className="h-64 md:col-span-3" />
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {/* Current plan */}
            <Card className="md:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <CreditCard className="h-4 w-4 text-muted-foreground" />
                    Current plan
                  </CardTitle>
                  {data.subscription ? (
                    <Badge className={statusColor(data.subscription.status)}>
                      {prettifyStatus(data.subscription.status)}
                    </Badge>
                  ) : (
                    <Badge variant="outline">No subscription</Badge>
                  )}
                </div>
                <CardDescription>
                  Your SaaS subscription tier and renewal date.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-end justify-between">
                  <div>
                    <p className="text-3xl font-bold capitalize">
                      {data.subscription?.plan.displayName ??
                        data.entitlements.saaasPlanName}
                    </p>
                    <p className="text-sm text-muted-foreground mt-1">
                      {formatPrice(data.entitlements.monthlyPriceMinor)}
                      /mo ·{" "}
                      {data.subscription?.billingCycle ?? "monthly"} billing
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">Renewal date</p>
                    <p className="text-sm font-medium mt-0.5">
                      {formatDate(data.entitlements.currentPeriodEnd)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Platform fee</p>
                    <p className="text-sm font-medium mt-0.5">
                      {data.entitlements.platformFeePercent}% per order
                      {data.entitlements.perOrderFeeMinor > 0 && (
                        <span className="text-muted-foreground">
                          {" "}+ {formatPrice(data.entitlements.perOrderFeeMinor)}
                        </span>
                      )}
                    </p>
                  </div>
                </div>
                {data.entitlements.features.length > 0 && (
                  <div className="pt-2 border-t">
                    <p className="text-xs text-muted-foreground mb-2">
                      Included features
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {data.entitlements.features.map((f) => (
                        <Badge key={f} variant="secondary" className="text-xs">
                          {prettifyStatus(f)}
                        </Badge>
                      ))}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Reseller Balance card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <CreditCard className="h-4 w-4 text-muted-foreground" />
                  Reseller Balance
                </CardTitle>
                <CardDescription>
                  Prepaid funds for connectivity purchases
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <p className="text-2xl font-bold">
                    {formatPrice(data.billing?.balanceMinor ?? 0)}
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">
                    Current available balance
                  </p>
                </div>
                <div className="grid grid-cols-2 gap-4 pt-2 border-t">
                  <div>
                    <p className="text-xs text-muted-foreground">Total deposited</p>
                    <p className="text-sm font-medium mt-0.5">
                      {formatPrice(data.billing?.totalDepositedMinor ?? 0)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Total spent</p>
                    <p className="text-sm font-medium mt-0.5">
                      {formatPrice(data.billing?.totalSpentMinor ?? 0)}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={async () => {
                    const amount = prompt("Enter deposit amount in cents (e.g. 10000 = $100.00):");
                    if (!amount) return;
                    const amountMinor = parseInt(amount, 10);
                    if (isNaN(amountMinor) || amountMinor <= 0) {
                      alert("Please enter a valid positive amount in cents");
                      return;
                    }
                    const key = `deposit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                    try {
                      const res = await fetch("/api/tenant/balance/deposit", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ amountMinor, idempotencyKey: key }),
                      });
                      if (res.ok) {
                        const result = await res.json();
                        alert(`Deposited ${formatPrice(amountMinor)}. New balance: ${formatPrice(result.balanceMinor)}`);
                        window.location.reload();
                      } else {
                        const err = await res.json();
                        alert(`Error: ${err.error ?? "Deposit failed"}`);
                      }
                    } catch (e) {
                      alert("Network error");
                    }
                  }}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Funds
                </Button>
              </CardContent>
            </Card>

            {/* Usage card */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                  Usage this period
                </CardTitle>
                <CardDescription>
                  Resets on {formatDate(data.entitlements.currentPeriodEnd)}.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <UsageBar
                  icon={ShoppingBag}
                  label="Orders"
                  used={data.usage.ordersThisMonth}
                  included={data.usage.includedOrdersPerMonth}
                />
                <UsageBar
                  icon={Users}
                  label="Customers"
                  used={data.usage.customers}
                  included={data.usage.includedCustomers}
                />
                <UsageBar
                  icon={UserCog}
                  label="Staff"
                  used={data.usage.staff}
                  included={data.usage.includedStaff}
                />
              </CardContent>
            </Card>
          </div>

          {/* Fee breakdown */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Receipt className="h-4 w-4 text-muted-foreground" />
                Fee breakdown
              </CardTitle>
              <CardDescription>
                Fees incurred this billing period based on order volume.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-4">
                <FeeStat
                  label="Order volume"
                  value={formatPrice(data.billing.totalOrderVolumeMinor)}
                  hint="This month"
                />
                <FeeStat
                  label="Platform fee"
                  value={formatPrice(data.billing.platformFeeMinor)}
                  hint={`${data.billing.platformFeePercent}% of volume`}
                />
                <FeeStat
                  label="Per-order fees"
                  value={formatPrice(data.billing.perOrderFeeMinor * data.usage.ordersThisMonth)}
                  hint={`${formatPrice(data.billing.perOrderFeeMinor)} × ${data.usage.ordersThisMonth} orders`}
                />
                <FeeStat
                  label="SaaS subscription"
                  value={formatPrice(data.billing.saasMonthlyPriceMinor)}
                  hint="Monthly base"
                />
              </div>
              <div className="mt-4 rounded-md bg-muted p-4 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">
                    Estimated total this month
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Subscription + platform + per-order fees
                  </p>
                </div>
                <p className="text-lg font-semibold">
                  {formatPrice(
                    data.billing.saasMonthlyPriceMinor +
                      data.billing.platformFeeMinor +
                      data.billing.perOrderFeeMinor * data.usage.ordersThisMonth,
                  )}
                </p>
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {/* API Keys */}
      <Card>
        <CardHeader>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Key className="h-4 w-4 text-muted-foreground" />
                API keys
              </CardTitle>
              <CardDescription className="mt-1.5">
                Use API keys to access the tenant API programmatically. Keys are shown
                only once at creation.
              </CardDescription>
            </div>
            <Button onClick={() => setShowCreate(true)} className="gap-2 self-start">
              <Plus className="h-4 w-4" />
              Create key
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {keysError ? (
            <div className="p-6">
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{keysError}</AlertDescription>
              </Alert>
            </div>
          ) : keys === null ? (
            <div className="p-6 space-y-2">
              {[...Array(2)].map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : keys.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Key className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium text-sm">No API keys</p>
              <p className="text-sm text-muted-foreground mt-1">
                Create an API key to start using the tenant API.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Name</TableHead>
                  <TableHead>Prefix</TableHead>
                  <TableHead className="hidden md:table-cell">Scopes</TableHead>
                  <TableHead className="hidden sm:table-cell">Last used</TableHead>
                  <TableHead className="hidden sm:table-cell">Created</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {keys.map((k) => (
                  <TableRow key={k.id}>
                    <TableCell className="pl-6 font-medium">{k.name}</TableCell>
                    <TableCell>
                      <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                        {k.prefix}…
                      </span>
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      <div className="flex flex-wrap gap-1">
                        {parsedScopes(k.scopes).map((s) => (
                          <Badge key={s} variant="secondary" className="text-xs">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">
                      {k.lastUsedAt ? formatDate(k.lastUsedAt) : "Never"}
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground text-xs">
                      {formatDate(k.createdAt)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-destructive hover:text-destructive"
                        onClick={() => setRemoveKey(k)}
                        title="Revoke key"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Create API Key Dialog */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API key</DialogTitle>
            <DialogDescription>
              Choose a name to identify this key. The raw key will be shown only once
              after creation — copy and store it securely.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleCreateKey} className="space-y-4">
            {createError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{createError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="key-name">Key name</Label>
              <Input
                id="key-name"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="Production backend"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="key-scope">Scope</Label>
              <Select value={keyScope} onValueChange={setKeyScope}>
                <SelectTrigger id="key-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">read</SelectItem>
                  <SelectItem value="write">write</SelectItem>
                  <SelectItem value="read,write">read,write</SelectItem>
                  <SelectItem value="admin">admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(false)}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating}>
                {creating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creating...
                  </>
                ) : (
                  "Create key"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* New Key Display Dialog */}
      <Dialog open={!!newKey} onOpenChange={(o) => !o && setNewKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>API key created</DialogTitle>
            <DialogDescription>
              Copy your new API key now. For security, it will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <Alert>
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>
              Store this key securely. Treat it like a password — anyone with this key
              can access your tenant API.
            </AlertDescription>
          </Alert>
          <div className="rounded-md border bg-muted p-3 flex items-center gap-2">
            <code className="flex-1 text-xs font-mono break-all">{newKey}</code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={copyKey}
            >
              {copied ? (
                <Check className="h-4 w-4 text-emerald-600" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
            </Button>
          </div>
          <DialogFooter>
            <Button onClick={() => setNewKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Key Confirmation */}
      <Dialog open={!!removeKey} onOpenChange={(o) => !o && setRemoveKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke API key?</DialogTitle>
            <DialogDescription>
              The key{" "}
              <span className="font-medium text-foreground">{removeKey?.name}</span>{" "}
              will be permanently revoked. Any integrations using this key will stop
              working immediately.
            </DialogDescription>
          </DialogHeader>
          {removeError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveKey(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleRevoke} disabled={removing}>
              {removing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Revoking...
                </>
              ) : (
                "Revoke key"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function UsageBar({
  icon: Icon,
  label,
  used,
  included,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  used: number;
  included: number;
}) {
  const pct =
    included > 0 && included !== 999999
      ? Math.min((used / included) * 100, 100)
      : 0;
  const isNearLimit = pct >= 80;
  const unlimited = included === 999999;
  return (
    <div>
      <div className="flex justify-between text-sm mb-1">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <Icon className="h-3.5 w-3.5" />
          {label}
        </span>
        <span className={isNearLimit ? "text-orange-600 font-medium" : ""}>
          {used} / {unlimited ? "∞" : included}
        </span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        {!unlimited && (
          <div
            className={`h-full rounded-full transition-all ${isNearLimit ? "bg-orange-500" : "bg-primary"}`}
            style={{ width: `${pct}%` }}
          />
        )}
      </div>
    </div>
  );
}

function FeeStat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="rounded-md border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-lg font-semibold mt-1">{value}</p>
      <p className="text-xs text-muted-foreground mt-0.5">{hint}</p>
    </div>
  );
}
