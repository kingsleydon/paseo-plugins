import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Plugin client bundles reach Hermes (iOS, Android) without Metro's transforms, and Hermes rejects
// class syntax (getpaseo/paseo#5783). Paseo only lowers async/await for them.
const root = join(import.meta.dirname, "..");
const clientSources = [
  join(root, "index.client.tsx"),
  ...["client", "shared"].flatMap((dir) =>
    readdirSync(join(root, dir))
      .filter((file) => /\.tsx?$/.test(file))
      .map((file) => join(root, dir, file)),
  ),
];

describe("client code runs on Hermes", () => {
  it.each(clientSources)("%s declares no classes", (file) => {
    expect(readFileSync(file, "utf8")).not.toMatch(/^\s*(export\s+)?(default\s+)?(abstract\s+)?class\s/m);
  });
});
