#!/usr/bin/env python3
"""Batched descriptor-relative source reader for platforms without procfs dirfd paths."""

import base64
import errno
import json
import os
import stat
import sys


def fail(message):
    raise RuntimeError(message)


def stat_receipt(value):
    return {
        "dev": str(value.st_dev),
        "ino": str(value.st_ino),
        "mode": format(stat.S_IMODE(value.st_mode), "o"),
        "nlink": str(value.st_nlink),
        "uid": str(value.st_uid),
        "gid": str(value.st_gid),
        "size": str(value.st_size),
        "mtimeNs": str(value.st_mtime_ns),
        "ctimeNs": str(value.st_ctime_ns),
    }


def same_stat(left, right):
    return stat_receipt(left) == stat_receipt(right)


def same_identity(left, right):
    return (
        left.st_dev == right.st_dev
        and left.st_ino == right.st_ino
        and stat.S_IFMT(left.st_mode) == stat.S_IFMT(right.st_mode)
    )


def safe_relative(value):
    if value == ".":
        return True
    return (
        isinstance(value, str)
        and value
        and "\\" not in value
        and "\0" not in value
        and not value.startswith("/")
        and all(part not in ("", ".", "..") for part in value.split("/"))
    )


def checked_lstat(name, directory_fd, source_path, label):
    try:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except OSError as error:
        if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP):
            fail(f"{label} changed during descriptor traversal: {source_path}")
        raise


class RootedReader:
    def __init__(self, root, label, expected_root):
        self.root = os.path.abspath(root)
        self.label = label
        if os.path.realpath(self.root) != self.root:
            fail(f"{label} source root ancestors must not be symbolic links")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_DIRECTORY
        flags |= getattr(os, "O_CLOEXEC", 0)
        self.root_chain = []
        try:
            filesystem_root = os.path.abspath(os.sep)
            descriptor = os.open(filesystem_root, flags)
            opened = os.fstat(descriptor)
            self.root_chain.append((descriptor, opened, None, None))
            for part in self.root[len(filesystem_root):].split(os.sep):
                if not part:
                    continue
                parent_fd = self.root_chain[-1][0]
                before = checked_lstat(part, parent_fd, ".", label)
                if stat.S_ISLNK(before.st_mode) or not stat.S_ISDIR(before.st_mode):
                    fail(f"{label} source root ancestors must be real directories")
                descriptor = os.open(part, flags, dir_fd=parent_fd)
                opened = os.fstat(descriptor)
                if not stat.S_ISDIR(opened.st_mode) or not same_identity(before, opened):
                    os.close(descriptor)
                    fail(f"{label} source root changed before descriptor traversal")
                self.root_chain.append((descriptor, opened, parent_fd, part))
        except Exception:
            for descriptor, _, _, _ in reversed(self.root_chain):
                os.close(descriptor)
            raise
        self.root_fd = self.root_chain[-1][0]
        self.root_stat = self.root_chain[-1][1]
        receipt = stat_receipt(self.root_stat)
        if expected_root is not None and receipt != expected_root:
            fail(f"{label} root changed during descriptor traversal")
        self.root_receipt = receipt

    def close(self):
        for descriptor, _, _, _ in reversed(self.root_chain):
            os.close(descriptor)
        self.root_chain = []
        self.root_fd = None

    def verify_root(self, source_path):
        for index, (descriptor, before, parent_fd, name) in enumerate(self.root_chain):
            descriptor_after = os.fstat(descriptor)
            path_after = os.lstat(os.sep) if parent_fd is None else checked_lstat(
                name,
                parent_fd,
                source_path,
                self.label,
            )
            compare = same_stat if index == len(self.root_chain) - 1 else same_identity
            if (
                stat.S_ISLNK(path_after.st_mode)
                or not compare(before, descriptor_after)
                or not compare(descriptor_after, path_after)
            ):
                fail(f"{self.label} root changed during descriptor traversal: {source_path}")

    def read_entry(self, source_path):
        if not safe_relative(source_path):
            fail(f"{self.label} reported an unsafe source path")
        opened = [(os.dup(self.root_fd), ".", self.root_stat, None, None)]
        try:
            parts = [] if source_path == "." else source_path.split("/")
            current_path = ""
            for index, part in enumerate(parts):
                current_path = f"{current_path}/{part}" if current_path else part
                parent_fd = opened[-1][0]
                path_stat = checked_lstat(part, parent_fd, source_path, self.label)
                if stat.S_ISLNK(path_stat.st_mode):
                    fail(f"symbolic links are forbidden in {self.label}: {current_path}")
                final = index == len(parts) - 1
                if not final and not stat.S_ISDIR(path_stat.st_mode):
                    fail(f"{self.label} ancestor is not a directory: {current_path}")
                flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                if not final:
                    flags |= os.O_DIRECTORY
                try:
                    descriptor = os.open(part, flags, dir_fd=parent_fd)
                except OSError as error:
                    if error.errno in (errno.ENOTDIR, errno.EMLINK, errno.ELOOP):
                        fail(f"symbolic links are forbidden in {self.label}: {current_path}")
                    raise
                descriptor_stat = os.fstat(descriptor)
                if not same_stat(path_stat, descriptor_stat):
                    os.close(descriptor)
                    fail(f"{self.label} changed before descriptor read: {current_path}")
                if not final and not stat.S_ISDIR(descriptor_stat.st_mode):
                    os.close(descriptor)
                    fail(f"{self.label} ancestor is not a directory: {current_path}")
                opened.append((descriptor, current_path, descriptor_stat, parent_fd, part))

            descriptor, _, final_stat, _, _ = opened[-1]
            if stat.S_ISREG(final_stat.st_mode):
                if final_stat.st_nlink != 1:
                    fail(f"hard-linked files are forbidden in {self.label}: {source_path}")
                chunks = []
                while True:
                    chunk = os.read(descriptor, 1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                data = b"".join(chunks)
                if len(data) != final_stat.st_size:
                    fail(f"{self.label} changed during descriptor read: {source_path}")
                value = {
                    "kind": "file",
                    "data": base64.b64encode(data).decode("ascii"),
                }
            elif stat.S_ISDIR(final_stat.st_mode):
                value = {"kind": "directory", "names": sorted(os.listdir(descriptor))}
            else:
                fail(f"{self.label} supports only regular files and directories: {source_path}")

            for index, (node_fd, _, before, parent_fd, name) in enumerate(opened):
                descriptor_after = os.fstat(node_fd)
                if index == 0:
                    path_after = descriptor_after
                else:
                    path_after = checked_lstat(name, parent_fd, source_path, self.label)
                if (
                    stat.S_ISLNK(path_after.st_mode)
                    or not same_stat(before, descriptor_after)
                    or not same_stat(descriptor_after, path_after)
                ):
                    fail(f"{self.label} changed during descriptor traversal: {source_path}")

            self.verify_root(source_path)

            value["path"] = source_path
            value["stat"] = stat_receipt(final_stat)
            value["ancestry"] = [
                {"path": node_path, **stat_receipt(node_stat)}
                for _, node_path, node_stat, _, _ in opened
            ]
            return value
        finally:
            for descriptor, _, _, _, _ in reversed(opened):
                os.close(descriptor)


def main():
    request = json.load(sys.stdin)
    root = request.get("root")
    label = request.get("label")
    paths = request.get("paths")
    prune = request.get("prune")
    walk = request.get("walk")
    if not isinstance(root, str) or not isinstance(label, str):
        fail("invalid rooted-reader request")
    if not isinstance(paths, list) or any(not safe_relative(item) for item in paths):
        fail("invalid rooted-reader paths")
    if not isinstance(prune, list) or any(not safe_relative(item) for item in prune):
        fail("invalid rooted-reader prune paths")
    if not isinstance(walk, bool):
        fail("invalid rooted-reader walk mode")
    expected_root = request.get("expectedRoot")
    if expected_root is not None and not isinstance(expected_root, dict):
        fail("invalid rooted-reader root receipt")

    reader = RootedReader(root, label, expected_root)
    entries = []
    seen = set()
    pruned = set(prune)

    def visit(source_path):
        if source_path in seen:
            return
        # Pruned metadata is outside the source model, including the boundary
        # directory itself. This mirrors the Linux descriptor reader exactly.
        if source_path != "." and any(
            source_path == boundary or source_path.startswith(f"{boundary}/")
            for boundary in pruned
        ):
            seen.add(source_path)
            return
        entry = reader.read_entry(source_path)
        seen.add(source_path)
        entries.append(entry)
        if walk and entry["kind"] == "directory":
            for name in entry["names"]:
                visit(name if source_path == "." else f"{source_path}/{name}")

    try:
        for source_path in sorted(set(paths)):
            visit(source_path)
        reader.verify_root(".")
        print(json.dumps({"ok": True, "root": reader.root_receipt, "entries": entries}))
    finally:
        reader.close()


try:
    main()
except Exception as error:
    message = str(error).replace("\n", " ")[:512]
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)
