import { lazy, Suspense } from "react";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthProvider, useAuth } from "./context/AuthContext";
import { ToastProvider } from "./context/ToastContext";
import { Skeleton } from "./components/ui/Skeleton";

const LoginPage    = lazy(() => import("./pages/Login"));
const OverviewPage = lazy(() => import("./pages/Overview"));
const SessionsPage = lazy(() => import("./pages/Sessions"));
const BudgetPage   = lazy(() => import("./pages/Budget"));
const AlertsPage   = lazy(() => import("./pages/Alerts"));
const SettingsPage = lazy(() => import("./pages/Settings"));

function PageLoader() {
  return (
    <div className="min-h-screen bg-bg flex items-center justify-center">
      <div className="space-y-3 w-80">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </div>
  );
}

function ProtectedRoutes() {
  const { isAuthenticated } = useAuth();
  if (!isAuthenticated) return <Navigate to="/login" replace />;

  return (
    <Routes>
      <Route path="/"         element={<Suspense fallback={<PageLoader />}><OverviewPage /></Suspense>} />
      <Route path="/sessions" element={<Suspense fallback={<PageLoader />}><SessionsPage /></Suspense>} />
      <Route path="/budget"   element={<Suspense fallback={<PageLoader />}><BudgetPage /></Suspense>} />
      <Route path="/alerts"   element={<Suspense fallback={<PageLoader />}><AlertsPage /></Suspense>} />
      <Route path="/settings" element={<Suspense fallback={<PageLoader />}><SettingsPage /></Suspense>} />
      <Route path="*"         element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter basename="/dashboard">
          <Routes>
            <Route
              path="/login"
              element={
                <Suspense fallback={<PageLoader />}>
                  <LoginGuard />
                </Suspense>
              }
            />
            <Route path="/*" element={<ProtectedRoutes />} />
          </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}

// Redirect already-logged-in users away from /login
function LoginGuard() {
  const { isAuthenticated } = useAuth();
  if (isAuthenticated) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<PageLoader />}>
      <LoginPage />
    </Suspense>
  );
}
