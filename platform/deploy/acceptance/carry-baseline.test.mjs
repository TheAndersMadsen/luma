import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const baselineTool = path.join(ROOT, "platform/deploy/vps/remote/carry-baseline.py");
const registrar = readFileSync(path.join(ROOT, "platform/deploy/vps/remote/register-carry-baseline.sh"), "utf8");
const library = readFileSync(path.join(ROOT, "platform/deploy/vps/remote/lib/carry-baseline.sh"), "utf8");
const deploy = readFileSync(path.join(ROOT, "platform/deploy/vps/remote/deploy.sh"), "utf8");
const rollback = readFileSync(path.join(ROOT, "platform/deploy/vps/remote/rollback.sh"), "utf8");
const preflight = readFileSync(path.join(ROOT, "platform/deploy/vps/remote/preflight.sh"), "utf8");
const localDeploy = readFileSync(path.join(ROOT, "platform/deploy/vps/deploy.sh"), "utf8");
const localLibrary = readFileSync(path.join(ROOT, "platform/deploy/vps/lib/local.sh"), "utf8");
const productionCli = readFileSync(path.join(ROOT, "platform/cli/production.js"), "utf8");

test("adopted Carry records are closed, deterministic, content-addressed, and tamper evident", () => {
  const script = String.raw`
import copy,importlib.util,os,tempfile
spec=importlib.util.spec_from_file_location("carry_baseline",__import__("sys").argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
fixture=tempfile.mkdtemp(prefix="revival-carry-baseline-"); os.chmod(fixture,0o700)
center=os.path.join(fixture,"center-data"); os.mkdir(center,0o700)
config=[]
for name,kind in (("runtime","file"),("backends","file"),("center","file"),
                  ("edge","directory"),("attest","directory"),("duc","directory"),("theme","directory")):
    target=os.path.join(fixture,name)
    if kind=="file":
        descriptor=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.write(descriptor,(name+"\n").encode()); os.fchmod(descriptor,0o600); os.close(descriptor)
    else:
        os.mkdir(target,0o700)
        member=os.path.join(target,"member")
        descriptor=os.open(member,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        os.write(descriptor,(name+"-bytes\n").encode()); os.fchmod(descriptor,0o600); os.close(descriptor)
    config.append((name,target,kind))
resources={"stateVolume":module.VOLUME_NAMES[0],"pgVolume":module.VOLUME_NAMES[1],
           "prometheusVolume":module.VOLUME_NAMES[2],"grafanaVolume":module.VOLUME_NAMES[3],
           "localModelNetwork":module.LOCAL_MODEL_NETWORK,"centerData":center}
def mounts(service):
    values=[]
    for destination,kind,source,writable in module.required_mounts(service,resources):
        values.append({"Type":kind,"Name":source if kind=="volume" else "",
                       "Source":"/var/lib/docker/volumes/"+source if kind=="volume" else source,
                       "Destination":destination,"Driver":"local" if kind=="volume" else "",
                       "Mode":"rw" if writable else "ro","RW":writable,"Propagation":"rprivate"})
    return values
def containers(state):
    result=[]
    for number,service in enumerate(module.EXPECTED_SERVICES,1):
        labels={"com.docker.compose.project":module.LEGACY_PROJECT,
                "com.docker.compose.service":service,"com.docker.compose.version":"2.39.1"}
        endpoint={"NetworkID":"e"*64,"EndpointID":f"{number:064x}","Gateway":"10.0.0.1",
                  "IPAddress":f"10.0.0.{number+1}","IPPrefixLen":24,"IPv6Gateway":"",
                  "GlobalIPv6Address":"","GlobalIPv6PrefixLen":0,"MacAddress":f"02:42:ac:11:00:{number:02x}",
                  "Aliases":[service],"DNSNames":[service]}
        networks={"carry-net":endpoint}
        if service=="ai-bus": networks[module.LOCAL_MODEL_NETWORK]={**endpoint,"NetworkID":"f"*64}
        running=state=="active"
        result.append({"Id":f"{number:064x}","Name":"/carry-"+service,"Image":"sha256:"+f"{number+100:064x}",
                       "Config":{"Image":"ai-pin-revival/"+service+":carry","Labels":labels,"Env":["SECRET=hashed-only"]},
                       "HostConfig":{"NetworkMode":"default","ReadonlyRootfs":True},
                       "State":{"Running":running,"Status":"running" if running else "exited",
                                "Health":{"Status":"healthy" if running else "unhealthy"}},
                       "Mounts":mounts(service),"NetworkSettings":{"Networks":networks}})
    return result
volumes=[{"Name":name,"Driver":"local","Mountpoint":"/var/lib/docker/volumes/"+name+"/_data",
          "Scope":"local","Labels":{"carry":"retained"},"Options":None} for name in module.VOLUME_NAMES]
networks=[{"Name":name,"Id":("a" if number==0 else "b")*64,"Created":"2026-01-01T00:00:00Z",
           "Scope":"local","Driver":"bridge","EnableIPv6":False,"IPAM":{"Driver":"default","Config":[]},
           "Internal":False,"Attachable":False,"Ingress":False,"ConfigFrom":{"Network":""},
           "ConfigOnly":False,"Options":{},"Labels":{"carry":"retained"},"Peers":None}
          for number,name in enumerate((module.LOCAL_MODEL_NETWORK,module.ROLLBACK_NETWORK))]
wrong_edge_mount=containers("active")
edge=next(item for item in wrong_edge_mount if item["Config"]["Labels"]["com.docker.compose.service"]=="edge")
edge["Mounts"][0]["Source"]=module.REMOTE_ROOT+"/private/copied-server.crt"
try:
    module.build_observation(wrong_edge_mount,volumes,networks,"active","a"*64,
                             config_paths=tuple(config),center_data_path=center,resource_paths=resources)
except SystemExit: pass
else: raise AssertionError("legacy edge certificate copy was accepted as the deployed Carry mount")
active=module.build_observation(containers("active"),volumes,networks,"active","a"*64,
                                config_paths=tuple(config),center_data_path=center,resource_paths=resources)
record=module.make_record(active,"b"*64,"c"*64,"d"*64)
module.validate_record(record)
module.verify_live(record,active,"active","b"*64,"c"*64,"d"*64)
stopped=module.build_observation(containers("stopped"),volumes,networks,"stopped",None,
                                 config_paths=tuple(config),center_data_path=center,resource_paths=resources)
module.verify_live(record,stopped,"stopped","b"*64,"c"*64,"d"*64)

attacks=[]
for mutate in (
    lambda value: value["services"][0].__setitem__("imageId","sha256:"+"9"*64),
    lambda value: value["services"][1].__setitem__("containerId","8"*64),
    lambda value: value["services"][2].__setitem__("configSha256","7"*64),
    lambda value: value["services"][3]["mounts"][0].__setitem__("Name","humane-cosmos-clone_cosmos-state"),
    lambda value: value["services"][4]["networks"].clear(),
    lambda value: value["configurations"][0]["entries"][0].__setitem__("sha256","6"*64),
    lambda value: value["volumes"][0].__setitem__("Name","humane-cosmos-clone_cosmos-state"),
    lambda value: value["centerData"].__setitem__("inode",value["centerData"]["inode"]+1),
):
    attacked=copy.deepcopy(active); mutate(attacked); attacks.append(attacked)
for attacked in attacks:
    try: module.verify_live(record,attacked,"active","b"*64,"c"*64,"d"*64)
    except SystemExit: pass
    else: raise AssertionError("tampered live observation was accepted")
for candidate,release,authority in (("e"*64,"c"*64,"d"*64),("b"*64,"e"*64,"d"*64),("b"*64,"c"*64,"e"*64)):
    try: module.verify_live(record,active,"active",candidate,release,authority)
    except SystemExit: pass
    else: raise AssertionError("wrong registrar binding was accepted")
false_claim=copy.deepcopy(record); false_claim["registrar"]["providerEvidence"]="provider-built-runtime"
try: module.validate_record(false_claim)
except SystemExit: pass
else: raise AssertionError("false old-image provider provenance was accepted")

privileged={}
for name,(root,uid,gid) in module.PRIVILEGED_CONFIG_PATHS.items():
    privileged[name]={"root":root,"entries":[{"path":".","kind":"directory","device":1,"inode":2,
        "mode":0o700,"uid":uid,"gid":gid,"links":2,"size":4096,"mtimeNs":3,"ctimeNs":4}]}
module.validate_privileged_configurations(privileged)
wrong_owner=copy.deepcopy(privileged); wrong_owner["attestation-pki"]["entries"][0]["uid"]=0
try: module.validate_privileged_configurations(wrong_owner)
except SystemExit: pass
else: raise AssertionError("privileged Carry PKI owner substitution was accepted")

store=os.path.join(fixture,"store-root"); os.mkdir(store,0o700); module.REMOTE_ROOT=store
baseline=module.register_record(store,record)
assert baseline==module.register_record(store,record)
assert module.read_record(store,baseline)==record
assert open(os.path.join(store,module.STORE_BASENAME,"active"),encoding="utf-8").read()==baseline+"\n"
assert (os.stat(os.path.join(store,module.STORE_BASENAME,"active")).st_mode&0o777)==0o400
different=copy.deepcopy(record); different["registrar"]["deploymentAuthoritySha256"]="e"*64
try: module.register_record(store,different)
except SystemExit: pass
else: raise AssertionError("retry replaced an active baseline")
record_path=os.path.join(store,module.STORE_BASENAME,baseline+".json")
os.chmod(record_path,0o600)
try: module.read_record(store,baseline)
except SystemExit: pass
else: raise AssertionError("writable baseline record was accepted")
print(len(attacks))
`;
  const result = spawnSync("/usr/bin/python3", ["-I", "-B", "-c", script, baselineTool], {
    encoding: "utf8",
    timeout: 30_000,
    env: { HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/usr/sbin", TZ: "UTC" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "8");
});

test("registration is a dedicated no-runtime-mutation command with held provider authority", () => {
  assert.match(productionCli, /registerCarryBaseline[\s\S]*register-carry-baseline\.sh/u);
  assert.match(localDeploy, /BASH_SOURCE\[1\][\s\S]*register-carry-baseline\.sh/u);
  assert.doesNotMatch(localDeploy, /--(?:register|adopt)-carry-baseline/u,
    "normal deploy accepted a hidden baseline override flag");
  assert.match(registrar, /point-of-use-reverified[\s\S]*observed-live-runtime-not-provider-built/u);
  assert.match(registrar, /flock -n 9[\s\S]*value\.get\("active"\)==\[\]/u);
  assert.match(registrar, /capture_adopted_live_carry_observation "\$first" active[\s\S]*"\$second" active[\s\S]*cmp -s/u);
  assert.equal((registrar.match(/^assert_active_durable_mounts$/gmu) ?? []).length, 4,
    "registration must re-prove exact mounts and alternate-writer absence at both captures and publication");
  assert.match(library, /write_exact_carry_security_identity[\s\S]*"attestation-pki":\("\/home\/anders\/carry-attest",65532,65532\)[\s\S]*write_privileged_carry_configuration_inventory[\s\S]*--privileged-config-fd 6/u);
  assert.doesNotMatch(`${registrar}\n${library}`, /docker\s+(?:stop|start|rm|run|compose|image\s+rm|volume\s+(?:create|rm)|network\s+(?:create|rm))\b/u);
  for (const invocation of library.matchAll(/docker\s+([^\n]+)/gu)) {
    assert.match(invocation[0], /docker (?:ps|inspect|volume inspect|network inspect)\b/u,
      `registrar reached a non-read-only Docker operation: ${invocation[0]}`);
  }
});

test("missing services and simultaneous canonical containers fail before any mutable Docker operation", () => {
  for (const scenario of ["missing", "simultaneous"]) {
    const script = String.raw`
set -euo pipefail
source "$1"
scenario="$2"; trace="$3"
PROJECT=ai-pin-revival
LEGACY_PROJECT=humane-carry-clone
fail() { printf '%s\n' "$*" >&2; return 1; }
docker() {
  printf '%s\n' "$*" >>"$trace"
  if [[ "$*" == *"label=com.docker.compose.project=$PROJECT"* ]]; then
    [[ "$scenario" != simultaneous ]] || printf '%064x\n' 900
    return 0
  fi
  if [[ "$*" == *"label=com.docker.compose.project=$LEGACY_PROJECT"* ]]; then
    for ((number=1;number<=14;number++)); do printf '%064x\n' "$number"; done
    return 0
  fi
  return 97
}
if capture_adopted_live_carry_observation "$4" active; then exit 91; fi
[[ ! -e "$4" ]]
`;
    const trace = path.join("/tmp", `revival-carry-baseline-${process.pid}-${scenario}.trace`);
    const output = `${trace}.json`;
    const result = spawnSync("/usr/bin/bash", ["-c", script, "baseline-hostile", path.join(ROOT,
      "platform/deploy/vps/remote/lib/carry-baseline.sh"), scenario, trace, output], {
      encoding: "utf8",
      env: { HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PATH: "/usr/bin:/usr/sbin", TZ: "UTC" },
    });
    assert.equal(result.status, 0, result.stderr);
    const invocations = readFileSync(trace, "utf8");
    assert.doesNotMatch(invocations, /^(?:stop|start|rm|run|compose|create|pull|build)\b/mu);
    assert.match(invocations, /^ps -a --no-trunc -q/u);
    rmSync(trace, { force: true });
    rmSync(output, { force: true });
  }
});

test("wrong or missing Carry resources refuse before incoming creation, upload, or image removal", () => {
  const match = localLibrary.match(/remote_preupload_gate\(\) \{[\s\S]*?<<'REMOTE'\n(?<body>[\s\S]*?)\nREMOTE\n\}/u);
  assert.ok(match?.groups?.body, "remote pre-upload gate body was not found");
  assert.match(match.groups.body,
    /mapfile -t all_containers[\s\S]*ps -aq --no-trunc[\s\S]*4< <\("\$\{docker\[@\]\}" inspect "\$\{all_containers\[@\]\}"\)[\s\S]*all_body=json\.load\(os\.fdopen\(4\)\)/u,
    "pre-upload did not inspect every retained container for alternate security writers");
  assert.match(match.groups.body,
    /assert \(item_project,item_service,source,mount\.get\("Destination"\)\) in allowed[\s\S]*mount\.get\("RW"\) is False/u,
    "pre-upload did not close security mounts to exact read-only project/service targets");
  const gateCall = localDeploy.indexOf('remote_preupload_gate "$release_id"');
  const incomingCreation = localDeploy.indexOf('run_ssh "$REMOTE_CLEAN_PYTHON', gateCall);
  assert.ok(gateCall >= 0 && incomingCreation > gateCall,
    "incoming creation/upload became reachable before the read-only resource gate");

  for (const scenario of ["missing-volume", "wrong-volume", "missing-network", "simultaneous"]) {
    const fixture = mkdtempSync(path.join(os.tmpdir(), `revival-preupload-${scenario}-`));
    try {
      chmodSync(fixture, 0o700);
      const root = path.join(fixture, "protected-root");
      const center = path.join(fixture, "carry-center-data");
      const fakeBin = path.join(fixture, "bin");
      const fakeDocker = path.join(fakeBin, "docker");
      const trace = path.join(fixture, "docker.trace");
      const mutationRoot = path.join(fixture, "MUTATION");
      mkdirSync(root, { mode: 0o700 });
      mkdirSync(center, { mode: 0o700 });
      mkdirSync(fakeBin, { mode: 0o700 });
      writeFileSync(fakeDocker, String.raw`#!/usr/bin/bash
set -euo pipefail
printf '%s\n' "$*" >>"$TRACE"
[[ "\${1:-}" != --host ]] || shift 4
case "$SCENARIO:$1:$2" in
  missing-volume:volume:inspect) exit 1 ;;
  wrong-volume:volume:inspect) printf '%s\n' humane-cosmos-clone_cosmos-state ;;
  missing-network:volume:inspect|simultaneous:volume:inspect) printf '%s\n' "\${!#}" ;;
  missing-network:network:inspect) exit 1 ;;
  simultaneous:network:inspect) printf '%s\n' "\${!#}" ;;
  simultaneous:ps:-q)
    if [[ "$*" == *ai-pin-revival* ]]; then printf '%064d\n' 1; else printf '%064d\n' 2; fi
    ;;
  *) exit 97 ;;
esac
`, { mode: 0o700 });
      const releaseId = "a".repeat(64);
      const incoming = path.join(root, "incoming", releaseId);
      const transformed = match.groups.body
        .replaceAll("/usr/bin/docker", fakeDocker)
        .replaceAll("/home/anders/ai-pin-revival", root)
        .replaceAll("/home/anders/carry-center-data", center)
        .replace(/carry_security_digest\(\) \{[\s\S]*?\nPY\n\}/u,
          `carry_security_digest() { printf '%s\\n' '${"f".repeat(64)}'; }`)
        .replaceAll("exit 1", "return 1");
      const script = `${transformed}\n`;
      const wrapped = [
        "set -euo pipefail",
        "gate() {",
        script,
        "}",
        "if gate \"$@\"; then",
        "  mkdir -p -- \"$MUTATION_ROOT/incoming\"",
        "  printf uploaded >\"$MUTATION_ROOT/upload\"",
        `  ${JSON.stringify(fakeDocker)} image rm forbidden`,
        "  exit 91",
        "fi",
        "exit 0",
      ].join("\n");
      const host = spawnSync("/usr/bin/hostname", ["-s"], { encoding: "utf8" }).stdout.trim();
      const user = spawnSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).stdout.trim();
      const result = spawnSync("/usr/bin/bash", ["--noprofile", "--norc", "-s", "--",
        host, user, "aarch64", root, releaseId, "0", "0", incoming], {
        input: wrapped,
        encoding: "utf8",
        env: {
          HOME: "/nonexistent", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", MUTATION_ROOT: mutationRoot,
          PATH: "/usr/bin:/usr/sbin", SCENARIO: scenario, TRACE: trace, TZ: "UTC",
        },
      });
      assert.equal(result.status, 0, `${scenario}: ${result.stderr}`);
      assert.equal(existsSync(incoming), false, `${scenario}: incoming directory was created`);
      assert.equal(existsSync(mutationRoot), false, `${scenario}: an upload/mutation marker was reached`);
      const invocations = readFileSync(trace, "utf8");
      for (const invocation of invocations.trim().split("\n")) {
        const command = invocation.replace(/^--host \S+ --config \S+ /u, "");
        assert.match(command, /^(?:volume inspect|network inspect|ps)\b/u,
          `${scenario}: pre-upload gate reached mutable Docker command ${command}`);
      }
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }
});

test("first deploy and exceptional rollback consume only the exact immediate observed predecessor", () => {
  const preflightVerify = preflight.indexOf("verify_adopted_live_carry");
  const preflightCleanup = preflight.indexOf("cleanup_project_images");
  assert.ok(preflightVerify >= 0 && preflightCleanup > preflightVerify,
    "preflight cleanup preceded adopted Carry equality proof");

  const selected = deploy.indexOf("carry_baseline_id=\"$(active_adopted_live_carry_id)\"");
  const bound = deploy.indexOf("$record/carry-baseline-id", selected);
  const quiescing = deploy.lastIndexOf("--namespace deploy --operation-action quiescing");
  const boundaryVerify = deploy.indexOf("Carry predecessor changed at the first-cutover quiescence boundary", quiescing);
  const stopLegacy = deploy.indexOf('stop_project_containers "$LEGACY_PROJECT"', boundaryVerify);
  assert.ok(selected >= 0 && bound > selected && quiescing > bound && boundaryVerify > quiescing && stopLegacy > boundaryVerify,
    "first cutover did not bind and reprove its baseline before quiescing/stopping Carry");
  assert.match(deploy, /if \[\[ -n "\$old_current" \]\][\s\S]*verify_hosted_rollback_baseline[\s\S]*else[\s\S]*active_adopted_live_carry_id/u,
    "routine canonical and exceptional observed predecessors share authority");

  const legacySelection = rollback.indexOf("legacy rollback lacks its one-time adopted-live-carry-v1 binding");
  const stoppedProof = rollback.indexOf('verify_adopted_live_carry "$carry_baseline_id" stopped', legacySelection);
  const firstMutation = rollback.indexOf("rollback_started=1", stoppedProof);
  const finalProof = rollback.indexOf("Carry predecessor identity changed at the legacy activation boundary", firstMutation);
  const startLegacy = rollback.indexOf('start_recorded_containers "$record/before/running-containers.txt"', finalProof);
  assert.ok(legacySelection >= 0 && stoppedProof > legacySelection && firstMutation > stoppedProof &&
    finalProof > firstMutation && startLegacy > finalProof,
  "legacy rollback did not prove the stopped observed predecessor before mutation and activation");
  assert.match(rollback, /if \[\[ -z "\$target_release" && -z "\$target_record" \]\][\s\S]*target_kind=legacy[\s\S]*elif[\s\S]*retained offline candidate/u);
});
