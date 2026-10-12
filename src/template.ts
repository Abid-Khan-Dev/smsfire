import { SmsError } from "./errors";

/** Replace `{name}` placeholders. Throws if any variable is missing. */
export function renderTemplate(template: string, vars: Record<string, unknown> = {}): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = vars[name];
    if (v === undefined || v === null) {
      throw new SmsError("TEMPLATE_VARIABLE_MISSING", `Missing template variable: ${name}`);
    }
    return String(v);
  });
}
