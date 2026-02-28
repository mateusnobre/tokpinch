import React, { createContext, useContext, useState, useCallback } from "react";
import { getToken, setToken as storeToken, clearToken } from "../api";

interface AuthContextValue {
  token: string | null;
  login: (token: string) => void;
  logout: () => void;
  isAuthenticated: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());

  const login = useCallback((newToken: string) => {
    storeToken(newToken);
    setToken(newToken);
  }, []);

  const logout = useCallback(() => {
    clearToken();
    setToken(null);
  }, []);

  return (
    <AuthContext.Provider value={{ token, login, logout, isAuthenticated: !!token }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
