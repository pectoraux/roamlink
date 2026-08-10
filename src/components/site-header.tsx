"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useAuth } from "@/app/providers";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from "@/components/ui/sheet";
import { Menu, Signal, LayoutDashboard, CreditCard, LogOut, ShieldCheck, User } from "lucide-react";

export function SiteHeader() {
  const { user, logout, loading } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { href: "/esim", label: "Browse eSIMs" },
    { href: "/dashboard/esims", label: "My eSIMs" },
    { href: "/dashboard/orders", label: "Orders" },
  ];

  function isActive(href: string) {
    return pathname === href || (href !== "/" && pathname.startsWith(href));
  }

  async function handleLogout() {
    await logout();
    router.push("/");
    router.refresh();
  }

  const initials = user?.email ? user.email.slice(0, 2).toUpperCase() : "U";

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border/60 bg-background/80 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4">
        <div className="flex items-center gap-2">
          {/* Mobile menu */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-72">
              <SheetTitle className="sr-only">Navigation</SheetTitle>
              <div className="mt-6 flex flex-col gap-1">
                <Link href="/" onClick={() => setMobileOpen(false)} className="mb-4 flex items-center gap-2">
                  <Signal className="h-6 w-6 text-primary" />
                  <span className="text-lg font-bold tracking-tight">RoamLink</span>
                </Link>
                {navLinks.map((l) => (
                  <Link
                    key={l.href}
                    href={l.href}
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    {l.label}
                  </Link>
                ))}
                {user?.role === "admin" && (
                  <Link
                    href="/admin"
                    onClick={() => setMobileOpen(false)}
                    className="rounded-lg px-3 py-2 text-sm font-medium hover:bg-muted"
                  >
                    Admin
                  </Link>
                )}
              </div>
            </SheetContent>
          </Sheet>

          <Link href="/" className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <Signal className="h-5 w-5" />
            </div>
            <span className="text-lg font-bold tracking-tight">RoamLink</span>
          </Link>
        </div>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-1 md:flex">
          {navLinks.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive(l.href) ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          ))}
          {user?.role === "admin" && (
            <Link
              href="/admin"
              className={`rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                isActive("/admin") ? "text-primary" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Admin
            </Link>
          )}
        </nav>

        {/* Account */}
        <div className="flex items-center gap-2">
          {loading ? (
            <div className="h-8 w-8 animate-pulse rounded-full bg-muted" />
          ) : user ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account menu">
                  <Avatar className="h-8 w-8">
                    <AvatarFallback className="bg-primary/10 text-primary text-xs">{initials}</AvatarFallback>
                  </Avatar>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="flex flex-col">
                  <span className="text-sm font-medium">{user.name ?? "Account"}</span>
                  <span className="text-xs text-muted-foreground">{user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/esims" className="flex items-center gap-2">
                    <LayoutDashboard className="h-4 w-4" /> Dashboard
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/orders" className="flex items-center gap-2">
                    <CreditCard className="h-4 w-4" /> Orders
                  </Link>
                </DropdownMenuItem>
                {user.role === "admin" && (
                  <DropdownMenuItem asChild>
                    <Link href="/admin" className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4" /> Admin
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout} className="flex items-center gap-2 text-rose-600">
                  <LogOut className="h-4 w-4" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <>
              <Button variant="ghost" asChild className="hidden sm:inline-flex">
                <Link href="/login">
                  <User className="mr-1 h-4 w-4" /> Sign in
                </Link>
              </Button>
              <Button asChild>
                <Link href="/register">Get started</Link>
              </Button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}
