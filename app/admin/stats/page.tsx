import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { listAllUsers, listRecentLogins } from "@/lib/dynamodb";

// Always run on the server, never cache — these are live counts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Who may view this page. Set ADMIN_EMAIL in the deploy env to override.
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "yashasvithakur2005@gmail.com";

function dayKey(iso: string): string {
  return (iso || "").slice(0, 10); // YYYY-MM-DD
}

function lastNDays(n: number): string[] {
  // Build day keys without Date.now arithmetic surprises: walk back from today.
  const out: string[] = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out.reverse();
}

function Bars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="flex items-end gap-1 h-32">
      {data.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center justify-end gap-1" title={`${d.label}: ${d.value}`}>
          <div
            className="w-full rounded-t bg-amber-400/80"
            style={{ height: `${(d.value / max) * 100}%`, minHeight: d.value > 0 ? 3 : 0 }}
          />
          <span className="text-[9px] text-neutral-500 rotate-0">{d.label.slice(5)}</span>
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-5">
      <div className="text-3xl font-bold text-white">{value}</div>
      <div className="text-sm text-neutral-400 mt-1">{label}</div>
      {sub ? <div className="text-xs text-neutral-600 mt-0.5">{sub}</div> : null}
    </div>
  );
}

export default async function AdminStatsPage() {
  const session = await auth();
  if (!session?.user?.email || session.user.email !== ADMIN_EMAIL) {
    redirect("/dashboard");
  }

  const [users, logins] = await Promise.all([listAllUsers(), listRecentLogins(300)]);

  const totalAccounts = users.length;
  const withCreatedAt = users.filter((u) => u.createdAt);
  const withEmail = users.filter((u) => u.email).length;

  const days = lastNDays(14);
  const signupsByDay = new Map<string, number>(days.map((d) => [d, 0]));
  for (const u of withCreatedAt) {
    const k = dayKey(u.createdAt!);
    if (signupsByDay.has(k)) signupsByDay.set(k, (signupsByDay.get(k) || 0) + 1);
  }
  const loginsByDay = new Map<string, number>(days.map((d) => [d, 0]));
  for (const e of logins) {
    const k = dayKey(e.at);
    if (loginsByDay.has(k)) loginsByDay.set(k, (loginsByDay.get(k) || 0) + 1);
  }

  const today = days[days.length - 1];
  const loginsToday = loginsByDay.get(today) || 0;
  const signupsToday = signupsByDay.get(today) || 0;

  const fmt = (iso: string) =>
    iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—";

  return (
    <div className="min-h-screen bg-neutral-950 text-neutral-200 px-6 py-10">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-2xl font-bold text-white">Imprint — Admin Stats</h1>
        <p className="text-sm text-neutral-500 mt-1">
          Live counts from DynamoDB. Signups &amp; logins are tracked going forward only.
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mt-6">
          <Stat label="Accounts" value={totalAccounts} sub={`${withEmail} with email`} />
          <Stat label="Signups (tracked)" value={withCreatedAt.length} sub={`${signupsToday} today`} />
          <Stat label="Logins recorded" value={logins.length} sub={`${loginsToday} today`} />
          <Stat label="Login events shown" value={Math.min(logins.length, 300)} sub="most recent" />
        </div>

        <div className="grid md:grid-cols-2 gap-4 mt-8">
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
            <h2 className="text-sm font-semibold text-neutral-300 mb-3">Signups · last 14 days</h2>
            <Bars data={days.map((d) => ({ label: d, value: signupsByDay.get(d) || 0 }))} />
          </div>
          <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5">
            <h2 className="text-sm font-semibold text-neutral-300 mb-3">Logins · last 14 days</h2>
            <Bars data={days.map((d) => ({ label: d, value: loginsByDay.get(d) || 0 }))} />
          </div>
        </div>

        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-5 mt-8">
          <h2 className="text-sm font-semibold text-neutral-300 mb-3">Recent logins</h2>
          {logins.length === 0 ? (
            <p className="text-sm text-neutral-500">
              No logins recorded yet. They&apos;ll appear here as users sign in (you included, next time you log in).
            </p>
          ) : (
            <div className="divide-y divide-neutral-800">
              {logins.slice(0, 50).map((e, i) => (
                <div key={i} className="flex items-center justify-between py-2 text-sm">
                  <span className="text-neutral-300">{e.email || e.userId}</span>
                  <span className="text-neutral-500">{fmt(e.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <p className="text-xs text-neutral-600 mt-6">
          Pre-existing accounts created before tracking was added won&apos;t have a signup date and aren&apos;t in the
          signup chart, but they&apos;re still counted in “Accounts”.
        </p>
      </div>
    </div>
  );
}
