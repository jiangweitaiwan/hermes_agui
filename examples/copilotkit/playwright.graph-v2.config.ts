import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"tests/browser",testMatch:"graph-v2.spec.ts",workers:1,retries:0,timeout:60000,
 use:{baseURL:"http://127.0.0.1:3039",headless:true,screenshot:"only-on-failure",trace:"retain-on-failure",launchOptions:{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}},
 webServer:{command:"node --import tsx tests/fixtures/graph-v2-browser-server.ts",url:"http://127.0.0.1:3039",timeout:60000,reuseExistingServer:false}});
