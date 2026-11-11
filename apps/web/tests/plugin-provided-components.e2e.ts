/** Existing parent-bundle components remain the only activation targets in the Plugins page. */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Locator } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh, PLUGIN_TOGGLE_SETTLE_MS, ZH_BROWSER_LOCALE } from './support.ts'

it('shows parent-provided components without selecting another bundle and rejects direct duplicate activation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-provided-web-'))
  const owned: { scaffold?: WebScaffold; browser?: Browser } = {}
  onTestFinished(async () => {
    try { await owned.browser?.close() } finally {
      try { await owned.scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  })
  const starter = '@fixture/memory-starter'
  const enhancement = '@fixture/memory-enhancement'
  const starterDir = join(root, 'starter')
  const enhancementDir = join(root, 'enhancement')
  await mkdir(starterDir)
  await mkdir(enhancementDir)
  await writeFile(join(enhancementDir, 'package.json'), JSON.stringify({
    name: enhancement, version: '1.0.0', type: 'module', main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await writeFile(join(enhancementDir, 'index.js'), 'export function apply() {}\n')
  const component = { id: 'fixture-memory-enhancement', name: enhancement, disabled: true }
  await writeFile(join(enhancementDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [component] }]))
  await writeFile(join(starterDir, 'package.json'), JSON.stringify({
    name: starter, version: '1.0.0', dependencies: { [enhancement]: 'file:../enhancement' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  await mkdir(join(starterDir, 'node_modules', '@fixture'), { recursive: true })
  await symlink(enhancementDir, join(starterDir, 'node_modules', '@fixture', 'memory-enhancement'), 'junction')
  await writeFile(join(starterDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [{
    id: 'fixture-memory-starter', name: 'cordis:group', group: true, config: [component],
  }] }]))
  const scaffold = owned.scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
    profile: { packages: [{ dir: starterDir, enabled: true }, { dir: enhancementDir }] },
  })
  const fixtureBundles = (await scaffold.ctx.pluginManager.listBundles()).filter(bundle => bundle.name.startsWith('@fixture/'))
  expect(fixtureBundles.find(bundle => bundle.name === enhancement)).toMatchObject({ enabled: false, providedBy: [starter] })
  const browser = owned.browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
  await page.goto(scaffold.authenticatedUrl)
  await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  await page.getByRole('navigation', { name: '全局面板' }).getByRole('button', { name: '插件', exact: true }).click()
  const card = page.locator(`[data-plugin-package="${enhancement}"]`)
  await card.getByText('已由其他插件包提供', { exact: true }).waitFor()
  expect(await card.getByRole('switch').count()).toBe(0)
  const artifacts = fileURLToPath(new URL('../../../.artifacts', import.meta.url))
  await mkdir(artifacts, { recursive: true })
  async function captureReview(view: string, target: Locator): Promise<void> {
    for (const [width, colorScheme] of [[1440, 'light'], [720, 'dark']] as const) {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme })
      await expect.poll(() => page.locator('body').evaluate(body => body.hasAttribute('data-ds-dark-theme'))).toBe(colorScheme === 'dark')
      if (view === 'detail') {
        const colors = await target.locator('p[role="status"]').evaluate((element) => {
          const actual = getComputedStyle(element).color
          const original = element.style.color
          try {
            element.style.color = 'var(--dsw-alias-label-secondary)'
            return { actual, neutral: getComputedStyle(element).color }
          } finally { element.style.color = original }
        })
        expect(colors.actual).toBe(colors.neutral)
      }
      const image = join(artifacts, `${basename(root)}-${view}-${width}-${colorScheme}.png`)
      await target.screenshot({ path: image, animations: 'disabled' })
      console.info(`Provided-component UI review: ${image}`)
    }
  }
  await captureReview('card', card)
  const manifest = join(scaffold.harnessHome, 'profiles/scaffold/package.json')
  const before = await readFile(manifest, 'utf8')
  await card.getByRole('button', { name: `查看 ${enhancement}`, exact: true }).click()
  const detail = page.locator(`[data-plugin-detail="${enhancement}"]`)
  await compareOrRefreshGolden(fileURLToPath(new URL('./expected/plugin-provided-components/provided.expected.md', import.meta.url)),
    await captureStableAria(page, `[data-plugin-detail="${enhancement}"] p[role="status"]`, scaffold.workspaceCwd), webSnapshotMode())
  const toggle = detail.getByRole('switch', { name: `启用组件 ${enhancement}`, exact: true })
  expect(await toggle.getAttribute('aria-checked')).toBe('false')
  await toggle.click()
  await expect.poll(
    async () => (await scaffold.ctx.pluginManager.listPlugins()).find(entry => entry.moduleName === enhancement),
    { timeout: PLUGIN_TOGGLE_SETTLE_MS },
  ).toMatchObject({ enabled: true, fiberPhase: 'active', patchId: component.id })
  await expect.poll(() => toggle.getAttribute('aria-checked'), { timeout: PLUGIN_TOGGLE_SETTLE_MS }).toBe('true')
  await captureReview('detail', detail)
  expect([...scaffold.ctx.loader.entries()].filter(entry => entry.options.id === component.id)).toHaveLength(1)
  expect(await readFile(manifest, 'utf8')).toBe(before)
  expect(await scaffold.ctx.pluginManager.setBundleEnabled(enhancement, true)).toMatchObject({
    application: 'failed', changed: false, error: { code: 'duplicate-entry' },
  })
  expect(await readFile(manifest, 'utf8')).toBe(before)
  expect((await scaffold.ctx.pluginManager.listBundles()).find(bundle => bundle.name === enhancement))
    .toMatchObject({ enabled: false, providedBy: [starter] })
})
