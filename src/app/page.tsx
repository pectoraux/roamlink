/**
 * Phase 3 — Reseller Portal (root page)
 *
 * This is the main UI for the B2B reseller SaaS. It replaces the old B2C
 * eSIM marketplace landing page. The portal shows:
 *   - Product catalog management (create/view WiFi and eSIM products)
 *   - Recent orders with fulfillment status
 *   - Entitlement/binding health
 *
 * The page is a server component that checks auth. If the user is not logged
 * in, it shows a sign-in prompt. If logged in, it shows the portal dashboard.
 *
 * All data is fetched server-side via the frozen kernel's Prisma client.
 * Mutations go through the /api/commerce/* API routes.
 */

import Link from "next/link";
import { getCurrentUser } from "@/lib/auth";
import { getActiveTenant, listUserTenants } from "@/lib/tenant/context";
import { db } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Wifi, Smartphone, Package, ShoppingCart, CheckCircle2, XCircle, Clock, Router } from "lucide-react";

export default async function PortalPage() {
  const user = await getCurrentUser();

  // Not logged in — show sign-in prompt
  if (!user) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-8">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">RoamLink Reseller Portal</CardTitle>
            <CardDescription>
              The connectivity operating system for WiFi ISPs and eSIM retailers.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Link href="/auth/login">
              <Button className="w-full">Sign in to your reseller account</Button>
            </Link>
            <p className="text-xs text-center text-muted-foreground">
              New reseller? Contact us to get started.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Check if user has a tenant
  const tenants = await listUserTenants(user.id);
  const ctx = await getActiveTenant(user);

  if (!ctx || tenants.length === 0) {
    return (
      <div className="flex min-h-[calc(100vh-4rem)] items-center justify-center p-8">
        <Card className="max-w-md w-full">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl">No Reseller Account</CardTitle>
            <CardDescription>
              You&apos;re signed in as {user.email}, but you don&apos;t have a reseller tenant yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground text-center">
              Contact your RoamLink account manager to be added to a reseller organization.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Fetch products and recent orders for this tenant
  const [products, recentOrders, entitlementStats] = await Promise.all([
    db.resellerProduct.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.customerOrder.findMany({
      where: { tenantId: ctx.tenantId },
      include: {
        product: { select: { name: true, providerType: true } },
        customer: { select: { email: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 10,
    }),
    db.connectivityEntitlement.groupBy({
      by: ["status"],
      where: { tenantId: ctx.tenantId },
      _count: true,
    }),
  ]);

  const activeEntitlements = entitlementStats.find((s) => s.status === "ACTIVE")?._count ?? 0;

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="container mx-auto p-4 md:p-8 space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{ctx.tenant.name}</h1>
            <p className="text-muted-foreground">Reseller Portal Dashboard</p>
          </div>
          <div className="flex gap-2">
            <Button asChild variant="outline">
              <Link href="/portal/infrastructure">
                <Router className="mr-2 h-4 w-4" />
                Infrastructure
              </Link>
            </Button>
            <Button asChild>
              <Link href="/portal/products/new">
                <Plus className="mr-2 h-4 w-4" />
                New Product
              </Link>
            </Button>
          </div>
        </div>

        {/* Stats */}
        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Entitlements</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{activeEntitlements}</div>
              <p className="text-xs text-muted-foreground">Customers with active connectivity</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Products</CardTitle>
              <Package className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{products.length}</div>
              <p className="text-xs text-muted-foreground">In your catalog</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Recent Orders</CardTitle>
              <ShoppingCart className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{recentOrders.length}</div>
              <p className="text-xs text-muted-foreground">Last 10 orders</p>
            </CardContent>
          </Card>
        </div>

        {/* Products */}
        <Card>
          <CardHeader>
            <CardTitle>Product Catalog</CardTitle>
            <CardDescription>
              WiFi plans, eSIM data packs, and other connectivity products you sell.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {products.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">No products yet. Create your first product to start selling.</p>
                <Button asChild>
                  <Link href="/portal/products/new">
                    <Plus className="mr-2 h-4 w-4" />
                    Create Product
                  </Link>
                </Button>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Provider</TableHead>
                    <TableHead>Price</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {products.map((product) => (
                    <TableRow key={product.id}>
                      <TableCell className="font-medium">{product.name}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          {product.capabilityType === "INTERNET" && <Wifi className="h-4 w-4" />}
                          {product.capabilityType === "ROAMING" && <Smartphone className="h-4 w-4" />}
                          {product.capabilityType}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{product.providerType ?? "any"}</Badge>
                      </TableCell>
                      <TableCell>
                        {product.priceMinor === 0
                          ? "Free"
                          : `${(product.priceMinor / 100).toFixed(2)} ${product.currency}`}
                      </TableCell>
                      <TableCell>
                        <Badge variant={product.status === "active" ? "default" : "secondary"}>
                          {product.status}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Recent Orders */}
        <Card>
          <CardHeader>
            <CardTitle>Recent Orders</CardTitle>
            <CardDescription>
              Customer purchases and their fulfillment status.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recentOrders.length === 0 ? (
              <p className="text-center text-muted-foreground py-8">No orders yet.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Customer</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Date</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recentOrders.map((order) => (
                    <TableRow key={order.id}>
                      <TableCell className="font-medium">
                        {order.customer.name ?? order.customer.email}
                      </TableCell>
                      <TableCell>{order.product.name}</TableCell>
                      <TableCell>
                        <OrderStatusBadge status={order.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {new Date(order.createdAt).toLocaleDateString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "fulfilled":
      return (
        <Badge className="bg-green-100 text-green-800 hover:bg-green-100">
          <CheckCircle2 className="mr-1 h-3 w-3" />
          Fulfilled
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="destructive">
          <XCircle className="mr-1 h-3 w-3" />
          Failed
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="secondary">
          <Clock className="mr-1 h-3 w-3" />
          Pending
        </Badge>
      );
    case "paid":
      return (
        <Badge variant="secondary">
          <Clock className="mr-1 h-3 w-3" />
          Provisioning
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
