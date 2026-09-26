#!/usr/bin/env python3
"""设置 GitHub Actions 仓库密钥（Secret）。

需要 PyNaCl（pip install pynacl）和一个对该仓库有 Secrets 写权限的令牌。

用法：
    python tools/set-actions-secret.py NATFRP_TOKEN --value-file E:\\dsh\\.secrets\\natfrp-token.txt
    python tools/set-actions-secret.py NATFRP_TOKEN --value 明文值

用法说明：密钥内容不会打印出来，只报告长度。
"""

import argparse
import base64
import json
import pathlib
import sys
import urllib.error
import urllib.request

try:
    from nacl import encoding, public
except ImportError:
    sys.exit("✗ 需要 PyNaCl： python -m pip install pynacl")

# Windows 控制台默认 GBK，直接打印中文/符号会抛 UnicodeEncodeError
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass

API = "https://api.github.com"


def gh(method, url, token, body=None):
    req = urllib.request.Request(url, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "mc-server-status-secret")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, data) as resp:
            raw = resp.read().decode()
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode()
        try:
            return exc.code, json.loads(raw or "{}")
        except json.JSONDecodeError:
            return exc.code, {"raw": raw}


def read_value_file(path):
    return pathlib.Path(path).read_text(encoding="utf-8").strip()


def main():
    parser = argparse.ArgumentParser(description="设置 GitHub Actions 仓库密钥")
    parser.add_argument("name", help="密钥名称，例如 NATFRP_TOKEN")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--value", help="密钥明文（会出现在命令历史里，不推荐）")
    group.add_argument("--value-file", help="从文件读取密钥（推荐）")
    parser.add_argument("--repo", default="moyudehaoren/mc-server-status")
    parser.add_argument("--gh-token-file", default=r"E:\dsh\.secrets\gh-token.txt")
    args = parser.parse_args()

    value = args.value if args.value is not None else read_value_file(args.value_file)
    gh_token = read_value_file(args.gh_token_file)

    status, key = gh("GET", f"{API}/repos/{args.repo}/actions/secrets/public-key", gh_token)
    if status != 200:
        print(f"✗ 读取仓库公钥失败：HTTP {status} {key}")
        print("  多半是令牌缺少 Secrets: Read and write 权限（网页上也能手动加密钥）")
        sys.exit(1)

    pk = public.PublicKey(key["key"].encode(), encoding.Base64Encoder())
    sealed = public.SealedBox(pk).encrypt(value.encode())
    encrypted = base64.b64encode(sealed).decode()

    status, res = gh(
        "PUT",
        f"{API}/repos/{args.repo}/actions/secrets/{args.name}",
        gh_token,
        {"encrypted_value": encrypted, "key_id": key["key_id"]},
    )
    if status in (201, 204):
        print(f"✓ 已设置仓库密钥 {args.name}（值长度 {len(value)}，内容未打印）")
    else:
        print(f"✗ 设置失败：HTTP {status} {res}")
        sys.exit(1)


if __name__ == "__main__":
    main()
