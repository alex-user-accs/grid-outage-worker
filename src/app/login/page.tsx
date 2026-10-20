import { LoginForm } from "./LoginForm";

export const metadata = { title: "Sign in · Deye Dashboard" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  return (
    <main className="login-wrap">
      <LoginForm next={next ?? "/"} />
    </main>
  );
}
