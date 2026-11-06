import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addSharePills } from "./client/pills";

export default function contribute(client: PluginClientContext) {
  return addSharePills(client);
}
