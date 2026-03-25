"""
Split large virtual_weights.json files into chunks for GitHub compatibility.

Walks all example directories. If virtual_weights.json exceeds 100MB,
splits it into ~50MB chunks and creates a manifest file.
"""

import json
import os

MAX_SIZE = 100 * 1024 * 1024  # 100MB
CHUNK_TARGET = 50 * 1024 * 1024  # 50MB target per chunk

EXAMPLES_DIR = os.path.join(os.path.dirname(__file__), "examples")


def split_file(filepath):
    file_size = os.path.getsize(filepath)
    if file_size <= MAX_SIZE:
        return

    print(f"Splitting {filepath} ({file_size / 1024 / 1024:.1f} MB)")

    with open(filepath) as f:
        data = json.load(f)

    total_entries = len(data)
    # Estimate entries per chunk based on file size ratio
    num_chunks = max(2, int(file_size / CHUNK_TARGET) + 1)
    entries_per_chunk = total_entries // num_chunks + 1

    dirpath = os.path.dirname(filepath)
    part_num = 0

    for i in range(0, total_entries, entries_per_chunk):
        chunk = data[i : i + entries_per_chunk]
        part_path = os.path.join(dirpath, f"virtual_weights_part{part_num}.json")
        with open(part_path, "w") as f:
            json.dump(chunk, f)
        part_size = os.path.getsize(part_path)
        print(f"  Part {part_num}: {len(chunk)} entries, {part_size / 1024 / 1024:.1f} MB")
        part_num += 1

    # Write manifest
    manifest_path = os.path.join(dirpath, "virtual_weights_manifest.json")
    with open(manifest_path, "w") as f:
        json.dump({"parts": part_num}, f)

    # Remove original
    os.remove(filepath)
    print(f"  Created {part_num} parts, removed original")


def main():
    for root, dirs, files in os.walk(EXAMPLES_DIR):
        if "virtual_weights.json" in files:
            split_file(os.path.join(root, "virtual_weights.json"))


if __name__ == "__main__":
    main()
