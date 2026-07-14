import { NextRequest, NextResponse } from "next/server";
import { createOrg, getOrg, addOrgMember, getOrgMemories, getMergedMemories } from "@/lib/dynamodb";
import { requireOwnerOrKey } from "@/lib/authz";
import { v4 as uuidv4 } from "uuid";

// POST /api/org — create org
// Body: { name, adminUserId, encryptedApiKey? }
export async function POST(req: NextRequest) {
  try {
    const { name, adminUserId, encryptedApiKey } = await req.json();
    if (!name || !adminUserId) {
      return NextResponse.json({ error: "name and adminUserId required" }, { status: 400 });
    }
    // Only the authenticated user may create an org with themselves as admin
    const denied = await requireOwnerOrKey(req, adminUserId);
    if (denied) return denied;
    const orgId = uuidv4();
    const org = await createOrg(orgId, name, adminUserId, encryptedApiKey);
    return NextResponse.json({ org });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// GET /api/org?orgId=&userId= — get org + merged memories (members only)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const orgId = searchParams.get("orgId");
    const userId = searchParams.get("userId");

    if (!orgId) return NextResponse.json({ error: "orgId required" }, { status: 400 });
    if (!userId) return NextResponse.json({ error: "userId required" }, { status: 400 });

    const denied = await requireOwnerOrKey(req, userId);
    if (denied) return denied;

    const org = await getOrg(orgId);
    if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
    if (!org.memberIds?.includes(userId)) {
      return NextResponse.json({ error: "Forbidden: not an org member" }, { status: 403 });
    }

    const memories = await getMergedMemories(userId, orgId);
    return NextResponse.json({ org, memories });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// PATCH /api/org — add member to org (admin only)
// Body: { orgId, userId, adminUserId }
export async function PATCH(req: NextRequest) {
  try {
    const { orgId, userId, adminUserId } = await req.json();
    if (!orgId || !userId || !adminUserId) {
      return NextResponse.json({ error: "orgId, userId and adminUserId required" }, { status: 400 });
    }
    // Caller must be authenticated as the org admin
    const denied = await requireOwnerOrKey(req, adminUserId);
    if (denied) return denied;
    const org = await getOrg(orgId);
    if (!org) return NextResponse.json({ error: "Org not found" }, { status: 404 });
    if (org.adminUserId !== adminUserId) {
      return NextResponse.json({ error: "Forbidden: only the org admin can add members" }, { status: 403 });
    }
    await addOrgMember(orgId, userId);
    return NextResponse.json({ ok: true, message: `${userId} added to org ${orgId}` });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
