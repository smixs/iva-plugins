// The extension handle. `hello` takes no settings, so the handle is bare: Iva calls
// it with the config it reads from `data/custom/plugins/hello.config.json`, and an
// extension without a config schema ignores it.
import { defineExtension } from "eve/extension";

export default defineExtension();
