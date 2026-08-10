/**
 * Auth context — manages the user's authentication state across the mobile app.
 * The session token is stored in expo-secure-store (not AsyncStorage).
 */

import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from "react";
import type { AuthUser } from "@roamlink/shared";
import { api, saveSession, getSession, clearSession, API_BASE_URL } from "./api";

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  signIn: async () => {},
  signOut: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const restore = useCallback(async () => {
    const token = await getSession();
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.me(token);
      setUser(res.user);
    } catch {
      await clearSession();
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    restore();
  }, [restore]);

  const signIn = useCallback(async (email: string, password: string) => {
    // The login response sets a cookie; we need to extract the token from the
    // Set-Cookie header. Since fetch on React Native exposes cookies via
    // document.cookie on web, but on native we use the response directly.
    // For the mobile app, we'll call the API and parse the Set-Cookie header.
    const res = await fetch(`${API_BASE_URL}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");

    // Extract token from Set-Cookie header
    const setCookie = res.headers.get("set-cookie") || "";
    const tokenMatch = setCookie.match(/esim_session=([^;]+)/);
    const token = tokenMatch?.[1];

    if (token) {
      await saveSession(token);
    }
    setUser(data.user);
  }, []);

  const signOut = useCallback(async () => {
    const token = await getSession();
    if (token) {
      try { await api.logout(token); } catch { /* noop */ }
    }
    await clearSession();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}
