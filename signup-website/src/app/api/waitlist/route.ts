import "server-only";

import { getWaitlistCount, handleWaitlist } from "@/lib/waitlist";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const count = await getWaitlistCount({ env: process.env, fetch: globalThis.fetch });
  return Response.json({ count }, {
    status: count === null ? 503 : 200,
    headers: { "Cache-Control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  return handleWaitlist(request, {
    env: process.env,
    fetch: globalThis.fetch,
    reportFailure: (diagnostic) => console.error("[waitlist] submission failed", diagnostic),
  });
}
