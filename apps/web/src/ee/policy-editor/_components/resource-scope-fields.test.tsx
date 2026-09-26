// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Connection } from "@/lib/api";
import { ResourceScopeFields } from "./resource-scope-fields";
import { ResourceScopeFields as FreeResourceScopeFields } from "@/lib/policy-editor/resource-scope";

/**
 * The "Resources" row: it must render on self-host (the old `IS_CLOUD` gate
 * made the picker unreachable here), describe the EFFECTIVE scope (policy ∩
 * org boundary), and host the provider's picker behind Manage.
 */

const github = (overrides: Partial<Connection> = {}): Connection => ({
  id: "conn-gh",
  provider: "github-app",
  label: "Acme GitHub",
  status: "active",
  scopes: [],
  scope: "workspace",
  connectedAt: "2026-01-01T00:00:00Z",
  metadata: {
    username: "acme",
    repositorySelection: "selected",
    repos: ["acme/api", "acme/web", "acme/docs"],
  },
  ...overrides,
});

const dropbox = (): Connection => ({
  ...github(),
  id: "conn-dbx",
  provider: "dropbox",
  label: "Team Dropbox",
  metadata: {},
});

describe("ResourceScopeFields (free wrapper, self-host)", () => {
  it("renders the real editor for a GitHub App connection", async () => {
    render(
      <FreeResourceScopeFields
        connection={github()}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    expect(await screen.findByText("Resources")).toBeInTheDocument();
    expect(screen.getByText("All repositories")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Manage resources" }),
    ).toBeInTheDocument();
  });

  it("shows a plain hint for a scopable provider without a picker", () => {
    render(
      <FreeResourceScopeFields
        connection={dropbox()}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    expect(
      screen.getByText(/is not available for this app yet/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/OneCLI Cloud/)).not.toBeInTheDocument();
  });

  it("renders nothing for an un-scopable connection", () => {
    const { container } = render(
      <FreeResourceScopeFields
        connection={github({ metadata: { repos: [] } })}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ResourceScopeFields summary", () => {
  const summary = () => screen.getByTestId("resource-scope-summary");

  it("reads 'All repositories' for an unrestricted policy", () => {
    render(
      <ResourceScopeFields
        connection={github()}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    expect(summary()).toHaveTextContent("All repositories");
    expect(
      screen.getByText(/Limit which repositories this connection's/),
    ).toHaveTextContent(/reach\.$/);
  });

  it("counts the selection with singular/plural", () => {
    const { rerender } = render(
      <ResourceScopeFields
        connection={github()}
        policy={{ repositories: ["acme/api"] }}
        onChange={vi.fn()}
      />,
    );
    expect(summary()).toHaveTextContent("1 repository");
    rerender(
      <ResourceScopeFields
        connection={github()}
        policy={{ repositories: ["acme/api", "acme/web"] }}
        onChange={vi.fn()}
      />,
    );
    expect(summary()).toHaveTextContent("2 repositories");
  });

  it("describes the effective scope inside the org boundary", () => {
    render(
      <ResourceScopeFields
        connection={github()}
        policy={{ repositories: ["acme/api", "acme/web"] }}
        orgPolicy={{ repositories: ["acme/web"] }}
        onChange={vi.fn()}
      />,
    );
    expect(summary()).toHaveTextContent("1 repository");
    expect(
      screen.getByText(/within the repositories your organization allows/),
    ).toBeInTheDocument();
  });

  it("flags an empty effective scope", () => {
    render(
      <ResourceScopeFields
        connection={github()}
        policy={{ repositories: ["acme/api"] }}
        orgPolicy={{ repositories: ["acme/web"] }}
        onChange={vi.fn()}
      />,
    );
    expect(summary()).toHaveTextContent("No repositories");
    expect(screen.getByRole("status")).toHaveTextContent(
      /can't reach anything/,
    );
  });

  it("hides Manage when read-only", () => {
    render(
      <ResourceScopeFields
        connection={github()}
        policy={null}
        onChange={vi.fn()}
        readOnly
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Manage resources" }),
    ).not.toBeInTheDocument();
  });

  it("renders nothing for a provider without a picker", () => {
    const { container } = render(
      <ResourceScopeFields
        connection={dropbox()}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("ResourceScopeFields Manage dialog", () => {
  it("opens the picker titled after the connection", async () => {
    const user = userEvent.setup();
    render(
      <ResourceScopeFields
        connection={github()}
        policy={null}
        onChange={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage resources" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Acme GitHub");
    expect(dialog).toHaveTextContent(
      "Choose which repositories this connection's credential can reach.",
    );
    expect(
      await screen.findByRole("group", { name: "Repository scope" }),
    ).toBeInTheDocument();
  });

  it("saves a selection and normalises an empty one to null", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ResourceScopeFields
        connection={github()}
        policy={null}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage resources" }));
    await user.click(
      await screen.findByRole("button", { name: "Selected repositories" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "acme/api" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenLastCalledWith({ repositories: ["acme/api"] });

    // Reopen, drop the only repo → Save sends null, not an empty list.
    await user.click(screen.getByRole("button", { name: "Manage resources" }));
    await user.click(
      await screen.findByRole("button", { name: "Selected repositories" }),
    );
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  it("discards the draft on Cancel", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ResourceScopeFields
        connection={github()}
        policy={null}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Manage resources" }));
    await user.click(
      await screen.findByRole("button", { name: "Selected repositories" }),
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
