"use client";

/**
 * Phase 5.1E — Infrastructure Management Page
 *
 * Allows operators to add and manage their connectivity infrastructure:
 *   - MikroTik routers (WiFi/ISP)
 *   - eSIM supplier connections
 *
 * This is the "Add Router" / "Add eSIM Supplier" UI that was missing
 * (GAP-5 from the commercial audit).
 */

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Plus, Router, Smartphone, Trash2 } from "lucide-react";

type Instance = {
  id: string;
  providerType: string;
  name: string;
  status: string;
  configuration: string | null;
  configurationKey: string | null;
  createdAt: string;
};

export default function InfrastructurePage() {
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);

  // Form state
  const [providerType, setProviderType] = useState("mikrotik");
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [configurationKey, setConfigurationKey] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [region, setRegion] = useState("");

  useEffect(() => {
    fetchInstances();
  }, []);

  async function fetchInstances() {
    setLoading(true);
    try {
      const res = await fetch("/api/connectivity/instances");
      if (res.ok) {
        const data = await res.json();
        setInstances(data.instances);
      }
    } catch {
      toast.error("Failed to load instances");
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();

    try {
      const res = await fetch("/api/connectivity/instances", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerType,
          name,
          endpoint: endpoint || undefined,
          configurationKey: configurationKey || undefined,
          apiVersion: apiVersion || undefined,
          region: region || undefined,
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create instance");
      }

      toast.success("Infrastructure added");
      setShowForm(false);
      setName("");
      setEndpoint("");
      setConfigurationKey("");
      setApiVersion("");
      setRegion("");
      fetchInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create instance");
    }
  }

  async function handleDeactivate(id: string) {
    try {
      const res = await fetch(`/api/connectivity/instances/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to deactivate");
      toast.success("Instance deactivated");
      fetchInstances();
    } catch {
      toast.error("Failed to deactivate instance");
    }
  }

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-background">
      <div className="container mx-auto p-4 md:p-8 space-y-8">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Infrastructure</h1>
            <p className="text-muted-foreground">Manage your connectivity providers</p>
          </div>
          <Button onClick={() => setShowForm(!showForm)}>
            <Plus className="mr-2 h-4 w-4" />
            {showForm ? "Cancel" : "Add Infrastructure"}
          </Button>
        </div>

        {showForm && (
          <Card>
            <CardHeader>
              <CardTitle>Add Infrastructure</CardTitle>
              <CardDescription>
                Connect a MikroTik router or eSIM supplier. Credentials are stored
                via environment variables referenced by the configuration key.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleCreate} className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Provider Type</Label>
                    <Select value={providerType} onValueChange={setProviderType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="mikrotik">
                          <span className="flex items-center gap-2">
                            <Router className="h-4 w-4" /> MikroTik (WiFi/ISP)
                          </span>
                        </SelectItem>
                        <SelectItem value="esim">
                          <span className="flex items-center gap-2">
                            <Smartphone className="h-4 w-4" /> eSIM Supplier
                          </span>
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="name">Name</Label>
                    <Input
                      id="name"
                      placeholder={providerType === "mikrotik" ? "Accra Router 01" : "Airalo Production"}
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="endpoint">Endpoint URL</Label>
                    <Input
                      id="endpoint"
                      placeholder={providerType === "mikrotik" ? "https://192.168.1.1/rest" : "https://api.airalo.com/v1"}
                      value={endpoint}
                      onChange={(e) => setEndpoint(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="configKey">Configuration Key</Label>
                    <Input
                      id="configKey"
                      placeholder={providerType === "mikrotik" ? "mikrotik-accra-01" : "esim-airalo-prod"}
                      value={configurationKey}
                      onChange={(e) => setConfigurationKey(e.target.value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      References env vars (e.g., MIKROTIK_{`{KEY}`}_USERNAME).
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="apiVersion">API Version (optional)</Label>
                    <Input
                      id="apiVersion"
                      placeholder="v1"
                      value={apiVersion}
                      onChange={(e) => setApiVersion(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="region">Region (optional)</Label>
                    <Input
                      id="region"
                      placeholder="West Africa"
                      value={region}
                      onChange={(e) => setRegion(e.target.value)}
                    />
                  </div>
                </div>

                <Button type="submit">Add Infrastructure</Button>
              </form>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Connected Infrastructure</CardTitle>
            <CardDescription>
              Routers, eSIM suppliers, and other connectivity providers you&apos;ve connected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-center text-muted-foreground py-8">Loading...</p>
            ) : instances.length === 0 ? (
              <div className="text-center py-8">
                <p className="text-muted-foreground mb-4">
                  No infrastructure connected yet. Add your first router or eSIM supplier to start provisioning.
                </p>
                {!showForm && (
                  <Button onClick={() => setShowForm(true)}>
                    <Plus className="mr-2 h-4 w-4" />
                    Add Infrastructure
                  </Button>
                )}
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {instances.map((instance) => {
                    const config = instance.configuration ? JSON.parse(instance.configuration) : {};
                    return (
                      <TableRow key={instance.id}>
                        <TableCell className="font-medium">{instance.name}</TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            {instance.providerType === "mikrotik" && <Router className="h-4 w-4" />}
                            {instance.providerType === "esim" && <Smartphone className="h-4 w-4" />}
                            {instance.providerType}
                          </div>
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {config.endpoint || "—"}
                        </TableCell>
                        <TableCell>
                          <Badge variant={instance.status === "active" ? "default" : "secondary"}>
                            {instance.status}
                          </Badge>
                        </TableCell>
                        <TableCell>
                          {instance.status === "active" && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleDeactivate(instance.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
