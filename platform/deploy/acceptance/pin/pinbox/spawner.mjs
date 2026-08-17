// spawner.mjs — run an underlying tool as a child node process with stdio
// inherited, resolving to its exit code. The `spawn` function is injected
// (Dependency Inversion) so tests can assert translation without running real
// tools. The token-file override is passed as env, never argv.

const NODE_BIN = process.execPath;

export function spawnChild(spawn, file, args, env, ctx) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(NODE_BIN, [file, ...args], {
        stdio: ["inherit", "inherit", "inherit"],
        env,
      });
    } catch (e) {
      ctx.err(`pinbox: failed to spawn ${file}: ${String(e?.message ?? e)}\n`);
      resolve(1);
      return;
    }
    child.on("error", (e) => {
      ctx.err(`pinbox: spawn error: ${String(e?.message ?? e)}\n`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}
