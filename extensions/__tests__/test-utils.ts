import { vi } from "vitest";

// Lightweight ExtensionAPI / ExtensionContext / event mocks.
// We don't import the real types to avoid pulling in pi-coding-agent's deep
// type graph in tests. Tests cast through `unknown as` where needed.

export interface MockUI {
  select: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  input: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  setStatus: ReturnType<typeof vi.fn>;
  setWorkingMessage: ReturnType<typeof vi.fn>;
  theme: { fg: ReturnType<typeof vi.fn> };
}

export interface MockCtx {
  ui: MockUI;
  hasUI: boolean;
  cwd: string;
  signal: AbortSignal | undefined;
  isIdle: () => boolean;
  abort: () => void;
}

export function makeUI(opts?: { selectAnswer?: string | undefined }): MockUI {
  return {
    select: vi.fn().mockResolvedValue(opts?.selectAnswer),
    confirm: vi.fn().mockResolvedValue(true),
    input: vi.fn().mockResolvedValue(undefined),
    notify: vi.fn(),
    setStatus: vi.fn(),
    setWorkingMessage: vi.fn(),
    theme: { fg: vi.fn((_color: string, text: string) => text) },
  };
}

export function makeCtx(overrides?: Partial<MockCtx>): MockCtx {
  return {
    ui: makeUI(),
    hasUI: true,
    cwd: "/tmp/test-cwd",
    signal: undefined,
    isIdle: () => true,
    abort: () => {},
    ...overrides,
  };
}

interface CapturedHandlers {
  sessionStart?: (event: unknown, ctx: unknown) => unknown;
  sessionShutdown?: (event: unknown, ctx: unknown) => unknown;
  userBash?: (event: unknown, ctx: unknown) => unknown;
  toolCall?: (event: unknown, ctx: unknown) => unknown;
  toolResult?: (event: unknown, ctx: unknown) => unknown;
  command?: (args: string, ctx: unknown) => Promise<void>;
}

export function makeMockApi() {
  const handlers: CapturedHandlers = {};
  const flags = new Map<string, boolean | string>();
  const tools: unknown[] = [];

  const api = {
    on: vi.fn((event: string, handler: (e: unknown, c: unknown) => unknown) => {
      switch (event) {
        case "session_start":
          handlers.sessionStart = handler;
          break;
        case "session_shutdown":
          handlers.sessionShutdown = handler;
          break;
        case "user_bash":
          handlers.userBash = handler;
          break;
        case "tool_call":
          handlers.toolCall = handler;
          break;
        case "tool_result":
          handlers.toolResult = handler;
          break;
      }
    }),
    registerTool: vi.fn((tool: unknown) => tools.push(tool)),
    registerCommand: vi.fn(
      (
        _name: string,
        opts: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        handlers.command = opts.handler;
      },
    ),
    registerFlag: vi.fn((name: string, opts: { default?: boolean | string }) => {
      flags.set(name, opts.default ?? false);
    }),
    registerShortcut: vi.fn(),
    registerMessageRenderer: vi.fn(),
    getFlag: vi.fn((name: string) => flags.get(name)),
    setFlag(name: string, value: boolean | string) {
      flags.set(name, value);
    },
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn().mockReturnValue(undefined),
    setLabel: vi.fn(),
    exec: vi.fn(),
    getActiveTools: vi.fn().mockReturnValue([]),
    getAllTools: vi.fn().mockReturnValue([]),
    setActiveTools: vi.fn(),
    getCommands: vi.fn().mockReturnValue([]),
    setModel: vi.fn().mockResolvedValue(true),
    getThinkingLevel: vi.fn().mockReturnValue("off"),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
  };

  return {
    api,
    handlers,
    invoke: {
      async sessionStart(ctx: MockCtx): Promise<void> {
        if (!handlers.sessionStart) throw new Error("session_start handler not registered");
        await handlers.sessionStart({}, ctx);
      },
      async sessionShutdown(ctx?: MockCtx): Promise<void> {
        if (!handlers.sessionShutdown) throw new Error("session_shutdown handler not registered");
        await handlers.sessionShutdown({}, ctx ?? makeCtx());
      },
      async userBash(event: unknown, ctx: MockCtx): Promise<unknown> {
        if (!handlers.userBash) throw new Error("user_bash handler not registered");
        return handlers.userBash(event, ctx);
      },
      async toolCall(event: unknown, ctx: MockCtx): Promise<unknown> {
        if (!handlers.toolCall) throw new Error("tool_call handler not registered");
        return handlers.toolCall(event, ctx);
      },
      async sandboxCommand(args: string, ctx: MockCtx): Promise<void> {
        if (!handlers.command) throw new Error("command handler not registered");
        await handlers.command(args, ctx);
      },
    },
  };
}
