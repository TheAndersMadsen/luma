import { cosmosNoteSchema, type CosmosNoteDto } from "@/lib/contracts/notes";
import type { ClipWrite } from "@/lib/contracts/clips";
import { COSMOS_WEBAPI_ENABLED, CosmosHttpError, webapiPut } from "../cosmos";
import { failedWebapi, live, unconfigured, type Sourced } from "./provenance";

/** INFERRED Luma endpoint: the same copy ID always addresses the same Cosmos note. */
export async function copyClip(id: string, article: ClipWrite): Promise<Sourced<CosmosNoteDto | null>> {
  if (!COSMOS_WEBAPI_ENABLED) return unconfigured(null, "empty", "Cosmos is not configured; the article was not saved.");
  try { return live(cosmosNoteSchema.parse(await webapiPut(`/capture/clips/${encodeURIComponent(id)}`, article))); }
  catch (error) {
    const result = failedWebapi(null, error);
    if (error instanceof CosmosHttpError) {
      if (error.status === 409) return { ...result, refusal: "conflict" };
      if (error.status === 400) return { ...result, refusal: "invalid" };
      if (error.status === 413) return { ...result, refusal: "too_large" };
    }
    return result;
  }
}
