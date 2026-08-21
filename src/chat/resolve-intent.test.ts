import { describe, expect, it, vi } from "vitest";
import type { InputParam } from "../artifact/schema.js";
import {
  invokeUrlFor,
  pickDeclaredParams,
  resolveIntent,
  toolNameFor,
  toolsFor,
  type RoutableCapability,
} from "./resolve-intent.js";

const param = (name: string, type: InputParam["type"] = "string"): InputParam => ({
  name,
  type,
  required: true,
  sensitive: false,
});

const READ_RECORD: RoutableCapability = {
  id: "meridian-read-member-record",
  name: "Read a member record",
  description: "Reads a member's name and contact details.",
  inputParams: [param("memberId")],
};

const TRANSFER: RoutableCapability = {
  id: "meridian-funds-transfer",
  name: "Transfer funds between shares",
  description: "Moves money between two of a member's shares.",
  inputParams: [param("memberId"), param("fromShareCode"), param("toShareCode"), param("amount", "currency")],
};

const CAPS = [READ_RECORD, TRANSFER];

/** A stub standing in for the SDK, so no test in this file makes a network call. */
function clientReturning(content: unknown[]) {
  const create = vi.fn().mockResolvedValue({ content });
  return { client: { messages: { create } } as never, create };
}

describe("toolsFor", () => {
  it("generates one tool per capability from its declared inputParams", () => {
    const tools = toolsFor(CAPS);
    expect(tools.map((t) => t.name)).toEqual(["meridian-read-member-record", "meridian-funds-transfer"]);
    expect(Object.keys(tools[1]!.input_schema.properties!)).toEqual([
      "memberId",
      "fromShareCode",
      "toShareCode",
      "amount",
    ]);
  });

  it("maps currency to a JSON number and leaves date as a string", () => {
    const tools = toolsFor([
      { ...TRANSFER, inputParams: [param("amount", "currency"), param("when", "date"), param("n", "number")] },
    ]);
    const props = tools[0]!.input_schema.properties as Record<string, { type: string }>;
    expect(props.amount!.type).toBe("number");
    expect(props.when!.type).toBe("string");
    expect(props.n!.type).toBe("number");
  });

  it("marks nothing required, so a partial request cannot push the model into inventing an id", () => {
    for (const tool of toolsFor(CAPS)) {
      expect(tool.input_schema.required).toEqual([]);
    }
  });

  it("keeps tool names inside the API's allowed character set", () => {
    expect(toolNameFor("meridian-read-member-record")).toBe("meridian-read-member-record");
    expect(toolNameFor("weird id/with:chars")).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe("pickDeclaredParams", () => {
  it("keeps only params the capability declares", () => {
    const got = pickDeclaredParams(READ_RECORD, { memberId: "101555", somethingElse: "x" });
    expect(got).toEqual({ memberId: "101555" });
  });

  it("drops role, so the router cannot pre-stage a privilege escalation", () => {
    // The invoke form accepts ?role= as a prefill (the permission-denied demo
    // link uses it). role is never a declared inputParam, so it never survives.
    const got = pickDeclaredParams(READ_RECORD, { memberId: "101555", role: "supervisor" });
    expect(got).toEqual({ memberId: "101555" });
    expect(got).not.toHaveProperty("role");
  });

  it("stringifies numbers and drops blanks, nulls and objects", () => {
    const got = pickDeclaredParams(TRANSFER, {
      memberId: 101555,
      fromShareCode: "   ",
      toShareCode: null,
      amount: { nested: true },
    });
    expect(got).toEqual({ memberId: "101555" });
  });
});

describe("resolveIntent", () => {
  it("routes a tool_use to its capability and keeps the stated values", async () => {
    const { client } = clientReturning([
      { type: "tool_use", name: "meridian-read-member-record", input: { memberId: "101555" } },
    ]);
    const intent = await resolveIntent("read member 101555's details", { client, capabilities: CAPS });
    expect(intent).toEqual({
      kind: "capability",
      capabilityId: "meridian-read-member-record",
      params: { memberId: "101555" },
    });
  });

  it("routes a partial request with no params rather than guessing one", async () => {
    const { client } = clientReturning([
      { type: "tool_use", name: "meridian-read-member-record", input: {} },
    ]);
    const intent = await resolveIntent("look up a member", { client, capabilities: CAPS });
    // The form is the clarification UI: land there empty, not on an invented id.
    expect(intent).toEqual({ kind: "capability", capabilityId: "meridian-read-member-record", params: {} });
  });

  it("reports the model's own words when it declines to route", async () => {
    const { client } = clientReturning([{ type: "text", text: "No capability opens a new member account." }]);
    const intent = await resolveIntent("open a new member account", { client, capabilities: CAPS });
    expect(intent).toEqual({ kind: "unclear", message: "No capability opens a new member account." });
  });

  it("does not route a tool name that is not in the catalog", async () => {
    const { client } = clientReturning([{ type: "tool_use", name: "meridian-delete-everything", input: {} }]);
    const intent = await resolveIntent("delete it all", { client, capabilities: CAPS });
    expect(intent.kind).toBe("unclear");
  });

  it("takes the first tool_use when the model calls more than one", async () => {
    const { client } = clientReturning([
      { type: "tool_use", name: "meridian-read-member-record", input: { memberId: "1" } },
      { type: "tool_use", name: "meridian-funds-transfer", input: { memberId: "1" } },
    ]);
    const intent = await resolveIntent("do two things", { client, capabilities: CAPS });
    expect(intent).toMatchObject({ capabilityId: "meridian-read-member-record" });
  });

  it("never calls the model for empty input or an empty catalog", async () => {
    const a = clientReturning([]);
    expect(await resolveIntent("   ", { client: a.client, capabilities: CAPS })).toMatchObject({ kind: "unclear" });
    expect(a.create).not.toHaveBeenCalled();

    const b = clientReturning([]);
    expect(await resolveIntent("anything", { client: b.client, capabilities: [] })).toMatchObject({ kind: "unclear" });
    expect(b.create).not.toHaveBeenCalled();
  });
});

describe("invokeUrlFor", () => {
  it("builds a prefilled invoke URL a person could have typed", () => {
    expect(invokeUrlFor({ capabilityId: "meridian-read-member-record", params: { memberId: "101555" } })).toBe(
      "/capabilities/meridian-read-member-record/invoke?memberId=101555",
    );
  });

  it("omits the query entirely when nothing was stated", () => {
    expect(invokeUrlFor({ capabilityId: "meridian-funds-transfer", params: {} })).toBe(
      "/capabilities/meridian-funds-transfer/invoke",
    );
  });

  it("escapes values so a memo cannot break out of the query string", () => {
    const url = invokeUrlFor({
      capabilityId: "meridian-funds-transfer",
      params: { memo: "rent & utilities?x=1" },
    });
    expect(url).toBe("/capabilities/meridian-funds-transfer/invoke?memo=rent%20%26%20utilities%3Fx%3D1");
  });
});
