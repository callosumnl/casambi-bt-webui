import { Toaster } from "@/components/ui/sonner";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { AppShell } from "./components/AppShell";
import { ThemeProvider } from "./contexts/ThemeContext";
import { clearSession, getActiveSession, Session, SESSION_EXPIRED_EVENT, tokenExpiresAt } from "./lib/localApi";
import AdminEnhanced from "./pages/AdminEnhanced";
import ApiDocs from "./pages/ApiDocs";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import Schedules from "./pages/Schedules";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Routes local appliance users through a cyberpunk dashboard and role-gated Admin Panel. */
function App() {
  const [session, setSession] = useState<Session | null>(() => getActiveSession());
  const logout = () => { clearSession(); setSession(null); };
  // Return to the login screen when the token expires, either at its `exp` time or when the server rejects it first.
  // The current URL is kept, so signing in again lands on the same page.
  useEffect(() => {
    if (!session) return;
    const expire = () => { clearSession(); setSession(null); toast("Your session has expired. Please sign in again.", { id: "session-expired" }); };
    window.addEventListener(SESSION_EXPIRED_EVENT, expire);
    const expiresAt = tokenExpiresAt(session.token);
    const timer = expiresAt === null ? undefined : window.setTimeout(expire, Math.max(0, expiresAt - Date.now()));
    return () => { window.removeEventListener(SESSION_EXPIRED_EVENT, expire); window.clearTimeout(timer); };
  }, [session]);
  if (!session) return <ThemeProvider defaultTheme="dark"><Login onAuthenticated={setSession} /><Toaster /></ThemeProvider>;
  return <ThemeProvider defaultTheme="dark"><ErrorBoundary><AppShell role={session.user.role} username={session.user.username} onLogout={logout}><Switch><Route path="/" component={Dashboard} /><Route path="/schedules" component={Schedules} />{session.user.role === "admin" && <Route path="/admin" component={AdminEnhanced} />}{session.user.role === "admin" && <Route path="/api" component={ApiDocs} />}<Route component={NotFound} /></Switch></AppShell><Toaster /></ErrorBoundary></ThemeProvider>;
}

export default App;
