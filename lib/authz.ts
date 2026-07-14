import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { ddb } from "@/lib/dynamodb";
import { ScanCommand } from "@aws-sdk/lib-dynamodb";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "imprint-users";

// Authorization helpers.
//
// Two caller types:
//  - Browser/dashboard requests carry a NextAuth session whose `user.id` IS the
//    userId → guarded by requireOwner.
//  - MCP server / stop-hook / webhook / sync callers have no session; they send
//    an `Authorization: Bearer imp_live_...` (or `X-Imprint-Key`) API key that
//    resolves to a userId → guarded by requireOwnerOrKey.
// Every route that reads or writes user data must use one of these guards.
// Never trust a userId from the query string or body on its own.

// Resolve an imp_live_ API key to its owning userId (null if invalid/revoked).
export async function getUserIdFromApiKey(key: string): Promise<string | null> {
  if (!key.startsWith("imp_live_")) return null;
  // Scan for the matching key (table is small; add GSI if it grows large)
  const res = await ddb.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: "imprintApiKey = :k",
    ExpressionAttributeValues: { ":k": key },
  }));
  const item = res.Items?.[0];
  if (!item) return null;
  // userId is stored as an attribute alongside PK/SK (set in getOrCreateUser)
  return (item.userId as string) ?? null;
}

// Extract an API key from Authorization: Bearer or X-Imprint-Key headers.
export function extractApiKey(req: NextRequest): string {
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (bearer) return bearer;
  return (req.headers.get("X-Imprint-Key") ?? "").trim();
}

// Require a signed-in session that owns `userId`. Returns null when authorized,
// or a 401/403 response to return immediately.
export async function requireOwner(userId: string | null | undefined): Promise<NextResponse | null> {
  const session = await auth();
  const sid = session?.user?.id;
  if (!sid) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  if (!userId || sid !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  return null;
}

// Require EITHER a session that owns `userId` OR an API key that resolves to
// `userId`. For routes shared between the dashboard and keyless-transport
// clients (MCP server, stop hook, sync). Returns null when authorized.
export async function requireOwnerOrKey(req: NextRequest, userId: string | null | undefined): Promise<NextResponse | null> {
  const key = extractApiKey(req);
  if (key) {
    const keyUserId = await getUserIdFromApiKey(key);
    if (!keyUserId) return NextResponse.json({ error: "Invalid or revoked API key" }, { status: 403 });
    if (!userId || keyUserId !== userId) return NextResponse.json({ error: "Forbidden: key does not own this userId" }, { status: 403 });
    return null;
  }
  return requireOwner(userId);
}

// For expensive maintenance endpoints (backfill, recheck): allow either the
// session owner OR a request carrying the ADMIN_KEY. Returns null when allowed.
export async function requireOwnerOrAdminKey(userId: string | null | undefined, providedKey: unknown): Promise<NextResponse | null> {
  const adminKey = process.env.ADMIN_KEY;
  if (adminKey && typeof providedKey === "string" && providedKey === adminKey) return null;
  return requireOwner(userId);
}
