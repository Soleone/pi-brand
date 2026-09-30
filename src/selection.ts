import { DynamicBorder, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, SelectList, Text, truncateToWidth } from "@earendil-works/pi-tui";

/** Large favorite/history/model lists need a bounded, searchable terminal viewport. */
export async function selectBrandOption(ctx: ExtensionContext, title: string, choices: string[]): Promise<string | undefined> {
  if (ctx.mode !== "tui") return ctx.ui.select(title, choices);
  return ctx.ui.custom<string | undefined>((tui, theme, keys, done) => {
    const container = new Container();
    const input = new Input({ prompt: "Filter: ", placeholder: "type to filter…" });
    const createList = (options: string[]) => {
      const list = new SelectList(options.map((value) => ({ value, label: value })), 10, {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: () => theme.fg("warning", "No matches. Clear the filter to see all options."),
      });
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(undefined);
      return list;
    };
    let list = createList(choices);
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    // A long product/direction should never wrap into a screenful of title lines.
    container.addChild({
      render: (width: number) => title.split("\n").filter(Boolean).map((line) => ` ${truncateToWidth(theme.bold(line), Math.max(1, width - 2), "…")}`),
      invalidate: () => {},
    });
    container.addChild(input);
    container.addChild({ render: (width) => list.render(width), invalidate: () => list.invalidate() });
    container.addChild(new Text(theme.fg("dim", "↑↓ move · Enter select · Esc back · Type filter"), 1, 0));
    container.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
    return {
      get focused() { return input.focused; },
      set focused(value: boolean) { input.focused = value; },
      render: (width: number) => container.render(width).map((line) => truncateToWidth(line, Math.max(0, width), "…")),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        const navigation = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
        if (navigation.some((action) => keys.matches(data, action))) list.handleInput(data);
        else {
          input.handleInput(data);
          const query = input.getValue().toLocaleLowerCase();
          // SelectList's own filter is prefix-only; model IDs should match without typing the provider.
          list = createList(choices.filter((choice) => choice.toLocaleLowerCase().includes(query)));
        }
        tui.requestRender();
      },
    };
  });
}
