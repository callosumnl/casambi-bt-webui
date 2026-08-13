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
  const [demo, setDemo] = useState(() => new URLSearchParams(window.location.search).get("demo") === "1");
  const logout = () => { clearSession(); setSession(null); setDemo(false); };
  if (!session && !demo) return <ThemeProvider defaultTheme="dark"><Login onAuthenticated={setSession} onDemo={() => setDemo(true)} /><Toaster /></ThemeProvider>;
  const activeRole = session?.user.role || "user"; const username = session?.user.username || "DEMO VISITOR";
  return <ThemeProvider defaultTheme="dark"><ErrorBoundary><AppShell role={activeRole} username={username} onLogout={logout} demo={demo}><Switch><Route path="/" component={() => <Dashboard demo={demo} />} /><Route path="/schedules" component={() => <Schedules demo={demo} />} />{!demo && session?.user.role === "admin" && <Route path="/admin" component={Admin} />}<Route component={NotFound} /></Switch></AppShell><Toaster /></ErrorBoundary></ThemeProvider>;
}

export default App;
