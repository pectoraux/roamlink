import { getCurrentUser } from "@/lib/auth";
import { json } from "@/lib/api";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return json({ user: null });
  return json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, isDemo: user.isDemo } });
}
