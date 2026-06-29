import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { recordLogin } from "@/lib/dynamodb";

// Records a login for the current session. Called once per browser session by
// the client <LoginTracker/>; the session is read server-side (never trust the
// client for identity), and recordLogin() throttles to one event per 30 min.
export async function POST() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  try {
    await recordLogin(userId, {
      email: session.user?.email ?? undefined,
      name: session.user?.name ?? undefined,
      image: session.user?.image ?? undefined,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("POST /api/track/login error:", err);
    return NextResponse.json({ error: "Failed to record login" }, { status: 500 });
  }
}
