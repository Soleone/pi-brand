import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickNames, type PickOutcome } from "../src/picker.ts";

function context(keys: string[], inspect?: (lines: string[]) => void): ExtensionContext {
  return {
    mode: "tui", hasUI: true,
    ui: {
      custom: async (factory: (tui: unknown, theme: unknown, keys: unknown, done: (outcome: PickOutcome | undefined) => void) => { render(width: number): string[]; handleInput(data: string): void }) => {
        let outcome: PickOutcome | undefined;
        const component = factory({ requestRender: () => {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, {}, (value) => { outcome = value; });
        inspect?.(component.render(24));
        for (const key of keys) { component.handleInput(key); inspect?.(component.render(24)); }
        return outcome;
      },
    },
  } as unknown as ExtensionContext;
}

const candidates = ["Able", "Bold", "Calm", "Daring"].map((name) => ({ name, flavor: "A long flavor note that needs truncation" }));

test("check selection enforces its batch limit and fits narrow terminals", async () => {
  const result = await pickNames(context([" ", " ", " ", " ", "\r"], lines => {
    for (const line of lines) assert.ok(visibleWidth(line) <= 24, line);
  }), candidates, { selectionOnly: true, maxSelection: 3 });
  assert.deepEqual(result, { kind: "picked", names: ["Able", "Bold", "Calm"] });
});

test("check selection escape cancels; ordinary escape saves and closes immediately", async () => {
  assert.equal(await pickNames(context(["\x1b"]), candidates, { selectionOnly: true }), undefined);
  assert.deepEqual(await pickNames(context([" ", "\x1b"]), candidates), { kind: "picked", names: ["Able"] });
  assert.deepEqual(await pickNames(context(["\r"]), candidates), { kind: "picked", names: [] });
});

test("the main picker has three next steps, no rejection mode or implicit picks", async () => {
  for (const [key, action] of [["1", "more"], ["2", "feedback"], ["3", "favorites"]]) {
    assert.deepEqual(await pickNames(context([key]), candidates), { kind: "action", action, names: [] });
  }
  const details = await pickNames(context(["?"]), candidates);
  assert.deepEqual(details, { kind: "action", action: "details", names: [] });
});

test("filtering and highlighting never imply a favorite", async () => {
  assert.deepEqual(await pickNames(context(["Bold", "\x1b"]), candidates), { kind: "picked", names: [] });
});

test("RPC exposes the same core actions and close semantics", async () => {
  const choices: (string | undefined)[] = ["[ ] Able", undefined];
  const ctx = { mode: "rpc", hasUI: true, ui: { select: async () => choices.shift() } } as unknown as ExtensionContext;
  assert.deepEqual(await pickNames(ctx, candidates), { kind: "picked", names: ["Able"] });
  choices.push("Give feedback");
  assert.deepEqual(await pickNames(ctx, candidates), { kind: "action", action: "feedback", names: [] });
  choices.push("Review favorites");
  assert.deepEqual(await pickNames(ctx, candidates), { kind: "action", action: "favorites", names: [] });
});
