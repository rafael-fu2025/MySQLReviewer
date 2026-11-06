#!/usr/bin/env python3
"""Scan git-tracked files for credential-like strings.

Read-only. Prints file:line + rule + masked match for each hit.
Used as a pre-push gate; not a general-purpose scanner.
"""
import re
import subprocess
import sys
from pathlib import Path

RULES = [
    ("aws-access-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github-pat", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b")),
    ("github-fine-pat", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{50,}\b")),
    ("openai-key", re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b")),
    ("google-api-key", re.compile(r"\bAIza[0-9A-Za-z_-]{30,}\b")),
    ("slack-token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private-key-block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----")),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("minimax-key", re.compile(r"\beyJhbGciOi[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b")),
    ("bearer-literal", re.compile(r"(?i)\b(?:bearer|authorization)\s*[:=]\s*['\"][A-Za-z0-9._-]{24,}['\"]")),
    ("assigned-secret", re.compile(
        r"(?i)\b(?:api[_-]?key|apikey|secret[_-]?key|secret|password|passwd|passphrase|pwd|"
        r"token|access[_-]?key|credential|private[_-]?key)\b"
        r"\s*[:=]\s*['\"][^'\"\s]{12,}['\"]")),
    ("connection-string-pw", re.compile(
        r"(?i)\b(?:mysql|postgres(?:ql)?|mongodb(?:\+srv)?|redis|amqp)://[^\s:@/]+:[^\s:@/]{3,}@")),
]

# Values that are obviously placeholders / test fixtures. Anchored at the
# start of the value so a real secret that merely *contains* one of these
# words (e.g. "sk-test-but-real") is not silently dismissed.
BENIGN = re.compile(
    r"(?i)^(?:x{3,}|\*{3,}|\.{3,}|dummy|placeholder|example|fake|your[-_]?\w+|"
    r"changeme|redacted|<[^>]+>|\$\{[^}]+\}|%[A-Z_]+%|null|none|undefined|"
    r"local-dev-|dev-only|not-a-real|"
    r"wrong[-_]?password|old[-_]?password|new[-_]?password|"
    r"(?:sk[-_]?)?probe[-_]|sample[-_]|fixture[-_]|"
    r"wrong[-_]?pass\w*|p@ssw0rd\w*)")

# A match inside a test file is expected to be a fixture. Real credentials
# leak into tests occasionally, so the scan still reports them - but the
# finding is labelled so a reviewer can triage in one glance.
TEST_PATH = re.compile(r"(^|/)(tests?|__tests__|spec)/|(^|/).*\.test\.[a-z]+$|(^|/).*\.spec\.[a-z]+$")

TEXT_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml",
    ".css", ".html", ".env", ".txt", ".sh", ".bat", ".ps1", ".sql", ".svg", ".toml",
}


def is_benign(value: str) -> bool:
    v = value.strip().strip("'\"")
    if not v:
        return True
    if BENIGN.match(v):
        return True
    # Obvious repeated-char filler.
    if len(set(v)) <= 3:
        return True
    return False


def mask(value: str) -> str:
    v = value.strip().strip("'\"")
    if len(v) <= 12:
        return v[:3] + "***"
    return f"{v[:6]}...{v[-4:]} ({len(v)} chars)"


def main() -> int:
    tracked = subprocess.run(
        ["git", "ls-files", "-z"], capture_output=True, text=True, check=True
    ).stdout.split("\0")
    tracked = [t for t in tracked if t]

    findings = []
    for rel in tracked:
        p = Path(rel)
        if not p.is_file():
            continue
        if p.suffix.lower() not in TEXT_EXT and p.name not in {"Dockerfile", "Makefile"}:
            continue
        try:
            content = p.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        in_test = bool(TEST_PATH.search(rel))
        for lineno, line in enumerate(content.splitlines(), 1):
            if len(line) > 4000:
                line = line[:4000]
            for name, rx in RULES:
                for m in rx.finditer(line):
                    raw = m.group(0)
                    if name == "assigned-secret":
                        value = raw.split(":=", 1)[-1] if ":=" in raw else raw.split("=", 1)[-1]
                        value = value.split(":", 1)[-1] if name == "assigned-secret" and ":" in value else value
                        value = value.strip().strip("'\"")
                        if is_benign(value):
                            continue
                    elif name in {"openai-key", "google-api-key", "github-pat", "github-fine-pat"}:
                        if is_benign(raw):
                            continue
                    if name == "private-key-block" and "PRIVATE KEY-----\\n" in line:
                        # An inline JS string fixture looks like
                        # '\nkey\n-----END PRIVATE KEY-----'. A real key has
                        # base64 body between the header and the footer.
                        tail = line.split("PRIVATE KEY-----\\n", 1)[-1]
                        if not re.search(r"[A-Za-z0-9+/]{40,}", tail):
                            continue
                    findings.append((rel, lineno, name, mask(raw), in_test))

    if not findings:
        print(f"OK: no credential patterns in {len(tracked)} tracked files")
        return 0

    print(f"FOUND {len(findings)} potential secret(s) in tracked files:\n")
    for rel, lineno, name, masked, in_test in findings:
        origin = " [test fixture - verify]" if in_test else ""
        print(f"  {rel}:{lineno}  [{name}]{origin}  {masked}")
    return 1


if __name__ == "__main__":
    sys.exit(main())
