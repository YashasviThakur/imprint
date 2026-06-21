import { NextRequest, NextResponse } from "next/server";
import { getCustomProjects, saveCustomProjects } from "@/lib/dynamodb";
import { resolveUserId, unauthorized } from "@/lib/authz";

// GET /api/projects  → { projects }  (auth: session or API key)
export async function GET(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return unauthorized();
  try {
    const projects = await getCustomProjects(userId);
    return NextResponse.json({ projects });
  } catch (err) {
    console.error("GET /api/projects error:", err);
    return NextResponse.json({ error: "Failed to fetch projects" }, { status: 500 });
  }
}

// PUT /api/projects  { projects } → replace the caller's custom project list
export async function PUT(req: NextRequest) {
  const userId = await resolveUserId(req);
  if (!userId) return unauthorized();
  const { projects } = await req.json();
  try {
    await saveCustomProjects(userId, Array.isArray(projects) ? projects : []);
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("PUT /api/projects error:", err);
    return NextResponse.json({ error: "Failed to save projects" }, { status: 500 });
  }
}
