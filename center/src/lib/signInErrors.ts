/**
 * What /login says when the OIDC callback sent the wearer back with `?error=`.
 *
 * The callback puts Keycloak's own error code in the URL, and that code is for
 * the operator, not the wearer: rendered verbatim it is jargon
 * (`access_denied`), and the URL is trivially hand-edited, so no code ever
 * reaches the page as text. Every known code maps to one fixed sentence and
 * everything else reads as the same generic notice the form's own failures use.
 */

const NOTICES: Record<string, string> = {
  // The callback's own three reasons (route.ts `fail`).
  unconfigured: "Login is not configured on this deployment.",
  state: "That sign-in link is no longer valid. Start again.",
  exchange: "We couldn't complete sign-in. Try again below.",
  // RFC 6749 §4.1.2.1 and Keycloak's error parameter values.
  access_denied: "Sign-in was cancelled or refused. Try again below.",
  login_required: "Your sign-in expired before it finished. Sign in again.",
  interaction_required: "Sign-in needs your attention. Try again below.",
  consent_required: "Sign-in needs your consent. Try again below.",
  account_selection_required: "Choose an account to continue, then sign in again.",
  server_error: "The sign-in service hit a problem. Try again in a moment.",
  temporarily_unavailable: "The sign-in service is busy. Try again in a moment.",
};

const GENERIC = "We couldn't complete sign-in. Try again below.";

export function signInErrorNotice(code: string | null): string {
  return (code !== null && NOTICES[code]) || GENERIC;
}
