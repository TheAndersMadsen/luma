import { get } from "node:http";

import { LIVENESS_PATH } from "./probes.mjs";

const address = process.env.LUMA_SPOTIFY_ADAPTER_BIND_ADDRESS;
const port = process.env.LUMA_SPOTIFY_ADAPTER_PORT || "18081";
if (!address) process.exit(1);
const probeAddress = address === "0.0.0.0" ? "127.0.0.1" : address === "::" ? "::1" : address;

const request = get(
  { host: probeAddress, port, path: LIVENESS_PATH, timeout: 7_000 },
  (response) => {
    response.resume();
    response.on("end", () => process.exit(response.statusCode === 200 ? 0 : 1));
  },
);
request.on("timeout", () => request.destroy());
request.on("error", () => process.exit(1));
