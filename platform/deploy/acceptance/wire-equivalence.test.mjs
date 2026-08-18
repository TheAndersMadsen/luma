import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The half of the equivalence gate contracts/wire-divergence.json asked for and
 * did not have: something that PARSES both wire trees and fails when they
 * disagree in a way that changes the bytes.
 *
 * wire-divergence.test.mjs, alongside this file, holds the inventory to its own
 * rules — counts, matrix, citation policy, symbols that still exist. All of that
 * is about the FILE. None of it reads a `.proto`. Editing `sint32` to `int32` in
 * either tree, or adding a message that collides with the other tree's field
 * numbers, failed nothing anywhere in the repository; the inventory would simply
 * describe source that no longer existed, which is the wrong-but-plausible state
 * the whole file was written to end.
 *
 * WHY THIS DOES NOT SHELL OUT TO PROTOC. The inventory's own `howToRegenerate`
 * uses protoc plus the python protobuf package. Neither is a deploy-time
 * dependency of this repository, and a gate that skips when its tool is missing
 * is a gate that is green on the machine that matters least. The parser below is
 * therefore deliberately small and deliberately strict: it understands exactly
 * the proto3 subset both trees are written in and THROWS on anything else, so an
 * unparsed construct fails loudly here instead of quietly dropping a field from
 * the comparison.
 *
 * WHAT COUNTS AS A FAILURE. Only a disagreement that changes the bytes — the
 * `wire-incompatible` class, defined by the inventory as "same field number,
 * different wire layout (varint vs zigzag-varint, message vs scalar, singular vs
 * repeated)". Renames are not failures: a field renamed, a type moved between
 * packages, an enum value respelled with a prefix, `int64` against `int32` are
 * all things the wire cannot see, and a gate that broke the build for them would
 * be turned off within the week. The inventory's classification is the
 * granularity, and the allowlist is the inventory itself.
 *
 * The assertion is set EQUALITY, not containment, in both directions:
 *
 *   - a byte-changing divergence that the inventory does not list fails, so a
 *     new one cannot be introduced silently;
 *   - an inventory entry that no longer diverges ALSO fails, so a divergence
 *     cannot be fixed without the record being burned down with it. That is the
 *     direction that rots first, and the reason the counts in that file were
 *     ever able to describe source that had moved on.
 *
 * WHAT THE 2026-08-12 HARDENING ADDED, and what it was worth. The gate above
 * compares the two trees to each other and the RESULT to the inventory's list of
 * citations. It never compared the inventory's recorded DECLARATIONS to the
 * source, so four separate mutations passed it green:
 *
 *   - `[packed = false]` on a repeated scalar, which is a real byte change the
 *     shape comparison could not see because it ignored options entirely;
 *   - an entry whose recorded `contracts` text no longer matched the tree — the
 *     citation still pointed at a real divergence, so set equality held while
 *     the description of it had silently become something else;
 *   - a presence-only entry whose "absent" side had since declared the field or
 *     enum value, which also silenced the enum-meaning check below, because that
 *     check treated ANY entry at that number as a decision somebody wrote down;
 *   - a recorded enum divergence the two trees no longer had, which is the same
 *     rot the field half already failed on and the enum half did not.
 *
 * One check closes all four: every entry must say exactly what the trees say.
 * A present side must render back to the recorded declaration, an absent side
 * must still be absent, and an entry with both sides must still actually differ.
 * That is strictly stronger than "the citation still resolves", and it is what
 * makes an EMPTY wire-incompatible class trustworthy rather than merely short.
 *
 * It also holds `stagedForRelease` — the block for corrections that are made in
 * the tree but not yet on the device — against the tree and against the operator
 * documentation, so that record cannot claim a change that was not made, survive
 * one that was reverted, or ship without the note telling the installer what
 * moves.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const inventory = JSON.parse(fs.readFileSync(path.join(root, "contracts/wire-divergence.json"), "utf8"));

// ---------------------------------------------------------------------------
// Lexer + parser for the proto3 subset both trees use.
// ---------------------------------------------------------------------------

const SCALAR_GROUPS = new Map(
  Object.entries({
    int32: "varint",
    int64: "varint",
    uint32: "varint",
    uint64: "varint",
    bool: "varint",
    // Zigzag is a DIFFERENT varint. Same tag, same wire type, different number
    // out the other end — the failure that put `OrientationInfo.horizon_angle`
    // and `PhotoMemoryRequest.gmt_offset` in the inventory, and the reason this
    // is its own group rather than folded in with the plain varints.
    sint32: "zigzag",
    sint64: "zigzag",
    fixed32: "i32",
    sfixed32: "i32",
    float: "i32",
    fixed64: "i64",
    sfixed64: "i64",
    double: "i64",
    string: "len-bytes",
    bytes: "len-bytes",
  }),
);

/** Strips comments without letting a `//` inside a string literal eat the line. */
function stripComments(source) {
  let out = "";
  let inString = null;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += source[i + 1] ?? "";
        i += 1;
      } else if (char === inString) inString = null;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = char;
      out += char;
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      out += " ";
      continue;
    }
    out += char;
  }
  return out;
}

function tokenize(source) {
  const tokens = [];
  const pattern = /"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_.]*|-?\d+(?:\.\d+)?|[{}();=,<>[\]]/g;
  for (const match of stripComments(source).matchAll(pattern)) tokens.push(match[0]);
  return tokens;
}

/** UpperCamel -> UPPER_SNAKE, the prefix convention proto enums are written in. */
function upperSnake(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toUpperCase();
}

/**
 * Parses one tree into three flat, fully-qualified indexes.
 *
 * Map fields are expanded into the synthetic `<Field>Entry` message protoc
 * generates for them, so a map compares against a message the same way protoc's
 * own descriptor set would — which is how the pin tree's
 * `humane.aibus.RunState.AgentToRunsEntry` came to be inventoried as a real
 * symbol in the first place.
 */
function parseTree(treeRoot) {
  const messages = new Map();
  const enums = new Map();
  const services = new Map();

  /**
   * One fully-qualified name, one declaration.
   *
   * The three indexes are flat and span every file in a tree, so a second
   * `message Foo` under the same package used to overwrite the first with no
   * complaint — and the comparison would then run against whichever copy the
   * directory walk happened to reach last. protoc rejects that outright; so does
   * this. The one legitimate overwrite is a real nested message displacing the
   * synthetic map entry protoc would have generated under the same name.
   */
  const declare = (index, fq, value, what) => {
    const existing = index.get(fq);
    assert.ok(
      existing === undefined || existing.synthetic === true,
      `${value.file}: ${fq} is declared twice (also in ${existing?.file}); the later ${what} would silently win`,
    );
    index.set(fq, value);
  };

  const protoPaths = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".proto")) protoPaths.push(full);
    }
  };
  walk(treeRoot);
  assert.ok(protoPaths.length > 0, `no .proto files under ${treeRoot}`);

  for (const file of protoPaths) {
    const where = path.relative(root, file);
    const tokens = tokenize(fs.readFileSync(file, "utf8"));
    let cursor = 0;
    const peek = () => tokens[cursor];
    const next = () => tokens[cursor++];
    const expect = (token) => {
      const got = next();
      assert.equal(got, token, `${where}: expected ${token}, got ${got}`);
    };
    const skipTo = (token) => {
      while (cursor < tokens.length && tokens[cursor] !== token) cursor += 1;
      cursor += 1;
    };
    /**
     * Consume a balanced `open ... close`, so a nested block cannot end the
     * outer one early. `skipTo("}")` on an rpc body containing
     * `option (x) = { y: z };` stopped at the INNER brace and left the service's
     * remaining methods to be parsed as top-level constructs — loudly, but with
     * an error naming the wrong thing.
     */
    const skipBalanced = (open, close) => {
      assert.equal(next(), open, `${where}: expected ${open}`);
      let depth = 1;
      while (cursor < tokens.length && depth > 0) {
        const token = next();
        if (token === open) depth += 1;
        else if (token === close) depth -= 1;
      }
      assert.equal(depth, 0, `${where}: unbalanced ${open}`);
    };
    /**
     * `[deprecated = true, packed = false]` and friends, returned rather than
     * skipped.
     *
     * Only `packed` is read, and only because it is the one field option in
     * proto3 that CHANGES THE BYTES: a repeated scalar is packed by default —
     * one length-delimited run — and `[packed = false]` writes a separate
     * tag-value pair per element instead. A gate that ignores options cannot see
     * that at all, and the pin tree already writes `[packed = true]` explicitly
     * on `humane.capture.ImageMetadata.strides`, so this is not a hypothetical
     * construct in these trees.
     */
    const parseOptions = () => {
      const options = new Map();
      if (peek() !== "[") return options;
      const start = cursor;
      skipBalanced("[", "]");
      const inner = tokens.slice(start + 1, cursor - 1);
      for (let i = 0; i < inner.length; i += 1) {
        if (inner[i + 1] === "=") options.set(inner[i], inner[i + 2]);
      }
      return options;
    };

    let pkg = "";

    const parseEnum = (scope) => {
      const name = next();
      const fq = scope ? `${scope}.${name}` : name;
      expect("{");
      const values = new Map();
      while (peek() !== "}") {
        const token = next();
        if (token === "option" || token === "reserved") {
          skipTo(";");
          continue;
        }
        // An empty statement. protoc accepts one; the parser used to abort on it
        // with "unparsed construct", which is a gate failing on valid proto.
        if (token === ";") continue;
        expect("=");
        const number = Number(next());
        parseOptions();
        expect(";");
        // First spelling wins, which is also what `allow_alias` means on the
        // wire: the number is the value, the later names are synonyms.
        if (!values.has(number)) values.set(number, token);
      }
      expect("}");
      declare(enums, fq, { fq, values, file: where }, "enum");
    };

    const parseMessage = (scope) => {
      const name = next();
      const fq = scope ? `${scope}.${name}` : name;
      expect("{");
      const fields = new Map();

      const addField = (label, type, fieldName, number, options) => {
        assert.ok(!fields.has(number), `${where}: ${fq} declares field ${number} twice`);
        fields.set(number, { number, name: fieldName, label, type, packed: options?.get("packed") ?? null });
      };

      const parseField = (label) => {
        const type = next();
        const fieldName = next();
        expect("=");
        const number = Number(next());
        const options = parseOptions();
        expect(";");
        addField(label, type, fieldName, number, options);
      };

      const parseMap = () => {
        expect("<");
        const keyType = next();
        expect(",");
        const valueType = next();
        expect(">");
        const fieldName = next();
        expect("=");
        const number = Number(next());
        parseOptions();
        expect(";");
        // protoc's synthetic entry: nested, UpperCamel of the field name plus
        // "Entry", key at 1 and value at 2, and the field itself is a repeated
        // message of that type. Modelling it exactly is what makes a map compare
        // correctly against the `bytes` placeholder that used to face it.
        const entryFq = `${fq}.${fieldName
          .split("_")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("")}Entry`;
        messages.set(entryFq, {
          fq: entryFq,
          scope: fq,
          file: where,
          synthetic: true,
          fields: new Map([
            [1, { number: 1, name: "key", label: "single", type: keyType, packed: null }],
            [2, { number: 2, name: "value", label: "single", type: valueType, packed: null }],
          ]),
        });
        addField("repeated", entryFq, fieldName, number, new Map());
      };

      while (peek() !== "}") {
        const token = next();
        if (token === "message") parseMessage(fq);
        else if (token === "enum") parseEnum(fq);
        else if (token === "option" || token === "reserved") skipTo(";");
        else if (token === ";") continue;
        else if (token === "map") parseMap();
        else if (token === "repeated") parseField("repeated");
        else if (token === "optional") parseField("single");
        else if (token === "oneof") {
          next(); // the oneof's own name is not on the wire
          expect("{");
          while (peek() !== "}") {
            const inner = next();
            if (inner === "option") skipTo(";");
            else if (inner === ";") continue;
            else {
              cursor -= 1;
              parseField("single");
            }
          }
          expect("}");
        } else {
          assert.match(token, /^[A-Za-z_][A-Za-z0-9_.]*$/, `${where}: ${fq} has an unparsed construct near "${token}"`);
          cursor -= 1;
          parseField("single");
        }
      }
      expect("}");
      // A synthetic map entry may already occupy this name only if the tree
      // declares one explicitly; the real declaration wins.
      declare(messages, fq, { fq, scope, file: where, fields }, "message");
    };

    const parseService = () => {
      const name = next();
      const fq = pkg ? `${pkg}.${name}` : name;
      expect("{");
      const methods = new Map();
      while (peek() !== "}") {
        const token = next();
        if (token === "option") {
          skipTo(";");
          continue;
        }
        if (token === ";") continue;
        assert.equal(token, "rpc", `${where}: ${fq} has an unparsed construct near "${token}"`);
        const method = next();
        expect("(");
        let requestStream = false;
        if (peek() === "stream") {
          next();
          requestStream = true;
        }
        const request = next();
        expect(")");
        assert.equal(next(), "returns", `${where}: ${fq}.${method} is missing its returns clause`);
        expect("(");
        let responseStream = false;
        if (peek() === "stream") {
          next();
          responseStream = true;
        }
        const response = next();
        expect(")");
        // An rpc body is a BLOCK, not a run of tokens ending at the first `}`:
        // `option (google.api.http) = { post: "/v1/x" };` closes an inner brace
        // first, and skipping to that one silently ended the service.
        if (peek() === "{") skipBalanced("{", "}");
        else expect(";");
        assert.ok(!methods.has(method), `${where}: ${fq} declares rpc ${method} twice`);
        methods.set(method, { method, request, requestStream, response, responseStream, scope: fq });
      }
      expect("}");
      declare(services, fq, { fq, methods, file: where }, "service");
    };

    while (cursor < tokens.length) {
      const token = next();
      if (token === "syntax" || token === "import" || token === "option") skipTo(";");
      else if (token === ";") continue;
      else if (token === "package") {
        pkg = next();
        expect(";");
      } else if (token === "message") parseMessage(pkg);
      else if (token === "enum") parseEnum(pkg);
      else if (token === "service") parseService();
      else assert.fail(`${where}: unparsed top-level construct "${token}"`);
    }
  }

  return { messages, enums, services };
}

// ---------------------------------------------------------------------------
// What the wire can see.
// ---------------------------------------------------------------------------

/** protoc's own resolution: innermost enclosing scope first, then outward. */
function resolveType(reference, scope, tree) {
  if (reference.startsWith(".")) {
    const absolute = reference.slice(1);
    return tree.messages.has(absolute) || tree.enums.has(absolute) ? absolute : null;
  }
  const parts = scope ? scope.split(".") : [];
  for (let depth = parts.length; depth >= 0; depth -= 1) {
    const candidate = [...parts.slice(0, depth), reference].join(".");
    if (tree.messages.has(candidate) || tree.enums.has(candidate)) return candidate;
  }
  return null;
}

/** Groups whose repeated form is packed by default in proto3. */
const PACKABLE = new Set(["varint", "zigzag", "i32", "i64"]);

/**
 * The four things the bytes encode for a field: how many of it there are, which
 * of the six encodings it uses, whether a repeated run of it is packed, and —
 * for a submessage — what it points at.
 */
function shapeOf(field, scope, tree) {
  const cardinality = field.label === "repeated" ? "repeated" : "single";
  /*
   * proto3 packs repeated scalars by default, so `packed` is only ever a
   * DIFFERENCE when one side says false: `[packed = true]`, which the pin tree
   * writes explicitly on ImageMetadata.strides, is the default spelled out and
   * must not read as a divergence against a bare `repeated int32`.
   */
  const packing = (group) =>
    cardinality === "repeated" && PACKABLE.has(group) ? field.packed !== "false" : null;

  if (SCALAR_GROUPS.has(field.type)) {
    const group = SCALAR_GROUPS.get(field.type);
    return { cardinality, group, packed: packing(group), reference: null, unresolved: null };
  }
  const resolved = resolveType(field.type, scope, tree);
  if (resolved === null) {
    // An imported well-known type (google.protobuf.*) neither tree declares.
    // Length-delimited, and comparable only by name.
    return { cardinality, group: "len-message", packed: null, reference: null, unresolved: field.type };
  }
  if (tree.enums.has(resolved)) {
    // An enum is a varint, and a repeated enum packs like one.
    return { cardinality, group: "varint", packed: packing("varint"), reference: null, unresolved: null };
  }
  return { cardinality, group: "len-message", packed: null, reference: resolved, unresolved: null };
}

/**
 * Do two references to a type NEITHER tree declares name the same type?
 *
 * The spelling is the only handle left, and for an import it is real signal:
 * google.protobuf.Timestamp and google.protobuf.Struct are not each other. But
 * the same type can be written two legal ways — fully qualified, with or without
 * the leading dot, or relative to the enclosing package once it is imported — and
 * comparing those raw reported `google.protobuf.Timestamp` against `Timestamp`
 * as a byte-changing divergence, which is a false alarm on a pure spelling
 * difference. Segment-aligned suffix equality accepts exactly the legal
 * rewritings and nothing else.
 */
function sameUnresolvedReference(a, b) {
  const strip = (name) => (name.startsWith(".") ? name.slice(1) : name);
  const [left, right] = [strip(a), strip(b)];
  if (left === right) return true;
  const [longer, shorter] = left.length >= right.length ? [left, right] : [right, left];
  return longer.endsWith(`.${shorter}`);
}

/**
 * Do the two declarations of one field number put different bytes on the wire?
 *
 * Everything this returns false for is something the inventory classes as
 * name-only, relocated-type, shape-subset or wire-compatible-value-risk — the
 * classes that exist precisely because proto3 carries field numbers and wire
 * types and nothing else.
 */
function byteChanging(contractsField, contractsScope, pinField, pinScope, trees, seen = new Set()) {
  const a = shapeOf(contractsField, contractsScope, trees.contracts);
  const b = shapeOf(pinField, pinScope, trees.pin);
  if (a.cardinality !== b.cardinality) return true;
  if (a.group !== b.group) return true;
  // A packed run and an unpacked one contain the same values in different bytes.
  if (a.packed !== null && b.packed !== null && a.packed !== b.packed) return true;
  if (a.group !== "len-message") return false;

  // Two submessages. Same framing; the question is what is inside it.
  if (a.unresolved !== null || b.unresolved !== null) {
    return !sameUnresolvedReference(a.unresolved ?? a.reference, b.unresolved ?? b.reference);
  }
  return typesConflict(a.reference, b.reference, trees, seen);
}

/**
 * Structural comparison across the trees, over SHARED field numbers only.
 *
 * Fields one side declares and the other does not are not a conflict: they
 * decode as unknown fields and are dropped, which is the inventory's
 * `shape-subset` class ("The extra fields decode as unknown fields and are
 * dropped in silence"). A recursive type is treated as agreeing with itself
 * while the comparison of it is still in flight, which terminates and is the
 * right answer for a cycle that agrees everywhere else.
 */
function typesConflict(contractsFq, pinFq, trees, seen) {
  // Separated by a character no fully-qualified name can contain: `A.B` + `C`
  // and `A` + `B.C` are different pairs, and a bare concatenation made them one
  // key -- so the second pair would have been reported as already seen, which is
  // to say as agreeing, without ever being compared.
  const key = `${contractsFq} ${pinFq}`;
  if (seen.has(key)) return false;
  seen.add(key);
  const a = trees.contracts.messages.get(contractsFq);
  const b = trees.pin.messages.get(pinFq);
  if (!a || !b) return false;
  for (const [number, contractsField] of a.fields) {
    const pinField = b.fields.get(number);
    if (!pinField) continue;
    if (byteChanging(contractsField, a.fq, pinField, b.fq, trees, seen)) return true;
  }
  return false;
}

const trees = {
  contracts: parseTree(path.join(root, inventory.trees.contracts.root)),
  pin: parseTree(path.join(root, inventory.trees.pin.root)),
};

/** Every field number the two trees encode differently, as symbol + number. */
function byteChangingDivergences() {
  const found = [];
  for (const [fq, contractsMessage] of trees.contracts.messages) {
    const pinMessage = trees.pin.messages.get(fq);
    if (!pinMessage) continue;
    for (const [number, contractsField] of contractsMessage.fields) {
      const pinField = pinMessage.fields.get(number);
      if (!pinField) continue;
      if (
        byteChanging(contractsField, contractsMessage.fq, pinField, pinMessage.fq, trees, new Set())
      ) {
        found.push({
          symbol: fq,
          at: number,
          contracts: `${contractsField.label === "repeated" ? "repeated " : ""}${contractsField.type} ${contractsField.name}`,
          pin: `${pinField.label === "repeated" ? "repeated " : ""}${pinField.type} ${pinField.name}`,
        });
      }
    }
  }
  return found.sort((a, b) => a.symbol.localeCompare(b.symbol) || a.at - b.at);
}

const cite = (entry) => `${entry.symbol} (${entry.at})`;

test("the two wire trees disagree about the bytes in exactly the inventoried places", () => {
  const observed = byteChangingDivergences();
  const inventoried = inventory.entries
    .filter((entry) => entry.class === "wire-incompatible")
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.at - b.at);

  const observedCitations = observed.map(cite);
  const inventoriedCitations = inventoried.map(cite);

  const introduced = observed.filter((entry) => !inventoriedCitations.includes(cite(entry)));
  assert.deepEqual(
    introduced.map((entry) => `${cite(entry)}: contracts "${entry.contracts}" vs pin "${entry.pin}"`),
    [],
    "these field numbers are encoded differently by the two trees and are not in contracts/wire-divergence.json — " +
      "one of the two copies is now unfaithful to the stock client's encoder and nothing else will say so",
  );

  const stale = inventoried.filter((entry) => !observedCitations.includes(cite(entry)));
  assert.deepEqual(
    stale.map(cite),
    [],
    "contracts/wire-divergence.json still lists these as wire-incompatible, but the two trees now agree about the " +
      "bytes — burn the entry down (and its counts) in the same change that fixed the divergence",
  );
});

test("a shared enum number never means two different things unrecorded", () => {
  /*
   * The `semantic-only` hazard, which by construction cannot fail at runtime:
   * "Same enum number, two names that mean DIFFERENT things... The number on the
   * wire is identical, so this class can never fail loudly."
   *
   * A PURE RENAME is not flagged. `humane.capture.MediaType` PHOTO against
   * MEDIA_TYPE_PHOTO is the prefix convention and nothing else, so stripping the
   * enum's own name as an UPPER_SNAKE prefix makes the two identical and the
   * gate stays quiet — the rule this file has to live by, or it gets disabled.
   * What is left after that is two names that genuinely differ, and every one of
   * those must be a decision somebody wrote down.
   */
  const unrecorded = [];
  /*
   * Only a class that DECIDES the two spellings silences this. presence-only
   * says "the other tree does not declare this number", which stops being true
   * the moment it does — and until 2026-08-12 such a row silenced the check
   * anyway, so a value the pin tree newly declared with a conflicting meaning
   * landed under a record that described the opposite situation. That is not a
   * decision somebody wrote down; it is a decision that was overtaken.
   */
  const decides = new Set(["name-only", "semantic-only"]);
  const recorded = new Set(
    inventory.entries
      .filter((entry) => entry.kind === "enum-value" && decides.has(entry.class))
      .map((entry) => `${entry.symbol} ${entry.at}`),
  );

  for (const [fq, contractsEnum] of trees.contracts.enums) {
    const pinEnum = trees.pin.enums.get(fq);
    if (!pinEnum) continue;
    const prefix = `${upperSnake(fq.split(".").pop())}_`;
    const bare = (value) => (value.startsWith(prefix) ? value.slice(prefix.length) : value);
    for (const [number, contractsValue] of contractsEnum.values) {
      const pinValue = pinEnum.values.get(number);
      if (pinValue === undefined) continue;
      if (bare(contractsValue) === bare(pinValue)) continue;
      if (recorded.has(`${fq} ${number}`)) continue;
      unrecorded.push(`${fq} (${number}): contracts ${contractsValue} vs pin ${pinValue}`);
    }
  }
  assert.deepEqual(
    unrecorded,
    [],
    "these enum numbers are spelled differently in the two trees in a way that is not the prefix convention, and " +
      "contracts/wire-divergence.json does not classify them — either it is a rename (record it name-only) or the " +
      "trees disagree about what the number MEANS, which mislabels data forever and never throws",
  );
});

test("a shared service never answers the same call on two different paths", () => {
  /*
   * The method name IS on the wire — it is the second half of
   * `/humane.capture.CaptureService/DeleteMemory` — so unlike a field name it
   * cannot be renamed freely. A method missing from one tree is not a finding
   * (the pin tree "reconstructs only what its runtime serves"). A method present
   * in BOTH under two spellings of one name is: the stock client reaches exactly
   * one of them, and the other is a route nothing will ever call.
   */
  const divergent = [];
  for (const [fq, contractsService] of trees.contracts.services) {
    const pinService = trees.pin.services.get(fq);
    if (!pinService) continue;
    const pinByFold = new Map([...pinService.methods.keys()].map((name) => [name.toLowerCase(), name]));
    for (const name of contractsService.methods.keys()) {
      const twin = pinByFold.get(name.toLowerCase());
      if (twin !== undefined && twin !== name) divergent.push(`${fq}: contracts /${name} vs pin /${twin}`);
    }
  }
  assert.deepEqual(divergent, [], "the two trees serve the same RPC under two different paths");
});

test("a shared method's request and response are encoded the same way by both trees", () => {
  /*
   * Field-level equality above is keyed on shared symbol names, so it says
   * nothing about a message that one tree spells differently — and the AI-bus
   * pair (EncryptedAIRequest against EncryptedAiRequest) is exactly that. The
   * method is the join: whatever the two request types are CALLED, the same call
   * carries them, so they have to encode the same.
   *
   * Only the differently-spelled pairs are checked here. A request type the two
   * trees agree to CALL the same thing is a shared symbol, so the field-level
   * test above already compares it against the inventory's allowlist, and
   * repeating it here would report the same known divergence a second time
   * without an allowlist to weigh it against.
   */
  const divergent = [];
  for (const [fq, contractsService] of trees.contracts.services) {
    const pinService = trees.pin.services.get(fq);
    if (!pinService) continue;
    for (const [name, contractsMethod] of contractsService.methods) {
      const pinMethod = pinService.methods.get(name);
      if (!pinMethod) continue;
      for (const side of ["request", "response"]) {
        const contractsFq = resolveType(contractsMethod[side], fq, trees.contracts);
        const pinFq = resolveType(pinMethod[side], fq, trees.pin);
        if (contractsFq === null || pinFq === null) {
          if (contractsMethod[side] !== pinMethod[side]) {
            divergent.push(`${fq}/${name} ${side}: contracts ${contractsMethod[side]} vs pin ${pinMethod[side]}`);
          }
          continue;
        }
        if (contractsFq !== pinFq && typesConflict(contractsFq, pinFq, trees, new Set())) {
          divergent.push(`${fq}/${name} ${side}: contracts ${contractsFq} vs pin ${pinFq} encode differently`);
        }
        if (contractsMethod[`${side}Stream`] !== pinMethod[`${side}Stream`]) {
          divergent.push(`${fq}/${name} ${side}: one tree streams it and the other does not`);
        }
      }
    }
  }
  assert.deepEqual(divergent, [], "a shared RPC carries differently-encoded messages in the two trees");
});

test("the parser saw both trees whole", () => {
  /*
   * Everything above is a comparison of what was parsed. A parser that silently
   * dropped half a tree would report perfect agreement, so the floor is asserted
   * here rather than inferred from green tests: both trees present, both with
   * messages, enums and services, and every message the inventory cites as a
   * shared symbol actually shared.
   */
  for (const [name, tree] of Object.entries(trees)) {
    assert.ok(tree.messages.size > 50, `${name}: parsed only ${tree.messages.size} messages`);
    assert.ok(tree.enums.size > 5, `${name}: parsed only ${tree.enums.size} enums`);
    assert.ok(tree.services.size > 5, `${name}: parsed only ${tree.services.size} services`);
  }
  const shared = [...trees.contracts.messages.keys()].filter((fq) => trees.pin.messages.has(fq));
  assert.ok(shared.length > 50, `only ${shared.length} messages are declared in both trees; the parser lost something`);

  for (const entry of inventory.entries) {
    if (entry.kind !== "field" || entry.contracts === null || entry.pin === null) continue;
    assert.ok(
      trees.contracts.messages.has(entry.symbol) && trees.pin.messages.has(entry.symbol),
      `the inventory records both trees declaring ${entry.symbol}, but the parser did not find it in both`,
    );
  }
});

// ---------------------------------------------------------------------------
// The inventory against the source, declaration by declaration.
// ---------------------------------------------------------------------------

/** The exact form the inventory writes a field declaration in. */
function renderField(field, scope, tree) {
  const resolved = resolveType(field.type, scope, tree);
  return `${field.label === "repeated" ? "repeated " : ""}${resolved ?? field.type} ${field.name}`;
}

/** The exact form the inventory writes a method signature in. */
function renderMethod(method, scope, tree) {
  const side = (type, streamed) => `(${streamed ? "stream " : ""}${resolveType(type, scope, tree) ?? type})`;
  return `${side(method.request, method.requestStream)} returns ${side(method.response, method.responseStream)}`;
}

/**
 * What one side of one inventory entry says the tree declares, read out of the
 * tree. `null` means the tree does not declare it, which is the same thing the
 * inventory's `null` means.
 */
function declaredAt(entry, side) {
  const tree = trees[side];
  if (entry.kind === "enum-value") {
    return tree.enums.get(entry.symbol)?.values.get(entry.at) ?? null;
  }
  if (entry.kind === "method") {
    const service = tree.services.get(entry.symbol);
    const method = service?.methods.get(entry.at);
    return method ? renderMethod(method, service.fq, tree) : null;
  }
  const message = tree.messages.get(entry.symbol);
  const field = message?.fields.get(entry.at);
  return field ? renderField(field, message.fq, tree) : null;
}

test("every inventoried divergence still says exactly what the two trees say", () => {
  /*
   * The direction the gate did not hold, and the one that rots quietly.
   *
   * Everything above compares the two trees to each other and the RESULT to the
   * inventory's list of CITATIONS — symbol plus number. That is enough to catch
   * a divergence appearing or disappearing, and blind to everything else the
   * record claims. Four separate mutations passed the gate green while making
   * the inventory describe source that no longer existed:
   *
   *   - changing what one tree declares at a still-divergent number, so the
   *     citation stayed valid and its `contracts`/`pin` text became fiction;
   *   - declaring, in the "absent" tree, a field a presence-only row says is
   *     absent — which ALSO silenced the enum-meaning check above;
   *   - making the two trees agree at an enum number the inventory still lists
   *     as a name-only or semantic-only divergence;
   *   - and, for enums, the burn-down direction the field half already had.
   *
   * One rule covers all four: an entry must say exactly what the trees say. It
   * is checkable because the inventory writes declarations in a form this parser
   * can reproduce exactly — `repeated <fully-qualified type> <name>` for fields,
   * the bare value name for enum values, `(stream X) returns (Y)` for methods —
   * and all 123 declarations in the file reproduced on the day this was written.
   */
  const wrong = [];
  for (const entry of inventory.entries) {
    for (const side of ["contracts", "pin"]) {
      const declared = declaredAt(entry, side);
      if (entry[side] === null) {
        if (declared !== null) {
          wrong.push(
            `${cite(entry)}: recorded as absent from ${side}, but that tree declares "${declared}" ` +
              `(a ${entry.class} entry whose absent side is no longer absent is not a divergence record, it is a stale one)`,
          );
        }
        continue;
      }
      if (declared === null) {
        wrong.push(`${cite(entry)}: recorded in ${side} as "${entry[side]}", but that tree no longer declares it`);
      } else if (declared !== entry[side]) {
        wrong.push(`${cite(entry)}: recorded in ${side} as "${entry[side]}", but that tree declares "${declared}"`);
      }
    }
    if (entry.contracts !== null && entry.pin !== null && entry.contracts === entry.pin) {
      wrong.push(`${cite(entry)}: both trees are recorded as declaring "${entry.contracts}", so this is not a divergence`);
    }
  }
  assert.deepEqual(
    wrong,
    [],
    "contracts/wire-divergence.json describes source that has moved on — burn the entry down, or correct it, in the " +
      "same change that moved the tree",
  );
});

test("what is staged for a Pin release is in the tree, agreed by both trees, and written down for the installer", () => {
  /*
   * `stagedForRelease` is the one place this repository says "the source is
   * right and the DEVICE is not", so it is the one place where being wrong is
   * invisible: nothing in a build, a deploy or a canary can observe what the
   * paired Pin is running. What CAN be held is everything around it.
   *
   *   - the pin tree really does declare what the record says it now declares,
   *     so the block cannot claim a change nobody made;
   *   - it differs from `wasBefore`, so a staged row that changes nothing is not
   *     left sitting there looking like an owed device check;
   *   - the two trees now AGREE at that point, because a staged correction is by
   *     definition one that moves the pin tree onto the stock layout — a
   *     disagreement means the correction was mis-copied;
   *   - the point is no longer an `entries` row, because it is no longer a
   *     divergence;
   *   - and docs/operations.md names the change, so whoever installs the release
   *     is told what moves rather than finding out from a wearer.
   */
  const operations = fs.readFileSync(path.join(root, "docs/operations.md"), "utf8");
  const staged = inventory.stagedForRelease?.changes ?? [];
  assert.ok(Array.isArray(staged), "stagedForRelease.changes must be a list");

  const inventoried = new Set(inventory.entries.map((entry) => `${entry.kind} ${cite(entry)}`));
  const problems = [];
  for (const change of staged) {
    assert.ok(change.id && change.symbol && change.stagedOn, `a staged change is missing id/symbol/stagedOn`);
    for (const required of ["whatChangesOnTheWire", "untilItIsInstalled", "installCheck", "ifItIsWrong"]) {
      assert.ok(
        typeof change[required] === "string" && change[required].length > 0,
        `staged change ${change.id} has no ${required}; an installer cannot act on that`,
      );
    }
    if (!operations.includes(change.id)) {
      problems.push(`${change.id}: docs/operations.md does not name it, so the install note does not exist`);
    }
    assert.ok(change.points?.length > 0, `staged change ${change.id} names no points`);
    for (const point of change.points) {
      const entry = { kind: point.kind, symbol: point.symbol, at: point.at };
      const pin = declaredAt(entry, "pin");
      const contracts = declaredAt(entry, "contracts");
      if (pin !== point.pin) {
        problems.push(`${change.id} ${cite(point)}: staged as "${point.pin}", but the pin tree declares "${pin}"`);
      }
      if (point.pin === point.wasBefore) {
        problems.push(`${change.id} ${cite(point)}: staged, but identical to what it replaced`);
      }
      if (contracts !== pin) {
        problems.push(
          `${change.id} ${cite(point)}: the trees still disagree here (contracts "${contracts}" vs pin "${pin}"); ` +
            "a staged correction is one that puts the pin tree ON the stock layout",
        );
      }
      if (inventoried.has(`${point.kind} ${cite(point)}`)) {
        problems.push(`${change.id} ${cite(point)}: still listed in entries, but it is no longer a divergence`);
      }
    }
  }
  assert.deepEqual(problems, [], "contracts/wire-divergence.json `stagedForRelease` does not match the tree it describes");
});
