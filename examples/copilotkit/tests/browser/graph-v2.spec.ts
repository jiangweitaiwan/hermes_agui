import {expect,test} from "@playwright/test";
test("real V2 API renders shared Wiki subjects, event evidence and current/history states",async({page})=>{
 const errors:string[]=[];page.on("pageerror",e=>errors.push(e.message));
 page.on("response",r=>{if(r.url().includes("/api/graph/") && r.status()>=400)errors.push(`Graph API ${r.status()}`);});
 await page.goto("/");await page.getByLabel("存取金鑰").fill("owner-secret");await page.getByRole("button",{name:"登入",exact:true}).click();
 await page.getByRole("button",{name:"Graph Memory",exact:true}).click();
 const timeline=page.getByRole("region",{name:"Fact timeline",exact:true}).first();
 await expect(timeline).toContainText("FeatureHub 目前部署 v2");
 await expect(timeline.locator("ol > li").filter({hasText:"deployed_version"})).toHaveCount(1);
 await timeline.getByLabel("時間檢視").selectOption("history");
 await expect(timeline).toContainText("FeatureHub 目前部署 v1");await expect(timeline).toContainText("FeatureHub 目前部署 v2");
 await timeline.getByText(/rolled_back/).first().click();await expect(timeline).toContainText("隔天 Bob 把 FeatureHub 回滾到舊版");
 const pages=page.getByRole("list",{name:"Wiki pages",exact:true});await pages.getByRole("button",{name:/FeatureHub/}).click();
 const detail=page.getByRole("region",{name:"Fact timeline",exact:true}).last();
 await detail.getByText(/展開 Wiki 內 Subject/).click();await expect(detail).toContainText("FeatureHub 的快取");await detail.getByText("FeatureHub 的快取 · component",{exact:true}).click();await expect(detail).toContainText("parent");
 await expect(page.locator(".memory-graph circle")).toHaveCount(8);
 await page.screenshot({path:"../../artifacts/graph-memory-v2-part-2/browser.png",fullPage:true});expect(errors).toEqual([]);
});
