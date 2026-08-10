import Link from "next/link";
import { listPlans, getPopularDestinations } from "@/lib/plans/service";
import { PlanCard } from "@/components/plan-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { ArrowRight, Globe2, Zap, ShieldCheck, Smartphone, Clock, CreditCard, Plane } from "lucide-react";
import { formatPrice, countryFlag } from "@/lib/format";
import { SearchForm } from "@/components/search-form";

export default async function HomePage() {
  const [featured, destinations] = await Promise.all([
    listPlans({ sort: "price_asc" }).then((plans) =>
      // Show a spread of countries.
      plans.filter((p, i, arr) => arr.findIndex((x) => x.countryCode === p.countryCode) === i).slice(0, 8),
    ),
    getPopularDestinations(8),
  ]);

  return (
    <>
      {/* Hero */}
      <section className="hero-gradient relative overflow-hidden">
        <div className="mx-auto max-w-6xl px-4 py-16 md:py-24">
          <div className="mx-auto max-w-3xl text-center">
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
              <Zap className="h-3.5 w-3.5" /> Install in 2 minutes · No physical SIM
            </div>
            <h1 className="text-4xl font-bold tracking-tight text-balance md:text-6xl">
              Stay Connected <span className="text-primary">Wherever You Go</span>
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-base text-muted-foreground md:text-lg">
              Instant travel eSIM data plans for 190+ destinations. Buy online, scan a QR code, and connect — no roaming fees.
            </p>
            <div className="mx-auto mt-8 max-w-xl">
              <SearchForm />
            </div>
            <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Secure payments</span>
              <span className="flex items-center gap-1.5"><Clock className="h-3.5 w-3.5 text-primary" /> Activate instantly</span>
              <span className="flex items-center gap-1.5"><Globe2 className="h-3.5 w-3.5 text-primary" /> 190+ countries</span>
            </div>
          </div>
        </div>
      </section>

      {/* Popular destinations */}
      {destinations.length > 0 && (
        <section className="mx-auto max-w-6xl px-4 py-14">
          <div className="flex items-end justify-between">
            <div>
              <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Popular destinations</h2>
              <p className="mt-1 text-sm text-muted-foreground">Tap a country to see available plans</p>
            </div>
            <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
              <Link href="/esim">View all <ArrowRight className="ml-1 h-4 w-4" /></Link>
            </Button>
          </div>
          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {destinations.map((d) => (
              <Link key={d.countryCode} href={`/esim?country=${d.countryCode}`}>
                <Card className="lift flex items-center gap-3 p-4">
                  <span className="text-3xl leading-none" aria-hidden>{countryFlag(d.countryCode)}</span>
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{d.country}</p>
                    <p className="text-xs text-muted-foreground">from {formatPrice(d.minPriceMinor)}</p>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Featured plans */}
      <section className="mx-auto max-w-6xl px-4 py-6">
        <div className="flex items-end justify-between">
          <h2 className="text-2xl font-bold tracking-tight md:text-3xl">Featured plans</h2>
          <Button asChild variant="ghost" size="sm" className="hidden sm:inline-flex">
            <Link href="/esim">Browse all <ArrowRight className="ml-1 h-4 w-4" /></Link>
          </Button>
        </div>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {featured.map((p) => (
            <PlanCard key={p.id} plan={p} />
          ))}
        </div>
      </section>

      {/* How it works */}
      <section className="mx-auto max-w-6xl px-4 py-14">
        <h2 className="text-center text-2xl font-bold tracking-tight md:text-3xl">How it works</h2>
        <p className="mx-auto mt-2 max-w-lg text-center text-sm text-muted-foreground">
          From purchase to connected in four simple steps.
        </p>
        <div className="mt-10 grid gap-6 md:grid-cols-4">
          {[
            { icon: Globe2, title: "Choose destination", desc: "Search any country and pick a data plan that fits your trip." },
            { icon: CreditCard, title: "Pay securely", desc: "Checkout in seconds. We verify every payment server-side." },
            { icon: Smartphone, title: "Install your eSIM", desc: "Scan the QR code or enter activation details manually." },
            { icon: Plane, title: "Connect & travel", desc: "Land and connect instantly. Track usage and top up anytime." },
          ].map((s, i) => (
            <div key={i} className="relative">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <s.icon className="h-5 w-5" />
              </div>
              <div className="mt-4 flex items-center gap-2">
                <span className="text-xs font-bold text-primary">STEP {i + 1}</span>
              </div>
              <h3 className="mt-1 font-semibold">{s.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{s.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-6xl px-4 pb-16">
        <Card className="overflow-hidden border-primary/20 bg-primary/5">
          <div className="flex flex-col items-center justify-between gap-4 p-8 md:flex-row">
            <div>
              <h2 className="text-2xl font-bold tracking-tight">Ready to travel connected?</h2>
              <p className="mt-1 text-sm text-muted-foreground">Browse plans for your next destination.</p>
            </div>
            <Button asChild size="lg">
              <Link href="/esim">Browse eSIMs <ArrowRight className="ml-1 h-4 w-4" /></Link>
            </Button>
          </div>
        </Card>
      </section>
    </>
  );
}
