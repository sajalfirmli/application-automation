import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const url = 'https://www.crizac.com/login';
const email = 'Sanghita.das@studyportal.io';
const password = 'Dfavo@123';

// Read "Label : Value" lines from a data file in the project folder
function readData(fileName) {
  const text = fs.readFileSync(path.join(__dirname, '..', fileName), 'utf8');
  const data = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    data[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return data;
}

// The dropdown that follows a label in a dialog
function selectByLabel(dialog, label) {
  return dialog.locator(`xpath=.//*[normalize-space(text())="${label}"]/following::mat-select[1]`);
}

// Open a dropdown and pick an option, typing in its search box only if the option isn't listed
async function selectOption(dialog, select, value) {
  await expect(select).toBeEnabled({ timeout: 30000 });
  await select.click();

  // Use this dropdown's own list: the previous one can still be closing (animating)
  const selectId = await select.getAttribute('id');
  const panel = dialog.page().locator(`[id="${selectId}-panel"]`);
  await panel.waitFor({ state: 'visible' });
  const option = panel.getByRole('option', { name: value, exact: true });

  // Pick straight from the list when the option has loaded. Typing in the search box
  // makes the site reload the list when it closes, which blanks the chosen value.
  const listed = await option
    .waitFor({ state: 'attached', timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  if (!listed) {
    // The search box sits inside an aria-disabled option, so Playwright's fill/click
    // would wait forever for it to be "enabled"; focus it and type with the keyboard
    await panel.locator('input[aria-label="dropdown search"]').focus();
    await dialog.page().keyboard.type(value, { delay: 50 });
  }

  await option.click({ timeout: 30000 });
  await expect(select).toContainText(value);
  // The next dropdown's options load from the server after this choice
  await dialog.page().waitForLoadState('networkidle');
}

test('application flow', async ({ page }) => {
  test.setTimeout(180000);

  await page.goto(url);
  await page.fill('#exampleInputEmail1', email);
  await page.fill('#exampleInputPassword', password);
  await page.click('button.btn-login');

  // Solve the text captcha if it appears after clicking login
  const captcha = page.locator('.captcha-container');
  const hasCaptcha = await captcha
    .waitFor({ state: 'visible', timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  if (hasCaptcha) {
    const letters = await captcha.locator('span').allTextContents();
    const captchaText = letters.map((l) => l.trim()).join('');
    await page.fill('input[placeholder="Enter text exactly as shown above."]', captchaText);
    await page.locator('button[mat-flat-button]', { hasText: 'Check' }).click();
    // Close the "Verified!" popup so it stops covering the login button
    await page.click('.swal2-confirm');
    await page.locator('.swal2-container').waitFor({ state: 'detached' });
    await page.click('button.btn-login');
  }

  // Wait for the dashboard to finish loading after login
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Add New Application' }).click();

  // Fill the Apply For New Course form (not submitted)
  const data = readData('apply_new_course.txt');
  const dialog = page.getByRole('dialog', { name: /Apply For New Course/ });
  await dialog.waitFor({ state: 'visible' });
  await page.waitForLoadState('networkidle');
  await expect(dialog).toContainText(data['Mode (toggle)']);

  const fields = [
    'Country to Apply',
    'Country of Student Passport',
    'Intake',
    'Course Type',
    'University',
    'Course',
    'University Main Course',
  ];
  for (const label of fields) {
    await selectOption(dialog, selectByLabel(dialog, label), data[label]);
  }

  // Confirm every choice is still showing once the form settles
  await page.waitForTimeout(3000);
  for (const label of fields) {
    await expect(selectByLabel(dialog, label)).toContainText(data[label]);
  }

  // Submit the course choice, which opens the Process Application form
  const applyButton = dialog.getByRole('button', { name: 'Apply New Course' });
  await expect(applyButton).toBeEnabled();
  await applyButton.click();

  // Fill the Process Application form (not submitted - Continue is not clicked)
  const student = readData('process_application.txt');
  const pa = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Process Application' }) });
  await pa.waitFor({ state: 'visible', timeout: 30000 });
  await page.waitForLoadState('networkidle');

  // Prefilled from the Apply For New Course form - must match what was picked there
  await expect(pa.getByRole('combobox').nth(0)).toContainText(data['Intake']);
  await expect(pa.getByRole('combobox').nth(1)).toContainText(data['Country of Student Passport']);

  // Choose State before the text boxes - choosing it clears City.
  // The dropdown's name changes from "Select State" to the chosen state, so pin it by id first
  const stateId = await pa.getByRole('combobox', { name: 'Select State' }).getAttribute('id');
  await selectOption(pa, pa.locator(`[id="${stateId}"]`), student['State']);

  // Text boxes, found by their placeholder
  const textFields = {
    'Student First Name': 'Enter First Name.',
    'Student Last Name': 'Enter Last Name.',
    'Student Passport No.': 'Student Passport No.',
    'Student Email ID': 'Enter Email ID.',
    'Pincode': 'Pincode',
    'City': 'City',
    'Address Line 1': 'Address Line 1',
    'Address Line 2': 'Address Line 2',
    'Email-ID of the person handling this application': 'Enter email address',
  };
  for (const [label, placeholder] of Object.entries(textFields)) {
    await pa.getByPlaceholder(placeholder, { exact: true }).fill(student[label]);
  }

  // Phone numbers: "+213 551234567" -> country code dropdown + number box
  const phoneFields = [
    'Student Whatsapp Number',
    'Contact No of the person handling this application',
  ];
  for (const label of phoneFields) {
    const [code, number] = student[label].split(/\s+/);
    const box = pa.getByPlaceholder(label, { exact: true });
    const codeSelect = box.locator('xpath=preceding::mat-select[1]');
    await expect(codeSelect).toContainText(`(${code})`);
    await box.fill(number);
  }

  // Radio buttons: find the field block holding both the question and its options
  const radioFields = [
    'Any Previous Visa Refusal',
    'Gender',
    'Do you want to avail Accommodation Assistance for this student in future?',
  ];
  for (const label of radioFields) {
    const group = pa
      .locator('div')
      .filter({ hasText: label })
      .filter({ has: page.getByRole('radiogroup') })
      .last();
    await group.getByRole('radio', { name: student[label], exact: true }).check();
  }

  // Confirm nothing was cleared once the form settles (e.g. City after choosing State)
  await page.waitForTimeout(2000);
  for (const [label, placeholder] of Object.entries(textFields)) {
    await expect(pa.getByPlaceholder(placeholder, { exact: true })).toHaveValue(student[label]);
  }
  for (const label of phoneFields) {
    await expect(pa.getByPlaceholder(label, { exact: true })).toHaveValue(student[label].split(/\s+/)[1]);
  }
  await expect(pa.locator(`[id="${stateId}"]`)).toContainText(student['State']);

  // Submit the application
  // Screenshots go in screenshots/<student email>-<CAMS ID>. The CAMS ID is only known
  // after submitting, so keep the first screenshots in memory and write them out then.
  const studentEmail = student['Student Email ID'];
  const shots = [];
  let shotDir = '';
  const capture = async (target, fileName) => {
    if (shotDir) await target.screenshot({ path: path.join(shotDir, fileName) });
    else shots.push([fileName, await target.screenshot()]);
  };
  await pa.getByRole('button', { name: 'Continue' }).click();

  // 1. "Success - Application Submitted Successfully" popup
  const success = page.locator('.swal2-popup');
  await expect(success).toContainText('Application Submitted Successfully', { timeout: 60000 });
  await capture(page, '1-submitted.png');
  await success.locator('.swal2-confirm').click();
  await page.locator('.swal2-container').waitFor({ state: 'detached' });

  // 2. Upload Documents - skip
  const skip = page.getByRole('button', { name: 'Skip', exact: true });
  await skip.waitFor({ state: 'visible', timeout: 30000 });
  await capture(page, '2-upload-documents.png');
  await skip.click();

  // 3. "Congratulations! Application Created." - continue
  //    The site can stack more than one of these popups, so close each in turn
  const created = page
    .getByRole('dialog')
    .filter({ hasText: 'Congratulations! Application Created.' });
  await created.first().waitFor({ state: 'visible', timeout: 30000 });
  await capture(page, '3-application-created.png');
  while (await created.count()) {
    await created.last().getByRole('button', { name: 'Continue' }).click();
    await page.waitForTimeout(1000);
  }
  await page.waitForLoadState('networkidle');

  // 4. Find the CAMS ID: the application row holding this passport number. Its first
  //    column is the CAMS ID. If the row isn't on screen, open Application History.
  const passportNo = student['Student Passport No.'];
  const name = `${student['Student First Name']} ${student['Student Last Name']}`;
  const row = page.getByRole('row').filter({ hasText: passportNo }).first();
  const rowShown = () =>
    row
      .waitFor({ state: 'visible', timeout: 15000 })
      .then(() => true)
      .catch(() => false);

  if (!(await rowShown())) {
    await page.getByRole('link', { name: 'Application History' }).click();
    await page.waitForLoadState('networkidle');
    expect(await rowShown()).toBe(true);
  }
  // Like Ctrl+F: bring the passport number into view so it shows in the screenshot
  // (the table can redraw while loading, so retry until it settles)
  await expect(async () => {
    await row.getByText(passportNo).scrollIntoViewIfNeeded({ timeout: 2000 });
  }).toPass({ timeout: 20000 });
  const camsId = (await row.getByRole('cell').first().innerText()).trim();
  await expect(row).toContainText(name);
  expect(camsId).toMatch(/^\d+$/);

  // Now the CAMS ID is known: create the folder and write the screenshots taken so far
  shotDir = path.join(__dirname, '..', 'screenshots', `${studentEmail}-${camsId}`);
  fs.mkdirSync(shotDir, { recursive: true });
  for (const [fileName, image] of shots) fs.writeFileSync(path.join(shotDir, fileName), image);
  await capture(page, '4-cams-id.png');

  // 5. Search with the CAMS ID (not the passport). Typing opens the results list;
  //    clicking the search icon would close it. The site remembers the last search,
  //    so clear the box before typing.
  const search = page.getByPlaceholder(/Enter CAMS/);
  await search.click();
  await search.fill('');
  await search.pressSequentially(camsId, { delay: 100 });
  const results = page.locator('.mat-mdc-menu-panel');
  await expect(results).toContainText(camsId, { timeout: 30000 });
  await expect(results).toContainText(name);
  await capture(page, '5-search-cams-id.png');

  // 6. Click the result - the application opens in a new tab - and verify its details
  const tabPromise = page.context().waitForEvent('page');
  await results.getByText(camsId).first().click();
  const view = await tabPromise;
  await view.waitForLoadState('networkidle');
  const details = view.locator('body');
  await expect(details).toContainText(`CAMS ID: ${camsId}`, { timeout: 30000 });
  for (const value of [
    name,
    passportNo,
    student['Student Email ID'],
    student['Student Whatsapp Number'],
    student['Email-ID of the person handling this application'],
    student['Contact No of the person handling this application'],
    data['University'],
    data['Course'],
    data['University Main Course'],
  ]) {
    await expect(details).toContainText(value);
  }
  // The page writes the intake as "January/february 2027", so ignore case
  await expect(details).toContainText(new RegExp(data['Intake'].replace('/', '\\/'), 'i'));
  await capture(view, '6-application-details.png');

  // Save the CAMS ID alongside the student details
  const line = `${new Date().toLocaleString()} | CAMS ID: ${camsId} | ${name} | Passport: ${passportNo}\n`;
  fs.appendFileSync(path.join(__dirname, '..', 'cams_ids.txt'), line);
});
