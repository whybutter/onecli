import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { newTestIds } from "./ids.js";

// Fixtures encrypt placeholder credentials before writing them. The Rust test
// reads policy and host metadata, so only the seed process needs this key.
process.env.SECRET_ENCRYPTION_KEY ??= randomBytes(32).toString("base64");
const { compiledGrantStack, seedWorld } = await import("./fixtures.js");

// The Rust loader test reads this world from the unit-rust job's fresh DB.
const prisma = new PrismaClient();
const ids = {
  ...newTestIds(),
  org: "gwenf-org",
  workspace: "gwenf-ws",
  agent: "gwenf-agent",
};
const github = "github-app";
try {
  await seedWorld(prisma, ids, {
    secrets: ["oauth", "api-key"].map((value) => ({
      value,
      type: "openai",
      hostPattern: "api.openai.com",
    })),
    appConnections: [
      { provider: github },
      { provider: github },
      { provider: "google-calendar" },
      { provider: github },
    ],
    rules: [
      {
        name: "Gmail",
        action: "block",
        targets: [{ kind: "app", provider: "gmail" }],
      },
      {
        name: "OpenAI OAuth",
        action: "block",
        targets: [{ kind: "secret", secretIndex: 0 }],
      },
      {
        name: "Datadog",
        action: "block",
        targets: [{ kind: "app", provider: "datadog" }],
      },
      {
        name: "GitHub connection",
        action: "block",
        targets: [{ kind: "connection", connectionIndex: 0 }],
      },
      {
        name: "Network",
        action: "block",
        targets: [{ hostPattern: "blocked.example.com" }],
      },
      {
        name: "Disabled",
        action: "block",
        enabled: false,
        targets: [{ hostPattern: "disabled.example.com" }],
      },
      ...compiledGrantStack(
        "google-calendar",
        ["list_events"],
        {
          ask: ["create_event"],
          otherReads: "never",
          otherWrites: "never",
        },
        2,
      ),
      ...compiledGrantStack(
        github,
        ["graphql_query", "list_pulls"],
        {
          otherReads: "never",
          otherWrites: "never",
        },
        3,
      ),
      { name: "Default", action: "allow", isDefault: true },
    ],
  });
  await prisma.secret.update({
    where: { id: "gwenf-ws-sec-0" },
    data: { metadata: { authMode: "oauth" } },
  });
  await prisma.workspace.create({
    data: {
      id: "gwenf-ws-b",
      organizationId: ids.org,
      policyRulesV2: {
        create: {
          name: "Workspace fence",
          scope: "workspace",
          status: "published",
          generation: 1,
          priority: 1,
          action: "block",
          targets: {
            create: { kind: "network", hostPattern: "fence-only.example.com" },
          },
        },
      },
    },
  });
} finally {
  await prisma.$disconnect();
}
