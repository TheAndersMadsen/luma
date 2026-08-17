import {
  ConfigurationProposalsUnavailableError,
  pendingProposals,
  proposalStoreFile,
  proposeValue,
  withdrawProposal,
} from "@/server/configurationProposals";
import { isSameOriginRequest } from "@/server/auth";
import { sourceHeaders } from "@/server/headers";
import { requireOperatorRequest } from "@/server/operator";

/**
 * The env-plane writer: /api/admin/configuration/proposals.
 *
 * A SEPARATE FILE FROM THE READER, on purpose. `../route.ts` is the inventory,
 * and its whole safety argument is that it exports GET and nothing else — Next
 * answers 405 for a verb a route file does not export, so "the inventory cannot
 * write" is enforced by the framework rather than by a guard someone could
 * relax. `verify/configuration-inventory.test.mjs` fails if a writing verb ever
 * appears there. Putting the writer here keeps that property literally true
 * while the writer still sits under the same operator prefix.
 *
 * WHAT A WRITE DOES, AND DOES NOT DO. It records a desired value in Center's
 * own `/data` volume. It does not touch `private/`, it does not restart
 * anything, and nothing about the running system changes until the next deploy
 * stages the private configuration and applies it. See §2 and §3 of
 * `server/configuration.ts` for why that is the mechanism rather than a
 * limitation: a dashboard that wrote the protected env files out of band would
 * disarm `rollback.sh` for the live system without saying so.
 *
 * GATED TWICE, like every other operator surface: `middleware.ts` refuses
 * `/api/admin/*` before this file runs, and `requireOperatorRequest` evaluates
 * the same `operatorGateOutcome` again from the session cookie. A wearer
 * session gets 403; no session gets 401. Mutations additionally require a
 * same-origin request, matching `/api/admin/flags` — an operator's cookie must
 * not be spendable by a page they merely visited.
 *
 * NOTHING HERE READS THE ENVIRONMENT. The values in the body are values the
 * operator supplied; the running values stay behind `configurationInventory`,
 * which reduces each to a state before it returns. There is no branch in this
 * file that could echo one back.
 */

const unavailable = (error: ConfigurationProposalsUnavailableError) =>
  Response.json(
    { error: error.message },
    {
      status: 503,
      headers: sourceHeaders({
        source: "center",
        state: "degraded",
        fallback: "empty",
        degraded: "Pending configuration changes could not be read from this deployment's data volume.",
      }),
    },
  );

/** Refuse to guess. An unreadable store must never render as "nothing pending". */
function withStore<T>(run: () => T): T | Response {
  try {
    return run();
  } catch (error) {
    if (error instanceof ConfigurationProposalsUnavailableError) return unavailable(error);
    throw error;
  }
}

async function operatorOf() {
  return requireOperatorRequest();
}

export async function GET() {
  const operator = await operatorOf();
  if (operator instanceof Response) return operator;

  const proposals = withStore(() => pendingProposals());
  if (proposals instanceof Response) return proposals;

  const refused = proposals.filter((proposal) => proposal.delivery === "refused").length;
  return Response.json(
    { file: proposalStoreFile(), proposals },
    {
      headers: sourceHeaders(
        refused === 0
          ? { source: "center", state: "live" }
          : {
              source: "center",
              state: "degraded",
              degraded: `${refused} pending change${refused === 1 ? "" : "s"} would be refused by the next deploy.`,
            },
      ),
    },
  );
}

export async function PUT(request: Request) {
  const operator = await operatorOf();
  if (operator instanceof Response) return operator;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }

  let body: { name?: unknown; value?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Expected a JSON body." }, { status: 400 });
  }
  if (typeof body.name !== "string" || body.name.length === 0) {
    return Response.json({ error: "A setting name is required." }, { status: 400 });
  }

  const outcome = withStore(() =>
    proposeValue(body.name as string, body.value, {
      sub: operator.sub,
      email: operator.email || null,
    }),
  );
  if (outcome instanceof Response) return outcome;
  if (!outcome.ok) {
    // 400 and the constraint's own sentence. The operator has to be able to fix
    // the value from what this says; "invalid value" is the answer that sends
    // someone to SSH and edit Compose by hand, which is the outcome §2 is
    // written to prevent.
    return Response.json({ error: outcome.reason }, { status: 400 });
  }
  return Response.json(
    { proposal: outcome.proposal },
    { headers: sourceHeaders({ source: "center", state: "live" }) },
  );
}

export async function DELETE(request: Request) {
  const operator = await operatorOf();
  if (operator instanceof Response) return operator;
  if (!isSameOriginRequest(request)) {
    return Response.json({ error: "A same-origin request is required." }, { status: 403 });
  }

  let name = "";
  try {
    const body = await request.json();
    name = typeof body?.name === "string" ? body.name : "";
  } catch {
    // Fall through to the same refusal a missing name gets. There is
    // deliberately no "no body clears everything" shortcut here: the flags
    // console has one because a flag change is reversible in seconds, and a
    // configuration change is only reversible by another deploy.
  }
  if (!name) {
    return Response.json({ error: "A setting name is required." }, { status: 400 });
  }

  const removed = withStore(() =>
    withdrawProposal(name, { sub: operator.sub, email: operator.email || null }),
  );
  if (removed instanceof Response) return removed;
  if (!removed) {
    return Response.json(
      { error: `There is no pending change for ${name}.` },
      { status: 404 },
    );
  }
  return Response.json(
    { withdrawn: name },
    { headers: sourceHeaders({ source: "center", state: "live" }) },
  );
}
