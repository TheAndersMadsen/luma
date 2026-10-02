import { NextResponse } from "next/server";
import { isSameOriginRequest } from "@/server/auth";
import { setDeviceBlocked } from "@/server/domain/account";
import { accountWriteResponse } from "../../../account/accountWriteResponse";

/**
 * Block mode for one of the signed-in wearer's Pins, the control the stock
 * Pin sends the wearer to humane.center/devices for.
 *
 *   POST   /api/devices/{deviceId}/block   the wearer marked this Pin lost
 *   DELETE /api/devices/{deviceId}/block   block mode off
 *
 * Cosmos keeps the block under the wearer's own account and refuses every call
 * from that Pin with the stock `unauthorized-device` trailer, which locks it.
 * Answers `{ok, block}` (see `accountWriteResponse`).
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  return change(request, context, true);
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
) {
  return change(request, context, false);
}

async function change(
  request: Request,
  context: { params: Promise<{ deviceId: string }> },
  blocked: boolean,
) {
  if (!isSameOriginRequest(request)) {
    return NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 });
  }
  const { deviceId } = await context.params;
  if (!/^[0-9a-fA-F]{1,64}$/u.test(deviceId)) {
    return NextResponse.json({ ok: false, error: "That is not a Pin id." }, { status: 404 });
  }
  return accountWriteResponse("block", await setDeviceBlocked(deviceId, blocked));
}
