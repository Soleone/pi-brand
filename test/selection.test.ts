import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { selectBrandOption } from "../src/selection.ts";

function context(keys: string[]): ExtensionContext {
  return {
    mode: "tui", hasUI: true,
    ui: { custom: async (factory: Function) => {
      let result: string | undefined;
      const component = factory({ requestRender: () => {} }, { fg: (_color: string, text: string) => text, bold: (text: string) => text }, getKeybindings(), (value: string | undefined) => { result = value; });
      component.focused = true;
      assert.equal(component.focused, true);
      for (const width of [24, 80]) {
        const lines = component.render(width);
        assert.ok(lines.length < 25, "large lists must stay bounded");
        for (const line of lines) assert.ok(visibleWidth(line) <= width);
      }
      for (const key of keys) component.handleInput(key);
      for (const line of component.render(24)) assert.ok(visibleWidth(line) <= 24);
      return result;
    } },
  } as unknown as ExtensionContext;
}

test("large terminal lists are searchable, bounded and select the filtered item", async () => {
  const choices = Array.from({ length: 500 }, (_, index) => `provider/model-${index}`);
  assert.equal(await selectBrandOption(context([..."model-499", "\r"]), "Choose a model", choices), "provider/model-499");
  assert.equal(await selectBrandOption(context([..."zzzz", "\r", "\x1b"]), "Choose a model", choices), undefined);
  assert.equal(await selectBrandOption(context(["\x1b"]), `Choose a model: ${"long product description ".repeat(100)}`, choices), undefined);
});
