import Link from "next/link";
import { logout } from "../login/actions";

export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <header className="topbar">
        <nav>
          <Link href="/" className="brand">☀ Deye</Link>
          <Link href="/">Dashboard</Link>
          <Link href="/devices">Devices</Link>
          <Link href="/status">API status</Link>
          <Link href="/api-docs">API docs</Link>
        </nav>
        <form action={logout}>
          <button type="submit" className="ghost">Sign out</button>
        </form>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
