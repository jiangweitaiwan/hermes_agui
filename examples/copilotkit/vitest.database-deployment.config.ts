import { defineConfig } from "vitest/config";
export default defineConfig({test:{include:["tests/acceptance/database-deployment.pg.ts"],maxWorkers:1,testTimeout:30000,hookTimeout:120000}});
