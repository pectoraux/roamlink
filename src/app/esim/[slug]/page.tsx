import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getDestinationBySlug, getPublicPlan, getAllDestinations, getPopularDestinations } from "@/lib/plans/service";
import { PlanCard } from "@/components/plan-card";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import {
  Wifi, Clock, Globe, Smartphone, ShieldCheck, Signal, MapPin, Zap, Info, ArrowRight, CheckCircle2,
} from "lucide-react";
import { formatPrice, formatDataSize, countryFlag } from "@/lib/format";

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const dest = await getDestinationBySlug(slug);
  if (dest) {
    const title = `${dest.country} eSIM — Travel Data Plans from ${formatPrice(dest.minPriceMinor)}`;
    const description = `Buy a ${dest.country} eSIM with instant activation. ${dest.planCount} data plans available. ${dest.networks.join(", ")} networks. No physical SIM, no roaming fees.`;
    return {
      title,
      description,
      alternates: { canonical: `/esim/${dest.slug}` },
      openGraph: {
        title,
        description,
        type: "website",
        images: [{ url: `/api/og?country=${dest.countryCode}&name=${encodeURIComponent(dest.country)}` }],
      },
      twitter: { card: "summary_large_image", title, description },
    };
  }
  // Plan detail metadata
  const plan = await getPublicPlan(slug);
  if (plan) {
    const title = `${plan.country} eSIM — ${formatDataSize(plan.dataAmountMB)} / ${plan.validityDays} days — ${formatPrice(plan.priceMinor)}`;
    const description = `${plan.country} travel eSIM: ${formatDataSize(plan.dataAmountMB)} data for ${plan.validityDays} days. ${plan.speed} speeds. Instant activation via QR code.`;
    return {
      title,
      description,
      alternates: { canonical: `/esim/${plan.id}` },
      openGraph: { title, description, type: "website" },
    };
  }
  return { title: "Not found" };
}

export default async function SlugPage({ params }: Props) {
  const { slug } = await params;

  // Try destination first (SEO pages like /esim/ghana)
  const dest = await getDestinationBySlug(slug);
  if (dest) return <DestinationPage dest={dest} />;

  // Fall back to plan detail (/esim/[planId])
  const plan = await getPublicPlan(slug);
  if (plan) return <PlanDetailPage plan={plan} />;

  notFound();
}

// ---------------------------------------------------------------------------
// Destination page — the primary SEO entity
// ---------------------------------------------------------------------------

async function DestinationPage({ dest }: { dest: Awaited<ReturnType<typeof getDestinationBySlug>> & {} }) {
  const [popular, allDestinations] = await Promise.all([getPopularDestinations(6), getAllDestinations()]);
  const faqs = [
    { q: `How do I install a ${dest.country} eSIM?`, a: `After purchase, you'll receive a QR code and activation details. On iPhone: Settings → Cellular → Add eSIM → scan QR. On Android: Settings → Network → SIMs → Add eSIM → scan QR. Installation takes under 2 minutes.` },
    { q: `Is my phone eSIM compatible?`, a: `Most iPhones from XS/XR onwards and many Android phones support eSIM. Check your device settings or use our compatibility checker. Note: eSIM hardware support and native installation support are not always the same.` },
    { q: `Can I use hotspot in ${dest.country}?`, a: `Yes, all our plans support tethering and hotspot unless specifically noted. You can share your data connection with other devices.` },
    { q: `What networks does the ${dest.country} eSIM use?`, a: `Our eSIMs connect to ${dest.networks.join(", ")}. Your phone automatically selects the best available network.` },
    { q: `Can I top up my data?`, a: `Yes, most plans support top-ups. If your plan supports it, you'll see top-up options in your dashboard after purchase.` },
  ];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${dest.country} eSIM`,
    description: `Travel eSIM data plans for ${dest.country}. ${dest.networks.join(", ")} networks. ${dest.speed} speeds.`,
    brand: { "@type": "Brand", name: "RoamLink" },
    offers: dest.plans.map((p) => ({
      "@type": "Offer",
      price: (p.priceMinor / 100).toFixed(2),
      priceCurrency: p.currency,
      name: `${formatDataSize(p.dataAmountMB)} / ${p.validityDays} days`,
    })),
  };
  const faqJsonLd = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
  };

  return (
    <div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqJsonLd) }} />

      {/* Hero */}
      <section className="hero-gradient relative overflow-hidden">
        <div className="mx-auto max-w-5xl px-4 py-12 md:py-16">
          <nav className="flex items-center gap-1 text-sm text-muted-foreground">
            <Link href="/esim" className="hover:text-foreground">eSIMs</Link>
            <span>/</span>
            <span className="text-foreground">{dest.country}</span>
          </nav>
          <div className="mt-4 flex items-center gap-4">
            <span className="text-5xl leading-none" aria-hidden>{countryFlag(dest.countryCode)}</span>
            <div>
              <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{dest.country} eSIM</h1>
              <p className="mt-1 text-muted-foreground">
                Stay connected in {dest.country} from <span className="font-semibold text-foreground">{formatPrice(dest.minPriceMinor)}</span> · {dest.planCount} plans · Instant activation
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1"><Signal className="h-3 w-3" /> {dest.speed ?? "4G/5G"}</Badge>
            <Badge variant="secondary" className="gap-1"><Smartphone className="h-3 w-3" /> Hotspot</Badge>
            <Badge variant="secondary" className="gap-1"><Zap className="h-3 w-3" /> Instant activation</Badge>
            {dest.networks.slice(0, 3).map((n) => <Badge key={n} variant="outline">{n}</Badge>)}
          </div>
        </div>
      </section>

      {/* Plans */}
      <section className="mx-auto max-w-5xl px-4 py-10">
        <h2 className="text-2xl font-bold tracking-tight">Available plans</h2>
        <p className="mt-1 text-sm text-muted-foreground">Choose the data package that fits your trip to {dest.country}.</p>
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {dest.plans.map((p) => <PlanCard key={p.id} plan={p} />)}
        </div>
      </section>

      {/* Coverage & networks */}
      <section className="mx-auto max-w-5xl px-4 py-6">
        <div className="grid gap-6 md:grid-cols-2">
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-primary" /> Coverage</h2>
            <p className="mt-2 text-sm text-muted-foreground">{dest.coverage ?? dest.country}</p>
            <div className="mt-4">
              <p className="text-xs font-medium text-muted-foreground">Supported networks</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {dest.networks.map((n) => <Badge key={n} variant="secondary" className="gap-1"><Signal className="h-3 w-3" /> {n}</Badge>)}
              </div>
            </div>
          </Card>
          <Card className="p-6">
            <h2 className="flex items-center gap-2 font-semibold"><Zap className="h-4 w-4 text-primary" /> Features</h2>
            <ul className="mt-3 space-y-2 text-sm">
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> {dest.speed ?? "4G/5G"} network speeds</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Hotspot / tethering supported</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> No physical SIM — install via QR</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Top-up available on most plans</li>
              <li className="flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Activates instantly after purchase</li>
            </ul>
          </Card>
        </div>
      </section>

      {/* Installation */}
      <section className="mx-auto max-w-5xl px-4 py-6">
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-semibold"><Info className="h-4 w-4 text-primary" /> How to install your {dest.country} eSIM</h2>
          <Accordion type="single" collapsible className="mt-4">
            <AccordionItem value="iphone">
              <AccordionTrigger className="text-sm">iPhone installation</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Settings → Cellular → Add eSIM Plan → scan the QR code. Confirm and follow prompts. Select the eSIM as your data line. Activation completes within minutes of connecting to a local network.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="android">
              <AccordionTrigger className="text-sm">Android installation</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                Settings → Network &amp; Internet → SIMs → Add eSIM → scan the QR code. Steps vary by manufacturer. Not all Android devices support eSIM — check compatibility before purchase.
              </AccordionContent>
            </AccordionItem>
            <AccordionItem value="compat">
              <AccordionTrigger className="text-sm">Is my phone compatible?</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">
                eSIM hardware support and native installation support are not always the same thing. Most iPhones from XS/XR onwards support eSIM. Android support varies by manufacturer. Check your device settings.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </Card>
      </section>

      {/* FAQ */}
      <section className="mx-auto max-w-5xl px-4 py-6">
        <h2 className="text-2xl font-bold tracking-tight">Frequently asked questions</h2>
        <Accordion type="single" collapsible className="mt-4">
          {faqs.map((f, i) => (
            <AccordionItem key={i} value={`faq-${i}`}>
              <AccordionTrigger className="text-sm">{f.q}</AccordionTrigger>
              <AccordionContent className="text-sm text-muted-foreground">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </section>

      {/* Other destinations */}
      <section className="mx-auto max-w-5xl px-4 py-10">
        <h2 className="text-xl font-bold tracking-tight">Other popular destinations</h2>
        <div className="mt-4 flex flex-wrap gap-2">
          {popular.filter((d) => d.countryCode !== dest.countryCode).map((d) => (
            <Link key={d.countryCode} href={`/esim/${d.country.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`}
              className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-card px-3 py-1.5 text-sm hover:border-primary/40 hover:bg-primary/5">
              <span aria-hidden>{countryFlag(d.countryCode)}</span> {d.country}
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Plan detail page (existing, preserved)
// ---------------------------------------------------------------------------

function PlanDetailPage({ plan }: { plan: Awaited<ReturnType<typeof getPublicPlan>> & {} }) {
  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <Link href="/esim" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        ← Back to plans
      </Link>
      <div className="mt-6 grid gap-8 lg:grid-cols-[1fr_360px]">
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
          {plan.description && <p className="mt-6 text-sm text-muted-foreground">{plan.description}</p>}
          <Card className="mt-6 p-5">
            <h2 className="flex items-center gap-2 font-semibold"><MapPin className="h-4 w-4 text-primary" /> Coverage</h2>
            <p className="mt-2 text-sm text-muted-foreground">{plan.coverage ?? plan.country}</p>
            {plan.networks.length > 0 && (
              <div className="mt-4">
                <p className="text-xs font-medium text-muted-foreground">Supported networks</p>
                <div className="mt-2 flex flex-wrap gap-2">{plan.networks.map((n) => <Badge key={n} variant="secondary" className="gap-1"><Signal className="h-3 w-3" /> {n}</Badge>)}</div>
              </div>
            )}
          </Card>
        </div>
        <div className="lg:sticky lg:top-20 lg:self-start">
          <Card className="p-6">
            <div className="flex items-baseline justify-between">
              <span className="text-3xl font-bold">{formatPrice(plan.priceMinor, plan.currency)}</span>
              <span className="text-sm text-muted-foreground">one-time</span>
            </div>
            <div className="mt-5 space-y-3 border-t border-border/60 pt-5 text-sm">
              <div className="flex justify-between"><span className="text-muted-foreground">Data</span><span className="font-medium">{formatDataSize(plan.dataAmountMB)}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Validity</span><span className="font-medium">{plan.validityDays} days</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Network</span><span className="font-medium">{plan.speed ?? "4G/5G"}</span></div>
            </div>
            <Button asChild size="lg" className="mt-6 w-full"><Link href={`/checkout/${plan.id}`}>Buy eSIM</Link></Button>
            <p className="mt-3 flex items-center justify-center gap-1.5 text-xs text-muted-foreground"><ShieldCheck className="h-3.5 w-3.5 text-primary" /> Secure checkout · Instant activation</p>
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
