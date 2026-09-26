import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Pins the publish contract: the publish.yml matrix, the docker/*.Dockerfile
// set, and the image names docker/docker-compose.yml pulls must all agree —
// the failure this prevents is a compose that pulls
// `ghcr.io/whybutter/onecli-<service>` images no workflow ever published,
// which breaks every clean-machine install. We only build four of the eight
// Dockerfiles in this tree (web, api, gateway, migrations); the rest
// (runner, agent, channel-adapter, ssh-terminator) stay pointed at
// upstream's published `ghcr.io/onecli/onecli-*` images (decision 0.A) —
// this test also pins that split explicitly. Also pins the repository guard
// that keeps both workflows inert outside whybutter/onecli, and the
// prerelease gate that keeps an -rc tag from capturing `latest`.

const read = (rel) =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), "utf8");

const publishYml = read(".github/workflows/publish.yml");
const releaseYml = read(".github/workflows/release.yml");
const composeYml = read("docker/docker-compose.yml");

// The two matrix lines (build + merge jobs). `include:` entries and the
// arch axis don't match this shape, so the extraction can't over-collect.
const serviceLines = [...publishYml.matchAll(/^\s*service: \[([^\]]+)\]\s*$/gm)];
const services = new Set(
  serviceLines[0]?.[1].split(",").map((s) => s.trim()) ?? [],
);

// The four upstream images we don't build — they stay on upstream's
// `ghcr.io/onecli/onecli-*` registry namespace (decision 0.A).
const UPSTREAM_PASSTHROUGH = new Set([
  "runner",
  "agent",
  "channel-adapter",
  "ssh-terminator",
]);

test("publish.yml has exactly two identical service matrices (build + merge)", () => {
  assert.equal(serviceLines.length, 2);
  assert.equal(serviceLines[0][1], serviceLines[1][1]);
  assert.ok(services.size > 0);
});

test("the matrix is a subset of the docker/*.Dockerfile set, excluding exactly the upstream-passthrough images", () => {
  const dockerfiles = new Set(
    readdirSync(fileURLToPath(new URL("../docker", import.meta.url)))
      .filter((f) => f.endsWith(".Dockerfile"))
      .map((f) => f.replace(/\.Dockerfile$/, "")),
  );
  for (const service of services)
    assert.ok(
      dockerfiles.has(service),
      `matrix service "${service}" has no docker/${service}.Dockerfile`,
    );
  const excluded = new Set(
    [...dockerfiles].filter((d) => !services.has(d)),
  );
  assert.deepEqual(excluded, UPSTREAM_PASSTHROUGH);
});

test("every image the compose pulls from our registry is in the matrix; every image it pulls from upstream's is in the known-excluded set", () => {
  // Captures the `-<service>` suffix and stops at the tag colon, so the
  // nested RUNNER_AGENT_IMAGE default parses too; the legacy all-in-one
  // `ghcr.io/onecli/onecli:` (no dash suffix) intentionally doesn't match.
  const ours = [
    ...composeYml.matchAll(/ghcr\.io\/whybutter\/onecli-([a-z0-9-]+):/g),
  ].map((m) => m[1]);
  const upstream = [
    ...composeYml.matchAll(/ghcr\.io\/onecli\/onecli-([a-z0-9-]+):/g),
  ].map((m) => m[1]);

  assert.ok(ours.length > 0);
  for (const name of ours)
    assert.ok(services.has(name), `compose pulls unpublished image: ${name}`);

  assert.ok(upstream.length > 0);
  for (const name of upstream) {
    assert.ok(
      UPSTREAM_PASSTHROUGH.has(name),
      `compose pulls "${name}" from upstream's registry, but it isn't in the known-excluded set`,
    );
    assert.ok(
      !services.has(name),
      `"${name}" is pulled from upstream's registry but is also in our publish matrix`,
    );
  }
  // The agent image is not a compose service (it's the RUNNER_AGENT_IMAGE
  // default the runner pulls lazily) — assert it explicitly so dropping it
  // from the compose default can't silently orphan the exclusion list.
  assert.ok(upstream.includes("agent"));
});

const jobBlocks = (yml) => {
  const tail = yml.slice(yml.indexOf("\njobs:"));
  const blocks = [];
  for (const line of tail.split("\n")) {
    const job = line.match(/^ {2}([\w-]+):\s*$/);
    if (job) blocks.push({ name: job[1], body: "" });
    else if (blocks.length) blocks[blocks.length - 1].body += `${line}\n`;
  }
  return blocks;
};

test("every job in both workflows carries the whybutter/onecli repository guard", () => {
  const all = [...jobBlocks(publishYml), ...jobBlocks(releaseYml)];
  assert.ok(all.length >= 3);
  for (const { name, body } of all)
    assert.match(
      body,
      /^ {4}if: github\.repository == 'whybutter\/onecli'$/m,
      `job "${name}" is missing the repository guard`,
    );
});

test("the latest tag is gated off prerelease refs", () => {
  assert.match(
    publishYml,
    /type=raw,value=latest,enable=\$\{\{ !contains\(github\.ref_name, '-'\) \}\}/,
  );
  assert.doesNotMatch(publishYml, /type=raw,value=latest\s*$/m);
});
