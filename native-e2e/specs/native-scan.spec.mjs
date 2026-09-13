describe("native Tauri viewer", () => {
  it("opens the injected source through production IPC and renders media from the custom protocol", async () => {
    const openFolder = await $("aria/Open folder");
    await openFolder.click();

    await browser.waitUntil(
      async () => (await $("body").getText()).includes("Ready"),
      {
        timeout: 20_000,
        timeoutMsg: "viewer never reached Ready after native scan",
      },
    );

    const bodyText = await $("body").getText();
    expect(bodyText).toContain("1 media");
    expect(bodyText).toContain("native-fixture.png");

    const image = await $('img[alt="native-fixture.png"]');
    await image.waitForDisplayed();

    const source = await image.getAttribute("src");
    expect(source).toContain("waterfall-media");
  });
});
