"use server";

import { verify } from "@node-rs/argon2";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { authEnv } from "@/lib/env";
import { SESSION_COOKIE, SESSION_TTL_S, createSession } from "@/lib/session";

// Simple in-memory brute-force brake: 5 failures per IP per 15 min.
const failures = new Map<string, { n: number; first: number }>();
const WINDOW_MS = 15 * 60_000;

export async function login(_prev: string | null, form: FormData): Promise<string | null> {
  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || "local";
  // Secure cookies are dropped over plain http (e.g. http://mac.local:3000 from a phone), so only set it on https.
  const https = h.get("x-forwarded-proto") === "https" || (h.get("origin") ?? "").startsWith("https://");
  const f = failures.get(ip);
  if (f && Date.now() - f.first < WINDOW_MS && f.n >= 5) return "Too many attempts. Try again in 15 minutes.";

  const password = String(form.get("password") ?? "");
  const ok = password.length > 0 && (await verify(authEnv().ADMIN_PASSWORD_HASH, password).catch(() => false));
  if (!ok) {
    const cur = f && Date.now() - f.first < WINDOW_MS ? f : { n: 0, first: Date.now() };
    failures.set(ip, { n: cur.n + 1, first: cur.first });
    await new Promise((r) => setTimeout(r, 600));
    return "Wrong password.";
  }
  failures.delete(ip);

  (await cookies()).set(SESSION_COOKIE, await createSession(), {
    httpOnly: true,
    sameSite: "strict",
    secure: https,
    path: "/",
    maxAge: SESSION_TTL_S,
  });
  const next = String(form.get("next") ?? "/");
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logout(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
