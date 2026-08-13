import { Toaster } from "@/components/ui/sonner";
import { Route, Switch } from "wouter";
import ErrorBoundary from "./components/ErrorBoundary";
import { AppShell } from "./components/AppShell";
import { ThemeProvider } from "./contexts/ThemeContext";
import { clearSession, getSession, Session } from "./lib/localApi";
import Admin from "./pages/Admin";
import Dashboard from "./pages/Dashboard";
import Login from "./pages/Login";
import NotFound from "./pages/NotFound";
import Schedules from "./pages/Schedules";
import { useState } from "react";

/** Routes local appliance users through a cyberpunk dashboard and role-gated Admin Panel. */
function App() {
  const [session, setSession] = useState<Session | null>(() => getSession());
  const logout = () => { clearSession(); setSession(null); };
  if (!session) return <ThemeProvider defaultTheme="dark"><Login onAuthenticated={setSession} /><Toaster /></ThemeProvider>;
  return <ThemeProvider defaultTheme="dark"><ErrorBoundary><AppShell role={session.user.role} username={session.user.username} onLogout={logout}><Switch><Route path="/" component={Dashboard} /><Route path="/schedules" component={Schedules} />{session.user.role === "admin" && <Route path="/admin" component={Admin} />}<Route component={NotFound} /></Switch></AppShell><Toaster /></ErrorBoundary></ThemeProvider>;
}

export default App;
