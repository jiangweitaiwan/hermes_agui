import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  page.on("pageerror", error => { throw error; });
});

test("UI streams native turns, observes tools, isolates threads and displays errors", async ({ page, request }) => {
  const externalRequests: string[] = [];
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
      externalRequests.push(url.origin);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto("/");
  const chat = page.locator("section:visible");
  await expect(chat.getByRole("status")).toHaveText("已連線");
  const input = () => chat.locator("textarea");
  async function send(text: string) {
    await input().fill(text);
    await input().press("Enter");
  }

  await send("hello alpha");
  await expect(chat).toContainText("Alpha private answer.");
  await expect(chat.getByRole("status")).toHaveText("已連線");
  await send("continue");
  await expect(chat).toContainText("Continued alpha conversation.");
  await expect(chat.getByRole("status")).toHaveText("已連線");

  await page.getByRole("button", { name: "新增對話" }).click();
  await expect(chat.getByRole("status")).toHaveText("已連線");
  await expect(chat).not.toContainText("Alpha private answer.");
  await send("hello beta");
  await expect(chat).toContainText("Beta private answer.");
  await expect(chat.getByRole("status")).toHaveText("已連線");
  await page.getByRole("button", { name: "對話 1", exact: true }).click();
  await expect(chat).toContainText("Alpha private answer.");
  await expect(chat).not.toContainText("Beta private answer.");

  await send("read sample");
  await expect(chat.getByTestId("tool-call")).toContainText("read_file");
  await expect(chat.getByTestId("tool-result")).toContainText("[withheld]");
  await expect(chat).toContainText("Native tool finished.");
  await expect(chat.getByRole("status")).toHaveText("已連線");

  try {
    await send("stream");
    await expect(chat).toContainText("First");
    // Native callback waits for /release, so this proves pre-completion rendering.
    await expect(chat.getByRole("status")).toHaveText("執行中…");
    await expect(chat).not.toContainText("Remaining final answer.");
  } finally {
    await request.post("http://127.0.0.1:8765/__test/release");
  }
  await expect(chat).toContainText("Remaining final answer.");
  await expect(chat.getByRole("status")).toHaveText("已連線");

  await send("fail");
  await expect(chat.getByRole("alert")).toBeVisible();
  await expect(chat).not.toContainText("PRIVATE scripted provider failure");
  await expect(chat.getByRole("status")).toHaveText("已連線");

  const transcripts = await (await request.get("http://127.0.0.1:8765/__test/transcripts")).json();
  const second = transcripts[1].map((m: { content?: string }) => m.content);
  expect(second.filter((text: string) => text === "hello alpha")).toHaveLength(1);
  expect(second).toContain("Alpha private answer.");
  expect(transcripts[2].map((m: { content?: string }) => m.content)).not.toContain("hello alpha");
  expect(transcripts.some((row: { role: string; content?: string }[]) =>
    row.some(m => m.role === "tool" && m.content?.includes("Native tool fixture content")))).toBe(true);
  expect(externalRequests).toEqual([]);
});


test("native clarification and approval resume through the official runtime", async ({ page }) => {
  await page.goto("/");
  const chat = page.locator("section:visible");
  await expect(chat.getByRole("status")).toHaveText("已連線");
  const input = chat.locator("textarea");
  await input.fill("ask color");
  await input.press("Enter");
  const card = chat.getByRole("form", { name: "等待使用者回覆" });
  await expect(card).toBeVisible();
  await card.getByRole("textbox", { name: "Which color?" }).fill("Blue");
  await card.getByRole("button", { name: "送出回覆" }).click();
  await expect(chat).toContainText("Clarification received: Blue.");
  await expect(card).not.toBeVisible();
  await expect(chat.getByRole("status")).toHaveText("已連線");
  await input.fill("approve write");
  await input.press("Enter");
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "拒絕", exact: true }).click();
  await expect(chat).toContainText("Approval handled.");
  await expect(card).not.toBeVisible();
});
