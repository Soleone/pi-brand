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

test("finalist picker enforces three selections and renders within narrow widths", async () => {
  const ctx = context([" ", " ", " ", " ", "\r"], (lines) => {
    for (const line of lines) assert.ok(visibleWidth(line) <= 24, `overflow: ${line}`);
  });
  const result = await pickNames(ctx, ["Able", "Bold", "Calm", "Daring"].map((name) => ({ name, flavor: "A very long flavor note which needs truncation" })), { title: "Choose finalists", selectionOnly: true, maxSelection: 3 });
  assert.deepEqual(result, { kind: "picked", names: ["Able", "Bold", "Calm"] });
});

test("finalist escape cancels immediately and empty enter can clear selection", async () => {
  const candidates = [{ name: "Able" }];
  assert.equal(await pickNames(context(["\x1b"]), candidates, { selectionOnly: true, maxSelection: 3 }), undefined);
  assert.deepEqual(await pickNames(context(["\r"]), candidates, { selectionOnly: true, maxSelection: 3 }), { kind: "picked", names: [] });
});

test("more like highlighted saves its taste reference and changes direction explicitly", async () => {
  const result = await pickNames(context(["4"]), [{ name: "Able" }], { direction: "familiar and confident" });
  assert.equal(result?.kind, "action");
  if (result?.kind === "action") {
    assert.deepEqual(result.names, ["Able"]);
    assert.equal(result.action, "more-new");
    assert.match(result.note ?? "", /More like "Able".*familiar and confident/);
  }
});

test("normal picker retains keyboard more and rejection behavior without redundant scores", async () => {
  const result = await pickNames(context([" ", "1"], (lines) => assert.ok(!lines.join("\n").includes("unscored"))), [{ name: "Able" }, { name: "Bold" }]);
  assert.deepEqual(result, { kind: "action", action: "more-same", names: ["Able"] });
  const rejected = await pickNames(context(["\x1b", "less cute", "\r"]), [{ name: "Able" }]);
  assert.deepEqual(rejected, { kind: "rejected", names: ["Able"], comment: "less cute" });
});

test("overview key saves explicit picks without turning a filter or highlight into a rejection", async () => {
  assert.deepEqual(await pickNames(context(["0"]), [{ name: "Able" }]), { kind: "action", action: "overview", names: [] });
  const candidates = [{ name: "Able" }, { name: "Bold" }];
  const result = await pickNames(context([" ", "zzz", "0"], (lines) => {
    for (const line of lines) assert.ok(visibleWidth(line) <= 24);
  }), candidates);
  assert.deepEqual(result, { kind: "action", action: "overview", names: ["Able"] });
});

test("RPC picker exposes direction, rejection, similar names and finalist navigation", async () => {
  const choices = ["Change direction", "Reject round with a note"];
  const ctx = {
    mode: "rpc", hasUI: true,
    ui: { select: async () => choices.shift(), input: async () => choices.length ? undefined : "less cute" },
  } as unknown as ExtensionContext;
  assert.deepEqual(await pickNames(ctx, [{ name: "Able" }]), { kind: "rejected", names: ["Able"], comment: "less cute" });
  choices.push("More like a name", "Able");
  const similar = await pickNames(ctx, [{ name: "Able" }]);
  assert.equal(similar?.kind, "action");
  if (similar?.kind === "action") { assert.equal(similar.action, "more-new"); assert.deepEqual(similar.names, ["Able"]); }
  choices.push("Choose finalists");
  assert.deepEqual(await pickNames(ctx, [{ name: "Able" }]), { kind: "action", action: "check", names: [] });
});
