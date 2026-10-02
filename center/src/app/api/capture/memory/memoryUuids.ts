import { NextResponse } from "next/server";

/** One capture page's worth. Cosmos refuses more in one request. */
const MAX_NAMED = 200;

/**
 * The recovered `{ memoryUUIDs: [...] }` body of the bulk routes, or the 400
 * that says why it is not one.
 */
export async function memoryUuidsFrom(request: Request): Promise<string[] | Response> {
  const body = (await request.json().catch(() => null)) as { memoryUUIDs?: unknown } | null;
  const uuids = body?.memoryUUIDs;
  if (
    !Array.isArray(uuids) ||
    uuids.length === 0 ||
    uuids.length > MAX_NAMED ||
    !uuids.every((uuid) => typeof uuid === "string" && /^[A-Za-z0-9-]{1,64}$/.test(uuid))
  ) {
    return NextResponse.json(
      { error: `memoryUUIDs must list 1 to ${MAX_NAMED} capture ids` },
      { status: 400 },
    );
  }
  return uuids as string[];
}
