import { redirect } from "next/navigation";

/*
 * Captures live in Cosmos. Stock Photography uploads each one through
 * `CaptureService` and deletes its own copy only after `UploadComplete`
 * (`AssetUploadWorkerImpl.handleUploadSuccess`). One still waiting on the Pin is
 * declared with `DeclareMemoryCreateIntent`. /captures lists both.
 */
export default function Page() {
  redirect("/captures");
}
