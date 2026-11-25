import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  getSwitchRecordRpc,
  listCatalogRpc,
  recordRecentRpc,
  switchModelRpc,
  togglePinRpc,
} from "./shared/contracts";
import { modelSwitchSettings } from "./shared/settings";
import {
  handleGetSwitchRecord,
  handleListCatalog,
  handleRecordRecent,
  handleSwitchModel,
  handleTogglePin,
  registerSessionOpenHook,
} from "./server/switcher";
import { IncrementalTimelineCache } from "./server/turn-cache";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(modelSwitchSettings);
  const turnCache = new IncrementalTimelineCache();
  const removeCacheHooks = turnCache.attachHooks(server);
  const removeOpenHook = registerSessionOpenHook(server, settings);

  server.handle(listCatalogRpc, (input, { paseo }) => handleListCatalog(input, paseo));
  server.handle(togglePinRpc, (input) => handleTogglePin(input));
  server.handle(recordRecentRpc, (input) => handleRecordRecent(input));
  server.handle(switchModelRpc, (input, { paseo }) =>
    handleSwitchModel(input, paseo, settings, turnCache),
  );
  server.handle(getSwitchRecordRpc, (input) => handleGetSwitchRecord(input));

  return () => {
    removeOpenHook();
    removeCacheHooks();
  };
}
