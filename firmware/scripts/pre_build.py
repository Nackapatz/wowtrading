# PlatformIO pre-build hook.
#
# Generates the headers that the firmware includes but that are not committed:
#   include/logo.h          tools/make_logo.py          (if missing)
#   include/web_assets.h    tools/embed_web.py          (if missing or webapp/ newer)
#   include/default_cert.h  tools/make_default_cert.py  (if missing)
#
# Runs under SCons (PlatformIO extra_scripts "pre:"). Import("env") is provided
# by SCons, so this file is not a regular Python module.

import os
import subprocess
import sys

Import("env")  # noqa: F821  (injected by SCons)

PROJECT_DIR = env.subst("$PROJECT_DIR")
REPO_DIR = os.path.abspath(os.path.join(PROJECT_DIR, os.pardir))
INCLUDE_DIR = os.path.join(PROJECT_DIR, "include")
WEBAPP_DIR = os.path.join(REPO_DIR, "webapp")

# (generator script relative to the repo, generated header, extra inputs)
GENERATORS = [
    ("tools/make_logo.py", "logo.h", []),
    ("tools/embed_web.py", "web_assets.h", [WEBAPP_DIR]),
    ("tools/make_default_cert.py", "default_cert.h", []),
]


def newest_mtime(paths):
    """Return the newest modification time among files and folders in paths."""
    newest = 0.0
    for path in paths:
        if os.path.isdir(path):
            for root, _dirs, files in os.walk(path):
                for name in files:
                    newest = max(newest, os.path.getmtime(os.path.join(root, name)))
        elif os.path.exists(path):
            newest = max(newest, os.path.getmtime(path))
    return newest


def needs_generation(output, inputs):
    if not os.path.exists(output):
        return True
    return bool(inputs) and newest_mtime(inputs) > os.path.getmtime(output)


def main():
    for script, header, inputs in GENERATORS:
        output = os.path.join(INCLUDE_DIR, header)
        if not needs_generation(output, inputs):
            continue
        script_path = os.path.join(REPO_DIR, script)
        print("pre_build: generating %s via %s" % (header, script))
        result = subprocess.run([sys.executable, script_path], cwd=REPO_DIR)
        if result.returncode != 0 or not os.path.exists(output):
            sys.exit(
                "pre_build: %s failed. Install its requirements (pip install pillow "
                "cryptography) and run it manually to see the error." % script
            )


main()
