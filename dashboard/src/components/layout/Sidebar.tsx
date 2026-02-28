import { NavLink } from "react-router-dom";
import { motion } from "framer-motion";
import {
  LayoutDashboard, Users, PiggyBank,
  Bell, Settings, LogOut, Shield,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";

const navItems = [
  { to: "/",         label: "Overview",  icon: LayoutDashboard },
  { to: "/sessions", label: "Sessions",  icon: Users           },
  { to: "/budget",   label: "Budget",    icon: PiggyBank       },
  { to: "/alerts",   label: "Alerts",    icon: Bell            },
  { to: "/settings", label: "Settings",  icon: Settings        },
];

export function Sidebar() {
  const { logout } = useAuth();

  return (
    <aside className="hidden md:flex flex-col w-56 min-h-screen bg-surface border-r border-border fixed left-0 top-0 bottom-0">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 py-5 border-b border-border">
        <span className="text-xl">🛡️</span>
        <span className="font-head font-bold text-primary text-lg tracking-tight">TokPinch</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5">
        {navItems.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === "/"}
            className={({ isActive }) =>
              `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors relative group ${
                isActive
                  ? "bg-accent/10 text-accent"
                  : "text-secondary hover:text-primary hover:bg-surface-el"
              }`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && (
                  <motion.div
                    layoutId="nav-indicator"
                    className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 bg-accent rounded-full"
                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                  />
                )}
                <Icon size={16} className="flex-shrink-0" />
                <span className="font-medium">{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Bottom */}
      <div className="px-3 pb-4 border-t border-border pt-3 space-y-1">
        {/* Proxy status indicator */}
        <div className="flex items-center gap-2.5 px-3 py-2 text-xs text-muted">
          <span className="w-2 h-2 rounded-full bg-success animate-pulse2 flex-shrink-0" />
          <span>Proxy Running</span>
          <Shield size={11} className="ml-auto" />
        </div>

        <button
          onClick={logout}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm text-muted hover:text-accent hover:bg-accent/5 transition-colors"
        >
          <LogOut size={16} />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  );
}
