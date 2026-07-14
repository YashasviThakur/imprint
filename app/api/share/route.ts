import { NextRequest, NextResponse } from "next/server";
import { getMemories, getOrCreateUser } from "@/lib/dynamodb";
import { requireOwner } from "@/lib/authz";
import crypto from "crypto";

// No hardcoded fallback: with a public fallback secret anyone could compute any
// user's share token offline and read their pinned memories.
const SHARE_SECRET = process.env.SHARE_SECRET || process.env.ENCRYPTION_SECRET;

function makeToken(userId: string): string {
  return crypto.createHmac("sha256", SHARE_SECRET!).update(userId).digest("hex").slice(0, 24);
}

function verifyToken(token: string, userId: string): boolean {
  const expected = Buffer.from(makeToken(userId));
  const provided = Buffer.from(token);
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}

// GET /api/share?userId=xxx        → generate a share link (owner only)
// GET /api/share?token=xxx&userId= → resolve a shared link (public, token-gated)
export async function GET(req: NextRequest) {
  if (!SHARE_SECRET) {
    return NextResponse.json({ error: "Sharing is not configured (SHARE_SECRET missing)" }, { status: 503 });
  }
  const token = req.nextUrl.searchParams.get("token");
  const userId = req.nextUrl.searchParams.get("userId");

  // Generating the token requires being signed in as that user
  if (userId && !token) {
    const denied = await requireOwner(userId);
    if (denied) return denied;
    const t = makeToken(userId);
    return NextResponse.json({ token: t, shareUrl: `${process.env.NEXT_PUBLIC_APP_URL || "https://imprint-ebon.vercel.app"}/share/${t}?uid=${encodeURIComponent(userId)}` });
  }

  // Resolving a shared link is public — the unguessable token IS the grant
  if (token && userId) {
    if (!verifyToken(token, userId)) {
      return NextResponse.json({ error: "Invalid share link" }, { status: 403 });
    }
    const memories = await getMemories(userId, undefined, 100);
    const pinned   = memories.filter(m => m.pinned);
    const user     = await getOrCreateUser(userId);
    return NextResponse.json({ memories: pinned, total: memories.length, tier: user?.tier || "free" });
  }

  return NextResponse.json({ error: "token and userId required" }, { status: 400 });
}
