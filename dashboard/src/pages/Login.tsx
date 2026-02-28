import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Eye, EyeOff, Shield, Lock } from "lucide-react";
import { login } from "../api";
import { useAuth } from "../context/AuthContext";

export default function LoginPage() {
  const [password, setPassword]   = useState("");
  const [show, setShow]           = useState(false);
  const [loading, setLoading]     = useState(false);
  const [error, setError]         = useState("");
  const [shake, setShake]         = useState(false);
  const { login: setToken }       = useAuth();
  const navigate                  = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoading(true);
    setError("");
    try {
      const { token } = await login(password);
      setToken(token);
      navigate("/", { replace: true });
    } catch {
      setError("Incorrect password. Try again.");
      setShake(true);
      setTimeout(() => setShake(false), 600);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg grid-bg flex items-center justify-center p-4">
      {/* Subtle radial glow */}
      <div className="absolute inset-0 bg-radial-at-center from-accent/5 via-transparent to-transparent pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: "easeOut" }}
        className="w-full max-w-sm"
      >
        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-surface border border-border flex items-center justify-center mb-4 shadow-xl">
            <span className="text-3xl">🛡️</span>
          </div>
          <h1 className="font-head font-bold text-2xl text-primary">TokPinch</h1>
          <p className="text-sm text-muted mt-1">TokPinch Dashboard</p>
        </div>

        {/* Card */}
        <motion.div
          animate={shake ? {
            x: [-8, 8, -8, 8, -4, 4, 0],
            transition: { duration: 0.5 },
          } : { x: 0 }}
          className="bg-surface border border-border rounded-2xl p-6 shadow-2xl"
        >
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-secondary mb-1.5">
                Dashboard Password
              </label>
              <div className="relative">
                <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
                <input
                  type={show ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  autoFocus
                  className="w-full pl-9 pr-10 py-2.5 bg-surface-el border border-border rounded-lg text-sm text-primary placeholder-muted focus:outline-none focus:border-accent/60 transition-colors"
                />
                <button
                  type="button"
                  onClick={() => setShow((v) => !v)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-secondary"
                >
                  {show ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            <AnimatePresence>
              {error && (
                <motion.p
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: "auto" }}
                  exit={{ opacity: 0, height: 0 }}
                  className="text-xs text-accent"
                >
                  {error}
                </motion.p>
              )}
            </AnimatePresence>

            <button
              type="submit"
              disabled={loading || !password.trim()}
              className="w-full flex items-center justify-center gap-2 py-2.5 bg-accent hover:bg-accent/90 disabled:bg-accent/40 text-white font-medium text-sm rounded-lg transition-all hover:shadow-lg hover:shadow-accent/20 disabled:cursor-not-allowed"
            >
              <Shield size={15} />
              {loading ? "Authenticating…" : "Enter Dashboard"}
            </button>
          </form>
        </motion.div>

        <p className="text-center text-xs text-muted mt-6">
          Protected by JWT · Session only storage
        </p>
      </motion.div>
    </div>
  );
}
