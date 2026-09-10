import { createSignal } from "solid-js";
import type { ThemeId } from "../themes";

/**
 * The resolved editor theme, published for CodeMirror instances that are mounted
 * outside the workbench tree and so cannot receive it as a prop — today the
 * single-line `SqlField` used by the Create/Modify table, index and constraint
 * dialogs. App writes it from the same effect that stamps `<html data-theme>`,
 * so a theme change reconfigures every field live.
 *
 * "system" is resolved before it gets here, exactly like `themeFor`'s input.
 */
const [fieldTheme, setFieldTheme] = createSignal<ThemeId>("oneDark");

export { fieldTheme, setFieldTheme };
