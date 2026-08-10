"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

export function SearchForm() {
  const router = useRouter();
  const [q, setQ] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const query = q.trim();
    router.push(query ? `/esim?search=${encodeURIComponent(query)}` : "/esim");
  }

  return (
    <form onSubmit={submit} className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a destination — Ghana, France, USA..."
          className="h-12 pl-10 text-base shadow-sm"
          aria-label="Search destination"
        />
      </div>
      <Button type="submit" size="lg" className="h-12 px-6">
        Search
      </Button>
    </form>
  );
}
