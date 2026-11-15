import { readFile } from "node:fs/promises";
import { join } from "node:path";

const files = ["manifest.json", "popup.html", "popup.css", "popup.js"];
let archive;

/** Fixed source assets only. The Center runtime is pinned to Bun. No user path. */
export async function clipExtensionArchive() {
  if (!archive) archive = Promise.all(files.map(async (name) => [
    `luma-clip/${name}`, await readFile(join(process.cwd(), "runtime", "luma-clip", name)),
  ])).then((entries) => new Bun.Archive(Object.fromEntries(entries), { compress: "gzip" }).bytes())
    .catch((error) => { archive = undefined; throw error; });
  return archive;
}
