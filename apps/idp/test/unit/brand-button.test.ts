import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetsDir, buttonCssPath } from "@kingdom-id/brand";
import { describe, expect, it } from "vitest";
import { BUTTON_CHOICES, type ButtonOptions, buttonClass, buttonSnippets, parseButtonOptions } from "../../src/views/brand.js";

const css = readFileSync(buttonCssPath, "utf8");
const pathData = (svg: string) => svg.match(/ d=["']([^"']+)["']/)![1];

describe("the Sign in with Kingdom button", () => {
  it("draws the same mark as the brand SVGs", () => {
    const inlined = decodeURIComponent(css.match(/url\("data:image\/svg\+xml,([^"]+)"\)/)![1]!);
    const mark = pathData(readFileSync(join(assetsDir, "kingdom-mark.svg"), "utf8"));
    expect(pathData(inlined)).toBe(mark);
    expect(pathData(readFileSync(join(assetsDir, "kingdom-mark-white.svg"), "utf8"))).toBe(mark);
  });

  it("defines every class the builder can hand out", () => {
    for (const look of BUTTON_CHOICES.look)
      for (const size of BUTTON_CHOICES.size)
        for (const shape of BUTTON_CHOICES.shape)
          for (const label of BUTTON_CHOICES.label) {
            const options = { look: look.value, size: size.value, shape: shape.value, label: label.value } as ButtonOptions;
            for (const cls of buttonClass(options).split(" ")) expect(css).toContain(`.${cls} {`);
          }
  });

  it("falls back to the default for missing or unknown choices", () => {
    expect(parseButtonOptions({})).toEqual({ look: "dark", size: "md", shape: "pill", label: "sign-in" });
    expect(parseButtonOptions({ look: "blue", size: "huge", shape: ["square"], label: '"><script>' })).toEqual({
      look: "blue",
      size: "md",
      shape: "pill",
      label: "sign-in",
    });
  });

  it("gives the mark-only button an accessible name", () => {
    const { html, jsx } = buttonSnippets({ look: "light", size: "lg", shape: "square", label: "icon" }, "https://id.example");
    expect(html).toBe(
      '<button type="submit" class="kingdom-button kingdom-button--light kingdom-button--lg kingdom-button--square kingdom-button--icon" aria-label="Sign in with Kingdom"></button>',
    );
    expect(jsx).toContain('aria-label="Sign in with Kingdom"');
  });
});
