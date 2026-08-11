import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getNumberCountries, searchNumbers } from "@/lib/virtual-numbers/service";
import { NumberSearch } from "@/components/number-search";
import { Badge } from "@/components/ui/badge";
import { MessageSquare, Phone, Smartphone } from "lucide-react";
import { countryFlag } from "@/lib/format";

type Props = { params: Promise<{ country: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { country: slug } = await params;
  const code = slug.toUpperCase();
  const countries = await getNumberCountries();
  const c = countries.find((x) => x.countryCode === code);
  if (!c) return { title: "Not found" };
  const title = `Virtual Number ${c.country} — ${c.count} numbers available`;
  const description = `Get a ${c.country} virtual phone number with SMS, voice, and MMS. Instant activation. ${c.count} local numbers available from ${formatPrice(c.minPrice ?? 0)}.`;
  return {
    title,
    description,
    alternates: { canonical: `/numbers/${slug}` },
    openGraph: { title, description, type: "website" },
  };
}

function formatPrice(minor: number, currency = "USD"): string {
  return `$${(minor / 100).toFixed(2)}`;
}

export default async function NumberCountryPage({ params }: Props) {
  const { country: slug } = await params;
  const code = slug.toUpperCase();
  const countries = await getNumberCountries();
  const c = countries.find((x) => x.countryCode === code);
  if (!c) notFound();

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: `${c.country} Virtual Number`,
    description: `Virtual phone number for ${c.country}. SMS, voice, and MMS capabilities.`,
  };

  return (
    <div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <div className="hero-gradient">
        <div className="mx-auto max-w-5xl px-4 py-12">
          <div className="flex items-center gap-4">
            <span className="text-5xl leading-none" aria-hidden>{countryFlag(c.countryCode)}</span>
            <div>
              <h1 className="text-3xl font-bold tracking-tight md:text-4xl">{c.country} Virtual Number</h1>
              <p className="mt-1 text-muted-foreground">{c.count} local numbers available · Instant activation</p>
            </div>
          </div>
          <div className="mt-4 flex gap-2">
            {c.sms && <Badge variant="secondary" className="gap-1"><MessageSquare className="h-3 w-3" /> SMS</Badge>}
            {c.voice && <Badge variant="secondary" className="gap-1"><Phone className="h-3 w-3" /> Voice</Badge>}
            {c.mms && <Badge variant="secondary" className="gap-1"><Smartphone className="h-3 w-3" /> MMS</Badge>}
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-5xl px-4 py-8">
        <NumberSearch countryCode={c.countryCode} countryName={c.country} />
      </div>
    </div>
  );
}
