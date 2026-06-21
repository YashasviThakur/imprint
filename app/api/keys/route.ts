import { NextResponse } from "next/server";
import { ddb } from "@/lib/dynamodb";
import { GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { auth } from "@/auth";
import crypto from "crypto";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "imprint-users";

function userKey(userId: string) {
  return { PK: `USER#${userId}`, SK: "PROFILE" };
}

// Key management requires a real signed-in session (not another API key).
async function sessionUserId(): Promise<string | null> {
  try {
    const s = await auth();
    return (s?.user as { id?: string } | undefined)?.id ?? null;
  } catch {
    return null;
  }
}

// GET — fetch current key (masked)
export async function GET() {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const res = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: userKey(userId) }));
  const key: string | undefined = res.Item?.imprintApiKey;
  if (!key) return NextResponse.json({ key: null, hasKey: false });
  const masked = key.slice(0, 12) + "•".repeat(20) + key.slice(-6);
  return NextResponse.json({ key: masked, hasKey: true });
}

// POST — generate (or regenerate) API key
export async function POST() {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const raw = crypto.randomBytes(24).toString("hex");
  const key = `imp_live_${raw}`;
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: userKey(userId),
    UpdateExpression: "SET imprintApiKey = :k",
    ExpressionAttributeValues: { ":k": key },
  }));
  return NextResponse.json({ key }); // full key returned only once
}

// DELETE — revoke key
export async function DELETE() {
  const userId = await sessionUserId();
  if (!userId) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: userKey(userId),
    UpdateExpression: "REMOVE imprintApiKey",
  }));
  return NextResponse.json({ success: true });
}

// Helper used by /api/v1/memories and lib/authz to resolve a Bearer token → userId
export async function getUserIdFromApiKey(key: string): Promise<string | null> {
  if (!key.startsWith("imp_live_")) return null;
  // Scan for the matching key (table is small; add a GSI if it grows large)
  const res = await ddb.send(new ScanCommand({
    TableName: USERS_TABLE,
    FilterExpression: "imprintApiKey = :k",
    ExpressionAttributeValues: { ":k": key },
  }));
  const item = res.Items?.[0];
  if (!item) return null;
  return (item.userId as string) ?? null;
}
