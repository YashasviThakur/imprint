import { NextRequest, NextResponse } from "next/server";
import { ddb } from "@/lib/dynamodb";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { requireOwner } from "@/lib/authz";
import crypto from "crypto";

const USERS_TABLE = process.env.DYNAMODB_USERS_TABLE || "imprint-users";

function userKey(userId: string) {
  return { PK: `USER#${userId}`, SK: "PROFILE" };
}

// GET — fetch current key (masked)
export async function GET(req: NextRequest) {
  const userId = req.nextUrl.searchParams.get("userId");
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const denied = await requireOwner(userId);
  if (denied) return denied;
  const res = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: userKey(userId) }));
  const key: string | undefined = res.Item?.imprintApiKey;
  if (!key) return NextResponse.json({ key: null, hasKey: false });
  const masked = key.slice(0, 12) + "•".repeat(20) + key.slice(-6);
  return NextResponse.json({ key: masked, hasKey: true });
}

// POST — generate (or regenerate) API key
export async function POST(req: NextRequest) {
  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const denied = await requireOwner(userId);
  if (denied) return denied;
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
export async function DELETE(req: NextRequest) {
  const { userId } = await req.json();
  if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });
  const denied = await requireOwner(userId);
  if (denied) return denied;
  await ddb.send(new UpdateCommand({
    TableName: USERS_TABLE,
    Key: userKey(userId),
    UpdateExpression: "REMOVE imprintApiKey",
  }));
  return NextResponse.json({ success: true });
}
