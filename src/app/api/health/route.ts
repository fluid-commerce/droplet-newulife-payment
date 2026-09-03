/**
 * Health check. Replaces Rails' `get "up" => "rails/health#show"`.
 *
 * Deliberately does NOT touch the database: Cloud Run restarts a container that
 * fails this, and making it depend on Postgres turns a database blip into a
 * restart loop that cannot recover.
 */

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  return NextResponse.json({ status: "ok" });
}
