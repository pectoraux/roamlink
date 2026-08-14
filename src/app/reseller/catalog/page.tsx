"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Package,
  Search,
  AlertCircle,
  Loader2,
  Globe,
  PlusCircle,
  Power,
  CheckCircle2,
  TrendingUp,
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
  formatPrice,
  statusColor,
  prettifyStatus,
} from "@/lib/format";

type DistributionOffer = {
  id: string;
  retailPrice: number;
  status: string;
  audience: string;
};

type Product = {
  id: string;
  name: string;
  productType: string;
  countryCode: string | null;
  region: string | null;
  dataAmount: number | null;
  validityDays: number | null;
  wholesalePriceMinor: number;
  supplierCount: number;
  distributionOffer: DistributionOffer | null;
};

export default function CatalogPage() {
  const [products, setProducts] = useState<Product[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");

  // Enable dialog state
  const [enableProduct, setEnableProduct] = useState<Product | null>(null);
  const [retailInput, setRetailInput] = useState("");
  const [audience, setAudience] = useState("B2C");
  const [saving, setSaving] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // Disable confirmation
  const [disableOffer, setDisableOffer] = useState<{
    product: Product;
    offer: DistributionOffer;
  } | null>(null);
  const [disabling, setDisabling] = useState(false);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/catalog", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load catalog");
      setProducts(data.products ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load catalog");
      setProducts([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const productTypes = useMemo(() => {
    if (!products) return [];
    return Array.from(new Set(products.map((p) => p.productType).filter(Boolean)));
  }, [products]);

  const filteredProducts = useMemo(() => {
    if (!products) return [];
    const q = search.trim().toLowerCase();
    return products.filter((p) => {
      if (typeFilter !== "all" && p.productType !== typeFilter) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.countryCode ?? "").toLowerCase().includes(q) ||
        (p.region ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, search, typeFilter]);

  // Products without an active distribution offer (available to enable)
  const available = filteredProducts.filter(
    (p) => !p.distributionOffer || p.distributionOffer.status !== "active",
  );
  // Products with an active distribution offer (the reseller's catalog)
  const enabled = filteredProducts.filter(
    (p) => p.distributionOffer && p.distributionOffer.status === "active",
  );

  function openEnable(product: Product) {
    setEnableProduct(product);
    setRetailInput(((product.wholesalePriceMinor || 0) / 100 * 1.2).toFixed(2));
    setAudience("B2C");
    setDialogError(null);
  }

  async function handleEnable(e: React.FormEvent) {
    e.preventDefault();
    if (!enableProduct) return;
    setDialogError(null);
    const dollars = parseFloat(retailInput);
    if (isNaN(dollars) || dollars <= 0) {
      setDialogError("Please enter a valid retail price.");
      return;
    }
    const retailPriceMinor = Math.round(dollars * 100);
    setSaving(true);
    try {
      const res = await fetch("/api/tenant/catalog", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: enableProduct.id,
          retailPriceMinor,
          audience,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to enable product");
      setEnableProduct(null);
      await load();
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "Failed to enable product");
    } finally {
      setSaving(false);
    }
  }

  async function handleDisable() {
    if (!disableOffer) return;
    setDisabling(true);
    try {
      const res = await fetch(`/api/tenant/catalog/${disableOffer.offer.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "disable" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to disable product");
      setDisableOffer(null);
      await load();
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : "Failed to disable product");
    } finally {
      setDisabling(false);
    }
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load catalog</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (products === null) {
    return (
      <div className="space-y-6">
        <PageHeader />
        <Skeleton className="h-10 w-full max-w-md" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, country, or region..."
            className="pl-9"
          />
        </div>
        {productTypes.length > 0 && (
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-full sm:w-48">
              <SelectValue placeholder="Product type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {productTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {prettifyStatus(t)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Enabled catalog */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            <CardTitle className="text-base">Your Catalog</CardTitle>
            <Badge variant="secondary">{enabled.length}</Badge>
          </div>
          <CardDescription>
            Products you currently sell to your customers, with your retail price and margin.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {enabled.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Package className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium text-sm">No products enabled</p>
              <p className="text-sm text-muted-foreground mt-1">
                Enable products from the available catalog below to start selling.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Product</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead className="hidden lg:table-cell">Data</TableHead>
                  <TableHead className="hidden lg:table-cell">Validity</TableHead>
                  <TableHead>Wholesale</TableHead>
                  <TableHead>Retail</TableHead>
                  <TableHead>Margin</TableHead>
                  <TableHead className="pr-6"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {enabled.map((p) => {
                  const retail = p.distributionOffer!.retailPrice;
                  const margin = retail - p.wholesalePriceMinor;
                  const marginPct =
                    retail > 0 ? Math.round((margin / retail) * 1000) / 10 : 0;
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-2">
                          {p.countryCode && (
                            <span aria-hidden>{countryFlag(p.countryCode)}</span>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground md:hidden">
                              {prettifyStatus(p.productType)}
                            </p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {prettifyStatus(p.productType)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {typeof p.dataAmount === "number" && p.dataAmount > 0
                          ? formatDataSize(p.dataAmount)
                          : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {p.validityDays ? `${p.validityDays} days` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatPrice(p.wholesalePriceMinor)}
                      </TableCell>
                      <TableCell className="font-medium">
                        {formatPrice(retail)}
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="font-medium text-emerald-700 dark:text-emerald-400">
                            {formatPrice(margin)}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {marginPct}%
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive"
                          onClick={() =>
                            setDisableOffer({
                              product: p,
                              offer: p.distributionOffer!,
                            })
                          }
                        >
                          <Power className="h-4 w-4" />
                          <span className="hidden sm:inline">Disable</span>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Available products */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Available Products</CardTitle>
            <Badge variant="secondary">{available.length}</Badge>
          </div>
          <CardDescription>
            The full connectivity catalog. Enable a product to set your retail price and
            add it to your catalog.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {available.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted">
                <Globe className="h-5 w-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium text-sm">
                {products.length === 0
                  ? "No products available"
                  : "All products are already in your catalog"}
              </p>
              <p className="text-sm text-muted-foreground mt-1">
                {products.length === 0
                  ? "New products will appear here when suppliers publish them."
                  : "Check back later for new products from suppliers."}
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Product</TableHead>
                  <TableHead className="hidden md:table-cell">Type</TableHead>
                  <TableHead className="hidden lg:table-cell">Data</TableHead>
                  <TableHead className="hidden lg:table-cell">Validity</TableHead>
                  <TableHead>Wholesale</TableHead>
                  <TableHead className="hidden md:table-cell">Suggested Retail</TableHead>
                  <TableHead className="pr-6"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {available.map((p) => {
                  const suggested = Math.ceil(
                    ((p.wholesalePriceMinor || 0) * 1.2) / 100,
                  ) * 100; // +20%, rounded up to nearest dollar
                  const previouslyDisabled = p.distributionOffer?.status === "inactive";
                  return (
                    <TableRow key={p.id}>
                      <TableCell className="pl-6">
                        <div className="flex items-center gap-2">
                          {p.countryCode && (
                            <span aria-hidden>{countryFlag(p.countryCode)}</span>
                          )}
                          <div className="min-w-0">
                            <p className="font-medium truncate">{p.name}</p>
                            <p className="text-xs text-muted-foreground md:hidden">
                              {prettifyStatus(p.productType)}
                            </p>
                            {previouslyDisabled && (
                              <Badge variant="outline" className="mt-1 text-xs">
                                Disabled
                              </Badge>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {prettifyStatus(p.productType)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {typeof p.dataAmount === "number" && p.dataAmount > 0
                          ? formatDataSize(p.dataAmount)
                          : "—"}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {p.validityDays ? `${p.validityDays} days` : "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatPrice(p.wholesalePriceMinor)}
                        <p className="text-xs text-muted-foreground">
                          {p.supplierCount} supplier{p.supplierCount === 1 ? "" : "s"}
                        </p>
                      </TableCell>
                      <TableCell className="hidden md:table-cell">
                        <span className="text-muted-foreground">
                          {formatPrice(suggested)}
                        </span>
                        <p className="text-xs text-muted-foreground">+20% margin</p>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          className="gap-1"
                          onClick={() => openEnable(p)}
                        >
                          <PlusCircle className="h-4 w-4" />
                          Enable
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Enable Dialog */}
      <Dialog
        open={!!enableProduct}
        onOpenChange={(o) => !o && setEnableProduct(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable product</DialogTitle>
            <DialogDescription>
              Set the retail price your customers will pay for{" "}
              <span className="font-medium text-foreground">{enableProduct?.name}</span>.
            </DialogDescription>
          </DialogHeader>
          {enableProduct && (
            <form onSubmit={handleEnable} className="space-y-4">
              {dialogError && (
                <Alert variant="destructive">
                  <AlertCircle className="h-4 w-4" />
                  <AlertDescription>{dialogError}</AlertDescription>
                </Alert>
              )}

              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-md bg-muted p-3">
                  <p className="text-xs text-muted-foreground">Wholesale cost</p>
                  <p className="font-medium">
                    {formatPrice(enableProduct.wholesalePriceMinor)}
                  </p>
                </div>
                <div className="rounded-md bg-muted p-3">
                  <p className="text-xs text-muted-foreground">Suggested retail</p>
                  <p className="font-medium">
                    {formatPrice(
                      Math.ceil((enableProduct.wholesalePriceMinor * 1.2) / 100) * 100,
                    )}
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="retail">Retail price (USD)</Label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                    $
                  </span>
                  <Input
                    id="retail"
                    type="number"
                    step="0.01"
                    min="0"
                    value={retailInput}
                    onChange={(e) => setRetailInput(e.target.value)}
                    className="pl-7"
                    autoFocus
                  />
                </div>
                {retailInput &&
                  !isNaN(parseFloat(retailInput)) &&
                  enableProduct.wholesalePriceMinor > 0 && (
                    <p className="text-xs flex items-center gap-1 text-muted-foreground">
                      <TrendingUp className="h-3 w-3" />
                      Margin:{" "}
                      <span className="font-medium text-foreground">
                        {formatPrice(
                          Math.round(parseFloat(retailInput) * 100) -
                            enableProduct.wholesalePriceMinor,
                        )}
                      </span>{" "}
                      (
                      {Math.round(
                        ((parseFloat(retailInput) * 100 -
                          enableProduct.wholesalePriceMinor) /
                          (parseFloat(retailInput) * 100)) *
                          1000,
                      ) / 10}
                      %)
                    </p>
                  )}
              </div>

              <div className="space-y-2">
                <Label htmlFor="audience">Audience</Label>
                <Select value={audience} onValueChange={setAudience}>
                  <SelectTrigger id="audience" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="B2C">B2C (consumer)</SelectItem>
                    <SelectItem value="B2B">B2B (corporate)</SelectItem>
                    <SelectItem value="B2C_AND_B2B">Both</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setEnableProduct(null)}
                  disabled={saving}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={saving}>
                  {saving ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Enabling...
                    </>
                  ) : (
                    "Enable product"
                  )}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      {/* Disable confirmation */}
      <Dialog
        open={!!disableOffer}
        onOpenChange={(o) => !o && setDisableOffer(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable product?</DialogTitle>
            <DialogDescription>
              This will remove{" "}
              <span className="font-medium text-foreground">
                {disableOffer?.product.name}
              </span>{" "}
              from your catalog. New orders can no longer be placed for this product.
              Existing orders are unaffected.
            </DialogDescription>
          </DialogHeader>
          {dialogError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{dialogError}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDisableOffer(null)}
              disabled={disabling}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDisable}
              disabled={disabling}
            >
              {disabling ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Disabling...
                </>
              ) : (
                "Disable product"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PageHeader() {
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight">Catalog</h1>
      <p className="text-sm text-muted-foreground mt-1">
        Browse the connectivity catalog and set your retail prices. Wholesale cost is
        shown for margin calculation only.
      </p>
    </div>
  );
}
