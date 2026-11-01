// "Connect wallet" with the test's injected wallet. When the page offers
// WalletConnect too (built with a project ID), the wallet picker opens
// first, listing the browser wallet before WalletConnect: pick the former.
export async function connectExtension(page, button = page.getByRole('button', { name: 'Connect wallet' })) {
  await button.click()
  const picker = page.locator('.wallet-picker')
  if (await picker.waitFor({ timeout: 3000 }).then(() => true, () => false)) {
    await picker.locator('.wallet-option').filter({ hasNotText: 'WalletConnect' }).first().click()
  }
}
