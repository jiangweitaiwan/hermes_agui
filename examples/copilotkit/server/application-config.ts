import type { ApplicationOptions } from "./application";
import type { RuntimeSettings } from "./runtime";
import { PostgresWikiStore } from "./graph/postgres-wiki-store";

export function validateComposition(initialBots: Record<string, RuntimeSettings>, options: ApplicationOptions) {
  if (options.management?.postgres && options.evolution && !(options.evolution.provider.store instanceof PostgresWikiStore)) {
    throw new Error("PostgreSQL Bot registry requires durable Graph evolution");
  }
  if (options.evolution?.provider.store instanceof PostgresWikiStore && options.graphCompletionToken === undefined) {
    throw new Error("Durable Graph evolution requires Host completion delivery");
  }
  if (options.graph && options.management?.users.some(user => options.management!.users.some(other =>
    other.ownerId !== user.ownerId && other.principal === user.principal && other.projectId === user.projectId))) {
    throw new Error("Graph memory requires distinct owner principals within a project");
  }
  if (options.threadMappings && !options.management && Object.values(initialBots).some(settings => {
    const scope = settings.threadScope ?? settings.memory;
    return !scope?.principal || !scope.projectId;
  })) throw new Error("Configure a trusted thread scope for each static Bot");
}
