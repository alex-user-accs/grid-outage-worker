"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Re-renders the server component from SQLite. Costs zero Deye API calls. */
export function AutoRefresh({ everyMs = 120_000 }: { everyMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") router.refresh();
    }, everyMs);
    return () => clearInterval(id);
  }, [router, everyMs]);
  return null;
}
