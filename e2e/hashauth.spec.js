// @ts-check
const { test, expect } = require('@playwright/test');

test('has title', async ({ page }) => {
  test.slow( );
  await page.waitForLoadState('networkidle');
  await page.goto('/report/');

  // Expect a title "to contain" a substring.
  await expect(page).toHaveTitle(/Nightscout/, {timeout: 10000});
});

test('should make module unauthorized', async ({ page }) => {
  await page.waitForLoadState('networkidle');
  await page.goto('/report/', {timeout: 10000});

  var testhashnull = await page.evaluate('Nightscout.client.hashauth.hash( ) === null');
  await expect(testhashnull).toEqual(true);
  var test_authenticated_false = await page.evaluate('Nightscout.client.hashauth.isAuthenticated()');
  await expect(test_authenticated_false).toEqual(false);

  var hashauth_repr = await page.evaluate('JSON.parse(JSON.stringify(Nightscout.client.hashauth))');

  // XXX: does not work? chrome and firefox error with a is not a function.
  // var hashauth_dialog = await page.evaluate('Nightscout.client.hashauth.inlineCode()');
  // var hashauth_handle = await page.evaluateHandle('Nightscout.client.hashauth');
  // var hashauth_dialog = await page.evaluate(({hashauth}) => { return hashauth.inlineCode( ) }, {hashauth: hashauth_handle});

  console.log('hashauth dialog', hashauth_repr);
});

test('can exchange api secret', async ({ page }) => {
  await page.waitForLoadState('networkidle');
	await page.goto('/report/');
  await page.getByText(/Unauthorized/);
  await page.getByRole('link', { name: '(Authenticate)' }).waitFor();
  // await expect(page.getByRole('link'), { timeout: 10000 }).toHaveText('?');
  await expect(page.getByRole('link', { name: '(Authenticate)' }, { timeout: 10000 })).toHaveCount(1)
  await page.getByRole('link', { name: /Authenticate/ }).click({timeout: 10000});
  await page.getByLabel('Your API secret or token:').click();
  await page.getByLabel('Your API secret or token:').fill('too short');
  /*
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  */
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Authenticate' }).click();
  await page.getByRole('link', { name: '(Authenticate)' }).waitFor();


  await page.getByLabel('Your API secret or token:').click();
  await page.getByLabel('Your API secret or token:').fill('does not match but is long');

  /*
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  */
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Authenticate' }).click();
	// 

  await page.getByLabel('Your API secret or token:').click();
  await page.getByLabel('Your API secret or token:').fill('abcdefghij123');
  await page.getByRole('button', { name: 'Authenticate' }).click();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: /Remove/ }).waitFor( );
  await expect(page.getByText(/Admin authorized/)).toHaveText("Admin authorized (Remove)");
  // await page.pause( );
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: /Remove/ }).click({timeout: 5000});

  // await page.pause( );
  await page.getByText(/Unauthorized/);
  await page.getByRole('link', { name: '(Authenticate)' }).click();
  await page.getByLabel('Your API secret or token:').click({timeout: 5000});

  /*
  page.once('dialog', dialog => {
    console.log(`Dialog message: ${dialog.message()}`);
    dialog.dismiss().catch(() => {});
  });
  */
  // 
  await page.getByRole('button', { name: 'Authenticate' }).click();
  // await page.waitForLoadState('networkidle');
  await page.getByText(/Unauthorized/);
});
