"use client";

import { useEffect } from "react";
import { useSession } from "next-auth/react";

// Pings /api/track/login once per browser session when a user is authenticated.
// Renders nothing. The server route throttles to one login event per 30 min, so
// this firing on every page mount is harmless — sessionStorage just avoids the
// extra request within the same tab.
export default function LoginTracker() {
  const { status } = useSession();

  useEffect(() => {
    if (status !== "authenticated") return;
    if (sessionStorage.getItem("login-tracked")) return;
    sessionStorage.setItem("login-tracked", "1");
    fetch("/api/track/login", { method: "POST" }).catch(() => {});
  }, [status]);

  return null;
}
