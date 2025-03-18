import { GlobalRegistrator } from "@happy-dom/global-registrator";

// FIX for https://github.com/oven-sh/bun/issues/6044
const oldconsole = console;
// FIX for https://github.com/vitest-dev/vitest/issues/7166
const oldfetch = globalThis.fetch;
GlobalRegistrator.register();
window.console = oldconsole;
globalThis.fetch = oldfetch;
