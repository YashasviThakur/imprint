import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { getUserIdFromApiKey } from "@/app/api/keys/route";

/**
 * Resolve the caller's userId from a trusted source — never from a
 * client-supplied `userId` param. Two legitimate callers:
 *   1. Programmatic (MCP server, stop-hook, external API) → `Authorization: Bearer imp_live_...`
 *   2. Browser (dashboard) → a valid NextAuth session cookie
 * Returns null when neither is present/valid → caller should 401.
 */
export async function resolveUserId(req: Request): Promise<string | null> {
  const hdr = req.headers.get("authorization") || "";
  if (/^bearer\s+/i.test(hdr)) {
    const key = hdr.replace(/^bearer\s+/i, "").trim();
    const uid = await getUserIdFromApiKey(key);
    if (uid) return uid;
  }
  try {
    const session = await auth();
    const uid = (session?.user as { id?: string } | undefined)?.id;
    if (uid) return uid;
  } catch {
    /* no session */
  }
  return null;
}

export function unauthorized() {
  return NextResponse.json(
    { error: "Unauthorized — sign in, or send a valid Imprint API key (Authorization: Bearer imp_live_…)." },
    { status: 401 },
  );
}
