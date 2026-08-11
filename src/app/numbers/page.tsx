import Link from "next/link";
import { getNumberCountries } from "@/lib/virtual-numbers/service";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Smartphone, MessageSquare, Phone, ArrowRight } from "lucide-react";
import { countryFlag } from "@/lib/format";

export default async function NumbersPage() {
  const countries = await getNumberCountries();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="text-center">
        <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Virtual Phone Numbers</h1>
        <p className="mt-2 text-muted-foreground">Get a local number in 8+ countries. SMS, voice, and MMS where supported.</p>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {countries.map((c) => (
          <Link key={c.countryCode} href={`/numbers/${c.countryCode.toLowerCase()}`}>
            <Card className="lift p-5">
              <div className="flex items-center gap-3">
                <span className="text-4xl leading-none" aria-hidden>{countryFlag(c.countryCode)}</span>
                <div className="flex-1">
                  <h3 className="font-semibold">{c.country}</h3>
                  <p className="text-xs text-muted-foreground">{c.count} numbers available</p>
                </div>
                <ArrowRight className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {c.sms && <Badge variant="secondary" className="gap-1 text-[11px]"><MessageSquare className="h-3 w-3" /> SMS</Badge>}
                {c.voice && <Badge variant="secondary" className="gap-1 text-[11px]"><Phone className="h-3 w-3" /> Voice</Badge>}
                {c.mms && <Badge variant="secondary" className="gap-1 text-[11px]"><Smartphone className="h-3 w-3" /> MMS</Badge>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
