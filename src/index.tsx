/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { CrashGuard } from "./CrashGuard";

render(() => <CrashGuard><App /></CrashGuard>, document.getElementById("root") as HTMLElement);
