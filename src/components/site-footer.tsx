import Link from "next/link";
import { Signal, Mail } from "lucide-react";

export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-border/60 bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="grid gap-8 md:grid-cols-4">
          <div className="md:col-span-2">
            <div className="flex items-center gap-2">
              <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                <Signal className="h-4 w-4" />
              </div>
              <span className="text-base font-bold">RoamLink</span>
            </div>
            <p className="mt-3 max-w-sm text-sm text-muted-foreground">
              Stay connected wherever you go. Instant eSIM data for 190+ destinations — no SIM swap, no roaming fees.
            </p>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Product</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li><Link href="/esim" className="hover:text-foreground">Browse eSIMs</Link></li>
              <li><Link href="/dashboard/esims" className="hover:text-foreground">My eSIMs</Link></li>
              <li><Link href="/dashboard/orders" className="hover:text-foreground">Orders</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold">Support</h4>
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li className="flex items-center gap-1.5"><Mail className="h-3.5 w-3.5" /> support@roamlink.app</li>
              <li><Link href="/login" className="hover:text-foreground">Sign in</Link></li>
              <li><Link href="/register" className="hover:text-foreground">Create account</Link></li>
            </ul>
          </div>
        </div>
        <div className="mt-8 flex flex-col items-center justify-between gap-3 border-t border-border/60 pt-6 text-xs text-muted-foreground sm:flex-row">
          <p>© {new Date().getFullYear()} RoamLink. eSIM reseller marketplace.</p>
          <p>Development build · Mock providers active</p>
        </div>
      </div>
    </footer>
  );
}
