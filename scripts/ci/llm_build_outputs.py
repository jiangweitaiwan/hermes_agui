"""Resolve only successfully published Cloud Build images for a coordinated rollout."""

import json
import re
import sys
from pathlib import Path


def resolve_images(build: dict, prefix: str) -> dict[str, str]:
    """Reject unsuccessful or incomplete artifact sets before any service changes."""
    if build.get("status") != "SUCCESS":
        raise ValueError("Cloud Build did not succeed")
    published = build.get("results", {}).get("images", [])
    images = {}
    for output, name in (("host_image", "hermes-host"), ("runtime_image", "hermes-runtime")):
        repository = f"{prefix}/{name}"
        matches = [image for image in published if image["name"].startswith(repository + ":")]
        if len(matches) != 1 or not re.fullmatch(r"sha256:[a-f0-9]{64}", matches[0].get("digest", "")):
            raise ValueError(f"Missing or ambiguous published digest for {name}")
        images[output] = f"{repository}@{matches[0]['digest']}"
    return images


def main() -> None:
    build_file, prefix, output_file = sys.argv[1:]
    images = resolve_images(json.loads(Path(build_file).read_text(encoding="utf-8-sig")), prefix)
    with Path(output_file).open("a", encoding="utf-8") as output:
        output.writelines(f"{name}={image}\n" for name, image in images.items())


if __name__ == "__main__":
    main()
