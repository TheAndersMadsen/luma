import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";
import { sourceFiles } from "./sourceScan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = path.join(root, "src");
const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const { options } = ts.parseJsonConfigFileContent(config.config, ts.sys, root);

test("browser entry points cannot import server implementations, even through shared modules", async () => {
  const modules = new Map();
  for (const url of await sourceFiles(new URL("../src/", import.meta.url), readdir)) {
    const file = fileURLToPath(url);
    if (/\.test\.tsx?$/.test(file)) continue;
    const source = ts.createSourceFile(file, await readFile(url, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = [];
    const visit = (node) => {
      if (ts.isImportDeclaration(node)) {
        // With verbatimModuleSyntax, even `import { type T }` emits an empty
        // runtime import. Only `import type` erases the module dependency.
        if (!node.importClause?.isTypeOnly) imports.push(node.moduleSpecifier.text);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && !node.isTypeOnly) {
        imports.push(node.moduleSpecifier.text);
      } else if (ts.isCallExpression(node) && node.arguments.length === 1 &&
          (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
            (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
          ts.isStringLiteral(node.arguments[0])) {
        imports.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    modules.set(file, {
      client: source.statements.some((node) => ts.isExpressionStatement(node) &&
        ts.isStringLiteral(node.expression) && node.expression.text === "use client"),
      dependencies: imports.map((specifier) =>
        ts.resolveModuleName(specifier, file, options, ts.sys).resolvedModule?.resolvedFileName,
      ).filter((target) => target?.startsWith(`${sourceRoot}${path.sep}`)),
    });
  }
  const clients = [...modules].filter(([, module]) => module.client);
  assert.ok(clients.length > 0, "the scan must find the browser entry points");
  for (const [entry] of clients) {
    const seen = new Set();
    const visit = (file, chain) => {
      if (seen.has(file)) return;
      seen.add(file);
      const relative = path.relative(sourceRoot, file);
      const next = [...chain, relative];
      assert.ok(!relative.startsWith(`server${path.sep}`) && !relative.startsWith(`app${path.sep}api${path.sep}`),
        `Browser code reaches a server implementation: ${next.join(" → ")}. Use a browser-safe contract or an explicit type-only import.`);
      for (const dependency of modules.get(file)?.dependencies ?? []) visit(dependency, next);
    };
    visit(entry, []);
  }
});
