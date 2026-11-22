import type { ApplicationOptions } from "../application";
import type { createBotManagement } from "../bots/application";
import type { BotRecord } from "../bots/types";
import type { Namespace } from "./types";
import { PostgresWikiStore } from "./postgres-wiki-store";
import { WikiGraphProvider } from "./provider";

/** Bind publication and final read checks to current Runtime ownership, including after external awaits. */
export function configureGraphAuthority(options: ApplicationOptions, management: ReturnType<typeof createBotManagement> | undefined,
  retained: (ns: Namespace, bot: string) => boolean) {
  if (options.evolution?.provider.store instanceof PostgresWikiStore) {
    options.evolution.provider.store.authorizePublication = async (client, ns, ids) => {
      if (management && options.management?.postgres) {
        const { rows } = await client.query<{ principal: string; record: BotRecord }>(
          "SELECT principal,record FROM hermes_agui_runtime.bot_registry WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE", [ids]);
        if (rows.length !== ids.length || rows.some(({ principal, record }) => principal !== ns.principal ||
          record.projectId !== ns.projectId || record.deletedAt || !options.management!.users.some(user =>
            user.ownerId === record.ownerId && user.principal === principal && user.projectId === ns.projectId))) {
          throw new Error("Graph publication authorization changed");
        }
      }
      if (ids.some(id => !retained(ns, id))) throw new Error("Graph publication denied");
    };
  }
  const readProvider = options.graph?.provider;
  if (readProvider instanceof WikiGraphProvider) readProvider.facts.retained = (ns,bot) => retained(ns,bot) &&
    (!management || management.manager.options.registry.get(bot)?.record.status === "active");
  if (readProvider instanceof WikiGraphProvider && readProvider.store instanceof PostgresWikiStore && options.management?.postgres) {
    readProvider.store.readScope = ns => options.management!.users
      .filter(user => user.principal === ns.principal && user.projectId === ns.projectId).map(user => user.ownerId);
    if (!options.evolution) readProvider.beforeQuery = async () => { await management?.manager.sync(); };
  }
}
