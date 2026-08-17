export const LIVENESS_PATH = "/healthz";
export const READINESS_PATH = "/readyz";

export const probeContract = Object.freeze({
  liveness: LIVENESS_PATH,
  readiness: READINESS_PATH,
});
