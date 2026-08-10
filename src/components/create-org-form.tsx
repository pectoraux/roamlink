"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api-client";
import { toast } from "sonner";

export function CreateOrgClientForm() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await api.post("/api/organization", { name });
      toast.success("Organization created!");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Failed to create organization");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="org-name">Organization name</Label>
        <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Travel Inc." required />
      </div>
      <Button type="submit" disabled={loading} className="w-full">
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />} Create organization
      </Button>
    </form>
  );
}
