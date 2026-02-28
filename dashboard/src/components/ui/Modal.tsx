import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";

interface ModalProps {
  open:      boolean;
  title:     string;
  children:  React.ReactNode;
  onClose:   () => void;
  onConfirm?: () => void;
  confirmLabel?: string;
  confirmVariant?: "danger" | "primary";
  loading?: boolean;
}

export function Modal({
  open, title, children, onClose, onConfirm,
  confirmLabel = "Confirm", confirmVariant = "primary", loading = false,
}: ModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40"
            onClick={onClose}
          />
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 8 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="bg-surface-el border border-border rounded-2xl shadow-2xl w-full max-w-md"
            >
              <div className="flex items-center justify-between px-6 py-4 border-b border-border">
                <h2 className="font-head font-semibold text-primary">{title}</h2>
                <button onClick={onClose} className="text-muted hover:text-secondary transition-colors">
                  <X size={18} />
                </button>
              </div>
              <div className="px-6 py-4 text-secondary text-sm">{children}</div>
              {onConfirm && (
                <div className="flex gap-3 justify-end px-6 py-4 border-t border-border">
                  <button
                    onClick={onClose}
                    className="px-4 py-2 text-sm text-secondary hover:text-primary border border-border rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={onConfirm}
                    disabled={loading}
                    className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:opacity-50 ${
                      confirmVariant === "danger"
                        ? "bg-accent hover:bg-accent/80 text-white"
                        : "bg-info hover:bg-info/80 text-white"
                    }`}
                  >
                    {loading ? "Please wait…" : confirmLabel}
                  </button>
                </div>
              )}
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );
}
