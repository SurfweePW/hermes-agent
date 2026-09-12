# Companion Library receipt manifest

Status: implemented local contract; physical Android download/share remains a device gate.

## Authorized collections

The Library is not a home-directory browser. It exposes only collection roots explicitly allowlisted for the authenticated profile under `companion_library.profiles.<profile>.collections` (or the current launch profile's conservative top-level `companion_library.collections` shorthand). An absent or empty policy returns `unconfigured`, scans no root, and does not create retained storage. Cross-profile reads require an exact profile policy and an owner-authorized served profile.

Each public collection contains only `id`, `name`, `owner`, optional `description`, and live `availability`. Absolute roots, relative paths, local URLs, tokens, and credentials are not sent to the client. Project/topic/session links remain namespaced references to the same canonical artifact; they do not copy an artifact or transfer identity/review state between sources.

## Search and presentation

The mobile Library requests server-side search and bounded pagination. Available filters are collection, agent/profile, project, topic, session, reviewed/live status, preview type, and date. A row identifies:

- filename;
- MIME type;
- source collection and agent/profile;
- updated/ingested date;
- either the exact reviewed `version_id` or `Latest live`.

Reviewed retained bytes and Latest live bytes are separate selections. Opening a reviewed catalog row pins its retained version in the route. Selecting Latest never silently inherits reviewed identity.

## Preview policy

Preview classification requires agreement between filename suffix, MIME type, and inspected bytes:

| Kind | Accepted input | Client rendering |
| --- | --- | --- |
| Markdown | `.md`, `.markdown`, `.mdown`, `.mkd`; UTF-8 text; compatible MIME | inert React text in `<pre>` (no Markdown HTML execution) |
| Text | `.txt`, `.log`, `.text`; UTF-8 text; compatible MIME | inert React text in `<pre>` |
| JSON fallback | `.json`; valid UTF-8 JSON; compatible MIME | explicitly labelled inert plain text in `<pre>`; no embedded content executes |
| Image | PNG, JPEG, GIF, WebP, or AVIF with matching signature and MIME | object URL in `<img>` |
| PDF | `%PDF-` signature and compatible MIME | object URL in an iframe with an empty sandbox |
| HTML | `.html`/`.htm`, UTF-8 HTML signature and compatible MIME | backend-generated sanitized static document in `srcdoc`, empty iframe sandbox, scripts/network disabled, CSP `default-src 'none'` |
| Unsupported | mismatch, invalid content, or unavailable safe preview | honest fallback message; original download remains available |

JSON is intentionally not advertised as a distinct protocol kind in capability version 1. The current backend classifies validated JSON as `text`; the client labels this exact MIME-based fallback rather than claiming a rich JSON renderer.

Preview absence never disables original download. Marking Latest reviewed requires the signed immutable descriptor returned by that exact safe-preview transfer; a changed fingerprint is rejected.

## Download and integrity

Original bytes use owner-authenticated JSON-RPC base64 chunks. There is no public file URL. Every noninitial chunk must repeat the signed immutable descriptor; size, offsets, progress, chunk bounds, and final completeness are checked. Before creating a download Blob, the client computes SHA-256 over the assembled original bytes and compares it with the backend digest. A mismatch creates no object URL and no download.

The backend opens only regular descendants via directory file descriptors and `O_NOFOLLOW`, rejects traversal-shaped artifact/version identifiers, detects replaced roots and file races, verifies size/digest/stable inode metadata, and maps sensitive failures to non-disclosing RPC errors. Retained objects are reopened beneath pinned private-storage directory identities.

## Enforced limits

Protocol limits:

- page size: 1–500 (client requests the negotiated maximum and follows every signed snapshot cursor);
- chunk size: 1–256 KiB;
- cursor payload: at most 1 MiB;
- list snapshot: at most 10,000 items and 32 MiB, retained for 15 minutes, at most 64 snapshots;
- search: at most 500 characters;
- relationship filter: at most 256 values, each at most 512 UTF-8 bytes.

Per-profile policy may lower, but never exceed, these `ArtifactLibrary` ceilings:

- file size: 256 MiB;
- scanned bytes: 2 GiB;
- scanned files: 100,000;
- scan depth: 64;
- retained items: 100,000;
- retained bytes: 2 GiB;
- generated HTML preview: 32 MiB.

Malformed, unknown, boolean, nonpositive, or above-ceiling limit values fail closed.

## Frozen synthetic acceptance collection

The local acceptance receipt uses one synthetic public collection envelope only:

```json
{"id":"p6-safe-receipts","name":"P6 safe receipts","owner":"atlas","description":"Synthetic Companion Library acceptance evidence","availability":"available"}
```

The following item evidence is frozen for preview/download verification. The payload descriptions are literal and reproducible; artifact IDs, filenames, MIME values, byte counts, and SHA-256 values are the only client-visible evidence. No local root, relative path, credential, token, or real user content belongs in this collection.

| Type | Artifact ID | Filename | Literal payload evidence | Bytes | SHA-256 | Expected safe behavior |
| --- | --- | --- | --- | ---: | --- | --- |
| Markdown | `art_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` | `receipt.md` | UTF-8 `# Receipt\n` | 10 | `cd915f009b6c2c74cc0482ea4d51a17a2579b94079a78bed6fb3559e1b1babd2` | MIME `text/markdown`; inert `<pre>` preview |
| Text | `art_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` | `receipt.txt` | UTF-8 `receipt ok\n` | 11 | `2bce736dacf33101444f286441ec731dccf779ed4cb4676aa0dc56f42f49d4a4` | MIME `text/plain`; inert `<pre>` preview |
| JSON fallback | `art_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc` | `receipt.json` | UTF-8 `{"ok":true}\n` | 12 | `e5f1eb4d806641698a35efe20e098efd20d7d57a9b90ee69079d5bb650920726` | MIME `application/json`; labelled inert text preview |
| Image | `art_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd` | `pixel.png` | Base64 `iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=` | 68 | `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460` | PNG suffix, MIME, and signature agree; object-URL image preview |
| PDF | `art_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee` | `receipt.pdf` | UTF-8 `%PDF-1.4\n%%EOF\n` | 15 | `14bcd090baf31edba64e9cbd8cdfc15f943344aa72cb3675ad8e91bfcbce03ad` | PDF suffix, MIME, and `%PDF-` signature agree; sandboxed object-URL preview |
| HTML | `art_ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff` | `receipt.html` | UTF-8 `<!doctype html><html><body><p>safe</p></body></html>\n` | 53 | `1e428a26e96f8cd029fc0fd5c39c9d17d0fb7adaa383a9d313650909e9cc89ee` | Backend-generated sanitized `srcdoc`; empty sandbox and `default-src 'none'` CSP |
| CSV | `art_1111111111111111111111111111111111111111111111111111111111111111` | `receipt.csv` | UTF-8 `name,value\nreceipt,1\n` | 21 | `570215361efc104b1083a6b9c8b7bd1be23b3d483a0432a94b93724770525a44` | MIME `text/csv`; inert text preview and download |
| Archive / unsupported | `art_2222222222222222222222222222222222222222222222222222222222222222` | `bundle.zip` | Bytes begin `50 4b 03 04`, followed by ASCII `synthetic` | 13 | `0ea0879b8c5070c96040559630c36793d16e578becbd651ad5712218a6382e9b` | No browser preview; download MIME `application/octet-stream` |

Original-download MIME is independently derived from the sanitized filename and verified bytes. A filename/signature mismatch falls back to `application/octet-stream`; response MIME metadata cannot promote content to an active or privileged type. The hostile filename acceptance case `..\\..\\evil\r\nContent-Type: text/html.pdf` freezes to `evil__Content-Type_ text_html.pdf`, and only `%PDF-` bytes permit `application/pdf`.

## Android receipt gate

The implemented path exercises the existing web download action after authenticated transfer and SHA-256 verification. No Capacitor Share/Filesystem dependency exists in the Companion package, so this receipt does **not** claim a physical Android share-sheet or Downloads-provider result. Acceptance on a real Android device must confirm that the system WebView presents/saves the Blob download with the original filename and bytes; native share requires a separately approved dependency and device test if the WebView path is insufficient.
