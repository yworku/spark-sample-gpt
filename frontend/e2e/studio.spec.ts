import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";

const origin = "http://127.0.0.1:8000";

test("private studio reopens edits and exports the selected media", async ({
  page,
}) => {
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.goto("/projects");
  await page
    .getByLabel("Studio password")
    .fill("disposable-browser-test-password");
  await page.getByRole("button", { name: /Enter studio/ }).click();
  await expect(
    page.getByRole("heading", { name: /Your Projects/ }),
  ).toBeVisible();

  // Set up real private source media through the same authenticated API.
  const created = await page.request.post("/api/projects", {
    headers: { Origin: origin },
    data: {
      name: "Browser export test",
      kind: "video",
      mode: "paste",
      script: "The first scene.\n\nA second scene.",
      ratio: "16:9",
      style: "watercolor",
      language: "English",
    },
  });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const upload = await page.request.post(`/api/projects/${project.id}/assets`, {
    headers: { Origin: origin },
    multipart: {
      kind: "image",
      file: {
        name: "fox.png",
        mimeType: "image/png",
        buffer: await fs.readFile(path.resolve("public/styles/watercolor.png")),
      },
    },
  });
  expect(upload.status()).toBe(201);
  const asset = await upload.json();
  const { id, revision, created_at, updated_at, deleted_at, ...document } =
    project;
  for (const scene of document.scenes) {
    scene.image_id = asset.id;
    scene.duration = 0.5;
  }
  const save = await page.request.put(`/api/projects/${id}`, {
    headers: { Origin: origin },
    data: { base_revision: revision, document },
  });
  expect(save.status()).toBe(200);

  await page.goto(`/editor/${id}`);
  await expect(page.getByLabel("Project name")).toHaveValue(
    "Browser export test",
  );
  await page
    .getByLabel("Scene title", { exact: true })
    .fill("Saved browser scene");
  await expect(
    page.getByText("All changes saved", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Scene title", { exact: true })).toHaveValue(
    "Saved browser scene",
  );
  await page.getByRole("button", { name: "Captions", exact: true }).click();
  await page.getByLabel("Show captions", { exact: true }).check();
  await page
    .getByLabel("Caption text", { exact: false })
    .fill("A private creative workspace.");
  await page.getByRole("button", { name: "Export video", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Resolution", { exact: true }).selectOption("720");
  await dialog
    .getByRole("button", { name: "Export video", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Download 720p export" }),
  ).toBeVisible({ timeout: 60_000 });
  const downloadPromise = page.waitForEvent("download");
  await dialog.getByRole("link", { name: "Download 720p export" }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const bytes = await fs.readFile(downloadedPath!);
  expect(bytes.subarray(0, 32).includes(Buffer.from("ftyp"))).toBeTruthy();
  expect(browserErrors).toEqual([]);

  const fileUrl = await dialog
    .getByRole("link", { name: "Download 720p export" })
    .getAttribute("href");
  await page.request.post("/api/logout", { headers: { Origin: origin } });
  expect((await page.request.get(fileUrl!)).status()).toBe(401);
});

test("new project offers guided and manual creation", async ({ page }) => {
  await page.goto("/projects");
  await page
    .getByLabel("Studio password")
    .fill("disposable-browser-test-password");
  await page.getByRole("button", { name: /Enter studio/ }).click();
  await page
    .getByRole("button", { name: /New Project$/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: /Spark.*Guide/ }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: /Spark.*Studio/ }),
  ).toBeVisible();
});
