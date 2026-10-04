import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpServersCard } from "./McpServersCard";

/*
 * The Tool servers card is where the owner hands the assistant new tools and
 * the credentials to reach them. The ways it can fail its owner, written
 * before the tests:
 *
 *  1. A wearer who is not the operator sees the card, or the card asks for
 *     the list on their behalf.
 *  2. A server is shown wrong: the sentence for its last contact, the count
 *     of offered tools, or which tools are offered and which are actions.
 *  3. Cosmos is another process, perhaps another release. It answers with a
 *     document of another shape and the card presents it as servers.
 *  4. Adding a server sends a header row the owner left empty (Cosmos refuses
 *     an empty value), drops one they filled, or sends an id and so changes
 *     another server.
 *  5. Editing a server shows a stored credential, sends an empty value for a
 *     saved header and so wipes it, or leaves the id out and adds a second
 *     server.
 *  6. A credential the owner typed stays on the page after it was saved.
 *  7. A switch sends the wrong field, the wrong server or the old value, or
 *     shows its own guess instead of what Cosmos answered.
 *  8. Remove deletes without asking, or deletes after the owner said no.
 *  9. Test contacts the wrong server, or the result is not shown.
 * 10. The session expired and the owner is left with an error and no way on.
 * 11. Cosmos refuses a change and the card hides its sentence, shows success,
 *     or loses the list it had.
 * 12. Switching one tool off forgets the other tools already switched off,
 *     including ones the server no longer lists, or a tool's chip gives the
 *     wrong reason it is not offered.
 * 13. Sign in is offered for a server that uses a typed Authorization header,
 *     is missing for one that asks for a sign-in, or sends the browser to an
 *     address that is not a web page.
 * 14. Adding a server the owner signs in to sends a header they typed before
 *     choosing sign-in, starts the sign-in on another server, starts one for
 *     a server that did not ask, or loses the added server when the sign-in
 *     cannot start.
 *
 * Controls are found by role and name, never by position, so a new control on
 * a server does not move them.
 */

type Tool = { name: string; description: string; read_only: boolean; offered: boolean; enabled: boolean };

type Server = {
  id: string;
  name: string;
  url: string;
  headers: string[];
  enabled: boolean;
  allow_actions: boolean;
  allow_when_locked: boolean;
  disabled_tools: string[];
  actions_without_asking: boolean;
  signed_in: boolean;
  status: string;
  checked_at_ms: number | null;
  tools: Tool[];
};

/** One server as Cosmos lists it. Header values never come back, only names. */
function server(patch: Partial<Server> = {}): Server {
  return {
    id: "home",
    name: "Home",
    url: "https://home.example.test/mcp",
    headers: ["Authorization"],
    enabled: true,
    allow_actions: false,
    allow_when_locked: false,
    disabled_tools: [],
    actions_without_asking: false,
    signed_in: false,
    status: "connected",
    checked_at_ms: 1_790_000_000_000,
    tools: [
      { name: "list_lights", description: "Lists the lights.", read_only: true, offered: true, enabled: true },
      { name: "switch_light", description: "", read_only: false, offered: false, enabled: true },
    ],
    ...patch,
  };
}

const WORK = server({
  id: "work",
  name: "Work",
  url: "https://work.example.test/mcp",
  status: "unauthorized",
  tools: [],
});

type Sent = { url: string; method: string; body: unknown };

/**
 * Stands in for Center's routes. The list is answered with `servers`; every
 * other request is recorded and answered by `change`.
 */
function center(servers: Server[], change: (sent: Sent) => Response = () => Response.json({ servers })) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (method === "GET") {
        return String(input) === "/api/admin/mcp"
          ? Response.json({ servers })
          : Response.json({ error: "Not found." }, { status: 404 });
      }
      const request = { url: String(input), method, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
      sent.push(request);
      return change(request);
    }),
  );
  return sent;
}

/** The one request that adds or changes a server. */
function saveOf(body: unknown): Sent {
  return { url: "/api/admin/mcp", method: "POST", body };
}

/** Open a server, or the Add form, the way the owner does: by its heading. */
async function open(user: UserEvent, name: string): Promise<HTMLElement> {
  const group = await screen.findByRole("group", { name });
  if (!(group as HTMLDetailsElement).open) await user.click(group.querySelector("summary")!);
  return group;
}

async function openEdit(user: UserEvent, name: string): Promise<HTMLElement> {
  const group = await open(user, name);
  await user.click(within(group).getByText("Edit name, URL and headers"));
  return group;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("McpServersCard", () => {
  it("renders nothing for a wearer who is not the operator and asks for no list", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<McpServersCard operator={false} />);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows each server with what Cosmos last saw of it and the tools it lists", async () => {
    center([server(), WORK, server({ id: "notes", name: "Notes", enabled: false, tools: [] })]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    expect(within(home).getByText("https://home.example.test/mcp")).toBeInTheDocument();
    expect(within(home).getByText("1 of 2 tools offered to the assistant.")).toBeInTheDocument();
    const tools = within(home).getByRole("list", { name: "Home tools" });
    const offered = within(tools).getByText("list_lights").closest("li")!;
    expect(within(offered).getByText("Lists the lights.")).toBeInTheDocument();
    expect(within(offered).getByText("Offered")).toBeInTheDocument();
    const action = within(tools).getByText("switch_light").closest("li")!;
    expect(within(action).getByText("No description.")).toBeInTheDocument();
    expect(within(action).getByText("Action")).toBeInTheDocument();
    expect(within(action).queryByText("Offered")).not.toBeInTheDocument();

    const work = await open(user, "Work");
    expect(within(work).getByText(/The server refused the request\./)).toBeInTheDocument();
    expect(within(work).queryByRole("list", { name: "Work tools" })).not.toBeInTheDocument();

    const notes = await open(user, "Notes");
    expect(within(notes).getByText(/Switched off\. The assistant is not offered its tools\./)).toBeInTheDocument();
    expect(within(notes).getByRole("switch", { name: "Use Notes" })).toHaveAttribute("aria-checked", "false");

    // Two of the three are switched on.
    expect(screen.getByText("2 on")).toBeInTheDocument();
  });

  it.each([
    ["untested", /Not contacted yet\. Choose Test/],
    ["unreachable", /could not be reached/],
    ["timed_out", /did not answer in time/],
    ["invalid_response", /not as an MCP server/],
  ])("says what a server whose last contact was %s needs", async (status, sentence) => {
    center([server({ status, tools: [] })]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");

    expect(within(home).getByText(sentence)).toBeInTheDocument();
    expect(within(home).queryByText(/offered to the assistant/)).not.toBeInTheDocument();
  });

  it("says why a connected server offers nothing when all its tools are actions", async () => {
    center([
      server({ tools: [{ name: "switch_light", description: "Switches a light.", read_only: false, offered: false, enabled: true }] }),
    ]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");

    expect(within(home).getByText(/none is marked read-only\. Turn on Allow actions/)).toBeInTheDocument();
  });

  it.each([
    ["no server list", {}],
    ["a status this card does not know", { servers: [server({ status: "made_up" })] }],
    ["a tool with missing fields", { servers: [{ ...server(), tools: [{ name: "list_lights" }] }] }],
    [
      "headers with their values",
      { servers: [{ ...server(), headers: [{ name: "Authorization", value: "Bearer stored-secret" }] }] },
    ],
    ["a server with a missing switch", { servers: [{ ...server(), allow_when_locked: undefined }] }],
  ])("refuses a list of the wrong shape: %s", async (_what, payload) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(payload)));
    render(<McpServersCard operator />);

    expect(await screen.findByText("Cosmos answered with a tool server list this page cannot read.")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Home" })).not.toBeInTheDocument();
    expect(screen.queryByText(/stored-secret/)).not.toBeInTheDocument();
    expect(screen.queryByText("1 on")).not.toBeInTheDocument();
  });

  it("adds a server with its name, URL and only the header rows that have a value", async () => {
    const sent = center([], () =>
      Response.json({ servers: [server({ headers: ["Authorization", "X-Api-Key"], status: "untested", tools: [] })] }),
    );
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    // With no server yet, the form is already open.
    const add = await screen.findByRole("group", { name: "Add a tool server" });
    await waitFor(() => expect(add).toHaveAttribute("open"));
    const submit = within(add).getByRole("button", { name: "Add server" });
    expect(submit).toBeDisabled();

    await user.type(within(add).getByRole("textbox", { name: /^Name/ }), " Home ");
    await user.type(within(add).getByRole("textbox", { name: /^Server URL/ }), "https://home.example.test/mcp");
    // The first row is offered as Authorization. Its value is typed as a secret.
    const authorization = within(add).getByLabelText("Value for Authorization");
    expect(authorization).toHaveAttribute("type", "password");
    await user.type(authorization, "Bearer owner-secret");

    const newRow = () =>
      within(add).getAllByRole("textbox", { name: "Header name" }).find((input) => (input as HTMLInputElement).value === "")!;
    await user.click(within(add).getByRole("button", { name: "Add a header" }));
    await user.type(newRow(), "X-Api-Key");
    await user.type(within(add).getByLabelText("Value for X-Api-Key"), "key-123");
    // A named row with no value, and a row left blank: neither has anything to send.
    await user.click(within(add).getByRole("button", { name: "Add a header" }));
    await user.type(newRow(), "X-Unfinished");
    await user.click(within(add).getByRole("button", { name: "Add a header" }));

    await user.click(submit);

    expect(await screen.findByText("Tool server added.")).toBeInTheDocument();
    expect(sent).toStrictEqual([
      saveOf({
        name: "Home",
        url: "https://home.example.test/mcp",
        headers: [
          { name: "Authorization", value: "Bearer owner-secret" },
          { name: "X-Api-Key", value: "key-123" },
        ],
      }),
    ]);
    // Cosmos's answer is the list now, and the secrets have left the form.
    expect(screen.getByRole("group", { name: "Home" })).toBeInTheDocument();
    expect(within(add).getByRole("textbox", { name: /^Name/ })).toHaveValue("");
    expect(within(add).getByRole("textbox", { name: /^Server URL/ })).toHaveValue("");
    expect(within(add).getByLabelText("Value for Authorization")).toHaveValue("");
    expect(within(add).queryByLabelText("Value for X-Api-Key")).not.toBeInTheDocument();
  });

  it("edits a server by id, keeps a saved header by sending its name alone, and never shows a stored value", async () => {
    const before = server({ headers: ["Authorization", "X-Api-Key"] });
    const sent = center([before], () => Response.json({ servers: [{ ...before, name: "Home lab" }] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await openEdit(user, "Home");
    // Saved headers are listed by name. Their values are blank secrets.
    for (const name of ["Authorization", "X-Api-Key"]) {
      const value = within(home).getByLabelText(`Value for ${name}`);
      expect(value).toHaveValue("");
      expect(value).toHaveAttribute("type", "password");
      expect(value).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");
    }

    const name = within(home).getByRole("textbox", { name: /^Name/ });
    expect(name).toHaveValue("Home");
    await user.clear(name);
    await user.type(name, "Home lab");
    await user.type(within(home).getByLabelText("Value for X-Api-Key"), "key-rotated");
    await user.click(within(home).getByRole("button", { name: "Save changes" }));

    await screen.findByRole("group", { name: "Home lab" });
    // Authorization was not retyped: its name alone tells Cosmos to keep the stored value.
    expect(sent).toStrictEqual([
      saveOf({
        id: "home",
        name: "Home lab",
        url: "https://home.example.test/mcp",
        headers: [{ name: "Authorization" }, { name: "X-Api-Key", value: "key-rotated" }],
      }),
    ]);
  });

  it("clears a header value from the page once it is saved", async () => {
    const before = server();
    const sent = center([before]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await openEdit(user, "Home");
    await user.type(within(home).getByLabelText("Value for Authorization"), "Bearer rotated-secret");
    await user.click(within(home).getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText("Home was saved.")).toBeInTheDocument();
    expect(sent).toStrictEqual([
      saveOf({
        id: "home",
        name: "Home",
        url: "https://home.example.test/mcp",
        headers: [{ name: "Authorization", value: "Bearer rotated-secret" }],
      }),
    ]);
    const value = within(screen.getByRole("group", { name: "Home" })).getByLabelText("Value for Authorization");
    expect(value).toHaveValue("");
    expect(value).toHaveAttribute("placeholder", "Saved. Leave blank to keep it");
  });

  it("drops a saved header the owner removes and keeps the others", async () => {
    const before = server({ headers: ["Authorization", "X-Api-Key"] });
    const sent = center([before], () => Response.json({ servers: [{ ...before, headers: ["Authorization"] }] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await openEdit(user, "Home");
    await user.click(within(home).getByRole("button", { name: "Remove header X-Api-Key" }));
    await user.click(within(home).getByRole("button", { name: "Save changes" }));

    await screen.findByText("Home was saved.");
    expect(sent).toStrictEqual([
      saveOf({
        id: "home",
        name: "Home",
        url: "https://home.example.test/mcp",
        headers: [{ name: "Authorization" }],
      }),
    ]);
    expect(within(screen.getByRole("group", { name: "Home" })).queryByLabelText("Value for X-Api-Key")).not.toBeInTheDocument();
  });

  it.each([
    ["Use Work", { id: "work", enabled: false }],
    ["Allow actions for Work", { id: "work", allow_actions: true }],
    ["Use Work while locked", { id: "work", allow_when_locked: true }],
    ["Ask before Work runs an action", { id: "work", actions_without_asking: true }],
  ])("the %s switch sends that one setting for that server and shows Cosmos's answer", async (label, change) => {
    const sent = center([server(), WORK], () => Response.json({ servers: [server(), { ...WORK, ...change }] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const work = await open(user, "Work");
    const control = within(work).getByRole("switch", { name: label });
    const was = control.getAttribute("aria-checked");
    await user.click(control);

    await waitFor(() => expect(sent).toStrictEqual([saveOf(change)]));
    await waitFor(() =>
      expect(within(screen.getByRole("group", { name: "Work" })).getByRole("switch", { name: label })).toHaveAttribute(
        "aria-checked",
        was === "true" ? "false" : "true",
      ),
    );
  });

  it("switches one tool off and keeps every other switched-off name, listed or not", async () => {
    const before = server({
      disabled_tools: ["gone"],
      tools: [
        { name: "list_lights", description: "Lists the lights.", read_only: true, offered: true, enabled: true },
        { name: "switch_light", description: "", read_only: false, offered: false, enabled: true },
      ],
    });
    const after = server({
      disabled_tools: ["gone", "list_lights"],
      tools: [
        { name: "list_lights", description: "Lists the lights.", read_only: true, offered: false, enabled: false },
        { name: "switch_light", description: "", read_only: false, offered: false, enabled: true },
      ],
    });
    const sent = center([before], () => Response.json({ servers: [after] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("switch", { name: "Use list_lights from Home" }));

    await waitFor(() => expect(sent).toStrictEqual([saveOf({ id: "home", disabled_tools: ["gone", "list_lights"] })]));
    const tools = await screen.findByRole("list", { name: "Home tools" });
    const off = within(tools).getByText("list_lights").closest("li")!;
    await waitFor(() => expect(within(off).getByText("Switched off")).toBeInTheDocument());
    expect(within(off).getByRole("switch", { name: "Use list_lights from Home" })).toHaveAttribute("aria-checked", "false");
    // The action tool is still held back for its own reason.
    expect(within(within(tools).getByText("switch_light").closest("li")!).getByText("Action")).toBeInTheDocument();
  });

  it("switches a tool back on by sending the list without it", async () => {
    const before = server({
      disabled_tools: ["gone", "list_lights"],
      tools: [{ name: "list_lights", description: "", read_only: true, offered: false, enabled: false }],
    });
    const sent = center([before], () => Response.json({ servers: [server()] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("switch", { name: "Use list_lights from Home" }));

    await waitFor(() => expect(sent).toStrictEqual([saveOf({ id: "home", disabled_tools: ["gone"] })]));
  });

  it("offers Sign in only to a server that asks for one and has no Authorization header of its own", async () => {
    center([
      WORK,
      server({ id: "hosted", name: "Hosted", headers: [], status: "sign_in_required", tools: [] }),
      server({ id: "done", name: "Done", headers: [], signed_in: true }),
    ]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const work = await open(user, "Work");
    expect(within(work).queryByRole("button", { name: "Sign in to Work" })).not.toBeInTheDocument();

    const hosted = await open(user, "Hosted");
    expect(within(hosted).getByText(/Choose Sign in\./)).toBeInTheDocument();
    expect(within(hosted).getByRole("button", { name: "Sign in to Hosted" })).toBeInTheDocument();

    const done = await open(user, "Done");
    expect(within(done).getByText(/Signed in\./)).toBeInTheDocument();
    expect(within(done).getByRole("button", { name: "Sign out of Done" })).toBeInTheDocument();
    expect(within(done).queryByRole("button", { name: "Sign in to Done" })).not.toBeInTheDocument();
  });

  it("asks Cosmos where to sign in and refuses an address that is not a web page", async () => {
    const hosted = server({ id: "hosted", name: "Hosted", headers: [], status: "sign_in_required", tools: [] });
    const sent = center([hosted], () => Response.json({ authorization_url: "javascript:alert(1)" }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const group = await open(user, "Hosted");
    await user.click(within(group).getByRole("button", { name: "Sign in to Hosted" }));

    expect(await screen.findByText("Cosmos answered with a sign-in address this page cannot open.")).toBeInTheDocument();
    // The browser sends no return address: Center computes it.
    expect(sent).toStrictEqual([{ url: "/api/admin/mcp/hosted/oauth", method: "POST", body: undefined }]);
  });

  it("shows Cosmos's sentence when a sign-in cannot start", async () => {
    const hosted = server({ id: "hosted", name: "Hosted", headers: [], status: "sign_in_required", tools: [] });
    center([hosted], () => Response.json({ error: "That server does not offer a sign-in." }, { status: 400 }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const group = await open(user, "Hosted");
    await user.click(within(group).getByRole("button", { name: "Sign in to Hosted" }));

    expect(await screen.findByText("That server does not offer a sign-in.")).toBeInTheDocument();
  });

  it("adds a server the owner signs in to with no headers, then starts that server's sign-in", async () => {
    const hosted = server({ id: "hosted", name: "Hosted", url: "https://hosted.example.test/mcp", headers: [], status: "sign_in_required", tools: [] });
    const sent = center([server()], (request) =>
      request.url === "/api/admin/mcp"
        ? Response.json({ servers: [server(), hosted] })
        : Response.json({ error: "That server does not offer a sign-in." }, { status: 400 }),
    );
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const add = await open(user, "Add a tool server");
    await user.type(within(add).getByRole("textbox", { name: /^Name/ }), "Hosted");
    await user.type(within(add).getByRole("textbox", { name: /^Server URL/ }), "https://hosted.example.test/mcp");
    // A value typed before choosing sign-in is not sent.
    await user.type(within(add).getByLabelText("Value for Authorization"), "Bearer left-over");
    await user.click(within(add).getByRole("radio", { name: "Sign in with the provider (OAuth)" }));
    expect(within(add).queryByLabelText("Value for Authorization")).not.toBeInTheDocument();
    await user.click(within(add).getByRole("button", { name: "Add and sign in" }));

    expect(
      await screen.findByText("Hosted was added, but its sign-in did not start. That server does not offer a sign-in."),
    ).toBeInTheDocument();
    expect(sent).toStrictEqual([
      saveOf({ name: "Hosted", url: "https://hosted.example.test/mcp", headers: [] }),
      { url: "/api/admin/mcp/hosted/oauth", method: "POST", body: undefined },
    ]);
    // The server is kept, with Sign in to try again.
    expect(within(screen.getByRole("group", { name: "Hosted" })).getByRole("button", { name: "Sign in to Hosted" })).toBeInTheDocument();
  });

  it("starts no sign-in for an added server that did not ask for one", async () => {
    const open_ = server({ id: "open", name: "Open", headers: [], status: "connected" });
    const sent = center([], () => Response.json({ servers: [open_] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const add = await screen.findByRole("group", { name: "Add a tool server" });
    await user.type(within(add).getByRole("textbox", { name: /^Name/ }), "Open");
    await user.type(within(add).getByRole("textbox", { name: /^Server URL/ }), "https://open.example.test/mcp");
    await user.click(within(add).getByRole("radio", { name: "Sign in with the provider (OAuth)" }));
    await user.click(within(add).getByRole("button", { name: "Add and sign in" }));

    expect(await screen.findByText("Open was added. It did not ask for a sign-in.")).toBeInTheDocument();
    expect(sent).toHaveLength(1);
  });

  it("says why when an added server could not be asked for its sign-in", async () => {
    const down = server({ id: "down", name: "Down", headers: [], status: "unreachable", tools: [] });
    const sent = center([], () => Response.json({ servers: [down] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const add = await screen.findByRole("group", { name: "Add a tool server" });
    await user.type(within(add).getByRole("textbox", { name: /^Name/ }), "Down");
    await user.type(within(add).getByRole("textbox", { name: /^Server URL/ }), "https://down.example.test/mcp");
    await user.click(within(add).getByRole("radio", { name: "Sign in with the provider (OAuth)" }));
    await user.click(within(add).getByRole("button", { name: "Add and sign in" }));

    expect(await screen.findByText(/Down was added, but it did not ask for a sign-in\..*could not be reached/)).toBeInTheDocument();
    expect(sent).toHaveLength(1);
  });

  it("does not offer the sign-in choice when editing a saved server", async () => {
    center([server()]);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await openEdit(user, "Home");
    expect(within(home).queryByRole("radio")).not.toBeInTheDocument();
  });

  it("signs out of the server the owner chose and shows Cosmos's answer", async () => {
    const signedIn = server({ id: "hosted", name: "Hosted", headers: [], signed_in: true });
    const signedOut = server({ id: "hosted", name: "Hosted", headers: [], status: "sign_in_required", tools: [] });
    const sent = center([signedIn], () => Response.json({ servers: [signedOut] }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const group = await open(user, "Hosted");
    await user.click(within(group).getByRole("button", { name: "Sign out of Hosted" }));

    await waitFor(() =>
      expect(sent).toStrictEqual([{ url: "/api/admin/mcp/hosted/oauth", method: "DELETE", body: undefined }]),
    );
    expect(await screen.findByRole("button", { name: "Sign in to Hosted" })).toBeInTheDocument();
  });

  it("keeps a switch where Cosmos has it when the change is refused, and shows Cosmos's sentence", async () => {
    const sent = center([server()], () =>
      Response.json({ error: "MCP server settings could not be saved." }, { status: 503 }),
    );
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("switch", { name: "Allow actions for Home" }));

    expect(await screen.findByText("MCP server settings could not be saved.")).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Sign in again" })).not.toBeInTheDocument();
    const still = screen.getByRole("group", { name: "Home" });
    expect(within(still).getByRole("switch", { name: "Allow actions for Home" })).toHaveAttribute("aria-checked", "false");
    expect(within(still).getByText("1 of 2 tools offered to the assistant.")).toBeInTheDocument();
  });

  it("keeps the list it had when a change is answered with the wrong shape", async () => {
    center([server()], () => Response.json({ servers: "none" }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("switch", { name: "Use Home" }));

    expect(await screen.findByText("Cosmos answered with a tool server list this page cannot read.")).toBeInTheDocument();
    expect(within(screen.getByRole("group", { name: "Home" })).getByRole("switch", { name: "Use Home" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("asks before removing a server, and removes nothing when the owner says no", async () => {
    const sent = center([server(), WORK], () => Response.json({ servers: [WORK] }));
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("button", { name: "Remove Home" }));

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("Remove Home?");
    expect(sent).toHaveLength(0);
    expect(screen.getByRole("group", { name: "Home" })).toBeInTheDocument();

    confirm.mockReturnValue(true);
    await user.click(within(home).getByRole("button", { name: "Remove Home" }));

    expect(await screen.findByText("Home was removed.")).toBeInTheDocument();
    expect(sent).toStrictEqual([{ url: "/api/admin/mcp/home", method: "DELETE", body: undefined }]);
    expect(screen.queryByRole("group", { name: "Home" })).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Work" })).toBeInTheDocument();
  });

  it("tests the server the owner chose and shows what Cosmos found", async () => {
    const sent = center([server(), WORK], () =>
      Response.json({
        servers: [
          server(),
          { ...WORK, status: "connected", tools: [{ name: "search_tickets", description: "Searches tickets.", read_only: true, offered: true, enabled: true }] },
        ],
      }),
    );
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const work = await open(user, "Work");
    await user.click(within(work).getByRole("button", { name: "Test Work" }));

    expect(await screen.findByText("Work was contacted.")).toBeInTheDocument();
    expect(sent).toStrictEqual([{ url: "/api/admin/mcp/work/test", method: "POST", body: undefined }]);
    const tested = screen.getByRole("group", { name: "Work" });
    expect(within(tested).getByText("1 of 1 tool offered to the assistant.")).toBeInTheDocument();
    expect(within(within(tested).getByRole("list", { name: "Work tools" })).getByText("search_tickets")).toBeInTheDocument();
  });

  it("offers the sign-in link when the session expired before the list loaded", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Not authenticated." }, { status: 401 })));
    render(<McpServersCard operator />);

    const notice = (await screen.findByText(/Not authenticated\./)).closest("div")!;
    expect(within(notice).getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("offers the sign-in link when the session expired before a change", async () => {
    center([server()], () => Response.json({ error: "Not authenticated." }, { status: 401 }));
    const user = userEvent.setup();
    render(<McpServersCard operator />);

    const home = await open(user, "Home");
    await user.click(within(home).getByRole("button", { name: "Test Home" }));

    const notice = (await screen.findByText(/Not authenticated\./)).closest("div")!;
    expect(within(notice).getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", "/login");
  });

  it("says so when Center cannot be reached, for the list and for a change", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    const { unmount } = render(<McpServersCard operator />);
    expect(await screen.findByText("Your tool servers could not be loaded.")).toBeInTheDocument();
    unmount();

    center([server()], () => { throw new TypeError("Failed to fetch"); });
    const user = userEvent.setup();
    render(<McpServersCard operator />);
    const home = await open(user, "Home");
    await user.click(within(home).getByRole("switch", { name: "Use Home" }));

    expect(await screen.findByText("Center could not reach your server. Try again.")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Home" })).toBeInTheDocument();
  });
});
