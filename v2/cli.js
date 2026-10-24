// Entrypoint CLI V2. Expuesto como "./tui".
// Es el único módulo que importa "@opencode/plugin/tui" (sólo lo carga V2).

import { Plugin } from "@opencode/plugin/tui";
import { setupV2 } from "./tui.js";

export default Plugin.define({
  id: "opencode-voice",
  setup: setupV2,
});
