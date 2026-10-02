import { spawnSync } from "node:child_process";

// Runs a command on a real pseudo-terminal and types each answer only after the
// command has been waiting for it, the way a person answers a prompt. Node has
// no pty of its own, so Python's pty module drives it; `available` is false
// where Python 3 or its pty module is missing.
const DRIVER = String.raw`
import json, os, pty, select, sys, time

answers = json.loads(sys.argv[1])
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
output = b""

def read_for(seconds):
    global output
    deadline = time.time() + seconds
    while time.time() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if not ready:
            continue
        try:
            data = os.read(fd, 4096)
        except OSError:
            return False
        if not data:
            return False
        output += data
    return True

for answer in answers:
    # An answer is text, or [prompt, text] to wait until the prompt shows.
    prompt, text = answer if isinstance(answer, list) else (None, answer)
    deadline = time.time() + 20
    alive = True
    while alive and prompt is not None and prompt.encode() not in output and time.time() < deadline:
        alive = read_for(0.05)
    if not alive or not read_for(0.4):
        break
    try:
        os.write(fd, (text + "\n").encode())
    except OSError:
        break
read_for(20)
_, status = os.waitpid(pid, 0)
sys.stdout.write(output.decode("utf-8", "replace"))
sys.exit(os.waitstatus_to_exitcode(status))
`;

export const terminalAvailable = process.platform !== "win32" &&
  spawnSync("python3", ["-c", "import pty"], { encoding: "utf8" }).status === 0;

export function runOnTerminal(command, args, answers, { cwd, env } = {}) {
  const result = spawnSync("python3", ["-c", DRIVER, JSON.stringify(answers), command, ...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, output: result.stdout, stderr: result.stderr };
}
