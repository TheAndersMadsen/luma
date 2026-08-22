import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "../../..");
const require = createRequire(import.meta.url);
const gates = require("../../cli/gates.js");
const debug = require("../../cli/pin-debug.js");
const debugStore = path.join(root, "platform/containers/pin-builder/debug-store.py");
const entrypoint = path.join(root, "platform/containers/pin-builder/entrypoint.sh");

function python(script, arguments_ = []) {
  return spawnSync("/usr/bin/python3", ["-B", "-c", script, debugStore, ...arguments_], {
    cwd: root,
    encoding: "utf8",
    env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" },
  });
}

function importStore() {
  return String.raw`
import importlib.util, sys
spec = importlib.util.spec_from_file_location("revival_debug_store_test", sys.argv[1])
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
`;
}

test("debug role routing and syntax retain the exact five-role contract", () => {
  assert.deepEqual(debug.DEBUG_ROLES, [
    "installer", "bootstrap", "hook", "server", "hook-injector",
  ]);
  assert.deepEqual(debug.rolesForChangedPath("pin/runtime/core/src/lib.rs"), ["server"]);
  assert.deepEqual(debug.rolesForChangedPath("pin/contracts/x.proto"), ["hook", "server"]);
  assert.deepEqual(debug.rolesForChangedPath("unknown"), debug.DEBUG_ROLES);
  assert.deepEqual(debug.selectChangedRoles([
    "pin/hook/payload/src/X.kt", "pin/runtime/core/src/lib.rs",
  ]), ["hook", "server"]);
  assert.deepEqual(debug.parseDebugBuildSyntax([
    "--role", "server", "--role", "hook",
  ]), { requested: ["server", "hook"], changed: false, base: undefined });
  assert.throws(() => debug.parseDebugBuildSyntax([]), /at least one --role/u);
  assert.throws(
    () => debug.parseDebugBuildSyntax(["--changed", "--role", "hook"]),
    /cannot be combined/u,
  );
});

test("usage remains 64 while native preflight failures remain operational status 1", () => {
  const bad = spawnSync("/usr/bin/node", ["./revival", "pin", "build-debug", "--wat"], {
    cwd: root, encoding: "utf8",
  });
  assert.equal(bad.status, 64);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-arm-no-write-"));
  const data = path.join(temporary, "data");
  const refused = spawnSync("/usr/bin/node", ["./revival", "pin", "build-debug", "--role", "hook"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, REVIVAL_DATA_DIR: data, REVIVAL_BUILD_DIR: path.join(data, "build") },
  });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /native hosted linux\/amd64/u);
  assert.equal(fs.existsSync(data), false);
});

test("check and debug each call one broker and changed selection stays inside it", () => {
  const calls = [];
  gates.pinContributorCheck({
    preflight() { calls.push("check-preflight"); },
    sessionRunner(...arguments_) { calls.push(arguments_.slice(0, 2)); },
  });
  debug.pinDebugBuild(["--changed", "--base", "origin/main"], {
    preflight() { calls.push("debug-preflight"); },
    sessionRunner(...arguments_) { calls.push(arguments_.slice(0, 2)); },
  });
  assert.deepEqual(calls, [
    "check-preflight", ["check", {}],
    "debug-preflight", ["debug", { changed: true, base: "origin/main" }],
  ]);
  const explicit = debug.debugBuildInvocations(["hook", "server"]);
  assert.deepEqual(explicit.brokerArguments.slice(-4), [
    "--role", "hook", "--role", "server",
  ]);
  assert.equal(JSON.stringify(explicit).includes("--mount"), false);
});

test("the broker surface has no fragmented preparation or destructive cleanup commands", () => {
  const store = fs.readFileSync(debugStore, "utf8");
  const gatesSource = fs.readFileSync(path.join(root, "platform/cli/gates.js"), "utf8");
  for (const removed of [
    "prepare-host-lane", "prepare-lane", "exec-docker", "latest.json",
    "os.unlink(", "os.rmdir(", "os.replace(",
  ]) assert.equal(store.includes(removed), false, removed);
  for (const removed of [
    "preparePinBuilderLaneDirectories", "pinBuilderDockerInvocation",
    "pinContributorEnvironment", "capturePinBuilderRootAuthorization",
  ]) assert.equal(gatesSource.includes(removed), false, removed);
  assert.match(store, /class ContinuousLaneSession/u);
  assert.match(store, /class ContainerLaneSession/u);
  assert.match(store, /class AppendOnlyDebugStore/u);
});

test("watch-before-target fixed and random directories work on fresh and warm runs", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-watched-warm-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, sys
base = sys.argv[2]
observed = []
for _ in range(2):
    with module.WatchedAuthorityTree() as tree:
        parent = tree.open_absolute(base, "fixture parent", private_final=True, contents_mutable=True)
        fixed = tree.create_fixed_child(parent, "fixed", "fixed directory", contents_mutable=True)
        nested = tree.create_fixed_child(fixed, "nested", "nested directory", contents_mutable=True)
        observed.append((os.fstat(fixed.descriptor).st_ino, os.fstat(nested.descriptor).st_ino))
        tree.revalidate_all()
assert observed[0] == observed[1]
for value in (base, base + "/fixed", base + "/fixed/nested"):
    assert os.stat(value, follow_symlinks=False).st_mode & 0o777 == 0o700
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("pre-open mode toggles and same-name substitutions are rejected before writes", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-watched-race-"));
  fs.chmodSync(temporary, 0o700);
  const victim = path.join(temporary, "victim");
  fs.mkdirSync(victim, { mode: 0o700 });
  fs.writeFileSync(path.join(victim, "sentinel"), "unchanged\n", { mode: 0o600 });
  const result = python(importStore() + String.raw`
import os, sys
base, victim = sys.argv[2:4]
with module.WatchedAuthorityTree() as tree:
    parent = tree.open_absolute(base, "parent", private_final=True, contents_mutable=True)
    os.mkdir("existing", 0o700, dir_fd=parent.descriptor); parent.refresh_contents()
    original = module.WatchedAuthorityTree._open_after_watch
    toggled = False
    def toggle(parent_value, name, label, edge, **options):
        global toggled
        if name == "existing" and not toggled:
            os.chmod(name, 0o755, dir_fd=parent_value.descriptor, follow_symlinks=False)
            os.chmod(name, 0o700, dir_fd=parent_value.descriptor, follow_symlinks=False)
            toggled = True
        return original(parent_value, name, label, edge, **options)
    module.WatchedAuthorityTree._open_after_watch = staticmethod(toggle)
    try:
        tree.open_existing_child(parent, "existing", "existing", contents_mutable=True)
        raise AssertionError("toggle was accepted")
    except module.StoreError: pass
    module.WatchedAuthorityTree._open_after_watch = staticmethod(original)

with module.WatchedAuthorityTree() as tree:
    parent = tree.open_absolute(base, "parent", private_final=True, contents_mutable=True)
    original = module.WatchedAuthorityTree._open_after_watch; swapped = False
    def substitute(parent_value, name, label, edge, **options):
        global swapped
        if options.get("created_token") and not swapped:
            os.rename(name, name + ".held", src_dir_fd=parent_value.descriptor,
                      dst_dir_fd=parent_value.descriptor)
            os.symlink(victim, name, dir_fd=parent_value.descriptor); swapped = True
        return original(parent_value, name, label, edge, **options)
    module.WatchedAuthorityTree._open_after_watch = staticmethod(substitute)
    try:
        tree.create_random_child(parent, ".random.", "random", contents_mutable=True)
        raise AssertionError("substitution was accepted")
    except (module.StoreError, OSError): pass
    module.WatchedAuthorityTree._open_after_watch = staticmethod(original)
    retry = tree.create_random_child(parent, ".random.", "random retry", contents_mutable=True)
    retry.revalidate()
assert open(victim + "/sentinel", encoding="utf-8").read() == "unchanged\n"
`, [temporary, victim]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(victim, "sentinel"), "utf8"), "unchanged\n");
});

test("all check/debug state and cache mounts remain descriptor-stable after plan substitution", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-mount-authority-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, sys
fixture = sys.argv[2]
def source_tree(token):
    source = os.path.join(fixture, "source-" + token)
    for relative in ("platform/deploy/acceptance", "platform/containers/pin-builder"):
        os.makedirs(os.path.join(source, relative), mode=0o700)
    files = {
        "platform/deploy/acceptance/source-policy.sh": "#!/bin/sh\nexit 0\n",
        "platform/containers/pin-builder/Dockerfile": "FROM scratch\n",
        "platform/containers/pin-builder/entrypoint.sh": "#!/bin/sh\n",
        "platform/containers/pin-builder/debug-store.py": "# fixture\n",
        "platform/containers/pin-builder/toolchain.json": "{}\n",
    }
    for relative, value in files.items():
        filename=os.path.join(source,relative); open(filename,"w",encoding="utf-8").write(value)
        os.chmod(filename, 0o755 if relative.endswith("source-policy.sh") else 0o600)
    return source
module.require_native_linux_amd64 = lambda: None
for lane in ("check", "debug"):
    for target_index in range(7):
        token=f"{lane}-{target_index}"; source=source_tree(token)
        data=os.path.join(fixture,"data-"+token); build=os.path.join(data,"build")
        session=module.ContinuousLaneSession(data,build,source,lane); captured=[]
        image_id="sha256:"+"1"*64
        session.inspect_image_id=lambda reference:image_id
        session.docker_child=lambda arguments,**kwargs: captured.append(tuple(arguments))
        session.run_builder(image_id,"fixture:image", () if lane == "check" else ("hook",))
        assert image_id in captured[0]
        assert "fixture:image" not in captured[0]
        mounts=[captured[0][i+1] for i,value in enumerate(captured[0]) if value=="--mount"]
        assert len(mounts)==8 and all("src=/proc/" in value and "/fd/" in value for value in mounts)
        assert any("dst=/run/revival-source.tar" in value for value in mounts)
        assert any("dst=/run/revival-source-manifest.json" in value for value in mounts)
        assert session._docker_environment()["DOCKER_CONFIG"].startswith("/proc/self/fd/")
        target=[session.state,*session.cache_leaves,session.docker_config][target_index]
        before=os.fstat(target.descriptor); assert target.parent is not None and target.name is not None
        os.rename(target.name,target.name+".held",src_dir_fd=target.parent.descriptor,dst_dir_fd=target.parent.descriptor)
        os.mkdir(target.name,0o700,dir_fd=target.parent.descriptor)
        replacement=os.stat(target.name,dir_fd=target.parent.descriptor,follow_symlinks=False)
        stable=os.stat(target.broker_path)
        assert (stable.st_dev,stable.st_ino)==(before.st_dev,before.st_ino)
        assert replacement.st_ino!=before.st_ino
        assert os.listdir(os.path.join(target.parent.broker_path,target.name))==[]
        session.close()
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("trusted child execution preserves nonzero status and signal", () => {
  const result = python(importStore() + String.raw`
import signal
with module.WatchedAuthorityTree() as tree:
    shell=tree.open_file_absolute("/usr/bin/dash","shell",root_owned=True,executable=True)
    environment={"LANG":"C","LC_ALL":"C"}
    try: module.run_held_child(shell,("-c","exit 37"),tree=tree,environment=environment); raise AssertionError()
    except module.ChildStatus as error: assert error.status==37
    try: module.run_held_child(shell,("-c","kill -TERM $$"),tree=tree,environment=environment); raise AssertionError()
    except module.ChildSignal as error: assert error.signum==signal.SIGTERM
`);
  assert.equal(result.status, 0, result.stderr);
});

test("credential-free compiler topology is fresh and persists only five cache leaves", () => {
  const store = fs.readFileSync(debugStore, "utf8");
  const shell = fs.readFileSync(entrypoint, "utf8");
  for (const leaf of [
    "cargo-registry", "cargo-git", "gradle-caches", "gradle-wrapper", "npm-cacache",
  ]) assert.equal(store.includes(`("${leaf}", "/cache-data/${leaf}")`), true, leaf);
  for (const forbidden of [
    "init.gradle", "gradle.properties", "credentials.toml", ".android/debug.keystore",
  ]) {
    // These names may (and for credentials.toml must) occur in the sealed-source
    // denylist.  What is forbidden is creating, mounting, or routing a compiler
    // control file at one of those paths.
    assert.doesNotMatch(
      store,
      new RegExp(`(?:create_named_file|open_file_absolute|child_path|symlink)[^\\n]*${forbidden.replaceAll(".", "\\\\.")}`, "u"),
      forbidden,
    );
  }
  assert.match(store, /fresh credential-free tool root/u);
  assert.match(store, /self\.npm_cache = self\._directory\("npm-cache", "fresh npm cache root"\)/u);
  assert.match(store, /self\.npm_cache,[\s\S]*"_cacache",[\s\S]*self\.cache_leaves\[4\]/u);
  assert.match(store, /"NPM_CONFIG_CACHE": self\.npm_cache\.child_path/u);
  assert.doesNotMatch(store, /"NPM_CONFIG_CACHE": self\.cache_leaves\[4\]\.child_path/u);
  assert.match(shell, /cargo test --locked/u);
  assert.match(shell, /cargo check --locked --all-targets --features local-nlu,iroh/u);
  assert.match(store, /container-private ephemeral compiler workspace/u);
  assert.match(store, /REVIVAL_PIN_EPHEMERAL_COMPILER_SOURCE/u);
  assert.doesNotMatch(store, /worktree.*container lane/u);
  assert.match(shell, /ephemeral compiler source is not descriptor-held/u);
  assert.match(shell, /REVIVAL_PIN_LANE_INNER/u);
  assert.match(shell, /\/usr\/bin\/python3 -B "\$\{DEBUG_STORE_TOOL\}" build-publish/u);
});

function syntheticPublicationScript(extra) {
  return importStore() + String.raw`
import hashlib, json, os, sys
root=sys.argv[2]; data=b"debug-apk-fixture"; digest=hashlib.sha256(data).hexdigest()
receipt={"schema":"revival.pin-debug-artifact","version":2,"role":"hook",
"package":module.ROLE_PACKAGES["hook"],"variant":"debug","versionName":"fixture","versionCode":1,
"minSdk":31,"targetSdk":32,"debuggable":True,"payloadComplete":False,"release":False,
"installable":False,"signerSha256":"1"*64,"sha256":digest,"size":len(data)}
with module.AppendOnlyDebugStore(root) as store:
    stage=store.allocate_stage(); directory=stage.name
    store.tree.create_named_file(stage,"hook.apk","apk",data)
    rb=json.dumps(receipt,sort_keys=True,separators=(",", ":")).encode()+b"\n"
    store.tree.create_named_file(stage,"hook.receipt.json","receipt",rb)
    sid=store.finalize(stage,("hook",),[receipt])
    verified=store.verify_set(directory,sid); store.append_selection(verified)
` + extra;
}

test("append-only publication verifies normally and retirement never removes set bytes", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-append-publish-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(syntheticPublicationScript(String.raw`
with module.AppendOnlyDebugStore(root) as store:
    latest=store.latest()
    assert latest.directory.name==directory and latest.set_id==sid and latest.roles==("hook",)
stage_path=root+"/sets/"+directory
before={name:os.stat(stage_path+"/"+name,follow_symlinks=False).st_ino for name in os.listdir(stage_path)}
module.discard(root,stage_path)
after={name:os.stat(stage_path+"/"+name,follow_symlinks=False).st_ino for name in os.listdir(stage_path)}
assert before==after
try: module.select_latest(root); raise AssertionError("retired set selected")
except module.StoreError: pass
`), [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("hardlinked set files and selection records fail closed without victim mutation", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-append-hardlink-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(syntheticPublicationScript(String.raw`
outside=root+"/outside"; os.link(root+"/sets/"+directory+"/hook.apk",outside)
before=os.stat(outside,follow_symlinks=False)
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("hardlink accepted")
except module.StoreError: pass
after=os.stat(outside,follow_symlinks=False)
assert (before.st_ino,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
segment=root+"/selections/segments/segment-0"
selection=next(name for name in os.listdir(segment) if name.startswith("record-"))
outside_selection=root+"/outside-selection"; os.link(segment+"/"+selection,outside_selection)
before=os.stat(outside_selection,follow_symlinks=False)
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("selection hardlink accepted")
except module.StoreError: pass
after=os.stat(outside_selection,follow_symlinks=False)
assert (before.st_ino,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
`), [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("selection mode toggles and last-check exchanges never publish a victim", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-selection-race-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, sys
root=sys.argv[2]
with module.AppendOnlyDebugStore(root) as store:
    stage=store.allocate_stage(); watcher=module.DirectoryEventWatcher(stage.descriptor,"empty set")
    verified=module.VerifiedSet(stage,"1"*64,("hook",),{},(),watcher)
    original=module.MetadataWatcher.__init__; changed=False
    def toggle(self,descriptor,label):
        global changed
        original(self,descriptor,label)
        if label=="append-only debug journal record unnamed destination" and not changed:
            os.fchmod(descriptor,0o644); os.fchmod(descriptor,0o600); changed=True
    module.MetadataWatcher.__init__=toggle
    try: store.append_selection(verified); raise AssertionError("toggle accepted")
    except module.StoreError: pass
    module.MetadataWatcher.__init__=original
assert not any(name.startswith("record-") for base,dirs,files in os.walk(root+"/selections") for name in files)
victim=root+"/victim"; open(victim,"wb").write(b"victim"); os.chmod(victim,0o600)
root=root+"-exchange"; os.mkdir(root,0o700)
with module.AppendOnlyDebugStore(root) as store:
    stage=store.allocate_stage(); watcher=module.DirectoryEventWatcher(stage.descriptor,"empty set")
    verified=module.VerifiedSet(stage,"2"*64,("hook",),{},(),watcher)
    original=store.tree.create_named_file; attack={}
    def exchange(parent,name,label,contents):
        created=original(parent,name,label,contents)
        if "journal record" not in label: return created
        os.rename(created.name,created.name+".held",src_dir_fd=parent.descriptor,dst_dir_fd=parent.descriptor)
        os.link(victim,created.name,dst_dir_fd=parent.descriptor)
        attack["before"]=os.stat(victim,follow_symlinks=False); return created
    store.tree.create_named_file=exchange
    try: store.append_selection(verified); raise AssertionError("exchange accepted")
    except module.StoreError: pass
after=os.stat(victim,follow_symlinks=False); before=attack["before"]
assert (before.st_ino,before.st_nlink,before.st_size,before.st_mtime_ns,before.st_ctime_ns)==(after.st_ino,after.st_nlink,after.st_size,after.st_mtime_ns,after.st_ctime_ns)
assert open(victim,"rb").read()==b"victim"
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("one sealed source generation binds policy selection build and run bytes", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-sealed-generation-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, sys
base=sys.argv[2]; module.lock_process_descriptor_authority()
for lane in ("check","debug"):
    source=os.path.join(base,"source-"+lane)
    os.makedirs(os.path.join(source,"pin/runtime/core/src"),mode=0o700)
    os.makedirs(os.path.join(source,".git/info"),mode=0o700)
    open(os.path.join(source,".git/info/exclude"),"wb").write(b"AGENTS.md\n")
    target=os.path.join(source,"pin/runtime/core/src/lib.rs")
    open(target,"wb").write(b"one\n"); os.chmod(target,0o600)
    open(os.path.join(source,"AGENTS.md"),"wb").write(
        b"# Ai-Pin-Revival \xe2\x80\x94 working context\n"
        b"<!-- Auto-generated from 12 claude-mem observations. Durable knowledge distilled -->\n"
        b"machine-local operator instruction\n")
    with module.WatchedAuthorityTree() as tree:
        held=tree.open_absolute(source,"source",private_final=False,contents_mutable=True)
        first,watch=module.SealedSourceGeneration.capture(held); watch.close()
        second,watch=module.SealedSourceGeneration.capture(held); watch.close()
        assert first.generation==second.generation
        assert module.descriptor_digest(first.tar_descriptor)==module.descriptor_digest(second.tar_descriptor)
        assert all(item.path!="AGENTS.md" for item in first.files)
        open(target,"wb").write(b"two\n")
        record=next(item for item in first.files if item.path=="pin/runtime/core/src/lib.rs")
        assert record.contents==b"one\n" and record.git_oid==module.SealedSourceGeneration._git_blob(b"one\n")
        extraction=tree.create_random_child(held,".extract.","extraction",contents_mutable=True)
        extraction_watch=first.extract_into(extraction)
        assert open(extraction.child_path+"/pin/runtime/core/src/lib.rs","rb").read()==b"one\n"
        extraction_watch.close(); first.close(); second.close()

generic=os.path.join(base,"source-user-agents"); os.makedirs(os.path.join(generic,".git/info"),mode=0o700)
open(os.path.join(generic,".git/info/exclude"),"wb").write(b"AGENTS.md\n")
open(os.path.join(generic,"AGENTS.md"),"wb").write(b"# User-owned build instructions\n")
with module.WatchedAuthorityTree() as tree:
    held=tree.open_absolute(generic,"user AGENTS source",private_final=False,contents_mutable=True)
    generation,watch=module.SealedSourceGeneration.capture(held); watch.close()
    assert any(item.path=="AGENTS.md" for item in generation.files)
    generation.close()

source=os.path.join(base,"source-race"); os.makedirs(source,mode=0o700)
target=os.path.join(source,"payload.rs"); open(target,"wb").write(b"aaaa"); os.chmod(target,0o600)
with module.WatchedAuthorityTree() as tree:
    held=tree.open_absolute(source,"race source",private_final=False,contents_mutable=True)
    original=module.bounded_descriptor_bytes; attacked=False
    def mutate(descriptor,maximum,label):
        global attacked
        value=original(descriptor,maximum,label)
        if label=="payload.rs" and not attacked:
            open(target,"wb").write(b"bbbb"); attacked=True
        return value
    module.bounded_descriptor_bytes=mutate
    try: module.SealedSourceGeneration.capture(held); raise AssertionError("source mutation accepted")
    except module.StoreError: pass
    finally: module.bounded_descriptor_bytes=original

for kind in ("nested-git","generated","private-key","symlink","fifo","hardlink"):
    hostile=os.path.join(base,"hostile-"+kind); os.makedirs(hostile,mode=0o700)
    if kind=="nested-git":
        os.makedirs(os.path.join(hostile,"nested/.git"),mode=0o700)
        open(os.path.join(hostile,"nested/.git/config"),"wb").write(b"hostile")
    elif kind=="generated":
        os.makedirs(os.path.join(hostile,"nested/build"),mode=0o700)
        open(os.path.join(hostile,"nested/build/output"),"wb").write(b"hostile")
    elif kind=="private-key":
        open(os.path.join(hostile,"fixture.pem"),"wb").write(b"private")
    elif kind=="symlink":
        os.symlink(base,os.path.join(hostile,"linked"))
    elif kind=="fifo":
        os.mkfifo(os.path.join(hostile,"pipe"),0o600)
    else:
        first=os.path.join(hostile,"first"); open(first,"wb").write(b"linked")
        os.link(first,os.path.join(hostile,"second"))
    with module.WatchedAuthorityTree() as tree:
        held=tree.open_absolute(hostile,"hostile source",private_final=False,contents_mutable=True)
        try: module.SealedSourceGeneration.capture(held); raise AssertionError(kind+" accepted")
        except module.StoreError: pass
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("changed selection ignores repo config hooks filters attributes and fsmonitor", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-safe-git-plumbing-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, subprocess, sys
base=sys.argv[2]; source=os.path.join(base,"source"); marker=os.path.join(base,"executed")
for relative in ("platform/deploy/acceptance","platform/containers/pin-builder","pin/runtime/core/src"):
    os.makedirs(os.path.join(source,relative),mode=0o700)
files={
 "platform/deploy/acceptance/source-policy.sh":"#!/bin/sh\nexit 0\n",
 "platform/containers/pin-builder/Dockerfile":"FROM scratch\n",
 "platform/containers/pin-builder/entrypoint.sh":"#!/bin/sh\n",
 "platform/containers/pin-builder/debug-store.py":"# fixture\n",
 "platform/containers/pin-builder/toolchain.json":"{}\n",
 "pin/runtime/core/src/lib.rs":"one\n",
 ".gitattributes":"*.rs diff=hostile filter=hostile\n",
}
for relative,value in files.items():
    filename=os.path.join(source,relative); open(filename,"w",encoding="utf-8").write(value)
    os.chmod(filename,0o755 if relative.endswith(".sh") else 0o600)
git_env={"PATH":"/usr/bin:/bin","HOME":base,"LANG":"C","LC_ALL":"C",
 "GIT_CONFIG_NOSYSTEM":"1","GIT_CONFIG_GLOBAL":"/dev/null"}
def git(*args):
    subprocess.run(("/usr/bin/git",*args),cwd=source,env=git_env,check=True,
                   stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
git("init","-b","main"); git("add","--all")
git("-c","user.name=fixture","-c","user.email=fixture@example.invalid","commit","-m","base")
with open(os.path.join(source,".git/info/exclude"),"a",encoding="utf-8") as stream:
    stream.write("AGENTS.md\n")
open(os.path.join(source,"AGENTS.md"),"w",encoding="utf-8").write(
    "# Ai-Pin-Revival — working context\n"
    "<!-- Auto-generated from 1 claude-mem observations. Durable knowledge distilled -->\n")
hook=os.path.join(base,"marker.sh")
open(hook,"w",encoding="utf-8").write("#!/bin/sh\nprintf x > '"+marker+"'\n")
os.chmod(hook,0o700)
open(os.path.join(source,".git/config"),"w",encoding="utf-8").write(
 "[core]\n\tfsmonitor = "+hook+"\n\thooksPath = "+base+"\n"
 "[include]\n\tpath = "+hook+"\n[diff \"hostile\"]\n\tcommand = "+hook+"\n"
 "[filter \"hostile\"]\n\tclean = "+hook+"\n\tsmudge = "+hook+"\n")
open(os.path.join(source,"pin/runtime/core/src/lib.rs"),"w",encoding="utf-8").write("two\n")
module.require_native_linux_amd64=lambda:None; module.lock_process_descriptor_authority()
data=os.path.join(base,"data"); build=os.path.join(data,"build")
with module.ContinuousLaneSession(data,build,source,"debug") as session:
    assert session.source_generation.omitted_root_agents
    assert all(item.path!="AGENTS.md" for item in session.source_generation.files)
    assert session.changed_roles("main")==("server",)
    try: session.changed_roles("missing-base"); raise AssertionError("missing base accepted")
    except module.StoreError: pass
assert not os.path.exists(marker)
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("all inotify overflow ignored loss and corrupt events fail closed", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-watch-loss-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, struct, sys
base=sys.argv[2]
def inject(watcher,payload,call):
    original=module.os.read; values=[payload]
    def fake(descriptor,size):
        if descriptor==watcher.descriptor and values: return values.pop(0)
        raise BlockingIOError()
    module.os.read=fake
    try:
        try: call(); raise AssertionError("watch loss accepted")
        except module.StoreError: pass
    finally: module.os.read=original
descriptor=os.open(base,module.DIRECTORY_FLAGS)
try:
    directory=module.DirectoryEventWatcher(descriptor,"directory")
    inject(directory,struct.pack("iIII",-1,module.DirectoryEventWatcher.IN_Q_OVERFLOW,0,0),directory.require_no_changes)
    directory.close()
    metadata=module.MetadataWatcher(descriptor,"metadata")
    inject(metadata,struct.pack("iIII",1,module.MetadataWatcher.IN_IGNORED,0,0),metadata.reject_metadata_change)
    metadata.close()
    recursive=module.RecursiveMutationWatcher(descriptor,"recursive")
    inject(recursive,struct.pack("iIII",1,module.RecursiveMutationWatcher.IN_IGNORED,0,0),recursive.assert_clean)
    recursive.close()
    short=module.DirectoryEventWatcher(descriptor,"short")
    inject(short,b"short",short.require_no_changes); short.close()
finally: os.close(descriptor)
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("compiler copy receipts hash held destination bytes across corruption windows", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-copy-destination-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import os, sys
base=sys.argv[2]; module.lock_process_descriptor_authority()
with module.WatchedAuthorityTree() as tree:
    parent=tree.open_absolute(base,"parent",private_final=True,contents_mutable=True)
    source=tree.create_named_file(parent,"source.apk","source",b"AAAA")
    stage=tree.create_random_child(parent,".stage.","stage",contents_mutable=True)
    original_digest=module.descriptor_digest; corrupted=False
    def corrupt_before(descriptor):
        global corrupted
        if descriptor!=source.descriptor and not corrupted:
            os.pwrite(descriptor,b"B",0); os.fsync(descriptor); corrupted=True
        return original_digest(descriptor)
    module.descriptor_digest=corrupt_before
    try: tree.create_named_file_from_held(stage,"before.apk","before",source); raise AssertionError()
    except module.StoreError: pass
    finally: module.descriptor_digest=original_digest
    assert "before.apk" not in os.listdir(stage.descriptor)

    stage2=tree.create_random_child(parent,".stage.","stage2",contents_mutable=True)
    original_link=module.linkat_empty
    def corrupt_after(descriptor,destination_parent,name):
        os.pwrite(descriptor,b"C",0); os.fsync(descriptor)
        return original_link(descriptor,destination_parent,name)
    module.linkat_empty=corrupt_after
    try: tree.create_named_file_from_held(stage2,"after.apk","after",source); raise AssertionError()
    except module.StoreError: pass
    finally: module.linkat_empty=original_link
    assert not any(name.endswith(".receipt.json") for name in os.listdir(stage2.descriptor))

    source2=tree.create_named_file(parent,"source2.apk","source2",b"DDDD")
    stage3=tree.create_random_child(parent,".stage.","stage3",contents_mutable=True)
    original_pread=module.os.pread; changed=False
    def corrupt_during(descriptor,size,offset):
        global changed
        value=original_pread(descriptor,size,offset)
        if descriptor==source2.descriptor and offset==0 and not changed:
            os.pwrite(descriptor,b"E",0); os.fsync(descriptor); changed=True
        return value
    module.os.pread=corrupt_during
    try: tree.create_named_file_from_held(stage3,"during.apk","during",source2); raise AssertionError()
    except module.StoreError: pass
    finally: module.os.pread=original_pread
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("segmented journal scales past one segment and rejects gaps and retired republish", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-chain-scale-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(importStore() + String.raw`
import hashlib,json,os,sys
root=sys.argv[2]; module.lock_process_descriptor_authority()
with module.AppendOnlyDebugStore(root): pass
os.mkdir(os.path.join(root,"sets",".set.fixture"),0o700)
predecessor=module.CHAIN_ZERO; names=[]
for sequence in range(1,4101):
    base={"schema":"revival.pin-debug-journal","version":2,"sequence":sequence,
      "predecessorSha256":predecessor,"action":"select","directory":".set.fixture",
      "setId":"a"*64,"roles":["hook"]}
    digest=hashlib.sha256(json.dumps(base,sort_keys=True,separators=(",", ":")).encode()).hexdigest()
    record={**base,"recordSha256":digest}; name=f"record-{sequence}-{digest}.json"
    segment=f"segment-{(sequence-1)//module.CHAIN_SEGMENT_SIZE}"
    for mirror in ("segments","anchors","high-water"):
        directory=os.path.join(root,"selections",mirror,segment)
        os.makedirs(directory,mode=0o700,exist_ok=True)
        filename=os.path.join(directory,name)
        open(filename,"wb").write(json.dumps(record,sort_keys=True,separators=(",", ":")).encode()+b"\n")
        os.chmod(filename,0o600)
    names.append((segment,name)); predecessor=digest
with module.AppendOnlyDebugStore(root) as store:
    state=store._read_chain(); assert len(state.records)==4100 and state.next_sequence==4101
segment,name=names[149]; os.unlink(os.path.join(root,"selections","segments",segment,name))
try:
    with module.AppendOnlyDebugStore(root) as store: store._read_chain()
    raise AssertionError("journal gap accepted")
except module.StoreError: pass
`, [temporary]);
  assert.equal(result.status, 0, result.stderr);

  const retired = fs.mkdtempSync(path.join(os.tmpdir(), "revival-retired-republish-"));
  fs.chmodSync(retired, 0o700);
  const retiredResult = python(syntheticPublicationScript(String.raw`
stage_path=root+"/sets/"+directory
module.discard(root,stage_path)
try: module.publish_existing(root,stage_path,("hook",)); raise AssertionError("retired set republished")
except module.StoreError: pass
copy_path=root+"/sets/.set.republish-copy"
os.mkdir(copy_path,0o700)
for name in os.listdir(stage_path):
    source=stage_path+"/"+name; target=copy_path+"/"+name
    with open(source,"rb") as reader, open(target,"xb") as writer: writer.write(reader.read())
    os.chmod(target,0o600)
try: module.publish_existing(root,copy_path,("hook",)); raise AssertionError("retired identity republished under a fresh name")
except module.StoreError: pass
`), [retired]);
  assert.equal(retiredResult.status, 0, retiredResult.stderr);
});

test("journal high-water reconciliation rejects offline mirrored-tail rollback", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-tail-rollback-"));
  fs.chmodSync(temporary, 0o700);
  const result = python(syntheticPublicationScript(String.raw`
segment=root+"/selections/segments/segment-0"
name=next(name for name in os.listdir(segment) if name.startswith("record-"))
os.unlink(segment+"/"+name)
os.unlink(root+"/selections/anchors/segment-0/"+name)
assert os.path.exists(root+"/selections/high-water/segment-0/"+name)
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("two-mirror offline rollback selected an older suffix")
except module.StoreError: pass
`), [temporary]);
  assert.equal(result.status, 0, result.stderr);
});

test("every local tail-loss variant fails closed without selection or retirement resurrection", () => {
  for (const [label, attack] of [
    ["high-water-only", String.raw`
segment=root+"/selections/high-water/segment-0"; name=next(iter(os.listdir(segment))); os.unlink(segment+"/"+name)
`],
    ["all-selection-facts", String.raw`
for mirror in ("segments","anchors","high-water"):
    segment=root+"/selections/"+mirror+"/segment-0"
    for name in os.listdir(segment): os.unlink(segment+"/"+name)
`],
    ["retirement-tail", String.raw`
module.discard(root,root+"/sets/"+directory)
for mirror in ("segments","anchors","high-water"):
    segment=root+"/selections/"+mirror+"/segment-0"
    for name in os.listdir(segment):
        if name.startswith("record-2-"): os.unlink(segment+"/"+name)
assert os.listdir(root+"/selections/retired-set-ids")
`],
  ]) {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `revival-${label}-`));
    fs.chmodSync(temporary, 0o700);
    const result = python(syntheticPublicationScript(attack + String.raw`
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("lost history selected or resurrected a set")
except module.StoreError: pass
`), [temporary]);
    assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  }
});

test("journal numbers are variable-length canonical decimals without a ceiling", () => {
  const result = python(importStore() + String.raw`
value=10**120+7
assert module.AppendOnlyDebugStore._segment_name(value)=="segment-"+str(value)
assert ":020d" not in open(sys.argv[1],encoding="utf-8").read()
assert ":016d" not in open(sys.argv[1],encoding="utf-8").read()
`);
  assert.equal(result.status, 0, result.stderr);
});

test("operations scope debug-journal rollback separately from release provenance", () => {
  const operations = fs.readFileSync(path.join(root, "docs/operations.md"), "utf8");
  assert.match(
    operations,
    /Deleting any strict subset of the local journal mirrors,[\s\S]*survives fails closed and cannot resurrect an older suffix\./u,
  );
  assert.match(
    operations,
    /remains ineligible for republish,[\s\S]*only while at least one independently reconciled local journal,[\s\S]*recording that retirement survives\./u,
  );
  assert.match(
    operations,
    /the same UID can delete every local journal[\s\S]*doing so can resurrect an older[\s\S]*outside any cryptographic rollback guarantee\./u,
  );
  assert.match(
    operations,
    /GitHub-hosted[\s\S]*release attestations[\s\S]*do not attest, checkpoint, or provide a high-water mark[\s\S]*for this debug journal\./u,
  );
  assert.doesNotMatch(operations, /external trusted high-water attestation/u);
  assert.doesNotMatch(
    operations,
    /retirement makes that checksum-bound set[\s\S]*permanently ineligible/u,
  );
});

test("spoofed guest and CI strings never satisfy hosted native release attestation", () => {
  const result = python(importStore() + String.raw`
import os, stat
os.environ.update({"RUNNER_OS":"Linux","RUNNER_ARCH":"X64","GITHUB_ACTIONS":"true"})
calls=[]
class Executed(Exception): pass
module.os.lstat=lambda path: type("Metadata",(),{"st_mode":stat.S_IFREG|0o555})()
def execve(path,arguments,environment):
    calls.append((path,arguments,environment)); raise Executed()
module.os.execve=execve
try:
    module.require_trusted_hosted_native_attestation("/request","/bundle","/output")
    raise AssertionError("fixed verifier was not executed")
except Executed: pass
assert calls==[(
    "/usr/bin/node",
    (
        "/usr/bin/node",
        "/usr/local/libexec/ai-pin-hosted-attestation/hosted-attestation.mjs",
        "verify-pre","--request","/request","--bundle","/bundle","--output","/output",
    ),
    {"HOME":"/tmp","PATH":"/usr/bin:/bin","LANG":"C.UTF-8","LC_ALL":"C.UTF-8"},
)]
assert not ({"RUNNER_OS","RUNNER_ARCH","GITHUB_ACTIONS"} & calls[0][2].keys())
`);
  assert.equal(result.status, 0, result.stderr);
});

test("Docker tag replacement cannot redirect immutable image-ID execution", () => {
  const result = python(importStore() + String.raw`
from types import SimpleNamespace
session=module.ContinuousLaneSession.__new__(module.ContinuousLaneSession)
session.lane="check"; identifier="sha256:"+"1"*64; replacement="sha256:"+"2"*64
session.source_generation=SimpleNamespace(broker_tar_path="/proc/1/fd/10",broker_manifest_path="/proc/1/fd/11")
session.state=SimpleNamespace(broker_path="/proc/1/fd/12")
session.cache_leaves=[SimpleNamespace(broker_path=f"/proc/1/fd/{20+i}") for i in range(5)]
tag=[identifier]; captured=[]
session.inspect_image_id=lambda reference: tag[0] if reference=="fixture:tag" else identifier
def docker(arguments,**kwargs):
    captured.append(arguments); tag[0]=replacement
session.docker_child=docker
session.run_builder(identifier,"fixture:tag",())
run=captured[0]; assert identifier in run and "fixture:tag" not in run
`);
  assert.equal(result.status, 0, result.stderr);
});

test("publisher code and source enter children only through held immutable descriptors", () => {
  const dockerfile = fs.readFileSync(path.join(root, "platform/containers/pin-builder/Dockerfile"), "utf8");
  const shell = fs.readFileSync(entrypoint, "utf8");
  const wrapper = fs.readFileSync(path.join(root, "platform/containers/pin-builder/publish-debug-set.sh"), "utf8");
  const store = fs.readFileSync(debugStore, "utf8");
  assert.match(dockerfile, /--chmod=0555 --chown=0:0 platform\/containers\/pin-builder\/debug-store\.py/u);
  assert.match(shell, /REVIVAL_HELD_DEBUG_STORE_TOOL/u);
  assert.match(shell, /REVIVAL_HELD_BOOTSTRAP_ALIUHOOK/u);
  assert.match(wrapper, /REVIVAL_HELD_DEBUG_STORE_TOOL/u);
  assert.doesNotMatch(wrapper, /dirname|tool_root/u);
  assert.match(store, /"REVIVAL_HELD_DEBUG_STORE_TOOL": self\.debug_store\.child_path/u);
  assert.match(store, /stdin_descriptor=self\.source_generation\.tar_descriptor/u);
  assert.doesNotMatch(store, /mount\(self\.source,/u);
});

test("verified set and journal readers watch before inventory and reject special or injected entries", () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "revival-verified-reader-"));
  fs.chmodSync(temporary, 0o700);
  const fifoResult = python(syntheticPublicationScript(String.raw`
stage_path=root+"/sets/"+directory; os.mkfifo(stage_path+"/hostile-fifo",0o600)
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("FIFO accepted")
except module.StoreError: pass
`), [temporary]);
  assert.equal(fifoResult.status, 0, fifoResult.stderr);

  const injected = fs.mkdtempSync(path.join(os.tmpdir(), "revival-verified-injected-"));
  fs.chmodSync(injected, 0o700);
  const injectedResult = python(syntheticPublicationScript(String.raw`
stage_path=root+"/sets/"+directory; original=module.os.listdir; attacked=False
# A descriptor-number comparison avoids reopening the set inside the reader.
stage_inode=os.stat(stage_path,follow_symlinks=False).st_ino
def inject(value):
    global attacked
    names=original(value)
    try: inode=os.stat(value).st_ino if isinstance(value,str) else os.fstat(value).st_ino
    except OSError: inode=-1
    if inode==stage_inode and not attacked:
        open(stage_path+"/late-entry","wb").write(b"late"); os.chmod(stage_path+"/late-entry",0o600)
        attacked=True
    return names
module.os.listdir=inject
try:
    with module.AppendOnlyDebugStore(root) as store: store.latest()
    raise AssertionError("post-list injection accepted")
except module.StoreError: pass
finally: module.os.listdir=original
`), [injected]);
  assert.equal(injectedResult.status, 0, injectedResult.stderr);
});

test("source policy keeps the descriptor root and never resolves hostile PATH tools", () => {
  const source = fs.readFileSync(path.join(root, "platform/deploy/acceptance/source-policy.sh"), "utf8");
  assert.match(source, /\/proc\/self\/fd/u);
  assert.match(source, /PATH=\/usr\/bin:\/bin/u);
  assert.equal(/\$\(dirname|\bdirname --/u.test(source), false);
  assert.equal(/\$\(readlink|\breadlink --/u.test(source), false);
  assert.match(source, /trusted Node must be a held broker fd/u);
});

test("toolchain and CI declare the continuous all-five native-x64 lane", () => {
  const workflow = fs.readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
  assert.match(workflow, /runs-on: ubuntu-24\.04/u);
  assert.match(workflow, /continuous credential-free Pin check session/u);
  assert.match(workflow, /continuous all-five debug publication session/u);
  assert.match(workflow, /--role installer --role bootstrap --role hook --role server --role hook-injector/u);
  assert.equal(workflow.includes("preparePinBuilderLaneDirectories"), false);
  assert.equal(workflow.includes("debug-store.py exec-docker"), false);
  for (const leaf of [
    "cargo-registry", "cargo-git", "gradle-caches", "gradle-wrapper", "npm-cacache",
  ]) assert.match(workflow, new RegExp(`pin-builder-cache-data/${leaf}`, "u"));
});
