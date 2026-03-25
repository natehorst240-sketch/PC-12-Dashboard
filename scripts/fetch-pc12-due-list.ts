#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { chromium, type Download, type Locator, type Page } from 'playwright';
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

  await page.waitForLoadState('networkidle', { timeout: 60_000 });
  log(`Post-login URL: ${page.url()}`);
}

async function exportDueList(page: Page): Promise<Download> {
  log('Navigating to PC-12 due-list page');
  await page.goto(DUE_LIST_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForLoadState('networkidle', { timeout: 90_000 });

  const exportSelectors: string[] = [
    'button:has-text("Export")',
    'a:has-text("Export")',
    '[aria-label="Export"]',
    '[title="Export"]',
  ];

  for (const selector of exportSelectors) {
    const locator = await getLocatorIfPresent(page, selector);
    if (locator && (await isClickable(locator))) {
      log(`Export control found using ${selector}`);
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
        locator.click({ timeout: 10_000 }),
      ]);
      return download;
    }
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
