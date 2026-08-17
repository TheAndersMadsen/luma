/*
 * A small structural reader for this repo's TypeScript, shared by the verify
 * tests that have to reason about WHERE something appears rather than merely
 * whether it appears.
 *
 * Both tests that use it exist because a grep-shaped assertion had already
 * failed us: `.shell(["rm","-f",deviceTmpPath])` contains no interpolation at
 * the call site, and a `catch {}` that eats an expired session is invisible to
 * any regex that only knows the file mentions the error somewhere. Neither
 * property can be checked without matching braces, so the brace matcher lives
 * here once instead of being copied into each test.
 *
 * This is not a parser. It masks everything that is not code — comment bodies,
 * string contents, regex bodies, and template text — keeping every index in
 * place so the caller can slice the ORIGINAL source with the same offsets.
 */

export const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = new Set([")", "]", "}"]);

/**
 * Blank out everything that is not code, preserving length.
 *
 * `${` and the expression inside it survive: an interpolation marker is a
 * structural fact about the code, and one of the two callers is looking for
 * exactly that.
 */
export function maskSource(source) {
  let out = "";
  let index = 0;
  let mode = "code";
  const stack = [];
  let braceDepth = 0;
  let previous = "";

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (mode === "line") {
      if (char === "\n") mode = "code";
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (mode === "block") {
      if (char === "*" && next === "/") {
        mode = "code";
        out += "  ";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (mode === "single" || mode === "double" || mode === "regex") {
      const terminator = mode === "single" ? "'" : mode === "double" ? '"' : "/";
      if (char === "\\") {
        out += "  ";
        index += 2;
        continue;
      }
      if (char === terminator) {
        mode = "code";
        out += char;
        index += 1;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }
    if (mode === "template") {
      if (char === "\\") {
        out += "  ";
        index += 2;
        continue;
      }
      if (char === "`") {
        mode = stack.pop() ?? "code";
        out += char;
        index += 1;
        continue;
      }
      if (char === "$" && next === "{") {
        stack.push("template");
        mode = "code";
        braceDepth += 1;
        out += "${";
        index += 2;
        continue;
      }
      out += char === "\n" ? "\n" : " ";
      index += 1;
      continue;
    }

    // mode === "code"
    if (char === "/" && next === "/") {
      mode = "line";
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      mode = "block";
      out += "  ";
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      mode = char === "'" ? "single" : "double";
      out += char;
      index += 1;
      continue;
    }
    if (char === "`") {
      stack.push("code");
      mode = "template";
      out += char;
      index += 1;
      continue;
    }
    // A `/` after a value is division; after an operator or an opener it starts
    // a regex literal, whose contents must not be read as braces.
    if (char === "/" && /[([{=,;:!&|?+\-*%^<>~]|^$/.test(previous)) {
      mode = "regex";
      out += char;
      index += 1;
      continue;
    }
    if (char === "}" && braceDepth > 0 && stack.at(-1) === "template") {
      braceDepth -= 1;
      mode = stack.pop();
      out += "}";
      index += 1;
      continue;
    }
    out += char;
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return out;
}

/** Text between the bracket at `open` and its match, plus that match's index. */
export function balanced(masked, open) {
  if (!OPENERS[masked[open]]) return null;
  let depth = 0;
  for (let index = open; index < masked.length; index += 1) {
    const char = masked[index];
    if (OPENERS[char]) depth += 1;
    else if (CLOSERS.has(char)) {
      depth -= 1;
      if (depth === 0) return { text: masked.slice(open + 1, index), end: index };
    }
  }
  return null;
}

/** The first top-level argument of an extracted argument list. */
export function firstArgument(argumentList) {
  let depth = 0;
  for (let index = 0; index < argumentList.length; index += 1) {
    const char = argumentList[index];
    if (OPENERS[char]) depth += 1;
    else if (CLOSERS.has(char)) depth -= 1;
    else if (char === "," && depth === 0) return argumentList.slice(0, index);
  }
  return argumentList;
}

/** 1-based line number of an index, for failure messages that name a place. */
export function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

/**
 * Every `try { … } catch (e) { … }` in a file.
 *
 * `binding` is null for a bare `catch {`, which is the shape that discards a
 * typed error entirely. A `try`/`finally` with no catch is skipped: it does not
 * swallow anything.
 */
export function tryCatchBlocks(source) {
  const masked = maskSource(source);
  const blocks = [];
  const keyword = /\btry\s*\{/g;
  let match;
  while ((match = keyword.exec(masked)) !== null) {
    const tryOpen = match.index + match[0].length - 1;
    const tryBlock = balanced(masked, tryOpen);
    if (!tryBlock) continue;
    const after = masked.slice(tryBlock.end + 1);
    const clause = /^\s*catch\s*(?:\(\s*([A-Za-z_$][\w$]*)[^)]*\))?\s*\{/.exec(after);
    if (!clause) continue;
    const catchOpen = tryBlock.end + 1 + clause[0].length - 1;
    const catchBlock = balanced(masked, catchOpen);
    if (!catchBlock) continue;
    blocks.push({
      line: lineOf(masked, match.index),
      binding: clause[1] ?? null,
      // Sliced from the original so callers can read the code as written.
      tryBody: source.slice(tryOpen + 1, tryBlock.end),
      catchBody: source.slice(catchOpen + 1, catchBlock.end),
    });
  }
  return blocks;
}

/** Recursively collect .ts/.tsx files under a directory URL. */
export async function sourceFiles(dir, readdir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(`${entry.name}${entry.isDirectory() ? "/" : ""}`, dir);
    if (entry.isDirectory()) await sourceFiles(child, readdir, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(child);
  }
  return out;
}
