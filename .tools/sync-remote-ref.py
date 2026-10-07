#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
sync-remote-ref.py —— 配合 push-via-api.py：把 GitHub 侧新建的提交对象在本地重建出来，
然后更新本地引用，让 `git status` / `git log` 回到自洽状态。

为什么需要：push-via-api.py 是通过 REST API 造提交的，那个对象**本地并不存在**；
直接 `git update-ref refs/remotes/origin/main <sha>` 会报
`trying to write ref ... with nonexistent object`，之后任何 `git log origin/main` 都会炸。

重建为什么必须"逐字节"：commit 对象的 SHA 由内容决定，差一个字节就换个号。
两处极易搞错的细节（2026-10-07 实测踩过）：
  1. **GitHub 的 API 把日期渲染成 `Z`（如 2026-10-07T04:40:04Z），但对象里存的仍是原始
     时区偏移**（如 `+0800`）。照着 API 显示值建对象，哈希必然对不上。
  2. GitHub 存下的提交消息**不带结尾换行**（本地 `git commit` 通常会带）。
所以这里对「时区偏移 × 结尾换行」做小规模枚举，并用 SHA 相等做**唯一验收标准** ——
只要哈希对上，就证明重建是逐字节正确的，不是"看起来差不多"。

用法:
  python .tools/sync-remote-ref.py <sha>            # 只更新 refs/remotes/origin/main
  python .tools/sync-remote-ref.py <sha> --also-head # 同时把 refs/heads/main 指过去
                                                      # （不动工作区/暂存区，安全）
"""
import datetime
import glob
import hashlib
import itertools
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

OWNER = "soloassistant"
REPO = "9-8"
API = "https://api.github.com"
REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def resolve_token():
    tok = os.environ.get("GITHUB_TOKEN", "").strip()
    if tok:
        return tok
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    payload = b"protocol=https\nhost=github.com\n\n"
    helpers = [
        p
        for pat in (
            os.path.join(
                os.path.expanduser("~"),
                ".workbuddy/binaries/PortableGit/versions/*/mingw64/bin/git-credential-wincred.exe",
            ),
            "C:/Program Files/Git/mingw64/bin/git-credential-wincred.exe",
        )
        for p in glob.glob(pat)
    ]
    for helper in helpers:
        try:
            out = subprocess.run(
                [helper, "get"], input=payload, capture_output=True, timeout=20, env=env
            ).stdout.decode("utf-8", "replace")
            for line in out.splitlines():
                if line.startswith("password=") and line[9:].strip():
                    return line[9:].strip()
        except Exception:
            continue
    raise SystemExit("取不到 GitHub 凭据：请在沙箱外运行，或设置 GITHUB_TOKEN。")


def api_get(token, path):
    req = urllib.request.Request(API + path)
    req.add_header("Authorization", "Bearer " + token)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "sync-remote-ref")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} GET {path}\n{e.read().decode('utf-8', 'replace')[:500]}")


def git(*args):
    return subprocess.check_output(["git", *args], cwd=REPO_DIR).decode("utf-8").strip()


def sha1_commit(body: bytes) -> str:
    return hashlib.sha1(b"commit %d\0" % len(body) + body).hexdigest()


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    target = sys.argv[1]
    also_head = "--also-head" in sys.argv

    token = resolve_token()
    d = api_get(token, f"/repos/{OWNER}/{REPO}/git/commits/{target}")

    tree = d["tree"]["sha"]
    parents = [p["sha"] for p in d.get("parents", [])]
    msg = d["message"]
    bot = d["author"]
    bct = d["committer"]
    # API 里的日期是"壁钟时间 Z 化"的展示值，其 epoch 可直接复用
    epoch = int(
        datetime.datetime.strptime(bot["date"], "%Y-%m-%dT%H:%M:%SZ")
        .replace(tzinfo=datetime.timezone.utc)
        .timestamp()
    )

    messages = {"as-is": msg, "no-trailing-newline": msg.rstrip("\n")}
    tzs = ["+0000", "+0800", "-0800", "+0530", "+0900"]
    found = None
    for (mname, m), tz, dts in itertools.product(messages.items(), tzs, (0, 28800, -28800, 3600, -3600)):
        ts = epoch + dts
        body = (
            f"tree {tree}\n"
            + "".join(f"parent {p}\n" for p in parents)
            + f"author {bot['name']} <{bot['email']}> {ts} {tz}\n"
            + f"committer {bct['name']} <{bct['email']}> {ts} {tz}\n\n"
            + m
        ).encode("utf-8")
        if sha1_commit(body) == target:
            found = (body, mname, tz, dts)
            break

    if not found:
        raise SystemExit(
            "重建失败：枚举的（时区 × 结尾换行 × 时间偏移）组合里没有哈希等于 %s 的对象。\n"
            "说明 GitHub 侧还用了别的规范化方式，请扩大枚举或改用 git fetch。" % target
        )

    body, mname, tz, dts = found
    p = subprocess.run(
        ["git", "hash-object", "-t", "commit", "-w", "--stdin"],
        input=body,
        capture_output=True,
        cwd=REPO_DIR,
    )
    got = p.stdout.decode().strip()
    if got != target:
        raise SystemExit(f"写入后哈希不符：{got} != {target}")

    print(f"逐字节重建成功：{target}")
    print(f"  命中组合：消息={mname} 时区={tz} 时间偏移={dts}s")

    git("update-ref", "refs/remotes/origin/main", target)
    print("  refs/remotes/origin/main 已更新")
    if also_head:
        git("update-ref", "refs/heads/main", target)
        print("  refs/heads/main 已更新（工作区/暂存区未改动）")
    print("  当前:", git("log", "--oneline", "-1"))


if __name__ == "__main__":
    main()
