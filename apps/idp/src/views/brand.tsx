import { Icon } from "./icons.js";
import { Document, type Ui } from "./layout.js";

/** The button builder's choices. Each maps to a modifier class in packages/brand/css/button.css. */
export const BUTTON_CHOICES = {
  look: [
    { value: "dark", label: "Dark", hint: "Kingdom ink. The default, for light backgrounds." },
    { value: "blue", label: "Blue", hint: "Kingdom blue, for when sign-in is the page's main action." },
    { value: "light", label: "Light", hint: "White, for dark backgrounds and photos." },
    { value: "outline", label: "Outline", hint: "Takes your text color, beside your own buttons." },
  ],
  size: [
    { value: "sm", label: "Small", hint: "36px. Dense toolbars only." },
    { value: "md", label: "Medium", hint: "44px. Right for most places." },
    { value: "lg", label: "Large", hint: "52px. Landing pages and phones." },
  ],
  shape: [
    { value: "pill", label: "Pill", hint: "Fully rounded." },
    { value: "square", label: "Rounded square", hint: "To match square-cornered buttons." },
  ],
  label: [
    { value: "sign-in", label: "Sign in with Kingdom", hint: "Where people come back." },
    { value: "continue", label: "Continue with Kingdom", hint: "Where people may be new or returning." },
    { value: "sign-up", label: "Sign up with Kingdom", hint: "On a sign-up page." },
    { value: "icon", label: "Mark only", hint: "Square, beside other sign-in options. Needs room to be read." },
  ],
} as const;

type Choice<K extends keyof typeof BUTTON_CHOICES> = (typeof BUTTON_CHOICES)[K][number]["value"];

export interface ButtonOptions {
  look: Choice<"look">;
  size: Choice<"size">;
  shape: Choice<"shape">;
  label: Choice<"label">;
}

export const DEFAULT_BUTTON: ButtonOptions = { look: "dark", size: "md", shape: "pill", label: "sign-in" };

/** Reads the builder's query string, falling back to the default for anything missing or unknown. */
export function parseButtonOptions(query: Record<string, unknown>): ButtonOptions {
  const pick = <K extends keyof ButtonOptions>(key: K): ButtonOptions[K] => {
    const value = query[key];
    return BUTTON_CHOICES[key].some((c) => c.value === value) ? (value as ButtonOptions[K]) : DEFAULT_BUTTON[key];
  };
  return { look: pick("look"), size: pick("size"), shape: pick("shape"), label: pick("label") };
}

export function buttonClass(o: ButtonOptions): string {
  const classes = ["kingdom-button"];
  if (o.look !== "dark") classes.push(`kingdom-button--${o.look}`);
  if (o.size !== "md") classes.push(`kingdom-button--${o.size}`);
  if (o.shape === "square") classes.push("kingdom-button--square");
  if (o.label === "icon") classes.push("kingdom-button--icon");
  return classes.join(" ");
}

/** The words on the button, or its accessible name when it shows the mark only. */
export function buttonText(o: ButtonOptions): string {
  return o.label === "icon" ? "Sign in with Kingdom" : BUTTON_CHOICES.label.find((c) => c.value === o.label)!.label;
}

export function buttonSnippets(o: ButtonOptions, issuer: string) {
  const cls = buttonClass(o);
  const text = buttonText(o);
  const iconOnly = o.label === "icon";
  return {
    stylesheet: `<link rel="stylesheet" href="${issuer}/brand/button.css">`,
    html: iconOnly
      ? `<button type="submit" class="${cls}" aria-label="${text}"></button>`
      : `<button type="submit" class="${cls}">${text}</button>`,
    jsx: iconOnly
      ? `<button type="submit" className="${cls}" aria-label="${text}" />`
      : `<button type="submit" className="${cls}">${text}</button>`,
  };
}

/** A picture of the button: the real class names on a non-interactive element, since it starts nothing here. */
function KingdomButton({ options }: { options: ButtonOptions }) {
  const text = buttonText(options);
  return options.label === "icon" ? (
    <span class={buttonClass(options)} role="img" aria-label={text} />
  ) : (
    <span class={buttonClass(options)}>{text}</span>
  );
}

function ChoiceGroup<K extends keyof ButtonOptions>(props: { name: K; legend: string; options: ButtonOptions }) {
  return (
    <fieldset class="builder-group">
      <legend>{props.legend}</legend>
      {BUTTON_CHOICES[props.name].map((choice) => (
        <label class="builder-choice" key={choice.value}>
          <input type="radio" name={props.name} value={choice.value} checked={props.options[props.name] === choice.value} />
          <span>
            <strong>{choice.label}</strong>
            <small>{choice.hint}</small>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

function CodeBlock({ id, title, code }: { id: string; title: string; code: string }) {
  return (
    <div class="code-block">
      <div class="code-head">
        <span>{title}</span>
        <button type="button" class="btn btn-small btn-secondary" data-copy={id} hidden>
          Copy
        </button>
      </div>
      <pre>
        <code id={id}>{code}</code>
      </pre>
    </div>
  );
}

export function BrandPage(props: { ui: Ui; issuer: string; options: ButtonOptions }) {
  const { options } = props;
  const snippets = buttonSnippets(options, props.issuer);
  return (
    <Document title="Sign in with Kingdom button" ui={props.ui} stylesheets={["/brand/button.css"]}>
      <a class="skip-link" href="#main">
        Skip to the button builder
      </a>
      <header class="dash-header dash-header-compact">
        <div class="dash-bar">
          <a class="dash-brand" href="/brand">
            <span class="cobrand-mark">
              <img src="/brand/kingdom-mark-white.svg" alt="" width="44" height="24" />
            </span>
            <span>
              <strong>Kingdom ID for developers</strong>
              <small>The Sign in with Kingdom button</small>
            </span>
          </a>
        </div>
      </header>
      <main id="main" class="dash-main brand-main">
        <div class="dash-section-head">
          <h1>Sign in with Kingdom</h1>
          <p class="lede">
            The official button, the same in every app, so members know it at a glance. Pick a look and copy two lines.
            It's one small stylesheet: no script and no images.
          </p>
        </div>

        <form class="builder" method="get" action="/brand" data-builder>
          <div class="builder-options panel">
            <ChoiceGroup name="look" legend="Look" options={options} />
            <ChoiceGroup name="size" legend="Size" options={options} />
            <ChoiceGroup name="shape" legend="Shape" options={options} />
            <ChoiceGroup name="label" legend="Label" options={options} />
            <button type="submit" class="btn btn-primary btn-block" data-builder-submit>
              Update preview
            </button>
          </div>

          <div class="builder-result" data-builder-result>
            <section class="panel" aria-labelledby="preview-title">
              <h2 id="preview-title" class="panel-title">
                Preview
              </h2>
              <div class="preview-surfaces" aria-live="polite">
                <div class="preview-surface preview-light">
                  <KingdomButton options={options} />
                  <span class="preview-caption">On light</span>
                </div>
                <div class="preview-surface preview-dark">
                  <KingdomButton options={options} />
                  <span class="preview-caption">On dark</span>
                </div>
              </div>
            </section>

            <section class="panel" aria-labelledby="code-title">
              <h2 id="code-title" class="panel-title">
                Add it to your app
              </h2>
              <ol class="steps">
                <li>
                  <p>
                    Add the stylesheet to your page's <code>&lt;head&gt;</code>. To serve it yourself instead,{" "}
                    <a href="/brand/button.css" download="kingdom-button.css">
                      download button.css
                    </a>
                    .
                  </p>
                  <CodeBlock id="snippet-stylesheet" title="HTML" code={snippets.stylesheet} />
                </li>
                <li>
                  <p>
                    Put the button inside the form or link that starts your app's sign-in. Your server sends the member
                    to Kingdom ID, as in the{" "}
                    <a href="https://github.com/jwag789/kingdom-id/blob/main/docs/integrations/nextjs.md">Next.js guide</a>.
                  </p>
                  <CodeBlock id="snippet-html" title="HTML" code={snippets.html} />
                  <CodeBlock id="snippet-jsx" title="React" code={snippets.jsx} />
                </li>
              </ol>
              <p class="hint">
                The mark is an inline image, so a Content Security Policy needs <code>data:</code> in{" "}
                <code>img-src</code>, and <code>{props.issuer}</code> in <code>style-src</code> if you link the hosted
                stylesheet.
              </p>
            </section>
          </div>
        </form>

        <section class="panel brand-gallery" aria-labelledby="gallery-title">
          <h2 id="gallery-title" class="panel-title">
            Every look
          </h2>
          <div class="preview-surfaces">
            <div class="preview-surface preview-light">
              {(["dark", "blue", "light", "outline"] as const).map((look) => (
                <KingdomButton key={look} options={{ ...DEFAULT_BUTTON, look, label: "continue" }} />
              ))}
            </div>
            <div class="preview-surface preview-dark">
              {(["light", "blue", "outline"] as const).map((look) => (
                <KingdomButton key={look} options={{ ...DEFAULT_BUTTON, look, label: "continue" }} />
              ))}
            </div>
          </div>
        </section>

        <section class="panel" aria-labelledby="rules-title">
          <h2 id="rules-title" class="panel-title">
            Using the button
          </h2>
          <div class="rules">
            <ul class="rules-list rules-do">
              <li>
                <Icon name="check" />
                Give it at least as much prominence as any other sign-in option.
              </li>
              <li>
                <Icon name="check" />
                Keep a clear space around it of at least half its height.
              </li>
              <li>
                <Icon name="check" />
                Use one of the three labels, in your page's language if you translate them.
              </li>
              <li>
                <Icon name="check" />
                Make the whole button the link or submit control, and keep the 44px size where people tap.
              </li>
            </ul>
            <ul class="rules-list rules-dont">
              <li>
                <Icon name="alert" />
                Don't recolor, stretch, or redraw the Kingdom mark, or show it without the button.
              </li>
              <li>
                <Icon name="alert" />
                Don't change the font, add icons, or override the button's colors.
              </li>
              <li>
                <Icon name="alert" />
                Don't use it for anything but signing in or signing up with Kingdom ID.
              </li>
              <li>
                <Icon name="alert" />
                Don't use the mark-only button where it's the only way to sign in.
              </li>
            </ul>
          </div>
        </section>
      </main>
      <script type="module" src="/assets/brand.js" nonce={props.ui.nonce} />
    </Document>
  );
}
