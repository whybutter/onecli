// @vitest-environment jsdom
import { useState } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GithubAppPolicyDialogContent } from "./policy-dialog-content";

/**
 * The GitHub repository picker: All/Selected, search past 8 repos, boundary
 * rows disabled only in the check direction, and the owner guard — a
 * cross-owner entry would silently scope to the installation owner's
 * same-named repo at the gateway, so it must never be savable.
 */

type Policy = Record<string, unknown> | null;

const ACME = ["acme/api", "acme/web", "acme/docs"];

const Harness = ({
  repos = ACME,
  /** `null` = a connection with no account login on its metadata. */
  username = "acme" as string | null,
  initial = null as Policy,
  orgBoundary = null as Policy,
  onSave = vi.fn(),
  onCancel = vi.fn(),
  onPolicy = vi.fn<(p: Policy) => void>(),
}) => {
  const [policy, setPolicy] = useState<Policy>(initial);
  return (
    <GithubAppPolicyDialogContent
      connectionId="conn-gh"
      metadata={{ username: username ?? undefined, repos }}
      policy={policy}
      orgBoundary={orgBoundary}
      onPolicyChange={(p) => {
        onPolicy(p);
        setPolicy(p);
      }}
      onSave={onSave}
      onCancel={onCancel}
    />
  );
};

const checkbox = (name: string) => screen.getByRole("checkbox", { name });
const modeButton = (name: "All repositories" | "Selected repositories") =>
  screen.getByRole("button", { name });

describe("GithubAppPolicyDialogContent selection", () => {
  it("starts in All mode for a null policy and lists nothing", () => {
    render(<Harness />);
    expect(modeButton("All repositories")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  });

  it("switches to Selected with an empty list, then tracks checks", async () => {
    const user = userEvent.setup();
    const onPolicy = vi.fn<(p: Policy) => void>();
    render(<Harness onPolicy={onPolicy} />);

    await user.click(modeButton("Selected repositories"));
    expect(onPolicy).toHaveBeenLastCalledWith({ repositories: [] });
    expect(screen.getByText("0 of 3 selected")).toBeInTheDocument();
    // Short name up front, full name beneath.
    expect(screen.getByText("api")).toBeInTheDocument();

    await user.click(checkbox("acme/api"));
    expect(onPolicy).toHaveBeenLastCalledWith({ repositories: ["acme/api"] });
    await user.click(checkbox("acme/web"));
    expect(onPolicy).toHaveBeenLastCalledWith({
      repositories: ["acme/api", "acme/web"],
    });
    expect(screen.getByText("2 of 3 selected")).toBeInTheDocument();
  });

  it("reverts to null when the last repository is unchecked", async () => {
    const user = userEvent.setup();
    const onPolicy = vi.fn<(p: Policy) => void>();
    render(
      <Harness initial={{ repositories: ["acme/api"] }} onPolicy={onPolicy} />,
    );

    expect(modeButton("Selected repositories")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(checkbox("acme/api"));
    expect(onPolicy).toHaveBeenLastCalledWith(null);
    expect(modeButton("All repositories")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("explains an installation with no enumerable repositories", async () => {
    const user = userEvent.setup();
    render(<Harness repos={[]} />);
    await user.click(modeButton("Selected repositories"));
    expect(
      screen.getByText(/no individual repositories to narrow to/),
    ).toBeInTheDocument();
  });

  it("wires Cancel and Save to the host", async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onCancel = vi.fn();
    render(<Harness onSave={onSave} onCancel={onCancel} />);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(onSave).toHaveBeenCalledOnce();
  });
});

describe("GithubAppPolicyDialogContent search", () => {
  const many = Array.from({ length: 9 }, (_, i) => `acme/repo-${i}`);

  it("has no search box at 8 repositories or fewer", async () => {
    const user = userEvent.setup();
    render(<Harness repos={many.slice(0, 8)} />);
    await user.click(modeButton("Selected repositories"));
    expect(
      screen.queryByRole("searchbox", { name: "Search repositories" }),
    ).not.toBeInTheDocument();
  });

  it("filters the list past 8 repositories and reports a miss", async () => {
    const user = userEvent.setup();
    render(<Harness repos={many} />);
    await user.click(modeButton("Selected repositories"));
    const search = screen.getByRole("searchbox", {
      name: "Search repositories",
    });
    expect(search).toHaveAttribute("placeholder", "Search repositories...");

    await user.type(search, "repo-3");
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    expect(checkbox("acme/repo-3")).toBeInTheDocument();
    // The count is over the whole list, not the filtered view.
    expect(screen.getByText("0 of 9 selected")).toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "nothing-here");
    expect(
      screen.getByText("No repositories match “nothing-here”"),
    ).toBeInTheDocument();
  });
});

describe("GithubAppPolicyDialogContent org boundary", () => {
  it("disables repositories outside the boundary, check-direction only", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ repositories: ["acme/docs"] }}
        orgBoundary={{ repositories: ["acme/api"] }}
      />,
    );

    // Unchecked and outside → disabled with the reason.
    const web = checkbox("acme/web");
    expect(web).toBeDisabled();
    expect(
      within(web.closest("li")!).getByText("Not allowed by your organization"),
    ).toBeInTheDocument();

    // Inside → free to check.
    expect(checkbox("acme/api")).toBeEnabled();

    // Already checked but outside → stays removable, with the stronger note.
    const docs = checkbox("acme/docs");
    expect(docs).toBeEnabled();
    expect(
      within(docs.closest("li")!).getByText(
        "No longer allowed by your organization. Remove it.",
      ),
    ).toBeInTheDocument();
    await user.click(docs);
    expect(screen.queryByRole("checkbox", { name: "acme/docs" })).toBeNull();
  });
});

describe("GithubAppPolicyDialogContent owner validation", () => {
  it("blocks Save while a cross-owner repository is selected", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        repos={["acme/api", "other/api"]}
        initial={{ repositories: ["acme/api", "other/api"] }}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("different owner than this installation");
    expect(alert).toHaveTextContent("(acme)");
    expect(alert).toHaveTextContent("other/api");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    // The offending row says why and stays removable.
    const other = checkbox("other/api");
    expect(other).toBeEnabled();
    expect(
      within(other.closest("li")!).getByText(
        "Owned by other, not this installation. Remove it.",
      ),
    ).toBeInTheDocument();

    await user.click(other);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("will not let a cross-owner repository be checked in the first place", async () => {
    const user = userEvent.setup();
    render(<Harness repos={["acme/api", "other/api"]} />);
    await user.click(modeButton("Selected repositories"));
    const other = checkbox("other/api");
    expect(other).toBeDisabled();
    expect(
      within(other.closest("li")!).getByText(
        "Owned by other, not this installation",
      ),
    ).toBeInTheDocument();
    expect(checkbox("acme/api")).toBeEnabled();
  });

  it("compares owners case-insensitively", () => {
    render(
      <Harness
        username="Acme"
        repos={["ACME/api"]}
        initial={{ repositories: ["ACME/api"] }}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("skips the check when the connection carries no account login", () => {
    render(
      <Harness
        username={null}
        repos={["acme/api", "other/api"]}
        initial={{ repositories: ["other/api"] }}
      />,
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("keeps a saved repository the installation no longer offers visible and removable", async () => {
    const user = userEvent.setup();
    const onPolicy = vi.fn<(p: Policy) => void>();
    render(
      <Harness
        initial={{ repositories: ["acme/gone", "acme/api"] }}
        onPolicy={onPolicy}
      />,
    );
    const gone = checkbox("acme/gone");
    expect(gone).toBeEnabled();
    expect(
      within(gone.closest("li")!).getByText(
        "No longer on this installation. Remove it.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of 4 selected")).toBeInTheDocument();
    await user.click(gone);
    expect(onPolicy).toHaveBeenLastCalledWith({ repositories: ["acme/api"] });
  });
});
