"""The owner's delivered permission, and this desktop's own local details.

A host, application or folder that is not in the delivered document is refused
whatever the runtime said; a document that is not this connection's, or that
breaks a bound the runtime itself applies, is refused whole rather than
half-read. A path that leaves its folder through a symlink is refused after the
link is followed, not before. The openers file allows nothing at all: it only
says how this machine opens what it was already allowed to open.
"""
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import policy as P

SURFACE_ID = "9b8a7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d"
OTHER_SURFACE = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f"
APPROVAL = 4


def document(hosts=("github.com",), apps=(), roots=(), surface_id: str = SURFACE_ID,
             approval_revision: int = APPROVAL, revision: int = 3, maximum_class: str = "private",
             **extra) -> dict:
    section = {}
    if hosts:
        section["hosts"] = list(hosts)
    if apps:
        section["apps"] = [dict(entry) for entry in apps]
    if roots:
        section["roots"] = [dict(entry) for entry in roots]
    value = {"version": 1, "surfaceId": surface_id, "approvalRevision": approval_revision,
             "actions": {"revision": revision, "maximumClass": maximum_class, "open": section}}
    value.update(extra)
    return value


def serialize(value) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def deliver(value=None, *, surface_id: str = SURFACE_ID, approval_revision: int = APPROVAL,
            raw: bytes = None, digest: str = None) -> P.Policy:
    """One delivered document, exactly as the controller hands it over: the
    bytes, and the digest the snapshot named for them."""
    encoded = raw if raw is not None else serialize(document() if value is None else value)
    return P.parse_policy(encoded, surface_id=surface_id, approval_revision=approval_revision,
                          digest=digest if digest is not None else hashlib.sha256(encoded).hexdigest())


ALLOWED = deliver(document(
    hosts=["github.com"],
    apps=[{"id": "dev.zed.Zed", "label": "Zed"}],
    roots=[{"id": "repo", "label": "Projects", "path": "/tmp/projects"}],
))


class HostTest(unittest.TestCase):
    def test_only_a_bare_lowercase_host_is_a_host(self):
        for good in ("github.com", "docs.rs", "a-b.example.co.uk"):
            self.assertTrue(P.valid_host(good), good)
        for bad in ("GitHub.com", "https://github.com", "github.com:443", "user@github.com", "github.com/x",
                    "localhost", "", ".github.com", "github..com", "-a.com", 7):
            self.assertFalse(P.valid_host(bad), bad)

    def test_a_host_the_owner_did_not_write_is_refused(self):
        self.assertTrue(ALLOWED.allows_host("https://github.com/owner/repo/pull/412"))
        # Exact match only: a lookalike or a subdomain is not the allowed host.
        for refused in ("https://gist.github.com/x", "https://github.com.evil.example/x",
                        "https://raw.githubusercontent.com/x"):
            self.assertFalse(ALLOWED.allows_host(refused), refused)

    def test_a_locator_with_userinfo_or_a_port_is_not_an_https_locator(self):
        for bad in ("https://user@github.com/x", "https://github.com:8443/x", "http://github.com/x",
                    "https://github.com/ x", "https://github.com/\\x", ""):
            self.assertFalse(P.valid_https(bad), bad)
        self.assertTrue(P.valid_https("https://github.com/owner/repo/pull/412#discussion_r1"))


class DeliveredPolicyTest(unittest.TestCase):
    """The shape Cosmos delivers, which is not the shape a person used to write."""

    def test_the_delivered_document_is_read_as_the_owner_wrote_it_in_center(self):
        policy = ALLOWED
        self.assertEqual(policy.surface_id, SURFACE_ID)
        self.assertEqual((policy.approval_revision, policy.revision), (APPROVAL, 3))
        self.assertEqual(policy.hosts, frozenset({"github.com"}))
        # `open` now sits under `actions`, and an application carries a label
        # and no desktop id: which entry starts it is this machine's business.
        self.assertEqual(policy.app("dev.zed.Zed"), P.App("dev.zed.Zed", "Zed"))
        self.assertIsNone(policy.app("com.other.App"))
        self.assertEqual(policy.root("repo").path, "/tmp/projects")
        self.assertIsNone(policy.root("downloads"))

    def test_the_class_the_owner_spent_is_a_ceiling_this_copy_cannot_raise(self):
        capped = deliver(document(maximum_class="shared_room"))
        self.assertTrue(capped.allows_class("public"))
        self.assertTrue(capped.allows_class("shared_room"))
        self.assertFalse(capped.allows_class("near_user"))
        self.assertFalse(capped.allows_class("private"))
        self.assertFalse(capped.allows_class("sensitive"))
        self.assertTrue(ALLOWED.allows_class("private"))

    def test_a_document_for_another_surface_or_another_approval_is_not_this_connection(self):
        for value in (document(surface_id=OTHER_SURFACE), document(approval_revision=APPROVAL + 1)):
            with self.assertRaises(P.InvalidPolicy, msg=value):
                deliver(value)
        # The same document, read against the connection it belongs to.
        self.assertTrue(deliver(document(surface_id=OTHER_SURFACE), surface_id=OTHER_SURFACE).hosts)

    def test_a_document_that_is_not_the_one_the_snapshot_named_is_refused(self):
        encoded = serialize(document())
        with self.assertRaises(P.InvalidPolicy):
            deliver(raw=encoded, digest="f" * 64)
        with self.assertRaises(P.InvalidPolicy):
            # The digest of another document is not the digest of these bytes.
            deliver(raw=encoded, digest=hashlib.sha256(serialize(document(revision=9))).hexdigest())

    def test_an_over_long_or_malformed_document_is_refused_whole(self):
        for raw in (b"", b"{not json", ("x" * (P.MAX_POLICY_BYTES + 1)).encode("utf-8"),
                    serialize(document())[:-1], serialize([document()])):
            with self.assertRaises(P.InvalidPolicy, msg=raw[:20]):
                deliver(raw=raw)
        for value in (
                {"version": 2, "surfaceId": SURFACE_ID, "approvalRevision": APPROVAL},
                # Half a permission is worse than none: every bound the runtime
                # applies when the owner saves it is applied again here.
                document(hosts=[]),
                document(hosts=["GitHub.com"]),
                document(hosts=["news.ycombinator.com", "github.com"]),
                document(hosts=["github.com", "github.com"]),
                document(hosts=[f"h{index}.example.com" for index in range(17)]),
                document(revision=0),
                document(approval_revision=True),
                document(maximum_class="sensitive"),
                document(apps=[{"id": "a b", "label": "A"}]),
                document(apps=[{"id": "dev.zed.Zed", "label": "Zed", "desktop": "dev.zed.Zed.desktop"}]),
                document(apps=[{"id": "dev.zed.Zed", "label": "A"}, {"id": "dev.zed.Zed", "label": "B"}]),
                document(roots=[{"id": "repo", "label": "P", "path": "relative"}]),
                document(roots=[{"id": "repo", "label": "P", "path": "/tmp/../etc"}]),
                document(roots=[{"id": "Repo", "label": "P", "path": "/tmp"}]),
                document(roots=[{"id": "a", "label": "A", "path": "/tmp"},
                                {"id": "a", "label": "B", "path": "/var"}]),
                document(openers=[]),
                dict(document(), actions={"revision": 3, "maximumClass": "private"}),
        ):
            with self.assertRaises(P.InvalidPolicy, msg=value):
                deliver(value)

    def test_a_section_this_computer_does_not_declare_is_refused_whole(self):
        """Only `action.open` is on this platform's manifest, so the runtime
        never sends the rest here; one that arrives is not acted on in part."""
        commands = dict(document(), commands={
            "revision": 2, "maximumClass": "private", "offerOutputToCognition": False,
            "entries": [{"id": "tests", "label": "Tests", "argv": ["./revival", "test"], "cwd": "/tmp",
                         "mutates": True, "budgetMs": 900_000}]})
        routed = document()
        routed["actions"]["route"] = {"app": "google_maps"}
        played = document()
        played["actions"]["play"] = {"providers": ["spotify"]}
        for value in (commands, routed, played):
            with self.assertRaises(P.InvalidPolicy, msg=value):
                deliver(value)

    def test_the_whole_document_is_lost_together_not_field_by_field(self):
        """One bad entry does not leave the good ones standing."""
        value = document(hosts=["github.com"], roots=[{"id": "repo", "label": "P", "path": "/tmp/projects"},
                                                      {"id": "bad", "label": "P", "path": "nowhere"}])
        with self.assertRaises(P.InvalidPolicy):
            deliver(value)


class OpenersTest(unittest.TestCase):
    """The local file: how this desktop opens a document, never whether it may."""

    OPENERS = P.parse_openers({
        "version": 1,
        "openers": [{"suffixes": [".rs", ".md"], "argv": ["code", "-g", "{path}:{line}"]},
                    {"suffixes": [".pdf"], "argv": ["zathura", "-P", "{page}", "{path}"]}],
        "applications": [{"id": "dev.zed.Zed", "desktop": "dev.zed.Zed.desktop"}],
    })

    def test_a_file_this_client_does_not_understand_opens_nothing_its_own_way(self):
        for bad in ({"version": 2}, {"version": 1, "openers": "code"}, {"version": 1, "hosts": []},
                    {"version": 1, "openers": [{"suffixes": [".rs"], "argv": ["code"]}]},
                    {"version": 1, "openers": [{"suffixes": [".rs"], "argv": ["sh", "-c", "{path}"]}]},
                    {"version": 1, "openers": [{"suffixes": ["rs"], "argv": ["code", "{path}"]}]},
                    {"version": 1, "applications": [{"id": "dev.zed.Zed", "desktop": "zed"}]},
                    {"version": 1, "applications": [{"id": "dev.zed.Zed", "label": "Zed"}]},
                    {"version": 1, "applications": [{"id": "a", "desktop": "a.desktop"},
                                                    {"id": "a", "desktop": "b.desktop"}]}):
            with self.assertRaises(P.InvalidPolicy, msg=bad):
                P.parse_openers(bad)

    def test_a_relative_opener_program_is_refused(self):
        with self.assertRaises(P.InvalidPolicy):
            P.parse_openers({"version": 1, "openers": [{"suffixes": [".rs"], "argv": ["./editor", "{path}"]}]})
        self.assertTrue(P.parse_openers(
            {"version": 1, "openers": [{"suffixes": [".rs"], "argv": ["/usr/bin/code", "{path}"]}]}).openers)

    def test_an_opener_substitutes_only_the_three_validated_values(self):
        opener = self.OPENERS.opener_for("src/state.rs")
        self.assertEqual(opener.command("/tmp/projects/src/state.rs", line=1710),
                         ("code", "-g", "/tmp/projects/src/state.rs:1710"))
        self.assertTrue(opener.honours_line)
        self.assertFalse(opener.honours_page)
        pdf = self.OPENERS.opener_for("papers/thesis.pdf")
        self.assertEqual(pdf.command("/tmp/x.pdf", page=12), ("zathura", "-P", "12", "/tmp/x.pdf"))
        self.assertIsNone(self.OPENERS.opener_for("archive.tar.gz"))

    def test_the_desktop_entry_is_local_and_names_no_permission(self):
        self.assertEqual(self.OPENERS.desktop_for("dev.zed.Zed"), "dev.zed.Zed.desktop")
        self.assertIsNone(self.OPENERS.desktop_for("com.other.App"))
        self.assertIsNone(P.NO_OPENERS.desktop_for("dev.zed.Zed"))
        self.assertIsNone(P.NO_OPENERS.opener_for("src/state.rs"))

    def test_a_missing_file_is_ordinary_and_a_broken_one_says_so(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / P.OPENERS_FILE
            self.assertIs(P.load_openers(path), P.NO_OPENERS)
            path.write_text("{not json", encoding="utf-8")
            broken = P.load_openers(path)
            self.assertFalse(broken.loaded)
            self.assertIsNotNone(broken.error)
            self.assertEqual(broken.openers, ())
            path.write_text(P.example_document(), encoding="utf-8")
            loaded = P.load_openers(path)
            self.assertTrue(loaded.loaded)
            self.assertEqual(loaded.desktop_for("dev.zed.Zed"), "dev.zed.Zed.desktop")
            path.write_text("x" * (P.MAX_FILE_BYTES + 1), encoding="utf-8")
            self.assertIsNotNone(P.load_openers(path).error)

    def test_the_example_file_is_the_shape_this_client_reads(self):
        self.assertTrue(P.parse_openers(json.loads(P.example_document())).loaded)
        # It describes the openers only; the permission is not a file any more.
        self.assertEqual(set(json.loads(P.example_document())), {"version", "openers", "applications"})


class RootContainmentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "projects"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src" / "state.rs").write_text("fn main() {}\n", encoding="utf-8")
        self.outside = Path(self.temporary.name) / "secrets"
        self.outside.mkdir()
        (self.outside / "id_ed25519").write_text("private\n", encoding="utf-8")
        self.policy = deliver(document(hosts=[], roots=[{"id": "repo", "label": "Projects",
                                                         "path": str(self.root)}]))
        self.addCleanup(self.temporary.cleanup)

    def test_a_path_inside_the_root_resolves(self):
        resolved = P.resolve_under_root(self.policy, "repo", "src/state.rs")
        self.assertEqual(resolved.path, os.path.realpath(self.root / "src" / "state.rs"))
        self.assertEqual(resolved.root.id, "repo")

    def test_a_root_this_installation_was_never_given_is_refused(self):
        self.assertEqual(P.resolve_under_root(self.policy, "downloads", "x.pdf").reason, "not_permitted")
        # Holding no permission at all allows no folder either.
        self.assertEqual(P.resolve_under_root(None, "repo", "src/state.rs").reason, "not_permitted")

    def test_a_symlink_out_of_the_root_is_an_escape_and_is_refused(self):
        os.symlink(self.outside / "id_ed25519", self.root / "src" / "key.rs")
        resolved = P.resolve_under_root(self.policy, "repo", "src/key.rs")
        self.assertIsNone(resolved.path)
        self.assertEqual(resolved.reason, "unresolvable")

    def test_a_symlinked_directory_out_of_the_root_is_refused_too(self):
        os.symlink(self.outside, self.root / "elsewhere")
        self.assertIsNone(P.resolve_under_root(self.policy, "repo", "elsewhere/id_ed25519").path)

    def test_a_symlink_that_stays_inside_the_root_still_resolves(self):
        os.symlink(self.root / "src" / "state.rs", self.root / "alias.rs")
        self.assertEqual(P.resolve_under_root(self.policy, "repo", "alias.rs").path,
                         os.path.realpath(self.root / "src" / "state.rs"))

    def test_an_escaping_relative_path_never_reaches_the_filesystem(self):
        for relative in ("../secrets/id_ed25519", "/etc/passwd", "src/../../secrets/id_ed25519",
                         "src//state.rs", "src\\state.rs", "src/state.rs\0"):
            self.assertFalse(P.valid_relative(relative), relative)
            self.assertIsNone(P.resolve_under_root(self.policy, "repo", relative).path, relative)

    def test_a_path_that_is_not_a_file_is_unresolvable(self):
        self.assertEqual(P.resolve_under_root(self.policy, "repo", "src").reason, "unresolvable")
        self.assertEqual(P.resolve_under_root(self.policy, "repo", "src/missing.rs").reason, "unresolvable")


if __name__ == "__main__":
    unittest.main()
