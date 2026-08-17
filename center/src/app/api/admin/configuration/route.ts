import { configurationInventory } from "@/server/configuration";
import { sourceHeaders } from "@/server/headers";
import { logInfo } from "@/server/log";
import { requireOperatorRequest } from "@/server/operator";

/**
 * GET /api/admin/configuration — which deployment settings are configured,
 * which are missing, and which are running on a coded default.
 *
 * READ-ONLY BY CONSTRUCTION. This module exports GET and nothing else: no PUT,
 * no POST, no PATCH, no DELETE. Next serves 405 for a verb a route file does
 * not export, so "there is no writer" is enforced by the framework rather than
 * by a guard someone could later relax. `verify/configuration-inventory.test.mjs`
 * fails if another verb is ever added here.
 *
 * NAMES AND STATES ONLY. The body is built from `configurationInventory()`,
 * which reduces each environment value to one member of a closed union before
 * it returns. No value, no prefix, no length, no hash reaches this handler, so
 * there is nothing here to redact. See the design block at the top of
 * `server/configuration.ts` for why the rule has no exception list, which
 * settings could ever become writable, and why a secret editor is not one of
 * them.
 *
 * GATED TWICE, like every other operator surface: `middleware.ts` refuses
 * `/api/admin/*` before this file runs, and `requireOperatorRequest` evaluates
 * the same `operatorGateOutcome` again from the session cookie. Knowing which
 * credentials a deployment is missing is itself a map of its attack surface, so
 * this is an operator answer even though it discloses no value.
 */
export async function GET() {
  const operator = await requireOperatorRequest();
  if (operator instanceof Response) return operator;

  const inventory = await configurationInventory();

  // The audit line. Counts and the operator's subject — never a setting name
  // paired with anything, and never a value; `server/log.ts` is explicitly not
  // for secrets.
  logInfo(
    `configuration inventory read by ${operator.sub}: ` +
      `${inventory.counts.configured} configured, ${inventory.counts.default} default, ` +
      `${inventory.counts.missing} missing, ${inventory.counts.unreadable} unreadable, ` +
      `${inventory.counts.unobservable} unobservable`,
  );

  return Response.json(inventory, {
    headers: sourceHeaders(
      inventory.complete
        ? { source: "center", state: "live" }
        : {
            source: "center",
            state: "degraded",
            degraded:
              "Some settings this deployment reads are missing or unreadable.",
          },
    ),
  });
}
