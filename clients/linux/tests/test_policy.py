"""This installation's own copy of the owner's device-action policy.

A host, application or root that is not in this file is refused whatever the
runtime said, and a path that leaves its root through a symlink is refused
after the link is followed, not before.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path

from cosmos_linux import policy as P


def document(**open_section) -> dict:
    return {"version": 1, "open": open_section}


ALLOWED = P.parse(document(
    hosts=["github.com"],
    apps=[{"id": "dev.zed.Zed", "label": "Zed", "desktop": "dev.zed.Zed.desktop"}],
    roots=[{"id": "repo", "label": "Projects", "path": "/tmp/projects"}],
    openers=[{"suffixes": [".rs", ".md"], "argv": ["code", "-g", "{path}:{line}"]},
             {"suffixes": [".pdf"], "argv": ["zathura", "-P", "{page}", "{path}"]}],
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

    def test_an_empty_policy_allows_no_host_at_all(self):
        self.assertFalse(P.EMPTY_POLICY.allows_host("https://github.com/"))
        self.assertTrue(P.EMPTY_POLICY.empty)

    def test_a_locator_with_userinfo_or_a_port_is_not_an_https_locator(self):
        for bad in ("https://user@github.com/x", "https://github.com:8443/x", "http://github.com/x",
                    "https://github.com/ x", "https://github.com/\\x", ""):
            self.assertFalse(P.valid_https(bad), bad)
        self.assertTrue(P.valid_https("https://github.com/owner/repo/pull/412#discussion_r1"))


class ParseTest(unittest.TestCase):
    def test_a_file_this_client_does_not_understand_allows_nothing(self):
        for bad in ({"version": 2}, {"open": {}}, document(hosts="github.com"), document(unknown=[]),
                    document(hosts=["GitHub.com"]), document(roots=[{"id": "repo", "label": "P", "path": "rel"}]),
                    document(roots=[{"id": "Repo", "label": "P", "path": "/tmp"}]),
                    document(apps=[{"id": "a b", "label": "A"}]),
                    document(openers=[{"suffixes": [".rs"], "argv": ["code"]}]),
                    document(openers=[{"suffixes": [".rs"], "argv": ["sh", "-c", "{path}"]}]),
                    document(openers=[{"suffixes": ["rs"], "argv": ["code", "{path}"]}]),
                    document(roots=[{"id": "a", "label": "A", "path": "/tmp"},
                                    {"id": "a", "label": "B", "path": "/var"}])):
            with self.assertRaises(P.InvalidPolicy, msg=bad):
                P.parse(bad)

    def test_a_relative_opener_program_is_refused(self):
        with self.assertRaises(P.InvalidPolicy):
            P.parse(document(openers=[{"suffixes": [".rs"], "argv": ["./editor", "{path}"]}]))
        self.assertTrue(P.parse(document(openers=[{"suffixes": [".rs"], "argv": ["/usr/bin/code", "{path}"]}])).openers)

    def test_an_opener_substitutes_only_the_three_validated_values(self):
        opener = ALLOWED.opener_for("src/state.rs")
        self.assertEqual(opener.command("/tmp/projects/src/state.rs", line=1710),
                         ("code", "-g", "/tmp/projects/src/state.rs:1710"))
        self.assertTrue(opener.honours_line)
        self.assertFalse(opener.honours_page)
        pdf = ALLOWED.opener_for("papers/thesis.pdf")
        self.assertEqual(pdf.command("/tmp/x.pdf", page=12), ("zathura", "-P", "12", "/tmp/x.pdf"))
        self.assertIsNone(ALLOWED.opener_for("archive.tar.gz"))

    def test_a_missing_file_allows_nothing_and_a_broken_one_says_so(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / P.POLICY_FILE
            self.assertIs(P.load(path), P.EMPTY_POLICY)
            path.write_text("{not json", encoding="utf-8")
            broken = P.load(path)
            self.assertFalse(broken.loaded)
            self.assertTrue(broken.empty)
            self.assertIsNotNone(broken.error)
            path.write_text(json.dumps(document(hosts=["github.com"])), encoding="utf-8")
            loaded = P.load(path)
            self.assertTrue(loaded.loaded)
            self.assertEqual(loaded.hosts, frozenset({"github.com"}))
            path.write_text("x" * (P.MAX_FILE_BYTES + 1), encoding="utf-8")
            self.assertIsNotNone(P.load(path).error)

    def test_the_example_document_is_the_shape_this_client_reads(self):
        self.assertTrue(P.parse(json.loads(P.example_document())).loaded)


class RootContainmentTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name) / "projects"
        (self.root / "src").mkdir(parents=True)
        (self.root / "src" / "state.rs").write_text("fn main() {}\n", encoding="utf-8")
        self.outside = Path(self.temporary.name) / "secrets"
        self.outside.mkdir()
        (self.outside / "id_ed25519").write_text("private\n", encoding="utf-8")
        self.policy = P.parse(document(roots=[{"id": "repo", "label": "Projects", "path": str(self.root)}]))
        self.addCleanup(self.temporary.cleanup)

    def test_a_path_inside_the_root_resolves(self):
        resolved = P.resolve_under_root(self.policy, "repo", "src/state.rs")
        self.assertEqual(resolved.path, os.path.realpath(self.root / "src" / "state.rs"))
        self.assertEqual(resolved.root.id, "repo")

    def test_a_root_this_installation_never_declared_is_refused(self):
        self.assertEqual(P.resolve_under_root(self.policy, "downloads", "x.pdf").reason, "not_permitted")
        self.assertEqual(P.resolve_under_root(P.EMPTY_POLICY, "repo", "src/state.rs").reason, "not_permitted")

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
