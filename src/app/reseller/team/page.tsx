"use client";

import { useEffect, useState } from "react";
import {
  UserCog,
  UserPlus,
  Search,
  AlertCircle,
  Loader2,
  Pencil,
  Trash2,
  Mail,
  Shield,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDate, statusColor, prettifyStatus } from "@/lib/format";

const ROLES = [
  "owner",
  "admin",
  "sales",
  "support",
  "billing",
  "operations",
  "viewer",
] as const;
type Role = (typeof ROLES)[number];

type Member = {
  id: string;
  role: string;
  createdAt: string;
  user: { id: string; email: string; name: string | null };
};

const roleColor: Record<string, string> = {
  owner: "bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300",
  admin: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  sales: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  support: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  billing: "bg-pink-100 text-pink-700 dark:bg-pink-500/15 dark:text-pink-300",
  operations:
    "bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300",
  viewer: "bg-muted text-muted-foreground",
};

export default function TeamPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ email: "", role: "viewer" as Role, name: "" });
  const [addError, setAddError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const [editMember, setEditMember] = useState<Member | null>(null);
  const [editRole, setEditRole] = useState<string>("viewer");
  const [editError, setEditError] = useState<string | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  const [removeMember, setRemoveMember] = useState<Member | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const res = await fetch("/api/tenant/team", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to load team");
      setMembers(data.members ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load team");
      setMembers([]);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    setAddError(null);
    if (!addForm.email.trim()) {
      setAddError("Email is required.");
      return;
    }
    setAdding(true);
    try {
      const res = await fetch("/api/tenant/team", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: addForm.email.trim(),
          role: addForm.role,
          name: addForm.name.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to add member");
      setShowAdd(false);
      setAddForm({ email: "", role: "viewer", name: "" });
      await load();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  function openEdit(m: Member) {
    setEditMember(m);
    setEditRole(m.role);
    setEditError(null);
  }

  async function handleSaveEdit() {
    if (!editMember) return;
    setEditError(null);
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/tenant/team/${editMember.user.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: editRole }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to update role");
      setEditMember(null);
      await load();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setSavingEdit(false);
    }
  }

  async function handleRemove() {
    if (!removeMember) return;
    setRemoveError(null);
    setRemoving(true);
    try {
      const res = await fetch(`/api/tenant/team/${removeMember.user.id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error ?? "Failed to remove member");
      setRemoveMember(null);
      await load();
    } catch (e) {
      setRemoveError(e instanceof Error ? e.message : "Failed to remove member");
    } finally {
      setRemoving(false);
    }
  }

  const filtered = members
    ? members.filter((m) => {
        const q = search.trim().toLowerCase();
        if (!q) return true;
        return (
          (m.user.name ?? "").toLowerCase().includes(q) ||
          m.user.email.toLowerCase().includes(q) ||
          m.role.toLowerCase().includes(q)
        );
      })
    : [];

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Team</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Manage who has access to your reseller control plane and what they can do.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)} className="gap-2">
          <UserPlus className="h-4 w-4" />
          Add Member
        </Button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, email, or role..."
          className="pl-9"
        />
      </div>

      {error ? (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Failed to load</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : members === null ? (
        <Card>
          <CardHeader>
            <Skeleton className="h-5 w-32" />
          </CardHeader>
          <CardContent className="p-0">
            {[...Array(4)].map((_, i) => (
              <div key={i} className="flex items-center gap-4 border-b px-6 py-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <Skeleton className="h-5 flex-1 max-w-[200px]" />
                <Skeleton className="h-5 w-20" />
              </div>
            ))}
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-muted">
              <UserCog className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="mt-4 font-medium">
              {members.length === 0 ? "No team members" : "No matching members"}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {members.length === 0
                ? "Add team members to delegate access to your control plane."
                : "Try adjusting your search."}
            </p>
            {members.length === 0 && (
              <Button onClick={() => setShowAdd(true)} className="mt-4 gap-2">
                <UserPlus className="h-4 w-4" />
                Add Member
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {filtered.length} member{filtered.length === 1 ? "" : "s"}
            </CardTitle>
            <CardDescription>
              Roles control access — owners and admins can manage members.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-6">Member</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead className="hidden sm:table-cell">Joined</TableHead>
                  <TableHead className="pr-6 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="pl-6">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-medium">
                          {(m.user.name ?? m.user.email).charAt(0).toUpperCase()}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">
                            {m.user.name ?? "Unnamed"}
                          </p>
                          <p className="text-xs text-muted-foreground sm:hidden truncate">
                            {m.user.email}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground hidden sm:table-cell">
                      {m.user.email}
                    </TableCell>
                    <TableCell>
                      <Badge className={roleColor[m.role] ?? statusColor(m.role)}>
                        {prettifyStatus(m.role)}
                      </Badge>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell text-muted-foreground">
                      {formatDate(m.createdAt)}
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => openEdit(m)}
                          title="Edit role"
                          disabled={m.role === "owner"}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive hover:text-destructive"
                          onClick={() => setRemoveMember(m)}
                          title="Remove member"
                          disabled={m.role === "owner"}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Roles legend */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4 text-muted-foreground" />
            Roles & permissions
          </CardTitle>
          <CardDescription>
            Role descriptions for your team members.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-2 sm:grid-cols-2">
          {[
            { role: "owner", desc: "Full control. Cannot be removed." },
            { role: "admin", desc: "Manage members, catalog, billing." },
            { role: "sales", desc: "Manage customers and orders." },
            { role: "support", desc: "View customers and orders." },
            { role: "billing", desc: "Manage subscription and API keys." },
            { role: "operations", desc: "Manage catalog and view orders." },
            { role: "viewer", desc: "Read-only access to all data." },
          ].map((r) => (
            <div
              key={r.role}
              className="flex items-start gap-2 rounded-md border p-2.5"
            >
              <Badge className={roleColor[r.role]}>{prettifyStatus(r.role)}</Badge>
              <p className="text-xs text-muted-foreground">{r.desc}</p>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Add Member Dialog */}
      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add team member</DialogTitle>
            <DialogDescription>
              Invite a member to your reseller tenant. If they don&apos;t have a
              RoamLink account, a placeholder will be created.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAdd} className="space-y-4">
            {addError && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{addError}</AlertDescription>
              </Alert>
            )}
            <div className="space-y-2">
              <Label htmlFor="add-email">Email</Label>
              <Input
                id="add-email"
                type="email"
                value={addForm.email}
                onChange={(e) => setAddForm({ ...addForm, email: e.target.value })}
                placeholder="colleague@company.com"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-name">Full name (optional)</Label>
              <Input
                id="add-name"
                value={addForm.name}
                onChange={(e) => setAddForm({ ...addForm, name: e.target.value })}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-role">Role</Label>
              <Select
                value={addForm.role}
                onValueChange={(v) => setAddForm({ ...addForm, role: v as Role })}
              >
                <SelectTrigger id="add-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLES.filter((r) => r !== "owner").map((r) => (
                    <SelectItem key={r} value={r}>
                      {prettifyStatus(r)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowAdd(false)}
                disabled={adding}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={adding}>
                {adding ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Adding...
                  </>
                ) : (
                  "Add member"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit Role Dialog */}
      <Dialog
        open={!!editMember}
        onOpenChange={(o) => !o && setEditMember(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit role</DialogTitle>
            <DialogDescription>
              Change the role for{" "}
              <span className="font-medium text-foreground">
                {editMember?.user.name ?? editMember?.user.email}
              </span>
              .
            </DialogDescription>
          </DialogHeader>
          {editError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{editError}</AlertDescription>
            </Alert>
          )}
          <div className="space-y-2">
            <Label htmlFor="edit-role">Role</Label>
            <Select value={editRole} onValueChange={setEditRole}>
              <SelectTrigger id="edit-role" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ROLES.map((r) => (
                  <SelectItem key={r} value={r} disabled={r === "owner"}>
                    {prettifyStatus(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditMember(null)}
              disabled={savingEdit}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveEdit} disabled={savingEdit}>
              {savingEdit ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save changes"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove Member Dialog */}
      <Dialog
        open={!!removeMember}
        onOpenChange={(o) => !o && setRemoveMember(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove team member?</DialogTitle>
            <DialogDescription>
              <span className="font-medium text-foreground">
                {removeMember?.user.name ?? removeMember?.user.email}
              </span>{" "}
              will lose access to this reseller tenant. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {removeError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{removeError}</AlertDescription>
            </Alert>
          )}
          {removeMember && (
            <div className="rounded-md bg-muted p-3 flex items-start gap-2">
              <Mail className="h-4 w-4 text-muted-foreground mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">{removeMember.user.name ?? "Unnamed"}</p>
                <p className="text-muted-foreground">{removeMember.user.email}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRemoveMember(null)}
              disabled={removing}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing}
            >
              {removing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Removing...
                </>
              ) : (
                "Remove member"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
