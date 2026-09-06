"""Secure curated artifacts and immutable reviewed evidence.

The library deliberately has no implicit roots.  Callers provide an explicit,
profile-scoped collection allowlist; retained bytes live below that profile and
are the authority from which the disposable JSON index can be rebuilt.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from contextlib import contextmanager
import errno
import html
from html.parser import HTMLParser
import hashlib
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import stat
from typing import Any, BinaryIO, Callable, Mapping, Sequence
import uuid


_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_HTML_CSP = (
    "sandbox; default-src 'none'; base-uri 'none'; form-action 'none'; "
    "navigate-to 'none'; frame-ancestors 'none'"
)
_PLATFORM_NOFOLLOW = getattr(os, "O_NOFOLLOW", None)
_OPEN_SUPPORTS_DIR_FD = os.open in getattr(os, "supports_dir_fd", set())
_STAT_SUPPORTS_DIR_FD = os.stat in getattr(os, "supports_dir_fd", set())
_DEFAULT_MAX_FILE_SIZE = 64 * 1024 * 1024
_DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024
_DEFAULT_MAX_SCAN_FILES = 10_000
_DEFAULT_MAX_SCAN_DEPTH = 32
_DEFAULT_MAX_RETAINED_ITEMS = 10_000
_DEFAULT_MAX_RETAINED_BYTES = 256 * 1024 * 1024
_DEFAULT_MAX_HTML_PREVIEW_SIZE = 16 * 1024 * 1024
_MAX_PROFILE_BYTES = 512
_MAX_COLLECTION_TEXT_BYTES = 4096
_MAX_RELATIVE_PATH_BYTES = 4096
_MAX_PATH_COMPONENT_BYTES = 255
_MAX_TITLE_BYTES = 4096
_MAX_RELATIONSHIP_ID_BYTES = 512
_MAX_RELATIONSHIP_TITLE_BYTES = 4096
_MAX_RELATIONSHIPS_PER_KIND = 256
_MAX_PROVENANCE_BYTES = 64 * 1024
_MAX_PROVENANCE_DEPTH = 8
_MAX_PROVENANCE_ITEMS = 256
_UNSUPPORTED = {
    "kind": "unsupported",
    "preview_available": False,
    "message": "Preview unavailable—download original",
}


class _StaticHTMLSanitizer(HTMLParser):
    """Reduce untrusted HTML to inert, attribute-free formatting markup."""

    _allowed = frozenset({
        "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code",
        "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "h1",
        "h2", "h3", "h4", "h5", "h6", "hr", "i", "ins", "kbd", "li",
        "mark", "ol", "p", "pre", "q", "s", "samp", "small", "span",
        "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot",
        "th", "thead", "time", "tr", "u", "ul", "var",
    })
    _void = frozenset({"br", "hr"})
    _drop_void = frozenset({
        "area", "base", "col", "embed", "img", "input", "link", "meta",
        "param", "source", "track", "wbr",
    })
    _drop_with_contents = frozenset({
        "applet", "audio", "canvas", "iframe", "math", "noscript",
        "object", "picture", "script", "style", "svg", "template", "video",
    })

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._output: list[str] = []
        self._open: list[str] = []
        self._blocked_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs  # No source attributes survive, including URLs, CSS, and events.
        tag = tag.lower()
        if self._blocked_depth:
            self._blocked_depth += 1
            return
        if tag in self._drop_void:
            return
        if tag in self._drop_with_contents:
            self._blocked_depth = 1
            return
        if tag in self._allowed:
            self._output.append(f"<{tag}>")
            if tag not in self._void:
                self._open.append(tag)

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if not self._blocked_depth and tag.lower() in self._allowed:
            self._output.append(f"<{tag.lower()}>")

    def handle_endtag(self, tag: str) -> None:
        if self._blocked_depth:
            self._blocked_depth -= 1
            return
        tag = tag.lower()
        if tag not in self._open:
            return
        while self._open:
            opened = self._open.pop()
            self._output.append(f"</{opened}>")
            if opened == tag:
                break

    def handle_data(self, data: str) -> None:
        if not self._blocked_depth:
            self._output.append(html.escape(data, quote=False))

    def document(self) -> bytes:
        while self._open:
            self._output.append(f"</{self._open.pop()}>")
        body = "".join(self._output)
        return (
            "<!doctype html><html><head><meta charset=\"utf-8\">"
            f"<meta http-equiv=\"Content-Security-Policy\" content=\"{_HTML_CSP}\">"
            "<title>Static artifact preview</title></head><body>"
            f"{body}</body></html>"
        ).encode("utf-8")


def _sanitize_static_html(source: bytes, *, max_size: int) -> bytes:
    parser = _StaticHTMLSanitizer()
    parser.feed(source.decode("utf-8", errors="replace"))
    parser.close()
    rendered = parser.document()
    if len(rendered) > max_size:
        raise ArtifactUnavailable("generated HTML preview exceeds the configured size limit")
    return rendered


class ArtifactError(Exception):
    """Base error carrying a stable application-facing category."""

    def __init__(self, message: str, code: str = "artifact_error") -> None:
        super().__init__(message)
        self.code = code


class ArtifactSecurityError(ArtifactError):
    def __init__(self, message: str = "artifact access denied") -> None:
        super().__init__(message, "forbidden")


class ArtifactUnavailable(ArtifactError):
    def __init__(self, message: str = "artifact unavailable") -> None:
        super().__init__(message, "unavailable")


class ArtifactNotFound(ArtifactError):
    def __init__(self, message: str = "artifact not found") -> None:
        super().__init__(message, "not_found")


@dataclass(frozen=True)
class Collection:
    id: str
    name: str
    root: Path
    owner: str
    description: str | None = None
    root_identity: tuple[int, int] | None = None
    root_rejected: bool = False

    def public(self) -> dict[str, Any]:
        available = False
        root_fd: int | None = None
        if not self.root_rejected:
            try:
                root_fd = ArtifactLibrary._open_absolute_directory(self.root)
                identity = ArtifactLibrary._directory_identity(root_fd)
                available = self.root_identity is None or identity == self.root_identity
            except ArtifactError:
                available = False
            finally:
                if root_fd is not None:
                    os.close(root_fd)
        result: dict[str, Any] = {
            "id": self.id,
            "name": self.name,
            "owner": self.owner,
            "availability": "available" if available else "unavailable",
        }
        if self.description:
            result["description"] = self.description
        return result


class OpenedArtifact:
    """An already-verified file descriptor plus safe response metadata."""

    def __init__(self, file: BinaryIO, metadata: Mapping[str, Any]) -> None:
        self.file = file
        self.metadata = dict(metadata)

    def read(self, size: int = -1) -> bytes:
        try:
            return self.file.read(size)
        except OSError as exc:
            raise ArtifactUnavailable("artifact read failed") from exc

    def fileno(self) -> int:
        return self.file.fileno()

    def close(self) -> None:
        self.file.close()

    def __enter__(self) -> "OpenedArtifact":
        return self

    def __exit__(self, *_: object) -> None:
        self.close()


def classify_preview(
    filename: str, mime_type: str | None = None, content: bytes | None = None
) -> dict[str, Any]:
    """Classify only when suffix, declared type, and bytes independently agree."""
    suffix = Path(filename).suffix.lower()
    mime = (mime_type or "").split(";", 1)[0].strip().lower()
    if not isinstance(content, bytes):
        return dict(_UNSUPPORTED)

    def text_bytes() -> bool:
        if b"\x00" in content:
            return False
        try:
            decoded = content.decode("utf-8")
        except UnicodeDecodeError:
            return False
        controls = sum(ord(char) < 32 and char not in "\n\r\t\f" for char in decoded)
        return controls <= max(1, len(decoded) // 100)

    markdown_suffixes = {".md", ".markdown", ".mdown", ".mkd"}
    if suffix in markdown_suffixes and mime in {"", "text/markdown", "text/x-markdown"} and text_bytes():
        return {"kind": "markdown", "preview_available": True}
    if suffix in {".txt", ".log", ".text"} and mime in {"", "text/plain"} and text_bytes():
        return {"kind": "text", "preview_available": True}
    image_signatures = {
        ".png": content.startswith(b"\x89PNG\r\n\x1a\n"),
        ".jpg": content.startswith(b"\xff\xd8\xff"),
        ".jpeg": content.startswith(b"\xff\xd8\xff"),
        ".gif": content.startswith((b"GIF87a", b"GIF89a")),
        ".webp": len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP",
        ".avif": len(content) >= 12 and content[4:8] == b"ftyp" and content[8:12] in {b"avif", b"avis"},
    }
    expected_image_mimes = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif",
    }
    if image_signatures.get(suffix, False) and mime in {"", expected_image_mimes[suffix]}:
        return {"kind": "image", "preview_available": True}
    if suffix == ".pdf" and mime in {"", "application/pdf"} and content.startswith(b"%PDF-"):
        return {"kind": "pdf", "preview_available": True}
    prefix = content[:4096].lstrip().lower()
    html_signature = any(token in prefix for token in (b"<!doctype html", b"<html", b"<head", b"<body"))
    if suffix in {".html", ".htm"} and mime in {"", "text/html"} and text_bytes() and html_signature:
        return {
            "kind": "html",
            "preview_available": True,
            "sandbox": "",  # no allow-scripts or allow-same-origin capabilities
            "scripts": False,
            "network": False,
            "app_origin": False,
            "content_security_policy": _HTML_CSP,
        }
    return dict(_UNSUPPORTED)


def load_collections(config: Mapping[str, Any] | None) -> list[Mapping[str, Any]]:
    """Extract collection config from supported explicit config sections.

    An absent/malformed section fails closed to an empty allowlist.  Mappings
    may key entries by collection id; lists must carry their own ``id``.
    """
    if not isinstance(config, Mapping):
        return []
    value: Any = config.get("artifact_library")
    if value is None:
        value = config.get("library")
    if value is None and isinstance(config.get("companion"), Mapping):
        value = config["companion"].get("library")
    if isinstance(value, Mapping) and "collections" in value:
        value = value["collections"]
    if isinstance(value, Mapping):
        result = []
        for ident, item in value.items():
            if isinstance(item, str):
                item = {"root": item}
            if isinstance(item, Mapping):
                result.append({"id": ident, **item})
        return result
    if isinstance(value, list):
        return [item for item in value if isinstance(item, Mapping)]
    return []


class ArtifactLibrary:
    """Profile-local curated library with immutable evidence retention."""

    schema_version = 1

    def __init__(
        self,
        profile_home: str | Path,
        *,
        profile: str,
        collections: Sequence[Mapping[str, Any]] | Mapping[str, Any] | None = None,
        clock: Callable[[], datetime] | None = None,
        max_file_size: int = _DEFAULT_MAX_FILE_SIZE,
        max_scan_bytes: int = _DEFAULT_MAX_SCAN_BYTES,
        max_scan_files: int = _DEFAULT_MAX_SCAN_FILES,
        max_scan_depth: int = _DEFAULT_MAX_SCAN_DEPTH,
        max_retained_items: int = _DEFAULT_MAX_RETAINED_ITEMS,
        max_retained_bytes: int = _DEFAULT_MAX_RETAINED_BYTES,
        max_html_preview_size: int = _DEFAULT_MAX_HTML_PREVIEW_SIZE,
    ) -> None:
        if (
            not isinstance(profile, str)
            or not profile
            or any(ord(c) < 32 for c in profile)
            or len(profile.encode("utf-8")) > _MAX_PROFILE_BYTES
        ):
            raise ValueError("invalid profile")
        self.profile_home = Path(profile_home).expanduser().resolve(strict=False)
        self.profile = profile
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        positive_limits = (
            max_file_size,
            max_scan_bytes,
            max_scan_files,
            max_retained_items,
            max_retained_bytes,
            max_html_preview_size,
        )
        if any(
            not isinstance(limit, int) or isinstance(limit, bool) or limit <= 0
            for limit in positive_limits
        ) or (
            not isinstance(max_scan_depth, int)
            or isinstance(max_scan_depth, bool)
            or max_scan_depth < 0
        ):
            raise ValueError(
                "artifact size/count limits must be positive and depth must be non-negative"
            )
        self.max_file_size = max_file_size
        self.max_scan_bytes = max_scan_bytes
        self.max_scan_files = max_scan_files
        self.max_scan_depth = max_scan_depth
        self.max_retained_items = max_retained_items
        self.max_retained_bytes = max_retained_bytes
        self.max_html_preview_size = max_html_preview_size
        if isinstance(collections, Mapping):
            collections = load_collections({"library": {"collections": collections}})
        self._collections = self._parse_collections(collections or [])
        self.storage_root = self.profile_home / "retained-artifacts"
        self.objects_root = self.storage_root / "objects"
        self.staging_root = self.storage_root / ".staging"
        self.index_path = self.storage_root / "index.json"
        profile_fd = self._open_or_create_absolute_directory(self.profile_home)
        try:
            self._profile_identity = self._directory_identity(profile_fd)
            storage_fd = self._open_private_child(profile_fd, "retained-artifacts", create=True)
            try:
                self._storage_identity = self._directory_identity(storage_fd)
                self._storage_child_identities: dict[str, tuple[int, int]] = {}
                for name in ("objects", ".staging"):
                    child_fd = self._open_private_child(storage_fd, name, create=True)
                    self._storage_child_identities[name] = self._directory_identity(
                        child_fd
                    )
                    os.close(child_fd)
            finally:
                os.close(storage_fd)
        finally:
            os.close(profile_fd)


    @staticmethod
    def _directory_identity(fd: int) -> tuple[int, int]:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode):
            raise ArtifactSecurityError("private artifact path is not a directory")
        return info.st_dev, info.st_ino

    @staticmethod
    def _open_or_create_absolute_directory(path: Path) -> int:
        """Create/open an absolute path without following any component symlink."""
        if not path.is_absolute() or not _OPEN_SUPPORTS_DIR_FD or not _PLATFORM_NOFOLLOW:
            raise ArtifactSecurityError("secure no-follow directory access is unavailable")
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _PLATFORM_NOFOLLOW
        current = os.open("/", flags)
        try:
            for part in path.parts[1:]:
                try:
                    next_fd = os.open(part, flags, dir_fd=current)
                except FileNotFoundError:
                    try:
                        os.mkdir(part, 0o700, dir_fd=current)
                    except FileExistsError:
                        pass
                    next_fd = os.open(part, flags, dir_fd=current)
                os.close(current)
                current = next_fd
            result = current
            current = -1
            return result
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
                raise ArtifactSecurityError("private artifact directory traversal was denied") from exc
            raise ArtifactUnavailable("private artifact directory is unavailable") from exc
        finally:
            if current >= 0:
                os.close(current)

    @staticmethod
    def _open_private_child(parent_fd: int, name: str, *, create: bool = False) -> int:
        if not _PLATFORM_NOFOLLOW or not _OPEN_SUPPORTS_DIR_FD:
            raise ArtifactSecurityError("secure no-follow directory access is unavailable")
        if create:
            try:
                os.mkdir(name, 0o700, dir_fd=parent_fd)
            except FileExistsError:
                pass
        flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | _PLATFORM_NOFOLLOW
        fd: int | None = None
        try:
            fd = os.open(name, flags, dir_fd=parent_fd)
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                raise ArtifactSecurityError("private artifact path is not a directory")
            os.fchmod(fd, 0o700)
            return fd
        except ArtifactSecurityError:
            if fd is not None:
                os.close(fd)
            raise
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
                raise ArtifactSecurityError(
                    "private artifact directory is not a real directory"
                ) from exc
            raise ArtifactUnavailable("private artifact directory is unavailable") from exc

    @contextmanager
    def _opened_storage(self):
        """Yield the initialized storage inode, rejecting replaced ancestors."""
        profile_fd = self._open_absolute_directory(self.profile_home)
        storage_fd: int | None = None
        try:
            if self._directory_identity(profile_fd) != self._profile_identity:
                raise ArtifactSecurityError("profile directory was replaced")
            storage_fd = self._open_private_child(profile_fd, "retained-artifacts")
            if self._directory_identity(storage_fd) != self._storage_identity:
                raise ArtifactSecurityError("private artifact directory was replaced")
            yield storage_fd
        finally:
            if storage_fd is not None:
                os.close(storage_fd)
            os.close(profile_fd)

    def _open_storage_child(self, storage_fd: int, name: str) -> int:
        fd = self._open_private_child(storage_fd, name)
        if self._directory_identity(fd) != self._storage_child_identities[name]:
            os.close(fd)
            raise ArtifactSecurityError("private artifact directory was replaced")
        return fd

    @classmethod
    def from_config(
        cls, profile_home: str | Path, *, profile: str, config: Mapping[str, Any] | None = None
    ) -> "ArtifactLibrary":
        if config is None:
            path = Path(profile_home) / "config.yaml"
            if not path.is_file():
                config = {}
            else:
                import yaml
                try:
                    loaded = yaml.safe_load(path.read_text(encoding="utf-8"))
                    config = loaded if isinstance(loaded, Mapping) else {}
                except (OSError, ValueError, yaml.YAMLError):
                    config = {}
        return cls(profile_home, profile=profile, collections=load_collections(config))

    def _parse_collections(self, entries: Sequence[Mapping[str, Any]]) -> dict[str, Collection]:
        parsed: dict[str, Collection] = {}
        for raw in entries:
            ident, name, root = raw.get("id"), raw.get("name"), raw.get("root")
            if not isinstance(ident, str) or not _ID_RE.fullmatch(ident):
                raise ValueError("collection id must be a safe stable identifier")
            if ident in parsed:
                raise ValueError(f"duplicate collection id: {ident}")
            if not self._bounded_text(name, _MAX_COLLECTION_TEXT_BYTES):
                raise ValueError(f"invalid collection name: {ident}")
            if not isinstance(root, (str, os.PathLike)) or not str(root):
                raise ValueError(f"collection root is required: {ident}")
            canonical = Path(os.path.abspath(os.fspath(Path(root).expanduser())))
            root_identity: tuple[int, int] | None = None
            root_rejected = False
            root_fd: int | None = None
            try:
                root_fd = self._open_absolute_directory(canonical)
                root_identity = self._directory_identity(root_fd)
            except ArtifactUnavailable:
                pass
            except ArtifactSecurityError:
                root_rejected = True
            finally:
                if root_fd is not None:
                    os.close(root_fd)
            description = raw.get("description")
            owner = raw.get("owner", self.profile)
            if not self._bounded_text(owner, _MAX_COLLECTION_TEXT_BYTES):
                raise ValueError(f"invalid collection owner: {ident}")
            if description is not None and not self._bounded_text(
                description, _MAX_COLLECTION_TEXT_BYTES, allow_empty=True
            ):
                raise ValueError(f"invalid collection description: {ident}")
            assert isinstance(name, str) and isinstance(owner, str)
            parsed[ident] = Collection(
                ident, name.strip(), canonical, owner.strip(),
                description.strip() if isinstance(description, str) and description.strip() else None,
                root_identity, root_rejected,
            )
        return parsed

    def list_collections(self) -> list[dict[str, Any]]:
        return [self._collections[key].public() for key in sorted(self._collections)]

    @staticmethod
    def _bounded_text(value: object, max_bytes: int, *, allow_empty: bool = False) -> bool:
        return (
            isinstance(value, str)
            and (allow_empty or bool(value.strip()))
            and not any(ord(char) < 32 for char in value)
            and len(value.encode("utf-8")) <= max_bytes
        )

    @staticmethod
    def _validated_provenance(value: Mapping[str, Any] | str) -> Mapping[str, Any] | str:
        """Validate JSON shape and encoded size before copying caller metadata."""
        item_count = 0
        encoded_bytes = 0
        active: set[int] = set()

        def visit(item: object, depth: int) -> None:
            nonlocal item_count, encoded_bytes
            if depth > _MAX_PROVENANCE_DEPTH:
                raise ValueError("provenance exceeds the configured depth limit")
            item_count += 1
            if item_count > _MAX_PROVENANCE_ITEMS:
                raise ValueError("provenance exceeds the configured item-count limit")
            if isinstance(item, str):
                encoded_bytes += len(item.encode("utf-8"))
            elif item is None or isinstance(item, (bool, int, float)):
                if isinstance(item, float) and not (float("-inf") < item < float("inf")):
                    raise ValueError("provenance must contain finite JSON values")
                encoded_bytes += len(str(item).encode("ascii"))
            elif isinstance(item, Mapping):
                identity = id(item)
                if identity in active:
                    raise ValueError("provenance must not contain cycles")
                active.add(identity)
                try:
                    for key, child in item.items():
                        if not isinstance(key, str):
                            raise ValueError("provenance mapping keys must be strings")
                        visit(key, depth + 1)
                        visit(child, depth + 1)
                finally:
                    active.remove(identity)
            elif isinstance(item, (list, tuple)):
                identity = id(item)
                if identity in active:
                    raise ValueError("provenance must not contain cycles")
                active.add(identity)
                try:
                    for child in item:
                        visit(child, depth + 1)
                finally:
                    active.remove(identity)
            else:
                raise ValueError("provenance must contain only JSON values")
            if encoded_bytes > _MAX_PROVENANCE_BYTES:
                raise ValueError("provenance exceeds the configured byte limit")

        visit(value, 0)
        # JSON punctuation/escaping can expand the encoded representation, so
        # enforce the limit on the exact serialization before manifest creation.
        try:
            encoded = json.dumps(
                value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                allow_nan=False,
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise ValueError("provenance must contain only JSON values") from exc
        if len(encoded) > _MAX_PROVENANCE_BYTES:
            raise ValueError("provenance exceeds the configured byte limit")
        return json.loads(encoded)

    @classmethod
    def _validated_relationships(
        cls, value: Mapping[str, Any] | None
    ) -> dict[str, list[dict[str, str]]]:
        """Validate explicit entity links without deriving them from file names.

        Relationship records contain a canonical entity identifier and its
        backend/profile namespace. This prevents an ID from another source from
        being mistaken for an authorized entity with the same local ID.
        """
        empty = {"projects": [], "topics": [], "sessions": []}
        if value is None:
            return empty
        if not isinstance(value, Mapping) or set(value) - set(empty):
            raise ValueError("invalid artifact relationships")
        result: dict[str, list[dict[str, str]]] = {}
        for kind in empty:
            raw_items = value.get(kind, [])
            if (
                not isinstance(raw_items, (list, tuple))
                or len(raw_items) > _MAX_RELATIONSHIPS_PER_KIND
            ):
                raise ValueError("invalid artifact relationships")
            normalized: list[dict[str, str]] = []
            seen: set[str] = set()
            for raw in raw_items:
                allowed = {"id", "title", "backend_namespace", "profile"}
                if kind == "sessions":
                    allowed.add("relationship")
                if not isinstance(raw, Mapping) or set(raw) - allowed:
                    raise ValueError("invalid artifact relationship")
                ident = raw.get("id")
                if (
                    not isinstance(ident, str)
                    or not cls._bounded_text(ident, _MAX_RELATIONSHIP_ID_BYTES)
                    or "/" in ident
                    or "\\" in ident
                    or ident in {".", ".."}
                ):
                    raise ValueError("invalid artifact relationship identifier")
                assert isinstance(ident, str)
                backend_namespace = raw.get("backend_namespace")
                relationship_profile = raw.get("profile")
                if not cls._bounded_text(
                    backend_namespace, _MAX_RELATIONSHIP_ID_BYTES
                ):
                    raise ValueError("artifact relationship backend identity is required")
                if not cls._bounded_text(relationship_profile, _MAX_PROFILE_BYTES):
                    raise ValueError("artifact relationship profile identity is required")
                assert isinstance(backend_namespace, str)
                assert isinstance(relationship_profile, str)
                item = {
                    "id": ident,
                    "backend_namespace": backend_namespace,
                    "profile": relationship_profile,
                }
                title = raw.get("title")
                if title is not None:
                    if not cls._bounded_text(title, _MAX_RELATIONSHIP_TITLE_BYTES):
                        raise ValueError("invalid artifact relationship title")
                    assert isinstance(title, str)
                    item["title"] = title.strip()
                if kind == "sessions":
                    relationship = raw.get("relationship", "related")
                    if relationship not in {"primary", "related"}:
                        raise ValueError("invalid artifact session relationship")
                    item["relationship"] = relationship
                if ident not in seen:
                    normalized.append(item)
                    seen.add(ident)
            if kind == "sessions" and sum(
                item["relationship"] == "primary" for item in normalized
            ) > 1:
                raise ValueError("artifact relationships have multiple primary sessions")
            result[kind] = normalized
        return result

    @staticmethod
    def _relative_parts(relative_path: str | os.PathLike[str]) -> tuple[str, ...]:
        if not isinstance(relative_path, (str, os.PathLike)):
            raise ArtifactSecurityError()
        value = os.fspath(relative_path)
        if not value or "\x00" in value or "\\" in value or os.path.isabs(value):
            raise ArtifactSecurityError("invalid root-relative artifact locator")
        parts = tuple(value.split("/"))
        if (
            len(value.encode("utf-8")) > _MAX_RELATIVE_PATH_BYTES
            or any(
                part in {"", ".", ".."}
                or len(part.encode("utf-8")) > _MAX_PATH_COMPONENT_BYTES
                for part in parts
            )
        ):
            raise ArtifactSecurityError("invalid root-relative artifact locator")
        return parts

    @staticmethod
    def _open_absolute_directory(
        root: Path, *, nofollow_flag: int | None = _PLATFORM_NOFOLLOW
    ) -> int:
        """Open an absolute directory one component at a time from ``/``."""
        if (
            not isinstance(nofollow_flag, int)
            or nofollow_flag <= 0
            or not _OPEN_SUPPORTS_DIR_FD
            or not root.is_absolute()
        ):
            raise ArtifactSecurityError("secure no-follow directory access is unavailable")
        directory_flag = getattr(os, "O_DIRECTORY", 0)
        current: int | None = None
        try:
            current = os.open("/", os.O_RDONLY | directory_flag | nofollow_flag)
            for part in root.parts[1:]:
                next_fd = os.open(
                    part, os.O_RDONLY | directory_flag | nofollow_flag, dir_fd=current
                )
                os.close(current)
                current = next_fd
            if not stat.S_ISDIR(os.fstat(current).st_mode):
                raise ArtifactSecurityError("artifact root is not a real directory")
            result = current
            current = None
            return result
        except ArtifactSecurityError:
            raise
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
                raise ArtifactSecurityError("artifact root traversal was denied") from exc
            raise ArtifactUnavailable("artifact root is unavailable") from exc
        finally:
            if current is not None:
                try:
                    os.close(current)
                except OSError:
                    pass

    @staticmethod
    def _open_regular_under(
        root: Path,
        relative_path: str,
        *,
        nofollow_flag: int | None = _PLATFORM_NOFOLLOW,
    ) -> BinaryIO:
        """Open a regular descendant without ever following a path symlink.

        ``nofollow_flag`` is an explicit capability seam for tests and unusual
        runtimes. A missing/zero capability is denied rather than degraded to a
        traversal-prone ordinary open.
        """
        parts = ArtifactLibrary._relative_parts(relative_path)
        if not isinstance(nofollow_flag, int) or nofollow_flag <= 0 or not _OPEN_SUPPORTS_DIR_FD:
            raise ArtifactSecurityError("secure no-follow file access is unavailable")
        directory_flag = getattr(os, "O_DIRECTORY", 0)
        directory_fds: list[int] = []

        def open_directory(path: str | os.PathLike[str], *, dir_fd: int | None = None) -> int:
            kwargs = {} if dir_fd is None else {"dir_fd": dir_fd}
            fd = os.open(path, os.O_RDONLY | directory_flag | nofollow_flag, **kwargs)
            try:
                is_directory = stat.S_ISDIR(os.fstat(fd).st_mode)
            except Exception:
                os.close(fd)
                raise
            if not is_directory:
                os.close(fd)
                raise ArtifactSecurityError("artifact path component is not a directory")
            return fd

        try:
            current = ArtifactLibrary._open_absolute_directory(
                root, nofollow_flag=nofollow_flag
            )
            directory_fds.append(current)
            for part in parts[:-1]:
                current = open_directory(part, dir_fd=current)
                directory_fds.append(current)
            # O_NONBLOCK prevents a malicious FIFO in an allowlisted tree from
            # hanging the service before fstat can reject it as non-regular.
            fd: int | None = None
            try:
                fd = os.open(
                    parts[-1],
                    os.O_RDONLY | nofollow_flag | getattr(os, "O_NONBLOCK", 0),
                    dir_fd=current,
                )
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode):
                    raise ArtifactSecurityError("artifact is not a regular file")
                handle = os.fdopen(fd, "rb", closefd=True)
                fd = None
                return handle
            finally:
                if fd is not None:
                    os.close(fd)
        except ArtifactSecurityError:
            raise
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
                raise ArtifactSecurityError() from exc
            if exc.errno in {errno.ENOENT, errno.ESTALE}:
                raise ArtifactUnavailable() from exc
            raise ArtifactUnavailable(str(exc)) from exc
        finally:
            for fd in reversed(directory_fds):
                try:
                    os.close(fd)
                except OSError:
                    pass

    def _open_regular_at(self, root_fd: int, relative_path: str) -> BinaryIO:
        """Open a regular descendant relative to an already validated root fd."""
        parts = ArtifactLibrary._relative_parts(relative_path)
        if not _PLATFORM_NOFOLLOW or not _OPEN_SUPPORTS_DIR_FD:
            raise ArtifactSecurityError("secure no-follow file access is unavailable")
        current = os.dup(root_fd)
        try:
            for part in parts[:-1]:
                next_fd: int | None = None
                try:
                    next_fd = os.open(
                        part,
                        os.O_RDONLY
                        | getattr(os, "O_DIRECTORY", 0)
                        | _PLATFORM_NOFOLLOW,
                        dir_fd=current,
                    )
                    if not stat.S_ISDIR(os.fstat(next_fd).st_mode):
                        raise ArtifactSecurityError(
                            "artifact path component is not a directory"
                        )
                except Exception:
                    if next_fd is not None:
                        os.close(next_fd)
                    raise
                os.close(current)
                current = next_fd
            fd: int | None = None
            try:
                fd = os.open(
                    parts[-1],
                    os.O_RDONLY | _PLATFORM_NOFOLLOW | getattr(os, "O_NONBLOCK", 0),
                    dir_fd=current,
                )
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise ArtifactSecurityError("artifact is not a regular file")
                handle = os.fdopen(fd, "rb", closefd=True)
                fd = None
                return handle
            finally:
                if fd is not None:
                    os.close(fd)
        except ArtifactSecurityError:
            raise
        except OSError as exc:
            if exc.errno in {errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM}:
                raise ArtifactSecurityError("artifact traversal was denied") from exc
            raise ArtifactUnavailable("artifact is unavailable") from exc
        finally:
            os.close(current)

    def _open_retained_regular_at(
        self, storage_fd: int, relative_path: str
    ) -> BinaryIO:
        """Open retained bytes after enforcing the initialized child inode."""
        parts = self._relative_parts(relative_path)
        child_name = parts[0]
        if child_name not in self._storage_child_identities or len(parts) < 2:
            raise ArtifactSecurityError("retained artifact path is outside private storage")
        child_fd = self._open_storage_child(storage_fd, child_name)
        try:
            return self._open_regular_at(child_fd, "/".join(parts[1:]))
        finally:
            os.close(child_fd)

    @staticmethod
    def _digest_opened(file: BinaryIO, *, max_size: int) -> tuple[str, int]:
        digest = hashlib.sha256()
        size = 0
        try:
            before = os.fstat(file.fileno())
            if before.st_size > max_size:
                raise ArtifactUnavailable("artifact exceeds the configured size limit")
            file.seek(0)
            while chunk := file.read(min(1024 * 1024, max_size + 1 - size)):
                digest.update(chunk)
                size += len(chunk)
                if size > max_size:
                    raise ArtifactUnavailable("artifact exceeds the configured size limit")
            after = os.fstat(file.fileno())
            stable_fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns")
            if size != before.st_size or any(
                getattr(before, key) != getattr(after, key) for key in stable_fields
            ):
                raise ArtifactUnavailable("artifact changed while it was being read")
            file.seek(0)
            return digest.hexdigest(), size
        except ArtifactError:
            raise
        except (OSError, ValueError) as exc:
            raise ArtifactUnavailable("artifact read failed") from exc

    def _collection(self, collection_id: str) -> Collection:
        try:
            return self._collections[collection_id]
        except (KeyError, TypeError) as exc:
            raise ArtifactSecurityError("collection is not allowlisted") from exc

    def _open_collection_root(self, collection: Collection) -> int:
        if collection.root_rejected:
            raise ArtifactSecurityError("configured artifact root was rejected")
        root_fd = self._open_absolute_directory(collection.root)
        if (
            collection.root_identity is not None
            and self._directory_identity(root_fd) != collection.root_identity
        ):
            os.close(root_fd)
            raise ArtifactSecurityError("configured artifact root was replaced")
        return root_fd

    def _artifact_id(self, collection_id: str, relative_path: str) -> str:
        material = f"{self.profile}\0{collection_id}\0{relative_path}".encode("utf-8")
        return "art_" + hashlib.sha256(material).hexdigest()

    @staticmethod
    def _version_id(artifact_id: str, sha256: str) -> str:
        return "ver_" + hashlib.sha256(f"{artifact_id}\0{sha256}".encode()).hexdigest()

    @staticmethod
    def _mime(filename: str) -> str:
        return mimetypes.guess_type(filename, strict=False)[0] or "application/octet-stream"

    def _live_metadata(self, collection: Collection, relative_path: str, file: BinaryIO) -> dict[str, Any]:
        digest, size = self._digest_opened(file, max_size=self.max_file_size)
        try:
            modified_at = datetime.fromtimestamp(
                os.fstat(file.fileno()).st_mtime, timezone.utc
            ).isoformat().replace("+00:00", "Z")
        except (OSError, OverflowError, ValueError) as exc:
            raise ArtifactUnavailable("artifact modification date is unavailable") from exc
        artifact_id = self._artifact_id(collection.id, relative_path)
        mime = self._mime(relative_path)
        try:
            suffix = Path(relative_path).suffix.lower()
            text_suffixes = {
                ".md", ".markdown", ".mdown", ".mkd", ".txt", ".log",
                ".text", ".html", ".htm",
            }
            # Text must be validated in full, not merely by a plausible prefix.
            # Files too large for the bounded preview pipeline remain downloadable.
            if suffix in text_suffixes and size > self.max_html_preview_size:
                signature = None
            else:
                probe_size = size if suffix in text_suffixes else min(size, 4096)
                signature = file.read(probe_size)
                if len(signature) != probe_size:
                    raise ArtifactUnavailable("artifact changed while its type was being validated")
            file.seek(0)
        except (OSError, ValueError) as exc:
            raise ArtifactUnavailable("artifact read failed") from exc
        return {
            "artifact_id": artifact_id,
            "profile": self.profile,
            "collection": collection.public(),
            "owner": collection.owner,
            "relative_path": relative_path,
            "filename": Path(relative_path).name,
            "size": size,
            "sha256": digest,
            "mime_type": mime,
            "preview": classify_preview(relative_path, mime, signature),
            "availability": "available",
            "version_id": self._version_id(artifact_id, digest),
            "reviewed": False,
            "status": "live",
            "modified_at": modified_at,
            "relationships": {"projects": [], "topics": [], "sessions": []},
            "download": {"authenticated_request_required": True, "url": None},
        }

    def open_source(self, collection_id: str, relative_path: str) -> OpenedArtifact:
        collection = self._collection(collection_id)
        normalized = "/".join(self._relative_parts(relative_path))
        root_fd = self._open_collection_root(collection)
        file: BinaryIO | None = None
        failed = True
        try:
            file = self._open_regular_at(root_fd, normalized)
            metadata = self._live_metadata(collection, normalized, file)
            opened = OpenedArtifact(file, metadata)
            failed = False
            return opened
        finally:
            try:
                os.close(root_fd)
            except BaseException:
                # A close failure turns an otherwise successful open into a
                # failure, so ownership of the source descriptor cannot be
                # transferred to the caller.
                failed = True
                raise
            finally:
                if failed and file is not None:
                    file.close()

    def scan(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        scanned_entries = 0
        scanned_bytes = 0
        for collection_id in sorted(self._collections):
            collection = self._collections[collection_id]
            try:
                root_fd = self._open_collection_root(collection)
            except ArtifactError:
                continue
            try:
                if not hasattr(os, "fwalk") or not _STAT_SUPPORTS_DIR_FD:
                    raise ArtifactSecurityError("secure bounded directory scanning is unavailable")
                for current, directories, files, current_fd in os.fwalk(
                    ".", topdown=True, follow_symlinks=False, dir_fd=root_fd
                ):
                    relative_dir = Path(current)
                    depth = 0 if current == "." else len(relative_dir.parts)
                    scanned_entries += len(directories) + len(files)
                    if scanned_entries > self.max_scan_files:
                        raise ArtifactUnavailable(
                            "artifact scan exceeds the configured file-count limit"
                        )
                    directories[:] = sorted(directories) if depth < self.max_scan_depth else []
                    for filename in sorted(files):
                        try:
                            info = os.stat(filename, dir_fd=current_fd, follow_symlinks=False)
                            if not stat.S_ISREG(info.st_mode):
                                continue
                            if info.st_size > self.max_file_size:
                                raise ArtifactUnavailable("artifact exceeds the configured size limit")
                            relative = (relative_dir / filename).as_posix()
                            if relative.startswith("./"):
                                relative = relative[2:]
                            with self._open_regular_at(root_fd, relative) as file:
                                opened_info = os.fstat(file.fileno())
                                identity_fields = ("st_dev", "st_ino", "st_mode")
                                if any(
                                    getattr(info, key) != getattr(opened_info, key)
                                    for key in identity_fields
                                ):
                                    raise ArtifactUnavailable(
                                        "artifact changed while it was being scanned"
                                    )
                                metadata = self._live_metadata(collection, relative, file)
                            scanned_bytes += metadata["size"]
                            if scanned_bytes > self.max_scan_bytes:
                                raise ArtifactUnavailable(
                                    "artifact scan exceeds the configured byte limit"
                                )
                            items.append(metadata)
                        except OSError:
                            continue
            finally:
                os.close(root_fd)
        return sorted(items, key=lambda item: (item["collection"]["id"], item["relative_path"]))

    @staticmethod
    def _safe_filename(filename: str) -> str:
        name = Path(filename).name
        name = "".join("_" if ord(ch) < 32 else ch for ch in name).strip(". ")
        if not name:
            name = "artifact"
        if len(name.encode("utf-8")) > 180:
            suffix = Path(name).suffix[:30]
            stem = Path(name).stem.encode("utf-8")[: 170 - len(suffix.encode())].decode("utf-8", "ignore")
            name = (stem or "artifact") + suffix
        return name

    def _write_private_json_at(
        self, directory_fd: int, filename: str, value: Mapping[str, Any]
    ) -> None:
        data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
        fd = os.open(
            filename,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | (_PLATFORM_NOFOLLOW or 0),
            0o600,
            dir_fd=directory_fd,
        )
        try:
            with os.fdopen(fd, "wb", closefd=False) as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
        finally:
            os.close(fd)

    def pin_reviewed(
        self,
        collection_id: str,
        relative_path: str,
        *,
        provenance: Mapping[str, Any] | str,
        title: str | None = None,
        relationships: Mapping[str, Any] | None = None,
        expected_fingerprint: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not isinstance(provenance, (Mapping, str)) or not provenance:
            raise ValueError("non-empty provenance is required")
        validated_provenance = self._validated_provenance(provenance)
        validated_relationships = self._validated_relationships(relationships)
        if title is not None and not self._bounded_text(
            title, _MAX_TITLE_BYTES, allow_empty=True
        ):
            raise ValueError("title exceeds the configured metadata limit")
        validated_title = title.strip() if isinstance(title, str) and title.strip() else None
        with self.open_source(collection_id, relative_path) as opened:
            try:
                source_before = os.fstat(opened.fileno())
            except OSError as exc:
                raise ArtifactUnavailable("artifact metadata could not be read") from exc
            metadata = dict(opened.metadata)
            if expected_fingerprint is not None and any(
                metadata.get(key) != expected_fingerprint.get(key)
                for key in ("sha256", "size", "filename", "mime_type")
            ):
                raise ArtifactUnavailable("reviewed source version is stale")
            artifact_id = metadata["artifact_id"]
            filename = self._safe_filename(metadata["filename"])
            with self._opened_storage() as storage_fd:
                objects_fd = self._open_storage_child(storage_fd, "objects")
                staging_fd = self._open_storage_child(storage_fd, ".staging")
                artifact_fd: int | None = None
                stage_fd: int | None = None
                stage_name = uuid.uuid4().hex
                digest = hashlib.sha256()
                size = 0
                try:
                    artifact_fd = self._open_private_child(
                        objects_fd, artifact_id, create=True
                    )
                    stage_fd = self._open_private_child(
                        staging_fd, stage_name, create=True
                    )
                    fd = os.open(
                        filename,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | (_PLATFORM_NOFOLLOW or 0),
                        0o600,
                        dir_fd=stage_fd,
                    )
                    try:
                        with os.fdopen(fd, "wb", closefd=False) as output:
                            opened.file.seek(0)
                            while chunk := opened.file.read(
                                min(1024 * 1024, self.max_file_size + 1 - size)
                            ):
                                output.write(chunk)
                                digest.update(chunk)
                                size += len(chunk)
                                if size > self.max_file_size:
                                    raise ArtifactUnavailable(
                                        "artifact exceeds the configured size limit"
                                    )
                            output.flush()
                            os.fsync(output.fileno())
                    except (OSError, ValueError) as exc:
                        raise ArtifactUnavailable(
                            "artifact read or retention write failed"
                        ) from exc
                    finally:
                        os.close(fd)
                    try:
                        source_after = os.fstat(opened.fileno())
                    except OSError as exc:
                        raise ArtifactUnavailable(
                            "artifact metadata could not be read"
                        ) from exc
                    stable_fields = (
                        "st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns"
                    )
                    if any(
                        getattr(source_before, key) != getattr(source_after, key)
                        for key in stable_fields
                    ):
                        raise ArtifactUnavailable(
                            "source changed while it was being retained"
                        )
                    sha256 = digest.hexdigest()
                    if size != metadata["size"] or sha256 != metadata["sha256"]:
                        raise ArtifactUnavailable(
                            "source changed while it was being retained"
                        )
                    if expected_fingerprint is not None and (
                        size != expected_fingerprint.get("size")
                        or sha256 != expected_fingerprint.get("sha256")
                    ):
                        raise ArtifactUnavailable("reviewed source version is stale")
                    version_id = self._version_id(artifact_id, sha256)
                    retained_object = f"objects/{artifact_id}/{version_id}/{filename}"
                    retained_manifest = (
                        f"objects/{artifact_id}/{version_id}/manifest.json"
                    )
                    manifest: dict[str, Any] = {
                        "schema_version": self.schema_version,
                        "artifact_id": artifact_id,
                        "version_id": version_id,
                        "profile": self.profile,
                        "collection": metadata["collection"],
                        "owner": metadata["owner"],
                        "relative_path": metadata["relative_path"],
                        "filename": filename,
                        "title": validated_title or filename,
                        "size": size,
                        "sha256": sha256,
                        "mime_type": metadata["mime_type"],
                        "preview": metadata["preview"],
                        "provenance": validated_provenance,
                        "ingested_at": self._clock().astimezone(timezone.utc).isoformat(),
                        "retained_object": retained_object,
                        "retained_manifest": retained_manifest,
                        "reviewed": True,
                        "status": "reviewed",
                        "relationships": validated_relationships,
                        "availability": "available",
                        "download": {
                            "authenticated_request_required": True, "url": None
                        },
                    }
                    self._write_private_json_at(stage_fd, "manifest.json", manifest)
                    os.fsync(stage_fd)
                    try:
                        os.rename(
                            stage_name,
                            version_id,
                            src_dir_fd=staging_fd,
                            dst_dir_fd=artifact_fd,
                        )
                        stage_name = ""
                    except OSError as exc:
                        if exc.errno not in {errno.EEXIST, errno.ENOTEMPTY}:
                            raise
                        self._remove_stage(staging_fd, stage_name, filename)
                        stage_name = ""
                        existing = self._manifest_for_at(
                            storage_fd, artifact_id, version_id
                        )
                        if (
                            existing is None
                            or existing.get("availability") != "available"
                            or existing.get("sha256") != sha256
                            or existing.get("size") != size
                        ):
                            raise ArtifactSecurityError(
                                "retained version identity collision"
                            )
                        self.rebuild_index()
                        return existing
                    os.fsync(artifact_fd)
                    self.rebuild_index()
                    return manifest
                finally:
                    if stage_fd is not None:
                        os.close(stage_fd)
                    if stage_name:
                        self._remove_stage(staging_fd, stage_name, filename)
                    if artifact_fd is not None:
                        os.close(artifact_fd)
                    os.close(staging_fd)
                    os.close(objects_fd)

    @staticmethod
    def _remove_stage(staging_fd: int, stage_name: str, filename: str) -> None:
        try:
            stage_fd = ArtifactLibrary._open_private_child(staging_fd, stage_name)
        except ArtifactError:
            return
        try:
            for name in (filename, "manifest.json"):
                try:
                    os.unlink(name, dir_fd=stage_fd)
                except FileNotFoundError:
                    pass
        finally:
            os.close(stage_fd)
        try:
            os.rmdir(stage_name, dir_fd=staging_fd)
        except FileNotFoundError:
            pass

    ingest = pin_reviewed

    def _read_manifest_at(self, storage_fd: int, relative: str) -> dict[str, Any] | None:
        try:
            with self._open_retained_regular_at(storage_fd, relative) as handle:
                raw = handle.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                return None
            value = json.loads(raw)
            if not isinstance(value, dict) or value.get("schema_version") != self.schema_version:
                return None
            artifact_id, version_id = value.get("artifact_id"), value.get("version_id")
            if not isinstance(artifact_id, str) or not artifact_id.startswith("art_") or not _ID_RE.fullmatch(artifact_id[4:]):
                return None
            if not isinstance(version_id, str) or not version_id.startswith("ver_") or not _ID_RE.fullmatch(version_id[4:]):
                return None
            expected = f"objects/{artifact_id}/{version_id}/manifest.json"
            if relative != expected or value.get("retained_manifest") != expected:
                return None
            collection = value.get("collection")
            collection_id = collection.get("id") if isinstance(collection, Mapping) else None
            source_relative = value.get("relative_path")
            sha256 = value.get("sha256")
            filename = value.get("filename")
            size = value.get("size")
            if value.get("profile") != self.profile or not isinstance(collection_id, str):
                return None
            if not isinstance(source_relative, str) or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256):
                return None
            if (
                not isinstance(filename, str)
                or filename != self._safe_filename(filename)
                or Path(filename).name != filename
                or not isinstance(size, int)
                or isinstance(size, bool)
                or size < 0
            ):
                return None
            self._relative_parts(source_relative)
            if artifact_id != self._artifact_id(collection_id, source_relative):
                return None
            if version_id != self._version_id(artifact_id, sha256):
                return None
            expected_object = f"objects/{artifact_id}/{version_id}/{filename}"
            if value.get("retained_object") != expected_object:
                return None
            if value.get("reviewed") is not True:
                return None
            # Schema-v1 manifests predate relationship/status fields.  Keep
            # their bytes valid and project conservative migration defaults
            # rather than rewriting immutable reviewed evidence in place.
            value.setdefault(
                "relationships", {"projects": [], "topics": [], "sessions": []}
            )
            value.setdefault("status", "reviewed")
            try:
                value["relationships"] = self._validated_relationships(
                    value["relationships"]
                )
            except ValueError:
                return None
            return value
        except (ArtifactError, OSError, ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return None

    def _manifests_at(self, storage_fd: int) -> list[dict[str, Any]]:
        manifests: list[dict[str, Any]] = []
        retained_items = 0
        retained_bytes = 0
        objects_fd = self._open_storage_child(storage_fd, "objects")
        try:
            artifact_names = sorted(os.listdir(objects_fd))
        finally:
            os.close(objects_fd)
        for artifact_name in artifact_names:
            if not artifact_name.startswith("art_") or not _ID_RE.fullmatch(
                artifact_name[4:]
            ):
                continue
            objects_fd = self._open_storage_child(storage_fd, "objects")
            try:
                try:
                    artifact_fd = self._open_private_child(objects_fd, artifact_name)
                except ArtifactError:
                    continue
                try:
                    version_names = sorted(os.listdir(artifact_fd))
                finally:
                    os.close(artifact_fd)
            finally:
                os.close(objects_fd)
            for version_name in version_names:
                if not version_name.startswith("ver_") or not _ID_RE.fullmatch(
                    version_name[4:]
                ):
                    continue
                retained_items += 1
                if retained_items > self.max_retained_items:
                    raise ArtifactUnavailable(
                        "retained manifest scan exceeds the configured item limit"
                    )
                relative = f"objects/{artifact_name}/{version_name}/manifest.json"
                manifest = self._read_manifest_at(storage_fd, relative)
                if manifest is None:
                    continue
                manifest_size = manifest.get("size")
                if type(manifest_size) is not int or manifest_size < 0:
                    continue
                retained_bytes += manifest_size
                if retained_bytes > self.max_retained_bytes:
                    raise ArtifactUnavailable(
                        "retained manifest scan exceeds the configured aggregate-byte limit"
                    )
                availability = "available"
                try:
                    object_rel = manifest.get("retained_object")
                    if not isinstance(object_rel, str):
                        raise ArtifactUnavailable()
                    with self._open_retained_regular_at(storage_fd, object_rel) as payload:
                        digest, size = self._digest_opened(
                            payload, max_size=self.max_file_size
                        )
                    if digest != manifest.get("sha256") or size != manifest.get("size"):
                        raise ArtifactUnavailable(
                            "retained evidence failed integrity verification"
                        )
                except ArtifactError:
                    availability = "unavailable"
                item = dict(manifest)
                item["availability"] = availability
                manifests.append(item)
        return manifests

    def _manifests(self) -> list[dict[str, Any]]:
        with self._opened_storage() as storage_fd:
            return self._manifests_at(storage_fd)

    def _grouped_metadata_at(self, storage_fd: int) -> list[dict[str, Any]]:
        grouped: dict[str, dict[str, Any]] = {}
        for manifest in self._manifests_at(storage_fd):
            artifact_id = manifest["artifact_id"]
            artifact = grouped.setdefault(artifact_id, {
                "artifact_id": artifact_id,
                "profile": manifest["profile"],
                "collection": manifest["collection"],
                "relative_path": manifest["relative_path"],
                "filename": manifest["filename"],
                "versions": [],
            })
            artifact["versions"].append(manifest)
        for artifact in grouped.values():
            artifact["versions"].sort(key=lambda item: item["version_id"])
        return sorted(grouped.values(), key=lambda item: (item["collection"]["id"], item["relative_path"], item["artifact_id"]))

    def _grouped_metadata(self) -> list[dict[str, Any]]:
        with self._opened_storage() as storage_fd:
            return self._grouped_metadata_at(storage_fd)

    def _rebuild_index_at(self, storage_fd: int) -> dict[str, Any]:
        index = {
            "schema_version": self.schema_version,
            "profile": self.profile,
            "collections": self.list_collections(),
            "artifacts": self._grouped_metadata_at(storage_fd),
        }
        temporary = ".index-" + uuid.uuid4().hex
        self._write_private_json_at(storage_fd, temporary, index)
        try:
            os.replace(
                temporary, "index.json", src_dir_fd=storage_fd, dst_dir_fd=storage_fd
            )
            os.fsync(storage_fd)
        except Exception:
            try:
                os.unlink(temporary, dir_fd=storage_fd)
            except FileNotFoundError:
                pass
            raise
        return index

    def rebuild_index(self) -> dict[str, Any]:
        with self._opened_storage() as storage_fd:
            return self._rebuild_index_at(storage_fd)

    def export_metadata(self) -> dict[str, Any]:
        """Return a deterministic snapshot without an export-time field."""
        return self.rebuild_index()

    def _manifest_for_at(
        self, storage_fd: int, artifact_id: str, version_id: str
    ) -> dict[str, Any] | None:
        if (
            not artifact_id.startswith("art_")
            or not _ID_RE.fullmatch(artifact_id[4:])
            or not version_id.startswith("ver_")
            or not _ID_RE.fullmatch(version_id[4:])
        ):
            return None
        relative = f"objects/{artifact_id}/{version_id}/manifest.json"
        manifest = self._read_manifest_at(storage_fd, relative)
        if manifest is None:
            return None
        result = dict(manifest)
        try:
            with self._open_retained_regular_at(
                storage_fd, manifest["retained_object"]
            ) as payload:
                digest, size = self._digest_opened(
                    payload,
                    max_size=min(self.max_file_size, self.max_retained_bytes),
                )
            if digest != manifest.get("sha256") or size != manifest.get("size"):
                raise ArtifactUnavailable(
                    "retained evidence failed integrity verification"
                )
        except (ArtifactError, KeyError):
            result["availability"] = "unavailable"
        else:
            result["availability"] = "available"
        return result

    def _manifest_for(self, artifact_id: str, version_id: str) -> dict[str, Any] | None:
        with self._opened_storage() as storage_fd:
            return self._manifest_for_at(storage_fd, artifact_id, version_id)

    def open_version(self, artifact_id: str, version_id: str) -> OpenedArtifact:
        file: BinaryIO | None = None
        try:
            with self._opened_storage() as storage_fd:
                manifest = self._manifest_for_at(storage_fd, artifact_id, version_id)
                if manifest is None:
                    raise ArtifactNotFound("reviewed artifact version not found")
                if manifest.get("availability") != "available":
                    raise ArtifactUnavailable("reviewed artifact version unavailable")
                file = self._open_retained_regular_at(
                    storage_fd, manifest["retained_object"]
                )
                digest, size = self._digest_opened(file, max_size=self.max_file_size)
                if digest != manifest["sha256"] or size != manifest["size"]:
                    raise ArtifactUnavailable(
                        "reviewed artifact version failed integrity verification"
                    )
                opened = OpenedArtifact(file, manifest)
                file = None
                return opened
        except KeyError as exc:
            raise ArtifactUnavailable("reviewed artifact metadata is invalid") from exc
        except OSError as exc:
            raise ArtifactUnavailable("reviewed artifact version could not be read") from exc
        finally:
            if file is not None:
                file.close()

    def _live_by_id(self, artifact_id: str) -> dict[str, Any] | None:
        return next((item for item in self.scan() if item["artifact_id"] == artifact_id), None)

    def open_latest(self, artifact_id: str) -> OpenedArtifact:
        item = self._live_by_id(artifact_id)
        if item is None:
            raise ArtifactUnavailable("latest artifact is unavailable")
        return self.open_source(item["collection"]["id"], item["relative_path"])

    def get_artifact(self, artifact_id: str) -> dict[str, Any]:
        grouped = next((item for item in self._grouped_metadata() if item["artifact_id"] == artifact_id), None)
        live = self._live_by_id(artifact_id)
        if grouped is None and live is None:
            raise ArtifactNotFound()
        if grouped is None:
            assert live is not None  # both-absent case was rejected above
            result = {
                "artifact_id": artifact_id,
                "profile": live["profile"],
                "collection": live["collection"],
                "relative_path": live["relative_path"],
                "filename": live["filename"],
                "versions": [],
            }
        else:
            result = dict(grouped)
        result["latest"] = live or {"availability": "unavailable"}
        return result

    def open_html_preview(
        self, artifact_id: str, version_id: str | None = None
    ) -> OpenedArtifact:
        """Return an enforced static HTML preview, never the original bytes.

        Callers must render this document in an iframe with the empty ``sandbox``
        value supplied in its metadata. ``download`` is the separate, explicit
        operation for retrieving the unmodified artifact.
        """
        source = (
            self.open_version(artifact_id, version_id)
            if version_id is not None
            else self.open_latest(artifact_id)
        )
        with source:
            preview_policy = source.metadata.get("preview")
            if not isinstance(preview_policy, Mapping) or preview_policy.get("kind") != "html":
                raise ArtifactUnavailable("static HTML preview is unavailable for this artifact")
            rendered = _sanitize_static_html(
                source.read(self.max_file_size + 1),
                max_size=self.max_html_preview_size,
            )
            metadata = dict(source.metadata)

        metadata.update({
            "filename": self._safe_filename(Path(metadata["filename"]).stem + "-preview.html"),
            "mime_type": "text/html; charset=utf-8",
            "size": len(rendered),
            "sha256": hashlib.sha256(rendered).hexdigest(),
            "sandbox": "",
            "scripts": False,
            "network": False,
            "app_origin": False,
            "content_security_policy": _HTML_CSP,
            "original_download_required": True,
        })
        return OpenedArtifact(io.BytesIO(rendered), metadata)

    def download(self, artifact_id: str, version_id: str | None = None) -> OpenedArtifact:
        """Return original bytes; transport auth stays outside shareable URLs."""
        return self.open_version(artifact_id, version_id) if version_id else self.open_latest(artifact_id)

    # Small, unsurprising aliases for callers that present this as a library.
    list_artifacts = scan
    pin = pin_reviewed

    def list_versions(self, artifact_id: str) -> list[dict[str, Any]]:
        return self.get_artifact(artifact_id)["versions"]
