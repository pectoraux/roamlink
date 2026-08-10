"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldCheck, LayoutDashboard, Package, ShoppingBag, Smartphone, Users, Radio, ArrowLeft } from "lucide-react";
import { useAuth } from "@/app/providers";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const nav = [
  { href: "/admin", label: "Overview", icon: LayoutDashboard, exact: true },
  { href: "/admin/plans", label: "Plans", icon: Package },
  { href: "/admin/orders", label: "Orders", icon: ShoppingBag },
  { href: "/admin/esims", label: "eSIMs", icon: Smartphone },
  { href: "/admin/users", label: "Users", icon: Users },
  { href: "/admin/providers", label: "Providers", icon: Radio },
];

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (loading) return;
    if (!user) { router.push("/login?next=/admin"); return; }
    if (user.role !== "admin") { router.push("/"); return; }
  }, [user, loading, router]);

  if (loading || !user || user.role !== "admin") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center text-muted-foreground">
        <ShieldCheck className="mr-2 h-5 w-5 animate-pulse" /> Checking admin access…
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-7xl px-4 py-6">
      <div className="flex items-center gap-2 border-b border-border/60 pb-4">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold">Admin Dashboard</h1>
        <Link href="/" className="ml-auto inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" /> Back to site
        </Link>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[200px_1fr]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <nav className="flex gap-1 overflow-x-auto lg:flex-col">
            {nav.map((item) => {
              const active = item.exact ? pathname === item.href : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                    active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  <item.icon className="h-4 w-4" /> {item.label}
                </Link>
              );
            })}
          </nav>
        </aside>
        <div>{children}</div>
      </div>
    </div>
  );
}
