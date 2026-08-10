import Link from "next/link";
import { notFound } from "next/navigation";
import { getPublicPlan } from "@/lib/plans/service";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  ArrowLeft,
  Wifi,
  Clock,
  Globe,
  Smartphone,
  ShieldCheck,
  Signal,
  Info,
  MapPin,
  Zap,
} from "lucide-react";
import { formatPrice, formatDataSize, countryFlag } from "@/lib/format";

export default async function PlanDetailsPage({ params }: { params: Promise<{ planId: string }> }) {
  const { planId } = await params;
  const plan = await getPublicPlan(planId);
  if (!plan) notFound();

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href="/esim" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to plans
      </Link>

      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
        {/* Left: details */}
        <div>
          <div className="flex items-center gap-4">
            <span className="text-5xl leading-none" aria-hidden>{countryFlag(plan.countryCode)}</span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{plan.country}</h1>
              <p className="text-sm text-muted-foreground">{plan.name}</p>
            </div>
          </div>

          <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat icon={Wifi} label="Data" value={formatDataSize(plan.dataAmountMB)} />
            <Stat icon={Clock} label="Validity" value={`${plan.validityDays} days`} />
            <Stat icon={Signal} label="Speed" value={plan.speed ?? "4G"} />
            <Stat icon={Smartphone} label="Hotspot" value={plan.hotspot ? "Yes" : "No"} />
          </div>

          {plan.description && (
            <p className="mt-6 text-sm text-muted-foreground">{plan.description}</p>
          )}

          {/* Coverage & networks */}
          <Card className="mt-6 p-5">
            <h2 className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-primary" /> Coverage</h2>
            <p className="mt-2 text-sm text-muted-foreground">{plan.coverage ?? plan.country}</p>
            {plan.networks.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-muted-foreground">Supported networks</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {plan.networks.map((n) => (
                    <Badge key={n} variant="secondary" className="gap-1">
                      <Signal className="h-3 w-3" /> {n}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </Card>

          {/* Features */}
          <Card className="mt-4 p-5">
            <h2 className="flex items-center gap-2 font-semibold"><Zap className="h-4 w-4 text-primary" /> Features</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <Feature ok label={`Data-only eSIM — ${formatDataSize(plan.dataAmountMB)} for ${plan.validityDays} days`} />
              <Feature ok label={`${plan.speed ?? "4G/5G"} network speeds`} />
              <Feature ok={plan.hotspot} label="Tethering / hotspot support" />
              <Feature ok={plan.roaming} label="Regional roaming included" />
              <Feature ok label="Top-up supported" />
              <Feature ok label="No physical SIM — install via QR" />
            </ul>
          </Card>

          {/* Activation / installation */}
          <Card className="mt-4 p-5">
            <h2 className="flex items-center gap-2 font-semibold"><Info className="h-4 w-4 text-primary" /> Installation & activation</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              After purchase you'll receive an SM-DP+ address and activation code. Install by scanning the QR code
              (recommended) or by entering the details manually in your phone's eSIM settings.
            </p>
            <Accordion type="single" collapsible className="mt-4">
              <AccordionItem value="iphone">
                <AccordionTrigger className="text-sm">iPhone installation</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  Settings → Cellular → Add eSIM Plan → scan the QR code. Confirm and follow on-screen prompts.
                  Select the eSIM as your data line. Activation typically completes within minutes of connecting to a network.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="android">
                <AccordionTrigger className="text-sm">Android installation</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  Settings → Network & Internet → SIMs → Add eSIM → scan the QR code. Steps vary by manufacturer.
                  Not all Android devices support eSIM — check your device compatibility before purchase.
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="fairuse">
                <AccordionTrigger className="text-sm">Fair-use policy</AccordionTrigger>
                <AccordionContent className="text-sm text-muted-foreground">
                  Plans are intended for normal personal use on a single device. Excessive tethering or automated
                  traffic may be rate-limited by the underlying carrier. Roaming availability depends on the destination.
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </Card>
        </div>

        {/* Right: purchase card */}
        <div className="lg:sticky lg:top-20 lg:self-start">
          <Card className="p-6">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold">{formatPrice(plan.priceMinor, plan.currency)}</span>
              <span className="text-sm text-muted-foreground">one-time</span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">All taxes & fees included</p>

            <div className="mt-5 space-y-3 border-t border-border/60 pt-5 text-sm">
              <Row label="Destination" value={plan.country} />
              <Row label="Data" value={formatDataSize(plan.dataAmountMB)} />
              <Row label="Validity" value={`${plan.validityDays} days`} />
              <Row label="Network" value={plan.speed ?? "4G/5G"} />
              <Row label="Hotspot" value={plan.hotspot ? "Supported" : "Not supported"} />
            </div>

            <Button asChild size="lg" className="mt-6 w-full">
              <Link href={`/checkout/${plan.id}`}>Buy eSIM</Link>
            </Button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <ShieldCheck className="h-3.5 w-3.5 text-primary" /> Secure checkout · Instant activation
            </p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Stat({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <Card className="p-3">
      <Icon className="h-4 w-4 text-primary" />
      <p className="mt-2 text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </Card>
  );
}

function Feature({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center gap-2">
      <span className={`flex h-4 w-4 items-center justify-center rounded-full ${ok ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"}`}>
        {ok ? "✓" : "—"}
      </span>
      <span className={ok ? "" : "text-muted-foreground line-through"}>{label}</span>
    </li>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}
