import { motion } from "framer-motion";
import { Sidebar } from "./Sidebar";

interface LayoutProps {
  children: React.ReactNode;
  title:    string;
}

export function Layout({ children, title }: LayoutProps) {
  return (
    <div className="flex min-h-screen bg-bg">
      <Sidebar />
      <main className="flex-1 md:ml-56 min-w-0">
        {/* Page header */}
        <div className="sticky top-0 z-10 bg-bg/80 backdrop-blur border-b border-border px-6 py-4">
          <h1 className="font-head font-semibold text-xl text-primary">{title}</h1>
        </div>

        {/* Page content */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: "easeOut" }}
          className="p-6"
        >
          {children}
        </motion.div>
      </main>
    </div>
  );
}
