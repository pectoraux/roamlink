"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";

export type ClientUser = {
  id: string;
  email: string;
  name: string | null;
  role: "customer" | "admin";
};

type AuthContextValue = {
  user: ClientUser | null;
  loading: boolean;
  refresh: () => Promise<ClientUser | null>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  refresh: async () => null,
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<ClientUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      setUser(data.user ?? null);
      return data.user ?? null;
    } catch {
      setUser(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ user, loading, refresh, logout }}>{children}</AuthContext.Provider>
  );
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, retry: 1, refetchOnWindowFocus: false },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} disableTransitionOnChange>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
