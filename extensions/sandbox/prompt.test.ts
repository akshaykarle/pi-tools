import { describe, expect, it, vi } from "vitest";
import { type PromptUI, promptDomainBlock, promptWriteBlock } from "./prompt.js";

function makeUI(answer: string | undefined): PromptUI {
  return {
    select: vi.fn().mockResolvedValue(answer),
    notify: vi.fn(),
  };
}

describe("promptWriteBlock", () => {
  it("maps 'Allow for this session only' to 'session'", async () => {
    const ui = makeUI("Allow for this session only");
    await expect(promptWriteBlock(ui, "/tmp/foo")).resolves.toBe("session");
  });

  it("maps 'Allow for this project' to 'project'", async () => {
    const ui = makeUI("Allow for this project");
    await expect(promptWriteBlock(ui, "/tmp/foo")).resolves.toBe("project");
  });

  it("maps 'Allow for all projects' to 'global'", async () => {
    const ui = makeUI("Allow for all projects");
    await expect(promptWriteBlock(ui, "/tmp/foo")).resolves.toBe("global");
  });

  it("maps 'Abort (keep blocked)' to 'abort'", async () => {
    const ui = makeUI("Abort (keep blocked)");
    await expect(promptWriteBlock(ui, "/tmp/foo")).resolves.toBe("abort");
  });

  it("maps undefined (user dismissed) to 'abort'", async () => {
    const ui = makeUI(undefined);
    await expect(promptWriteBlock(ui, "/tmp/foo")).resolves.toBe("abort");
  });

  it("presents exactly four options with Abort first", async () => {
    const ui = makeUI("Abort (keep blocked)");
    await promptWriteBlock(ui, "/tmp/foo");
    const args = (ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[1]).toEqual([
      "Abort (keep blocked)",
      "Allow for this session only",
      "Allow for this project",
      "Allow for all projects",
    ]);
  });
});

describe("promptDomainBlock", () => {
  it("maps session answer correctly", async () => {
    const ui = makeUI("Allow for this session only");
    await expect(promptDomainBlock(ui, "example.com")).resolves.toBe("session");
  });

  it("maps undefined to abort", async () => {
    const ui = makeUI(undefined);
    await expect(promptDomainBlock(ui, "example.com")).resolves.toBe("abort");
  });

  it("embeds the domain in the title", async () => {
    const ui = makeUI("Abort (keep blocked)");
    await promptDomainBlock(ui, "evil.com");
    const args = (ui.select as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(args[0]).toContain("evil.com");
  });
});
