"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  Package,
  ShoppingBag,
  CreditCard,
  Settings,
  UserCog,
  ChevronDown,
  Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type TenantInfo = {
  id: string;
  name: string;
  slug: string;
  role: string;
};

type TenantListItem = {
  tenantId: string;
  role: string;
  name: string;
  slug: string;
  status: string;
};

type MeResponse = {
  tenant: TenantInfo | null;
  tenants: TenantListItem[];
  entitlements: {
    saaasPlanName: string;
    includedStaff: number;
    includedCustomers: number;
    includedOrdersPerMonth: number;
  } | null;
  stats: {
    customers: { total: number; active: number };
    orders: number;
    activeServices: number;
  } | null;
};

const navItems = [
  { href: "/reseller", label: "Dashboard", icon: LayoutDashboard },
  { href: "/reseller/customers", label: "Customers", icon: Users },
  { href: "/reseller/catalog", label: "Catalog", icon: Package },
  { href: "/reseller/orders", label: "Orders", icon: ShoppingBag },
  { href: "/reseller/billing", label: "Billing", icon: CreditCard },
  { href: "/reseller/team", label: "Team", icon: UserCog },
];

export default function ResellerLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [data, setData] = useState<MeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);

  useEffect(() => {
    fetch("/api/tenant/me")
      .then((r) => r.json())
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [pathname]);

  async function switchTenant(tenantId: string) {
    setSwitching(true);
    setShowSwitcher(false);
    await fetch("/api/tenant/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tenantId }),
    });
    router.refresh();
    setSwitching(false);
  }

  if (loading) {
    return (
      <div className="flex min-h-screen bg-muted/30">
        <div className="w-64 border-r bg-background p-4">
          <Skeleton className="h-8 w-32 mb-6" />
          <div className="space-y-2">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" />
            ))}
          </div>
        </div>
        <div className="flex-1 p-8">
          <Skeleton className="h-8 w-48 mb-6" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  // No tenant context — show access required message
  if (!data?.tenant) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
        <div className="max-w-md text-center space-y-4">
          <Building2 className="h-12 w-12 mx-auto text-muted-foreground" />
          <h1 className="text-xl font-semibold">No Reseller Tenant</h1>
          <p className="text-muted-foreground text-sm">
            You don&apos;t have access to a reseller tenant yet. An administrator must
            create a tenant and add you as a team member.
          </p>
          <Link href="/dashboard">
            <Button variant="outline">Back to Dashboard</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-muted/30">
      {/* Sidebar */}
      <aside className="w-64 border-r bg-background flex flex-col">
        <div className="p-4 border-b">
          {/* Tenant switcher */}
          <button
            onClick={() => setShowSwitcher(!showSwitcher)}
            className="w-full flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted transition-colors"
          >
            <div className="flex items-center gap-2 min-w-0">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground text-sm font-semibold shrink-0">
                {data.tenant.name.charAt(0).toUpperCase()}
              </div>
              <div className="text-left min-w-0">
                <div className="text-sm font-medium truncate">{data.tenant.name}</div>
                <div className="text-xs text-muted-foreground capitalize">{data.tenant.role}</div>
              </div>
            </div>
            {data.tenants.length > 1 && <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />}
          </button>
          {showSwitcher && data.tenants.length > 1 && (
            <div className="mt-1 space-y-1 border rounded-lg p-1 bg-popover">
              {data.tenants.map((t) => (
                <button
                  key={t.tenantId}
                  onClick={() => switchTenant(t.tenantId)}
                  disabled={switching}
                  className={`w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted transition-colors ${
                    t.tenantId === data.tenant?.id ? "bg-muted font-medium" : ""
                  }`}
                >
                  {t.name}
                </button>
              ))}
            </div>
          )}
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = pathname === item.href || (item.href !== "/reseller" && pathname.startsWith(item.href));
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-3 border-t">
          <Link href="/dashboard">
            <Button variant="ghost" size="sm" className="w-full justify-start gap-2 text-muted-foreground">
              <Settings className="h-4 w-4" />
              Exit to Dashboard
            </Button>
          </Link>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 overflow-auto">
        <div className="p-6 lg:p-8 max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
