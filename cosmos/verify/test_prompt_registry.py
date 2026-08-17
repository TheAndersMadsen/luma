from __future__ import annotations

import json
import shutil
import stat
import tempfile
import unittest
from pathlib import Path

from prompts.registry_tool import REPO_ROOT, RegistryError, private_dump, validate_registry


class PromptRegistryTests(unittest.TestCase):
    def _copy_prompt_tree(self, destination: Path) -> Path:
        root = destination / "clone"
        shutil.copytree(REPO_ROOT / "prompts", root / "prompts")
        return root

    def test_repository_registry_is_complete_and_hash_matched(self) -> None:
        registry, _, prompts = validate_registry()
        self.assertEqual(len(registry["prompts"]), 22)
        self.assertEqual(len(prompts), 22)
        self.assertEqual({prompt.metadata["evidence_grade"] for prompt in prompts}, {"chosen", "derived"})

    def test_hash_tampering_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._copy_prompt_tree(Path(temporary))
            prompt = root / "prompts" / "content" / "system" / "core.prompt"
            prompt.write_text(prompt.read_text(encoding="utf-8") + "tampered\n", encoding="utf-8")
            with self.assertRaisesRegex(RegistryError, "hash mismatch"):
                validate_registry(root)

    def test_unregistered_prompt_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._copy_prompt_tree(Path(temporary))
            orphan = root / "prompts" / "content" / "system" / "orphan.prompt"
            orphan.write_text("orphan\n", encoding="utf-8")
            with self.assertRaisesRegex(RegistryError, "unregistered prompt file"):
                validate_registry(root)

    def test_registry_path_escape_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = self._copy_prompt_tree(Path(temporary))
            registry_path = root / "prompts" / "registry.json"
            registry = json.loads(registry_path.read_text(encoding="utf-8"))
            registry["prompts"][0]["path"] = "prompts/content/../../outside.prompt"
            registry_path.write_text(json.dumps(registry), encoding="utf-8")
            with self.assertRaisesRegex(RegistryError, "below prompts/content"):
                validate_registry(root)

    def test_dump_requires_acknowledgement(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / "dump.json"
            with self.assertRaisesRegex(RegistryError, "acknowledge-owned-prompts"):
                private_dump(output, acknowledge_owned_prompts=False)

    def test_dump_is_private_complete_and_non_overwriting(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            private_directory = Path(temporary) / "private"
            private_directory.mkdir(mode=0o700)
            private_directory.chmod(0o700)
            output = private_directory / "prompts.json"
            destination, count, _ = private_dump(
                output,
                acknowledge_owned_prompts=True,
            )
            self.assertEqual(destination, output.resolve())
            self.assertEqual(count, 22)
            self.assertEqual(stat.S_IMODE(output.stat().st_mode), 0o600)
            exported = json.loads(output.read_text(encoding="utf-8"))
            self.assertEqual(len(exported["prompts"]), 22)
            self.assertTrue(all("content" in prompt for prompt in exported["prompts"]))
            with self.assertRaisesRegex(RegistryError, "overwrite"):
                private_dump(output, acknowledge_owned_prompts=True)

    def test_dump_is_deterministic(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            private_directory = Path(temporary) / "private"
            private_directory.mkdir(mode=0o700)
            private_directory.chmod(0o700)
            first = private_directory / "first.json"
            second = private_directory / "second.json"
            _, first_count, first_hash = private_dump(first, acknowledge_owned_prompts=True)
            _, second_count, second_hash = private_dump(second, acknowledge_owned_prompts=True)
            self.assertEqual(first_count, second_count)
            self.assertEqual(first_hash, second_hash)
            self.assertEqual(first.read_bytes(), second.read_bytes())

    def test_dump_inside_repository_is_rejected(self) -> None:
        output = REPO_ROOT / "prompts" / "unsafe-dump.json"
        with self.assertRaisesRegex(RegistryError, "outside the repository"):
            private_dump(output, acknowledge_owned_prompts=True)

    def test_dump_parent_must_be_private(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            public_directory = Path(temporary) / "public"
            public_directory.mkdir(mode=0o755)
            public_directory.chmod(0o755)
            output = public_directory / "prompts.json"
            with self.assertRaisesRegex(RegistryError, "mode 0700"):
                private_dump(output, acknowledge_owned_prompts=True)

    def test_dump_symlink_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            private_directory = Path(temporary) / "private"
            private_directory.mkdir(mode=0o700)
            private_directory.chmod(0o700)
            target = private_directory / "target.json"
            output = private_directory / "prompts.json"
            output.symlink_to(target)
            with self.assertRaisesRegex(RegistryError, "must not be a symlink"):
                private_dump(output, acknowledge_owned_prompts=True)


if __name__ == "__main__":
    unittest.main()
