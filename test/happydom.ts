import { GlobalRegistrator } from "@happy-dom/global-registrator";

// FIX for https://github.com/oven-sh/bun/issues/6044
const oldconsole = console;
GlobalRegistrator.register();
window.console = oldconsole;
