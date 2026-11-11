import "server-only";

import { handleWaitlist } from "@/lib/waitlist";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  return handleWaitlist(request, { env: process.env, fetch: globalThis.fetch });
}
