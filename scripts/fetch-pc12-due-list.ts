#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { chromium, type BrowserContext, type Download, type Locator, type Page } from 'playwright';
import XLSX from 'xlsx';

const LOGIN_URL: string =
  process.env.FLIGHTDOCS_LOGIN_URL ||
  'https://auth.flightdocs.com/Account/Login';

const DUE_LIST_URL: string =
  process.env.FLIGHTDOCS_DUE_LIST_URL ||
  'https://app2.flightdocs.com/#/maintenance/item/due-list?IncludePaging=false&SortDirection=1&SortProperty=status&ItemDescriptionConstraint=1&PartNumberConstraint=1&SerialNumberConstraint=1&AdSbNumberConstraint=1&ShowTolerance&AircraftIds=23884&AircraftIds=13506&AircraftIds=13505&AircraftIds=22158&AircraftIds=36600&AircraftIds=16028&AircraftIds=15660&ProjectedLandings=600&ProjectedHours=600&ProjectedCycles=600&OverrideLandings&OverrideHours&OverrideCycles&OffsetDays=90';

const OUTPUT_PATH: string =
  process.env.FLIGHTDOCS_OUTPUT_PATH ||
  path.join(process.cwd(), 'data', 'PC12-Daily-Due-List.csv');

const MAX_ATTEMPTS: number = Number(process.env.FLIGHTDOCS_MAX_ATTEMPTS || 3);
const HEADLESS: boolean = process.env.FLIGHTDOCS_HEADLESS !== 'false';

class NonRetryableError extends Error {}

function getFirstEnv(names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value) return value;
  }
  return undefined;
}

function requireCredential(label: string, names: string[]): string {
  const value = getFirstEnv(names);
  if (!value) {
    throw new NonRetryableError(
      `Missing ${label} credential. Set one of: ${names.join(', ')}.`,
    );
  }
  return value;
}

function timestamp(): string {
  return new Date().toISOString();
}

function log(message: string): void {
  console.log(`[${timestamp()}] ${message}`);
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

async function getLocatorIfPresent(page: Page, selector: string): Promise<Locator | null> {
  const locator = page.locator(selector).first();
  if ((await locator.count()) === 0) return null;
  return locator;
}

// Pendo (in-app guide / onboarding) injects a full-page backdrop that sits on
// top of the due-list toolbar and intercepts pointer events, which makes the
// Export button impossible to click. Aborting its agent requests stops the
// guides from ever rendering.
async function blockPendo(context: BrowserContext): Promise<void> {
  await context.route(
    /(pendo\.io|pendo-static|pendo-io-static|data\.pendo)/i,
    (route) => route.abort(),
  );
}

// Defensive cleanup in case a Pendo guide still slipped through (e.g. served
// from a host we did not block, or already cached). Removing the overlay nodes
// frees up the underlying controls so they become clickable again.
async function dismissPendoOverlays(page: Page): Promise<number> {
  try {
    const removed = await page.evaluate(() => {
      const selectors = [
        '#pendo-base',
        '[id^="pendo-backdrop"]',
        '[class*="_pendo-backdrop"]',
        '[class*="_pendo-step-container"]',
        '[id^="pendo-guide"]',
        '[class*="pendo-resource-center"]',
        '[class*="_pendo-badge"]',
      ];
      let count = 0;
      for (const selector of selectors) {
        document.querySelectorAll(selector).forEach((el) => {
          el.remove();
          count += 1;
        });
      }
      return count;
    });
    if (removed > 0) {
      log(`Removed ${removed} Pendo overlay element(s) blocking interaction`);
    }
    return removed;
  } catch (err) {
    log(
      `Failed to dismiss Pendo overlays: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  }
}

async function isClickable(locator: Locator): Promise<boolean> {
  try {
    return (await locator.isVisible()) && (await locator.isEnabled());
  } catch {
    return false;
  }
}

async function isEditable(locator: Locator): Promise<boolean> {
  try {
    return (
      (await locator.isVisible()) &&
      (await locator.isEnabled()) &&
      (await locator.isEditable())
    );
  } catch {
    return false;
  }
}

async function hasAnyEditableSelector(page: Page, selectors: string[]): Promise<boolean> {
  for (const selector of selectors) {
    const locator = await getLocatorIfPresent(page, selector);
    if (locator && (await isEditable(locator))) return true;
  }
  return false;
}

async function waitForAnyEditableSelector(
  page: Page,
  selectors: string[],
  timeoutMs: number,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    for (const selector of selectors) {
      const locator = await getLocatorIfPresent(page, selector);
      if (locator && (await isEditable(locator))) return selector;
    }
    await page.waitForTimeout(300);
  }
  throw new Error(`Timed out waiting for any editable selector: ${selectors.join(', ')}`);
}

async function clickFirst(page: Page, selectors: string[]): Promise<string> {
  for (const selector of selectors) {
    const locator = await getLocatorIfPresent(page, selector);
    if (locator && (await isClickable(locator))) {
      await locator.click({ timeout: 10_000 });
      return selector;
    }
  }
  throw new Error(`Unable to click any selector: ${selectors.join(', ')}`);
}

async function fillFirst(page: Page, selectors: string[], value: string): Promise<string> {
  for (const selector of selectors) {
    const locator = await getLocatorIfPresent(page, selector);
    if (locator && (await isEditable(locator))) {
      await locator.fill(value, { timeout: 10_000 });
      return selector;
    }
  }
  throw new Error(`Unable to fill any editable selector: ${selectors.join(', ')}`);
}

async function login(page: Page, username: string, password: string): Promise<void> {
  log('Navigating to login page');
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const usernameSelectors: string[] = [
    'input[name="username"]',
    'input[name="Username"]',
    'input[name="email"]',
    'input[name="Email"]',
    'input[name="EmailAddress"]',
    'input[id="username"]',
    'input[id="Email"]',
    'input[id="email"]',
    'input[id="EmailAddress"]',
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[placeholder*="email" i]',
    'input[placeholder*="user" i]',
    'xpath=/html/body/div[2]/section/div/div[2]/form/div[1]/div/div/input',
  ];

  const continueSelectors: string[] = [
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Proceed")',
    'input[type="submit"][value*="Continue" i]',
    'input[type="submit"][value*="Next" i]',
  ];

  const passwordSelectors: string[] = [
    'input[name="password"]',
    'input[name="Password"]',
    'input[id="password"]',
    'input[id="Password"]',
    'input[autocomplete="current-password"]',
    'input[autocomplete="password"]',
    'input[type="password"]',
  ];

  await waitForAnyEditableSelector(page, usernameSelectors, 20_000);
  const userSelector = await fillFirst(page, usernameSelectors, username);
  log(`Filled username using ${userSelector}`);

  if (!(await hasAnyEditableSelector(page, passwordSelectors))) {
    const continueSelector = await clickFirst(page, continueSelectors);
    log(`Clicked intermediate continue/next using ${continueSelector}`);
  }

  await waitForAnyEditableSelector(page, passwordSelectors, 30_000);
  const passSelector = await fillFirst(page, passwordSelectors, password);
  log(`Filled password using ${passSelector}`);

  const submitSelector = await clickFirst(page, [
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
    'input[type="submit"][value*="Sign in" i]',
    'input[type="submit"][value*="Log in" i]',
    'button[type="submit"]',
    'input[type="submit"]',
  ]);
  log(`Submitted login form using ${submitSelector}`);

  try {
    await page.waitForURL((url: URL) => !/auth\.flightdocs\.com/i.test(url.hostname), {
      timeout: 60_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Login did not navigate away from auth host: ${message}`);
  }
  log(`Post-login URL: ${page.url()}`);
}

async function saveExportDiagnostics(page: Page, reason: string): Promise<void> {
  const debugDir =
    process.env.FLIGHTDOCS_DEBUG_DIR || path.join(process.cwd(), 'data', 'debug');
  try {
    await ensureDir(debugDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(debugDir, `pc12-export-${reason}-${stamp}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    log(`Saved failure screenshot to ${screenshotPath}`);
    const htmlPath = path.join(debugDir, `pc12-export-${reason}-${stamp}.html`);
    await fs.writeFile(htmlPath, await page.content(), 'utf8');
    log(`Saved failure HTML to ${htmlPath}`);
  } catch (err) {
    log(
      `Failed to save export diagnostics: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function exportDueList(page: Page): Promise<Download> {
  log('Navigating to PC-12 due-list page');
  await page.goto(DUE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });

  try {
    await page.waitForLoadState('networkidle', { timeout: 30_000 });
  } catch {
    log('Network did not become fully idle; proceeding anyway');
  }

  await dismissPendoOverlays(page);

  const exportSelectors: string[] = [
    'button:has-text("Export")',
    'a:has-text("Export")',
    '[aria-label="Export"]',
    '[title="Export"]',
  ];

  // Selectors for sub-menu / dropdown items that appear after clicking Export.
  // Restricted to :visible so we don't match hidden/collapsed menu nodes. The
  // "Export Due List" confirmation dialog is matched first so its primary
  // Export button takes precedence over the toolbar Export link behind it.
  const exportSubMenuSelectors: string[] = [
    '[role="dialog"] button:has-text("Export"):visible',
    '[role="dialog"] a:has-text("Export"):visible',
    '.modal-footer button:has-text("Export"):visible',
    '.modal-dialog button:has-text("Export"):visible',
    '.modal button:has-text("Export"):visible',
    '[role="menuitem"]:has-text("Excel"):visible',
    '[role="menuitem"]:has-text("XLSX"):visible',
    '[role="menuitem"]:has-text("CSV"):visible',
    '[role="menuitem"]:has-text("Download"):visible',
    'a:has-text("Export to Excel"):visible',
    'button:has-text("Export to Excel"):visible',
    'a:has-text("Excel"):visible',
    'button:has-text("Excel"):visible',
    'a:has-text("XLSX"):visible',
    'button:has-text("XLSX"):visible',
    'a:has-text("CSV"):visible',
    'button:has-text("CSV"):visible',
    'li:has-text("Excel"):visible a',
    'li:has-text("Excel"):visible button',
    'li:has-text("CSV"):visible a',
    'li:has-text("Download"):visible a',
    'a:has-text("Download"):visible',
    'button:has-text("Download"):visible',
    'button:has-text("Generate"):visible',
  ];

  const downloadTimeoutMs = Number(
    process.env.FLIGHTDOCS_DOWNLOAD_TIMEOUT_MS || 300_000,
  );
  const submenuPollTimeoutMs = Number(
    process.env.FLIGHTDOCS_SUBMENU_TIMEOUT_MS || 30_000,
  );

  const start = Date.now();
  const findExportTimeoutMs = 120_000;
  while (Date.now() - start < findExportTimeoutMs) {
    for (const selector of exportSelectors) {
      const locator = await getLocatorIfPresent(page, selector);
      if (locator && (await isClickable(locator))) {
        log(`Export control found using ${selector}`);

        // Start listening for download before any clicks so we don't miss it
        const downloadPromise = page.waitForEvent('download', {
          timeout: downloadTimeoutMs,
        });
        let downloadResolved = false;
        downloadPromise.then(
          () => {
            downloadResolved = true;
          },
          () => {
            downloadResolved = true;
          },
        );

        await dismissPendoOverlays(page);
        try {
          await locator.click({ timeout: 10_000 });
        } catch (clickErr) {
          // A Pendo backdrop can intercept the click; strip it and retry once.
          const removed = await dismissPendoOverlays(page);
          if (removed === 0) throw clickErr;
          log('Retrying Export click after removing Pendo overlay');
          await locator.click({ timeout: 10_000 });
        }

        // Actively poll for a submenu item rather than relying on a fixed wait.
        // Stop polling as soon as a submenu is clicked or the download fires
        // (covers the case where Export itself triggers an immediate download).
        const submenuStart = Date.now();
        let submenuClicked = false;
        while (
          !submenuClicked &&
          !downloadResolved &&
          Date.now() - submenuStart < submenuPollTimeoutMs
        ) {
          await dismissPendoOverlays(page);
          for (const subSelector of exportSubMenuSelectors) {
            const subLocator = await getLocatorIfPresent(page, subSelector);
            if (subLocator && (await isClickable(subLocator))) {
              log(`Export submenu found using ${subSelector}; clicking`);
              try {
                await subLocator.click({ timeout: 10_000 });
                submenuClicked = true;
              } catch (err) {
                log(
                  `Failed to click submenu ${subSelector}: ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              }
              break;
            }
          }
          if (!submenuClicked && !downloadResolved) {
            await page.waitForTimeout(500);
          }
        }

        if (!submenuClicked && !downloadResolved) {
          log(
            'No submenu item appeared within poll window; saving diagnostics and continuing to wait for download',
          );
          await saveExportDiagnostics(page, 'no-submenu');
        }

        try {
          return await downloadPromise;
        } catch (err) {
          await saveExportDiagnostics(page, 'download-timeout');
          throw err;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Unable to find Export button with selectors: ${exportSelectors.join(', ')}`);
}

async function convertExcelToCsv(excelPath: string, csvPath: string): Promise<void> {
  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Downloaded workbook did not contain any sheets.');
  }

  const sheet = workbook.Sheets[sheetName];
  const csv = XLSX.utils.sheet_to_csv(sheet);

  const outputDir = path.dirname(csvPath);
  await ensureDir(outputDir);

  const backupPath = `${csvPath}.bak`;
  const tempPath = `${csvPath}.tmp`;

  try {
    await fs.copyFile(csvPath, backupPath);
    log(`Backed up previous CSV to ${backupPath}`);
  } catch {
    log('No previous CSV found to back up; continuing');
  }

  await fs.writeFile(tempPath, csv, 'utf8');
  await fs.rename(tempPath, csvPath);

  const stats = await fs.stat(csvPath);
  log(`CSV written: ${csvPath} (${stats.size} bytes)`);

  try { await fs.unlink(excelPath); log(`Deleted temp Excel: ${excelPath}`); } catch {}
  try { await fs.unlink(backupPath); } catch {}
  try {
    const files = await fs.readdir(outputDir);
    for (const file of files) {
      if (file.endsWith('.xlsx') || file.endsWith('.bak') || file.endsWith('.tmp')) {
        await fs.unlink(path.join(outputDir, file));
        log(`Cleaned up: ${file}`);
      }
    }
  } catch {}
}

async function runOnce(): Promise<void> {
  const username = requireCredential('username', ['FLIGHTDOCS_USERNAME', 'FD_USERNAME', 'FLIGHTDOCS_USER']);
  const password = requireCredential('password', ['FLIGHTDOCS_PASSWORD', 'FD_PASSWORD', 'FLIGHTDOCS_PASS']);

  const downloadDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flightdocs-pc12-due-list-'));
  log(`Download directory: ${downloadDir}`);

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({ acceptDownloads: true });
  await blockPendo(context);
  const page = await context.newPage();

  try {
    await login(page, username, password);
    const download = await exportDueList(page);
    const suggested = download.suggestedFilename();
    const extension = path.extname(suggested).toLowerCase() || '.xlsx';
    const excelPath = path.join(downloadDir, `pc12-due-list${extension}`);
    await download.saveAs(excelPath);
    log(`Downloaded file saved to ${excelPath}`);
    await convertExcelToCsv(excelPath, OUTPUT_PATH);
  } finally {
    await context.close();
    await browser.close();
  }
}

async function runWithRetries(): Promise<void> {
  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    try {
      log(`Attempt ${attempt}/${MAX_ATTEMPTS}`);
      await runOnce();
      log('Success');
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(`Attempt ${attempt} failed: ${message}`);
      if (error instanceof NonRetryableError) throw error;
      if (attempt >= MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

runWithRetries().catch((error: unknown) => {
  console.error(`[${timestamp()}] Fatal error:`, error);
  process.exit(1);
});
